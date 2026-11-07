import { Hono } from "hono";
import {
  accuseStorySchema,
  inspectStoryEvidenceSchema,
  startStorySessionSchema,
} from "@festival/shared";
import { StoryRunQuotaError, type SQLiteStoryRunStore } from "../../infrastructure/sqlite/story-run-store";
import type { StoryCatalog } from "../platform/stories/ports/story-catalog";
import { supportsSoloStory } from "./solo-story";
import type { StorySessionService } from "./story-session-service";

export function createGameRoutes(deps: {
  stories: StoryCatalog;
  runs: SQLiteStoryRunStore;
  sessions: StorySessionService;
}) {
  const app = new Hono();

  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

  app.get("/stories/:id", (c) => {
    const story = deps.stories.get(c.req.param("id"));
    if (!story) return c.json({ error: "공개된 작품을 찾을 수 없어." }, 404);
    if (!supportsSoloStory(story)) return c.json({ error: "이 작품은 현재 1인 수사 엔진에서 지원하지 않는 진행 방식이야." }, 422);
    deps.runs.record({
      id: crypto.randomUUID(),
      runId: null,
      storyId: story.story.id,
      type: "story_impression",
      occurredAt: new Date().toISOString(),
      value: null,
      metadata: { version: story.story.version },
    });
    return c.json({ story: story.story });
  });

  app.post("/sessions", async (c) => {
    const { storyId } = startStorySessionSchema.parse(await c.req.json());
    let session;
    try { session = deps.sessions.start(storyId); }
    catch (error) {
      if (error instanceof StoryRunQuotaError) return c.json({ error: error.message }, 429);
      throw error;
    }
    deps.runs.record({
      id: crypto.randomUUID(),
      runId: session.runId,
      storyId,
      type: "story_click",
      occurredAt: new Date().toISOString(),
      value: null,
      metadata: { version: session.story.version },
    });
    return c.json(session, 201);
  });
  app.post("/sessions/:id/advance", (c) =>
    c.json(deps.sessions.advance(c.req.param("id"))),
  );
  app.post("/sessions/:id/evidence", async (c) => {
    const { evidenceId } = inspectStoryEvidenceSchema.parse(await c.req.json());
    return c.json(deps.sessions.inspectEvidence(c.req.param("id"), evidenceId));
  });
  app.post("/sessions/:id/accuse", async (c) => {
    const { suspectId, evidenceIds } = accuseStorySchema.parse(await c.req.json());
    return c.json(deps.sessions.accuse(c.req.param("id"), suspectId, evidenceIds));
  });
  app.post("/sessions/:id/abandon", (c) => {
    deps.sessions.abandon(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/sessions/:id/rating", async (c) => {
    const { rating } = await c.req.json();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      return c.json({ error: "평점은 1점부터 5점까지 입력해 줘." }, 400);
    return c.json(deps.sessions.rate(c.req.param("id"), rating));
  });

  return app;
}
