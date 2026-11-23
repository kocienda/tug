/**
 * at0882-docket-landed-revert.test.ts — the Docket card lists landed arcs in
 * the order they joined, with their join commits, and Revert undoes one.
 *
 * ## What this gates
 *
 * The Rust tests pin the revert itself — its preflight, its conflict abort,
 * the `reverted` line — and the thread cell's `joined_at` and `reverted`; the
 * unit tests pin the frames, the group's order and the confirm's sentence.
 * What only the app can show is a join the CLI made reaching the card through
 * the real DOCKETS feed, and a press going through the dry run, the confirm
 * and the real revert, and back.
 *
 *   A. **Two joined arcs show in the Landed group in join order**, each with
 *      its join commit atom and Revert.
 *   B. **Revert's confirm names the file count** the join touched.
 *   C. **Confirming marks the row reverted** with the revert commit's atom,
 *      and the base carries the revert commit.
 *
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/lib/docket-verbs.ts
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/docket-loop-actions.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import { gitRetry } from "./arc-fixture";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  captureIdea,
  focusDocket,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  rmAuthoringScratch,
  type AuthoringScratch,
} from "./docket-authoring-fixture";
import {
  arcRow,
  makeJoinedArc,
  readLanded,
  type LandedReading,
} from "./docket-loop-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a882";
const OLDER = "rail";
const NEWER = "sleeper";
const OLDER_IDEA = "lay the rail";
const NEWER_IDEA = "set the sleepers";

const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_BUTTON = '[data-slot="tug-confirm-confirm"]';

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0882", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

/** Wait until the Landed group reads as `want` says, noting it on a miss. */
async function awaitLanded(
  app: App,
  what: string,
  want: (rows: LandedReading[]) => boolean,
): Promise<LandedReading[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const rows = await readLanded(app);
    if (want(rows)) return rows;
    if (Date.now() > deadline) {
      const line = await app.body("D").evalJS<string | null>(
        `(document.querySelector('[data-slot="docket-filing-line"]') || {}).textContent || null`,
      );
      note(`docket landed: ${what}`, JSON.stringify({ rows, line }));
      throw new Error(`the Landed group never ${what}`);
    }
    await Bun.sleep(100);
  }
}

describe.skipIf(!SHOULD_RUN)("at0882 — the Landed group and Revert", () => {
  test(
    "landed arcs list in join order with their commits; Revert asks, then commits a revert",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0882-docket-landed-revert");
      try {
        await newDocket(app, "Rail");
        await captureIdea(app, OLDER_IDEA);
        await captureIdea(app, NEWER_IDEA);
        makeJoinedArc(s!, OLDER, OLDER_IDEA, "rail.txt");
        makeJoinedArc(s!, NEWER, NEWER_IDEA, "sleeper.txt");

        // ---- A. Both landed, in join order, each with its join commit. -----
        const landed = await awaitLanded(app, "listed both joined arcs", (r) => r.length === 2);
        expect(landed).toEqual([
          { arc: OLDER, join: true, reverted: false, revert: true },
          { arc: NEWER, join: true, reverted: false, revert: true },
        ]);

        // ---- B. Revert's confirm names the file count. ---------------------
        await focusDocket(app);
        const mark = "data-revert-press";
        await app.body("D").evalJS<null>(
          `(function(){
            document.querySelectorAll("[${mark}]").forEach(function (el) { el.removeAttribute("${mark}"); });
            ${arcRow(OLDER)}.querySelector('[data-slot="docket-landed-revert-button"]').setAttribute("${mark}", "1");
            return null;
          })()`,
        );
        await app.body("D").nativeClickAtElement(`[${mark}="1"]`);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const message = await app.body("D").evalJS<string>(
          `(document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}) || {}).textContent || ""`,
        );
        expect(message).toContain(`Revert ${OLDER}?`);
        expect(message).toContain("touched 1 file");

        // ---- C. Confirming marks the row reverted. -------------------------
        await app.body("D").nativeClickAtElement(CONFIRM_BUTTON);
        const after = await awaitLanded(app, "marked the older arc reverted", (r) =>
          r.length === 2 && r[0]!.reverted,
        );
        expect(after).toEqual([
          { arc: OLDER, join: true, reverted: true, revert: false },
          { arc: NEWER, join: true, reverted: false, revert: true },
        ]);
        const subject = gitRetry(s!.scratch.repo, "log", "-1", "--format=%s").trim();
        expect(subject.startsWith('Revert "')).toBe(true);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
