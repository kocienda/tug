/**
 * at0477-transcript-copy-atoms.test.ts — the transcript row's COPY carries the
 * atoms, not the words they were flattened into.
 *
 * A submitted prompt is a substrate: text with a `U+FFFC` at each atom position
 * and a parallel array naming what stands there. The row's COPY used to write
 * only the flattened string, which lost the prompt twice over — the slash off a
 * command atom (the chip draws `/tugplug:dash`, the stored value is the bare
 * name), and every chip's identity, so a paste back into Tug arrived as prose.
 * Copying a prompt and pasting it back could not resubmit it.
 *
 * Three things, on the real pasteboard, through the real gesture:
 *
 *   A. **The `text/plain` flavor is what the user read.** Click the row's COPY
 *      and read `pbpaste` — the flavor any other app gets. A command atom must
 *      come back with its leading `/`, because that is the shape claude expands
 *      as a user invocation; a bare name is a word.
 *
 *   B. **The atom sidecar rode along.** Read the private
 *      `dev.tug.prompt-atoms` type back through the two functions the editor's
 *      paste handler calls (`readClipboardViaNative` → `parseClipboardSidecar`).
 *      `pbpaste` cannot see a private type, so this is the only way to assert
 *      the flavor was written at all.
 *
 *   C. **A paste back into the composer re-materializes the chips.** The end of
 *      the round trip, and the claim the whole thing is for: what the user
 *      submitted comes back submittable. The `paste` event is dispatched with
 *      an EMPTY `clipboardData` — the shape of the real gesture inside Tug.app,
 *      where everything the paste needs is on the pasteboard and none of it is
 *      in the event.
 *
 *   D. **And ⌘C gives the same clipboard.** The chord never enters the
 *      responder chain — AppKit performs Edit ▸ Copy on the web view — so a
 *      selection copied with the keyboard reaches the reconstruction only
 *      through the `copy` DOM event the row answers. One selection must not
 *      copy one way from the row's COPY and another way from the chord.
 *
 * The prompt is seeded through `driveSession`'s `send`, which is
 * `codeSessionStore.send(text, atoms)` — the production submit, the same call
 * the composer makes. The row under test is the one that paints from it.
 *
 * Foreground: the pasteboard write and the reads want a key window.
 *
 * @foreground
 *
 * @covers tugdeck/src/lib/atom-text.ts
 * @covers tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-z1b.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 * @covers tugdeck/src/lib/markdown/serialize-selection.ts
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "3c9b17ae-5d24-4f60-9b81-2ea7c4d0f513";
const PROJECT_DIR = "/Users/tester/src/tugtool";

/** U+FFFC — the object-replacement char an atom occupies. */
const FFFC = "￼";

/** The command atom stores the BARE name; the slash belongs to the chip. */
const COMMAND = "tugplug:dash";
const BRIEF = ".tug/dashes/verify-surfaces/brief.md";
/** The prompt as submitted: two chips with a word between them. */
const PROMPT_TEXT = `${FFFC} on ${FFFC}`;
/** What the user read on screen — and must get back on the clipboard. */
const FLAT = `/${COMMAND} on ${BRIEF}`;

const SENTINEL = "at0477-sentinel-nothing-copied";

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const USER_COPY =
  `${CARD} [data-slot="session-z1b"][data-participant="user"]` +
  ` [data-slot="session-z1b-copy"]`;

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The composer's chips (type + value) and its flat text, in one read. */
function composerProbe(): string {
  return `(function(){
    var cm = document.querySelector(${JSON.stringify(COMPOSER)});
    return {
      atoms: Array.prototype.map.call(
        cm.querySelectorAll('img:not(.cm-widgetBuffer)'),
        function (img) {
          return (img.getAttribute("data-atom-type") || "")
            + ":" + (img.getAttribute("data-atom-value") || "");
        }),
      text: Array.prototype.map.call(cm.querySelectorAll('.cm-line'),
        function (l) { return l.textContent || ""; }).join(""),
    };
  })()`;
}

describe.skipIf(!SHOULD_RUN)("at0477 — a copied prompt keeps its atoms", () => {
  test(
    "COPY writes the drawn text plus the atom sidecar; a paste back rebuilds the chips",
    async () => {
      const app = await launchTugApp({
        testName: "at0477-transcript-copy-atoms",
        foreground: true,
      });
      try {
        // `isEngineReady` is a deck-trace probe — without the trace on, the
        // event it reads is never recorded.
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 20_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        // The production submit: text with its U+FFFC positions and the atoms
        // that stand there. The in-flight user row paints from it immediately —
        // a submission is complete the instant it posts, which is why the row
        // wears its OK badge and its COPY without waiting for a response.
        await app.driveSession("A", {
          op: "send",
          text: PROMPT_TEXT,
          atoms: [
            { kind: "atom", type: "command", label: COMMAND, value: COMMAND },
            { kind: "atom", type: "file", label: BRIEF, value: BRIEF },
          ],
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_BODY)}).length === 1`,
          { timeoutMs: 12_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(USER_COPY)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // ---- A. The flavor every other app gets. --------------------------
        setPasteboard(SENTINEL);
        await app.nativeClickAtElement(USER_COPY);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(USER_COPY)}) !== null`,
          { timeoutMs: 4_000 },
        );
        // The native write settles synchronously on the Swift side; give the
        // round trip a beat before reading the pasteboard back.
        await new Promise((r) => setTimeout(r, 400));
        const flat = readPasteboard();
        note("at0477 pasteboard text", JSON.stringify(flat));
        expect(flat).not.toBe(SENTINEL); // the copy happened at all
        // The command carries the slash it is drawn with — the shape claude
        // expands as a user invocation.
        expect(flat.trim()).toBe(FLAT);

        // ---- B. The sidecar rode along, typed. ----------------------------
        //
        // The read is async (the bridge calls back) and `evalJS` cannot return
        // a promise, so kick it off, park the result, and poll.
        await app.evalJS<null>(
          `(window.__at0477sidecar = undefined,
            window.__tug.readClipboardAtoms().then(function (r) {
              window.__at0477sidecar = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0477sidecar !== undefined`,
          { timeoutMs: 8_000 },
        );
        const sidecar = JSON.parse(
          await app.evalJS<string>(`window.__at0477sidecar`),
        ) as {
          text: string;
          atoms: Array<{ type: string; label: string; value: string }>;
        } | null;
        note("at0477 sidecar", JSON.stringify(sidecar));
        expect(sidecar).not.toBeNull();
        // The substrate itself, not the flattened text.
        expect(sidecar?.text).toBe(PROMPT_TEXT);
        expect(sidecar?.atoms.map((a) => a.type)).toEqual(["command", "file"]);
        expect(sidecar?.atoms.map((a) => a.value)).toEqual([COMMAND, BRIEF]);

        // ---- C. A paste back into the composer rebuilds the chips. --------
        await app.focusElement(COMPOSER);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 2`,
          { timeoutMs: 8_000 },
        );
        const pasted = await app.evalJS<{ atoms: string[]; text: string }>(
          composerProbe(),
        );
        note("at0477 composer after paste", JSON.stringify(pasted));
        expect(pasted.atoms).toEqual([`command:${COMMAND}`, `file:${BRIEF}`]);
        // The chips are chips — the words they would have flattened into are
        // nowhere in the composer's text.
        expect(pasted.text).not.toContain(COMMAND);
        expect(pasted.text).not.toContain(BRIEF);
        expect(pasted.text).toContain("on");

        // ---- D. The OTHER door: a selection and ⌘C. ----------------------
        //
        // ⌘C never enters the responder chain — AppKit performs Edit ▸ Copy on
        // the web view — so it reaches the same reconstruction only through the
        // `copy` DOM event the row answers. The two doors must produce one
        // clipboard: a chip is a chip whichever way the reader copied it.
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 0`,
          { timeoutMs: 8_000 },
        );
        setPasteboard(SENTINEL);
        await app.evalJS<null>(`(function(){
          var body = document.querySelector(${JSON.stringify(USER_BODY)});
          var range = document.createRange();
          range.selectNodeContents(body);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return null;
        })()`);
        await app.nativeKey("c", ["cmd"]);
        // The chord travels through AppKit before the web view answers it;
        // give the round trip a beat before reading the pasteboard back.
        await new Promise((r) => setTimeout(r, 600));
        const chordFlat = readPasteboard();
        note("at0477 chord pasteboard text", JSON.stringify(chordFlat));
        expect(chordFlat).not.toBe(SENTINEL);
        expect(chordFlat.trim()).toBe(FLAT);

        await app.evalJS<null>(
          `(window.__at0477chord = undefined,
            window.__tug.readClipboardAtoms().then(function (r) {
              window.__at0477chord = JSON.stringify(r);
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0477chord !== undefined`,
          { timeoutMs: 8_000 },
        );
        const chordSidecar = JSON.parse(
          await app.evalJS<string>(`window.__at0477chord`),
        ) as {
          text: string;
          atoms: Array<{ type: string; label: string; value: string }>;
        } | null;
        note("at0477 chord sidecar", JSON.stringify(chordSidecar));
        expect(chordSidecar).not.toBeNull();
        expect(chordSidecar?.text).toBe(PROMPT_TEXT);
        expect(chordSidecar?.atoms.map((a) => a.value)).toEqual([
          COMMAND,
          BRIEF,
        ]);

        // And it pastes back as chips, exactly as the button's copy did.
        await app.focusElement(COMPOSER);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 2`,
          { timeoutMs: 8_000 },
        );
        const chordPasted = await app.evalJS<{ atoms: string[]; text: string }>(
          composerProbe(),
        );
        note("at0477 composer after chord paste", JSON.stringify(chordPasted));
        expect(chordPasted.atoms).toEqual([`command:${COMMAND}`, `file:${BRIEF}`]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
