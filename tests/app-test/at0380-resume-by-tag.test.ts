/**
 * at0380-resume-by-tag.test.ts — the callsign is addressable ([P12]).
 *
 * ## What this gates
 *
 * `/resume <callsign>` resolves a name to a session and drives the same
 * `fireRestore` the picker's Open drives. Two of its three pieces can only be
 * seen in the running app:
 *
 *   A. **The route reads its argument, and the reverse index answers.** The
 *      card's `resume` surface used to ignore `args` and open the picker
 *      regardless — close enough to working that it would survive review. With
 *      an argument it must resolve instead, and the proof that it resolved is
 *      that it reports the *specific* outcome for that session rather than the
 *      generic "no such callsign".
 *
 *   B. **An unresolvable callsign is answered.** A typed command that does
 *      nothing at all reads as the app being broken, so the miss has a surface:
 *      a caution bulletin naming the callsign.
 *
 * Both go through `run-card-command`, which is the production door a menu item
 * carrying a name and args uses and which the module's own comment describes as
 * byte-identical to typing the command. It is used here rather than typing into
 * the composer because a background app-test cannot make the CM6 editor the
 * chain leaf, so Return never reaches the entry's submit — the same limitation
 * that keeps the ⌘S editor-leaf assertions at the store layer. The third piece,
 * the matcher accepting the argument at all (`takesArgs`), is exactly a pure
 * string rule and is unit-tested in `slash-commands.test.ts`.
 *
 * @covers tugdeck/src/lib/session-tag-store.ts
 * @covers tugdeck/src/components/tugways/cards/resume-sheet.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT_DIR = "/Users/tester/src/tugtool";
const TAG = "stocky-pixie";
const UNKNOWN_TAG = "nobody-home";

const CARD = '[data-card-id="S"]';
const BULLETIN = ".tug-pane-bulletin";
const RESUME_SHEET = ".resume-sheet";

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 620 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * The bulletins on screen, newest first, as `<tone>:<text>`. The pane
 * bulletin is the Session card's own (`session-card.tsx` mounts its
 * provider), so it stands in S's body.
 */
function bulletins(app: App): Promise<string[]> {
  return app.body("S").evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)})).map(
      function (b) {
        return (b.getAttribute("data-type") || "") + ":" + (b.innerText || "");
      })`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0380 — /resume <callsign>", () => {
  test(
    "an argument resolves the callsign; a miss is answered rather than swallowed",
    async () => {
      const app = await launchTugApp({ testName: "at0380-resume-by-tag" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await waitForBodyReady(app, "S");
        await app.bindSession("S", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        // The callsign arrives the way it always does — on the ledger row —
        // which is also what feeds the reverse index. The wire reaches every
        // page; the index the card's resume route reads is the one in S's
        // body, whose surface takes the row through `dispatchControlAction`
        // (the same `dispatchAction` the shell's `publishSessionUpdated` makes).
        const row = {
          session_id: SESSION_ID,
          fields: { tag: TAG, name: null, name_user_set: false },
        };
        // card-dom: shell — the shell's own identity stores take the row too.
        await app.evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify(row))})`,
        );
        await app.body("S").evalJS<boolean>(
          `(window.__tug.dispatchControlAction("session_updated", ${JSON.stringify(row)}), true)`,
        );
        await app.body("S").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // ---- B. A callsign nothing wears. ---------------------------------
        // card-dom: shell — `run-card-command` is the shell's action (the
        // menu's door); the shell routes it to the key card's body.
        await app.dispatchControlAction("run-card-command", {
          name: "resume",
          args: UNKNOWN_TAG,
        });
        await app.body("S").waitForCondition<boolean>(
          `(function(){
            var b = document.querySelector(${JSON.stringify(BULLETIN)});
            return b !== null && b.getAttribute("data-type") === "warning";
          })()`,
          { timeoutMs: 8_000 },
        );
        const missText = (await bulletins(app)).join(" | ");
        expect(missText).toContain(UNKNOWN_TAG);
        // It did not fall through to the picker: an argument names a session,
        // and failing to find it is not a reason to ask which one.
        expect(
          await app.body("S").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(RESUME_SHEET)}) === null`,
          ),
        ).toBe(true);

        // ---- A. A callsign the index knows resolves. -----------------------
        //
        // It resolves to the session this very card is showing, so the honest
        // outcome is "already open here" — and that is exactly what makes this
        // an assertion about RESOLUTION: a route that had not resolved anything
        // could only have said "no session called stocky-pixie".
        await app.dispatchControlAction("run-card-command", {
          name: "resume",
          args: TAG,
        });
        await app.body("S").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)}))
            .some(function (b) {
              return (b.innerText || "").indexOf("already open") !== -1;
            })`,
          { timeoutMs: 8_000 },
        );
        const hitText = (await bulletins(app)).join(" | ");
        expect(hitText).toContain(TAG);
        expect(hitText).not.toContain(`No session called ${TAG}`);

        // ---- And bare `/resume` still opens the picker. ---------------------
        await app.dispatchControlAction("run-card-command", { name: "resume" });
        await app.body("S").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESUME_SHEET)}) !== null`,
          { timeoutMs: 8_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
