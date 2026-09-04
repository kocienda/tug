/**
 * at0346-annotation-atom-and-entity.test.ts — the ways the transcript's
 * right-click treats an annotation as a thing rather than as text.
 *
 * Every case is the same claim from a different side. An annotation is
 * an object the transcript mentions; a secondary click on it should offer
 * object-shaped acts and should not narrow it to whatever run of characters
 * the browser thinks a word is.
 *
 *  1. **A file inserts as an atom, and copies as one** — a verified file path
 *     offers exactly one way into the prompt, and the label says what will
 *     arrive: Insert Atom into Prompt mints the chip an `@` mention does,
 *     carrying the canonical path as its value rather than as a run of path
 *     characters. Beside it, Copy as Atom puts that same object on the
 *     clipboard, so a paste into the prompt returns a chip rather than the
 *     characters — the round trip through the pasteboard, which no unit test
 *     can reach. The assertions are that the menu offers one insert item and
 *     not two, both labels, the chips' own `data-atom-value`, and that the
 *     path never landed as literal text.
 *  2. **A mention chip is that same object** — an `@` mention's value is
 *     relative (that is what the file index reports), and a chip carrying
 *     one used to name nothing a menu could act on: the right-click offered
 *     the bare editing block. Resolved against the card's project it is the
 *     same file the same path in prose is, and offers the same four items.
 *  3. **A command is one entity** — right-clicking a command span selects the
 *     whole span, not a word inside it. The control is the span beside it: an
 *     inline-code span the annotator marked nothing on, where WebKit's
 *     smart-select still runs and paints a sub-word. Same DOM shape, same
 *     gesture, different verdict — which is what proves the whole-entity
 *     selection is the annotation's doing and not the surface selecting
 *     everything it is clicked on.
 *  4. **A mention says so at rest** — the same claim seen from the surface
 *     rather than from the menu. A run the resolver confirmed carries the
 *     resting rule whether it was backticked or bare, and an inline-code
 *     span the resolver refused carries none: code tone and actionability
 *     are separate channels, and only the second is the resolver's to speak
 *     for.
 *  5. **A commit is that same object too** — the newest kind to answer
 *     {@link atomSegmentFor}, and the one whose atom's value carries no
 *     repository, so the round trip has to resolve one from the card. A
 *     confirmed sha in prose offers the atom insert and the atom copy, mints a
 *     `commit` chip whose value is the sha, survives the real pasteboard, and
 *     comes back as a second chip. The bake and the live pill are read against
 *     each other in the same frame, because "one mark everywhere" is a claim
 *     about two renderers and only a measurement can hold it.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/lib/annotator/atom-segment.ts
 * @covers tugdeck/src/lib/session-atom.ts
 * @covers tugdeck/src/lib/annotator/payloads.ts
 * @covers tugdeck/src/lib/atom-file-path.ts
 * @covers tugdeck/src/lib/command-atom.ts
 * @covers tugdeck/src/lib/commit-format.ts
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/styles/tug-annotation.css
 * @covers tugdeck/src/components/tugways/tug-markdown-view.css
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/entity-menu-items.ts
 * @covers tugdeck/src/lib/copy-clipboard.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 * @covers tugdeck/src/lib/annotator/annotation-element.ts
 * @covers tugdeck/src/lib/entity-selection-paint.ts
 * @covers tugdeck/src/components/tugways/use-text-surface-context-menu.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/code-session-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const FILE_NAME = "notes.md";
const FILE_BODY = ["alpha", "bravo", "charlie"].join("\n");

const KNOWN_CMD = "tugplug:implement";
const ARG = "arc/find-route.md";
const UNKNOWN_CMD = "definitely-not-a-command";

/** This repository — a real git repo whose HEAD the app's git feed confirms. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();
/** The short form prose uses — deliberately longer than the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 10);
/** What every commit surface, and the atom's plain flavor, spell. */
const COMMIT_LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

let projectDir = "";
let realPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0346-annotation-"));
  realPath = join(projectDir, FILE_NAME);
  writeFileSync(realPath, FILE_BODY, "utf8");
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
        size: { width: 900, height: 640 },
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

function capabilities(commands: string[]) {
  return {
    type: "session_capabilities",
    models: [{ value: "default", displayName: "Default" }],
    commands,
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort: null,
    ipc_version: 2,
  };
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/** Center a span in the scroller before a native click reaches for it. */
const revealJS = (selector: string) =>
  `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  })()`;

/** The viewport point of a menu item, or `null` when it is not open. */
const menuItemPointJS = (action: string) =>
  `(function(){
    var item = document.querySelector('[data-item-action=${action}]');
    if (item === null) return null;
    var r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;

describe.skipIf(!SHOULD_RUN)("AT0346: annotations as objects", () => {
  test(
    "a file inserts into the prompt as an atom, not as its path text",
    async () => {
      const app = await launchTugApp({
        testName: "at0346-annotation-atom",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

        await ingest(replayStarted());
        await ingest(userMsg("where is it"));
        await ingest(asstText("m1", `It is at \`${realPath}\`.`, 1));
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        // The path is inert until the filesystem confirms it.
        const SPAN = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
          { timeoutMs: 12_000 },
        );
        const stampedPath = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SPAN)});
            return el === null ? null : el.getAttribute('data-path');
          })()`,
        );
        expect(stampedPath?.startsWith("/")).toBe(true);
        expect(stampedPath?.endsWith(`/${FILE_NAME}`)).toBe(true);

        // --- one insert item, and it mints the chip --------------------
        await app.evalJS<boolean>(revealJS(SPAN));
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        // Exactly one — a file's way into the prompt is the chip, and the
        // path as characters is what Copy Path is for.
        const insertItems = await app.evalJS<number>(
          `document.querySelectorAll('[data-item-action="insert-into-prompt"]').length`,
        );
        expect(insertItems).toBe(1);
        // And the click that opened this menu selected the whole path, not
        // the sub-word WebKit picks out of it — the menu names the file, so
        // the highlight under it names the file too.
        const spanText = await app.evalJS<string>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SPAN)});
            return el === null ? "" : (el.textContent || "");
          })()`,
        );
        const pathSelection = await app.evalJS<string>(
          `(function(){
            var sel = window.getSelection();
            return sel === null ? "" : sel.toString();
          })()`,
        );
        expect(spanText.length).toBeGreaterThan(0);
        expect(pathSelection).toBe(spanText);
        const insertLabel = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector('[data-item-action="insert-into-prompt"]');
            return el === null ? null : (el.textContent || '').trim();
          })()`,
        );
        // The label names what will arrive. A file's insert mints an atom,
        // so it says so; a command's does not, which at0225 asserts.
        expect(insertLabel).toBe("Insert Atom into Prompt");

        const itemPoint = await app.evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("insert-into-prompt"),
        );
        expect(itemPoint).not.toBeNull();
        await app.nativeClick(itemPoint as { x: number; y: number });

        // The prompt carries a file chip whose value is the canonical
        // path — an object, not the path spelled out.
        await app.waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (cm === null) return false;
            return cm.querySelector('img[data-atom-type="file"]') !== null;
          })()`,
          { timeoutMs: 8000 },
        );
        const chip = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify((function(){
              var img = document.querySelector(${JSON.stringify(PROMPT_INPUT)} + ' img[data-atom-type="file"]');
              if (img === null) return {};
              return {
                value: img.getAttribute('data-atom-value'),
                label: img.getAttribute('data-atom-label'),
              };
            })())`,
          ),
        ) as { value?: string | null; label?: string | null };
        expect(chip.value).toBe(stampedPath);
        // The chip reads as the filename — a prompt line has no room for
        // an absolute path, and the whole path is right there in the value.
        expect(chip.label).toBe(FILE_NAME);

        const literal = await app.evalJS<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm !== null && (cm.textContent || '').indexOf(${JSON.stringify(
              FILE_NAME,
            )}) !== -1;
          })()`,
        );
        expect(literal).toBe(false);

        // --- and Copy as Atom puts that same object on the clipboard ----
        // The half a unit test cannot reach: the sidecar has to survive the
        // real pasteboard and come back through the paste side as a chip.
        await app.evalJS<boolean>(revealJS(SPAN));
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
          { timeoutMs: 4000 },
        );
        const copyLabel = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector('[data-item-action="copy-annotation-atom"]');
            return el === null ? null : (el.textContent || '').trim();
          })()`,
        );
        // `Copy as <Format>` — a different serialization of one entity,
        // which is what an atom is beside the path Copy Path writes.
        expect(copyLabel).toBe("Copy as Atom");
        const copyPoint = await app.evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("copy-annotation-atom"),
        );
        expect(copyPoint).not.toBeNull();
        await app.nativeClick(copyPoint as { x: number; y: number });

        // The sidecar reached the REAL pasteboard, on the private
        // `dev.tugapp.prompt-atoms` type — read back through the same two
        // functions the paste handler calls, since `pbpaste` cannot see a
        // private type and no other route can assert the flavor was written.
        // The read is async (the native bridge calls back) and `evalJS`
        // cannot return a promise, so kick it off, park it, and poll.
        await app.evalJS<null>(
          `(window.__at0346sidecar = undefined,
            window.__tug.readClipboardAtoms().then(function (r) {
              window.__at0346sidecar = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0346sidecar !== undefined`,
          { timeoutMs: 8_000 },
        );
        const onClipboard = await app.evalJS<string>(`window.__at0346sidecar`);
        note(`clipboard sidecar: ${onClipboard}`);
        expect(JSON.parse(onClipboard)).toEqual({
          // U+FFFC, the object-replacement char an atom occupies.
          text: "￼",
          atoms: [{ type: "file", label: FILE_NAME, value: stampedPath }],
        });

        // And the paste rebuilds the chip. An EMPTY `clipboardData` is the
        // shape of the real gesture — everything the paste needs is on the
        // pasteboard and none of it is in the event, because WebKit hides a
        // private type from the DOM event. The editor reads the bridge, which
        // is the route a real ⌘V takes. Same driver as at0474.
        await app.focusElement(PROMPT_INPUT);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);

        // Two chips now: the one the insert minted and the one the paste
        // rebuilt from the sidecar. Both name the same file.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img[data-atom-type="file"]').length === 2`,
          { timeoutMs: 8000 },
        );
        const pastedValues = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.prototype.map.call(
              document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img[data-atom-type="file"]'),
              function(el){ return el.getAttribute('data-atom-value'); },
            ))`,
          ),
        ) as string[];
        note(`prompt chips after paste: ${pastedValues.join(" / ")}`);
        expect(pastedValues).toEqual([stampedPath as string, stampedPath as string]);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0346] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mention chip offers the file's own menu, resolved against the project",
    async () => {
      const app = await launchTugApp({
        testName: "at0346-annotation-mention-chip",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // The card's project IS the temp project — the root the file index
        // counts from, and so the root the mention's value counts from.
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
        });
        await app.ingestSessionMetadata("A", {
          type: "system_metadata",
          cwd: projectDir,
          ipc_version: 2,
        });

        // The wire form of an `@` mention: the value wrapped as a
        // backtick-`@` marker, which the synthesizer re-mints as the chip.
        // Its value is RELATIVE — that is what `@`-completion carries, and
        // the case a chip with an absolute value never exercises.
        await ingest(replayStarted());
        await ingest(userMsg("read `@" + FILE_NAME + "` please"));
        await ingest(asstText("m1", "Reading it now.", 1));
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        const CHIP_HOST =
          `[data-card-id="A"] [data-slot="tug-atom-markdown-body"] .tug-atom-chip-host`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_HOST)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // The chip names a file, so it wears the file annotation — carrying
        // the address the relative value never had on its own.
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_HOST)});
            return el !== null && el.getAttribute('data-tug-annotation') === 'file-path';
          })()`,
          { timeoutMs: 8000 },
        );
        const stampedPath = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_HOST)});
            return el === null ? null : el.getAttribute('data-path');
          })()`,
        );
        note(`mention chip resolved to: ${stampedPath ?? "(none)"}`);
        expect(stampedPath).toBe(realPath);

        // And the menu is the file's own — the same four items a path in
        // prose offers, over the standard editing block.
        await app.evalJS<boolean>(revealJS(CHIP_HOST));
        await app.nativeRightClickAtElement(CHIP_HOST);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        const labels = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.prototype.map.call(
              document.querySelectorAll('[data-item-action]'),
              function(el){ return (el.textContent || '').trim(); },
            ))`,
          ),
        ) as string[];
        note(`mention chip menu: ${labels.join(" / ")}`);
        expect(labels).toContain("Open in Editor");
        expect(labels).toContain("Show in Finder");
        expect(labels).toContain("Copy Path");
        expect(labels).toContain("Copy as Atom");
        expect(labels).toContain("Insert Atom into Prompt");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0346] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "right-clicking a command selects the whole command, where plain code still smart-selects",
    async () => {
      const app = await launchTugApp({
        testName: "at0346-annotation-whole-entity",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });
      const selectionText = () =>
        app.evalJS<string>(
          `(function(){
            var sel = window.getSelection();
            return sel === null ? "" : sel.toString();
          })()`,
        );
      const clearSelection = () =>
        app.evalJS<boolean>(
          `(function(){
            var sel = window.getSelection();
            if (sel !== null) sel.removeAllRanges();
            return true;
          })()`,
        );

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });
        await app.ingestSessionMetadata("A", capabilities([KNOWN_CMD]));

        await ingest(replayStarted());
        await ingest(userMsg("go"));
        await ingest(
          asstText(
            "m1",
            `Ready: \`/${KNOWN_CMD} ${ARG}\` — not \`/${UNKNOWN_CMD}\`.`,
            1,
          ),
        );
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        const CMD_SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${KNOWN_CMD}"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CMD_SPAN)}) !== null`,
          { timeoutMs: 12_000 },
        );

        // --- the control: an inline-code span with no registry entry ---
        const PLAIN_SPAN = `[data-card-id="A"] .session-card-transcript-code-body code:not(.tugx-annotation)`;
        const plainIsTheUnknownCommand = await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PLAIN_SPAN)});
            return el !== null && (el.textContent || '').indexOf(${JSON.stringify(
              UNKNOWN_CMD,
            )}) !== -1;
          })()`,
        );
        expect(plainIsTheUnknownCommand).toBe(true);

        await clearSelection();
        await app.evalJS<boolean>(revealJS(PLAIN_SPAN));
        await app.nativeRightClickAtElement(PLAIN_SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy"]') !== null`,
          { timeoutMs: 4000 },
        );
        // WebKit's smart-select ran: the click painted a word inside the
        // span. This is the behavior the command case must NOT show.
        expect((await selectionText()).length).toBeGreaterThan(0);
        await app.nativeKey("Escape");

        // --- the command: one entity, so the whole of it is taken -------
        await clearSelection();
        await app.evalJS<boolean>(revealJS(CMD_SPAN));
        await app.nativeRightClickAtElement(CMD_SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-command"]') !== null`,
          { timeoutMs: 4000 },
        );
        // Not the sub-word WebKit picked out of it: the entire span, which
        // is the thing every item in this menu acts on.
        const commandText = await app.evalJS<string>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CMD_SPAN)});
            return el === null ? "" : (el.textContent || "");
          })()`,
        );
        expect(commandText.length).toBeGreaterThan(0);
        expect(await selectionText()).toBe(commandText);
        // And the menu is the command's own — no selection-scoped Copy
        // beside Copy Command to say the same thing twice.
        const standardCopy = await app.evalJS<boolean>(
          `document.querySelector('[data-item-action="copy"]') !== null`,
        );
        expect(standardCopy).toBe(false);
        await app.nativeKey("Escape");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0346] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a confirmed mention rules itself at rest; an unresolved code span does not",
    async () => {
      const app = await launchTugApp({
        testName: "at0346-annotation-resting-rule",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });
      // Read the un-animated longhands. A colour read mid-transition comes
      // back as an interpolated `oklab(...)`, and the rule's colour is
      // `currentColor`-derived by construction anyway — the falsifiable
      // claim is that the line is there, not what hue it is.
      const decoration = (selector: string) =>
        app.evalJS<string>(`JSON.stringify((function(){
          var el = document.querySelector(${JSON.stringify(selector)});
          if (el === null) return null;
          var s = getComputedStyle(el);
          return {
            line: s.textDecorationLine,
            thickness: s.textDecorationThickness,
            style: s.textDecorationStyle,
          };
        })())`);

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

        // One sentence carrying all three cases: the same real file
        // backticked and bare, plus an identifier in backticks that names
        // nothing. An absolute path needs no project binding — `fs/stat`
        // answers it.
        await ingest(replayStarted());
        await ingest(userMsg("where is it"));
        await ingest(
          asstText(
            "m1",
            `It is at \`${realPath}\`, or ${realPath} — see \`AnnotationContext\`.`,
            1,
          ),
        );
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        const CODE_MARK = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
        const RUN_MARK = `[data-card-id="A"] span[data-tugx-wrapped][data-tug-annotation="file-path"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CODE_MARK)}) !== null && document.querySelector(${JSON.stringify(RUN_MARK)}) !== null`,
          { timeoutMs: 12_000 },
        );

        // Backticked and bare wear the same rule — the whole point of one
        // gate is that the two look alike once the resolver agrees.
        const codeRule = JSON.parse(await decoration(CODE_MARK)) as {
          line: string;
          thickness: string;
          style: string;
        };
        const runRule = JSON.parse(await decoration(RUN_MARK)) as {
          line: string;
          thickness: string;
          style: string;
        };
        note("backticked mention", codeRule);
        note("bare mention", runRule);
        expect(codeRule.line).toBe("underline");
        expect(runRule.line).toBe("underline");
        expect(codeRule.thickness).toBe("1px");
        expect(runRule.thickness).toBe("1px");
        expect(codeRule.style).toBe("solid");
        expect(runRule.style).toBe("solid");

        // The control: an inline-code span the resolver refused carries no
        // annotation, so it matches no rule and looks exactly as it always
        // has. Code tone and the rule are separate channels.
        const PLAIN = `[data-card-id="A"] .session-card-transcript-code-body code:not([data-tug-annotation])`;
        const plainIsTheIdentifier = await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PLAIN)});
            return el !== null && (el.textContent || '') === 'AnnotationContext';
          })()`,
        );
        expect(plainIsTheIdentifier).toBe(true);
        const plainRule = JSON.parse(await decoration(PLAIN)) as {
          line: string;
        };
        note("unresolved code span", plainRule);
        expect(plainRule.line).toBe("none");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0346] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit inserts and copies as an atom, and the bake matches the pill",
    async () => {
      const app = await launchTugApp({ testName: "at0346-commit-atom" });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // The binding is what gives the annotator a commit root — this
        // repository, where the sha resolves — and it is also the root the
        // pasted atom resolves back through.
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: REPO_ROOT,
          sessionMode: "resume",
        });

        await ingest(replayStarted());
        await ingest(userMsg("which commit"));
        await ingest(asstText("m1", `It landed as \`${WRITTEN_SHA}\`.`, 1));
        await ingest(turnDone("m1"));
        await ingest(replayComplete());

        // The run is inert until the repository confirms the sha, and the
        // pill is what the portal mounts once it does.
        const SPAN = `[data-card-id="A"] [data-tug-annotation="commit-sha"]`;
        const PILL = `${SPAN} [data-slot="tug-commit-atom"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL)}) !== null`,
          { timeoutMs: 15_000 },
        );
        // The prose spelled ten characters; the mark shows the label's eight,
        // with the word the pill supplies.
        const shown = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PILL)}).textContent || "").trim()`,
        );
        note(`at0346 commit pill: ${shown}`);
        expect(shown).toBe(COMMIT_LABEL);

        // --- the insert mints a commit chip ----------------------------
        await app.evalJS<boolean>(revealJS(SPAN));
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        // The label names what will arrive. Before a commit had an atom form
        // this said the plain word, and the menu was telling the truth.
        expect(
          await app.evalJS<string | null>(
            `(function(){
              var el = document.querySelector('[data-item-action="insert-into-prompt"]');
              return el === null ? null : (el.textContent || '').trim();
            })()`,
          ),
        ).toBe("Insert Atom into Prompt");

        // The whole PILL wears the selection, not just the label inside it.
        // A text highlight reaches the runs it covers and stops, so the box
        // — node, gap, padding, border — paints itself from the settle's
        // `data-tug-entity-selected` or the mark reads as a fragment of
        // itself under a menu about the whole commit.
        const selectedFace = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify((function(){
              var span = document.querySelector(${JSON.stringify(SPAN)});
              var pill = document.querySelector(${JSON.stringify(PILL)});
              if (span === null || pill === null) return {};
              return {
                marked: span.hasAttribute('data-tug-entity-selected'),
                fill: getComputedStyle(pill).backgroundColor,
              };
            })())`,
          ),
        ) as { marked?: boolean; fill?: string };
        note(`at0346 selected pill: ${JSON.stringify(selectedFace)}`);
        expect(selectedFace.marked).toBe(true);
        // At rest the pill is transparent; selected it carries the same fill
        // the native highlight paints its label with.
        expect(selectedFace.fill).not.toBe("rgba(0, 0, 0, 0)");
        expect(selectedFace.fill).not.toBe("transparent");

        const insertPoint = await app.evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("insert-into-prompt"),
        );
        expect(insertPoint).not.toBeNull();
        await app.nativeClick(insertPoint as { x: number; y: number });

        const CHIP = `${PROMPT_INPUT} img[data-atom-type="commit"]`;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8000 },
        );
        const chip = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify((function(){
              var img = document.querySelector(${JSON.stringify(CHIP)});
              if (img === null) return {};
              return {
                value: img.getAttribute('data-atom-value'),
                label: img.getAttribute('data-atom-label'),
                alt: img.getAttribute('alt'),
                height: Math.round(img.getBoundingClientRect().height),
              };
            })())`,
          ),
        ) as { value?: string; label?: string; alt?: string; height?: number };
        note(`at0346 commit chip: ${JSON.stringify(chip)}`);
        // The chip carries the SHA as the prose spelled it — an object, not a
        // run of hex characters — and reads as the label every surface shows.
        expect(chip.value).toBe(WRITTEN_SHA);
        expect(chip.label).toBe(COMMIT_LABEL);
        expect(chip.alt).toBe(COMMIT_LABEL);

        // The bake and the live pill are ONE PICTURE. Both boxes measured in
        // the same frame: the pill is the CSS renderer reading the register
        // table as custom properties, the chip is the Canvas renderer reading
        // it as numbers, and the whole point of the table is that they cannot
        // answer differently.
        const pillHeight = await app.evalJS<number>(
          `Math.round(document.querySelector(${JSON.stringify(PILL)}).getBoundingClientRect().height)`,
        );
        note(`at0346 bake ${chip.height}px vs pill ${pillHeight}px`);
        expect(chip.height).toBe(pillHeight);

        // --- and Copy as Atom puts that same object on the pasteboard ---
        await app.evalJS<boolean>(revealJS(SPAN));
        await app.nativeRightClickAtElement(SPAN);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
          { timeoutMs: 4000 },
        );
        const copyPoint = await app.evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("copy-annotation-atom"),
        );
        expect(copyPoint).not.toBeNull();
        await app.nativeClick(copyPoint as { x: number; y: number });

        await app.evalJS<null>(
          `(window.__at0346commit = undefined,
            window.__tug.readClipboardAtoms().then(function (r) {
              window.__at0346commit = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0346commit !== undefined`,
          { timeoutMs: 8_000 },
        );
        const onClipboard = await app.evalJS<string>(`window.__at0346commit`);
        note(`at0346 commit sidecar: ${onClipboard}`);
        expect(JSON.parse(onClipboard)).toEqual({
          text: "￼",
          atoms: [
            { type: "commit", label: COMMIT_LABEL, value: WRITTEN_SHA },
          ],
        });

        // The paste rebuilds the chip from the sidecar, the same route a real
        // ⌘V takes — an empty `clipboardData`, because WebKit hides a private
        // type from the DOM event.
        await app.focusElement(PROMPT_INPUT);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(CHIP)}).length === 2`,
          { timeoutMs: 8000 },
        );

        // --- and submitting carries it on the wire ---------------------
        // The last leg: a chip is only a real atom if it survives the send.
        await app.evalJS<boolean>(
          `window.__tug.dispatchControlAction("submit-prompt", { cardId: "A" }), true`,
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector('[data-card-id="A"]').textContent || "").indexOf(${JSON.stringify(
            HEAD_SHA.slice(0, 8),
          )}) !== -1`,
          { timeoutMs: 10_000 },
        );

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0346] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
