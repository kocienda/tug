/**
 * at0590-workspace-delete-crash.test.ts — deleting a workspace full of live
 * sessions throws nothing.
 *
 * A red error banner reading `undefined is not an object (evaluating
 * 't.type')` is what a person sees when they delete a workspace holding their
 * work. Three throwaway probes went looking for it and came back green — a
 * parked workspace with a clean Text card, the active workspace with the
 * same, and a workspace holding an UNBOUND session card — which is why this
 * file exists as a permanent test rather than a fourth probe: the shape that
 * throws is worth keeping once it is found.
 *
 * This shape is the user's own case at its longest. The doomed workspace
 * holds **two bound session cards** and is the **active** one, so
 * `runGuardedDelete` reads `arriving` false and runs neither the activation
 * nor the arrival wait: `closeGuardWalk` and `store.deleteSpace` go
 * SYNCHRONOUSLY inside the confirm's own click, in the same turn the
 * popover's teardown pops its focus mode in. It also sits in the **middle**
 * of three, so the splice takes out an index the workspace after it is still
 * numbered against. The focus-mode pop's write notifies subscribers
 * synchronously; the Workspaces card's list re-renders inside the delete, and
 * a cell drawn against an index the projection no longer holds is exactly the
 * throw.
 *
 * The workspaces are restored from a seeded tugbank rather than made with the
 * verb: `createSpace` mounts what it makes, and the shapes this fixture was
 * walked through before this one needed a workspace never stood up. The two
 * cards are bound through `cardSessionBindingStore`, which is keyed by card
 * id and needs no mounted host — which is what lets an unmounted workspace
 * hold bound cards at all.
 *
 * Two things are asserted and the second is not the interesting one. The
 * recorder has to be empty — and it is armed on FOUR channels rather than the
 * two the plan named, because those two cannot see this crash at all: a
 * render error is swallowed by `ErrorBoundary.getDerivedStateFromError`, so
 * React never rethrows and neither `window.onerror` nor `unhandledrejection`
 * ever fires. `console.error` and the `TugBanner` the boundary paints are the
 * channels that carry it, and the banner is the user's own observable. The
 * arming is proven before it is trusted — `proveRecorder` fires a real Error
 * and appends a real banner and checks both were seen. Then the workspace is
 * gone, so a delete that threw its way to silence by not deleting anything
 * cannot pass.
 *
 * The recorder's contents are `note()`d unconditionally: a failure here is
 * only useful if it carries the throw's own message and stack, and a count
 * carries neither.
 *
 * **What the reproduction attempt established, for whoever writes the fix.**
 * The crash did not reproduce under any shape tried: parked, parked-and-
 * mounted, never-mounted, behind an awaited Save sheet, mid-list of three,
 * with the list filtered, and with the doomed workspace ACTIVE so the whole
 * walk runs synchronously inside the confirm's own click. The mechanism is
 * nonetheless reachable and worth stating, and one end of it has since
 * moved. The list view subscribes to `dataSource.getVersion()` through
 * `useSyncExternalStore` while each CELL reads `dataSource.rowAt(index)` with
 * its own `index` prop, so a cell re-rendering on its own context against a
 * projection that has since got shorter is handed a row that is not there.
 * `rowAt` used to be declared `CardsRow` over a body of
 * `return this.rows[index]`, which is how that became a throw on `.type`; it
 * returns `CardsRow | undefined` now and every call site draws nothing
 * instead. **The guard is not the fix** — a list rendering against indices
 * its projection no longer holds is still the defect, and it is a silent one
 * now. Reproducing the ordering needs a gesture none available here produces;
 * the one condition still untried is a session card carrying arc sub-rows
 * from the changeset aggregate, which is fed over the wire.
 *
 * `deck-manager.ts` is the other half of what this drives — `deleteSpace` is
 * there — and is deliberately NOT declared: it sits at its recorded fan-out
 * ceiling in `ACCEPTED_FANOUT`, and that ratchet only pays down. So the
 * declaration is the surface the gesture is driven through, and the fix this
 * test earns will name whatever it actually lands on.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** Where the user is looking from — first in the list, and active. */
const HERE = "at0590-here";
/** The doomed workspace: middle of three, parked, never mounted. */
const AWAY = "at0590-away";
/** The workspace after it, whose row index the splice moves. */
const LAST = "at0590-last";

/**
 * "On screen", said out loud.
 *
 * Every visited workspace stays MOUNTED, so the document holds one Workspaces
 * card per visited workspace — all but one inside a wrapper with no
 * `data-space-shown` and no boxes. The portaled selectors (menus, confirms)
 * deliberately carry no scope: an overlay is mounted at the canvas's overlay
 * root, outside every layer.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

const HEADER = `${SHOWN}[data-testid="cards-space-header"]`;
const VERBS_BUTTON = '[data-testid="cards-space-verbs-button"]';
const DELETE_ITEM = '[data-item-action="delete-space"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_OK = '[data-slot="tug-confirm-confirm"]';
const FILTER_INPUT = `${SHOWN}.cards-card [data-testid="cards-filter"] input`;
/**
 * The term has to name a row the projection actually labels. A SESSION row is
 * labelled `<project>/<callsign>` rather than by its card title, so the two
 * bound cards cannot be filtered on by name — a Text card can, and `Zeta`
 * lives only in the doomed workspace. The list narrows to that one header and
 * that one row, and every other workspace's rows leave the projection, which
 * is the shortened list a stale index points past the end of.
 */
const FILTER_TERM = "Zeta";

const headerFor = (id: string): string =>
  `${SHOWN}.cards-space-header[data-cards-space-id="${id}"]`;

/**
 * Every row the list is holding, headers subtracted. A filter narrows the
 * ROWS and leaves every workspace's header standing — so the header count is
 * the wrong probe for "the projection got shorter" and this is the right one.
 */
const ROWS = `${SHOWN}.cards-list [data-cards-space-run]:not([data-testid="cards-space-header"])`;

const settle = (ms = 450): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface SpacesProbe {
  activeSpaceId: string;
  spaces: { id: string; name: string; active: boolean }[];
}

/**
 * The mounted workspaces, read where they are observable. The store's own
 * snapshot carries `mountedSpaceIds` but `diag.getSpaces` does not project it
 * — and a mounted workspace is exactly one with a layer element in the
 * document, so the DOM answers the same question without widening a
 * diagnostic surface for one test.
 */
const MOUNTED_LAYERS = `Array.prototype.map.call(
  document.querySelectorAll("[data-space-layer]"),
  function (el) { return el.getAttribute("data-space-layer"); }
)`;

/** One recorded throw, however it reached the window. */
interface Caught {
  kind: "error" | "rejection";
  message: string;
  stack: string;
}

function rail(id: string, cardId: string): Record<string, unknown> {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 420, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [] as string[],
  };
}

function sessionPane(
  id: string,
  cardId: string,
  offset: number,
): Record<string, unknown> {
  return {
    id,
    position: { x: 60 + offset, y: 60 + offset },
    size: { width: 700, height: 500 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
  };
}

const IMPOSITION = {
  kind: "one-up",
  sidebars: { cards: { side: "right" } },
};

/**
 * Three workspaces, each standing its own Workspaces rail. `HERE` is first
 * and active; `AWAY` is the middle one and holds the two Session cards;
 * `LAST` is after it, so the splice moves an index that is still being
 * rendered against.
 */
function threeSpaceBlob(): Record<string, unknown> {
  const plain = (id: string, name: string, cardId: string, paneId: string) => ({
    id,
    name,
    deck: {
      cards: [
        { id: cardId, componentId: "cards", title: "Workspaces", closable: true },
      ],
      panes: [rail(paneId, cardId)],
      activePaneId: paneId,
      imposition: IMPOSITION,
      hasFocus: true,
    },
  });
  return {
    version: 5,
    // AWAY is ACTIVE, and that is the shape: `runGuardedDelete` reads
    // `arriving` false, so it neither activates nor awaits arrival, and
    // `closeGuardWalk` and `store.deleteSpace` run SYNCHRONOUSLY inside the
    // confirm's own click — the same turn the popover's teardown pops its
    // focus mode in. Every earlier probe deleted a workspace it had to
    // activate first, which puts the splice in a later task and takes the
    // collision apart.
    activeSpaceId: AWAY,
    spaces: [
      plain(HERE, "Here", "CH", "pch"),
      {
        id: AWAY,
        name: "Away",
        deck: {
          cards: [
            { id: "CA", componentId: "cards", title: "Workspaces", closable: true },
            { id: "S1", componentId: "session", title: "S1", closable: true },
            { id: "S2", componentId: "session", title: "S2", closable: true },
            { id: "Z", componentId: "text", title: "Zeta", closable: true },
          ],
          panes: [
            rail("pca", "CA"),
            sessionPane("ps1", "S1", 0),
            sessionPane("ps2", "S2", 20),
            sessionPane("pz", "Z", 40),
          ],
          activePaneId: "ps1",
          imposition: IMPOSITION,
          hasFocus: true,
        },
      },
      plain(LAST, "Last", "CL", "pcl"),
    ],
  };
}

/**
 * Arm every channel the crash could arrive on, into one array.
 *
 * The two the plan named are the two that cannot see it. A render error is
 * caught by `ErrorBoundary.getDerivedStateFromError` (`error-boundary.tsx`,
 * wrapping the whole tree above `DeckCanvas`), so React never rethrows it:
 * `window.onerror` is silent, and so is `unhandledrejection`. What the
 * boundary does instead is write the Error to `console.error` from
 * `componentDidCatch`, and paint a `TugBanner` carrying the message and the
 * stack — which is the red banner the user actually reported. So the banner
 * and the console are the channels that matter here, and the plan's two are
 * kept because a throw somewhere OTHER than a render still takes them.
 */
async function armRecorder(app: App): Promise<void> {
  await app.evalJS<boolean>(
    `(function () {
       window.__at0590 = [];
       var push = function (kind, message, stack) {
         window.__at0590.push({
           kind: kind,
           message: String(message),
           stack: String(stack === undefined || stack === null ? "" : stack),
         });
       };
       window.onerror = function (message, _src, _line, _col, err) {
         push("error", message, err && err.stack);
         return false;
       };
       window.addEventListener("unhandledrejection", function (ev) {
         var r = ev.reason;
         push(
           "rejection",
           r && r.message !== undefined ? r.message : r,
           r && r.stack,
         );
       });
       // The boundary's own report. Only entries carrying a real Error are
       // taken: React writes plenty of warnings through console.error, and a
       // recorder that counts those is a recorder nobody can read.
       var realError = console.error;
       console.error = function () {
         for (var i = 0; i < arguments.length; i++) {
           var a = arguments[i];
           if (a instanceof Error) {
             push("console", a.message, a.stack);
             break;
           }
         }
         return realError.apply(console, arguments);
       };
       // The banner itself — the user's own observable, and the one channel
       // that is true by construction whatever React does above it.
       var seen = function (el) {
         var msg = el.querySelector(".tug-banner-message");
         var pre = el.querySelector(".tug-banner-detail-body");
         push(
           "banner",
           msg === null ? el.textContent : msg.textContent,
           pre === null ? "" : pre.textContent,
         );
       };
       var BANNER = '[data-slot="tug-banner"][data-variant="error"]';
       var already = document.querySelector(BANNER);
       if (already !== null) seen(already);
       new MutationObserver(function () {
         var el = document.querySelector(BANNER);
         if (el !== null && el.__at0590Seen !== true) {
           el.__at0590Seen = true;
           seen(el);
         }
       }).observe(document.body, { childList: true, subtree: true });
       return true;
     })()`,
  );
}

/**
 * Prove the recorder can see a boundary catch before trusting it to report
 * one. A green run is only worth the instrument that produced it, and this
 * file exists because three earlier probes were green on channels that could
 * not have seen the crash — so the console channel is fired deliberately and
 * the banner channel is shown a real banner element, and the recorder is
 * emptied again before the gesture.
 */
async function proveRecorder(app: App): Promise<string[]> {
  await app.evalJS<boolean>(
    `(function () {
       console.error("[ErrorBoundary]", new Error("at0590 instrument check"));
       var el = document.createElement("div");
       el.id = "at0590-instrument-check";
       el.setAttribute("data-slot", "tug-banner");
       el.setAttribute("data-variant", "error");
       el.innerHTML =
         '<div class="tug-banner-message">at0590 instrument check</div>' +
         '<div class="tug-banner-detail-body">no stack</div>';
       document.body.appendChild(el);
       return true;
     })()`,
  );
  // The banner channel is a MutationObserver, so its record is delivered on a
  // later task than the append. Read across that boundary, not inside it.
  await settle(200);
  return app.evalJS<string[]>(
    `(function () {
       var el = document.getElementById("at0590-instrument-check");
       if (el !== null) el.remove();
       var kinds = window.__at0590.map(function (c) { return c.kind; });
       window.__at0590.length = 0;
       return kinds;
     })()`,
  );
}

/**
 * Put a query in the card's filter field, the way the field's own delegate
 * hears it: the native value setter plus a bubbling `input`, which is what a
 * controlled React field reads. A narrowed projection holds fewer rows than
 * the one the cells were numbered against, which is the state a stale index
 * is most likely to point past the end of.
 */
function typeFilter(app: App, text: string): Promise<null> {
  return app.evalJS<null>(
    `(function(){
       var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
       if (el === null) throw new Error("cards filter input not found");
       el.focus();
       var setter = Object.getOwnPropertyDescriptor(
         window.HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(text)});
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return null;
     })()`,
  );
}

/** Open the `···` menu on a workspace's header and press Delete. */
async function pressDelete(app: App, spaceId: string): Promise<void> {
  await app.nativeClickAtElement(`${headerFor(spaceId)} ${VERBS_BUTTON}`);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DELETE_ITEM)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.nativeClickAtElement(DELETE_ITEM);
}

describe.skipIf(!SHOULD_RUN)(
  "at0590 — a workspace of live sessions deletes without throwing",
  () => {
    test(
      "deleting the active middle of three, holding two bound sessions, records no error",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(threeSpaceBlob()),
        );

        const app = await launchTugApp({
          testName: "at0590-workspace-delete-crash",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HEADER)}).length === 3`,
            { timeoutMs: 20_000 },
          );
          const before = await app.evalJS<SpacesProbe>(
            `window.tugdeck.diag.getSpaces()`,
          );
          const mounted = await app.evalJS<string[]>(MOUNTED_LAYERS);
          note(`at0590 mounted before: ${JSON.stringify(mounted)}`);
          expect(
            before.activeSpaceId,
            "we are looking AT the workspace we are about to delete",
          ).toBe(AWAY);
          expect(
            before.spaces.map((s) => s.id),
            "and the doomed workspace is the middle one",
          ).toEqual([HERE, AWAY, LAST]);

          // ---- The two cards are BOUND. The binding store is keyed by card
          // id and needs no mounted host, which is the only way an unmounted
          // workspace can hold bound cards at all.
          for (const cardId of ["S1", "S2"]) {
            await app.bindSession(cardId, {
              tugSessionId: `at0590-${cardId}`,
            });
          }
          await settle();

          // ---- The list is FILTERED at the moment of the delete. ----------
          const rowsBefore = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length`,
          );
          await typeFilter(app, FILTER_TERM);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ROWS)}).length < ${rowsBefore}`,
            { timeoutMs: 10_000 },
          );
          note(
            `at0590 filtered to ${JSON.stringify(FILTER_TERM)}: ` +
              `${rowsBefore} rows -> ${await app.evalJS<number>(
                `document.querySelectorAll(${JSON.stringify(ROWS)}).length`,
              )}`,
          );

          // ---- Arm, then drive the real gesture end to end. ---------------
          await armRecorder(app);
          expect(
            (await proveRecorder(app)).sort(),
            "the recorder sees a console-reported Error and a banner — proven before it is trusted",
          ).toEqual(["banner", "console"]);
          await pressDelete(app, AWAY);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement(CONFIRM_OK);
          // Either outcome ends the wait: the splice lands, or the boundary
          // catches. Waiting only on the splice would turn the very failure
          // this file exists to catch into a bare 20-second timeout carrying
          // none of the throw — and the throw is the whole point.
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.length === 2 ||
             window.__at0590.length > 0`,
            { timeoutMs: 20_000 },
          );
          // A rejection, or the banner's paint, can land a tick after the
          // splice; give it one.
          await settle(1_000);

          const caught = await app.evalJS<Caught[]>(`window.__at0590`);
          note(`at0590 recorder (${caught.length}):`);
          for (const c of caught) {
            note(`  [${c.kind}] ${c.message}`);
            if (c.stack !== "")
              note(`    ${c.stack.split("\n").join("\n    ")}`);
          }

          expect(
            caught.map((c) => `${c.kind}: ${c.message}`),
            "the delete threw nothing, on any channel",
          ).toEqual([]);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(
                 '[data-slot="tug-banner"][data-variant="error"]'
               ) !== null`,
            ),
            "and no error banner is standing — the user's own observable, read last",
          ).toBe(false);
          expect(
            await app.evalJS<string[]>(
              `window.tugdeck.diag.getSpaces().spaces.map(function (s) { return s.id; })`,
            ),
            "and the workspace is actually gone — silence by doing nothing is not a pass",
          ).not.toContain(AWAY);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
