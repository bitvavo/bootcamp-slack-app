import { KnownBlock, WebClient } from "@slack/web-api";
import { SessionPresenter } from "../application/SessionPresenter.ts";
import { Session } from "../domain/Session.ts";
import { list } from "../utils.ts";
import { SlackActions } from "./SlackActions.ts";
import { formatTime24h } from "../application/BootcampSchedule.ts";
import { LocalDate } from "../domain/LocalDate.ts";

export class SlackSessionPresenter implements SessionPresenter {
  readonly #webClient: WebClient;
  readonly #channel: string;
  readonly #todayProvider: () => LocalDate;

  constructor(
    webClient: WebClient,
    channel: string,
    todayProvider: () => LocalDate = () => LocalDate.today(),
  ) {
    this.#webClient = webClient;
    this.#channel = channel;
    this.#todayProvider = todayProvider;
  }

  async presentSession(session: Session): Promise<void> {
    if (session.ts) {
      await this.#webClient.chat.update({
        blocks: this.render(session),
        channel: this.#channel,
        ts: session.ts,
      });
    } else {
      const { ts } = await this.#webClient.chat.postMessage({
        blocks: this.render(session),
        channel: this.#channel,
      });
      session.ts = ts;
    }
  }

  async representSession(session: Session): Promise<void> {
    if (session.ts) {
      await this.#webClient.chat.update({
        blocks: this.render(session),
        channel: this.#channel,
        ts: session.ts,
      });
    }
  }

  private render(session: Session): KnownBlock[] {
    const introText = this.renderIntroText(session);
    const participantsText = this.renderParticipants(
      session.participants,
      session.limit,
    );
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: introText,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: participantsText,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: plainText("Join Bootcamp"),
            style: "primary",
            value: session.sessionId,
            action_id: SlackActions.JOIN,
          },
          {
            type: "button",
            text: plainText("Stay Home"),
            value: session.sessionId,
            action_id: SlackActions.QUIT,
          },
        ],
      },
    ];
  }

  private renderParticipants(
    participants: string[],
    limit: number | undefined,
  ): string {
    if (participants.length === 0) {
      return "_Nobody is joining so far..._";
    }

    let limitText = "";
    if (limit) {
      limitText = ` (${participants.length}/${limit})`;
    }

    if (participants.length === 1) {
      return `<@${participants[0]}> is joining :muscle:${limitText}`;
    }

    return list(participants.map((it) => `<@${it}>`)) + " are joining" +
      limitText;
  }

  private renderIntroText(session: Session): string {
    const hasTime = Number.isFinite(session.hour) &&
      Number.isFinite(session.minute);
    const time = hasTime
      ? formatTime24h(session.hour, session.minute)
      : undefined;
    const today = this.#todayProvider();
    if (session.date.equals(today)) {
      return hasTime
        ? `*Ready to sweat today at ${time}?* :hot_face:`
        : "*Ready to sweat today?* :hot_face:";
    }
    const tomorrow = today.tomorrow();
    if (session.date.equals(tomorrow)) {
      return hasTime
        ? `*Ready to sweat tomorrow at ${time}?* :hot_face:`
        : "*Ready to sweat tomorrow?* :hot_face:";
    }
    return hasTime
      ? `Who joined on ${session.date.toHuman()} at ${time}:`
      : `Who joined on ${session.date.toHuman()}:`;
  }
}

function plainText(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}
