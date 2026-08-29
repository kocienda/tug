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
        // Tall enough that the landing field's card-fraction ceiling does not
        // bind: the field's height is a count of lines, and the count is only
        // the answer on a card that can afford it.
        size: { width: 820, height: 780 },
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

        // Landing mode is a reading mode: the composer marks the subject as a
        // heading with a rule under it, the summary as the paragraph it is,
        // and COLLAPSES git's blank separator between them — the rule already
        // draws that break, and drawn twice it read as air the author had
        // left. Typed with real keys, because the decorations are rebuilt from
        // the document and a document nobody typed proves nothing.
        //
        // The bulleted shape leads, because it is the one the separator rule
        // has to be read off the DOCUMENT to catch: a body that opens on a
        // list has no summary paragraph at all, and a collapse scoped to the
        // summary left exactly this message with its blank line intact.
        const parts = (): Promise<{
          subject: number;
          ruled: number;
          summary: number;
          gaps: number;
          gapHeight: number;
          step: number;
          lineHeight: number;
          doc: string;
        }> =>
          app.evalJS(
            `(() => {
               const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
               const lines = content.querySelectorAll(".cm-line");
               const subject = content.querySelector(".cm-landing-subject").getBoundingClientRect();
               const after = lines[lines.length - 1].getBoundingClientRect();
               const gap = content.querySelector(".cm-landing-gap");
               return {
                 subject: content.querySelectorAll(".cm-landing-subject").length,
                 ruled: content.querySelectorAll(".cm-landing-subject-over-body").length,
                 summary: content.querySelectorAll(".cm-landing-summary").length,
                 gaps: content.querySelectorAll(".cm-landing-gap").length,
                 gapHeight: gap === null ? -1 : Math.round(gap.getBoundingClientRect().height),
                 step: Math.round(after.top - subject.bottom),
                 lineHeight: Math.round(subject.height),
                 doc: Array.from(lines).map((l) => l.textContent).join("|"),
               };
             })()`,
          );

        // A subject and nothing else wears no rule: the hairline is
        // SEPARATION, and under the last line of a document it would promise a
        // body that never comes. The one-line commit is the common message, so
        // this is the shape most often on screen.
        await app.nativeType("at0253(mode): a subject over bullets");
        await settle();
        const alone = await parts();
        // The pinned line has to be opaque — text passing behind it would
        // otherwise pass through it — and it has to be invisible: any color but
        // the field's own reads as a band drawn across the message. It is
        // painted from the surface the entry shell publishes as it paints the
        // field, so the two computed colors are one string.
        const surfaces = await app.evalJS<{ subject: string; field: string }>(
          `(() => {
             const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
             const paint = (el) => getComputedStyle(el).backgroundColor;
             return {
               subject: paint(content.querySelector(".cm-landing-subject")),
               field: paint(content.closest(".cm-editor")),
             };
           })()`,
        );
        note(`at0253 sticky surface: ${JSON.stringify(surfaces)}`);
        expect(
          surfaces.subject,
          "the pinned line shows no band of its own",
        ).toBe(surfaces.field);
        note(`at0253 subject-alone marks: ${JSON.stringify(alone)}`);
        expect(alone.subject, "the subject is still marked as the heading").toBe(1);
        expect(alone.ruled, "but nothing follows it, so no rule").toBe(0);
        expect(alone.gaps, "and no separator either").toBe(0);

        // Give that same subject a body, and both marks arrive together.
        await app.nativeKey("Return");
        await app.nativeKey("Return");
        await app.nativeType("- the first bullet, which is not prose");
        await settle();
        const bulleted = await parts();
        note(`at0253 bulleted marks: ${JSON.stringify(bulleted)}`);
        expect(bulleted.subject, "the subject line is marked").toBe(1);
        expect(bulleted.ruled, "and now it has a body, so it takes the rule").toBe(1);
        expect(bulleted.summary, "a bullet list is not a summary paragraph").toBe(0);
        expect(bulleted.gaps, "and the separator is marked all the same").toBe(1);
        expect(bulleted.gapHeight, "the separator draws no line of its own").toBe(0);
        expect(
          bulleted.step,
          "so the bullets follow the rule rather than a blank line",
        ).toBeLessThan(bulleted.lineHeight);

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

        // Grow a summary paragraph into the same message, ahead of the
        // bullets: the summary is marked as the prose it is, and the one
        // separator under the subject stays collapsed.
        await app.nativeKey("ArrowRight");
        await app.nativeType("The summary paragraph, which is prose.");
        await app.nativeKey("Return");
        await app.nativeKey("Return");
        await settle();
        const summarized = await parts();
        note(`at0253 summarized marks: ${JSON.stringify(summarized)}`);
        expect(summarized.summary, "the prose paragraph is marked").toBe(1);
        expect(summarized.gaps, "and the subject's separator is still the one").toBe(1);
        expect(summarized.gapHeight, "still collapsed").toBe(0);

        // The subject STAYS. A message longer than the field is read by
        // scrolling it, and the one line that must never leave is the topline —
        // it is what the reader is deciding on. It is sticky at the top of the
        // scroller, so scrolled to the very bottom the subject is still there,
        // flush with the top edge, with the detail moving underneath it.
        for (let n = 0; n < 16; n += 1) {
          await app.nativeType(`- detail line ${n}`);
          await app.nativeKey("Return");
        }
        await settle();

        // The field shows the number of lines the card asks for — counted the
        // way a reader counts them, as lines of the message standing whole
        // inside the field, not as a height divided by a height. The subject
        // is one of them and is taller than the rest (it wears the rule), which
        // is exactly the difference a height-over-height count misses.
        const visible = await app.evalJS<{
          shown: number;
          declared: number;
          clientHeight: number;
          lineBoxVar: string;
        }>(
          `(() => {
             const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
             const scroller = content.closest(".cm-scroller");
             scroller.scrollTop = 0;
             const box = scroller.getBoundingClientRect();
             const card = content.closest(".session-card");
             const shown = Array.from(content.querySelectorAll(".cm-line")).filter((line) => {
               const rect = line.getBoundingClientRect();
               // The collapsed separator is not a line anybody counts.
               if (rect.height === 0) return false;
               return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
             }).length;
             return {
               shown,
               clientHeight: scroller.clientHeight,
               lineBoxVar: getComputedStyle(scroller).getPropertyValue("--tugx-editor-line-box"),
               declared: parseFloat(
                 getComputedStyle(card).getPropertyValue("--session-entry-landing-lines"),
               ),
             };
           })()`,
        );
        note(`at0253 visible lines: ${JSON.stringify(visible)}`);
        expect(visible.shown, "the field shows the lines the card declared").toBe(visible.declared);
        const stuck = await app.evalJS<{
          overflow: number;
          scrolled: number;
          offset: number;
          visible: boolean;
        }>(
          `(() => {
             const content = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
             const scroller = content.closest(".cm-scroller");
             scroller.scrollTop = scroller.scrollHeight;
             const box = scroller.getBoundingClientRect();
             const subject = content.querySelector(".cm-landing-subject").getBoundingClientRect();
             return {
               overflow: Math.round(scroller.scrollHeight - scroller.clientHeight),
               scrolled: Math.round(scroller.scrollTop),
               offset: Math.round(subject.top - box.top),
               visible: subject.bottom > box.top && subject.top < box.bottom,
             };
           })()`,
        );
        note(`at0253 sticky subject: ${JSON.stringify(stuck)}`);
        expect(stuck.overflow, "the message outgrew the field, so it scrolls").toBeGreaterThan(0);
        expect(stuck.scrolled, "and it is scrolled away from the top").toBeGreaterThan(0);
        expect(stuck.visible, "the subject is on screen all the same").toBe(true);
        expect(
          Math.abs(stuck.offset),
          "held flush against the scroller's top edge",
        ).toBeLessThanOrEqual(2);

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
