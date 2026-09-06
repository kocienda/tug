/**
 * at0527-jot-keeps-its-chips.test.ts — a chip pasted into a Jot is still a
 * chip, and a chip taken out of a Jot arrives as one.
 *
 * The Jots card is the one editing surface in Tug that outlives the app. Every
 * other field that holds atoms holds them for as long as somebody is looking
 * at it; a jot is written to `jots.json` and read back tomorrow. So it is the
 * surface where losing the atoms is permanent rather than annoying, and it is
 * the one the report came through: a file chip pasted into a jot drew
 * correctly, and came back after a reopen as a bare `U+FFFC` — a placeholder
 * with nothing left to say what had stood there.
 *
 * Two doors, one claim, and they are [B11](b) and [B11](d):
 *
 *   1. **A chip survives the jot.** Copy a verified file path out of a
 *      transcript as an atom, paste it into an open jot, and follow it through
 *      three levels of forgetting: the editor closes (the store), the card
 *      closes and reopens (the mount), and the app quits and is relaunched
 *      against the same isolated `jots.json` (the file). The chip has to be
 *      there at each one, with the same value.
 *   2. **A chip leaves the jot as a chip.** A jot seeded with a file atom is
 *      copied with the row's Copy, and the paste into the prompt entry
 *      produces a chip rather than the words the path would have flattened
 *      into — while the `text/plain` flavor beside it IS those words, in the
 *      one [B03] spelling, because that is the flavor that leaves Tug.
 *
 * Together they prove no `U+FFFC` escapes unpaired: every assertion below
 * reads the atom's `data-atom-value` off a live chip or off the `atoms` list on
 * disk, and the placeholder character never appears anywhere a reader would
 * see it as a character.
 *
 * The file is written and read through the Rust model in `tugcast/src/jots.rs`
 * as well as the TypeScript one, which is why the on-disk assertion is here
 * rather than in a unit test: the two models have to agree about a field or it
 * is dropped on the next save with no sign.
 *
 * Runs against an isolated `TUG_JOTS_PATH` so the user's machine-global
 * `jots.json` is never touched.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/lib/jots-doc.ts
 * @covers tugdeck/src/lib/jots-store.ts
 * @covers tugdeck/src/components/tugways/tug-message-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/keymap.ts
 * @covers tugdeck/src/lib/atom-text.ts
 * @covers tugdeck/src/lib/atom-plain-text.ts
 * @covers tugrust/crates/tugcast/src/jots.rs
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "at0527-session";

/** U+FFFC, the object-replacement char an atom stands at. */
const OBJ = "￼";

const FILE_NAME = "knobs.ts";
const FILE_BODY = ["export const knobs = {", "  flash: 1500,", "};", ""].join("\n");

const JOTS_KBD = `.jots-card .jots-list[data-key-view-kbd]`;
const EDITOR = `.jots-list .jot-editor`;
const JOT_CONTENT = `${EDITOR} .cm-content`;
const JOT_CHIP = `${JOT_CONTENT} img[data-atom-type="file"]`;
const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

/** A sentinel so "the copy never happened" is distinguishable from a real one. */
const COPY_SENTINEL = "at0527-sentinel-nothing-copied";

interface JotsFile {
  jots: Array<{
    id: string;
    text: string;
    atoms?: Array<{ position: number; type: string; label: string; value: string }>;
  }>;
}

function sessionDeck() {
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

/** A deck with no session in it — the relaunch needs a card, not a project. */
function plainDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
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

/** The chips in a CM6 field, as `type:value` — the identity a copy reads. */
const chipsJS = (selector: string) =>
  `JSON.stringify(Array.prototype.map.call(
    document.querySelectorAll(${JSON.stringify(selector)} + ' img:not(.cm-widgetBuffer)'),
    function (img) {
      return (img.getAttribute("data-atom-type") || "")
        + ":" + (img.getAttribute("data-atom-value") || "");
    }))`;

/** The flat text of a CM6 field, lines joined — what a reader would see. */
const flatTextJS = (selector: string) =>
  `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(selector)} + ' .cm-line'),
     function (l) { return l.textContent || ""; }).join("")`;

/**
 * Reveal the Jots card and wait for its first row.
 */
async function openJotsCard(app: App): Promise<void> {
  await app.dispatchControlAction("toggle-jots");
  await app.waitForCondition<boolean>(
    `document.querySelector('.jots-card .jot-row-label') !== null`,
    { timeoutMs: 8_000 },
  );
}

/**
 * Click the first row and Enter into its editor — the ordinary route a person
 * takes, and the one at0241 pins.
 */
async function enterFirstJotEditor(app: App): Promise<void> {
  await app.nativeClickAtElement(".jots-card .jot-row-label");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
    { timeoutMs: 5_000 },
  );
  await app.nativeKey("Return");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
    { timeoutMs: 5_000 },
  );
}

/** The card and the row in one gesture, for the phases that need both. */
async function openFirstJotEditor(app: App): Promise<void> {
  await openJotsCard(app);
  await enterFirstJotEditor(app);
}

/**
 * A paste with an EMPTY `clipboardData` — the shape of the real gesture inside
 * Tug.app, where everything the paste needs is on the pasteboard and none of it
 * is in the event, because WebKit hides a private pasteboard type from the DOM.
 */
async function pasteInto(app: App, selector: string): Promise<void> {
  await app.focusElement(selector);
  await app.evalJS<null>(`(function(){
    var cm = document.querySelector(${JSON.stringify(selector)});
    cm.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
    }));
    return null;
  })()`);
}

/** Read the atom sidecar back off the REAL pasteboard, through the parser. */
async function readSidecar(
  app: App,
): Promise<{ text: string; atoms: Array<{ type: string; label: string; value: string }> } | null> {
  // The read is async (the native bridge calls back) and `evalJS` cannot
  // return a promise, so kick it off, park the result, and poll.
  await app.evalJS<null>(
    `(window.__at0527sidecar = undefined,
      window.__tug.readClipboardAtoms().then(function (r) {
        window.__at0527sidecar = JSON.stringify(r);
      }),
      null)`,
  );
  await app.waitForCondition<boolean>(`window.__at0527sidecar !== undefined`, {
    timeoutMs: 8_000,
  });
  return JSON.parse(await app.evalJS<string>(`window.__at0527sidecar`)) as {
    text: string;
    atoms: Array<{ type: string; label: string; value: string }>;
  } | null;
}

/** Poll the jots file until it parses — the save is temp-file + rename. */
function readJotsFile(path: string, timeoutMs: number): Promise<JotsFile | null> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    let last: JotsFile | null = null;
    while (Date.now() < deadline) {
      try {
        last = JSON.parse(readFileSync(path, "utf8")) as JotsFile;
        if ((last.jots[0]?.atoms ?? []).length > 0) return last;
      } catch {
        // Mid-write — read again.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return last;
  })();
}

describe.skipIf(!SHOULD_RUN)("at0527 — a Jot keeps its chips, and hands them on", () => {
  test(
    "a file chip pasted into a jot survives the store, the card and a relaunch",
    async () => {
      const tugbankPath = mkTempTugbank();
      const projectDir = mkdtempSync(join(tmpdir(), "at0527-project-"));
      const jotsDir = mkdtempSync(join(tmpdir(), "at0527-jots-"));
      const realPath = join(projectDir, FILE_NAME);
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(realPath, FILE_BODY, "utf8");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [{ id: "s1", text: "" }] }, null, 2)}\n`,
      );

      let stampedPath = "";

      try {
        seedTugbankForLaunch(tugbankPath);

        // ── Phase A: copy an atom, paste it into a jot, close and reopen. ──
        {
          const app = await launchTugApp({
            testName: "at0527-jot-keeps-its-chips",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 30_000 },
            );
            await app.bindSession("A", {
              tugSessionId: SID,
              projectDir,
              sessionMode: "resume",
            });

            // A transcript citing a file that exists — the annotator only
            // offers an atom for a path the filesystem confirms.
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
              tug_session_id: SID,
              msg_id: "m1",
              text: `Tune it in \`${realPath}\`.`,
              is_partial: false,
              rev: 0,
              seq: 1,
            });
            await ingest({
              type: "turn_complete",
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

            const SPAN = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
              { timeoutMs: 15_000 },
            );
            stampedPath =
              (await app.evalJS<string | null>(
                `(function(){
                  var el = document.querySelector(${JSON.stringify(SPAN)});
                  return el === null ? null : el.getAttribute('data-path');
                })()`,
              )) ?? "";
            expect(stampedPath.endsWith(`/${FILE_NAME}`)).toBe(true);

            // The Jots card is mounted BEFORE the copy on purpose. The system
            // pasteboard is machine-wide and the app-test corpus runs several
            // files at once, so every wall-clock second between this test's
            // write and its read is a second another test can overwrite it in.
            // Mounting the card first takes the card's own mount out of that
            // window, and the re-read below closes what is left of it.
            await openJotsCard(app);

            // ---- Copy as Atom: the object, not the characters. -----------
            Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(COPY_SENTINEL) });
            await app.evalJS<boolean>(revealJS(SPAN));
            await app.nativeRightClickAtElement(SPAN);
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
              { timeoutMs: 5_000 },
            );
            const copyPoint = await app.evalJS<{ x: number; y: number } | null>(
              menuItemPointJS("copy-annotation-atom"),
            );
            expect(copyPoint).not.toBeNull();
            await app.nativeClick(copyPoint as { x: number; y: number });

            const sidecar = await readSidecar(app);
            note("at0527 sidecar", JSON.stringify(sidecar));
            expect(sidecar).toEqual({
              text: OBJ,
              atoms: [{ type: "file", label: FILE_NAME, value: stampedPath }],
            });

            // ---- Paste it into a jot, after some prose. ------------------
            await enterFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.activeElement !== null &&
               document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`,
              { timeoutMs: 5_000 },
            );
            // Words first, so the atom lands INSIDE prose rather than alone —
            // a position the substrate has to carry, not just a lone chip.
            await app.nativeType("see ");
            await app.waitForCondition<boolean>(
              `(${flatTextJS(JOT_CONTENT)}).indexOf("see ") !== -1`,
              { timeoutMs: 5_000 },
            );
            // Read the pasteboard again, in the instant before the paste. A
            // foreign sidecar here is contention on a shared machine resource
            // rather than a defect, and this is where it says so — the
            // alternative is a chip mismatch three assertions later that reads
            // like the feature broke.
            expect(await readSidecar(app)).toEqual({
              text: OBJ,
              atoms: [{ type: "file", label: FILE_NAME, value: stampedPath }],
            });
            await pasteInto(app, JOT_CONTENT);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 8_000 },
            );
            expect(
              JSON.parse(await app.evalJS<string>(chipsJS(JOT_CONTENT))) as string[],
            ).toEqual([`file:${stampedPath}`]);
            // The path never landed as characters — a chip, not a spelling.
            expect(await app.evalJS<string>(flatTextJS(JOT_CONTENT))).not.toContain(
              FILE_NAME,
            );

            // ---- Level one: the editor closes. --------------------------
            await app.nativeKey("Escape");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
              { timeoutMs: 5_000 },
            );

            // ---- The file agrees, which is the Rust model agreeing. -----
            const saved = await readJotsFile(jotsPath, 10_000);
            note("at0527 jots.json", JSON.stringify(saved));
            const jot = saved?.jots[0];
            expect(jot?.text).toBe(`see ${OBJ}`);
            expect(jot?.atoms).toEqual([
              { position: 4, type: "file", label: FILE_NAME, value: stampedPath },
            ]);
            // The placeholder is paired: one `U+FFFC`, one atom standing at it.
            expect((jot?.text.match(/￼/g) ?? []).length).toBe(
              (jot?.atoms ?? []).length,
            );

            // ---- Level two: the card closes and reopens. ----------------
            await app.dispatchControlAction("toggle-jots");
            await app.waitForCondition<boolean>(
              `document.querySelector('.jots-card') === null`,
              { timeoutMs: 5_000 },
            );
            await openFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 8_000 },
            );
            expect(
              JSON.parse(await app.evalJS<string>(chipsJS(JOT_CONTENT))) as string[],
            ).toEqual([`file:${stampedPath}`]);
          } catch (err) {
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0527 A] log tail:\n${tail}\n`);
            throw err;
          } finally {
            await app.close();
          }
        }

        // ── Phase B: level three — a new app, reading the same file. ──────
        {
          const app = await launchTugApp({
            testName: "at0527-jot-keeps-its-chips-relaunch",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: plainDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 30_000 },
            );
            await openFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 10_000 },
            );
            const chips = JSON.parse(
              await app.evalJS<string>(chipsJS(JOT_CONTENT)),
            ) as string[];
            note("at0527 chips after relaunch", chips.join(" / "));
            // The same chip, in a process that never saw the copy — read off
            // `jots.json` through the Rust model and the TypeScript one.
            expect(chips).toEqual([`file:${stampedPath}`]);
            expect(await app.evalJS<string>(flatTextJS(JOT_CONTENT))).not.toContain(
              FILE_NAME,
            );
          } catch (err) {
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0527 B] log tail:\n${tail}\n`);
            throw err;
          } finally {
            await app.close();
          }
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a chip copied out of a jot arrives in the prompt as a chip, not as words",
    async () => {
      const tugbankPath = mkTempTugbank();
      const projectDir = mkdtempSync(join(tmpdir(), "at0527d-project-"));
      const jotsDir = mkdtempSync(join(tmpdir(), "at0527d-jots-"));
      const realPath = join(projectDir, FILE_NAME);
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(realPath, FILE_BODY, "utf8");
      // Seeded with the substrate a Phase-A paste would have left behind, so
      // this half stands on the record rather than on the other test's run.
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: [
              {
                id: "s1",
                text: `see ${OBJ} for the table`,
                atoms: [
                  { position: 4, type: "file", label: FILE_NAME, value: realPath },
                ],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      /** The [B03] spelling of a file — what leaves Tug as `text/plain`. */
      const PLAIN = `see [${FILE_NAME}](<${realPath}>) for the table`;

      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0527-jot-copies-out-as-a-chip",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir,
            sessionMode: "resume",
          });

          // The seeded jot draws its chip before anything is copied — the copy
          // reads the record, and this is that record having survived the read.
          await openFirstJotEditor(app);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
            { timeoutMs: 10_000 },
          );

          // ---- The row's own Copy — a click, no chord. ------------------
          Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(COPY_SENTINEL) });
          await app.nativeClickAtElement(
            `.jot-editor-header [aria-label="Copy jot"]`,
          );

          // The plain flavor is the words, in the one spelling — the flatten
          // happens HERE, at the exit, and only here.
          const deadline = Date.now() + 5_000;
          let plain = COPY_SENTINEL;
          while (plain === COPY_SENTINEL && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
            plain = Bun.spawnSync(["pbpaste"]).stdout.toString();
          }
          note("at0527d pasteboard text", JSON.stringify(plain));
          expect(plain.trim()).toBe(PLAIN);
          // Whatever a foreign app gets, it is not a naked placeholder.
          expect(plain).not.toContain(OBJ);

          // And the sidecar rode along, carrying the object rather than the
          // words — the half that makes the paste below a chip.
          const sidecar = await readSidecar(app);
          note("at0527d sidecar", JSON.stringify(sidecar));
          expect(sidecar).toEqual({
            text: `see ${OBJ} for the table`,
            atoms: [{ type: "file", label: FILE_NAME, value: realPath }],
          });

          // ---- Paste into the prompt entry. ----------------------------
          await pasteInto(app, PROMPT_INPUT);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img:not(.cm-widgetBuffer)').length === 1`,
            { timeoutMs: 10_000 },
          );
          const chips = JSON.parse(
            await app.evalJS<string>(chipsJS(PROMPT_INPUT)),
          ) as string[];
          note("at0527d prompt chips", chips.join(" / "));
          expect(chips).toEqual([`file:${realPath}`]);

          // A chip, not the words it would have flattened into — the prose
          // around it survives, the path does not appear as characters, and no
          // placeholder is left standing on its own.
          const flat = await app.evalJS<string>(flatTextJS(PROMPT_INPUT));
          note("at0527d prompt text", JSON.stringify(flat));
          expect(flat).toContain("see ");
          expect(flat).toContain(" for the table");
          expect(flat).not.toContain(FILE_NAME);
          expect(flat).not.toContain("](<");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0527d] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
