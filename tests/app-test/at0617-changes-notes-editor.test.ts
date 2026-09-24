/**
 * at0617-changes-notes-editor.test.ts — editing release notes in the row that
 * lists them.
 *
 * A release's notes are the one file in a release round whose content is the
 * user's to write, and before this the shade could only show their diff. Now a
 * `release-notes/*.md` row on the **session entry** carries a pencil, and
 * pressing it puts a real `TextCardStore` in automatic mode under a real
 * `TugTextCardEditor` in the row's expanded body, in the diff's place ([P08]).
 *
 * The one assertion this test exists for is the one a unit test cannot make:
 * that a keystroke in the shade reaches the **disk**. Everything between the
 * caret and the file — CM6's document, the bridge, the autosave debounce, the
 * `/api/fs/write` round trip — is live, so the test reads the file back with
 * `readFileSync` and does not believe the status line until the bytes agree.
 *
 * It also pins the scope: the `.txt` row beside it has no pencil at all. The
 * editor mode is offered on release notes and nothing else, because a general
 * file editor in the Changes shade is what [B08] declines.
 *
 * The session entry is composed the at0334 way — `app.seedLedger()` after
 * launch writes a live `sessions` row plus proof-class `file_events`, which is
 * what makes these paths *this session's* rather than unattributed. Both
 * scratch files live in this checkout, because the registry keys a workspace by
 * the canonical project dir; `afterAll` removes them.
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notes-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notes-editor.css
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-read-error-copy.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0617-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const SESSION_ENTRY = `${SHEET} [data-entry-kind="session"]`;

// The registry keys a workspace by the canonical project dir, so both scratch
// files have to live in this checkout — the constraint at0332/at0334 record.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const NOTES_FILE = "release-notes/at0617-scratch.md";
const OTHER_FILE = "at0617-scratch.txt";
const notesPath = join(PROJECT_DIR, NOTES_FILE);
const otherPath = join(PROJECT_DIR, OTHER_FILE);

const NOTES_ROW =
  `${SESSION_ENTRY} [data-testid="tug-changes-list-file-block"][data-path="${NOTES_FILE}"]`;
const OTHER_ROW =
  `${SESSION_ENTRY} [data-testid="tug-changes-list-file-block"][data-path="${OTHER_FILE}"]`;
const NOTES_PENCIL = `${NOTES_ROW} [data-testid="tug-changes-list-edit"]`;
const EDITOR = `${NOTES_ROW} [data-testid="session-changes-notes-editor"]`;
const EDITOR_CONTENT = `${EDITOR} .cm-content`;
const DIFF_BODY = `${NOTES_ROW} [data-slot="tug-changes-list-file-diff"]`;

const SEEDED = "# Tug 0.0.0\n\nscratch\n";
const TYPED = "edited in the shade";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  mkdirSync(join(PROJECT_DIR, "release-notes"), { recursive: true });
  writeFileSync(notesPath, SEEDED);
  writeFileSync(otherPath, "at0617 not release notes\n");
});

afterAll(() => {
  rmSync(notesPath, { force: true });
  rmSync(otherPath, { force: true });
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1000, height: 760 },
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

describe.skipIf(!SHOULD_RUN)("AT0617: the notes editor mode in the shade", () => {
  test(
    "the pencil is scoped to release notes, and a keystroke in the row reaches disk",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0617-changes-notes-editor",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        // After launch, not before: tugcast demotes every `live` row to
        // `closed` once at startup, so a pre-launch seed would be swept and
        // both files would surface as `orphaned` instead of as this session's.
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0617 work",
            },
          ],
          file_events: [NOTES_FILE, OTHER_FILE].map((relative, index) => ({
            tug_session_id: SID,
            tool_use_id: `at0617-tu-${index + 1}`,
            file_path: join(PROJECT_DIR, relative),
            tool_name: "Write",
            op: "created",
            // Proof class: a `bash` row is a bracket hint and never makes an
            // owner, so the files would fall to unattributed instead.
            origin: "exact",
            ambiguous: false,
            project_dir: PROJECT_DIR,
            at: Date.now(),
          })),
        });
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // One committed turn so the card is a live, non-empty session.
        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: {
            tug_session_id: SID,
            type: "turn_complete",
            msg_id: "m1",
            result: "success",
          },
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes shade ───────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── Both files compose as SESSION-entry rows ───────────────────────
        // The pencil is wired only for the session entry, so an unattributed
        // row would render none and every assertion below would be vacuous.
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(NOTES_ROW)}) !== null` +
              ` && document.querySelector(${JSON.stringify(OTHER_ROW)}) !== null`,
            { timeoutMs: 30000 },
          );
        } catch (err) {
          note(
            "at0617 shade contents when the session rows did not appear",
            await app.evalJS<unknown>(
              `(() => {
                 const sheet = document.querySelector(${JSON.stringify(SHEET)});
                 if (sheet === null) return "no sheet";
                 return {
                   entryKinds: Array.from(
                     sheet.querySelectorAll("[data-entry-kind]"),
                   ).map((el) => el.getAttribute("data-entry-kind")),
                   paths: Array.from(
                     sheet.querySelectorAll("[data-testid=\\"tug-changes-list-file-block\\"]"),
                   ).map((el) => el.getAttribute("data-path")).slice(0, 25),
                 };
               })()`,
            ),
          );
          throw err;
        }

        // ── The scope: notes get a pencil, the .txt beside them does not ───
        const pencils = await app.evalJS<{ notes: number; other: number }>(
          `({
             notes: document.querySelectorAll(${JSON.stringify(NOTES_PENCIL)}).length,
             other: document.querySelectorAll(
               ${JSON.stringify(`${OTHER_ROW} [data-testid="tug-changes-list-edit"]`)},
             ).length,
           })`,
        );
        note("at0617 pencils per row", pencils);
        expect(pencils).toEqual({ notes: 1, other: 0 });

        // ── Pressing it mounts a real editor over the real file ────────────
        // Retried against the editor's own presence: an aggregate recompute can
        // re-render the list between finding the pencil and hitting it.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const mounted = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
          );
          if (mounted) break;
          await app.nativeClickAtElement(NOTES_PENCIL);
          await settle(500);
        }
        await app.waitForCondition<boolean>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
             return el !== null && el.textContent.includes("scratch");
           })()`,
          { timeoutMs: 20000 },
        );
        // The mode takes the body in the diff's place — both at once would be
        // the row saying two things about one file.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(DIFF_BODY)}) !== null` +
              ` && document.querySelector(${JSON.stringify(`${DIFF_BODY} [data-slot="diff-body"]`)}) === null`,
          ),
        ).toBe(true);

        // ── A keystroke here reaches the disk ─────────────────────────────
        // Through CM6's real input pipeline — `execCommand("insertText")` on
        // the focused contenteditable fires `beforeinput` exactly as a
        // keystroke does — which is the shape at0209 settled on for driving a
        // Text card editor. Native keys are deliberately not used: the Session
        // card forwards stray typing to its prompt entry, so a native `a` in
        // the shade lands in the composer no matter which element holds DOM
        // focus. What this test is about is the path from the editor's
        // document to the file, and that path is fully live either way.
        expect(
          await app.evalJS<boolean>(
            `(() => {
               const el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
               if (el === null) return false;
               el.focus();
               const range = document.createRange();
               range.selectNodeContents(el);
               range.collapse(false);
               const selection = window.getSelection();
               selection.removeAllRanges();
               selection.addRange(range);
               return document.execCommand(
                 "insertText",
                 false,
                 ${JSON.stringify(`\n${TYPED}`)},
               );
             })()`,
          ),
        ).toBe(true);
        // First that the keystrokes reached CM6 at all. Asserted separately
        // from the disk read on purpose: a caret that never landed in the
        // editor and a write that never happened are different defects, and a
        // single assertion on the file cannot tell them apart.
        try {
          await app.waitForCondition<boolean>(
            `(() => {
               const el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
               return el !== null && el.textContent.includes(${JSON.stringify(TYPED)});
             })()`,
            { timeoutMs: 10000 },
          );
        } catch (err) {
          note(
            "at0617 where the typing went instead",
            await app.evalJS<unknown>(
              `({
                 editor: document.querySelector(${JSON.stringify(EDITOR_CONTENT)})?.textContent ?? null,
                 prompt: document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? null,
                 active: document.activeElement?.className ?? null,
               })`,
            ),
          );
          throw err;
        }
        // Then the disk, which is the whole point of driving the real app.
        // Autosave debounces 1s and the write is a real round trip, so the
        // file is polled to a horizon rather than read once.
        let onDisk = "";
        for (let waited = 0; waited < 20_000; waited += 250) {
          onDisk = readFileSync(notesPath, "utf8");
          if (onDisk.includes(TYPED)) break;
          await settle(250);
        }
        note("at0617 the file after the autosave", JSON.stringify(onDisk));
        expect(onDisk).toContain(TYPED);
        expect(onDisk).toContain("scratch");
        // And only now the status line, which claims what the bytes have
        // already shown.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(
            `${EDITOR}[data-save-state="clean"]`,
          )}) !== null`,
          { timeoutMs: 10000 },
        );
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(
              `${EDITOR} [data-testid="session-changes-notes-editor-status"]`,
            )})?.textContent ?? null`,
          ),
        ).toBe("Saved");

        // ── Pressing it again gives the diff back ─────────────────────────
        await app.nativeClickAtElement(NOTES_PENCIL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
          { timeoutMs: 8000 },
        );
        // The row folds shut with the mode, so re-expanding it is what shows
        // the diff is what comes back.
        await app.nativeClickAtElement(
          `${NOTES_ROW} [data-slot="tug-changes-list-fold"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIFF_BODY)}) !== null` +
            ` && document.querySelector(${JSON.stringify(EDITOR)}) === null`,
          { timeoutMs: 20000 },
        );
        note("at0617 the diff came back after leaving editor mode", NOTES_FILE);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
