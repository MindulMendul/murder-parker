import { test, expect, afterEach } from "bun:test";
import { Store } from "./store";
import { Game } from "./game";
import { storyCatalog } from "./modules/platform/stories/catalog";
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const game = new Game(store, storyCatalog);
  const a = { id: "a", nickname: "안내" },
    b = { id: "b", nickname: "무대" },
    c = { id: "c", nickname: "손님" };
  for (const me of [a, b, c]) {
    store.state.guests[me.id] = me;
    game.online.set(me.id, 1);
  }
  return { store, game, a, b, c };
}
const cmd = (type: "start" | "advance" | "return" | "leave") => ({
  type,
  requestId: crypto.randomUUID(),
});
test("room discovery follows vacancy and waiting status without hiding the member's room", () => {
  const { game, a, b, c } = setup();
  const room = game.create(a, "rehearsal");
  expect(game.snapshot(c).rooms.map((item) => item.id)).toEqual([room.id]);
  game.join(b, room.code);
  expect(game.snapshot(c).rooms).toEqual([]);
  expect(game.snapshot(a).room?.id).toBe(room.id);
  game.command(b, cmd("leave"));
  expect(game.snapshot(c).rooms.map((item) => item.id)).toEqual([room.id]);
  game.join(b, room.code);
  game.command(a, cmd("start"));
  // Even a persisted playing room with a vacant seat must not be advertised.
  room.memberIds.pop();
  expect(game.snapshot(c).rooms).toEqual([]);
  expect(game.snapshot(a).room?.session).not.toBeNull();
});
test("room discovery hides an active solo room even when its member disconnects", () => {
  const { game, a, b } = setup();
  const room = game.create(a, "rehearsal");
  game.command(a, { type: "mode", mode: "solo", requestId: "solo" });
  game.command(a, cmd("start"));
  room.memberIds = [];
  expect(game.snapshot(b).rooms).toEqual([]);
  expect(game.summary(room).status).toBe("playing");
});
test("only a full connected room can start; host authorization and duplicate start", () => {
  const { game, a, b } = setup();
  game.create(a, "rehearsal");
  expect(() => game.command(a, cmd("start"))).toThrow();
  game.join(b, game.needRoom(a.id).code);
  expect(() => game.command(b, cmd("start"))).toThrow("방장");
  game.online.set(b.id, 0);
  expect(() => game.command(a, cmd("start"))).toThrow("접속");
  game.online.set(b.id, 1);
  game.command(a, cmd("start"));
  expect(() => game.command(a, cmd("start"))).toThrow("이미");
  expect(Object.keys(game.state.sessions)).toHaveLength(1);
});
test("personalized secrets, private ballots, complete game, return, replay", () => {
  const { game, a, b, c } = setup();
  const room = game.create(a, "rehearsal");
  game.join(b, room.code);
  game.command(a, cmd("start"));
  const first = room.sessionId!;
  expect(() => game.join(c, room.code)).toThrow("진행");
  const av = game.snapshot(a).room!.session!,
    bv = game.snapshot(b).room!.session!;
  expect(av.role.name).not.toBe(bv.role.name);
  expect(av.clues).toEqual([]);
  expect(JSON.stringify(av)).not.toContain(bv.role.secret);
  expect(() => game.command(b, cmd("leave"))).toThrow();
  game.command(a, cmd("advance"));
  game.command(a, cmd("advance"));
  expect(() =>
    game.command(a, { type: "vote", requestId: "1", targetId: "unknown" }),
  ).toThrow();
  game.command(a, { type: "vote", requestId: "2", targetId: b.id });
  expect(game.snapshot(b).room!.session!.result).toBeNull();
  expect(() =>
    game.command(a, { type: "vote", requestId: "3", targetId: a.id }),
  ).toThrow("이미");
  game.command(b, { type: "vote", requestId: "4", targetId: a.id });
  expect(game.snapshot(a).room!.session!.phase).toBe("reveal");
  game.command(a, cmd("return"));
  expect(room.sessionId).toBeNull();
  expect(game.state.sessions[first].endedAt).not.toBeNull();
  expect(game.state.sessions[first].participants).toHaveLength(2);
  game.command(a, cmd("start"));
  expect(room.sessionId).not.toBe(first);
});
test("capacity, host transfer, room deletion, unavailable scenario", () => {
  const { game, a, b, c } = setup();
  expect(() => game.create(a, "detective-x")).toThrow();
  const room = game.create(a, "rehearsal");
  game.join(b, room.code);
  expect(() => game.join(c, room.code)).toThrow("가득");
  game.command(a, cmd("leave"));
  expect(room.hostId).toBe(b.id);
  game.command(b, cmd("leave"));
  expect(game.state.rooms[room.id]).toBeUndefined();
});
test("guest credentials expire and unknown credentials fail", () => {
  const { store, a } = setup();
  const token = store.issue(a.id);
  expect(store.authenticate(token)).toEqual(a);
  expect(store.authenticate("invalid")).toBeNull();
  store.db.exec("UPDATE credentials SET expires=0");
  expect(store.authenticate(token)).toBeNull();
});
test("database survives process restart with role assignments and guest identity", () => {
  const path = `/tmp/festival-test-${crypto.randomUUID()}.sqlite`;
  const store = new Store(path);
  stores.push(store);
  const game = new Game(store, storyCatalog);
  const a = { id: "a", nickname: "A" },
    b = { id: "b", nickname: "B" };
  store.state.guests = { a, b };
  game.online.set("a", 1);
  game.online.set("b", 1);
  const token = store.issue("a");
  const room = game.create(a, "rehearsal");
  game.join(b, room.code);
  game.command(a, cmd("start"));
  const id = room.sessionId!;
  const restored = new Store(path);
  stores.push(restored);
  expect(restored.authenticate(token)).toEqual(a);
  expect(new Game(restored, storyCatalog).snapshot(a).room!.session!.id).toBe(id);
});

test("host can open a one-person room, start alone and return to multiplayer", () => {
  const { game, a, b } = setup();
  const room = game.create(a, "rehearsal");
  game.command(a, { type: "mode", mode: "solo", requestId: "solo" });
  expect(game.snapshot(a).room!.capacity).toBe(1);
  expect(game.snapshot(a).room!.mode).toBe("solo");
  expect(game.snapshot(a).room!.soloStory).toEqual({ id: "deokil-trading-murder", title: "덕일상사 살인사건" });
  expect(game.snapshot(a).room!.scenario.id).toBe("rehearsal");
  expect(() => game.join(b, room.code)).toThrow("가득");
  game.command(a, cmd("start"));
  expect(game.snapshot(a).room!.soloStarted).toBe(true);
  expect(game.snapshot(a).room!.soloPlayId).toBeString();
  expect(game.snapshot(a).room!.status).toBe("playing");
  expect(game.snapshot(a).room!.session).toBeNull();
  expect(() => game.command(a, cmd("start"))).toThrow("이미");
  expect(() => game.command(a, { type: "mode", mode: "multiplayer", requestId: "playing" })).toThrow("시작 전");
  expect(() => game.command(a, cmd("leave"))).toThrow("게임 중");
  game.command(a, { type: "solo-return", requestId: "return" });
  expect(game.snapshot(a).room!.status).toBe("waiting");
  game.command(a, { type: "mode", mode: "multiplayer", requestId: "multi" });
  expect(game.snapshot(a).room!.capacity).toBe(2);
  expect(game.snapshot(a).room!.title).toBe("사라진 축제 초대장");
  game.join(b, room.code);
  game.command(a, cmd("start"));
  expect(game.snapshot(a).room!.session).not.toBeNull();
});

test("solo page exit ends only the host's matching room attempt, including after state reload", () => {
  const { game, store, a, b } = setup();
  const room = game.create(a, "rehearsal");
  game.join(b, room.code);
  expect(() => game.endSolo(b, room.id, null)).toThrow("방장");
  game.command(b, cmd("leave"));
  game.command(a, { type: "mode", mode: "solo", requestId: "solo" });
  game.command(a, cmd("start"));
  const firstAttempt = room.soloPlayId!;
  expect(() => game.endSolo(a, crypto.randomUUID(), firstAttempt)).toThrow("현재 방");
  expect(game.snapshot(a).room!.soloStarted).toBe(true);
  const reloaded = new Game(store, storyCatalog);
  reloaded.endSolo(a, room.id, firstAttempt);
  expect(reloaded.snapshot(a).room!.status).toBe("waiting");
  expect(reloaded.snapshot(a).room!.soloPlayId).toBeNull();
  reloaded.online.set(a.id, 1);
  reloaded.command(a, cmd("start"));
  expect(room.soloPlayId).not.toBe(firstAttempt);
  reloaded.endSolo(a, room.id, firstAttempt);
  expect(reloaded.snapshot(a).room!.soloStarted).toBe(true);
  reloaded.endSolo(a, room.id, room.soloPlayId!);
  reloaded.endSolo(a, room.id, firstAttempt);
  expect(reloaded.snapshot(a).room!.status).toBe("waiting");
});

test("solo mode changes enforce host, single occupancy, presence and lifecycle", () => {
  const { game, a, b } = setup();
  const room = game.create(a, "rehearsal");
  game.join(b, room.code);
  expect(() => game.command(b, { type: "mode", mode: "solo", requestId: "guest" })).toThrow("방장");
  expect(() => game.command(a, { type: "mode", mode: "solo", requestId: "full" })).toThrow("혼자");
  expect(() => game.command(a, { type: "solo-return", requestId: "invalid" })).toThrow("진행 중");
  game.command(b, cmd("leave"));
  game.command(a, { type: "mode", mode: "solo", requestId: "solo" });
  game.online.set(a.id, 0);
  expect(() => game.command(a, cmd("start"))).toThrow("접속");
  expect(game.snapshot(a).room!.soloStarted).toBe(false);
});
