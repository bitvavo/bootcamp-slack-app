import { LocalDate } from "../domain/LocalDate.ts";

export type BootcampSessionTemplate = {
  weekday: number; // LocalDate.MONDAY..SUNDAY
  hour: number; // 24h
  minute: number; // 0-59
};

// Single source of truth for when bootcamp sessions happen.
// Never mutate or rewrite this list elsewhere.
export const BOOTCAMP_SCHEDULES: readonly BootcampSessionTemplate[] = [
  // Evening sessions: Mon, Tue, Wed, Thu at 17:00
  { weekday: LocalDate.MONDAY, hour: 17, minute: 0 },
  { weekday: LocalDate.TUESDAY, hour: 17, minute: 0 },
  { weekday: LocalDate.WEDNESDAY, hour: 17, minute: 0 },
  { weekday: LocalDate.THURSDAY, hour: 17, minute: 0 },
  // Morning session: Tuesday at 07:00
  { weekday: LocalDate.TUESDAY, hour: 7, minute: 0 },
] as const;

export function formatTime24h(hour: number, minute: number): string {
  const hh = hour.toString().padStart(2, "0");
  const mm = minute.toString().padStart(2, "0");
  return `${hh}:${mm}`;
}


