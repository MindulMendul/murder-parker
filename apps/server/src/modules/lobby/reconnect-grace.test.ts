import { afterEach, expect, test } from "bun:test";
import { Store } from "../../store";
import { Game } from "../game/game";
import { storyCatalog } from "../platform/stories/catalog";
import { ReconnectGrace, RECONNECT_GRACE_MS } from "./reconnect-grace";
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup(playing: boolean) {
  const store = new Store(":memory:");
  stores.push(store);
  const game = new Game(store, storyCatalog);
  const a = { id: "a", nickname: "host" }, b = { id: "b", nickname: "guest" };
  for (const guest of [a, b]) store.state.guests[guest.id] = guest;
  let now = 0;
  const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  let changes = 0;
  const presence = new ReconnectGrace(game, () => changes++, (fire, delay) => {
    const timer = { at: now + delay, fire, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  }, () => now);
  presence.connect(a.id); presence.connect(b.id);
  const room = game.create(a, "rehearsal"); game.join(b, room.code);
  if (playing) game.command(a, { type: "start", requestId: "start" });
  return { game, a, b, room, presence, timers, get changes() { return changes; }, delay(ms: number) { now += ms; }, tick(ms: number) {
    now += ms;
    for (const timer of timers.splice(0)) {
      if (timer.at <= now && !timer.cancelled) timer.fire();
      else timers.push(timer);
    }
  } };
}
for (const playing of [false, true]) {
  const state = playing ? "playing" : "waiting";
  test(`${state}: last disconnect expires room access after exactly 60 seconds`, () => {
    const s = setup(playing), sessionId = s.room.sessionId;
    s.presence.disconnect(s.b.id);
    expect(s.timers[0].at).toBe(RECONNECT_GRACE_MS);
    s.tick(59_999); expect(s.game.roomFor(s.b.id)?.id).toBe(s.room.id);
    s.tick(1); expect(s.game.roomFor(s.b.id)).toBeUndefined();
    expect(s.game.snapshot(s.b).room).toBeNull();
    s.presence.connect(s.b.id);
    expect(s.game.snapshot(s.b).room).toBeNull();
    expect(() => s.game.command(s.b, { type: "advance", requestId: "old" })).toThrow("방");
    if (sessionId) {
      expect(s.game.state.sessions[sessionId].participants).toHaveLength(2);
      expect(s.game.state.sessions[sessionId].phase).toBe("briefing");
      expect(() => s.game.join(s.b, s.room.code)).toThrow("진행");
    }
    expect(s.changes).toBe(1);
  });
  test(`${state}: reconnect cancels expiry and stale timer cannot expire a new grace`, () => {
    const s = setup(playing);
    s.presence.disconnect(s.b.id); const stale = s.timers[0].fire;
    s.tick(59_999); s.presence.connect(s.b.id);
    stale(); expect(s.game.roomFor(s.b.id)?.id).toBe(s.room.id);
    s.presence.disconnect(s.b.id); stale();
    s.tick(59_999); expect(s.game.roomFor(s.b.id)?.id).toBe(s.room.id);
    s.tick(1); expect(s.game.roomFor(s.b.id)).toBeUndefined();
  });
}
test("one tab closing does not start expiry; host expiry transfers waiting room ownership", () => {
  const s = setup(false);
  s.presence.connect(s.a.id); s.presence.disconnect(s.a.id);
  expect(s.timers).toHaveLength(0);
  s.presence.disconnect(s.a.id); s.tick(60_000);
  expect(s.room.hostId).toBe(s.b.id);
  s.presence.disconnect(s.b.id); s.tick(60_000);
  expect(s.game.state.rooms[s.room.id]).toBeUndefined();
});
test("an old room's expiry cannot remove a newly joined room", () => {
  const s = setup(false);
  s.presence.disconnect(s.b.id);
  s.game.command(s.b, { type: "leave", requestId: "leave" });
  const next = s.game.create(s.b, "rehearsal");
  s.tick(60_000);
  expect(s.game.roomFor(s.b.id)?.id).toBe(next.id);
});

for (const playing of [false, true]) {
  test(`late reconnect cannot beat an overdue timer (playing=${playing})`, () => {
    const s = setup(playing);
    s.presence.disconnect(s.b.id);
    s.delay(60_000); // Simulate a delayed timer while the reconnect event runs first.
    s.presence.connect(s.b.id);
    expect(s.game.roomFor(s.b.id)).toBeUndefined();
    s.timers[0].fire();
    expect(s.game.online.get(s.b.id)).toBe(1);
    expect(s.changes).toBe(1);
  });
}
