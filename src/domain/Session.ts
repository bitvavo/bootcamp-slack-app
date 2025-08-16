import { LocalDate } from "./LocalDate.ts";

export interface Session {
  sessionId: string;
  date: LocalDate;
  participants: string[];
  ts?: string;
  limit?: number;
  time?: string;
}
