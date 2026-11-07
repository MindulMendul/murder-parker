import { soloRoomExitSchema, type RoomView } from "@festival/shared";

export type SoloExit = { roomId: string; soloPlayId: string | null };
const exitKey = "festival_solo_exit";

export function rememberSoloExit(storage: Storage, exit: SoloExit) {
  try { storage.setItem(exitKey, JSON.stringify(exit)); } catch { /* Explicit return still works without storage. */ }
}

export function clearSoloExit(storage: Storage, exit: SoloExit) {
  try {
    const saved = JSON.parse(storage.getItem(exitKey) ?? "null");
    if (saved?.roomId === exit.roomId && saved?.soloPlayId === exit.soloPlayId) storage.removeItem(exitKey);
  } catch { /* Ignore unavailable or invalid tab storage. */ }
}

export function matchesSoloExit(exit: SoloExit, room: RoomView | null) {
  return !!room?.soloStarted && room.id === exit.roomId && room.soloPlayId === exit.soloPlayId;
}

export function pendingSoloExit(storage: Storage, room: RoomView | null): SoloExit | null {
  try {
    const parsed = soloRoomExitSchema.safeParse(JSON.parse(storage.getItem(exitKey) ?? "null"));
    if (parsed.success && matchesSoloExit(parsed.data, room)) return parsed.data;
    storage.removeItem(exitKey);
  } catch { /* A new page never infers an exit from the room's active flag. */ }
  return null;
}
