/**
 * at0873-docket-atom-and-arc-link.test.ts — a docket placed in a prompt gives
 * the model something it can actually read.
 *
 * ## What this gates
 *
 * at0871's shape, for the docket. The unit tests know each half: the block's
 * grammar, the wire builder that appends it, the synthesizer that strips it,
 * the citation store's cache. What only the app can show is the whole path
 * at once: the atom copied from the Docket card's own door, pasted into a
 * session's composer, resolved by the real server, and sent.
 *
 *   A. **The block rides out.** A docket made in the Docket card is copied
 *      with its chooser's Copy as Atom and pasted into a session prompt; the
 *      same docket is also placed from `@docket:` completion. The submission's
 *      `user_message` ends with a `tug:docket-refs` block naming the docket
 *      once, by its name and its checkout, with the `here` the server's answer
 *      settles rather than `unverified`.
 *
 *   B. **And it is not in the transcript.** The same submission's row shows
 *      the docket chips and none of the block's text.
 *
 *   C. **The command the block prints answers.** The block's read, run with
 *      this checkout's built `tugtool`, prints the docket.
 *
 * Everything runs in a scratch repository under a scratch `TUG_DATA_DIR`
 * through this checkout's built `tugtool`, so nothing here touches the
 * user's own dockets.
 *
 * @covers tugdeck/src/lib/docket-atom.ts
 * @covers tugdeck/src/lib/docket-ref-block.ts
 * @covers tugdeck/src/lib/docket-citation-store.ts
 * @covers tugdeck/src/lib/docket-search-answers.ts
 * @covers tugdeck/src/components/tugways/cards/completion-providers/docket-mentions.ts
 * @covers tugdeck/src/lib/build-wire-payload.ts
 * @covers tugdeck/src/lib/synthesize-user-message.ts
 * @covers tugdeck/src/components/docket/docket-card.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { makeArcScratchRepo, tugtool, type ArcScratchRepo } from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "aa11bb22-0000-4000-8000-00000000a873";
const SID_B = "aa11bb22-0000-4000-8000-00000000b873";
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const NAME = "Rail work";

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMPOSER_DOCKETS = `${COMPOSER} [data-atom-type="docket"]`;
const COMPLETION_ITEMS = '[data-slot="tug-completion-menu"] .tug-completion-menu-item';
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const DOCKET_CHIP = '[data-atom-type="docket"]';

const CHOOSER = '.docket-chooser [data-slot="tug-popup-button"]';
const CHOOSER_ITEM = (i: number) => `[data-testid="docket-chooser"] .tug-menu-item[data-item-id="${i}"]`;
const DIALOG_FIELD = '[data-slot="tug-modal-input-dialog-field"]';
const EMPTY = '[data-slot="docket-empty"]';
const HEADER_ATOM = '[data-slot="docket-card-atom"] [data-atom-type="docket"]';

let scratch: ArcScratchRepo | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0873", checkout: CHECKOUT });
});

afterAll(() => {
  if (scratch === null) return;
  rmSync(scratch.repo, { recursive: true, force: true });
  rmSync(scratch.dataRoot, { recursive: true, force: true });
});

/** This checkout's tugtool, in the scratch repo, against the scratch data. */
function cli(args: string[]): string {
  const s = scratch!;
  return tugtool(args, { cwd: s.repo, binaryRoot: s.cli.binaryRoot, env: s.cli.env });
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "session", title: "Session", closable: true },
      { id: "D", componentId: "docket", title: "Docket", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 620, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p2",
        position: { x: 660, y: 20 },
        size: { width: 640, height: 520 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p3",
        position: { x: 20, y: 560 },
        size: { width: 420, height: 300 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Wait until `cardId`'s view is the window's first responder. */
async function awaitResponder(app: App, cardId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await app.bodies()).some((b) => b.cardId === cardId && b.firstResponder === true)) {
    if (Date.now() > deadline) throw new Error(`${cardId}'s view never became the first responder`);
    await Bun.sleep(50);
  }
}

/**
 * Open the chooser by a real press and wait for its items to stand. A press
 * into a card that is not yet key may only raise it, so a second press
 * follows when the first opened nothing, as a hand would.
 */
async function openChooser(app: App): Promise<void> {
  const open = `document.querySelector(${JSON.stringify(CHOOSER_ITEM(0))}) !== null`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.body("D").nativeClickAtElement(CHOOSER);
    try {
      await app.body("D").waitForCondition<boolean>(open, { timeoutMs: 1_500 });
      return;
    } catch {
      // Raised, not opened; press again.
    }
  }
  throw new Error("the docket chooser never opened");
}

/** Open the chooser and press the item whose label is `label`. */
async function pickFromChooser(app: App, label: string): Promise<void> {
  await app.dispatchControlAction("focus-pane", { paneId: "p2" });
  await openChooser(app);
  const labels = await app.body("D").evalJS<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="docket-chooser"] .tug-menu-item')).map(function (el) { return (el.textContent || "").trim(); })`,
  );
  const index = labels.indexOf(label);
  expect(index, `the chooser offers ${label} (it offered ${labels.join(" | ")})`).toBeGreaterThan(-1);
  await app.body("D").nativeClickAtElement(CHOOSER_ITEM(index));
}

/** The command a block line offers after `read:`, as argv. */
function readCommand(block: string, marker: string): string[] {
  const line = block.split("\n").find((l) => l.startsWith(marker)) ?? "";
  const m = / — read: (.+)$/.exec(line);
  expect(m, `the line ${line} offers a read`).not.toBeNull();
  const argv = (m?.[1] ?? "").split(" ");
  expect(argv[0]).toBe("tugtool");
  return argv.slice(1);
}

describe.skipIf(!SHOULD_RUN)("at0873 — a docket atom the model can read", () => {
  test(
    "the copied docket atom sends a resolved block, stays out of the transcript, and names a command that answers",
    async () => {
      const s = scratch!;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0873-docket-atom-and-arc-link",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.dataRoot },
      });
      try {
        await app.seedDeckState({
          state: deckShape(),
          cardStates: { D: { content: { projectDir: s.repo } } },
          focusCardId: "D",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // Spawning B on the scratch repo registers it as a workspace, which is
        // what puts it in the DOCKETS feed; A stays free to bind below.
        await app.spawnSessionResume("B", { tugSessionId: SID_B, projectDir: s.repo });
        await app.awaitEngineReady("B", { timeoutMs: 15_000 });
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EMPTY)}) !== null
           && (document.querySelector(${JSON.stringify(EMPTY)}).textContent || "").trim() === "No dockets"`,
          { timeoutMs: 20_000 },
        );

        // A docket, made from the card; its atom stands in the header.
        await pickFromChooser(app, "New Docket…");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG_FIELD)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await app.nativeType(NAME);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-modal-input-dialog-list"]') !== null
           && (document.querySelector('[data-slot="tug-modal-input-dialog-list"]').textContent || "").indexOf(${JSON.stringify(NAME)}) !== -1`,
          { timeoutMs: 5_000 },
        );
        await app.nativeKey("Return");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(HEADER_ATOM)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const listed = JSON.parse(cli(["docket", "list", "--json"])) as {
          data: Array<{ id: string; name: string }>;
        };
        const docket = listed.data.find((d) => d.name === NAME);
        expect(docket, "tugtool docket list names the new docket").toBeDefined();
        const id = docket!.id;
        expect(
          await app.body("D").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(HEADER_ATOM)}).getAttribute("data-atom-value")`,
          ),
        ).toBe(id);

        // ---- A. The block rides out. ---------------------------------------
        await pickFromChooser(app, "Copy as Atom");

        // The real workspace key, the gateway's form of the checkout, so the
        // verdict compares as a spawned session's would: the docket is this
        // project's, so `here`.
        await app.bindSession("A", { tugSessionId: SID, projectDir: s.repo, workspaceKey: s.repo });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: { type: "replay_started", tug_session_id: SID },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: {
            type: "replay_complete",
            tug_session_id: SID,
            count: 0,
            firstLoadedTurnIndex: 0,
            totalTurns: 0,
            hasOlder: false,
          },
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.dispatchControlAction("focus-session-card", { cardId: "A" });
        await awaitResponder(app, "A");
        await app.body("A").focusElement(COMPOSER);
        const pasted = await app.performMenuItem("edit.paste");
        expect(pasted.found && pasted.performed, "Edit ▸ Paste performs").toBe(true);
        try {
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER_DOCKETS)}) !== null`,
            { timeoutMs: 10_000 },
          );
        } catch (error) {
          const seen = await app.body("A").evalJS<string>(
            `(function(){ var el = document.querySelector(${JSON.stringify(COMPOSER)}); return el === null ? "no composer" : el.innerHTML.slice(0, 600); })()`,
          );
          note("at0873 composer after paste", seen);
          throw error;
        }
        const pastedAtom = await app.body("A").evalJS<{ value: string | null; dir: string | null }>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(COMPOSER_DOCKETS)});
            return { value: el.getAttribute("data-atom-value"), dir: el.getAttribute("data-atom-docket-project-dir") };
          })()`,
        );
        note("at0873 pasted", JSON.stringify(pastedAtom));
        expect(pastedAtom.value).toBe(id);
        expect(pastedAtom.dir).toBe(s.repo);

        // The same docket from `@docket:` completion: a search answered by the
        // server, sent after the pasted chip's resolve, so by the time its row
        // stands that resolve has had its round trip.
        await app.nativeType(" @docket:rail");
        await app.body("A").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(COMPLETION_ITEMS)})).some(function (el) { return (el.textContent || "").indexOf(${JSON.stringify(NAME)}) !== -1; })`,
          { timeoutMs: 15_000 },
        );
        await app.nativeKey("Return");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(COMPOSER_DOCKETS)}).length === 2`,
          { timeoutMs: 10_000 },
        );

        // Shift-Return submits, dispatched on the focused editor as at0818 does.
        await app.body("A").evalJS<null>(
          `(function () {
            (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", shiftKey: true, bubbles: true, cancelable: true,
            }));
            return null;
          })()`,
        );
        await app.body("A").waitForCondition<boolean>(
          `window.__tug.lastSentUserMessage("A") !== null`,
          { timeoutMs: 10_000 },
        );
        const wire = JSON.parse(
          (await app.body("A").evalJS<string>(`window.__tug.lastSentUserMessage("A")`))!,
        ) as { type: string; content: Array<{ type: string; text?: string }> };
        note("at0873 wire", JSON.stringify(wire).slice(0, 900));
        expect(wire.type).toBe("user_message");
        const texts = wire.content.map((b) => b.text ?? "");
        const block = texts[texts.length - 1]!;
        expect(block.startsWith("<!-- tug:docket-refs -->")).toBe(true);
        const lines = block.split("\n").filter((l) => l.startsWith("- @docket:"));
        expect(lines.length, "two chips naming one docket earn one line").toBe(1);
        expect(lines[0]).toContain(`- @docket:${id} — "${NAME}", project ${s.repo}`);
        expect(lines[0]).toContain("threads 0, verdict: here — read: ");
        expect(block).not.toContain("unverified");
        const body = texts.slice(0, -1).join("");
        expect(body).toContain(`\`@docket:${id}\``);

        // ---- B. And it is not in the transcript. ---------------------------
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var body = document.querySelector(${JSON.stringify(USER_BODY)});
            return body !== null && body.querySelector(${JSON.stringify(DOCKET_CHIP)}) !== null;
          })()`,
          { timeoutMs: 10_000 },
        );
        const row = await app.body("A").evalJS<{ text: string; dockets: number }>(
          `(function(){
            var body = document.querySelector(${JSON.stringify(USER_BODY)});
            return {
              text: (body.textContent || "").replace(/\\s+/g, " ").trim(),
              dockets: body.querySelectorAll(${JSON.stringify(DOCKET_CHIP)}).length,
            };
          })()`,
        );
        note("at0873 row", JSON.stringify(row));
        expect(row.dockets).toBe(2);
        expect(row.text).not.toContain("tug:docket-refs");
        expect(row.text).not.toContain("verdict:");

        // ---- C. The command the block prints answers. ----------------------
        const shown = cli(readCommand(block, "- @docket:"));
        note("at0873 docket show", shown.slice(0, 400));
        expect(shown).toContain(NAME);
        expect(shown).toContain(id);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
