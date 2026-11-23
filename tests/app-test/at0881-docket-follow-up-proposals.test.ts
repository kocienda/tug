/**
 * at0881-docket-follow-up-proposals.test.ts — an audit's follow-ups arrive in
 * the Docket card's Inbox as proposals, and Accept and Dismiss settle them.
 *
 * ## What this gates
 *
 * The Rust tests pin the follow-up lines, their k, and how a decision settles
 * one; the unit tests pin the frames and the proposal list. What only the app
 * can show is a line `tugtool arc follow-up` writes reaching the card through
 * the real DOCKETS feed, and a press going round the CONTROL verbs and back.
 *
 *   A. **Two follow-ups recorded through the CLI appear in the Inbox**, each
 *      naming the arc it came from, under the Inbox label, in the order they
 *      were recorded.
 *   B. **Accept turns one into an idea row**: the proposal leaves, and an
 *      idea thread reading its line takes its place on the docket.
 *   C. **Dismiss removes the other**, and makes no idea.
 *
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/docket-verbs.ts
 * @covers tugdeck/src/lib/docket-loop-actions.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  captureIdea,
  focusDocket,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  rmAuthoringScratch,
  rowFor,
  type AuthoringScratch,
} from "./docket-authoring-fixture";
import {
  makeStaleArc,
  proposalRow,
  readProposals,
  recordFollowUp,
  type ProposalReading,
} from "./docket-loop-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a881";
const ARC = "rail";
const IDEA = "lay the rail in three pieces";
const FIRST = "Name the rails before the next survey";
const SECOND = "Paint the rails once they settle";

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0881", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

/** Wait until the card's proposals read as `want` says, noting them on a miss. */
async function awaitProposals(
  app: App,
  what: string,
  want: (rows: ProposalReading[]) => boolean,
): Promise<ProposalReading[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rows = await readProposals(app);
    if (want(rows)) return rows;
    if (Date.now() > deadline) {
      const line = await app.body("D").evalJS<string | null>(
        `(document.querySelector('[data-slot="docket-filing-line"]') || {}).textContent || null`,
      );
      note(`docket proposals: ${what}`, JSON.stringify({ rows, line }));
      throw new Error(`the Inbox never ${what}`);
    }
    await Bun.sleep(100);
  }
}

/** Mark the button `slot` in the proposal reading `text` and press it for real. */
async function pressOnProposal(app: App, text: string, slot: string): Promise<void> {
  await focusDocket(app);
  const mark = "data-proposal-press";
  await app.body("D").evalJS<null>(
    `(function(){
      document.querySelectorAll("[${mark}]").forEach(function (el) { el.removeAttribute("${mark}"); });
      ${proposalRow(text)}.querySelector('[data-slot="${slot}"]').setAttribute("${mark}", "1");
      return null;
    })()`,
  );
  await app.body("D").nativeClickAtElement(`[${mark}="1"]`);
}

describe.skipIf(!SHOULD_RUN)("at0881 — follow-ups as Inbox proposals", () => {
  test(
    "recorded follow-ups are proposed in the Inbox; Accept makes an idea and Dismiss hides one",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0881-docket-follow-up-proposals");
      try {
        await newDocket(app, "Rail");
        await captureIdea(app, IDEA);
        makeStaleArc(s!, ARC, IDEA);

        // ---- A. Two follow-ups appear in the Inbox. ------------------------
        expect(recordFollowUp(s!, ARC, FIRST)).toBe(1);
        expect(recordFollowUp(s!, ARC, SECOND)).toBe(2);
        const shown = await awaitProposals(app, "showed both follow-ups", (r) => r.length === 2);
        expect(shown).toEqual([
          { from: `from ${ARC}`, text: FIRST, inInbox: true },
          { from: `from ${ARC}`, text: SECOND, inInbox: true },
        ]);

        // ---- B. Accept turns one into an idea row. -------------------------
        await pressOnProposal(app, FIRST, "docket-proposal-accept");
        await awaitProposals(app, "let the accepted follow-up go", (r) =>
          r.length === 1 && r[0]!.text === SECOND,
        );
        await app.body("D").waitForCondition<boolean>(`${rowFor(FIRST)} !== null`, {
          timeoutMs: 20_000,
        });

        // ---- C. Dismiss removes the other. ---------------------------------
        await pressOnProposal(app, SECOND, "docket-proposal-dismiss");
        await awaitProposals(app, "let the dismissed follow-up go", (r) => r.length === 0);
        expect(
          await app.body("D").evalJS<boolean>(`${rowFor(SECOND)} === null`),
          "a dismissed follow-up makes no idea",
        ).toBe(true);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
