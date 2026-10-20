
/**
 * update-tug-fixture.ts — what the at0612 update files share: the deck they
 * seed, the snapshot pushes that stand in for the host's
 * `__tugBridge.onUpdateState`, the recorder that stands in for its
 * `updateAction` handler, and the waits and readings the pill and the
 * UpdateTug wizard are judged by.
 *
 * Split out of `at0612-update-tug-wizard.test.ts` when that file was cut into
 * `at0612-update-tug-pill` (what lights the pill and what raises and lowers
 * the wizard) and `at0612-update-tug-controls` (what every control posts, and
 * what progress says) to keep each under the 20 s budget. The claims both
 * files pin are listed in the pill file's header.
 *
 * Two pages. The pill and the wizard are drawn in the overlay page
 * (`overlay-fixture.ts`), so every reading and press of them here is the
 * overlay's ({@link ui}). The host's side stays the shell's: a snapshot is
 * pushed to the shell's bridge, which relays it to the overlay, and an
 * action the overlay asks for is posted by the shell, so the recorder stands
 * in the shell's page.
 */

import { expect } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { overlayPage, overlayReady } from "./overlay-fixture";

/** The page the pill and the wizard are drawn in. */
export const ui = (app: App) => overlayPage(app);

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

/**
 * The host's reveal is a monotonic count that rides *every* snapshot, so the
 * test has to carry one too. Every push below sends the standing count unless
 * it is deliberately bumping it — a push that let the number fall back to zero
 * would read to the deck as a count it had not seen, and open the wizard by
 * accident in the middle of an assertion about something else.
 */
export let reveal = 0;
export const nextReveal = (): number => (reveal += 1);

/** The modeless notice: the whole row, badge and `x` together. */
export const PILL_ANCHOR = `[data-slot="update-pill"]`;
/** The pressable part of the pill — clicking it opens the wizard. */
export const PILL = `[data-testid="update-pill"]`;
/** The pill's `x`: takes the pill off the screen, and nothing else. */
export const PILL_HIDE = `[data-testid="update-pill-hide"]`;
/** The wizard's panel. Absent from the DOM entirely while it is closed. */
export const WIZARD = `[data-testid="update-tug"]`;
/** The four step rows, in the order they are walked. */
export const STEP_ROWS = `${WIZARD} .update-tug-steps [data-slot="tug-step-row"]`;
/** One row's CTA, addressed by the action it posts. */
export const cta = (action: string): string =>
  `${WIZARD} [data-testid="update-tug-action-${action}"]`;
/** The one bottom button: Close, or Done / Dismiss on a terminal stage. */
export const CLOSE = `[data-testid="update-tug-close"]`;
/** The download row's detail line — the whole of what progress is. */
export const PROGRESS = `[data-testid="update-tug-progress"]`;
export const BAR = `[data-testid="update-tug-bar"]`;
/** The bar's place: a strip on the plinth, never a member of the content column. */
export const ROW_EDGE = `.tug-step-row-edge`;

/** A snapshot in the shape `UpdateSnapshot.jsonObject` emits, host-side. */
export interface Payload {
  stage: string;
  version?: string;
  build?: string;
  currentVersion?: string;
  releaseNotes?: string | null;
  releaseNotesFailed?: boolean;
  userInitiated?: boolean;
  percent?: number | null;
  receivedBytes?: number;
  expectedBytes?: number;
  message?: string;
  cancellable?: boolean;
  revealCount?: number;
}

export function snapshot(stage: string, over: Partial<Payload> = {}): Payload {
  return {
    stage,
    version: "0.9.0",
    build: "900",
    currentVersion: "0.8.10",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    receivedBytes: 0,
    expectedBytes: 0,
    message: "",
    cancellable: false,
    revealCount: reveal,
    ...over,
  };
}

/** Push one snapshot the way `MainWindow.bridgeUpdateState` does. */
export async function push(app: App, payload: Payload): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onUpdateState(${JSON.stringify(payload)}), null)`,
  );
}

/**
 * Stand a recorder in front of the host's `updateAction` handler.
 *
 * Two jobs, and the second is the load-bearing one: it is how the posted action
 * names are read back, and it is what guarantees no click in this file reaches
 * the real updater. Returns the name of the mechanism that took, so a WebKit
 * that refuses the override fails here rather than by silently recording
 * nothing.
 */
export async function installActionRecorder(app: App): Promise<string> {
  // card-dom: shell — the recorder stands in the shell's page, where the update wizard posts.
  return app.evalJS<string>(
    `(function () {
       var w = window;
       w.__at0612 = { posted: [] };
       // Patch postMessage on the handler's PROTOTYPE, not the handler.
       //
       // window.webkit is unconfigurable and its messageHandlers hands back a
       // fresh handler object, so a stub written over one of them is there on
       // the write and gone on the read — which shows up as an action that
       // posted nothing, indistinguishable from a dead button. Every handler
       // shares one prototype, so patching the method there is the one seam
       // that holds.
       //
       // Recording is by value: the seven action names are the whole of what
       // the update feature posts, and no other message the deck sends is one
       // of those strings. The deck posts every payload as its JSON, so an
       // action arrives as a quoted string and is parsed before it is
       // matched; a bare name (the self-check below) is matched as it is.
       // Anything else is forwarded to the host
       // untouched, so the rest of the deck keeps working; an action name is
       // swallowed, which is what keeps a click in this file from reaching
       // Sparkle.
       var ACTIONS = ["install","later","skip","cancel","pause","resume","retry","dismiss","check"];
       var handler = w.webkit.messageHandlers.updateAction;
       var proto = Object.getPrototypeOf(handler);
       var orig = proto.postMessage;
       proto.postMessage = function (v) {
         var action = v;
         if (typeof v === "string") {
           try { action = JSON.parse(v); } catch (e) { action = v; }
         }
         if (typeof action === "string" && ACTIONS.indexOf(action) !== -1) {
           w.__at0612.posted.push(action);
           return;
         }
         return orig.apply(this, arguments);
       };
       // Self-verify: the read path the deck actually takes has to land in
       // the recorder, here, rather than midway through the run.
       w.webkit.messageHandlers.updateAction.postMessage("check");
       var ok = w.__at0612.posted.length === 1
         && w.__at0612.posted[0] === "check";
       w.__at0612.posted.length = 0;
       return ok ? "prototype-patched" : "FAILED";
     })()`,
  );
}

export async function postedActions(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`window.__at0612.posted.slice()`);
}

/**
 * The posted actions once `name` is among them. A press in the overlay posts
 * through the shell, which records it, so the post lands a hop after the
 * click rather than inside it.
 */
export async function postedOnceIncludes(app: App, name: string): Promise<string[]> {
  await app.waitForCondition<boolean>(`window.__at0612.posted.indexOf(${JSON.stringify(name)}) !== -1`, { timeoutMs: 10_000 });
  return postedActions(app);
}

export async function clearPosted(app: App): Promise<void> {
  await app.evalJS<null>(`(window.__at0612.posted.length = 0, null)`);
}

export async function elementCount(app: App, selector: string): Promise<number> {
  return ui(app).evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/** One element's box, with the window it is anchored against. */
export interface AnchoredBox {
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

/** Measure `selector`'s box against the window it is centred on. */
export async function anchoredBox(app: App, selector: string): Promise<AnchoredBox> {
  return ui(app).evalJS<AnchoredBox>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       var r = el.getBoundingClientRect();
       return {
         left: r.left,
         top: r.top,
         width: r.width,
         height: r.height,
         windowWidth: window.innerWidth,
         windowHeight: window.innerHeight,
       };
     })()`,
  );
}

/** The horizontal centre of a measured box. */
export function centreX(b: AnchoredBox): number {
  return b.left + b.width / 2;
}

/**
 * Wait until `selector` is a thing a click can actually land on.
 *
 * Present in the DOM is not the same as ready: both surfaces are laid out and
 * transition in, so a click dispatched the instant one mounts can land where the
 * element is no longer. Ready means two polls agree on the element's box AND the
 * centre of that box hit-tests back to the element itself — the box has stopped
 * moving and nothing is over it.
 */
export async function waitForClickable(app: App, selector: string): Promise<void> {
  await ui(app).evalJS<null>(`(window.__at0612 = window.__at0612 || {}, window.__at0612.box = null, null)`);
  await ui(app).waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) { window.__at0612.box = null; return false; }
       var r = el.getBoundingClientRect();
       if (r.width === 0 || r.height === 0) { window.__at0612.box = null; return false; }
       var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
       if (hit === null || !el.contains(hit)) { window.__at0612.box = null; return false; }
       var key = [r.left, r.top, r.width, r.height].join(",");
       var settled = window.__at0612.box === key;
       window.__at0612.box = key;
       return settled;
     })()`,
    { timeoutMs: 15_000, pollMs: 50 },
  );
}

/** Wait until the wizard is up, on `stage`. */
export async function waitForWizard(app: App, stage: string): Promise<void> {
  await ui(app).waitForCondition<boolean>(
    `(function () {
       var d = document.querySelector(${JSON.stringify(WIZARD)});
       return d !== null && d.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the wizard is gone. Radix animates the close, so this is a wait. */
export async function waitForWizardGone(app: App): Promise<void> {
  await ui(app).waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(WIZARD)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/** Wait until the pill is up, on `stage`. */
export async function waitForPill(app: App, stage: string): Promise<void> {
  await ui(app).waitForCondition<boolean>(
    `(function () {
       var p = document.querySelector(${JSON.stringify(PILL)});
       return p !== null && p.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** The rows' statuses, in layout order. */
export async function stepStatuses(app: App): Promise<string[]> {
  return ui(app).evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) { return r.getAttribute("data-status"); }
     )`,
  );
}

/** The rows' step keys — Check / Download / Stop work / Relaunch. */
export async function stepKeys(app: App): Promise<string[]> {
  return ui(app).evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) { return r.getAttribute("data-step"); }
     )`,
  );
}

/** The check row's detail line — the one that names the versions. */
export async function checkDetail(app: App): Promise<string> {
  return ui(app).evalJS<string>(
    `(function () {
       var row = document.querySelector(
         ${JSON.stringify(STEP_ROWS)} + '[data-step="check"]'
       );
       var el = row && row.querySelector(".tug-step-row-detail");
       return el ? (el.textContent || "").trim() : "";
     })()`,
  );
}

/** The rows' labels, which are the same four in every stage. */
export async function stepLabels(app: App): Promise<string[]> {
  return ui(app).evalJS<string[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)} + " .tug-step-row-label"),
       function (s) { return (s.textContent || "").trim(); }
     )`,
  );
}

/**
 * Put the deck back to having nothing to say: no wizard, no pill.
 *
 * The wizard is closed by hand first, because pushing `idle` only closes it
 * when the stage actually *moves*. A wizard raised by a reveal at `idle` is
 * already standing on the snapshot this function pushes, so the push is a no-op
 * and the panel would still be there — which is exactly the state the reveal
 * loop below leaves behind. On the two terminal stages that close posts
 * `dismiss`, so every caller that reads the recorder clears it after this —
 * and this waits for that `dismiss` to reach the recorder first: the overlay
 * asks it of the shell, one page hop later than the click, and a clear that
 * ran ahead of it would leave it to be read as the next gesture's.
 */
export async function goIdle(app: App): Promise<void> {
  if ((await elementCount(app, WIZARD)) > 0) {
    const stage = await ui(app).getElementAttribute(WIZARD, "data-stage");
    await clearPosted(app);
    await waitForClickable(app, CLOSE);
    await ui(app).click(CLOSE);
    await waitForWizardGone(app);
    if (stage === "upToDate" || stage === "error") {
      await app.waitForCondition<boolean>(`window.__at0612.posted.indexOf("dismiss") !== -1`, { timeoutMs: 10_000 });
    }
  }
  await push(app, snapshot("idle"));
  await ui(app).waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PILL_ANCHOR)}) === null
       && document.querySelector(${JSON.stringify(WIZARD)}) === null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * True once `ms` have passed in the page, polled rather than slept — the shape
 * for "and it is *still* there", which no single condition expresses.
 */
export async function letTimePass(app: App, ms: number): Promise<void> {
  await app.evalJS<null>(`(window.__at0612.mark = Date.now(), null)`);
  await app.waitForCondition<boolean>(
    `Date.now() - window.__at0612.mark >= ${ms}`,
    // A tight poll: the wait is the `ms` itself, and a coarse poll only adds
    // up to a poll's length past it on every call ([B07]).
    { timeoutMs: ms + 10_000, pollMs: 50 },
  );
}

export function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-input", title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 600 },
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
/**
 * Launch an app on the update deck, with the recorder standing in front of
 * the host's `updateAction` handler, and run `body` against it; the verdict
 * line and the log tail on a failure are this function's.
 */
export async function withUpdateDeck(testName: string, body: (app: App) => Promise<void>): Promise<void> {
  const app = await launchTugApp({ testName });
  try {
    await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      { timeoutMs: 30_000 },
    );
    await app.waitForCondition<boolean>(
      `typeof window.__tugBridge !== "undefined"
         && typeof window.__tugBridge.onUpdateState === "function"`,
      { timeoutMs: 20_000 },
    );

    const recorder = await installActionRecorder(app);
    note(`${testName} action recorder`, recorder);
    expect(recorder).not.toBe("FAILED");
    await overlayReady(app);

    await body(app);

    process.stdout.write("VERDICT: PASS\n");
  } catch (err) {
    process.stdout.write("VERDICT: FAIL\n");
    const tail = app.tailLog(200);
    if (tail !== "") process.stderr.write(`\n[${testName}] log tail:\n${tail}\n`);
    throw err;
  } finally {
    await app.close();
  }
}
