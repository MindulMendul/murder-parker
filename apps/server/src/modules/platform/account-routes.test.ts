import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nicknameSchema, type StoryPackage } from "@festival/shared";
import { Store } from "../../store";
import { SQLiteStoryRunStore } from "../../infrastructure/sqlite/story-run-store";
import { SQLiteWorkshopStore } from "../../infrastructure/sqlite/workshop-store";
import { FileStoryCatalog } from "./stories/file-catalog";
import { createAccountRoutes } from "./account-routes";
import { createPlatformRoutes } from "./routes";

async function read<T = { me: { id: string; nickname: string }; accountType: string; needsNickname: boolean }>(response: Response): Promise<T> { return await response.json() as T; }
const cleanups: (() => void)[] = [];
afterEach(() => { setSystemTime(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(options: Partial<Parameters<typeof createAccountRoutes>[0]> = {}, path = ":memory:") {
  const store = new Store(path);
  const runs = new SQLiteStoryRunStore(store.db);
  const workshop = new SQLiteWorkshopStore(store.db);
  const app = new Hono();
  app.route("/api/platform", createAccountRoutes({ store, production: false, googleDemo: true, ...options }));
  app.route("/api/platform", createPlatformRoutes({ store, runs, production: false, stories: new FileStoryCatalog(join(import.meta.dir, "../../../stories")) }));
  app.onError((_error, c) => c.json({ error: "Invalid input" }, 400));
  cleanups.push(() => store.close());
  const req = (path: string, cookie = "", body?: unknown, headers: Record<string, string> = {}, address = "192.0.2.1") => app.request(`http://localhost/api/platform${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }, { requestIP: () => ({ address, family: "IPv4", port: 1234 }) });
  const guest = async (nickname: string) => {
    const response = await req("/guest", "", { nickname });
    expect(response.status).toBe(201);
    return { cookie: sessionCookie(response), me: (await read(response)).me as { id: string; nickname: string } };
  };
  return { store, workshop, req, guest };
}
function sessionCookie(response: Response, name = "festival_guest") {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))!.split(";")[0]!;
}
const source = JSON.parse(readFileSync(join(import.meta.dir, "../../../stories/deokil-trading-murder.mstory"), "utf8")) as StoryPackage;

test("nickname lengths, Unicode normalization and invalid characters", () => {
  for (const valid of ["가나", "가".repeat(10), "abcd", "a".repeat(20), "ab_1", "가나", "ｆｏｏｏ"])
    expect(nicknameSchema.safeParse(valid).success).toBe(true);
  for (const invalid of ["", "가", "가".repeat(11), "abc", "a".repeat(21), "ab cd", "ab<script>", "😀😀", "ｆｏｏ"])
    expect(nicknameSchema.safeParse(invalid).success).toBe(false);
  expect(nicknameSchema.parse(" 가나 ")).toBe("가나");
});

test("guest registration and rename enforce global case-insensitive uniqueness at write time", async () => {
  const f = fixture();
  const a = await f.guest("Alpha"), b = await f.guest("다른이");
  expect((await f.req("/guest", "", { nickname: "ALPHA" })).status).toBe(409);
  expect(await read<{ available: boolean }>((await f.req("/nicknames/availability?nickname=alpha")))).toEqual({ available: false });
  expect(await read<{ available: boolean }>((await f.req("/nicknames/availability?nickname=Alpha", a.cookie)))).toEqual({ available: true });
  expect((await f.req("/account/nickname", b.cookie, { nickname: "Alpha" })).status).toBe(409);
  expect((await f.req("/nicknames/availability?nickname=a")).status).toBe(400);
  expect((await f.req("/account/nickname", "", { nickname: "새로운이" })).status).toBe(401);
  const responses = await Promise.all([f.req("/guest", "", { nickname: "경쟁닉네임" }), f.req("/guest", "", { nickname: "경쟁닉네임" })]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
});

test("Google onboarding cannot use lobby credentials before nickname; guest and Google names share a namespace", async () => {
  const f = fixture();
  await f.guest("공통닉네임");
  const response = await f.req("/auth/google/demo", "", {}), cookie = sessionCookie(response);
  expect(response.status).toBe(200);
  expect((await read(response)).needsNickname).toBe(true);
  expect(f.store.authenticate(cookie.split("=")[1])).toBeNull();
  expect((await f.req("/guest", cookie, { nickname: "다른닉네임" })).status).toBe(409);
  expect((await f.req("/account/nickname", cookie, { nickname: "공통닉네임" })).status).toBe(409);
  expect((await f.req("/account/nickname", cookie, { nickname: "구글닉네임" })).status).toBe(200);
  expect(f.store.authenticate(cookie.split("=")[1])?.nickname).toBe("구글닉네임");
  expect((await f.req("/guest", "", { nickname: "구글닉네임" })).status).toBe(409);
});

test("guest logout revokes every session, deletes drafts and favorites, releases nickname", async () => {
  const f = fixture();
  const a = await f.guest("GuestOne");
  const otherToken = f.store.issue(a.me.id);
  const draft = f.workshop.create(a.me, { package: source, published: true, thumbnailUrl: null, difficulty: null });
  f.workshop.favorite(draft.id, a.me.id, true);
  f.workshop.favorite(draft.id, "someone-else", true);
  expect((await f.req("/account/logout", a.cookie, {})).status).toBe(200);
  expect(f.store.authenticate(otherToken)).toBeNull();
  expect((await read((await f.req("/account", a.cookie)))).me).toBeNull();
  expect(f.workshop.get(draft.id)).toBeUndefined();
  expect(f.store.db.query("SELECT * FROM workshop_favorites").all()).toHaveLength(0);
  expect(f.store.nicknameAvailable(a.me.nickname)).toBe(true);
});

test("Google logout preserves identity, drafts and renamed author for subsequent login", async () => {
  const f = fixture();
  const response = await f.req("/auth/google/demo", "", {}), cookie = sessionCookie(response), demoCookie = sessionCookie(response, "festival_google_demo");
  const renamed = await read((await f.req("/account/nickname", cookie, { nickname: "GoogleOne" })));
  const draft = f.workshop.create(renamed.me, { package: source, published: false, thumbnailUrl: null, difficulty: null });
  await f.req("/account/nickname", cookie, { nickname: "GoogleTwo" });
  expect(f.workshop.get(draft.id)?.author.name).toBe("GoogleTwo");
  await f.req("/account/logout", cookie, {});
  expect(f.workshop.get(draft.id)).toBeDefined();
  const next = await f.req("/auth/google/demo", demoCookie, {});
  expect((await read(next)).me).toEqual({ id: renamed.me.id, nickname: "GoogleTwo" });
  expect((await read((await f.req("/account", cookie)))).me).toBeNull();
});

test("auto-login cookie is HttpOnly, SameSite and persistent; stored sessions survive server restart and expire", async () => {
  const directory = mkdtempSync(join(tmpdir(), "festival-account-"));
  const path = join(directory, "db.sqlite");
  // Register directory cleanup first so databases close before removal.
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture({}, path);
  const response = await f.req("/guest", "", { nickname: "Persistent" });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
  const cookie = sessionCookie(response);
  const second = new Store(path);
  expect(second.authenticate(cookie.split("=")[1])?.nickname).toBe("Persistent");
  second.db.query("UPDATE credentials SET expires=0").run();
  expect(second.authenticate(cookie.split("=")[1])).toBeNull();
  second.close();
});

test("demo login is disabled by default and always disabled in production", async () => {
  for (const options of [{ googleDemo: false }, { googleDemo: true, production: true }]) {
    const f = fixture(options);
    expect((await f.req("/auth/google/demo", "", {})).status).toBe(503);
    expect((await f.req("/auth/google")).status).toBe(503);
  }
});

test("room membership blocks rename and logout to preserve active game identities", async () => {
  const f = fixture();
  const a = await f.guest("RoomGuest");
  f.store.state.rooms.test = { id: "test", code: "ABCDEF", hostId: a.me.id, scenarioId: "rehearsal", memberIds: [a.me.id], sessionId: null };
  expect((await f.req("/account/logout", a.cookie, {})).status).toBe(409);
  expect((await f.req("/account/nickname", a.cookie, { nickname: "Changed" })).status).toBe(409);
  expect(f.store.authenticate(a.cookie.split("=")[1])).not.toBeNull();
});

test("OAuth uses PKCE and browser-bound, expiring, single-use state; identity comes only from Google", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const mockFetch = (async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/token") ? { access_token: "server-only-token" } : { sub: "verified-subject" });
  });
  const f = fixture({ google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" }, fetch: mockFetch });
  async function start() {
    const response = await f.req("/auth/google?locale=en");
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe("https://accounts.google.com");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    return { state: target.searchParams.get("state")!, cookie: sessionCookie(response, "festival_oauth_state"), challenge: target.searchParams.get("code_challenge") };
  }
  const a = await start();
  const callback = `/auth/google/callback?state=${a.state}&code=code`;
  expect((await f.req(callback)).headers.get("location")).toBe("/?auth=failed");
  expect(calls).toHaveLength(0);
  const response = await f.req(callback, a.cookie);
  expect(response.headers.get("location")).toBe("/en/");
  const tokenBody = calls[0]!.options!.body as URLSearchParams;
  expect(tokenBody.get("client_secret")).toBe("secret");
  expect(tokenBody.get("code_verifier")).toBeTruthy();
  expect((await f.req(callback, a.cookie)).headers.get("location")).toBe("/en/?auth=failed");
  expect(calls).toHaveLength(2);
  const cookie = sessionCookie(response);
  const profile = await read((await f.req("/account", cookie)));
  expect(profile.accountType).toBe("google");
  expect(profile.needsNickname).toBe(true);
  expect(JSON.stringify(profile)).not.toContain("token");
  await f.req("/account/nickname", cookie, { nickname: "Verified" });
  await f.req("/account/logout", cookie, {});
  const b = await start();
  const again = await f.req(`/auth/google/callback?state=${b.state}&code=new-code`, b.cookie);
  expect((await read((await f.req("/account", sessionCookie(again))))).me.id).toBe(profile.me.id);
});


test("OAuth cancellation, expired state and upstream failure never issue a session", async () => {
  const f = fixture({ google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" }, fetch: (async () => new Response("unavailable", { status: 503 })) });
  const start = async () => {
    const response = await f.req("/auth/google");
    return { state: new URL(response.headers.get("location")!).searchParams.get("state")!, cookie: sessionCookie(response, "festival_oauth_state") };
  };
  const cancelled = await start();
  const denial = await f.req(`/auth/google/callback?state=${cancelled.state}&error=access_denied`, cancelled.cookie);
  expect(denial.headers.get("location")).toBe("/?auth=cancelled");
  expect(denial.headers.getSetCookie().some((cookie) => cookie.startsWith("festival_guest="))).toBe(false);
  const failed = await start();
  const failure = await f.req(`/auth/google/callback?state=${failed.state}&code=untrusted`, failed.cookie);
  expect(failure.headers.get("location")).toBe("/?auth=failed");
  expect(failure.headers.getSetCookie().some((cookie) => cookie.startsWith("festival_guest="))).toBe(false);
  const expired = await start();
  setSystemTime(Date.now() + 601000);
  expect((await f.req(`/auth/google/callback?state=${expired.state}&code=old`, expired.cookie)).headers.get("location")).toBe("/?auth=failed");
  expect(Object.values(f.store.state.guests)).toHaveLength(0);
});


test("failed persistence rolls back account memory, credentials and workshop mutations", async () => {
  const f = fixture();
  const a = await f.guest("Rollback");
  const draft = f.workshop.create(a.me, { package: source, published: false, thumbnailUrl: null, difficulty: null });
  const save = spyOn(f.store, "save").mockImplementation(() => { throw Error("disk failure"); });
  try {
    expect(() => f.store.logout(a.me)).toThrow("disk failure");
    expect(f.store.authenticate(a.cookie.split("=")[1])?.id).toBe(a.me.id);
    expect(f.workshop.get(draft.id)).toBeDefined();
    expect(() => f.store.rename(f.store.state.guests[a.me.id]!, "Changed")).toThrow("disk failure");
    expect(f.store.state.guests[a.me.id]?.nickname).toBe("Rollback");
    expect(f.store.nicknameAvailable("ROLLBACK")).toBe(false);
    expect(f.store.nicknameAvailable("Changed")).toBe(true);
    expect(f.workshop.get(draft.id)?.author.name).toBe("Rollback");
    expect(() => f.store.createGuest("Rejected")).toThrow("disk failure");
    expect(f.store.nicknameAvailable("Rejected")).toBe(true);
    expect(() => f.store.googleAccount("google:rejected")).toThrow("disk failure");
    expect(Object.values(f.store.state.guests)).toHaveLength(1);
    expect(f.store.db.query("SELECT * FROM google_accounts").all()).toHaveLength(0);
  } finally { save.mockRestore(); }
});


test("OAuth initiation has no shared pending capacity; cookie tampering cannot create a session", async () => {
  const f = fixture({ google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" } });
  let response: Response | undefined;
  for (let i = 0; i < 1001; i++) response = await f.req("/auth/google");
  expect(response!.status).toBe(302);
  const state = new URL(response!.headers.get("location")!).searchParams.get("state")!;
  const cookie = sessionCookie(response!, "festival_oauth_state");
  expect((await f.req(`/auth/google/callback?state=${state}&code=bad`, cookie + "tampered")).headers.get("location")).toBe("/?auth=failed");
  expect(f.store.db.query("SELECT * FROM oauth_consumed").all()).toHaveLength(0);
});

test("account deletion revokes every session, removes Google identity and owned content only", async () => {
  const f = fixture();
  const response = await f.req("/auth/google/demo", "", {});
  const cookie = sessionCookie(response), demoCookie = sessionCookie(response, "festival_google_demo");
  const { me } = await read(await f.req("/account/nickname", cookie, { nickname: "DeleteGoogle" }));
  const secondToken = f.store.issue(me.id);
  const other = await f.guest("OtherOwner");
  const own = f.workshop.create(me, { package: source, published: true, thumbnailUrl: null, difficulty: null });
  const retained = f.workshop.create(other.me, { package: source, published: true, thumbnailUrl: null, difficulty: null });
  f.workshop.favorite(own.id, other.me.id, true);
  f.workshop.favorite(retained.id, me.id, true);
  expect((await f.req("/account/delete", "", {})).status).toBe(401);
  const deletion = await f.req("/account/delete", cookie, {});
  expect(deletion.status).toBe(200);
  expect(deletion.headers.getSetCookie().some(value => value.startsWith("festival_guest=;") && value.includes("Max-Age=0"))).toBe(true);
  expect(f.store.authenticate(secondToken)).toBeNull();
  expect(f.store.nicknameAvailable(me.nickname)).toBe(true);
  expect(f.workshop.get(own.id)).toBeUndefined();
  expect(f.workshop.get(retained.id)).toBeDefined();
  expect(f.store.db.query("SELECT * FROM workshop_favorites").all()).toHaveLength(0);
  expect(f.store.db.query("SELECT * FROM google_accounts WHERE guest_id=?").all(me.id)).toHaveLength(0);
  const next = await read(await f.req("/auth/google/demo", demoCookie, {}));
  expect(next.me.id).not.toBe(me.id);
  expect(next.needsNickname).toBe(true);
});

test("account deletion rejects active room members and rolls back failed persistence", async () => {
  const f = fixture();
  const a = await f.guest("KeepAccount");
  f.store.state.rooms.test = { id: "test", code: "ABCDEF", hostId: a.me.id, scenarioId: "rehearsal", memberIds: [a.me.id], sessionId: null };
  expect((await f.req("/account/delete", a.cookie, {})).status).toBe(409);
  delete f.store.state.rooms.test;
  const draft = f.workshop.create(a.me, { package: source, published: false, thumbnailUrl: null, difficulty: null });
  const save = spyOn(f.store, "save").mockImplementation(() => { throw Error("disk failure"); });
  try {
    expect(() => f.store.deleteAccount(a.me)).toThrow("disk failure");
    expect(f.store.authenticate(a.cookie.split("=")[1])?.id).toBe(a.me.id);
    expect(f.workshop.get(draft.id)).toBeDefined();
    expect(f.store.nicknameAvailable(a.me.nickname)).toBe(false);
  } finally { save.mockRestore(); }
});

test("account deletion clears a pending Google login without deleting retained OAuth identity data", async () => {
  let upstreamCalls = 0;
  const f = fixture({
    google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" },
    fetch: async () => { upstreamCalls++; return Response.json({ sub: "must-not-be-created" }); },
  });
  const pending = await f.req("/auth/google?locale=en");
  const state = new URL(pending.headers.get("location")!).searchParams.get("state")!;
  const pendingCookie = sessionCookie(pending, "festival_oauth_state");
  const login = await f.req("/auth/google/demo", "", {});
  const deletion = await f.req("/account/delete", sessionCookie(login), {});
  expect(deletion.status).toBe(200);
  expect(deletion.headers.getSetCookie().some((value) => value.startsWith("festival_oauth_state=;") && value.includes("Max-Age=0"))).toBe(true);
  // The browser's shared cookie jar applies the deletion response to the other tab too.
  const callback = await f.req(`/auth/google/callback?state=${state}&code=stale`, "");
  expect(callback.headers.get("location")).toBe("/?auth=failed");
  expect(upstreamCalls).toBe(0);
  expect(f.store.db.query("SELECT * FROM google_accounts").all()).toHaveLength(0);
  expect(pendingCookie).toContain("festival_oauth_state=");
});

test("OAuth invalid state returns to a fixed localized app URL without contacting Google or issuing credentials", async () => {
  let calls = 0;
  const f = fixture({ google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" }, fetch: async () => { calls++; throw Error("must not fetch"); } });
  const start = await f.req("/auth/google?locale=en");
  const cookie = sessionCookie(start, "festival_oauth_state");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  for (const [query, boundCookie, expected] of [
    [`state=${state}&code=x&locale=en&returnTo=https://evil.invalid`, "", "/?auth=failed"],
    [`state=wrong&code=x`, cookie, "/en/?auth=failed"],
    ["code=x", cookie, "/en/?auth=failed"],
    [`state=${state}&code=x`, `${cookie}tampered`, "/?auth=failed"],
  ]) {
    const response = await f.req(`/auth/google/callback?${query}`, boundCookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(expected);
    const preservedPending = boundCookie === cookie;
    expect(response.headers.getSetCookie().some(value => value.startsWith("festival_oauth_state=;") && value.includes("Max-Age=0"))).toBe(!preservedPending);
    expect(response.headers.getSetCookie().some(value => value.startsWith("festival_guest="))).toBe(false);
  }
  setSystemTime(Date.now() + 600001);
  const expired = await f.req(`/auth/google/callback?state=${state}&code=x`, cookie);
  expect(expired.headers.get("location")).toBe("/en/?auth=failed");
  expect(expired.headers.getSetCookie().some(value => value.startsWith("festival_oauth_state=;"))).toBe(true);
  expect(calls).toBe(0);
  expect(f.store.db.query("SELECT * FROM credentials").all()).toHaveLength(0);
  expect(f.store.db.query("SELECT * FROM oauth_consumed").all()).toHaveLength(0);
});

test("nickname availability throttles transport IPs independently, ignores forged headers and preserves account access", async () => {
  const f = fixture();
  const owner = await f.guest("ThrottleOwner");
  for (let i = 0; i < 60; i++) expect((await f.req("/nicknames/availability?nickname=Available")).status).toBe(200);
  const limited = await f.req("/nicknames/availability?nickname=Available", "", undefined, { "X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.10" });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await f.req("/nicknames/availability?nickname=Available", "", undefined, {}, "192.0.2.2")).status).toBe(200);
  expect((await f.req("/nicknames/availability?nickname=Available", owner.cookie)).status).toBe(200);
  expect(f.store.authenticate(owner.cookie.split("=")[1])?.id).toBe(owner.me.id);
  setSystemTime(Date.now() + 60000);
  expect((await f.req("/nicknames/availability?nickname=Available")).status).toBe(200);
});

test("a mismatched or missing OAuth state leaves the valid pending browser attempt usable", async () => {
  let calls = 0;
  const f = fixture({ google: { clientId: "client", clientSecret: "secret", origin: "http://localhost" }, fetch: async (url) => { calls++; return Response.json(url.endsWith("/token") ? { access_token: "token" } : { sub: "preserved" }); } });
  const start = await f.req("/auth/google?locale=en");
  let cookie = sessionCookie(start, "festival_oauth_state");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  for (const query of ["state=unrelated", "code=stray"]) {
    const stray = await f.req(`/auth/google/callback?${query}`, cookie);
    expect(stray.headers.get("location")).toBe("/en/?auth=failed");
    // Apply any cookie update as a browser would, before the legitimate callback.
    const update = stray.headers.getSetCookie().find(value => value.startsWith("festival_oauth_state="));
    if (update) cookie = update.includes("Max-Age=0") ? "" : update.split(";")[0]!;
  }
  expect(calls).toBe(0);
  const valid = await f.req(`/auth/google/callback?state=${state}&code=legitimate`, cookie);
  expect(valid.headers.get("location")).toBe("/en/");
  expect(sessionCookie(valid)).toContain("festival_guest=");
  expect(calls).toBe(2);
});

test("nickname limiter bounds client buckets and releases expired capacity", async () => {
  const f = fixture();
  for (let i = 0; i < 4096; i++) {
    expect((await f.req("/nicknames/availability?nickname=Available", "", undefined, {}, `client-${i}`)).status).toBe(200);
  }
  expect((await f.req("/nicknames/availability?nickname=Available", "", undefined, {}, "new-client")).status).toBe(429);
  setSystemTime(Date.now() + 60000);
  expect((await f.req("/nicknames/availability?nickname=Available", "", undefined, {}, "new-client")).status).toBe(200);
});

test("nickname index restores Unicode names on restart and updates only after successful account mutations", () => {
  const directory = mkdtempSync(join(tmpdir(), "festival-names-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "db.sqlite");
  const f = fixture({}, path);
  const guest = f.store.createGuest("Ｆｏｏｏ");
  const second = new Store(path);
  try {
    expect(second.nicknameAvailable("fooo")).toBe(false);
    expect(second.nicknameAvailable("FOOO", guest.id)).toBe(true);
    const restored = second.state.guests[guest.id]!;
    second.rename(restored, "Updated");
    expect(second.nicknameAvailable("fooo")).toBe(true);
    expect(second.nicknameAvailable("updated")).toBe(false);
    second.logout(restored);
    expect(second.nicknameAvailable("UPDATED")).toBe(true);
    const google = second.googleAccount("google:indexed");
    expect(second.nicknameAvailable("GoogleName")).toBe(true);
    second.rename(google, "GoogleName");
    second.logout(google);
    expect(second.nicknameAvailable("googlename")).toBe(false);
    expect(second.googleAccount("google:indexed").id).toBe(google.id);
  } finally { second.close(); }
});

test("legacy duplicate normalized nicknames remain reserved until every owner releases them", () => {
  const directory = mkdtempSync(join(tmpdir(), "festival-legacy-names-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "db.sqlite");
  const f = fixture({}, path);
  // Old state files can predate case-insensitive nickname uniqueness.
  f.store.state.guests.first = { id: "first", nickname: "Legacy" };
  f.store.state.guests.second = { id: "second", nickname: "Ｌｅｇａｃｙ" };
  f.store.save();
  const restored = new Store(path);
  try {
    expect(restored.nicknameAvailable("legacy")).toBe(false);
    expect(restored.nicknameAvailable("legacy", "first")).toBe(false);
    expect(() => restored.createGuest("LEGACY")).toThrow();
    restored.rename(restored.state.guests.first!, "Renamed");
    expect(restored.nicknameAvailable("legacy")).toBe(false);
    expect(restored.nicknameAvailable("legacy", "second")).toBe(true);
    restored.logout(restored.state.guests.second!);
    expect(restored.nicknameAvailable("legacy")).toBe(true);
    expect(restored.nicknameAvailable("renamed")).toBe(false);
  } finally { restored.close(); }
});
