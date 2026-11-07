import { test, expect } from "bun:test";
import type { Snapshot, ServerEvent } from "@festival/shared";
test("HTTP + real WebSocket: guests, room, session, ballots, reconnect, return", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000),
    origin = `http://127.0.0.1:${port}`;
  const process = Bun.spawn([Bun.which("bun")!, "apps/server/src/index.ts"], {
    env: {
      ...Bun.env,
      PORT: String(port),
      DATABASE_PATH: ":memory:",
      APP_ORIGIN: origin,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const sockets: WebSocket[] = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/api/health")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(30);
    }
    expect(ready).toBe(true);
    for (const path of ["/missing-page", "/en/missing-page/", "/workshop/unknown", "/missing.js"]) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain('content="noindex,nofollow"');
    }
    for (const path of ["/", "/en", "/workshop", "/en/workshop/", "/workshop/editor", "/en/mypage/", "/privacy", "/en/privacy/", "/terms/", "/en/terms", "/robots.txt", "/sitemap.xml"]) {
      expect((await fetch(origin + path)).status).toBe(200);
    }
    expect((await fetch(origin + "/api/missing")).status).toBe(404);
    expect((await fetch(origin + "/api")).status).toBe(404);
    expect((await fetch(origin + "/en/missing", { method: "HEAD" })).status).toBe(404);
    const req = async (
      path: string,
      cookie = "",
      body?: unknown,
      requestOrigin = origin,
    ) =>
      fetch(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: requestOrigin,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await req("/api/lobby/state")).status).toBe(401);
    expect(
      (await req("/api/platform/guest", "", { nickname: "bad" }, "https://evil.invalid"))
        .status,
    ).toBe(403);
    const guest = async (nickname: string) => {
      const r = await req("/api/platform/guest", "", { nickname });
      expect(r.status).toBe(201);
      return {
        cookie: r.headers.get("set-cookie")!.split(";")[0],
        me: ((await r.json()) as { me: { id: string; nickname: string } }).me,
      };
    };
    const a = await guest("방장"),
      b = await guest("참가자");
    const connect = async (cookie: string) => {
      let latest: Snapshot | undefined;
      const events: ServerEvent[] = [];
      const ws = new WebSocket(origin.replace("http", "ws") + "/api/lobby/ws", {
        headers: { Cookie: cookie, Origin: origin },
      });
      sockets.push(ws);
      ws.onmessage = (e) => {
        const event = JSON.parse(String(e.data)) as ServerEvent;
        events.push(event);
        if (event.type === "snapshot") latest = event.data;
      };
      await wait(() => !!latest);
      return {
        ws,
        events,
        get latest() {
          return latest!;
        },
      };
    };
    const aa = await connect(a.cookie),
      bb = await connect(b.cookie);
    expect(
      (await req("/api/lobby/rooms", a.cookie, { scenarioId: "rehearsal" })).status,
    ).toBe(201);
    await wait(() => !!aa.latest.room);
    const roomId = aa.latest.room!.id;
    await wait(() => bb.latest.rooms.some((room) => room.id === roomId));
    const listed = await req("/api/lobby/state", b.cookie);
    expect(((await listed.json()) as Snapshot).rooms.map((room) => room.id)).toContain(roomId);
    expect(
      (await req("/api/lobby/rooms/join", b.cookie, { code: aa.latest.room!.code }))
        .status,
    ).toBe(200);
    await wait(() => aa.latest.room?.count === 2);
    await wait(() => !bb.latest.rooms.some((room) => room.id === roomId));
    expect(((await (await req("/api/lobby/state", b.cookie)).json()) as Snapshot).rooms).toEqual([]);
    const exitPath = "/api/lobby/rooms/solo-exit";
    expect((await req(exitPath, "", { roomId, soloPlayId: null })).status).toBe(401);
    expect((await req(exitPath, b.cookie, { roomId, soloPlayId: null })).status).toBe(400);
    expect((await req(exitPath, a.cookie, { roomId, soloPlayId: null }, "https://evil.invalid")).status).toBe(403);
    expect((await req(exitPath, a.cookie, { roomId: "bad", soloPlayId: null })).status).toBe(400);
    const send = async (client: typeof aa, type: string, targetId?: string, mode?: "solo" | "multiplayer") => {
      const requestId = crypto.randomUUID();
      client.ws.send(JSON.stringify({ type, requestId, targetId, mode }));
      await wait(() =>
        client.events.some(
          (e) => e.type === "ack" && e.requestId === requestId,
        ),
      );
    };
    await send(aa, "start");
    await wait(() => !!bb.latest.room?.session);
    expect(aa.latest.room!.session!.role.name).not.toBe(
      bb.latest.room!.session!.role.name,
    );
    const id = bb.latest.room!.session!.id;
    bb.ws.close();
    await wait(
      () =>
        aa.latest.room?.members.some((m) => m.id === b.me.id && !m.online) ??
        false,
    );
    const reconnected = await connect(b.cookie);
    expect(reconnected.latest.room!.session!.id).toBe(id);
    await send(aa, "advance");
    await send(aa, "advance");
    await send(aa, "vote", b.me.id);
    expect(aa.latest.room!.session!.result).toBeNull();
    await send(reconnected, "vote", a.me.id);
    await wait(() => aa.latest.room?.session?.phase === "reveal");
    await send(aa, "return");
    expect(aa.latest.room!.session).toBeNull();
    expect(aa.latest.room!.count).toBe(2);
    expect((await req("/api/platform/account/logout", a.cookie, {})).status).toBe(409);
    await send(reconnected, "leave");
    await send(aa, "mode", undefined, "solo");
    await send(aa, "start");
    const firstAttempt = aa.latest.room!.soloPlayId;
    expect(firstAttempt).toBeString();
    const sameHostTab = await connect(a.cookie);
    expect(sameHostTab.latest.room!.soloPlayId).toBe(firstAttempt);
    sameHostTab.ws.close();
    expect(((await (await req("/api/lobby/state", a.cookie)).json()) as Snapshot).room!.soloStarted).toBe(true);
    expect((await req(exitPath, a.cookie, { roomId: crypto.randomUUID(), soloPlayId: firstAttempt })).status).toBe(400);
    expect((await req(exitPath, a.cookie, { roomId, soloPlayId: firstAttempt })).status).toBe(200);
    await wait(() => aa.latest.room?.status === "waiting");
    await send(aa, "start");
    const newAttempt = aa.latest.room!.soloPlayId;
    expect(newAttempt).not.toBe(firstAttempt);
    expect((await req(exitPath, a.cookie, { roomId, soloPlayId: firstAttempt })).status).toBe(200);
    expect(((await (await req("/api/lobby/state", a.cookie)).json()) as Snapshot).room!.soloStarted).toBe(true);
    expect((await req(exitPath, a.cookie, { roomId, soloPlayId: newAttempt })).status).toBe(200);
    await wait(() => aa.latest.room?.status === "waiting");
    await send(aa, "leave");
    await wait(() => !reconnected.latest.rooms.some((room) => room.id === roomId));
    expect(((await (await req("/api/lobby/state", b.cookie)).json()) as Snapshot).rooms.map((room) => room.id)).not.toContain(roomId);
    let closed = false;
    aa.ws.addEventListener("close", () => { closed = true; });
    expect((await req("/api/platform/account/logout", a.cookie, {})).status).toBe(200);
    await wait(() => closed);
    expect((await req("/api/lobby/state", a.cookie)).status).toBe(401);
    expect((await req("/api/lobby/state", b.cookie)).status).toBe(200);
    expect((await fetch(origin + "/api/health")).status).toBe(200);
  } finally {
    for (const ws of sockets) ws.close();
    process.kill();
    await process.exited;
  }
}, 15000);
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw Error("Timed out waiting for server event");
}
