import { assertEquals } from "@std/testing/asserts";
import { Application } from "./Application.ts";
import { Logger } from "./Logger.ts";
import { SessionRepository } from "./SessionRepository.ts";
import { ScheduleRepository } from "./ScheduleRepository.ts";
import { HelpPrinter } from "./HelpPrinter.ts";
import { SlackSessionPresenter } from "../adapters/SlackSessionPresenter.ts";
import { LocalDate } from "../domain/LocalDate.ts";
import { WebClient } from "@slack/web-api";
import { LeaderboardPresenter } from "./LeaderboardPresenter.ts";

class InMemorySessionRepository implements SessionRepository {
  sessions: any[] = [];
  async loadSessions() { return this.sessions; }
  async saveSession(session: any) { const idx = this.sessions.findIndex((s) => s.sessionId === session.sessionId); if (idx >= 0) this.sessions[idx] = session; else this.sessions.push(session); }
  async deleteSession(sessionId: string) { this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId); }
}

class InMemoryScheduleRepository implements ScheduleRepository {
  schedules: any[] = [];
  async loadAllSchedules() { return this.schedules; }
  async loadScheduleByUser(user: string) { return this.schedules.find((s) => s.user === user); }
  async saveSchedule(schedule: any) { const idx = this.schedules.findIndex((s) => s.user === schedule.user); if (idx >= 0) this.schedules[idx] = schedule; else this.schedules.push(schedule); }
  async deleteSchedule(user: string) { this.schedules = this.schedules.filter((s) => s.user !== user); }
}

class DummyHelpPrinter implements HelpPrinter {
  async printHelp(): Promise<void> {}
  async printInfo(): Promise<void> {}
}

class CapturingLeaderboardPresenter implements LeaderboardPresenter {
  async presentLeaderboard(): Promise<void> {}
  async presentLeaderboardForUser(): Promise<void> {}
}

function withFixedDate<T>(iso: string, fn: () => Promise<T> | T): Promise<T> | T {
  const RealDate = Date;
  const fixed = new RealDate(iso);
  class FakeDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixed);
      } else {
        // @ts-ignore
        super(...args);
      }
    }
    static override now() { return fixed.getTime(); }
  }
  // @ts-ignore
  globalThis.Date = FakeDate as any;
  try { return fn(); } finally { /* @ts-ignore */ globalThis.Date = RealDate as any; }
}

function buildFakeWebClient() {
  const calls: any[] = [];
  const webClient = { chat: { postMessage: async (args: any) => { calls.push(args); return { ts: "1" }; }, update: async (_args: any) => {} } } as unknown as WebClient;
  return { webClient, calls };
}

Deno.test("Monday morning: presents today 17:00 and tomorrow 07:00 intros", async () => {
  await withFixedDate("2025-06-02T08:00:00Z", async () => {
    const { webClient, calls } = buildFakeWebClient();
    const sessionRepo = new InMemorySessionRepository();
    const scheduleRepo = new InMemoryScheduleRepository();
    const today = LocalDate.today();
    const presenter = new SlackSessionPresenter(webClient, "C", () => today);
    const app = new Application({
      logger: new Logger("Test"),
      sessionPresenter: presenter,
      sessionRepository: sessionRepo,
      scheduleRepository: scheduleRepo,
      helpPrinter: new DummyHelpPrinter(),
      leaderboardPresenter: new CapturingLeaderboardPresenter(),
    });
    await app.createAndPresentSessionsForMorningJob();

    assertEquals(calls.length, 2);
    const intros = calls.map((c) => c.blocks[0].text.text as string);
    intros.sort();
    assertEquals(intros.includes("*Ready to sweat today at 17:00?* :hot_face:"), true);
    assertEquals(intros.includes("*Ready to sweat tomorrow at 07:00?* :hot_face:"), true);
  });
});

Deno.test("Tuesday morning: presents only today 17:00 intro", async () => {
  await withFixedDate("2025-06-03T08:00:00Z", async () => {
    const { webClient, calls } = buildFakeWebClient();
    const sessionRepo = new InMemorySessionRepository();
    const scheduleRepo = new InMemoryScheduleRepository();
    const today = LocalDate.today();
    const presenter = new SlackSessionPresenter(webClient, "C", () => today);
    const app = new Application({
      logger: new Logger("Test"),
      sessionPresenter: presenter,
      sessionRepository: sessionRepo,
      scheduleRepository: scheduleRepo,
      helpPrinter: new DummyHelpPrinter(),
      leaderboardPresenter: new CapturingLeaderboardPresenter(),
    });
    await app.createAndPresentSessionsForMorningJob();

    assertEquals(calls.length, 1);
    const intro = calls[0].blocks[0].text.text as string;
    assertEquals(intro, "*Ready to sweat today at 17:00?* :hot_face:");
  });
});


