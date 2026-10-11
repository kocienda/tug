/**
 * at0352-shell-row-copy.test.ts — ⌘C works in a shell-route row.
 *
 * A `/commit` lands in the transcript as a shell-route exchange painted by
 * the commit-receipt renderer. Its header line — the sha and the subject —
 * selected like any other ink, and ⌘C did nothing at all.
 *
 * The reason is the native Edit menu. ⌘C is Edit ▸ Copy's key equivalent, so
 * AppKit resolves it before the web view ever sees a keydown, and the item is
 * validated from `MenuState.edit.copy` — which is
 * `responderChain.validateAction(COPY)`. The shell cell registered no COPY
 * handler at all (only the user and assistant cells did), so with a shell row
 * as first responder the item validated DARK: the chord beeped, and the deck's
 * own ⌘C binding never ran either (`preventDefaultOnMatch` suppresses WebKit's
 * native copy on the frontend side). Selection painted; clipboard unmoved.
 *
 * The shell cell now mounts the same `useTranscriptCellMenu` responder the
 * other two do, which lights the menu item and copies the live selection.
 *
 * Ground truth here is the system pasteboard, not a JS clipboard sink: with
 * the item enabled the copy runs through AppKit's `NSText.copy(_:)`, so a
 * stub on `navigator.clipboard` would never see it. Each assertion seeds the
 * pasteboard with a sentinel first, so "unchanged" is distinguishable from
 * "copied the same thing again".
 *
 * `foreground: true` for that same reason: `NSApp.sendAction(_:to: nil)` walks
 * the KEY window's responder chain, and a background instance has none — the
 * enabled item fires, the send finds nobody, and the pasteboard never moves.
 * The menu path is only observable with the app active.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "test-session-A";
const CARD = `[data-card-id="A"]`;

/**
 * The subject and body lines carry nothing path-shaped: an annotated run
 * would turn the click that promotes the row into an open-file gesture, and
 * this test is about the clipboard, not the annotator.
 */
const SUBJECT = "commit receipt copy check";
const BODY_LINE = "the body line reads as ordinary prose";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0352-commit-"));
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

/** The S02 commit-summary shape the receipt parses (`·` U+00B7, `−` U+2212). */
function commitOutput(): string {
  return ["committed 95428607 · 1 file(s) · +12 −3", SUBJECT, "", BODY_LINE].join("\n");
}

/** Select chars [start,end) of the first text node under `selector` holding `needle`. */
function selectInScript(selector: string, needle: string, start: number, end: number): string {
  return `(function(){
    var root = document.querySelector('${CARD} ${selector}');
    if (root === null) return "__NO_ROOT__";
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n !== null; n = w.nextNode()){
      if ((n.textContent || "").indexOf(${JSON.stringify(needle)}) !== -1){
        var range = document.createRange();
        range.setStart(n, ${start});
        range.setEnd(n, Math.min(${end}, (n.textContent || "").length));
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return range.toString();
      }
    }
    return "__NOT_FOUND__";
  })()`;
}

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

/**
 * Press ⌘C and return what landed on the pasteboard, waiting for it to move
 * off the sentinel. Returns the sentinel itself when nothing was copied —
 * which is exactly what the bug looked like.
 */
async function copyAndRead(
  app: Awaited<ReturnType<typeof launchTugApp>>,
  sentinel: string,
): Promise<string> {
  setPasteboard(sentinel);
  await app.nativeKey("c", ["cmd"]);
  const deadline = Date.now() + 3000;
  let seen = readPasteboard();
  while (seen === sentinel && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    seen = readPasteboard();
  }
  return seen;
}

describe.skipIf(!SHOULD_RUN)("AT0352: ⌘C copies a selection in a shell-route row", () => {
  test(
    "the commit receipt's header subject and message body both copy",
    async () => {
      const app = await launchTugApp({ testName: "at0352-shell-row-copy", foreground: true });
      try {
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
          workspaceKey: projectDir,
        });

        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "commit-1",
          command: "/commit",
          output: commitOutput(),
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });

        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="commit-receipt-block"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        // Promote the row to first responder the way a reader does — a
        // click inside it. Both the menu's enablement and ⌘C's routing
        // start from there.
        await app.nativeClickAtElement(`${CARD} .commit-receipt-summary`);
        await app.waitForCondition<boolean>(`window.__tug.getHasFocus() === true`, {
          timeoutMs: 3000,
        });

        // The row registers a COPY handler, so Edit ▸ Copy validates lit —
        // the condition ⌘C's whole path hangs off.
        const rowIsFirstResponder = await app.evalJS<boolean>(`(function(){
          var id = window.__tug.getFirstResponderId();
          var el = id === null ? null : document.querySelector('[data-responder-id="' + id + '"]');
          return el !== null && el.getAttribute("data-slot") === "session-transcript-shell-row";
        })()`);
        expect(rowIsFirstResponder).toBe(true);
        const copyItem = await app.menuItemState("edit.copy");
        expect(copyItem.found).toBe(true);
        expect(copyItem.found === true && copyItem.enabled).toBe(true);

        // ---- the header subject: the reported case ----
        const headSel = await app.evalJS<string>(
          selectInScript(".commit-receipt-summary", SUBJECT, 0, SUBJECT.length),
        );
        expect(headSel).toBe(SUBJECT);
        expect(await copyAndRead(app, "at0352-sentinel-head")).toBe(SUBJECT);

        // ---- a partial selection copies exactly what is selected ----
        const partSel = await app.evalJS<string>(
          selectInScript(".commit-receipt-summary", SUBJECT, 7, 14),
        );
        expect(partSel).toBe(SUBJECT.slice(7, 14));
        expect(await copyAndRead(app, "at0352-sentinel-part")).toBe(SUBJECT.slice(7, 14));

        // ---- the message body below the header ----
        const bodySel = await app.evalJS<string>(
          selectInScript('[data-slot="commit-receipt-detail"]', BODY_LINE, 0, BODY_LINE.length),
        );
        expect(bodySel).toBe(BODY_LINE);
        expect(await copyAndRead(app, "at0352-sentinel-body")).toBe(BODY_LINE);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0352] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
