/**
 * at0544-commit-pill-holds-through-deltas.test.ts — the commit pill is never
 * blank for a frame while the paragraph around it streams in.
 *
 * A confirmed sha in prose is a marked span the annotator writes, emptied and
 * filled by a React portal (`useCommitTipPortals`). The streaming reconciler
 * rewrites a block's `innerHTML` on every delta, so the span is a NEW element
 * per delta and the portal has to mount again — and the emptying is a DOM
 * write while the filling is a React render. Announced from the rAF that owns
 * the delta, those were two frames, not one: the frame that emptied the host
 * painted a hole where the pill had been, and the portal arrived in the next.
 * A paragraph is dozens of deltas, so the pill flashed dozens of times, taking
 * the sentence's width with it each time — the enclosure around it collapsing
 * and re-opening. at0459 pins the SETTLED state and cannot see this; it waits,
 * and the wait is what hides it.
 *
 * So this test reads the frames instead of the settled state. A
 * `MutationObserver` on the card samples every commit host at each microtask
 * checkpoint — after the delta's whole rAF callback has run, and before the
 * browser paints. A host with no pill inside it at that moment is a hole the
 * reader would have seen. The contract is that there are none: the pass writes
 * the DOM, the portals fill it, and only then is there a paint.
 *
 * Driven against this checkout, whose HEAD the app's own git feed can confirm
 * — the footing at0459 stands on.
 *
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 * @covers tugdeck/src/components/tugways/annotation-portals.tsx
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

/** What the reader must end up seeing, whatever the prose spelled. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

/** The sentence that mints the pill. */
const FIRST = `One finding, fixed (\`${WRITTEN_SHA}\`).`;

/**
 * The prose that streams in AFTER it — the deltas that used to strip the pill
 * for a frame each. Appended one clause at a time, which is the shape a real
 * turn arrives in: the same paragraph rebuilt over and over with the pill near
 * its start.
 */
const TAIL_CLAUSES = [
  " `placeTiles` drew a drop's preview tiles",
  " from the shares a fitting place is holding,",
  " but a card arriving from another place",
  " changes its membership, and the commit",
  " re-seeds from the naturals — so the outline",
  " promised a division the drop immediately replaced.",
  " It now applies the commit's own key-set test:",
  " a foreign arrival previews the seed, a reorder",
  " inside one place keeps its record, flow is untouched.",
];

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
const asstDelta = (msgId: string, text: string, rev: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  // Partial, so the store APPENDS — the block is rebuilt rather than replaced.
  is_partial: true,
  rev,
  seq: 0,
});

const HOSTS = '[data-card-id="A"] [data-tug-annotation="commit-sha"]';
const PILL = '[data-slot="tug-commit-atom"]';

/**
 * Install the frame reader.
 *
 * `MutationObserver` callbacks run at the microtask checkpoint after the
 * callback that queued the records — so for a streaming delta that is after
 * the reconcile, after the annotation pass, after the portals the pass
 * announces, and still before the paint. Whatever it finds is what the frame
 * would show.
 */
const INSTALL_PROBE_JS = `(function(){
  var root = document.querySelector('[data-card-id="A"]');
  if (!root) return "no-card";
  var state = { blanks: 0, samples: 0, worst: "" };
  window.__at0544 = state;
  var obs = new MutationObserver(function(){
    var hosts = document.querySelectorAll(${JSON.stringify(HOSTS)});
    for (var i = 0; i < hosts.length; i += 1) {
      state.samples += 1;
      if (hosts[i].querySelector(${JSON.stringify(PILL)}) === null) {
        state.blanks += 1;
        state.worst = (hosts[i].outerHTML || "").slice(0, 160);
      }
    }
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  window.__at0544_stop = function(){ obs.disconnect(); };
  return "ok";
})()`;

const READ_PROBE_JS = `JSON.stringify(window.__at0544 || null)`;

describe.skipIf(!SHOULD_RUN)(
  "AT0544: the commit pill holds through the deltas around it",
  () => {
    test(
      "no delta paints the pill's host empty",
      async () => {
        const app = await launchTugApp({
          testName: "at0544-commit-pill-holds-through-deltas",
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

          // One committed turn raises the restore veil; the live turn beneath
          // it is what streams.
          await ingest(replayStarted());
          await ingest(userMsg("hello"));
          await ingest(asstText("m0", "Ready."));
          await ingest(turnDone("m0"));
          await ingest(replayComplete());

          await app.driveSession("A", { op: "send", text: "what did you fix" });
          await ingest(asstDelta("m1", FIRST, 0));

          // The verdict is a round trip to the git feed, so the pill is waited
          // for. Everything after this point is the streaming the pill has to
          // survive.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${HOSTS} ${PILL}`)}) !== null`,
            { timeoutMs: 15_000 },
          );

          const installed = await app.evalJS<string>(INSTALL_PROBE_JS);
          expect(installed).toBe("ok");

          // The paragraph streams in around a pill that is already there.
          let rev = 1;
          for (const clause of TAIL_CLAUSES) {
            await ingest(asstDelta("m1", clause, rev));
            rev += 1;
          }
          await app.waitForCondition<boolean>(
            `(document.querySelector('[data-card-id="A"]')?.textContent || "").indexOf("flow is untouched") !== -1`,
            { timeoutMs: 15_000 },
          );

          const probe = JSON.parse(await app.evalJS<string>(READ_PROBE_JS)) as {
            blanks: number;
            samples: number;
            worst: string;
          } | null;
          await app.evalJS<unknown>(`window.__at0544_stop && window.__at0544_stop()`);
          note("at0544 probe", JSON.stringify(probe));

          expect(probe).not.toBeNull();
          // A run where the observer never saw the host at all would pass the
          // blank check vacuously, so the sighting count is asserted too.
          expect(probe!.samples).toBeGreaterThan(0);
          expect(probe!.blanks).toBe(0);

          // And the settled state is still the settled state.
          const settled = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(HOSTS)})?.textContent || "").trim()`,
          );
          expect(settled).toBe(LABEL);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0544] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
