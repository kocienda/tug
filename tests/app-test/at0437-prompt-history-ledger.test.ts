/**
 * at0437-prompt-history-ledger.test.ts — every submitted prompt survives a
 * relaunch, and the retired tugbank domain carries none of them.
 *
 * The claim under test is the one the whole feature exists for: a prompt the
 * user submitted is still there tomorrow. It used to be re-serialized into the
 * boot DEFAULTS frame on every write, which forced an entry cap, a byte cap and
 * a thumbnail trim — three separate ways for a prompt to disappear without
 * anyone being told. It now appends to a machine-global SQLite ledger with no
 * retention policy at all.
 *
 * So this launches the real app, submits a batch of distinct prompts, quits,
 * relaunches into the SAME instance (which is what makes it the same
 * `prompt_history.db` — the harness stamps `TUG_PROMPT_HISTORY_DB` per
 * instance), and then asserts three things about the second launch:
 *
 *  - the ledger returns every prompt for that session, in submit order;
 *  - Up-arrow in a fresh composer recalls the newest of them;
 *  - `dev.tugapp.prompt.history` holds nothing for the session — the domain is
 *    retired and the startup migration is what emptied it.
 *
 * Count fidelity is the assertion, not paging UI: a page boundary is exercised
 * directly against the route rather than by driving twenty arrow presses.
 *
 * @covers tugrust/crates/tugcast/src/prompt_ledger.rs
 * @covers tugrust/crates/tugcast/src/prompt_history_api.rs
 * @covers tugdeck/src/lib/prompt-history-store.ts
 * @covers tugdeck/src/lib/prompt-history-api.ts
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const CARD = '[data-card-id="A"]';
const ENTRY = `${CARD} .tug-prompt-entry`;
const EDITOR_HOST = `${ENTRY} .tug-text-editor`;
const EDITOR_CONTENT = `${EDITOR_HOST} .cm-content`;

/** Enough prompts that a lost tail would be obvious, all distinct. */
const PROMPTS = Array.from(
  { length: 12 },
  (_, i) => `at0437 prompt ${String(i + 1).padStart(2, "0")}`,
);

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
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

const CARET_IN_EDITOR = `(function(){
  var el = document.activeElement;
  return el !== null && el.matches(${JSON.stringify(EDITOR_CONTENT)});
})()`;

function pressKey(app: App, key: string, opts: { meta?: boolean; shift?: boolean } = {}): Promise<null> {
  return app.evalJS<null>(
    `(function(){
      var el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)},
        metaKey: ${opts.meta === true},
        shiftKey: ${opts.shift === true},
        bubbles: true,
        cancelable: true,
      }));
      return null;
    })()`,
  );
}

/** The composer's document, read off CM6's rendered lines. */
function docText(app: App): Promise<string> {
  return app.evalJS<string>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT} .cm-line`)}))
      .map(function(l){ return l.textContent || ""; })
      .join("\\n")`,
  );
}

/**
 * Bring up card A with the caret in its composer.
 *
 * The binding is the harness default, which is what makes the session id
 * deterministic across the two launches — `test-session-A` both times, so the
 * second launch reads back exactly the corpus the first one wrote.
 */
async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A");
  await app.awaitEngineReady("A", { timeoutMs: 15_000 });
  await app.nativeClickAtElement(EDITOR_CONTENT);
  await app.waitForCondition<boolean>(CARET_IN_EDITOR, { timeoutMs: 8000 });
}

/** The session id the harness default binding uses for card A. */
const SESSION_ID = "test-session-A";

/** Read a full page of the session's ledger history through the real route. */
async function ledgerTexts(app: App, sessionId: string): Promise<string[]> {
  const raw = await app.evalJS<string>(
    `(function(){
      window.__at0437Page = "pending";
      fetch("/api/prompt-history?session=" + encodeURIComponent(${JSON.stringify(sessionId)}) + "&limit=500",
            { cache: "no-store" })
        .then(function(r){ return r.json(); })
        .then(function(b){ window.__at0437Page = JSON.stringify(b); },
              function(e){ window.__at0437Page = "err:" + e.message; });
      return "kicked";
    })()`,
  );
  expect(raw).toBe("kicked");
  const body = await app.waitForCondition<string>(
    `(function(){
      var v = window.__at0437Page;
      return (typeof v === "string" && v !== "pending") ? v : false;
    })()`,
    { timeoutMs: 15_000 },
  );
  expect(body.startsWith("err:"), `page request failed: ${body}`).toBe(false);
  const page = JSON.parse(body) as { entries: { text: string }[] };
  return page.entries.map((e) => e.text);
}

describe.skipIf(!SHOULD_RUN)("at0437 — the prompt corpus survives relaunch, uncapped", () => {
  test(
    "every submitted prompt is recallable after a relaunch, and tugbank holds none of them",
    async () => {
      // One instance id across both launches: that is what makes the second
      // launch open the same prompt_history.db the first one wrote.
      // Both launches share one instance id, which is what makes them share a
      // `prompt_history.db`. It has to stay inside the recipe's worktree-scoped
      // id family or the harness's sweeps won't recognize it as theirs.
      const idPrefix = process.env.TUG_APPTEST_ID_PREFIX ?? "apptest";
      const instanceId = `${idPrefix}-at0437-${randomUUID()}`;
      const sessionId = SESSION_ID;

      const first = await launchTugApp({
        testName: "at0437-prompt-history-submit",
        instanceId,
      });
      try {
        await openCard(first);

        for (const prompt of PROMPTS) {
          await first.nativeType(prompt);
          await first.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent.indexOf(${JSON.stringify(prompt)}) !== -1`,
            { timeoutMs: 8000 },
          );
          // Return inserts a newline in this composer; Shift-Return submits.
          await pressKey(first, "Enter", { shift: true });
          await first.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}).textContent.indexOf(${JSON.stringify(prompt)}) === -1`,
            { timeoutMs: 15_000 },
          );
        }

        // The appends are awaited on the wire, so the corpus is complete
        // before the quit — but read it here anyway, so a later failure can be
        // told apart from a submit that never landed in the first place.
        const beforeQuit = await ledgerTexts(first, sessionId);
        expect(beforeQuit).toEqual(PROMPTS);
      } finally {
        await first.close();
      }

      const second = await launchTugApp({
        testName: "at0437-prompt-history-recall",
        instanceId,
      });
      try {
        // (a) The whole corpus is there, in submit order. A cap, a trim, or a
        // rewind truncation would show up here as a short list.
        expect(await ledgerTexts(second, sessionId)).toEqual(PROMPTS);

        await openCard(second);

        // (b) Up-arrow in a fresh composer recalls the newest prompt. The
        // window has to have paged in from the ledger for this to land, so it
        // also pins that the first page is fetched on composer mount.
        const newest = PROMPTS[PROMPTS.length - 1];
        await second.waitForCondition<boolean>(
          `(function(){
            var el = document.activeElement || document.body;
            el.dispatchEvent(new KeyboardEvent("keydown", {
              key: "ArrowUp", metaKey: true, bubbles: true, cancelable: true,
            }));
            return Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT} .cm-line`)}))
              .map(function(l){ return l.textContent || ""; })
              .join("\\n") === ${JSON.stringify(newest)};
          })()`,
          { timeoutMs: 20_000 },
        );
        expect(await docText(second)).toBe(newest);

        // (c) The retired domain carries nothing for this session. A 404 is
        // the expected answer; a 200 must at least not be carrying entries.
        const domainState = await second.evalJS<string>(
          `(function(){
            window.__at0437Domain = "pending";
            fetch("/api/defaults/dev.tugapp.prompt.history/" + encodeURIComponent(${JSON.stringify(sessionId)}),
                  { cache: "no-store" })
              .then(function(r){
                if (r.status === 404) { window.__at0437Domain = "absent"; return null; }
                return r.json().then(function(b){
                  var v = b && b.value;
                  window.__at0437Domain = (Array.isArray(v) && v.length === 0) ? "absent" : "present:" + JSON.stringify(v).slice(0, 200);
                });
              }, function(e){ window.__at0437Domain = "err:" + e.message; });
            return "kicked";
          })()`,
        );
        expect(domainState).toBe("kicked");
        expect(
          await second.waitForCondition<string>(
            `(function(){
              var v = window.__at0437Domain;
              return (typeof v === "string" && v !== "pending") ? v : false;
            })()`,
            { timeoutMs: 15_000 },
          ),
          "the retired tugbank domain must carry no history for this session",
        ).toBe("absent");
      } finally {
        await second.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
