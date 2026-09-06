/**
 * at0526-commit-mention-copies-as-pill.test.ts — a commit mention in transcript
 * prose copies as a commit, and pastes back as one.
 *
 * This is the report the whole atom copy/paste fidelity arc opened on, driven
 * end to end on the real pasteboard. A sha the resolver confirms wears a pill
 * in the prose it was written in — and selecting across that pill and copying
 * used to produce two prose runs and no atom at all. The `text/plain` flavor
 * came out as `` `commit:``64747b8c` ``: the serializer walked *into* the pill,
 * read its word and its hash as two separate text nodes inside the mention's
 * own `<code>`, and gave each its own pair of backticks. Nothing wrote a
 * sidecar entry, so the paste back into the prompt arrived as words.
 *
 * Three failures had to be fixed for one gesture to work, and this test is the
 * one place all three are proved at once against the running app:
 *
 *   A. **The pill carries its own identity.** `TugCommitAtom` emits the
 *      `data-atom-*` attributes the selection serializer recognises a chip by,
 *      from its sha, whoever mounted it — the portal a confirmed mention wears
 *      passes none of them.
 *   B. **The flavor is the one spelling.** `atomPlainText` gives a commit
 *      `commit:<8>` through every door, so what the reader saw and what the
 *      clipboard carries are one string. The absence of the backtick stutter
 *      is proved by asserting the whole line, not a substring of it.
 *   C. **The paste rebuilds the pill.** The sidecar rode along, and a paste
 *      into the composer produces a commit chip rather than the words it would
 *      have flattened into.
 *
 * ⌘C is the gesture rather than a row's COPY button, because a prose mention
 * has no button: the reader selects it and copies. The chord never enters the
 * responder chain — AppKit performs Edit ▸ Copy on the web view — so it
 * reaches the reconstruction only through the `copy` DOM event the transcript
 * answers, which is exactly the door the report came through.
 *
 * Driven against this checkout, whose HEAD is a sha the app's own git feed can
 * confirm — the same footing at0459 stands on, and the reason the prose can
 * cite a real commit at all.
 *
 * Foreground: the pasteboard write and the reads want a key window.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/lib/atom-identity-attrs.ts
 * @covers tugdeck/src/lib/atom-plain-text.ts
 * @covers tugdeck/src/lib/markdown/serialize-selection.ts
 * @covers tugdeck/src/lib/copy-clipboard.ts
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

/** This repository — the app-test bootstrap workspace, and a real git repo. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();

/** The short form prose uses — deliberately NOT the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);

/** What the reader sees, and what the clipboard must carry. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

/** The mention, backticked the way prose actually writes one. */
const PROSE = `Landed as \`${WRITTEN_SHA}\`.`;

/** The whole line as plain text — the stutter's absence, stated positively. */
const EXPECTED_FLAT = `Landed as ${LABEL}.`;

const SENTINEL = "at0526-sentinel-nothing-copied";

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const MENTION =
  `${CARD} .session-card-transcript-code-body [data-tug-annotation="commit-sha"]`;

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

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 1,
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

/** The pill's own DOM identity — the four attributes a copy reads it by. */
const PILL_IDENTITY_JS = `JSON.stringify((function(){
  var el = document.querySelector(
    ${JSON.stringify(MENTION)} + ' [data-slot="tug-commit-atom"]');
  if (!el) return { found: false };
  return {
    found: true,
    text: (el.textContent || "").trim(),
    type: el.getAttribute("data-atom-type"),
    label: el.getAttribute("data-atom-label"),
    value: el.getAttribute("data-atom-value"),
  };
})())`;

/** The composer's chips (type + value) and its flat text, in one read. */
const COMPOSER_PROBE_JS = `(function(){
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

describe.skipIf(!SHOULD_RUN)(
  "at0526 — a prose commit mention copies as a pill and pastes back as one",
  () => {
    test(
      "⌘C over the mention writes commit:<8> plus the atom, and a paste rebuilds the chip",
      async () => {
        const app = await launchTugApp({
          testName: "at0526-commit-mention-copies-as-pill",
          foreground: true,
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
          // The binding is what gives the annotator a commit root: this
          // repository, where the sha resolves.
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir: REPO_ROOT,
            sessionMode: "resume",
          });

          // A card bound to a session stands behind its restore veil until a
          // replay bracket closes; one committed turn raises it.
          await ingest(replayStarted());
          await ingest(userMsg("hello"));
          await ingest(asstText("m0", "Ready."));
          await ingest(turnDone("m0"));
          await ingest(replayComplete());

          await app.driveSession("A", { op: "send", text: "what landed" });
          await ingest(asstText("m1", PROSE));

          // The prose paints first; the verdict is a round trip to the git
          // feed, so the pill is waited for rather than read.
          await app.waitForCondition<boolean>(
            `JSON.parse(${PILL_IDENTITY_JS}).text === ${JSON.stringify(LABEL)}`,
            { timeoutMs: 20_000 },
          );

          // ---- A. The pill carries its own identity. ---------------------
          const pill = JSON.parse(
            await app.evalJS<string>(PILL_IDENTITY_JS),
          ) as {
            found: boolean;
            text: string;
            type: string | null;
            label: string | null;
            value: string | null;
          };
          note("at0526 pill", JSON.stringify(pill));
          expect(pill.found).toBe(true);
          // The portal that mounts this pill passes none of these — they are
          // the component's own, which is what makes the selection below see a
          // chip rather than two prose runs.
          expect(pill.type).toBe("commit");
          expect(pill.label).toBe(LABEL);
          expect(pill.value).not.toBeNull();
          expect(HEAD_SHA.startsWith(pill.value ?? "x")).toBe(true);

          // ---- B. Select the mention and ⌘C. ------------------------------
          setPasteboard(SENTINEL);
          await app.evalJS<null>(`(function(){
            var el = document.querySelector(${JSON.stringify(MENTION)});
            var range = document.createRange();
            // The whole paragraph, so the copy is the mention IN ITS SENTENCE —
            // which is how a reader selects one, and the case the report came
            // from.
            range.selectNodeContents(el.closest("p") || el);
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
          note("at0526 pasteboard text", JSON.stringify(flat));
          expect(flat).not.toBe(SENTINEL); // the copy happened at all
          // The WHOLE line, not a substring: the defect wrote
          // `` `commit:``64747b8c` `` and a `toContain` would have passed on it.
          expect(flat.trim()).toBe(EXPECTED_FLAT);
          // And the characters the author actually typed are gone, replaced by
          // the one spelling every commit surface shows.
          expect(flat).not.toContain(WRITTEN_SHA);

          // ---- The sidecar rode along, typed. -----------------------------
          //
          // The read is async (the bridge calls back) and `evalJS` cannot
          // return a promise, so kick it off, park the result, and poll.
          await app.evalJS<null>(
            `(window.__at0526sidecar = undefined,
              window.__tug.readClipboardAtoms().then(function (r) {
                window.__at0526sidecar = JSON.stringify(r);
              }),
              null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__at0526sidecar !== undefined`,
            { timeoutMs: 8_000 },
          );
          const sidecar = JSON.parse(
            await app.evalJS<string>(`window.__at0526sidecar`),
          ) as {
            text: string;
            atoms: Array<{ type: string; label: string; value: string }>;
          } | null;
          note("at0526 sidecar", JSON.stringify(sidecar));
          expect(sidecar).not.toBeNull();
          // One atom for one pill — the substrate, with a U+FFFC where the
          // mention stood rather than the words it draws.
          expect(sidecar?.atoms.map((a) => a.type)).toEqual(["commit"]);
          expect(sidecar?.atoms[0]?.label).toBe(LABEL);
          expect(sidecar?.text).toContain("￼");
          expect(sidecar?.text).not.toContain(LABEL);

          // ---- C. A paste into the composer rebuilds the pill. ------------
          await app.focusElement(COMPOSER);
          await app.evalJS<null>(`(function(){
            var cm = document.querySelector(${JSON.stringify(COMPOSER)});
            // An EMPTY clipboardData — the shape of the real gesture inside
            // Tug.app, where everything the paste needs is on the pasteboard
            // and none of it is in the event.
            cm.dispatchEvent(new ClipboardEvent("paste", {
              bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
            }));
            return null;
          })()`);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(COMPOSER)} + ' img:not(.cm-widgetBuffer)').length === 1`,
            { timeoutMs: 8_000 },
          );
          const pasted = await app.evalJS<{ atoms: string[]; text: string }>(
            COMPOSER_PROBE_JS,
          );
          note("at0526 composer after paste", JSON.stringify(pasted));
          expect(pasted.atoms).toHaveLength(1);
          expect(pasted.atoms[0]).toStartWith("commit:");
          // A chip, not the words it would have flattened into.
          expect(pasted.text).not.toContain(LABEL);
          expect(pasted.text).toContain("Landed as");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0526] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
