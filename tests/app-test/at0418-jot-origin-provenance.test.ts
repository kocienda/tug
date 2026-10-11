/**
 * at0418-jot-origin-provenance.test.ts — a copied passage carries the project
 * it was written against, and the jot it lands in keeps it.
 *
 * A transcript cites files the way people talk about them: `src/knobs.ts:3`,
 * relative to a repo root the sentence never names because everyone reading it
 * in place already knows which one. Copy that sentence into a jot and the
 * citation has no root — the jots card is machine-global, bound to no session
 * and no project. Resolving it against whatever project happens to be frontmost
 * is a guess, and it is wrong exactly when the user has more than one project
 * open.
 *
 * So the copy writes the root down: a Tug copy puts it in the clipboard
 * sidecar's `origins`, and the paste records it on the jot.
 *
 * The setup is built so that ONLY the carried root can explain a pass:
 *
 *   - project **P** holds `src/knobs.ts`; the session card citing it is bound
 *     to P and lives in the BACK pane;
 *   - project **Q** holds no such file, and its card is in the FRONT pane —
 *     so the frontmost-project fallback resolves nothing;
 *   - the jot is pasted while Q is frontmost.
 *
 * A link that lights up therefore came from the pasteboard, not from the deck.
 *
 * Foreground: ⌘V is an Edit-menu key equivalent, so AppKit resolves it against
 * the main menu before the web view sees a keydown, and a background instance
 * has no key window for that resolution to land in. The editor-leaf responder
 * route is not an alternative here — a headless run cannot make an in-list
 * editor the chain leaf. The COPY half needs no chord (the row's own Copy
 * button is a click), so the chord is confined to the one step that needs it.
 *
 * @foreground
 *
 * Asserts:
 *  - the pasted text lands in the jot (the ordinary paste still works);
 *  - `jots.json` on disk records P in the jot's `origins` — the Rust model and
 *    the TS model agree, or the field is silently dropped on the next save;
 *  - the cited path becomes a `.cm-annotation-link`, resolved through P while Q
 *    is the frontmost project.
 *
 * @covers tugdeck/src/lib/clipboard-origin.ts
 * @covers tugdeck/src/lib/copy-text.ts
 * @covers tugdeck/src/lib/jots-doc.ts
 * @covers tugdeck/src/lib/jots-store.ts
 * @covers tugdeck/src/lib/annotator/resolve-reference.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0418-session";
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT

const EDITOR = `.jots-list .jot-editor`;
const LINK = `${EDITOR} .cm-annotation-link`;

/** The citation, relative to project P and to nothing else. */
const CITED = "src/knobs.ts:3";
const FILE_BODY = ["export const knobs = {", "  // use", "  flash: 1500,", "};", ""].join("\n");

/** A sentinel so "the copy never happened" is distinguishable from a real copy. */
const COPY_SENTINEL = "at0418-sentinel-nothing-copied";

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Source", closable: true },
      { id: "B", componentId: "session", title: "Other", closable: true },
    ],
    panes: [
      // Panes are back-to-front, so the LAST is topmost: the frontmost bound
      // project is B's, which is the project that must not be able to explain
      // the link.
      {
        id: "pA",
        position: { x: 20, y: 40 },
        size: { width: 820, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "pB",
        position: { x: 880, y: 40 },
        size: { width: 420, height: 300 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pB",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0418 — a jot keeps the project it was copied from", () => {
  test(
    "a path copied from one project resolves in a jot while another is frontmost",
    async () => {
      const tugbankPath = mkTempTugbank();
      const source = mkdtempSync(join(tmpdir(), "at0418-source-"));
      const other = mkdtempSync(join(tmpdir(), "at0418-other-"));
      mkdirSync(join(source, "src"), { recursive: true });
      writeFileSync(join(source, "src", "knobs.ts"), FILE_BODY);

      const jotsPath = join(other, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          { version: 1, jots: [{ id: "s1", text: "" }] },
          null,
          2,
        )}\n`,
      );

      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0418-jot-origin-provenance",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
          foreground: true,
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A") &&
             window.__tug.assertHostRootRegistered("B")`,
            { timeoutMs: 8_000 },
          );
          // A is the project the prose is about; B is the project that will be
          // frontmost when the paste happens.
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir: source,
            sessionMode: "resume",
          });
          await app.bindSession("B", {
            tugSessionId: "at0418-other-session",
            projectDir: other,
          });

          // --- a transcript that cites a file, in project P ----------------
          const ingest = (decoded: unknown) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded,
            });
          await ingest({ type: "replay_started", tug_session_id: SID });
          await ingest({
            type: "add_user_message",
            tug_session_id: SID,
            content: [{ type: "text", text: "where is the knob" }],
          });
          await ingest({
            type: "assistant_text",
            status: "complete",
            tug_session_id: SID,
            msg_id: "m1",
            text: `Tune it in \`${CITED}\`.`,
            is_partial: false,
            rev: 0,
            seq: 1,
          });
          await ingest({
            type: "turn_complete",
            seq: 0,
            tug_session_id: SID,
            msg_id: "m1",
            result: "success",
          });
          await ingest({
            type: "replay_complete",
            tug_session_id: SID,
            count: 1,
            firstLoadedTurnIndex: 0,
            totalTurns: 1,
            hasOlder: false,
          });

          const CODE = `[data-card-id="A"] .session-card-transcript-code-body code`;
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(CODE)}))
               .some((c) => (c.textContent ?? '') === ${JSON.stringify(CITED)})`,
            { timeoutMs: 10_000 },
          );

          // The card stamps its project, which is what the copy reads.
          expect(
            await app.evalJS<string | null>(
              `document.querySelector('[data-card-id="A"] .session-card')
                 ?.getAttribute('data-tug-clipboard-origin') ?? null`,
            ),
          ).toBe(source);

          // --- copy the message --------------------------------------------
          //
          // The row's own Copy button, not ⌘C: ⌘C is Edit ▸ Copy's key
          // equivalent, which AppKit resolves against the MAIN MENU, and a
          // background app-test instance has no active main menu — the copy
          // event never fires (at0188 pays for the foreground tier to test
          // that door). The button is a plain click, and it reaches the same
          // provenance-carrying write.
          Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(COPY_SENTINEL) });
          // The LAST Copy in the card — every turn row has one, and the first
          // belongs to the user's question.
          const COPY_BUTTON = `[data-card-id="A"] [data-slot="session-z1b-copy"]`;
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(COPY_BUTTON)}).length >= 2`,
            { timeoutMs: 5_000 },
          );
          const copyPoint = await app.evalJS<{ x: number; y: number }>(
            `(() => {
               const all = document.querySelectorAll(${JSON.stringify(COPY_BUTTON)});
               const r = all[all.length - 1].getBoundingClientRect();
               return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
             })()`,
          );
          await app.nativeClick(copyPoint);

          // The pasteboard is where the write lands, so it is where "the copy
          // happened" is observable at all.
          const deadline = Date.now() + 5_000;
          let pasted = COPY_SENTINEL;
          while (pasted === COPY_SENTINEL && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
            pasted = Bun.spawnSync(["pbpaste"]).stdout.toString();
          }
          expect(pasted).toContain(CITED);

          // --- paste into a jot, with the OTHER project frontmost ----------
          await app.dispatchControlAction("toggle-jots");
          await app.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jot-row-label') !== null`,
            { timeoutMs: 5_000 },
          );
          await app.nativeClickAtElement(".jots-card .jot-row-label");
          await app.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );
          // ⌘V reaches a FOCUSED editable directly (WebKit handles it), which
          // is why this waits for the caret rather than assuming it: without
          // focus the chord would need the main menu, which a background
          // instance does not have.
          await app.waitForCondition<boolean>(
            `document.activeElement !== null &&
             document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("v", ["cmd"]);
          await app.waitForCondition<boolean>(
            `((document.querySelector('${EDITOR} .cm-content')?.textContent) ?? '')
               .includes(${JSON.stringify(CITED)})`,
            { timeoutMs: 5_000 },
          );

          // The provenance reached the FILE — the TS model and the Rust model
          // agree, or the field is dropped on the next save with no sign.
          const savedDeadline = Date.now() + 8_000;
          let origins: string[] = [];
          while (origins.length === 0 && Date.now() < savedDeadline) {
            await new Promise((r) => setTimeout(r, 100));
            try {
              const doc = JSON.parse(readFileSync(jotsPath, "utf8")) as {
                jots: { id: string; origins?: string[] }[];
              };
              origins = doc.jots[0]?.origins ?? [];
            } catch {
              // Mid-write (temp-file + rename) — read again.
            }
          }
          expect(origins).toEqual([source]);

          // --- and the citation resolves, through the carried root ---------
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LINK)}) !== null`,
            { timeoutMs: 12_000 },
          );
          expect(
            await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(LINK)}).textContent`,
            ),
          ).toBe(CITED);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0418] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(other, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
