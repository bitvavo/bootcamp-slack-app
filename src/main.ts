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
import { parseOptionalInt } from "./utils.ts";

await load({ export: true });

const appToken = Deno.env.get("SLACK_APP_TOKEN");
const botToken = Deno.env.get("SLACK_BOT_TOKEN");
const channel = Deno.env.get("SLACK_CHANNEL");
const sessionLimit = parseOptionalInt(Deno.env.get("SESSION_LIMIT"));
const dbLocation = Deno.env.get("DB_LOCATION") ?? "data";

if (!channel) {
  throw new Error("Please provide SLACK_CHANNEL");
}

const ONE_HOUR = 60 * 60 * 1000;
const inactivityCountdown = new Countdown(ONE_HOUR);
inactivityCountdown.on("countdown", () => {
  logger.error("No message received in the last hour. Shutting down.");
  Deno.exit(1);
});

inactivityCountdown.start();

const level = new LevelModule(dbLocation);

const socketModeLogger = new Logger("SocketModeClient", LogLevel.DEBUG);
const socketModeClient = new SocketModeClient({
  appToken,
  logger: socketModeLogger,
});
const webClient = new WebClient(botToken);

const application = new Application({
  logger: new Logger("Application"),
  sessionPresenter: new SlackSessionPresenter(webClient, channel),
  sessionRepository: level.sessionRepository,
  scheduleRepository: level.scheduleRepository,
  helpPrinter: new SlackHelpPrinter(webClient, new Logger("SlackHelpPrinter")),
  leaderboardPresenter: new SlackLeaderboardPresenter(webClient, channel),
  sessionLimit,
});

interface Action {
  value: string;
}

const actionEmitter = new EventEmitter<{ [action: string]: [Action, any] }>();

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

socketModeClient.on("interactive", async ({ body, ack }) => {
  await ack();
  inactivityCountdown.reset();
  if (body.type === "block_actions") {
    for (const action of body.actions) {
      actionEmitter.emit(action.action_id, action, body);
    }
  }
});

socketModeClient.on("slash_commands", async ({ body, ack }) => {
  if (body.command === "/bootcamp") {
    await ack();
    inactivityCountdown.reset();
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
          await application.joinSchedule({ weekday: args[2], user, channel });
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

socketModeClient.on("error", (error: Error) => {
  socketModeLogger.error("Error occurred, shutting down:", error);
  Deno.exit(1);
});

socketModeClient.on("disconnecting", () => {
  socketModeLogger.warn("Disconnecting");
});

socketModeClient.on("reconnecting", () => {
  socketModeLogger.info("Reconnecting");
});

socketModeClient.on("disconnected", (error: Error | undefined) => {
  if (error) {
    socketModeLogger.error("Disconnected with error:", error);
  } else {
    socketModeLogger.warn("Disconnected");
  }
});

socketModeClient.on("disconnect", (event) => {
  logger.error(
      "Received event disconnect.",
    );
  if (event && event.reason === "too_many_websockets") {
    logger.error(
      "Received too_many_websockets disconnect. Exiting app.",
    );
    Deno.exit(1);
  }
});

await socketModeClient.start();

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
