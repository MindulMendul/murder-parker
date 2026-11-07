import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { storyPackageSchema } from "@festival/shared";
import { Store } from "../../store";
import { SQLiteStoryRunStore } from "../../infrastructure/sqlite/story-run-store";
import { SQLiteWorkshopStore } from "../../infrastructure/sqlite/workshop-store";
import { FileStoryCatalog } from "../platform/stories/file-catalog";
import { PlayStoryCatalog } from "../platform/stories/play-catalog";
import { createWorkshopRoutes } from "../workshop/routes";
import { createGameRoutes } from "./routes";
import { StorySessionService } from "./story-session-service";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workshop-play-"));
  let store: Store;
  const source = storyPackageSchema.parse(JSON.parse(readFileSync(join(import.meta.dir, "../../../stories/deokil-trading-murder.mstory"), "utf8")));
  const build = () => {
    store = new Store(join(dir, "test.sqlite"));
    const workshop = new SQLiteWorkshopStore(store.db);
    const runs = new SQLiteStoryRunStore(store.db);
    const files = new FileStoryCatalog();
    const catalog = new PlayStoryCatalog(files, workshop);
    const sessions = new StorySessionService(catalog, runs);
    const app = new Hono();
    app.route("/api/game", createGameRoutes({ stories: catalog, runs, sessions }));
    app.route("/api/workshop", createWorkshopRoutes({ stories: files, store, workshop, runs }));
    app.onError((error, c) => c.json({ error: error.message }, 400));
    return { store, workshop, runs, sessions, catalog, app };
  };
  const services = build();
  const author = services.store.createGuest("Author");
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const draft = (packageSource = source, published = true) => ({ package: packageSource, published, thumbnailUrl: null, difficulty: null });
  const create = (packageSource = source, published = true) => services.workshop.create(author, draft(packageSource, published));
  return { ...services, source, author, draft, create, databasePath: join(dir, "test.sqlite"), restart: () => { store.close(); return build(); } };
}
async function request(app: Hono, path: string, body?: unknown) {
  const response = await app.request(`http://localhost/api/game${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() as any };
}

test("public workshop preview and started play never expose source, answer keys or unreleased scenes", async () => {
  const f = fixture(); const item = f.create();
  const preview = await request(f.app, `/stories/${item.id}`);
  expect(preview.response.status).toBe(200);
  expect(Object.keys(preview.data)).toEqual(["story"]);
  expect(preview.data.story.id).toBe(item.id);
  const started = await request(f.app, "/sessions", { storyId: item.id });
  expect(started.response.status).toBe(201);
  expect(started.data.package.story.id).toBe(item.id);
  const payload = JSON.stringify(started.data);
  expect(payload).not.toContain('"solution"');
  expect(payload).not.toContain('"revealsTruth"');
  expect(payload).not.toContain('"scenes"');
  expect(payload).not.toContain('"information"');
  expect(payload).not.toContain('"resolution"');
  expect(started.data.scene.id).toBe("opening");
  const blocked = await request(f.app, `/sessions/${started.data.runId}/evidence`, { evidenceId: f.source.content.mechanics.type === "solo-investigation" ? f.source.content.mechanics.evidence[0]!.id : "missing" });
  expect(blocked.response.status).toBe(400);
  const meta = await f.app.request(`http://localhost/api/workshop/stories/${item.id}`);
  expect(await meta.text()).not.toContain('"solution"');
 });

test("started community runs pin source even with same-version edits, unpublishing and process restart", async () => {
  const f = fixture(); const item = f.create();
  const start = f.sessions.start(item.id);
  const revised = structuredClone(f.source);
  revised.story.title = "Edited title";
  revised.content.scenes[0]!.cues = [{ type: "dialogue.show", text: "NEW OPENING" }];
  f.workshop.update(item.id, f.author, f.draft(revised));
  expect(f.sessions.current(start.runId).scene.cues).toEqual(f.source.content.scenes[0]!.cues);
  const newer = f.sessions.start(item.id);
  expect(newer.package.story.title).toBe("Edited title");
  expect(newer.scene.cues).toEqual(revised.content.scenes[0]!.cues);
  f.workshop.update(item.id, f.author, f.draft(revised, false));
  const reloaded = f.restart();
  expect(reloaded.sessions.current(start.runId).scene.cues).toEqual(f.source.content.scenes[0]!.cues);
  expect(() => reloaded.sessions.start(item.id)).toThrow();
  expect((await request(reloaded.app, `/stories/${item.id}`)).response.status).toBe(404);
  expect(reloaded.sessions.advance(start.runId).scene.id).toBe("investigation");
  expect(() => reloaded.sessions.advance(start.runId)).toThrow();
  const mechanics = f.source.content.mechanics;
  if (mechanics.type !== "solo-investigation") throw Error("fixture");
  const evidenceIds = mechanics.evidence.slice(0, 3).map(e => e.id);
  expect(() => reloaded.sessions.accuse(start.runId, mechanics.solution.culpritId, evidenceIds)).toThrow();
  for (const evidence of mechanics.evidence) reloaded.sessions.inspectEvidence(start.runId, evidence.id);
  const decisive = mechanics.solution.requiredEvidenceIds.slice(0, 3);
  expect(reloaded.sessions.accuse(start.runId, mechanics.solution.culpritId, decisive).outcome).toBe("success");
  reloaded.sessions.rate(start.runId, 5);
  expect(reloaded.runs.metrics(item.id).playsStarted).toBe(2);
  expect(reloaded.runs.metrics(item.id).playsCompleted).toBe(1);
  expect(reloaded.runs.metrics(item.id).averageRating).toBe(5);
  expect(reloaded.runs.metrics(f.source.story.id).playsStarted).toBe(0);
 });

test("private, absent, malformed, multiplayer and unsupported branching packages cannot start", async () => {
  const f = fixture(); const hidden = f.create(f.source, false);
  expect((await request(f.app, `/stories/${hidden.id}`)).response.status).toBe(404);
  expect((await request(f.app, "/sessions", { storyId: hidden.id })).response.status).toBe(400);
  expect((await request(f.app, "/sessions", { storyId: "community-missing" })).response.status).toBe(400);
  const multiplayer = structuredClone(f.source); multiplayer.story.mode = "multiplayer"; multiplayer.content.mechanics = { type: "roleplay" };
  const multi = f.create(multiplayer);
  expect((await request(f.app, `/stories/${multi.id}`)).response.status).toBe(422);
  expect(() => f.sessions.start(multi.id)).toThrow();
  const branching = structuredClone(f.source);
  branching.content.scenes.push({ id: "secret-ending", cues: [{ type: "dialogue.show", text: "SECRET ENDING" }], choices: [] });
  branching.content.scenes.find(s => s.id === "investigation")!.nextSceneId = "secret-ending";
  const unsupported = f.create(branching);
  expect((await request(f.app, `/stories/${unsupported.id}`)).response.status).toBe(422);
  expect(() => f.sessions.start(unsupported.id)).toThrow();
  const choices = structuredClone(f.source);
  choices.content.scenes[0]!.choices = [{ id: "skip", label: "Skip ahead", targetSceneId: "resolution", visibleWhen: { type: "always" } }];
  expect(() => f.sessions.start(f.create(choices).id)).toThrow();
  const duplicateLocations = structuredClone(f.source);
  if (duplicateLocations.content.mechanics.type !== "solo-investigation") throw Error("fixture");
  duplicateLocations.content.mechanics.locations[1]!.id = duplicateLocations.content.mechanics.locations[0]!.id;
  expect(() => f.sessions.start(f.create(duplicateLocations).id)).toThrow();
  const impossible = structuredClone(f.source);
  if (impossible.content.mechanics.type !== "solo-investigation") throw Error("fixture");
  impossible.content.mechanics.solution.requiredEvidenceIds = Array(3).fill(impossible.content.mechanics.evidence[0]!.id);
  impossible.content.mechanics.solution.minimumEvidenceCount = 3;
  expect(() => f.sessions.start(f.create(impossible).id)).toThrow();
  const corrupt = f.create();
  f.store.db.query("UPDATE workshop_drafts SET package_json=? WHERE id=?").run('{"invalid":true}', corrupt.id);
  expect(() => f.sessions.start(corrupt.id)).toThrow();
 });

test("canonical community IDs isolate embedded source IDs, versions, plays and ratings", () => {
  const f = fixture(); const first = f.create(); const otherSource = structuredClone(f.source); otherSource.story.version = 9;
  const second = f.create(otherSource);
  const a = f.sessions.start(first.id); const b = f.sessions.start(second.id);
  expect(a.story.id).toBe(first.id); expect(a.story.version).toBe(1);
  expect(b.story.id).toBe(second.id); expect(b.story.version).toBe(9);
  expect(f.runs.metrics(first.id).playsStarted).toBe(1);
  expect(f.runs.metrics(second.id).playsStarted).toBe(1);
  expect(f.runs.metrics(f.source.story.id).playsStarted).toBe(0);
  expect(() => f.sessions.rate(a.runId, 5)).toThrow();
  const official = f.sessions.start(f.source.story.id);
  expect(official.story.id).toBe(f.source.story.id);
  expect(f.runs.metrics(f.source.story.id).playsStarted).toBe(1);
 });


test("anonymous repeated starts share a UTF-8 snapshot budget across connections and release only ended source", async () => {
  const f = fixture();
  const item = f.create();
  const bytes = Buffer.byteLength(JSON.stringify(f.catalog.get(item.id)));
  const tooSmall = new StorySessionService(f.catalog, new SQLiteStoryRunStore(f.store.db, { pinnedBytes: bytes - 1 }));
  expect(() => tooSmall.start(item.id)).toThrow();
  expect(f.runs.metrics(item.id).playsStarted).toBe(0);
  const boundedRuns = new SQLiteStoryRunStore(f.store.db, { pinnedBytes: bytes });
  const bounded = new StorySessionService(f.catalog, boundedRuns);
  const app = createGameRoutes({ stories: f.catalog, runs: boundedRuns, sessions: bounded });
  const otherStore = new Store(f.databasePath);
  try {
    const otherRuns = new SQLiteStoryRunStore(otherStore.db, { pinnedBytes: bytes });
    const other = new StorySessionService(f.catalog, otherRuns);
    const otherApp = createGameRoutes({ stories: f.catalog, runs: otherRuns, sessions: other });
    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      (index % 2 ? app : otherApp).request("http://localhost/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storyId: item.id }),
      })));
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    expect(responses.filter(response => response.status === 429)).toHaveLength(39);
    const started = await responses.find(response => response.status === 201)!.json() as { runId: string };
    const retained = f.store.db.query("SELECT SUM(length(CAST(package_json AS BLOB))) AS bytes FROM story_runs").get() as { bytes: number };
    expect(retained.bytes).toBe(bytes);
    expect(bounded.current(started.runId).story.id).toBe(item.id);
    expect(other.current(started.runId).story.id).toBe(item.id);
    expect(f.runs.metrics(item.id).playsStarted).toBe(1);
    bounded.abandon(started.runId);
    expect(boundedRuns.get(started.runId)?.storyPackage).toBeUndefined();
    expect(f.runs.metrics(item.id).playsAbandoned).toBe(1);
    const next = other.start(item.id);
    other.advance(next.runId);
    const mechanics = f.source.content.mechanics;
    if (mechanics.type !== "solo-investigation") throw new Error("fixture");
    for (const evidence of mechanics.evidence) other.inspectEvidence(next.runId, evidence.id);
    other.accuse(next.runId, mechanics.solution.culpritId, mechanics.solution.requiredEvidenceIds.slice(0, 3));
    expect(otherRuns.get(next.runId)?.storyPackage).toBeUndefined();
    expect(otherRuns.get(next.runId)?.storyVersion).toBe(f.source.story.version);
    other.rate(next.runId, 4);
    expect(f.runs.metrics(item.id).averageRating).toBe(4);
    expect(f.runs.metrics(item.id).playsStarted).toBe(2);
    expect(f.runs.metrics(item.id).playsCompleted).toBe(1);
    expect(bounded.start(item.id).story.id).toBe(item.id);
  } finally { otherStore.close(); }
});

test("a valid published story with no opening cues can advance into investigation", async () => {
  const f = fixture();
  const emptyOpening = structuredClone(f.source);
  emptyOpening.content.scenes.find(scene => scene.id === emptyOpening.story.startSceneId)!.cues = [];
  const item = f.create(emptyOpening);

  const started = await request(f.app, "/sessions", { storyId: item.id });
  expect(started.response.status).toBe(201);
  expect(started.data.scene).toEqual({ id: "opening", cues: [] });
  const startPayload = JSON.stringify(started.data);
  expect(startPayload).not.toContain('"solution"');
  expect(startPayload).not.toContain('"revealsTruth"');
  expect(startPayload).not.toContain('"resolution"');

  const advanced = await request(f.app, `/sessions/${started.data.runId}/advance`, {});
  expect(advanced.response.status).toBe(200);
  expect(advanced.data.scene.id).toBe("investigation");
  const nextPayload = JSON.stringify(advanced.data);
  expect(nextPayload).not.toContain('"solution"');
  expect(nextPayload).not.toContain('"revealsTruth"');
  expect(nextPayload).not.toContain('"resolution"');
  expect(f.runs.get(started.data.runId)?.currentSceneId).toBe("investigation");
});
