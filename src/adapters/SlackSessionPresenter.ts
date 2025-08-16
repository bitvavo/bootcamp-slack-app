import { KnownBlock, WebClient } from "@slack/web-api";
import { SessionPresenter } from "../application/SessionPresenter.ts";
import { Session } from "../domain/Session.ts";
import { list } from "../utils.ts";
import { LocalDate } from "../domain/LocalDate.ts";
import { SlackActions } from "./SlackActions.ts";

export class SlackSessionPresenter implements SessionPresenter {
  readonly #webClient: WebClient;
  readonly #channel: string;

  constructor(webClient: WebClient, channel: string) {
    this.#webClient = webClient;
    this.#channel = channel;
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
    if (session.date.isToday()) {
      return "*Ready to sweat today?* :hot_face:";
    }
    // Special Monday tease for Tuesday 07:00 session
    const todayWeekday = LocalDate.today().weekday;
    if (todayWeekday === LocalDate.MONDAY && session.date.weekday === LocalDate.TUESDAY && session.time === "07:00") {
      return "ready to join 7am outdoors session tomorrow?";
    }

    return `Who joined on ${session.date.toHuman()}:`;
  }
}

function plainText(text: string): { type: "plain_text"; text: string } {
  return { type: "plain_text", text };
}
