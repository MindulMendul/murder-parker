import type { StoryPackage } from "@festival/shared";
import type { StoryRun, StoryRunStore } from "../platform/stories/run-store";
import type { StoryCatalog } from "../platform/stories/ports/story-catalog";

import { soloStoryView, supportsSoloStory } from "./solo-story";

export class StorySessionService {
  constructor(
    private readonly catalog: StoryCatalog,
    private readonly runs: StoryRunStore,
  ) {}

  start(storyId: string) {
    const story = this.needSoloStory(storyId);
    const now = new Date().toISOString();
    const run: StoryRun = {
      id: crypto.randomUUID(),
      storyId,
      storyVersion: story.story.version,
      storyPackage: structuredClone(story),
      currentSceneId: story.story.startSceneId,
      startedAt: now,
      lastActiveAt: now,
      endedAt: null,
      outcome: null,
      foundEvidenceIds: [],
    };
    this.runs.create(run);
    this.record(run, "play_started");
    return { runId: run.id, package: soloStoryView(story), ...this.sceneView(run, story) };
  }

  current(runId: string) {
    const run = this.needActiveRun(runId);
    const story = run.storyPackage ?? this.needSoloStory(run.storyId, run.storyVersion);
    return { runId: run.id, ...this.sceneView(run, story) };
  }

  advance(runId: string) {
    const run = this.needActiveRun(runId);
    const story = run.storyPackage ?? this.needSoloStory(run.storyId, run.storyVersion);
    const current = story.content.scenes.find((scene) => scene.id === run.currentSceneId);
    if (!current?.nextSceneId) throw new Error("이 장면에서 자동으로 진행할 수 없어.");
    // Resolution cues are returned only by a successful server-side accusation.
    if (
      story.content.mechanics.type === "solo-investigation" &&
      current.nextSceneId === "resolution"
    ) {
      throw new Error("사건의 결말은 고발 결과를 확인한 뒤 볼 수 있어.");
    }
    run.currentSceneId = current.nextSceneId;
    run.lastActiveAt = new Date().toISOString();
    this.runs.save(run);
    this.record(run, "scene_entered", { sceneId: run.currentSceneId });
    return { runId: run.id, ...this.sceneView(run, story) };
  }

  inspectEvidence(runId: string, evidenceId: string) {
    const run = this.needActiveRun(runId);
    const story = run.storyPackage ?? this.needSoloStory(run.storyId, run.storyVersion);
    if (story.content.mechanics.type !== "solo-investigation")
      throw new Error("이 작품은 현장 조사 방식이 아니야.");
    if (run.currentSceneId !== "investigation")
      throw new Error("현장 조사 장면에서만 단서를 살펴볼 수 있어.");
    if (!story.content.mechanics.evidence.some((evidence) => evidence.id === evidenceId))
      throw new Error("증거를 찾을 수 없어.");
    if (!run.foundEvidenceIds.includes(evidenceId)) {
      run.foundEvidenceIds.push(evidenceId);
      run.lastActiveAt = new Date().toISOString();
      this.runs.save(run);
      this.record(run, "evidence_found", { evidenceId });
    }
    return { foundEvidenceIds: run.foundEvidenceIds };
  }

  accuse(runId: string, suspectId: string, evidenceIds: string[]) {
    const run = this.needActiveRun(runId);
    const story = run.storyPackage ?? this.needSoloStory(run.storyId, run.storyVersion);
    if (story.content.mechanics.type !== "solo-investigation")
      throw new Error("이 작품은 추리 고발 방식이 아니야.");
    if (run.currentSceneId !== "investigation")
      throw new Error("조사 장면을 마친 뒤 고발할 수 있어.");
    const mechanics = story.content.mechanics;
    if (!mechanics.suspects.some((suspect) => suspect.id === suspectId))
      throw new Error("용의자를 찾을 수 없어.");
    if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.length > 3)
      throw new Error("고발 증거를 확인해 줘.");
    if (evidenceIds.some((id) => !run.foundEvidenceIds.includes(id)))
      throw new Error("아직 발견하지 않은 증거는 제출할 수 없어.");

    const solution = mechanics.solution;
    const correct =
      suspectId === solution.culpritId &&
      evidenceIds.filter((id) => solution.requiredEvidenceIds.includes(id)).length >=
        solution.minimumEvidenceCount;
    const now = new Date().toISOString();
    run.endedAt = now;
    run.lastActiveAt = now;
    run.outcome = correct ? "completed" : "failed";
    this.runs.save(run);
    this.record(run, "accusation_submitted", { suspectId, evidenceIds, correct });
    this.record(run, correct ? "play_completed" : "play_failed", {
      elapsedMs: Math.max(0, Date.parse(now) - Date.parse(run.startedAt)),
    });

    return correct
      ? {
          outcome: "success" as const,
          cues: story.content.scenes.find((scene) => scene.id === "resolution")?.cues ?? [],
        }
      : {
          outcome: "failure" as const,
          message:
            suspectId !== solution.culpritId
              ? `${mechanics.suspects.find((suspect) => suspect.id === suspectId)?.name}${solution.failureMessages.wrongSuspect}`
              : solution.failureMessages.insufficientEvidence,
        };
  }

  abandon(runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.endedAt) return;
    const now = new Date().toISOString();
    run.endedAt = now;
    run.lastActiveAt = now;
    run.outcome = "abandoned";
    this.runs.save(run);
    this.record(run, "play_abandoned", {
      elapsedMs: Math.max(0, Date.parse(now) - Date.parse(run.startedAt)),
    });
  }

  rate(runId: string, rating: number) {
    const run = this.runs.get(runId);
    if (!run || !run.endedAt || run.outcome === "abandoned")
      throw new Error("끝난 플레이에만 평점을 남길 수 있어.");
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      throw new Error("평점은 1점부터 5점까지 입력해 줘.");
    this.runs.rate(run.id, run.storyId, rating, new Date().toISOString());
    this.record(run, "rating_submitted", { rating });
    return { saved: true };
  }

  private sceneView(run: StoryRun, story: StoryPackage) {
    const scene = story.content.scenes.find((item) => item.id === run.currentSceneId);
    if (!scene) throw new Error("현재 장면을 찾을 수 없어.");
    if (story.content.mechanics.type === "solo-investigation" && scene.id === "resolution") {
      throw new Error("사건의 결말은 고발 결과를 확인한 뒤 볼 수 있어.");
    }
    return {
      story: { id: story.story.id, version: story.story.version },
      scene: { id: scene.id, cues: scene.cues },
      progress: {
        startedAt: run.startedAt,
        elapsedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)),
        foundEvidenceIds: run.foundEvidenceIds,
      },
    };
  }

  private needActiveRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error("플레이 세션을 찾을 수 없어.");
    if (run.endedAt) throw new Error("이미 끝난 플레이야.");
    return run;
  }

  private needSoloStory(id: string, version?: number) {
    const story = this.catalog.get(id, version);
    if (!story || !supportsSoloStory(story)) throw new Error("단독 플레이 스토리를 찾을 수 없어.");
    return story;
  }

  private record(run: StoryRun, type: string, metadata: Record<string, unknown> = {}) {
    this.runs.record({
      id: crypto.randomUUID(),
      runId: run.id,
      storyId: run.storyId,
      type,
      occurredAt: new Date().toISOString(),
      value: typeof metadata.elapsedMs === "number" ? metadata.elapsedMs : null,
      metadata,
    });
  }
}
