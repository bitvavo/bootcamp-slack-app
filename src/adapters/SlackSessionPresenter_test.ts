import { assertEquals } from "@std/testing/asserts";
import { SlackSessionPresenter } from "./SlackSessionPresenter.ts";
import { LocalDate } from "../domain/LocalDate.ts";
import { Session } from "../domain/Session.ts";

function withFixedDate<T>(
  iso: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
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
    static override now() {
      return fixed.getTime();
    }
  }
  // @ts-ignore
  globalThis.Date = FakeDate as any;
  try {
    return fn();
  } finally {
    // @ts-ignore
    globalThis.Date = RealDate as any;
  }
}

function buildFakeWebClient() {
  const calls: any[] = [];
  const webClient = {
    chat: {
      postMessage: async (args: any) => {
        calls.push({ type: "postMessage", args });
        return { ts: "123" };
      },
      update: async (args: any) => {
        calls.push({ type: "update", args });
      },
    },
  } as any;
  return { webClient, calls };
}

Deno.test("SlackSessionPresenter posts Monday evening and Tuesday morning with correct intros and participants text", async () => {
  await withFixedDate("2025-06-02T12:00:00Z", async () => {
    const { webClient, calls } = buildFakeWebClient();
    const monday = LocalDate.today(); // 2025-06-02 Monday
    const presenter = new SlackSessionPresenter(webClient, "C", () => monday);
    const tuesday = monday.tomorrow(); // 2025-06-03 Tuesday

    // Sanity: ensure tomorrow detection aligns
    const computedTomorrow = LocalDate.today().tomorrow();
    assertEquals(tuesday.equals(computedTomorrow), true);

    const monEvening: Session = {
      sessionId: "S1",
      date: monday,
      hour: 17,
      minute: 0,
      participants: [],
    };
    const tueMorning: Session = {
      sessionId: "S2",
      date: tuesday,
      hour: 7,
      minute: 0,
      participants: [],
    };

    await presenter.presentSession(monEvening);
    await presenter.presentSession(tueMorning);

    // Expect two postMessage calls
    assertEquals(calls.length, 2);

    const intros = calls.map((c) => c.args.blocks[0].text.text as string);
    const participantsTexts = calls.map((c) =>
      c.args.blocks[1].text.text as string
    );

    // Validate intros regardless of order
    intros.sort();
    assertEquals(
      intros.includes("*Ready to sweat today at 17:00?* :hot_face:"),
      true,
    );
    assertEquals(
      intros.includes("*Ready to sweat tomorrow at 07:00?* :hot_face:"),
      true,
    );

    // Validate participants section texts
    for (const p of participantsTexts) {
      assertEquals(p, "_Nobody is joining so far..._");
    }
  });
});

Deno.test("SlackSessionPresenter posts only today evening on Tuesday morning", async () => {
  await withFixedDate("2025-06-03T12:00:00Z", async () => {
    const { webClient, calls } = buildFakeWebClient();
    const tuesday = LocalDate.today();
    const presenter = new SlackSessionPresenter(webClient, "C", () => tuesday);
    const tueEvening: Session = {
      sessionId: "S3",
      date: tuesday,
      hour: 17,
      minute: 0,
      participants: [],
    };

    await presenter.presentSession(tueEvening);

    assertEquals(calls.length, 1);
    const first = calls[0].args;
    const intro = first.blocks[0].text.text as string;
    assertEquals(intro, "*Ready to sweat today at 17:00?* :hot_face:");
  });
});
