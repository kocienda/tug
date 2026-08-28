/**
 * at0253-commit-dialog.test.ts — commit-mode open/dismiss drives ([P03]
 * revised, [D119]).
 *
 * `/commit` enters *commit mode* — a bottom-anchored commit sheet rises from
 * the top of Z2 and the prompt entry becomes the message editor, so Z5 shows
 * the cancel / auto-message / commit icon rail. Cheap drives only: typing
 * `/commit` enters the mode — the rising commit sheet panel appears AND the
 * Z5 Commit button appears — and Escape exits it (both vanish). The mode
 * activates regardless of changeset state ([P09]) — an empty changeset shows
 * the "None" sheet with the Commit button disabled-but-present — so no
 * real changes are needed. The full commit round-trip is covered at the Rust
 * layer (the replay workspace's changeset entries live ~2s). ⌃⌘C toggles this
 * same bottom sheet (and, on an empty composer, the mode); the chord's own
 * round trip is at0340's, so this suite drives the menu door instead.
 *
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/landing-message-structure.ts
 * @covers tugdeck/src/lib/changeset-draft-store.ts
 * @covers tugdeck/src/lib/landing-receipt.ts
 * @covers tugrust/crates/tugchanges-core/
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0253-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
// The Z5 Commit button is commit mode's tell: present exactly while the
// mode is active (the retired dialog's `data-slot` is gone).
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
// The bottom-anchored changes sheet: the TugSheet mounts its shade panel only
// while open, so this is present exactly while the sheet has risen. The mode
// and the sheet are decoupled ([D117] revised) — entering the mode via
// `/commit` on an empty composer raises this same sheet.
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0253-commit-"));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0253: commit mode + read-only shade", () => {
  test(
    "/commit enters commit mode — the sheet rises and Z5 shows Commit; Escape exits",
    async () => {
      const app = await launchTugApp({ testName: "at0253-commit-dialog" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir });
        await app.awaitEngineReady("A");

        // Drive one committed turn so the card is a live, non-empty session.
        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });
        await app.driveSession("A", { op: "send", text: "hello there" });
        await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
        await frame({ type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        await frame({ type: "assistant_text", msg_id: "m1", block_index: 0, text: "hi", is_partial: false });
        await frame({ type: "turn_complete", msg_id: "m1", result: "success" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── /commit enters the mode: the sheet rises AND Z5 shows Commit ─────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]); // submit → run /commit
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null &&
           document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
          { timeoutMs: 6000 },
        );

        // ── The message's parts, marked in the field ──────────────────────
        // Landing mode is a reading mode: the composer marks the subject as a
        // heading with a rule under it, the summary as the paragraph it is,
        // and COLLAPSES git's blank separator between them — the rule already
        // draws that break, and drawn twice it read as air the author had
        // left. Typed with real keys, because the decoration is rebuilt from
        // the document and a document nobody typed proves nothing.
        await app.nativeType("at0253(mode): the subject line");
        await app.nativeKey("Return");
        await app.nativeKey("Return");
        await app.nativeType("The summary paragraph, which is prose.");
        await settle();
        const marks = await app.evalJS<{
          subject: number;
          summary: number;
          gaps: number;
          gapHeight: number;
          step: number;
          lineHeight: number;
        }>(
          `(() => {
             const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
             const at = (sel) => content.querySelector(sel);
             const subject = at(".cm-landing-subject").getBoundingClientRect();
             const summary = at(".cm-landing-summary").getBoundingClientRect();
             const gap = at(".cm-landing-gap");
             return {
               subject: content.querySelectorAll(".cm-landing-subject").length,
               summary: content.querySelectorAll(".cm-landing-summary").length,
               gaps: content.querySelectorAll(".cm-landing-gap").length,
               gapHeight: gap === null ? -1 : Math.round(gap.getBoundingClientRect().height),
               step: Math.round(summary.top - subject.bottom),
               lineHeight: Math.round(subject.height),
             };
           })()`,
        );
        note(`at0253 landing marks: ${JSON.stringify(marks)}`);
        expect(marks.subject, "the subject line is marked").toBe(1);
        expect(marks.summary, "and so is the summary's line").toBe(1);
        expect(marks.gaps, "and the separator between them is marked too").toBe(1);
        expect(marks.gapHeight, "the separator draws no line of its own").toBe(0);
        expect(
          marks.step,
          "so the summary follows the rule rather than a blank line",
        ).toBeLessThan(marks.lineHeight);

        // A collapsed line is still an editable one. The caret's line is never
        // marked, so stepping onto the separator gives it back its height —
        // without that, a caret parked there would be invisible. Horizontally,
        // because that is how a collapsed line is reached: vertical motion in
        // CodeMirror is geometric and steps over a zero-height line, which is
        // the behaviour worth having — the reader never arrows into a phantom.
        await app.nativeKey("ArrowLeft", ["cmd"]);
        await app.nativeKey("ArrowLeft");
        await settle();
        const onGap = await app.evalJS<number>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}).querySelectorAll(".cm-landing-gap").length`,
        );
        expect(onGap, "the separator is a real line when the caret is on it").toBe(0);

        // Escape exits the mode (sheet drops, composer restores its prompt draft).
        await settle();
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) === null &&
           document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) === null`,
          { timeoutMs: 4000 },
        );

        // The card and its transcript survived the open/dismiss cycle.
        const after = await app.evalJS<{ cardPresent: boolean; userRows: number }>(
          `({
             cardPresent: document.querySelector(${JSON.stringify(CARD)}) !== null,
             userRows: document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length,
           })`,
        );
        expect(after.cardPresent).toBe(true);
        expect(after.userRows).toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
