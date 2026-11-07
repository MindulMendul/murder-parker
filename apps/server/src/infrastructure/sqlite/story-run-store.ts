import type { Database } from "bun:sqlite";
import type { StoryMetrics, StoryRun, StoryRunEvent, StoryRunStore, StoryVital } from "../../modules/platform/stories/run-store";

type Row = {
  id: string;
  story_id: string;
  story_version: number;
  current_scene_id: string;
  started_at: string;
  last_active_at: string;
  ended_at: string | null;
  outcome: StoryRun["outcome"];
  found_evidence_json: string;
  package_json: string | null;
};

export class StoryRunQuotaError extends Error {}

export class SQLiteStoryRunStore implements StoryRunStore {
  private readonly pinnedBytes: number;
  constructor(private readonly db: Database, limits: { pinnedBytes?: number } = {}) {
    this.pinnedBytes = limits.pinnedBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.pinnedBytes) || this.pinnedBytes < 0) throw new Error("Invalid pinned play storage budget");
    db.exec(`
      CREATE TABLE IF NOT EXISTS story_runs (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        story_version INTEGER NOT NULL,
        current_scene_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        ended_at TEXT,
        outcome TEXT CHECK (outcome IN ('completed', 'failed', 'abandoned')),
        found_evidence_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS story_runs_story_started_idx
        ON story_runs(story_id, started_at);
      CREATE TABLE IF NOT EXISTS story_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES story_runs(id) ON DELETE SET NULL,
        story_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        value REAL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS story_run_events_story_type_idx
        ON story_run_events(story_id, event_type, occurred_at);
      CREATE TABLE IF NOT EXISTS story_ratings (
        run_id TEXT PRIMARY KEY REFERENCES story_runs(id) ON DELETE CASCADE,
        story_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS story_ratings_story_idx
        ON story_ratings(story_id, created_at);
      CREATE TABLE IF NOT EXISTS story_rum_vitals (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        metric_name TEXT NOT NULL CHECK (metric_name IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB', 'page_load_ms')),
        value REAL NOT NULL CHECK (value >= 0),
        navigation_id TEXT NOT NULL,
        route TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS story_rum_vitals_story_metric_idx
        ON story_rum_vitals(story_id, metric_name, occurred_at);
    `);
    const columns = db.query("PRAGMA table_info(story_runs)").all() as { name: string }[];
    if (!columns.some(column => column.name === "package_json")) db.exec("ALTER TABLE story_runs ADD COLUMN package_json TEXT");
    db.exec("UPDATE story_runs SET package_json=NULL WHERE ended_at IS NOT NULL AND package_json IS NOT NULL; CREATE INDEX IF NOT EXISTS story_runs_pinned_idx ON story_runs(id) WHERE package_json IS NOT NULL");
  }

  create(run: StoryRun) {
    const source = run.storyPackage ? JSON.stringify(run.storyPackage) : null;
    this.db.transaction(() => {
      const retained = this.db.query("SELECT COALESCE(SUM(length(CAST(package_json AS BLOB))), 0) AS bytes FROM story_runs WHERE package_json IS NOT NULL").get() as { bytes: number };
      if (retained.bytes + (source ? Buffer.byteLength(source) : 0) > this.pinnedBytes)
        throw new StoryRunQuotaError("진행 중인 플레이 보관 공간이 가득 찼어. 플레이가 끝난 뒤 다시 시도해 줘.");
      this.db.query(`
        INSERT INTO story_runs (
          id, story_id, story_version, current_scene_id, started_at,
          last_active_at, ended_at, outcome, found_evidence_json, package_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.storyId,
        run.storyVersion,
        run.currentSceneId,
        run.startedAt,
        run.lastActiveAt,
        run.endedAt,
        run.outcome,
        JSON.stringify(run.foundEvidenceIds),
        source,
      );
    }).immediate();
  }

  get(id: string) {
    const row = this.db.query("SELECT * FROM story_runs WHERE id=?").get(id) as Row | null;
    if (!row) return undefined;
    return {
      id: row.id,
      storyId: row.story_id,
      storyVersion: row.story_version,
      storyPackage: row.package_json ? JSON.parse(row.package_json) : undefined,
      currentSceneId: row.current_scene_id,
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
      endedAt: row.ended_at,
      outcome: row.outcome,
      foundEvidenceIds: JSON.parse(row.found_evidence_json) as string[],
    };
  }

  save(run: StoryRun) {
    this.db.query(`
      UPDATE story_runs SET current_scene_id=?, last_active_at=?, ended_at=?,
        outcome=?, found_evidence_json=?, package_json=CASE WHEN ? IS NULL THEN package_json ELSE NULL END WHERE id=?
    `).run(
      run.currentSceneId,
      run.lastActiveAt,
      run.endedAt,
      run.outcome,
      JSON.stringify(run.foundEvidenceIds),
      run.endedAt,
      run.id,
    );
  }

  record(event: StoryRunEvent) {
    this.db.query(`
      INSERT INTO story_run_events
        (id, run_id, story_id, event_type, occurred_at, value, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.runId,
      event.storyId,
      event.type,
      event.occurredAt,
      event.value,
      JSON.stringify(event.metadata),
    );
  }

  rate(runId: string, storyId: string, rating: number, createdAt: string) {
    this.db.query(`
      INSERT INTO story_ratings (run_id, story_id, rating, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET rating=excluded.rating, created_at=excluded.created_at
    `).run(runId, storyId, rating, createdAt);
  }

  recordVital(vital: StoryVital) {
    this.db.query(`
      INSERT INTO story_rum_vitals
        (id, story_id, metric_name, value, navigation_id, route, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vital.id,
      vital.storyId,
      vital.metricName,
      vital.value,
      vital.navigationId,
      vital.route,
      vital.occurredAt,
    );
  }

  catalogMetrics(storyIds: readonly string[]) {
    const result = new Map<string, { playCount: number; ratingCount: number; averageRating: number | null }>();
    const ids = [...new Set(storyIds)];
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.query(`
      WITH plays AS (
        SELECT story_id, COUNT(*) AS play_count FROM story_runs
        WHERE story_id IN (${placeholders}) GROUP BY story_id
      ), ratings AS (
        SELECT story_id, COUNT(*) AS rating_count, AVG(rating) AS average_rating
        FROM story_ratings WHERE story_id IN (${placeholders}) GROUP BY story_id
      ), ids AS (
        SELECT story_id FROM plays UNION SELECT story_id FROM ratings
      )
      SELECT ids.story_id, COALESCE(plays.play_count, 0) AS play_count,
        COALESCE(ratings.rating_count, 0) AS rating_count, ratings.average_rating
      FROM ids LEFT JOIN plays USING (story_id) LEFT JOIN ratings USING (story_id)
    `).all(...batch, ...batch) as {
      story_id: string;
      play_count: number;
      rating_count: number;
      average_rating: number | null;
    }[];
      for (const row of rows) result.set(row.story_id, {
        playCount: row.play_count,
        ratingCount: row.rating_count,
        averageRating: row.average_rating,
      });
    }
    return result;
  }

  metrics(storyId: string): StoryMetrics {
    const eventRow = this.db.query(`
      SELECT
        SUM(CASE WHEN event_type='story_impression' THEN 1 ELSE 0 END) AS impressions,
        SUM(CASE WHEN event_type='story_click' THEN 1 ELSE 0 END) AS clicks
      FROM story_run_events WHERE story_id=?
    `).get(storyId) as { impressions: number | null; clicks: number | null };
    const runRow = this.db.query(`
      SELECT
        COUNT(*) AS plays_started,
        SUM(CASE WHEN outcome='completed' THEN 1 ELSE 0 END) AS plays_completed,
        SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) AS plays_failed,
        SUM(CASE WHEN outcome='abandoned' THEN 1 ELSE 0 END) AS plays_abandoned,
        AVG(CASE WHEN outcome='completed'
          THEN (julianday(ended_at)-julianday(started_at))*86400000 END) AS average_duration_ms
      FROM story_runs WHERE story_id=?
    `).get(storyId) as {
      plays_started: number;
      plays_completed: number | null;
      plays_failed: number | null;
      plays_abandoned: number | null;
      average_duration_ms: number | null;
    };
    const ratingRow = this.db.query(`
      SELECT COUNT(*) AS rating_count, AVG(rating) AS average_rating
      FROM story_ratings WHERE story_id=?
    `).get(storyId) as { rating_count: number; average_rating: number | null };
    const rumVitals = this.db.query(`
      SELECT metric_name, COUNT(*) AS samples, AVG(value) AS average
      FROM story_rum_vitals WHERE story_id=? GROUP BY metric_name ORDER BY metric_name
    `).all(storyId) as { metric_name: string; samples: number; average: number }[];
    const impressions = eventRow.impressions ?? 0;
    const clicks = eventRow.clicks ?? 0;
    const playsStarted = runRow.plays_started ?? 0;
    const playsCompleted = runRow.plays_completed ?? 0;
    return {
      storyId,
      impressions,
      clicks,
      ctr: impressions ? clicks / impressions : null,
      playsStarted,
      playsCompleted,
      playsFailed: runRow.plays_failed ?? 0,
      playsAbandoned: runRow.plays_abandoned ?? 0,
      completionRate: playsStarted ? playsCompleted / playsStarted : null,
      averageDurationMs: runRow.average_duration_ms,
      ratingCount: ratingRow.rating_count,
      averageRating: ratingRow.average_rating,
      rumVitals: rumVitals.map((metric) => ({
        metricName: metric.metric_name,
        samples: metric.samples,
        average: metric.average,
      })),
    };
  }
}
