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
 * Cases 4 and 5 run in `at0346-annotation-resting-and-commit.test.ts`, so
 * neither file crosses the 20 s file budget.
 *
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
 * @family at0346-annotation
 */


import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import {
  ARG,
  CODE_OUTPUT_FEED,
  FILE_NAME,
  KNOWN_CMD,
  PROMPT_INPUT,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  UNKNOWN_CMD,
  asstText,
  capabilities,
  menuItemPointJS,
  projectDir,
  realPath,
  replayComplete,
  replayStarted,
  revealJS,
  rightClickPastGate,
  turnDone,
  installAnnotationProject,
  userMsg,
} from "./annotation-atom-fixture";

installAnnotationProject();

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
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
          { timeoutMs: 12_000 },
        );
        const stampedPath = await app.body("A").evalJS<string | null>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SPAN)});
            return el === null ? null : el.getAttribute('data-path');
          })()`,
        );
        expect(stampedPath?.startsWith("/")).toBe(true);
        expect(stampedPath?.endsWith(`/${FILE_NAME}`)).toBe(true);

        // --- one insert item, and it mints the chip --------------------
        await app.body("A").evalJS<boolean>(revealJS(SPAN));
        await rightClickPastGate(app, SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        // Exactly one — a file's way into the prompt is the chip, and the
        // path as characters is what Copy Path is for.
        const insertItems = await app.body("A").evalJS<number>(
          `document.querySelectorAll('[data-item-action="insert-into-prompt"]').length`,
        );
        expect(insertItems).toBe(1);
        // And the click that opened this menu selected the whole path, not
        // the sub-word WebKit picks out of it — the menu names the file, so
        // the highlight under it names the file too.
        const spanText = await app.body("A").evalJS<string>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SPAN)});
            return el === null ? "" : (el.textContent || "");
          })()`,
        );
        const pathSelection = await app.body("A").evalJS<string>(
          `(function(){
            var sel = window.getSelection();
            return sel === null ? "" : sel.toString();
          })()`,
        );
        expect(spanText.length).toBeGreaterThan(0);
        expect(pathSelection).toBe(spanText);
        const insertLabel = await app.body("A").evalJS<string | null>(
          `(function(){
            var el = document.querySelector('[data-item-action="insert-into-prompt"]');
            return el === null ? null : (el.textContent || '').trim();
          })()`,
        );
        // The label names what will arrive. A file's insert mints an atom,
        // so it says so; a command's does not, which at0225 asserts.
        expect(insertLabel).toBe("Insert Atom into Prompt");

        const itemPoint = await app.body("A").evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("insert-into-prompt"),
        );
        expect(itemPoint).not.toBeNull();
        await app.body("A").nativeClick(itemPoint as { x: number; y: number });

        // The prompt carries a file chip whose value is the canonical
        // path — an object, not the path spelled out.
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (cm === null) return false;
            return cm.querySelector('img[data-atom-type="file"]') !== null;
          })()`,
          { timeoutMs: 8000 },
        );
        const chip = JSON.parse(
          await app.body("A").evalJS<string>(
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

        const literal = await app.body("A").evalJS<boolean>(
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
        await app.body("A").evalJS<boolean>(revealJS(SPAN));
        await rightClickPastGate(app, SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
          { timeoutMs: 4000 },
        );
        const copyLabel = await app.body("A").evalJS<string | null>(
          `(function(){
            var el = document.querySelector('[data-item-action="copy-annotation-atom"]');
            return el === null ? null : (el.textContent || '').trim();
          })()`,
        );
        // `Copy as <Format>` — a different serialization of one entity,
        // which is what an atom is beside the path Copy Path writes.
        expect(copyLabel).toBe("Copy as Atom");
        const copyPoint = await app.body("A").evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("copy-annotation-atom"),
        );
        expect(copyPoint).not.toBeNull();
        await app.body("A").nativeClick(copyPoint as { x: number; y: number });

        // The sidecar reached the REAL pasteboard, on the private
        // `dev.tugapp.prompt-atoms` type — read back through the same two
        // functions the paste handler calls, since `pbpaste` cannot see a
        // private type and no other route can assert the flavor was written.
        // The read is async (the native bridge calls back) and `evalJS`
        // cannot return a promise, so kick it off, park it, and poll.
        // card-dom: shell — the pasteboard is the app's, and `readClipboardAtoms` is the shell's surface verb.
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
        await app.body("A").focusElement(PROMPT_INPUT);
        await app.body("A").evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);

        // Two chips now: the one the insert minted and the one the paste
        // rebuilt from the sidecar. Both name the same file.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img[data-atom-type="file"]').length === 2`,
          { timeoutMs: 8000 },
        );
        const pastedValues = JSON.parse(
          await app.body("A").evalJS<string>(
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
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_HOST)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // The chip names a file, so it wears the file annotation — carrying
        // the address the relative value never had on its own.
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_HOST)});
            return el !== null && el.getAttribute('data-tug-annotation') === 'file-path';
          })()`,
          { timeoutMs: 8000 },
        );
        const stampedPath = await app.body("A").evalJS<string | null>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_HOST)});
            return el === null ? null : el.getAttribute('data-path');
          })()`,
        );
        note(`mention chip resolved to: ${stampedPath ?? "(none)"}`);
        expect(stampedPath).toBe(realPath);

        // And the menu is the file's own — the same four items a path in
        // prose offers, over the standard editing block.
        await app.body("A").evalJS<boolean>(revealJS(CHIP_HOST));
        await rightClickPastGate(app, CHIP_HOST);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        const labels = JSON.parse(
          await app.body("A").evalJS<string>(
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
      // The selection and the menu are the card's body's.
      const selectionText = () =>
        app.body("A").evalJS<string>(
          `(function(){
            var sel = window.getSelection();
            return sel === null ? "" : sel.toString();
          })()`,
        );
      const clearSelection = () =>
        app.body("A").evalJS<boolean>(
          `(function(){
            var sel = window.getSelection();
            if (sel !== null) sel.removeAllRanges();
            return true;
          })()`,
        );

      try {
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CMD_SPAN)}) !== null`,
          { timeoutMs: 12_000 },
        );

        // --- the control: an inline-code span with no registry entry ---
        const PLAIN_SPAN = `[data-card-id="A"] .session-card-transcript-code-body code:not(.tugx-annotation)`;
        const plainIsTheUnknownCommand = await app.body("A").evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PLAIN_SPAN)});
            return el !== null && (el.textContent || '').indexOf(${JSON.stringify(
              UNKNOWN_CMD,
            )}) !== -1;
          })()`,
        );
        expect(plainIsTheUnknownCommand).toBe(true);

        await clearSelection();
        await app.body("A").evalJS<boolean>(revealJS(PLAIN_SPAN));
        await rightClickPastGate(app, PLAIN_SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy"]') !== null`,
          { timeoutMs: 4000 },
        );
        // WebKit's smart-select ran: the click painted a word inside the
        // span. This is the behavior the command case must NOT show.
        expect((await selectionText()).length).toBeGreaterThan(0);
        await app.nativeKey("Escape");
        // The second gesture waits for the first menu to be gone: a
        // right-click that lands while it is still dismissing opens nothing.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy"]') === null`,
          { timeoutMs: 4000 },
        );

        // --- the command: one entity, so the whole of it is taken -------
        await clearSelection();
        await app.body("A").evalJS<boolean>(revealJS(CMD_SPAN));
        await rightClickPastGate(app, CMD_SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-command"]') !== null`,
          { timeoutMs: 4000 },
        );
        // Not the sub-word WebKit picked out of it: the entire span, which
        // is the thing every item in this menu acts on.
        const commandText = await app.body("A").evalJS<string>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CMD_SPAN)});
            return el === null ? "" : (el.textContent || "");
          })()`,
        );
        expect(commandText.length).toBeGreaterThan(0);
        expect(await selectionText()).toBe(commandText);
        // And the menu is the command's own — no selection-scoped Copy
        // beside Copy Command to say the same thing twice.
        const standardCopy = await app.body("A").evalJS<boolean>(
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

});
