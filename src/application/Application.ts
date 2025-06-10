import { LocalDate } from "../domain/LocalDate.ts";
import { Session } from "../domain/Session.ts";
import { User } from "../domain/User.ts";
import {
  capitalize,
  getHourInAmsterdam,
  isBootcampDay,
  isOneDayAfterLastSessionOfTheMonth,
  list,
} from "../utils.ts";
import { Logger } from "./Logger.ts";
import { SessionPresenter } from "./SessionPresenter.ts";
import { SessionRepository } from "./SessionRepository.ts";
import { ScheduleRepository } from "./ScheduleRepository.ts";
import { HelpPrinter } from "./HelpPrinter.ts";
import { Schedule } from "../domain/Schedule.ts";
import { Leaderboard } from "../domain/Leaderboard.ts";
import { LeaderboardPresenter } from "./LeaderboardPresenter.ts";

const WEEKDAYS = new Map([
  ["monday", 1],
  ["tuesday", 2],
  ["wednesday", 3],
  ["thursday", 4],
]);

export class Application {
  readonly #logger: Logger;
  readonly #sessionPresenter: SessionPresenter;
  readonly #sessionRepository: SessionRepository;
  readonly #scheduleRepository: ScheduleRepository;
  readonly #helpPrinter: HelpPrinter;
  readonly #leaderboardPresenter: LeaderboardPresenter;
  readonly #sessions: Map<string, Session> = new Map();
  readonly #sessionLimit?: number;

  constructor({
    logger,
    sessionPresenter,
    sessionRepository,
    scheduleRepository,
    helpPrinter,
    leaderboardPresenter,
    sessionLimit,
  }: {
    logger: Logger;
    sessionPresenter: SessionPresenter;
    sessionRepository: SessionRepository;
    scheduleRepository: ScheduleRepository;
    helpPrinter: HelpPrinter;
    leaderboardPresenter: LeaderboardPresenter;
    sessionLimit?: number;
  }) {
    this.#logger = logger;
    this.#sessionPresenter = sessionPresenter;
    this.#sessionRepository = sessionRepository;
    this.#scheduleRepository = scheduleRepository;
    this.#helpPrinter = helpPrinter;
    this.#leaderboardPresenter = leaderboardPresenter;
    this.#sessionLimit = sessionLimit;
  }

  async start(): Promise<void> {
    this.#logger.debug("Application starting");

    const existingSessions = await this.#sessionRepository.loadSessions();
    for (const session of existingSessions) {
      this.#sessions.set(session.sessionId, session);
    }
    this.#logger.info(
      `Loaded ${existingSessions.length} sessions from repository`,
    );
    await this.onTick();

    this.#logger.info("Application started");
  }

  sessions(): Session[] {
    return [...this.#sessions.values()];
  }

  async schedules(): Promise<Schedule[]> {
    return await this.#scheduleRepository.loadAllSchedules();
  }

  leaderboard(year: number, month: number): Leaderboard {
    const date = new LocalDate(year, month, 1);
    return this.calculateLeaderboard(date);
  }

  async onTick(): Promise<void> {
    const { hour, minute } = getHourInAmsterdam(new Date());
    if (hour !== 9 && minute < 15) return;

    this.#logger.info(`Running morning job on ${LocalDate.today()} at 9:00 AM`);
    await this.createSessions();
    await this.presentSessionOfToday();
    await this.presentLeaderboard();
  }

  async createSessions(): Promise<void> {
    const nextDates = this.calculateNextDates();
    await this.createSessionsForDatesIfNotExist(nextDates);
  }

  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  async putSession(sessionId: string, session: Session): Promise<Session> {
    if (session.sessionId !== sessionId) {
      throw new Error(
        `Session ID mismatch: ${session.sessionId} !== ${sessionId}`,
      );
    }
    this.#sessions.set(sessionId, session);
    await this.#sessionRepository.saveSession(session);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.#sessions.delete(sessionId)) {
      await this.#sessionRepository.deleteSession(sessionId);
      this.#logger.info(`Deleted session ${sessionId}`);
    }
  }

  private calculateNextDates(): LocalDate[] {
    const date1 = this.calculateNextDateFrom(LocalDate.today());
    const date2 = this.calculateNextDateFrom(date1.tomorrow());
    const date3 = this.calculateNextDateFrom(date2.tomorrow());

    return [date1, date2, date3];
  }

  private calculateNextDateFrom(date: LocalDate): LocalDate {
    let nextDate = date;
    while (!isBootcampDay(nextDate)) {
      nextDate = nextDate.tomorrow();
    }

    return nextDate;
  }

  private async createSessionsForDatesIfNotExist(
    dates: LocalDate[],
  ): Promise<void> {
    for (const date of dates) {
      const session = this.findSessionForDate(date);
      if (session === undefined) {
        await this.createSessionForDate(date);
      }
    }
  }

  private findSessionForDate(date: LocalDate): Session | undefined {
    for (const session of this.#sessions.values()) {
      if (session.date.equals(date)) {
        return session;
      }
    }

    return undefined;
  }

  private async createSessionForDate(date: LocalDate): Promise<void> {
    const sessionId = crypto.randomUUID();
    const participants = await this.findScheduledParticipantsFor(date);
    const limit = this.#sessionLimit;
    const session = { sessionId, date, participants, limit } satisfies Session;

    this.#sessions.set(session.sessionId, session);
    await this.#sessionRepository.saveSession(session);
    this.#logger.debug(`Created session ${session}`);
  }

  private async findScheduledParticipantsFor(
    date: LocalDate,
  ): Promise<string[]> {
    const participants = [];
    for (const schedule of await this.#scheduleRepository.loadAllSchedules()) {
      if (schedule.weekdays.includes(date.weekday)) {
        participants.push(schedule.user);
      }
    }

    return participants;
  }

  async presentSessionOfToday(): Promise<void> {
    const today = LocalDate.today();
    const session = this.findSessionForDate(today);
    if (session) {
      await this.#sessionPresenter.presentSession(session);
      await this.#sessionRepository.saveSession(session);
    } else {
      this.#logger.warn("No session for today");
    }
  }

  async presentLeaderboard(): Promise<void> {
    const today = LocalDate.today();
    if (isOneDayAfterLastSessionOfTheMonth(today)) {
      const leaderboard = this.calculateLeaderboard(today.yesterday());
      await this.#leaderboardPresenter.presentLeaderboard(leaderboard);
    }
  }

  private calculateLeaderboard(forDay: LocalDate): Leaderboard {
    const lastMonth = forDay.absoluteMonth;
    const leaderboard = new Leaderboard(forDay.month, forDay.year);
    const allSessionsThatMonth = this.sessions().filter((session) =>
      session.date.absoluteMonth === lastMonth
    );
    for (const session of allSessionsThatMonth) {
      for (const participant of session.participants) {
        leaderboard.addAttendee(participant);
      }
    }
    return leaderboard;
  }

  async joinSession(
    { dateString, sessionId, user, channel }: {
      dateString?: string;
      sessionId?: string;
      user: User;
      channel: string;
    },
  ) {
    let session: Session;
    try {
      session = this.findSession({ dateString, sessionId });
    } catch (error) {
      this.#logger.warn(error.message);
      await this.#helpPrinter.printInfo(user.id, channel, error.message);
      return;
    }

    const index = session.participants.indexOf(user.id);
    if (index >= 0) {
      this.#logger.warn("User already part of session:", user);
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You already joined the bootcamp on ${session.date.toHuman()}.`,
      );
      return;
    }

    if (session.limit && session.participants.length >= session.limit) {
      this.#logger.warn(
        "Session is full",
        session.sessionId,
        session.limit,
        user.id,
      );
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `The bootcamp on ${session.date.toHuman()} is already full.`,
      );
      return;
    }

    session.participants.push(user.id);
    await this.#sessionPresenter.representSession(session);
    await this.#sessionRepository.saveSession(session);
    await this.#helpPrinter.printInfo(
      user.id,
      channel,
      `You are joining the bootcamp on ${session.date.toHuman()}.`,
    );
  }

  async quitSession(
    { dateString, sessionId, user, channel }: {
      dateString?: string;
      sessionId?: string;
      user: User;
      channel: string;
    },
  ) {
    let session: Session;
    try {
      session = this.findSession({ dateString, sessionId });
    } catch (error) {
      this.#logger.warn(error.message);
      await this.#helpPrinter.printInfo(user.id, channel, error.message);
      return;
    }

    const index = session.participants.indexOf(user.id);
    if (index >= 0) {
      session.participants.splice(index, 1);
      await this.#sessionPresenter.representSession(session);
      await this.#sessionRepository.saveSession(session);
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You are not joining the bootcamp on ${session.date.toHuman()} anymore.`,
      );
    } else {
      this.#logger.warn("User is not part of session:", user);
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You have not joined the bootcamp on ${session.date.toHuman()}.`,
      );
    }
  }

  async printLeaderboard({ user, channel }: { user: User; channel: string }) {
    const leaderboard = this.calculateLeaderboard(LocalDate.today());
    await this.#leaderboardPresenter.presentLeaderboardForUser(
      leaderboard,
      user.id,
      channel,
    );
  }

  private findSession(
    { dateString, sessionId }: { dateString?: string; sessionId?: string },
  ): Session {
    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) {
        throw new Error("No session with ID " + sessionId);
      }

      return session;
    }

    if (
      dateString === "today" || dateString === "next" || dateString === "now" ||
      dateString === undefined
    ) {
      return this.findNextSession();
    }

    if (dateString === "tomorrow") {
      const tomorrow = LocalDate.today().tomorrow();
      const session = this.findSessionForDate(tomorrow);
      if (!session) {
        throw new Error("No session for tomorrow");
      }
      return session;
    }

    const weekdays = [
      ["monday", LocalDate.MONDAY],
      ["tuesday", LocalDate.TUESDAY],
      ["wednesday", LocalDate.WEDNESDAY],
      ["thursday", LocalDate.THURSDAY],
      ["friday", LocalDate.FRIDAY],
      ["saturday", LocalDate.SATURDAY],
      ["sunday", LocalDate.SUNDAY],
    ] as const;

    for (const [weekday, day] of weekdays) {
      if (dateString === weekday) {
        const nextWeekday = LocalDate.today().nextWeekday(day);
        const session = this.findSessionForDate(nextWeekday);
        if (!session) {
          throw new Error(`No session on ${weekday}`);
        }
        return session;
      }
    }

    throw new Error("Invalid date: " + dateString);
  }

  private findNextSession(): Session {
    const today = LocalDate.today();
    let result: Session | undefined;
    for (const session of this.#sessions.values()) {
      if (
        !session.date.isBefore(today) &&
        (!result || session.date.isBefore(result.date))
      ) {
        result = session;
      }
    }

    if (!result) {
      throw new Error("No next session found");
    }

    return result;
  }

  async joinSchedule(
    { user, weekday, channel }: {
      user: User;
      channel: string;
      weekday: string;
    },
  ): Promise<void> {
    const weekdayNum = await this.resolveWeekday(weekday, channel, user);
    if (weekdayNum === undefined) return;

    let schedule = await this.#scheduleRepository.loadScheduleByUser(user.id);
    if (!schedule) {
      schedule = { user: user.id, weekdays: [weekdayNum] };
    } else if (!schedule.weekdays.includes(weekdayNum)) {
      schedule.weekdays.push(weekdayNum);
      schedule.weekdays.sort((a, b) => a - b);
    }

    await this.updateSchedule(schedule, user, channel);
  }

  async quitSchedule(
    { user, weekday, channel }: {
      user: User;
      channel: string;
      weekday: string;
    },
  ): Promise<void> {
    const weekdayNum = await this.resolveWeekday(weekday, channel, user);
    if (weekdayNum === undefined) return;

    const schedule = await this.#scheduleRepository.loadScheduleByUser(user.id);
    if (!schedule) {
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You are not part of any schedule.`,
      );
      return;
    }

    const index = schedule.weekdays.indexOf(weekdayNum);
    if (index < 0) {
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You are not part of a schedule for ${weekday}.`,
      );
      return;
    }

    schedule.weekdays.splice(index, 1);
    if (schedule.weekdays.length === 0) {
      await this.#scheduleRepository.deleteSchedule(schedule.user);
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `You are not on any schedule to join the bootcamp anymore.`,
      );
    } else {
      await this.updateSchedule(schedule, user, channel);
    }
  }

  private async resolveWeekday(
    weekday: string,
    channel: string,
    user: User,
  ): Promise<number | undefined> {
    if (!WEEKDAYS.has(weekday)) {
      await this.#helpPrinter.printInfo(
        user.id,
        channel,
        `Invalid weekday provided: ${weekday}`,
      );
      return undefined;
    }

    return WEEKDAYS.get(weekday)!;
  }

  private async updateSchedule(
    schedule: Schedule,
    user: User,
    channel: string,
  ) {
    console.dir(schedule);
    await this.#scheduleRepository.saveSchedule(schedule);

    const weekdays = list(
      schedule.weekdays.map((wd) => this.nameWeekday(wd)).map(capitalize),
    );
    const message = `You are joining the bootcamp every ${weekdays}.`;
    await this.#helpPrinter.printInfo(user.id, channel, message);
  }

  private nameWeekday(weekday: number): string {
    for (const [str, num] of WEEKDAYS) {
      if (weekday === num) {
        return str;
      }
    }
    return "";
  }

  async printHelp(args: { user: User; channel: string }): Promise<void> {
    await this.#helpPrinter.printHelp(args.user.id, args.channel);
  }
}
