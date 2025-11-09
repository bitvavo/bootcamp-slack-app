import { EventEmitter } from "@denosaurs/event";
import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { load } from "@std/dotenv";
import { CronJob } from "cron";
// @deno-types="npm:@types/express@^4.17.21"
import express from "express";
import { LevelModule } from "./adapters/level/LevelModule.ts";
import { Logger } from "./application/Logger.ts";
import { SlackActions } from "./adapters/SlackActions.ts";
import { SlackSessionPresenter } from "./adapters/SlackSessionPresenter.ts";
import { Application } from "./application/Application.ts";
import { Countdown } from "./domain/Countdown.ts";
import { User } from "./domain/User.ts";
import { SlackHelpPrinter } from "./adapters/SlackHelpPrinter.ts";
import { SlackLeaderboardPresenter } from "./adapters/SlackLeaderboardPresenter.ts";
import { SessionPresenter } from "./application/SessionPresenter.ts";
import { HelpPrinter } from "./application/HelpPrinter.ts";
import { LeaderboardPresenter } from "./application/LeaderboardPresenter.ts";
import { parseOptionalInt } from "./utils.ts";

const expressLogger = new Logger("Express");

await load({ export: true });

const HTTP_ONLY = (Deno.env.get("HTTP_ONLY") ?? "").toLowerCase() === "1" ||
  (Deno.env.get("HTTP_ONLY") ?? "").toLowerCase() === "true";
const ENABLE_SCHEDULES =
  (Deno.env.get("ENABLE_SCHEDULES") ?? "").toLowerCase() === "1" ||
  (Deno.env.get("ENABLE_SCHEDULES") ?? "").toLowerCase() === "true";

const appToken = Deno.env.get("SLACK_APP_TOKEN");
const botToken = Deno.env.get("SLACK_BOT_TOKEN");
const channel = Deno.env.get("SLACK_CHANNEL");
const sessionLimit = parseOptionalInt(Deno.env.get("SESSION_LIMIT"));
const dbLocation = Deno.env.get("DB_LOCATION") ?? "data";

if (!HTTP_ONLY && !channel) {
  throw new Error("Please provide SLACK_CHANNEL");
}

let inactivityCountdown: Countdown | undefined;
if (!HTTP_ONLY) {
  const ONE_HOUR = 60 * 60 * 1000;
  inactivityCountdown = new Countdown(ONE_HOUR);
  inactivityCountdown.on("countdown", () => {
    logger.error("No message received in the last hour. Shutting down.");
    Deno.exit(1);
  });
  inactivityCountdown.start();
}

const level = new LevelModule(dbLocation);

const socketModeLogger = new Logger("SocketModeClient", LogLevel.DEBUG);
const socketModeClient = !HTTP_ONLY
  ? new SocketModeClient({
    appToken,
    logger: socketModeLogger,
  })
  : undefined;
const webClient = !HTTP_ONLY
  ? new WebClient(botToken)
  : undefined as unknown as WebClient;

class NoopSessionPresenter implements SessionPresenter {
  async presentSession(): Promise<void> {}
  async representSession(): Promise<void> {}
}
class NoopHelpPrinter implements HelpPrinter {
  async printHelp(): Promise<void> {}
  async printInfo(): Promise<void> {}
}
class NoopLeaderboardPresenter implements LeaderboardPresenter {
  async presentLeaderboard(): Promise<void> {}
  async presentLeaderboardForUser(): Promise<void> {}
}

const application = new Application({
  logger: new Logger("Application"),
  sessionPresenter: HTTP_ONLY
    ? new NoopSessionPresenter()
    : new SlackSessionPresenter(webClient, channel!),
  sessionRepository: level.sessionRepository,
  scheduleRepository: level.scheduleRepository,
  helpPrinter: HTTP_ONLY
    ? new NoopHelpPrinter()
    : new SlackHelpPrinter(webClient, new Logger("SlackHelpPrinter")),
  leaderboardPresenter: HTTP_ONLY
    ? new NoopLeaderboardPresenter()
    : new SlackLeaderboardPresenter(webClient, channel!),
  sessionLimit,
});

interface Action {
  value: string;
}

const actionEmitter = !HTTP_ONLY
  ? new EventEmitter<{ [action: string]: [Action, any] }>()
  : undefined as unknown as EventEmitter<{ [action: string]: [Action, any] }>;

const cronJobLogger = new Logger("CronJob");
CronJob.from({
  cronTime: "0 * * * *",
  start: true,
  runOnInit: false,
  onTick: async () => {
    cronJobLogger.debug("Running cron job");
    await application.onTick();
  },
});

if (!HTTP_ONLY) {
  actionEmitter.on(SlackActions.QUIT, async (action, body) => {
    await application.quitSession({
      sessionId: action.value,
      user: body.user,
      channel: body.channel.id,
    });
  });

  actionEmitter.on(SlackActions.JOIN, async (action, body) => {
    await application.joinSession({
      sessionId: action.value,
      user: body.user,
      channel: body.channel.id,
    });
  });
}

if (!HTTP_ONLY) {
  socketModeClient!.on("interactive", async ({ body, ack }) => {
    await ack();
    inactivityCountdown!.reset();
    if (body.type === "block_actions") {
      for (const action of body.actions) {
        actionEmitter.emit(action.action_id, action, body);
      }
    }
  });
}

if (!HTTP_ONLY) {
  socketModeClient!.on("slash_commands", async ({ body, ack }) => {
    if (body.command === "/bootcamp") {
      await ack();
      inactivityCountdown!.reset();
      const text: string = body.text;
      const args = text.split(/\s+/g).map((arg) => arg.toLowerCase());
      const user = { id: body.user_id } satisfies User;
      const channel = body.channel_id as string;
      switch (args[0]) {
        case "help": {
          await application.printHelp({ user, channel });
          break;
        }
        case "join": {
          if (args[1] === "every") {
            if (ENABLE_SCHEDULES) {
              await application.joinSchedule({
                weekday: args[2],
                user,
                channel,
              });
            } else {
              await webClient.chat.postEphemeral({
                user: body.user_id,
                channel,
                text: "this command is disabled!",
              });
            }
            break;
          }
          await application.joinSession({ dateString: args[1], user, channel });
          break;
        }
        case "quit": {
          if (args[1] === "every") {
            await application.quitSchedule({ weekday: args[2], user, channel });
            break;
          }
          await application.quitSession({ dateString: args[1], user, channel });
          break;
        }
        case "leaderboard": {
          await application.printLeaderboard({ user, channel });
          break;
        }
        default: {
          const text = "I didn't catch that. " +
            "Try `/bootcamp join` to join the next session or `/bootcamp quit` to remove yourself from the next session.";
          await webClient.chat.postEphemeral({
            user: body.user_id,
            channel,
            text,
          });
          break;
        }
      }
    }
  });
}

if (!HTTP_ONLY) {
  socketModeClient!.on("error", (error: Error) => {
    socketModeLogger.error("Error occurred, shutting down:", error);
    Deno.exit(1);
  });

  socketModeClient!.on("disconnecting", () => {
    socketModeLogger.warn("Disconnecting");
  });

  socketModeClient!.on("reconnecting", () => {
    socketModeLogger.info("Reconnecting");
  });

  socketModeClient!.on("disconnected", (error: Error | undefined) => {
    if (error) {
      socketModeLogger.error("Disconnected with error:", error);
    } else {
      socketModeLogger.warn("Disconnected");
    }
  });

  socketModeClient!.on("disconnect", (event) => {
    expressLogger.error("Received event disconnect.");
    Deno.exit(1);
    if (event && event.reason === "too_many_websockets") {
      expressLogger.error(
        "Received too_many_websockets disconnect. Exiting app.",
      );
      Deno.exit(1);
    }
  });
}

if (!HTTP_ONLY) {
  await socketModeClient!.start();
}

// Purge existing schedules only when schedules are disabled
if (!ENABLE_SCHEDULES) {
  const schedules = await level.scheduleRepository.loadAllSchedules();
  if (schedules.length > 0) {
    for (const s of schedules) {
      await level.scheduleRepository.deleteSchedule(s.user);
    }
    expressLogger.info(`Purged ${schedules.length} existing schedules`);
  }
}

await application.start();

const logger = new Logger("Express");
const app = express();

app.use(express.json());

app.get("/sessions", (_req, res) => {
  res.send(application.sessions());
});

app.get("/sessions/:id", (req, res) => {
  res.send(application.getSession(req.params.id));
});

app.put("/sessions/:id", (req, res) => {
  application.putSession(req.params.id, req.body).then((session) => {
    res.send(session);
  });
});

app.delete("/sessions/:id", (req, res) => {
  application.deleteSession(req.params.id).then(() => {
    res.status(204).send();
  });
});

app.get("/schedules", (_req, res) => {
  application.schedules().then((schedules) => {
    res.send(schedules);
  });
});

app.get("/leaderboard/:year/:month", (req, res) => {
  const leaderboard = application.leaderboard(
    +req.params.year,
    +req.params.month,
  );
  res.send(leaderboard);
});

app.listen(8080, () => {
  logger.info("Server running on http://localhost:8080");
});
