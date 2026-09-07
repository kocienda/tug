/**
 * at0534-overview-history.test.ts — the Overview's prompt history.
 *
 * The user's note, verbatim: "It needs a *history*, just like we offer history
 * support for prompt-entry components in session cards." The gesture set was
 * never missing — the substrate's keymap carries Cmd-Up / Cmd-Down at the
 * document edges and Opt-Up / Opt-Down as a position-independent walk, and it
 * walks whatever provider the host passes. The Overview passed none. So this
 * exercises the wiring, not the keymap: a provider over the shared
 * `PromptHistoryStore`, keyed on the Overview's own synthetic session and its
 * own route.
 *
 * Three claims:
 *
 *  1. **The walk reaches the Overview's own questions.** Two questions asked
 *     from the rail, then Cmd-Up twice and Cmd-Down once, and the field reads
 *     what was asked, in order. Opt-Up walks the same corpus from a caret
 *     that is not at an edge, which is the gesture's whole reason for
 *     existing beside Cmd-Up.
 *  2. **The corpus is the Overview's, never a session's.** Read back off the
 *     real ledger through the real route: every row the walk can reach is
 *     keyed `(session "overview", route "overview")`, which is disjoint from
 *     the `(session id, "❯")` a session card writes. That is a property of
 *     the KEY rather than of what happens to be on this machine, and it is
 *     what makes "never a session's" true without standing one up.
 *  3. **A recalled question carrying an image is resubmittable.** The
 *     Overview sends its bytes inline in the question frame, so no upload
 *     receipt exists to complete a history row from — the answering post is
 *     the receipt, and its `attachments` name where tugcast rested each
 *     picture. Recall then reads those back, so the strip fills with real
 *     pixels and the send goes out again with the image attached. A tile with
 *     `naturalWidth > 0` on the SECOND question post is the assertion,
 *     because pixels at that end are the only evidence the whole chain held.
 *
 * Nothing here is stubbed: the real ledger, the real HTTP route, the real
 * fold. Under the app-test gate the agent pool answers nothing, so the
 * Operator's reply is the transient "couldn't answer" post — which is all
 * this test needs, since what it watches is the question's own round trip.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/lib/overview-card-id.ts
 * @covers tugdeck/src/lib/prompt-history-store.ts
 * @covers tugdeck/src/lib/prompt-history-api.ts
 * @covers tugdeck/src/components/tugways/cards/use-session-card-services.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/keymap.ts
 * @covers tugrust/crates/tugcast/src/prompt_history_api.rs
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const CARD = '[data-testid="overview-card"]';
const POST = `${CARD} .overview-cell`;
const FIELD = '[data-testid="overview-composer-field"]';
const CONTENT = `${FIELD} .cm-content`;
const COMPOSE_STRIP = '[data-testid="overview-composer-attachment-strip"]';

/** The synthetic session and the route the Overview's rows are keyed under. */
const OVERVIEW_SESSION = "overview";
const OVERVIEW_ROUTE = "overview";

const FIRST = "what did the observer see this morning";
const SECOND = "and what did it do about it";

/**
 * The composer's current text, placeholder excluded — CM6 draws the
 * placeholder inside `.cm-content`, so a bare `textContent` on an empty field
 * reads back the prompt rather than the empty string.
 */
const FIELD_TEXT = `(function(){
  var c = document.querySelector(${JSON.stringify(CONTENT)});
  if (c === null) return "";
  var clone = c.cloneNode(true);
  Array.prototype.forEach.call(
    clone.querySelectorAll(".cm-placeholder"),
    function (p) { p.remove(); },
  );
  return (clone.textContent || "").trim();
})()`;

/** How many user posts the column is showing. */
const USER_POSTS = `document.querySelectorAll(${JSON.stringify(
  `${POST}[data-author="user"]`,
)}).length`;

/** Open the rail and wait for the composer. */
async function openRail(app: App): Promise<void> {
  await app.nativeKey("o", ["cmd", "ctrl"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(FIELD)}) !== null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * Ask one question and wait for the round trip to finish — the user echo AND
 * the Operator's reply, because the field is disabled while an answer is
 * outstanding and the next question cannot be typed until it clears.
 */
async function ask(app: App, question: string, expectUserPosts: number): Promise<void> {
  await app.nativeClickAtElement(FIELD);
  await app.nativeType(question);
  await app.waitForCondition<boolean>(
    `${FIELD_TEXT}.indexOf(${JSON.stringify(question.slice(0, 12))}) !== -1`,
    { timeoutMs: 8_000 },
  );
  // ⇧⏎ at the shipped `newline` Return policy — the chord the send button
  // wears on its ring.
  await app.nativeKey("Return", ["shift"]);
  await app.waitForCondition<boolean>(
    `${USER_POSTS} === ${expectUserPosts}`,
    { timeoutMs: 20_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(FIELD)}).getAttribute("aria-disabled") !== "true" &&
     document.querySelector(${JSON.stringify(`${CARD} [data-testid="overview-pending-row"]`)}) === null`,
    { timeoutMs: 30_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0534 — the Overview remembers what was asked", () => {
  test(
    "the walk reaches the Overview's own questions, and only those",
    async () => {
      const app = await launchTugApp({ testName: "at0534-overview-history" });
      try {
        await openRail(app);
        await ask(app, FIRST, 1);
        await ask(app, SECOND, 2);

        // The field is empty after a submit, and the cursor is back at the
        // end of the list — so the first Cmd-Up is the most recent question
        // rather than wherever a previous walk had left off.
        expect(await app.evalJS<string>(FIELD_TEXT)).toBe("");

        await app.nativeClickAtElement(FIELD);
        await app.nativeKey("ArrowUp", ["cmd"]);
        await app.waitForCondition<boolean>(
          `${FIELD_TEXT} === ${JSON.stringify(SECOND)}`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("ArrowUp", ["cmd"]);
        await app.waitForCondition<boolean>(
          `${FIELD_TEXT} === ${JSON.stringify(FIRST)}`,
          { timeoutMs: 8_000 },
        );
        // Forward with Opt-Down rather than Cmd-Down, and that is the
        // gesture's own rule rather than a convenience: a `back` lands the
        // caret at index 0 so the next Cmd-Up keeps walking, which leaves the
        // caret nowhere near the END boundary Cmd-Down asks for — so the
        // first Cmd-Down there moves the caret and the second walks. Opt-Down
        // is the position-independent half of the pair and walks from where
        // the caret happens to be.
        await app.nativeKey("ArrowDown", ["alt"]);
        await app.waitForCondition<boolean>(
          `${FIELD_TEXT} === ${JSON.stringify(SECOND)}`,
          { timeoutMs: 8_000 },
        );
        note("walked back and forward", await app.evalJS<string>(FIELD_TEXT));

        // And Opt-Up backward from a caret that is nowhere near an edge —
        // which is what distinguishes the Opt pair from the Cmd pair. Park
        // the caret mid-line first, so a pass here cannot be Cmd-Up's own
        // rule wearing another chord.
        await app.evalJS<boolean>(`(function(){
          var view = document.querySelector(${JSON.stringify(CONTENT)});
          if (view === null) return false;
          var sel = window.getSelection();
          var node = view.firstChild;
          while (node !== null && node.nodeType !== 3) node = node.firstChild;
          if (node === null) return false;
          var r = document.createRange();
          var at = Math.min(3, node.length);
          r.setStart(node, at); r.setEnd(node, at);
          sel.removeAllRanges(); sel.addRange(r);
          return true;
        })()`);
        await app.nativeKey("ArrowUp", ["alt"]);
        await app.waitForCondition<boolean>(
          `${FIELD_TEXT} === ${JSON.stringify(FIRST)}`,
          { timeoutMs: 8_000 },
        );

        // ── 2. The corpus is keyed as the Overview's own. ─────────────────
        // The real route, the real ledger. Every row the Overview's provider
        // can reach carries this session and this route — the pair a session
        // card's `(session id, "❯")` can never collide with.
        expect(
          await app.evalJS<boolean>(`(function(){
            window.__at0534Rows = null;
            fetch("/api/prompt-history?session=" +
              encodeURIComponent(${JSON.stringify(OVERVIEW_SESSION)}) + "&limit=50",
              { cache: "no-store" })
              .then(function (r) { return r.json(); })
              .then(function (b) {
                window.__at0534Rows = (b.entries || []).map(function (e) {
                  return { session_id: e.session_id, route: e.route, text: e.text };
                });
              });
            return true;
          })()`),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `window.__at0534Rows !== null`,
          { timeoutMs: 10_000 },
        );
        const rows = await app.evalJS<
          Array<{ session_id: string; route: string; text: string }>
        >(`window.__at0534Rows`);
        note("ledger rows", JSON.stringify(rows));
        expect(rows.length).toBeGreaterThanOrEqual(2);
        for (const row of rows) {
          expect(row.session_id).toBe(OVERVIEW_SESSION);
          expect(row.route).toBe(OVERVIEW_ROUTE);
        }
        // And the questions that were asked are in there, as asked.
        const texts = rows.map((r) => r.text);
        expect(texts).toContain(FIRST);
        expect(texts).toContain(SECOND);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a recalled question carrying an image is sent again with the image",
    async () => {
      const app = await launchTugApp({
        testName: "at0534-overview-history-image",
      });
      try {
        await openRail(app);

        // A real PNG through the real pipeline — the substrate downsamples
        // it, stages the bytes, and drops an `image-1` chip at the caret.
        await app.evalJS<void>(
          `(function () {
            window.__at0534Dropped = false;
            var host = document.querySelector(${JSON.stringify(FIELD)});
            var canvas = document.createElement("canvas");
            canvas.width = 48;
            canvas.height = 32;
            var ctx = canvas.getContext("2d");
            ctx.fillStyle = "#3f5f8f";
            ctx.fillRect(0, 0, 48, 32);
            ctx.fillStyle = "#eef3fa";
            ctx.fillRect(6, 6, 36, 20);
            canvas.toBlob(function (blob) {
              var file = new File([blob], "shot.png", { type: "image/png" });
              var dt = new DataTransfer();
              dt.items.add(file);
              var r = host.getBoundingClientRect();
              var ev = new DragEvent("drop", {
                bubbles: true, cancelable: true,
                clientX: r.left + r.width / 2, clientY: r.top + 8,
              });
              Object.defineProperty(ev, "dataTransfer", { value: dt });
              host.dispatchEvent(ev);
              window.__at0534Dropped = true;
            }, "image/png");
          })()`,
        );
        await app.waitForCondition<boolean>(`window.__at0534Dropped === true`, {
          timeoutMs: 8_000,
        });
        await app.waitForCondition<boolean>(
          `(function () {
            var img = document.querySelector(${JSON.stringify(
              `${COMPOSE_STRIP} .tug-attachment-preview__thumb-img`,
            )});
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 20_000 },
        );

        await ask(app, "what is this", 1);

        // The strip is empty again — the bytes went with the question and
        // this composer stopped holding them.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSE_STRIP)}) === null`,
          { timeoutMs: 10_000 },
        );

        // ── Recall. The row's image atom was path-less at submit; the
        // answering post carried the rested path and completed it, so the
        // recall reads real bytes back rather than a severed marker.
        await app.nativeClickAtElement(FIELD);
        await app.nativeKey("ArrowUp", ["cmd"]);
        await app.waitForCondition<boolean>(
          `(function () {
            var img = document.querySelector(${JSON.stringify(
              `${COMPOSE_STRIP} .tug-attachment-preview__thumb-img`,
            )});
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 30_000 },
        );
        const recalled = await app.evalJS<{ text: string; width: number }>(
          `(function () {
            var img = document.querySelector(${JSON.stringify(
              `${COMPOSE_STRIP} .tug-attachment-preview__thumb-img`,
            )});
            return { text: ${FIELD_TEXT}, width: img === null ? 0 : img.naturalWidth };
          })()`,
        );
        note("recalled question", JSON.stringify(recalled));
        expect(recalled.text).toContain("what is this");
        // Pixels, not a placeholder: the difference between a recall that is
        // legible and one that can be sent again.
        expect(recalled.width).toBeGreaterThan(0);

        // ── And it goes out again, image and all. ─────────────────────────
        await app.nativeKey("Return", ["shift"]);
        await app.waitForCondition<boolean>(`${USER_POSTS} === 2`, {
          timeoutMs: 20_000,
        });
        await app.waitForCondition<boolean>(
          `(function () {
            var rows = document.querySelectorAll(${JSON.stringify(
              `${POST}[data-author="user"]`,
            )});
            var last = rows[rows.length - 1];
            if (last === undefined) return false;
            var img = last.querySelector(".tug-attachment-preview__thumb-img");
            return img !== null && img.complete && img.naturalWidth > 0;
          })()`,
          { timeoutMs: 30_000 },
        );
        note("resubmitted", "the second question post carries its own tile");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
