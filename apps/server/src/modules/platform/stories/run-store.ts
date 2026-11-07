import type { StoryPackage } from "@festival/shared";
export type StoryRun = {
  id: string;
  storyId: string;
  storyVersion: number;
  /** Private immutable source for a started play, including unpublished/deleted revisions. */
  storyPackage?: StoryPackage;
  currentSceneId: string;
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
  outcome: "completed" | "failed" | "abandoned" | null;
  foundEvidenceIds: string[];
};

export type StoryRunEvent = {
  id: string;
  runId: string | null;
  storyId: string;
  type: string;
  occurredAt: string;
  value: number | null;
  metadata: Record<string, unknown>;
};

export type StoryVital = {
  id: string;
  storyId: string;
  metricName: string;
  value: number;
  navigationId: string;
  route: string;
  occurredAt: string;
};

export type StoryMetrics = {
  storyId: string;
  impressions: number;
  clicks: number;
  ctr: number | null;
  playsStarted: number;
  playsCompleted: number;
  playsFailed: number;
  playsAbandoned: number;
  completionRate: number | null;
  averageDurationMs: number | null;
  ratingCount: number;
  averageRating: number | null;
  rumVitals: { metricName: string; samples: number; average: number }[];
};

export interface StoryRunStore {
  create(run: StoryRun): void;
  get(id: string): StoryRun | undefined;
  save(run: StoryRun): void;
  record(event: StoryRunEvent): void;
  rate(runId: string, storyId: string, rating: number, createdAt: string): void;
  recordVital(vital: StoryVital): void;
  metrics(storyId: string): StoryMetrics;
}
