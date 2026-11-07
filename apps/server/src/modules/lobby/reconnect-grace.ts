import type { Game } from "../game/game";

export const RECONNECT_GRACE_MS = 60_000;
type Schedule = (expire: () => void, delay: number) => () => void;
const schedule: Schedule = (expire, delay) => {
  const timer = setTimeout(expire, delay);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Presence is counted per socket; only the last disconnect starts the grace. */
export class ReconnectGrace {
  private pending = new Map<string, { cancel: () => void; expiresAt: number; roomId: string }>();
  constructor(
    private game: Pick<Game, "online" | "roomFor" | "expireConnection">,
    private changed: () => void,
    private later: Schedule = schedule,
    private now: () => number = Date.now,
  ) {}

  connect(guestId: string) {
    const pending = this.pending.get(guestId);
    if (pending) {
      pending.cancel();
      // Enforce the deadline even if a busy event loop delayed the timer callback.
      if (pending.expiresAt <= this.now()) {
        this.game.expireConnection(guestId, pending.roomId);
        this.changed();
      }
    }
    this.pending.delete(guestId);
    this.game.online.set(guestId, (this.game.online.get(guestId) ?? 0) + 1);
  }

  disconnect(guestId: string) {
    const remaining = Math.max(0, (this.game.online.get(guestId) ?? 1) - 1);
    this.game.online.set(guestId, remaining);
    if (remaining || this.pending.has(guestId)) return;
    const room = this.game.roomFor(guestId);
    if (!room) return;
    const roomId = room.id;
    const entry = { cancel: () => {}, expiresAt: this.now() + RECONNECT_GRACE_MS, roomId };
    this.pending.set(guestId, entry);
    entry.cancel = this.later(() => {
      // A cancelled callback must never expire a later connection or grace period.
      if (this.pending.get(guestId) !== entry) return;
      this.pending.delete(guestId);
      this.game.expireConnection(guestId, roomId);
      this.changed();
    }, RECONNECT_GRACE_MS);
  }
}
