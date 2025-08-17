import { LocalDate } from "./LocalDate.ts";

export interface Session {
  sessionId: string;
  date: LocalDate;
  // Time of day for the session in 24h local time (Europe/Amsterdam)
  hour: number;
  minute: number;
  participants: string[];
  ts?: string;
  limit?: number;
}
