/**
 * at0528-receipt-commit-copies-as-atom.test.ts — the commit pill in a `/commit`
 * receipt is an object, through both doors a reader has for taking it away.
 *
 * A receipt header is where a commit is most likely to be copied: it is the
 * moment the commit came into existence, and the pill is right there. Both ways
 * of taking it were broken, for two different reasons, and this is the test
 * that holds them together because they are one claim about one surface.
 *
 *   **The mount.** A pill mounted by a receipt carried no `data-atom-*`
 *   attributes at all — the trio was a spread each caller remembered, and the
 *   receipt, the join receipt, the arc receipt and the History shade were the
 *   callers that did not. `TugCommitAtom` now emits the trio from its own sha,
 *   whoever mounted it, and this asserts that off the running app: the pill in
 *   a live receipt header names its own type, label and value.
 *
 *   **The menu.** The receipt's right-click offered every form of a commit
 *   except the one that pastes back as a commit: the registry's menu returned
 *   early on a surface holding the record, so `Copy as Atom` was appended only
 *   for a prose mention. It is offered here now, and it writes the same
 *   one-atom sidecar the annotation menu writes, so a paste into the prompt
 *   entry is a live pill rather than the eight characters it draws.
 *
 * The two doors are asserted against the SAME pill in the same frame, which is
 * the point: a reader does not know or care which one they used, and an object
 * that is an object through one and prose through the other is not an object.
 *
 * **What a ⌘C across the header still does, and why it is not asserted here.**
 * The trio is necessary and not sufficient: the atom-aware reconstruction runs
 * per transcript CELL, and a `/commit` receipt is painted inside the shell-route
 * cell, which supplies no `resolveCopyMarkdown` because shell ink is literal
 * text and copies verbatim by design — at0352 pins exactly that, on this exact
 * header. So a selection dragged across the pill still hands back the drawn
 * characters. That is a decision about the literal-ink rule rather than about
 * this pill, and the arc never opened it, so the run records what the door
 * actually does as a diagnostic rather than asserting it: freezing a known gap
 * as the expected answer would make the eventual fix read as a regression.
 *
 * Driven against this checkout, whose HEAD is a sha the app's own git feed can
 * confirm — the same footing at0512 and at0526 stand on, and the reason the
 * receipt can name a real commit at all.
 *
 * Foreground: ⌘C is Edit ▸ Copy's key equivalent, which AppKit resolves against
 * the main menu before the web view sees anything, and a background instance
 * has no key window for that resolution to land in.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/commit-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/session-identity-menu.tsx
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/lib/copy-clipboard.ts
 * @covers tugdeck/src/lib/annotator/atom-segment.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "at0528-session";

/** This repository — the app-test bootstrap workspace, and a real git repo. */
const REPO = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();

/** The one spelling every commit surface draws, and the one flavor it writes. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

/** U+FFFC, the object-replacement char an atom stands at. */
const OBJ = "￼";

const CARD = '[data-card-id="S"]';
const PILL = '[data-slot="tug-commit-atom"]';
const RECEIPT_HEADER = `${CARD} .commit-receipt-header`;
const RECEIPT_PILL = `${RECEIPT_HEADER} ${PILL}`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

const SENTINEL = "at0528-sentinel-nothing-copied";

/**
 * A `/commit` receipt's output — the server-formatted summary the transcript's
 * bespoke renderer parses. The sha is this repo's HEAD, so the header's pill
 * stands on a commit the git feed can confirm.
 */
const COMMIT_SUMMARY =
  `committed ${HEAD_SHA} · 1 file(s) · +3 −1\n` +
  `files: [{"path":"tugdeck/src/lib/commit-format.ts","status":"modified","added":3,"removed":1}]\n` +
  "Land the commit atom";

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pS",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pS",
    hasFocus: true,
  };
}

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

/** The viewport point of a menu item, or `null` when it is not open. */
const menuItemPointJS = (action: string) =>
  `(function(){
    var item = document.querySelector('[data-item-action=${action}]');
    if (item === null) return null;
    var r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;

/** The chips in a CM6 field, as `type:value`. */
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

/** Read the atom sidecar back off the REAL pasteboard, through the parser. */
async function readSidecar(
  app: App,
): Promise<{ text: string; atoms: Array<{ type: string; label: string; value: string }> } | null> {
  // The read is async (the native bridge calls back) and `evalJS` cannot
  // return a promise, so kick it off, park the result, and poll.
  await app.evalJS<null>(
    `(window.__at0528sidecar = undefined,
      window.__tug.readClipboardAtoms().then(function (r) {
        window.__at0528sidecar = JSON.stringify(r);
      }),
      null)`,
  );
  await app.waitForCondition<boolean>(`window.__at0528sidecar !== undefined`, {
    timeoutMs: 8_000,
  });
  return JSON.parse(await app.evalJS<string>(`window.__at0528sidecar`)) as {
    text: string;
    atoms: Array<{ type: string; label: string; value: string }>;
  } | null;
}

describe.skipIf(!SHOULD_RUN)(
  "at0528 — a receipt's commit copies as an atom, by selection and by menu",
  () => {
    test(
      "the header's pill carries its identity, and Copy as Atom pastes back as a pill",
      async () => {
        const app = await launchTugApp({
          testName: "at0528-receipt-commit-copies-as-atom",
          foreground: true,
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("S", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 20_000 },
          );
          await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("S")`,
            { timeoutMs: 20_000 },
          );
          // The binding is what gives the receipt a commit root: this
          // repository, where the sha resolves.
          await app.bindSession("S", {
            tugSessionId: SID,
            projectDir: REPO,
            sessionMode: "resume",
          });

          // A bound card stands behind its restore veil until a replay bracket
          // closes; one committed turn is the cheapest way to raise it.
          await ingest({ type: "replay_started", tug_session_id: SID });
          await ingest({
            type: "add_user_message",
            tug_session_id: SID,
            content: [{ type: "text", text: "hello" }],
          });
          await ingest({
            type: "assistant_text",
            tug_session_id: SID,
            msg_id: "m0",
            text: "Ready.",
            is_partial: false,
            rev: 0,
            seq: 1,
          });
          await ingest({
            type: "turn_complete",
            tug_session_id: SID,
            msg_id: "m0",
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

          // ---- The receipt, with its pill. --------------------------------
          await app.driveSession("S", {
            op: "shellExchange",
            exchangeId: "at0528-commit",
            command: "/commit",
            output: COMMIT_SUMMARY,
            cwd: REPO,
            exitCode: 0,
            startedAtMs: 1_700_000_000_000,
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RECEIPT_PILL)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // ---- A. The mount carries the identity. -------------------------
          const identity = JSON.parse(
            await app.evalJS<string>(
              `JSON.stringify((function(){
                var el = document.querySelector(${JSON.stringify(RECEIPT_PILL)});
                if (el === null) return { found: false };
                return {
                  found: true,
                  text: (el.textContent || "").trim(),
                  type: el.getAttribute("data-atom-type"),
                  label: el.getAttribute("data-atom-label"),
                  value: el.getAttribute("data-atom-value"),
                };
              })())`,
            ),
          ) as {
            found: boolean;
            text: string;
            type: string | null;
            label: string | null;
            value: string | null;
          };
          note("at0528 receipt pill", JSON.stringify(identity));
          expect(identity.found).toBe(true);
          expect(identity.text).toBe(LABEL);
          // The receipt block passes none of these; they are the component's
          // own, which is what makes the selection below see a chip.
          expect(identity.type).toBe("commit");
          expect(identity.label).toBe(LABEL);
          expect(identity.value).toBe(HEAD_SHA);

          // ---- B. What a selection across the header actually does. -------
          //
          // Recorded, not asserted — see the docblock. The shell-route cell
          // copies its selection verbatim by design, so this reads back the
          // drawn characters rather than the substrate. It is here because a
          // number in a diagnostics line is how the next person to open the
          // literal-ink question finds out what the door does today.
          setPasteboard(SENTINEL);
          await app.evalJS<null>(`(function(){
            var el = document.querySelector(${JSON.stringify(RECEIPT_HEADER)});
            el.scrollIntoView({ block: "center" });
            var range = document.createRange();
            // The whole header, which is what a drag across it selects — the
            // pill in its line, not the pill alone.
            range.selectNodeContents(el);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return null;
          })()`);
          await app.nativeKey("c", ["cmd"]);
          // The chord travels through AppKit before the web view answers it;
          // give the round trip a beat before reading the pasteboard back.
          await new Promise((r) => setTimeout(r, 600));
          const flat = readPasteboard();
          const dragged = await readSidecar(app);
          note("at0528 selection text", JSON.stringify(flat));
          note("at0528 selection sidecar", JSON.stringify(dragged));
          // The one thing that IS this test's claim about the chord: it
          // reaches the web view at all, which at0352 is the ground for.
          expect(flat).not.toBe(SENTINEL);

          // ---- C. And the menu offers the same object. --------------------
          setPasteboard(SENTINEL);
          await app.nativeRightClickAtElement(RECEIPT_PILL);
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
            { timeoutMs: 5_000 },
          );
          const labels = JSON.parse(
            await app.evalJS<string>(
              `JSON.stringify(Array.prototype.map.call(
                 document.querySelectorAll('[data-item-action]'),
                 function (el) { return (el.textContent || "").trim(); }))`,
            ),
          ) as string[];
          note("at0528 receipt menu", labels.join(" / "));
          // The record's own forms AND the object — a surface that holds the
          // whole commit record used to offer every form except this one.
          expect(labels).toContain("Copy Commit Record");
          expect(labels).toContain("Copy as Atom");

          const point = await app.evalJS<{ x: number; y: number } | null>(
            menuItemPointJS("copy-annotation-atom"),
          );
          expect(point).not.toBeNull();
          await app.nativeClick(point as { x: number; y: number });

          const fromMenu = await readSidecar(app);
          note("at0528 menu sidecar", JSON.stringify(fromMenu));
          // Byte for byte what the annotation menu writes for a prose mention:
          // one atom, alone, against a single placeholder.
          expect(fromMenu).toEqual({
            text: OBJ,
            atoms: [{ type: "commit", label: LABEL, value: HEAD_SHA }],
          });
          expect(readPasteboard().trim()).toBe(LABEL);

          // ---- D. A paste into the composer rebuilds the pill. ------------
          //
          // An EMPTY `clipboardData` is the shape of the real gesture inside
          // Tug.app: everything the paste needs is on the pasteboard and none
          // of it is in the event, because WebKit hides a private type from the
          // DOM event.
          await app.focusElement(PROMPT_INPUT);
          await app.evalJS<null>(`(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            cm.dispatchEvent(new ClipboardEvent("paste", {
              bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
            }));
            return null;
          })()`);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img:not(.cm-widgetBuffer)').length === 1`,
            { timeoutMs: 8_000 },
          );
          const chips = JSON.parse(
            await app.evalJS<string>(chipsJS(PROMPT_INPUT)),
          ) as string[];
          note("at0528 composer chips", chips.join(" / "));
          expect(chips).toEqual([`commit:${HEAD_SHA}`]);
          // A pill, not the eight characters it draws.
          expect(await app.evalJS<string>(flatTextJS(PROMPT_INPUT))).not.toContain(
            LABEL,
          );
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0528] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
