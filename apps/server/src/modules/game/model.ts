import type { Guest } from "@festival/shared";

export type Room = {
  id: string;
  code: string;
  hostId: string;
  scenarioId: string;
  memberIds: string[];
  sessionId: string | null;
  mode?: "solo" | "multiplayer";
  soloStarted?: boolean;
  soloPlayId?: string | null;
};

export type Session = {
  id: string;
  roomId: string;
  scenarioId: string;
  scenarioVersion: number;
  participants: { id: string; nickname: string; roleIndex: number }[];
  phase: "briefing" | "discussion" | "voting" | "reveal";
  votes: Record<string, string>;
  endedAt: string | null;
};

export type State = {
  guests: Record<string, Guest>;
  rooms: Record<string, Room>;
  sessions: Record<string, Session>;
};
