import type { Database } from "bun:sqlite";
import { storyPackageSchema, type Guest, type StoryPackage } from "@festival/shared";
import type { WorkshopDraftInput, WorkshopStory } from "../../modules/workshop/model";

type DraftRow = {
  id: string;
  owner_id: string;
  author_name: string;
  story_json: string;
  thumbnail_url: string | null;
  difficulty: WorkshopStory["difficulty"];
  published: number;
  published_at: string | null;
  updated_at: string;
};

export type WorkshopLimits = {
  guestDrafts: number;
  guestBytes: number;
  totalDrafts: number;
  totalBytes: number;
  publicCatalogLimit: number;
  globalCreatesPerMinute: number;
};

const defaultLimits: WorkshopLimits = {
  guestDrafts: 20,
  guestBytes: 10 * 1024 * 1024,
  totalDrafts: 1000,
  totalBytes: 100 * 1024 * 1024,
  publicCatalogLimit: 1000,
  globalCreatesPerMinute: 10,
};

const payloadSizeSql = `length(CAST(package_json AS BLOB)) + length(CAST(story_json AS BLOB)) +
  length(CAST(COALESCE(thumbnail_url, '') AS BLOB)) + length(CAST(author_name AS BLOB))`;

export class WorkshopQuotaError extends Error {
  constructor(message: string, readonly status: 429 | 413) {
    super(message);
    this.name = "WorkshopQuotaError";
  }
}

/** Keeps editable packages private; public readers receive only explicit metadata. */
export class SQLiteWorkshopStore {
  private readonly limits: WorkshopLimits;

  constructor(private readonly db: Database, limits: Partial<WorkshopLimits> = {}) {
    this.limits = { ...defaultLimits, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error("Workshop limits must be nonnegative safe integers.");
    db.exec(`
      CREATE TABLE IF NOT EXISTS workshop_drafts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        story_json TEXT NOT NULL,
        package_json TEXT NOT NULL,
        thumbnail_url TEXT,
        difficulty TEXT CHECK (difficulty IN ('easy', 'normal', 'hard')),
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        published_at TEXT,
        updated_at TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0)
      );
      CREATE INDEX IF NOT EXISTS workshop_drafts_owner_idx
        ON workshop_drafts(owner_id, updated_at);
      CREATE INDEX IF NOT EXISTS workshop_drafts_published_idx
        ON workshop_drafts(published, published_at);
      CREATE INDEX IF NOT EXISTS workshop_drafts_public_order_idx
        ON workshop_drafts(published, published_at DESC, id);
      CREATE INDEX IF NOT EXISTS workshop_drafts_owner_order_idx
        ON workshop_drafts(owner_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS workshop_favorites (
        story_id TEXT NOT NULL,
        guest_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (story_id, guest_id)
      );
      CREATE INDEX IF NOT EXISTS workshop_favorites_guest_idx
        ON workshop_favorites(guest_id, story_id);
      CREATE TABLE IF NOT EXISTS workshop_creation_budget (
        id INTEGER PRIMARY KEY CHECK (id=1),
        window_started_at INTEGER NOT NULL,
        creations INTEGER NOT NULL CHECK (creations >= 0)
      );
    `);
    db.transaction(() => {
      const columns = db.query("PRAGMA table_info(workshop_drafts)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "payload_bytes")) {
        db.exec("ALTER TABLE workshop_drafts ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes >= 0)");
      }
      // Reconcile nonzero stale values left by older images as well as newly migrated rows.
      db.exec(`UPDATE workshop_drafts SET payload_bytes=${payloadSizeSql}`);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS workshop_payload_insert AFTER INSERT ON workshop_drafts
        BEGIN
          UPDATE workshop_drafts SET payload_bytes=${payloadSizeSql} WHERE id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS workshop_payload_update
          AFTER UPDATE OF package_json, story_json, thumbnail_url, author_name ON workshop_drafts
        BEGIN
          UPDATE workshop_drafts SET payload_bytes=${payloadSizeSql} WHERE id=NEW.id;
        END;
      `);
    }).immediate();
  }

  list(ownerId?: string): WorkshopStory[] {
    const rows = this.db.query(`
      SELECT id, owner_id, author_name, story_json, thumbnail_url, difficulty,
        published, published_at, updated_at
      FROM workshop_drafts WHERE ${ownerId === undefined ? "published=1" : "owner_id=?"}
      ORDER BY ${ownerId === undefined ? "published_at" : "updated_at"} DESC, id ASC
      ${ownerId === undefined ? "LIMIT ?" : ""}
    `).all(...(ownerId === undefined ? [this.limits.publicCatalogLimit] : [ownerId])) as DraftRow[];
    return rows.map((row) => this.metadata(row));
  }

  get(id: string): WorkshopStory | undefined {
    const row = this.db.query(`
      SELECT id, owner_id, author_name, story_json, thumbnail_url, difficulty,
        published, published_at, updated_at
      FROM workshop_drafts WHERE id=?
    `).get(id) as DraftRow | null;
    return row ? this.metadata(row) : undefined;
  }

  source(id: string, ownerId: string): StoryPackage | undefined {
    const row = this.db.query(
      "SELECT package_json FROM workshop_drafts WHERE id=? AND owner_id=?",
    ).get(id, ownerId) as { package_json: string } | null;
    return row ? JSON.parse(row.package_json) as StoryPackage : undefined;
  }

  /** Server-only source lookup; public API routes must never serialize this package. */
  playableSource(id: string): StoryPackage | undefined {
    const row = this.db.query("SELECT package_json FROM workshop_drafts WHERE id=? AND published=1")
      .get(id) as { package_json: string } | null;
    if (!row) return undefined;
    try {
      const parsed = storyPackageSchema.safeParse(JSON.parse(row.package_json));
      return parsed.success ? { ...parsed.data, story: { ...parsed.data.story, id } } : undefined;
    } catch { return undefined; }
  }

  create(owner: Guest, draft: WorkshopDraftInput): WorkshopStory {
    const id = `community-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const payload = this.serialize(owner, draft);
    return this.db.transaction(() => {
      this.checkCountQuota(owner.id);
      this.checkByteQuota(owner.id, payload.bytes);
      this.consumeCreationBudget();
      this.db.query(`
      INSERT INTO workshop_drafts (
        id, owner_id, author_name, story_json, package_json, thumbnail_url,
        difficulty, published, published_at, updated_at, payload_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, owner.id, owner.nickname, payload.story, payload.package, draft.thumbnailUrl, draft.difficulty,
      Number(draft.published), draft.published ? now : null, now, payload.bytes,
    );
      return this.get(id)!;
    }).immediate();
  }

  update(id: string, owner: Guest, draft: WorkshopDraftInput): WorkshopStory | undefined {
    const now = new Date().toISOString();
    const payload = this.serialize(owner, draft);
    return this.db.transaction(() => {
      const previous = this.db.query("SELECT payload_bytes FROM workshop_drafts WHERE id=? AND owner_id=?")
        .get(id, owner.id) as { payload_bytes: number } | null;
      if (!previous) return undefined;
      if (payload.bytes > previous.payload_bytes) this.checkByteQuota(owner.id, payload.bytes, id);
      this.db.query(`
      UPDATE workshop_drafts SET author_name=?, story_json=?, package_json=?,
        thumbnail_url=?, difficulty=?, published=?, payload_bytes=?,
        published_at=CASE WHEN ?=1 THEN
          CASE WHEN published=1 THEN COALESCE(published_at, ?) ELSE ? END
          ELSE NULL END,
        updated_at=? WHERE id=? AND owner_id=?
    `).run(
      owner.nickname, payload.story, payload.package,
      draft.thumbnailUrl, draft.difficulty, Number(draft.published), payload.bytes,
      Number(draft.published), now, now, now, id, owner.id,
    );
      return this.get(id);
    }).immediate();
  }

  deletePrivate(id: string, ownerId: string): 'deleted' | 'missing' | 'published' {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT published FROM workshop_drafts WHERE id=? AND owner_id=?')
        .get(id, ownerId) as { published: number } | null;
      if (!row) return 'missing' as const;
      if (row.published) return 'published' as const;
      // Quotas sum existing rows, so removing the payload restores count and bytes atomically.
      this.db.query('DELETE FROM workshop_favorites WHERE story_id=?').run(id);
      this.db.query('DELETE FROM workshop_drafts WHERE id=? AND owner_id=? AND published=0').run(id, ownerId);
      return 'deleted' as const;
    }).immediate();
  }

  private serialize(owner: Guest, draft: WorkshopDraftInput) {
    const story = JSON.stringify(draft.package.story);
    const source = JSON.stringify(draft.package);
    const bytes = Buffer.byteLength(story) + Buffer.byteLength(source) +
      Buffer.byteLength(draft.thumbnailUrl ?? "") + Buffer.byteLength(owner.nickname);
    return { story, package: source, bytes };
  }

  /** Called under an IMMEDIATE transaction so competing connections cannot pass stale totals. */
  private checkCountQuota(ownerId: string) {
    const guestCount = this.db.query(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM workshop_drafts WHERE owner_id=? LIMIT ?
      )
    `).get(ownerId, this.limits.guestDrafts) as { count: number };
    if (guestCount.count >= this.limits.guestDrafts)
      throw new WorkshopQuotaError(`한 사람당 작품은 ${this.limits.guestDrafts}개까지 저장할 수 있어. 기존 작품을 수정해 줘.`, 429);
    const totalCount = this.db.query(`
      SELECT COUNT(*) AS count FROM (SELECT 1 FROM workshop_drafts LIMIT ?)
    `).get(this.limits.totalDrafts) as { count: number };
    if (totalCount.count >= this.limits.totalDrafts)
      throw new WorkshopQuotaError("창작마당 저장 작품 수가 한도에 도달했어. 기존 작품을 수정해 줘.", 429);
  }

  private checkByteQuota(ownerId: string, bytes: number, excludedId = "") {
    const usage = this.db.query(`
      SELECT COALESCE(SUM(payload_bytes), 0) AS total,
        COALESCE(SUM(CASE WHEN owner_id=? THEN payload_bytes ELSE 0 END), 0) AS guest
      FROM workshop_drafts WHERE id<>?
    `).get(ownerId, excludedId) as { total: number; guest: number };
    if (usage.guest + bytes > this.limits.guestBytes)
      throw new WorkshopQuotaError("내 작품의 총 저장 용량 한도를 넘었어. 파일 크기를 줄여 줘.", 413);
    if (usage.total + bytes > this.limits.totalBytes)
      throw new WorkshopQuotaError("창작마당의 총 저장 용량 한도를 넘었어. 파일 크기를 줄여 줘.", 413);
  }

  private consumeCreationBudget() {
    const now = Date.now();
    const previous = this.db.query("SELECT window_started_at, creations FROM workshop_creation_budget WHERE id=1")
      .get() as { window_started_at: number; creations: number } | null;
    const active = previous && now >= previous.window_started_at && now - previous.window_started_at < 60000;
    const count = active ? previous.creations : 0;
    if (count >= this.limits.globalCreatesPerMinute)
      throw new WorkshopQuotaError("새 작품 저장 요청이 많아. 잠시 후 다시 저장해 줘.", 429);
    this.db.query(`
      INSERT INTO workshop_creation_budget (id, window_started_at, creations) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET window_started_at=excluded.window_started_at, creations=excluded.creations
    `).run(active ? previous.window_started_at : now, count + 1);
  }

  favorite(storyId: string, guestId: string, selected: boolean) {
    if (selected) {
      this.db.query(`
        INSERT OR IGNORE INTO workshop_favorites (story_id, guest_id, created_at)
        VALUES (?, ?, ?)
      `).run(storyId, guestId, new Date().toISOString());
    } else {
      this.db.query("DELETE FROM workshop_favorites WHERE story_id=? AND guest_id=?")
        .run(storyId, guestId);
    }
  }

  favoriteIds(guestId: string) {
    const rows = this.db.query("SELECT story_id FROM workshop_favorites WHERE guest_id=?")
      .all(guestId) as { story_id: string }[];
    return new Set(rows.map((row) => row.story_id));
  }

  favorites(storyIds: readonly string[], guestId?: string) {
    const result = new Map<string, { count: number; selected: boolean }>();
    const ids = [...new Set(storyIds)];
    // Bound the number of SQLite parameters even for large filtered catalogs.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const batch = ids.slice(offset, offset + 400);
      const rows = this.db.query(`
        SELECT story_id, COUNT(*) AS count,
          MAX(CASE WHEN guest_id=? THEN 1 ELSE 0 END) AS selected
        FROM workshop_favorites WHERE story_id IN (${batch.map(() => "?").join(",")})
        GROUP BY story_id
      `).all(guestId ?? "", ...batch) as { story_id: string; count: number; selected: number }[];
      for (const row of rows) result.set(row.story_id, { count: row.count, selected: row.selected === 1 });
    }
    return result;
  }

  private metadata(row: DraftRow): WorkshopStory {
    return {
      id: row.id,
      story: JSON.parse(row.story_json) as StoryPackage["story"],
      author: { id: row.owner_id, name: row.author_name },
      thumbnailUrl: row.thumbnail_url,
      difficulty: row.difficulty,
      published: row.published === 1,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    };
  }
}
