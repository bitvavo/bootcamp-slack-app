import { assert, assertEquals } from "@std/testing/asserts";
import { Application } from "./Application.ts";
import { Logger } from "./Logger.ts";
import { SessionPresenter } from "./SessionPresenter.ts";
import { SessionRepository } from "./SessionRepository.ts";
import { ScheduleRepository } from "./ScheduleRepository.ts";
import { HelpPrinter } from "./HelpPrinter.ts";
import { LeaderboardPresenter } from "./LeaderboardPresenter.ts";
import { Session } from "../domain/Session.ts";
import { LocalDate } from "../domain/LocalDate.ts";
import { Leaderboard } from "../domain/Leaderboard.ts";

class InMemorySessionRepository implements SessionRepository {
  sessions = new Map<string, Session>();
  async loadSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }
  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }
  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

type Schedule = { user: string; weekdays: number[] };

class InMemoryScheduleRepository implements ScheduleRepository {
  schedules = new Map<string, Schedule>();
  async loadAllSchedules(): Promise<Schedule[]> {
    return [...this.schedules.values()];
  }
  async loadScheduleByUser(user: string): Promise<Schedule | undefined> {
    return this.schedules.get(user);
  }
  async saveSchedule(schedule: Schedule): Promise<void> {
    this.schedules.set(schedule.user, schedule);
  }
  async deleteSchedule(user: string): Promise<void> {
    this.schedules.delete(user);
  }
}

class DummyHelpPrinter implements HelpPrinter {
  messages: { user: string; channel: string; text: string }[] = [];
  async printHelp(user: string, channel: string): Promise<void> {
    this.messages.push({ user, channel, text: "help" });
  }
  async printInfo(
    user: string,
    channel: string,
    message: string,
  ): Promise<void> {
    this.messages.push({ user, channel, text: message });
  }
}

class CapturingSessionPresenter implements SessionPresenter {
  presented: Session[] = [];
  async presentSession(session: Session): Promise<void> {
    this.presented.push(session);
  }
  async representSession(session: Session): Promise<void> {
    this.presented.push(session);
  }
}

class CapturingLeaderboardPresenter implements LeaderboardPresenter {
  posted: Leaderboard[] = [];
  async presentLeaderboard(leaderboard: Leaderboard): Promise<void> {
    this.posted.push(leaderboard);
  }
  async presentLeaderboardForUser(): Promise<void> {}
}

function buildAppForDate(dateIso: string) {
  const realDate = Date;
  const fixed = new realDate(dateIso);
  // Monkey-patch Date.now and default constructor so LocalDate.today() uses our date
  // Note: keep tz in the ISO string to emulate Amsterdam when relevant
  // @ts-ignore
  class FakeDate extends realDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixed);
      } else {
        // @ts-ignore
        super(...args);
      }
    }
    static override now() {
      return fixed.getTime();
    }
  }
  // @ts-ignore
  globalThis.Date = FakeDate as any;

  const sessionRepo = new InMemorySessionRepository();
  const scheduleRepo = new InMemoryScheduleRepository();
  const sessionPresenter = new CapturingSessionPresenter();
  const leaderboardPresenter = new CapturingLeaderboardPresenter();
  const helpPrinter = new DummyHelpPrinter();
  const app = new Application({
    logger: new Logger("Test"),
    sessionPresenter,
    sessionRepository: sessionRepo,
    scheduleRepository: scheduleRepo,
    helpPrinter,
    leaderboardPresenter,
    sessionLimit: undefined,
  });
  return {
    app,
    sessionRepo,
    scheduleRepo,
    sessionPresenter,
    leaderboardPresenter,
    helpPrinter,
    restore: () => {
      globalThis.Date = realDate as any;
    },
  };
}

Deno.test("creates and posts today evening only (Wednesday)", async () => {
  const { app, sessionPresenter, restore } = buildAppForDate(
    "2025-06-04T09:00:00+02:00",
  ); // Wednesday
  try {
    await app.start();
    sessionPresenter.presented.length = 0; // clear initial call from start
    await app.createAndPresentSessionsForMorningJob();

    const sessions = app.sessions();
    // Expect exactly one session today at 17:00
    assertEquals(sessions.length >= 1, true);
    const today = LocalDate.today();
    const todaySessions = sessions.filter((s) => s.date.equals(today));
    assertEquals(todaySessions.length, 1);
    const s = todaySessions[0];
    assertEquals({ hour: s.hour, minute: s.minute }, { hour: 17, minute: 0 });

    // Presented exactly that session
    assertEquals(sessionPresenter.presented.length >= 1, true);
    const presentedToday = sessionPresenter.presented.filter((p) =>
      p.date.equals(today)
    );
    assertEquals(presentedToday.length, 1);
  } finally {
    restore();
  }
});

Deno.test("creates and posts today evening and tomorrow morning (Monday)", async () => {
  const { app, sessionPresenter, restore } = buildAppForDate(
    "2025-06-02T09:00:00+02:00",
  ); // Monday
  try {
    await app.createAndPresentSessionsForMorningJob();
    const sessions = app.sessions();
    const today = LocalDate.today();
    const tomorrow = today.tomorrow();
    const todaySessions = sessions.filter((s) => s.date.equals(today));
    assertEquals(todaySessions.length, 1);
    assertEquals({
      hour: todaySessions[0].hour,
      minute: todaySessions[0].minute,
    }, { hour: 17, minute: 0 });

    const tomorrowSessions = sessions.filter((s) => s.date.equals(tomorrow));
    assertEquals(tomorrowSessions.length, 1);
    assertEquals({
      hour: tomorrowSessions[0].hour,
      minute: tomorrowSessions[0].minute,
    }, { hour: 7, minute: 0 });

    // Both presented
    const presentedToday = sessionPresenter.presented.filter((p) =>
      p.date.equals(today)
    );
    const presentedTomorrow = sessionPresenter.presented.filter((p) =>
      p.date.equals(tomorrow)
    );
    assertEquals(presentedToday.length >= 1, true);
    assertEquals(presentedTomorrow.length >= 1, true);
  } finally {
    restore();
  }
});

Deno.test("leaderboard aggregates morning and evening sessions", async () => {
  const { app, sessionRepo, restore } = buildAppForDate(
    "2025-06-02T09:00:00+02:00",
  ); // Monday
  try {
    await app.createAndPresentSessionsForMorningJob();
    // Add attendees across both sessions (Mon 17:00 and Tue 07:00)
    const sessions = app.sessions();
    const [monEvening, tueMorning] = sessions.sort((a, b) =>
      a.date.toString().localeCompare(b.date.toString()) || a.hour - b.hour
    );
    monEvening.participants.push("U1", "U2");
    tueMorning.participants.push("U1");
    await sessionRepo.saveSession(monEvening);
    await sessionRepo.saveSession(tueMorning);

    const lb = app.leaderboard(monEvening.date.year, monEvening.date.month);
    const u1 = lb.levels.find((l) => l.participant === "U1");
    const u2 = lb.levels.find((l) => l.participant === "U2");
    assertEquals(u1?.attendances, 2);
    assertEquals(u2?.attendances, 1);
  } finally {
    restore();
  }
});

Deno.test("users can join/quit morning and evening separately", async () => {
  const { app, sessionPresenter, restore } = buildAppForDate(
    "2025-06-02T09:00:00+02:00",
  ); // Monday
  try {
    await app.createAndPresentSessionsForMorningJob();
    const sessions = app.sessions();
    const [monEvening, tueMorning] = sessions.sort((a, b) =>
      a.date.toString().localeCompare(b.date.toString()) || a.hour - b.hour
    );
    const user = { id: "U1" } as any;

    // Join evening
    await app.joinSession({
      sessionId: monEvening.sessionId,
      user,
      channel: "C",
    });
    assert(monEvening.participants.includes("U1"));

    // Join morning (distinct session)
    await app.joinSession({
      sessionId: tueMorning.sessionId,
      user,
      channel: "C",
    });
    assert(tueMorning.participants.includes("U1"));

    // Quit evening only
    await app.quitSession({
      sessionId: monEvening.sessionId,
      user,
      channel: "C",
    });
    assert(!monEvening.participants.includes("U1"));
    assert(tueMorning.participants.includes("U1"));

    // Presenter updated at least twice for the two sessions
    assertEquals(sessionPresenter.presented.length >= 2, true);
  } finally {
    restore();
  }
});

Deno.test("created sessions have correct date & time fields", async () => {
  const { app, restore } = buildAppForDate("2025-06-02T09:00:00+02:00"); // Monday
  try {
    await app.createAndPresentSessionsForMorningJob();
    const sessions = app.sessions();
    const today = LocalDate.today();
    const tomorrow = today.tomorrow();

    const monEvening = sessions.find((s) => s.date.equals(today));
    const tueMorning = sessions.find((s) => s.date.equals(tomorrow));
    assertEquals(monEvening?.hour, 17);
    assertEquals(monEvening?.minute, 0);

    assertEquals(tueMorning?.hour, 7);
    assertEquals(tueMorning?.minute, 0);
  } finally {
    restore();
  }
});
