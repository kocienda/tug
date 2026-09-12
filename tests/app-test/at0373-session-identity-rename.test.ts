/**
 * at0373-session-identity-rename.test.ts — one resolver, and it is reactive.
 *
 * ## What this gates
 *
 * `resolveSessionIdentity` reads three stores imperatively. Called bare from a
 * render it hands back a snapshot with **no subscription**, so a `/rename`
 * would update the stores while the surface repaints never. That failure is
 * invisible to every unit test in `session-identity.test.ts` — the derivation
 * is correct, the wiring is not — which is why the hook's contract can only be
 * pinned against the real app.
 *
 *   A. **A Session pane's title bar reads the session's identity line, and
 *      nothing else.** No `(branch)` suffix — the branch left identity and is
 *      telemetry now — and the callsign run wears the `project/` prefix ([P05]
 *      amendment): the bar spells `tugtool/stocky-pixie`, the same Line string
 *      the tab strip and the Window menu read, so one glance says which
 *      project the session works against.
 *
 *   B. **An identity change repaints a live surface with no reload.** The
 *      change arrives the way the wire delivers it — a real `session_updated`
 *      frame through `dispatchAction`, the production decoder and the
 *      production store writes — and the mounted Cards session row and title
 *      bar must repaint from it. The change used is the ledger's callsign
 *      **reroll**, which is a real shipping event: a collided mint is rerolled
 *      rather than suffixed, so a callsign shown "from the drop" changes once,
 *      seconds after spawn. A bare-resolver implementation fails here and only
 *      here.
 *
 *   C. **A `/rename` LEADS the title, and the callsign follows it.** The user's
 *      own name outranks a callsign Tug minted for itself, so it takes the front
 *      of the title on every graphical surface — and the callsign stays beside
 *      it, because that is the permanent citable handle a rename never changes.
 *      Two runs, sized separately, on the same live mounted row. The Line
 *      string's own constancy across a rename is a pure function and is pinned in
 *      `lib/__tests__/session-identity.test.ts`.
 *
 *   D. **The row's DESCRIPTION is the markdown pipeline's rendering, and the
 *      filter's mark is painted onto it.** The rail shows the same sentence
 *      the Session card's masthead does and renders it the same way ([B01] of
 *      the narration-one brief): a backticked path is a `<code>` run and no
 *      literal backtick survives in the line. That DOM is written by the
 *      parse and the annotator, with no render-time seam to nest a `<mark>`
 *      into, so the filter's mark on it is DOM Ranges in the registered
 *      `tug-filter-mark` highlight rather than an element ([B08]) — the same
 *      walk and the same matcher transcript Find and the row's other marked
 *      runs use.
 *
 * The per-run filter mark on the TITLE is still not asserted here: it is
 * enforced by construction — `TugSessionIdentity` highlights each run
 * separately and never sees a joined string.
 *
 * @covers tugdeck/src/lib/session-identity.ts
 * @covers tugdeck/src/lib/session-synopsis-store.ts
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/filter-mark-painter.ts
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT_DIR = "/Users/tester/src/tugtool";
const TAG = "stocky-pixie";
/** What the ledger sends when it rerolls a collided mint ([P12]). */
const REROLLED_TAG = "syrupy-beam";
/** The user's own name for the session, from `/rename`. */
const RENAME = "Refactor the imposer";
const CARDS_ROW = ".cards-list .cards-row[data-session-id]";
/** The row's middle line — the description, which carries the newest post. */
const CARDS_DESCRIPTION = `${CARDS_ROW} .tug-session-row-description`;
/** The Cards card's own filter field. */
const CARDS_FILTER = '.cards-card [data-testid="cards-filter"] input';
// Scoped to the session pane by id: the Cards card is a pane too, and once it is
// open an unscoped query would read ITS title bar.
const TITLE_BAR = '.tug-pane[data-pane-id="p1"] [data-slot="tug-pane-title-bar"]';

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
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

/** A `session_updated` frame body — exactly what the supervisor pushes. */
function sessionUpdated(fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SESSION_ID, fields });
}

/** One DIGEST frame, kinded — which is what puts the turn in flight, and a
 *  turn in flight is what makes the newest post the description's rung. */
function digestFrame(text: string, beat: number): string {
  return JSON.stringify({
    type: "digest",
    text,
    scopes: [SESSION_ID],
    beat,
    at: Date.now(),
    kind: "tool",
  });
}

/** One Observer post about this session, as the OVERVIEW feed carries it. */
function observerPost(body: string, id: number): string {
  return JSON.stringify({
    id,
    at_ms: Date.now(),
    author: "observer",
    session_id: SESSION_ID,
    body,
    refs: [],
  });
}

/** A path the post backticks, as an agent writes one. */
const POST_PATH = "src/lib/layout-imposer.ts";
/**
 * The post the description carries. Its subject word is one the row's TITLE
 * carries too — the rail filters a row on its title, callsign and directory
 * and never on its description, so only a term that does both keeps the row
 * AND has something to mark in the line under test.
 */
const POST_BODY = `Taught the imposer to read its own ceiling in \`${POST_PATH}\` before it allocates the wall.`;
const FILTER_TERM = "imposer";

/** Type into a filter field the way a keystroke does (React sees a change). */
function typeFilter(
  app: { evalJS<T>(s: string): Promise<T> },
  selector: string,
  text: string,
): Promise<null> {
  return app.evalJS<null>(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("filter input not found");
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return null;
  })()`);
}

describe.skipIf(!SHOULD_RUN)("at0373 — session identity is one resolver, subscribed", () => {
  test(
    "the callsign leads and a rename repaints without a reload",
    async () => {
      const app = await launchTugApp({
        testName: "at0373-session-identity-rename",
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });

        // The callsign arrives the way it always does: on the ledger row. This
        // is the same frame a spawn ack echoes, so the store write is
        // production, not a seed.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              sessionUpdated({ tag: TAG, name: null, name_user_set: false }),
            )})`,
          ),
        ).toBe(true);

        // ---- A. The title bar is the session name, and nothing else. -------
        await app.waitForCondition<boolean>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
            return bar !== null && bar.innerText.indexOf("${TAG}") !== -1;
          })()`,
          { timeoutMs: 15_000 },
        );
        const barText = await app.evalJS<string>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
            return bar === null ? "" : bar.innerText;
          })()`,
        );
        // The `(branch)` suffix is retired outright — not merely dropped on
        // `main`, which is what the old rule did and what would still pass a
        // test that only checked for the word "main".
        expect(barText).toContain(TAG);
        expect(barText).not.toContain("(");
        // The `project/` prefix leads the callsign run ([P05] amendment): the
        // bar spells the same `project/callsign` Line the tab strip and the
        // Window menu read, so a glance across cards says which project each
        // session works against.
        expect(barText).toContain(`tugtool/${TAG}`);
        // The UUID never leads, and never appears at all in a name.
        expect(barText).not.toContain(SESSION_ID);

        // ---- B. A rename repaints a live surface. --------------------------
        //
        // The Cards card is open and its session row is mounted, so this is a live
        // subscription being exercised, not a remount.
        await app.dispatchControlAction("toggle-cards");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARDS_ROW)}) !== null`,
          { timeoutMs: 15_000 },
        );
        const lineBefore = await app.evalJS<string>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(CARDS_ROW)});
            var t = row.querySelector(".tug-list-row-title");
            return t === null ? "" : t.innerText;
          })()`,
        );
        expect(lineBefore).toContain(TAG);

        // The ledger rerolls a collided mint rather than suffixing it, so a
        // callsign shown "from the drop" legitimately changes ONCE, seconds
        // after spawn. That is a real shipping identity change on a live
        // surface, arriving on the same frame and travelling the same
        // subscription a `/rename` does — which makes it the assertion the
        // hook's contract can actually be pinned with.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              sessionUpdated({ tag: REROLLED_TAG, name: null, name_user_set: false }),
            )})`,
          ),
        ).toBe(true);

        // No reload, no remount: the same mounted row repaints. A bare
        // resolver called from the render body passes every unit test and
        // hangs here until the timeout.
        await app.waitForCondition<boolean>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(CARDS_ROW)});
            if (row === null) return false;
            var t = row.querySelector(".tug-list-row-title");
            return t !== null && t.innerText.indexOf("${REROLLED_TAG}") !== -1;
          })()`,
          { timeoutMs: 8_000 },
        );
        // The title bar rides the same hook through the card's publication.
        await app.waitForCondition<boolean>(
          `(function(){
            var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
            return bar !== null && bar.innerText.indexOf("${REROLLED_TAG}") !== -1;
          })()`,
          { timeoutMs: 8_000 },
        );

        // ---- C. A `/rename` REPLACES the title's callsign run. -------------
        //
        // The user's own name outranks a callsign Tug minted for itself, and
        // under [D141] the name REMOVES the callsign from the title rather
        // than leading it — the callsign stays the citable handle in the
        // tooltip, the citation, and every copy path, and it returns to the
        // title only when two sessions collide on one custom name. One run,
        // on the same live mounted row, with no reload.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              sessionUpdated({
                tag: REROLLED_TAG,
                name: RENAME,
                name_user_set: true,
              }),
            )})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(CARDS_ROW)});
            if (row === null) return false;
            var name = row.querySelector(".tug-session-identity-name");
            return name !== null && name.innerText.indexOf(${JSON.stringify(RENAME)}) !== -1;
          })()`,
          { timeoutMs: 8_000 },
        );
        const runs = await app.evalJS<{ name: string; callsigns: number }>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(CARDS_ROW)});
            var name = row.querySelector(".tug-session-identity-name");
            return {
              name: name === null ? "" : name.innerText,
              callsigns: row.querySelectorAll(".tug-session-identity-callsign").length,
            };
          })()`,
        );
        // The name alone: no callsign run, no residue — removal, not
        // truncation ([D141]). No other session shares this name, so the
        // collision exception does not fire.
        expect(runs.name).toContain(RENAME);
        expect(runs.callsigns).toBe(0);
        // The Line string the pane-title channel carries is a different, and
        // deliberately CONSTANT, thing: `sessionIdentityLine` has no name arm, so
        // the tab strip and the Window menu read the same string before and after
        // a rename. That is a pure function and is pinned in
        // `lib/__tests__/session-identity.test.ts`; asserting it here would need
        // a surface that still shows it, and a masthead pane's bar does not.

        // ---- D. The description renders through the markdown pipeline, and
        //         the filter paints its mark onto what the pipeline built. ---
        //
        // The description's ladder climbs to the newest Observer post only
        // while a turn is in flight, so the beat comes first and the post
        // after it — the same two doors at0551 and at0561 use.
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame("Reading the imposition allocator", 1),
          )})`,
        );
        await app.evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(
            observerPost(POST_BODY, 1),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var line = document.querySelector(${JSON.stringify(CARDS_DESCRIPTION)});
            return line !== null && line.querySelector('code') !== null;
          })()`,
          { timeoutMs: 20_000 },
        );
        const ink = JSON.parse(
          await app.evalJS<string>(`JSON.stringify((function(){
            var line = document.querySelector(${JSON.stringify(CARDS_DESCRIPTION)});
            var code = line.querySelector('code');
            return {
              codeInk: code === null ? null : (code.textContent || ""),
              // Spelled rather than written: this probe is a template literal.
              backticks: (line.textContent || "")
                .split(String.fromCharCode(96)).length - 1,
            };
          })())`),
        ) as Record<string, unknown>;
        // The rail's line is the masthead's line: backticks consumed into a
        // code run, on the same call ([B01], [B02]).
        expect(ink.codeInk, "the backticked path is a <code> run").toBe(POST_PATH);
        expect(ink.backticks, "the line spells no backtick").toBe(0);

        // The filter's term is one the row's title carries, so the row stays;
        // it occurs in the description too, which is what there is to mark.
        await typeFilter(app, CARDS_FILTER, FILTER_TERM);
        await app.waitForCondition<boolean>(
          `(function(){
            var hl = (typeof CSS === "undefined" || CSS.highlights === undefined)
              ? null : CSS.highlights.get("tug-filter-mark");
            return hl !== null && hl !== undefined && hl.size > 0;
          })()`,
          { timeoutMs: 10_000 },
        );
        const marks = JSON.parse(
          await app.evalJS<string>(`JSON.stringify((function(){
            var line = document.querySelector(${JSON.stringify(CARDS_DESCRIPTION)});
            var hl = CSS.highlights.get("tug-filter-mark");
            var inside = 0;
            Array.prototype.forEach.call(Array.from(hl), function (range) {
              var node = range.startContainer;
              var el = node.nodeType === 1 ? node : node.parentElement;
              if (el !== null && line !== null && line.contains(el)) inside += 1;
            });
            return {
              rowPresent: line !== null,
              painted: inside,
              // The composed mark cannot reach this run at all, and must not
              // have been nested into it by some second painter ([B08]).
              nested: line === null ? -1 : line.querySelectorAll('mark').length,
              // The row's own title still wears the composed mark — the two
              // kinds of mark coexist on one row, which is the arrangement.
              titleMarks: document.querySelectorAll(
                ${JSON.stringify(CARDS_ROW)} + ' .tug-list-row-title mark').length,
            };
          })())`),
        ) as Record<string, number | boolean>;
        note("at0373 rail description marks", JSON.stringify(marks));
        expect(marks.rowPresent, "the term keeps the row").toBe(true);
        expect(marks.painted, "the filter's mark is painted on the description")
          .toBeGreaterThan(0);
        expect(marks.nested, "no <mark> was nested into the rendered line").toBe(0);
        expect(marks.titleMarks, "the title keeps the composed mark")
          .toBeGreaterThan(0);

        // Clearing the field retires the paint rather than leaving a highlight
        // registered under a name every rail row feeds.
        await typeFilter(app, CARDS_FILTER, "");
        await app.waitForCondition<boolean>(
          `(function(){
            var hl = CSS.highlights.get("tug-filter-mark");
            return hl === undefined || hl === null || hl.size === 0;
          })()`,
          { timeoutMs: 10_000 },
        );

      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
