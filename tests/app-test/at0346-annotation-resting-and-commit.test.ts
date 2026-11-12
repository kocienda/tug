/**
 * at0346-annotation-resting-and-commit.test.ts — the second half of [AT0346],
 * the ways the transcript treats an annotation as a thing rather than as text.
 * The first half (a file atom, a mention chip, a whole command) is
 * `at0346-annotation-atom-and-entity.test.ts`, whose header states the claim;
 * the file is split so neither half crosses the 20 s file budget.
 *
 *  4. **A mention says so at rest** — a run the resolver confirmed carries the
 *     resting rule whether it was backticked or bare, and an inline-code span
 *     the resolver refused carries none: code tone and actionability are
 *     separate channels, and only the second is the resolver's to speak for.
 *  5. **A commit is that same object too** — the newest kind to answer
 *     `atomSegmentFor`, and the one whose atom's value carries no repository,
 *     so the round trip has to resolve one from the card. A confirmed sha in
 *     prose offers the atom insert and the atom copy, mints a `commit` chip
 *     whose value is the sha, survives the real pasteboard, and comes back as
 *     a second chip. The bake and the live pill are read against each other in
 *     the same frame, because "one mark everywhere" is a claim about two
 *     renderers and only a measurement can hold it.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/lib/annotator/atom-segment.ts
 * @covers tugdeck/src/lib/annotator/payloads.ts
 * @covers tugdeck/src/lib/annotator/annotation-element.ts
 * @covers tugdeck/src/lib/commit-format.ts
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/styles/tug-annotation.css
 * @covers tugdeck/styles/tugx-md.css
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/entity-menu-items.ts
 * @covers tugdeck/src/lib/copy-clipboard.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 * @covers tugdeck/src/lib/entity-selection-paint.ts
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 * @covers tugdeck/src/lib/code-session-store.ts
 * @family at0346-annotation
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import {
  CODE_OUTPUT_FEED,
  COMMIT_LABEL,
  HEAD_SHA,
  PROMPT_INPUT,
  REPO_ROOT,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  WRITTEN_SHA,
  asstText,
  menuItemPointJS,
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
        app.body("A").evalJS<string>(`JSON.stringify((function(){
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
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
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
        const plainIsTheIdentifier = await app.body("A").evalJS<boolean>(
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
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL)}) !== null`,
          { timeoutMs: 15_000 },
        );
        // The prose spelled ten characters; the mark shows the label's eight,
        // with the word the pill supplies.
        const shown = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(PILL)}).textContent || "").trim()`,
        );
        note(`at0346 commit pill: ${shown}`);
        expect(shown).toBe(COMMIT_LABEL);

        // --- the insert mints a commit chip ----------------------------
        await app.body("A").evalJS<boolean>(revealJS(SPAN));
        await rightClickPastGate(app, SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="insert-into-prompt"]') !== null`,
          { timeoutMs: 4000 },
        );
        // The label names what will arrive. Before a commit had an atom form
        // this said the plain word, and the menu was telling the truth.
        expect(
          await app.body("A").evalJS<string | null>(
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
          await app.body("A").evalJS<string>(
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

        const insertPoint = await app.body("A").evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("insert-into-prompt"),
        );
        expect(insertPoint).not.toBeNull();
        await app.body("A").nativeClick(insertPoint as { x: number; y: number });

        const CHIP = `${PROMPT_INPUT} img[data-atom-type="commit"]`;
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8000 },
        );
        const chip = JSON.parse(
          await app.body("A").evalJS<string>(
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
        const pillHeight = await app.body("A").evalJS<number>(
          `Math.round(document.querySelector(${JSON.stringify(PILL)}).getBoundingClientRect().height)`,
        );
        note(`at0346 bake ${chip.height}px vs pill ${pillHeight}px`);
        expect(chip.height).toBe(pillHeight);

        // --- and Copy as Atom puts that same object on the pasteboard ---
        await app.body("A").evalJS<boolean>(revealJS(SPAN));
        await rightClickPastGate(app, SPAN);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
          { timeoutMs: 4000 },
        );
        const copyPoint = await app.body("A").evalJS<{ x: number; y: number } | null>(
          menuItemPointJS("copy-annotation-atom"),
        );
        expect(copyPoint).not.toBeNull();
        await app.body("A").nativeClick(copyPoint as { x: number; y: number });

        // card-dom: shell — the pasteboard is the app's, and `readClipboardAtoms` is the shell's surface verb.
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
        await app.body("A").focusElement(PROMPT_INPUT);
        await app.body("A").evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(CHIP)}).length === 2`,
          { timeoutMs: 8000 },
        );

        // --- and submitting carries it on the wire ---------------------
        // The last leg: a chip is only a real atom if it survives the send.
        await app.body("A").evalJS<boolean>(
          `window.__tug.dispatchControlAction("submit-prompt", { cardId: "A" }), true`,
        );
        await app.body("A").waitForCondition<boolean>(
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
