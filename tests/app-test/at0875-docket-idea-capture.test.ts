/**
 * at0875-docket-idea-capture.test.ts — a line typed into the Docket card is
 * an idea, and Sketch it opens a session that starts from it.
 *
 * ## What this gates
 *
 * The unit tests pin the pieces: the idea verbs' decoding, which gestures a
 * thread offers, the prompt Sketch it sends. What only the app can show is
 * the loop through the real server and a real fresh session:
 *
 *   A. **Return captures an idea.** A line typed into the field and Return
 *      becomes an inbox row reading the line, under the Inbox label, the
 *      field empties, and the built `tugtool idea list` holds it.
 *   B. **Sketch it opens a session on the idea.** Pressing Sketch it on the
 *      row opens a new Session card whose first user turn is the idea's
 *      line, and the idea's row gains the session's cell.
 *
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/components/docket/docket-card.css
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/docket-verbs.ts
 * @covers tugdeck/src/lib/opening-command-runner.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  FIELD_CONTENT,
  INBOX_LABEL,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitOpenedSession,
  captureIdea,
  cli,
  gesturesOn,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  pressGesture,
  rmAuthoringScratch,
  rowFor,
  sessionCards,
  type AuthoringScratch,
} from "./docket-authoring-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a875";
const IDEA = "a ledger of the jots we keep retyping";

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0875", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

describe.skipIf(!SHOULD_RUN)("at0875 — capturing an idea and sketching it", () => {
  test(
    "Return files the line as an inbox idea, and Sketch it opens a session that starts from it",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0875-docket-idea-capture");
      try {
        await newDocket(app, "Ideas");

        // ---- A. Return captures an idea. -----------------------------------
        await captureIdea(app, IDEA);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INBOX_LABEL)}) !== null
           && (document.querySelector(${JSON.stringify(FIELD_CONTENT)}).textContent || "").indexOf(${JSON.stringify(IDEA)}) === -1`,
          { timeoutMs: 5_000 },
        );
        const listed = JSON.parse(cli(s!, ["idea", "list", "--json"])) as {
          data: Array<{ text: string; sessions: number }>;
        };
        expect(listed.data.map((i) => i.text)).toEqual([IDEA]);
        expect(await gesturesOn(app, IDEA)).toEqual(["sketch-it"]);

        // ---- B. Sketch it opens a session on the idea. ---------------------
        const known = await sessionCards(app);
        await pressGesture(app, IDEA, "sketch-it");
        const opened = await awaitOpenedSession(app, known, [IDEA]);
        expect(opened.turn.trim()).toBe(IDEA);
        await app.body("D").waitForCondition<boolean>(
          `(function(){ var r = ${rowFor(IDEA)}; return r !== null && r.querySelector('[data-slot="docket-session-cell"]') !== null; })()`,
          { timeoutMs: 15_000 },
        );
        const after = JSON.parse(cli(s!, ["idea", "list", "--json"])) as {
          data: Array<{ text: string; sessions: number }>;
        };
        expect(after.data[0]!.sessions).toBe(1);
        // Sketched once, the idea can now have its sketch kept.
        expect(await gesturesOn(app, IDEA)).toEqual(["sketch-it", "keep-sketch"]);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
