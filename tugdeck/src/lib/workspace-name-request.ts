/**
 * workspace-name-request.ts — the question New Workspace and Duplicate
 * Workspace ask before they make anything: what is the workspace called?
 *
 * One module-singleton store ([L02]). The shell asks ({@link askWorkspaceName})
 * and gets back the name the user committed, or `null` for a cancel. The
 * naming modal (`components/chrome/workspace-name-dialog.tsx`) reads the open question
 * through `useSyncExternalStore` and answers it through its page's gate deck
 * (`gate-deck.ts`). Where the host keeps an overlay the modal is drawn there:
 * the shell's snapshot is the truth, relayed as `overlay.workspaceName`, the
 * overlay's copy adopts it ({@link adoptWorkspaceNameRequest}), and the
 * answer comes back as `overlay.workspaceNameAnswer` to
 * {@link answerWorkspaceName} here.
 *
 * Every question is numbered, and an answer names the question it answers,
 * so an answer that crosses a later ask on the bus is dropped rather than
 * taken for the new one. A second ask while one is open cancels the first:
 * one modal, one question.
 *
 * A name that is empty after trimming answers nothing and leaves the
 * question open — the rule `renameSpace` already holds a name to. The name
 * that is accepted is the trimmed one.
 *
 * An asker may hand a `settle` with its question: the work a committed name
 * starts, done while the modal still stands. New Workspace's cut waits on
 * its pages there, so the scrim stays up through it. While a settle that
 * returned a promise runs, the question is `waiting`: still open, answering
 * nothing more, and the modal shows the deck's progress wave in place of its
 * buttons. It closes when the settle ends, whichever way it ends.
 *
 * The question also carries where the modal's zoom rectangles run: `from`,
 * the rect of the control that raised it, and `to`, the rect of the row the
 * named workspace lands on, both in window points — the overlay's, which the
 * shell converts a card's own rect into with {@link windowRectOf}. `from`
 * comes with the ask; `to` is set on the open question by
 * {@link setWorkspaceNameDestination} once the row exists — or answered
 * `null`, when there is no row on screen to land on. Only a committed
 * question that expects one takes it: the row is asked for once the name
 * commits, so an answer reaching a question still being typed belongs to an
 * earlier one and is dropped. An asker that expects
 * a destination (`awaitDestination`) has its committed question's close
 * wait for that answer, bounded by {@link WORKSPACE_NAME_DESTINATION_BOUND_MS};
 * past the bound it closes with none, and a rect that arrives after the
 * close is dropped. The run is decoration, so nothing waits on it longer
 * than the bound ([L33]). A superseded question takes neither rect onward:
 * the next ask carries only its own.
 *
 * @module lib/workspace-name-request
 */

import { createSubscribable } from "./subscribable";

/** Which verb is asking: what the modal's title and commit button say. */
export type WorkspaceNameVerb = "new" | "duplicate";

/**
 * A rect in window points: the overlay's viewport, which the shell's shares.
 * Shaped as `zoom-rects.ts`'s `ZoomRect`, so the modal runs it as it stands.
 */
export interface WorkspaceNameRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** The question as the modal reads it. `open: false` is no question. */
export interface WorkspaceNameRequest {
  readonly open: boolean;
  /** The question's number: what its answer names. */
  readonly seq: number;
  readonly verb: WorkspaceNameVerb;
  /** The name filled in and selected when the field opens. */
  readonly proposed: string;
  /** A name is committed and its settle is running: the modal waits, answering nothing. */
  readonly waiting: boolean;
  /** The rect of the control that raised the modal: where order-in runs from, and a cancel back to. */
  readonly from: WorkspaceNameRect | null;
  /** The rect of the row the named workspace landed on: where order-out runs to. */
  readonly to: WorkspaceNameRect | null;
}

/**
 * The work a committed name starts, run before the question closes: a
 * promise keeps the modal up, waiting, until it settles.
 */
export type WorkspaceNameSettle = (name: string) => Promise<void> | void;

/** What an asker hands with its question, beside the verb and the proposed name. */
export interface AskWorkspaceNameOptions {
  /** The work a committed name starts, run while the modal still stands. */
  readonly settle?: WorkspaceNameSettle;
  /** The rect of the control that raised the modal, in window points; none for a door with no place on screen. */
  readonly from?: WorkspaceNameRect | null;
  /** A committed name's close waits, bounded, for {@link setWorkspaceNameDestination}. */
  readonly awaitDestination?: boolean;
}

/** How long a committed question's close waits for its destination rect, ms. */
export const WORKSPACE_NAME_DESTINATION_BOUND_MS = 250;

/** Run `fn` after `ms`. Returns the cancel. */
export type WorkspaceNameTimer = (fn: () => void, ms: number) => () => void;

const LIVE_TIMER: WorkspaceNameTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

const CLOSED: WorkspaceNameRequest = {
  open: false,
  seq: 0,
  verb: "new",
  proposed: "",
  waiting: false,
  from: null,
  to: null,
};

let snapshot: WorkspaceNameRequest = CLOSED;
let resolver: ((name: string | null) => void) | null = null;
let settler: WorkspaceNameSettle | null = null;
let awaitsDestination = false;
/** The open question is committed and waits for its destination: the one state that takes one. */
let expectingDestination = false;
/** The open question's destination is answered — a rect, or none on screen. */
let destinationAnswered = false;
/** The close a committed question holds for its destination, run once `to` arrives. */
let heldClose: (() => void) | null = null;
let timer: WorkspaceNameTimer = LIVE_TIMER;
const listeners = createSubscribable();

function publish(next: WorkspaceNameRequest): void {
  snapshot = next;
  listeners.notify();
}

/** Subscribe to the question opening and closing. Returns an unsubscribe function. */
export function subscribeWorkspaceNameRequest(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/** The open question, or a closed snapshot (the `useSyncExternalStore` snapshot). */
export function getWorkspaceNameRequest(): WorkspaceNameRequest {
  return snapshot;
}

/**
 * Ask for a workspace's name, `proposed` filled in. Resolves with the trimmed
 * name the user committed, once `settle` (if given) has run on it, or `null`
 * when they cancelled — or when a later ask took the modal over.
 */
export function askWorkspaceName(
  verb: WorkspaceNameVerb,
  proposed: string,
  options: AskWorkspaceNameOptions = {},
): Promise<string | null> {
  const superseded = resolver;
  resolver = null;
  heldClose = null;
  superseded?.(null);
  return new Promise((resolve) => {
    resolver = resolve;
    settler = options.settle ?? null;
    awaitsDestination = options.awaitDestination === true;
    expectingDestination = false;
    destinationAnswered = false;
    publish({
      open: true,
      seq: snapshot.seq + 1,
      verb,
      proposed,
      waiting: false,
      from: options.from ?? null,
      to: null,
    });
  });
}

/**
 * The row the open question's workspace lands on, in window points: its
 * order-out runs there, and a close held for it goes ahead. `null` answers
 * that there is no row on screen: no run, and the close goes ahead the same.
 * Dropped unless the open question is committed and expects it: an answer
 * that arrives after the close, or one a question still being typed hears,
 * which an earlier question asked for.
 */
export function setWorkspaceNameDestination(to: WorkspaceNameRect | null): void {
  if (!snapshot.open || !expectingDestination) return;
  destinationAnswered = true;
  if (to !== null) publish({ ...snapshot, to });
  const close = heldClose;
  heldClose = null;
  close?.();
}

/**
 * A rect a card measured in its own page, `local`, in window points: offset
 * by the card's content box, `contentBox` — where the card's page is drawn in
 * the window. With no content box (a page with no host overlay, where the
 * card, the modal and the zoom layer share one viewport) it is the rect as
 * it stands.
 */
export function windowRectOf(
  local: WorkspaceNameRect,
  contentBox: { readonly x: number; readonly y: number } | null,
): WorkspaceNameRect {
  if (contentBox === null) return local;
  return {
    top: local.top + contentBox.y,
    left: local.left + contentBox.x,
    width: local.width,
    height: local.height,
  };
}

/**
 * Answer question `seq`: a name to commit, or `null` to cancel. Answers
 * whether the answer was taken — false for a question that is not the open
 * one, for one already waiting on its settle, and for a name that is empty
 * after trimming, which leaves it open.
 */
export function answerWorkspaceName(seq: number, name: string | null): boolean {
  if (!snapshot.open || seq !== snapshot.seq || snapshot.waiting) return false;
  const trimmed = name === null ? null : name.trim();
  if (trimmed === "") return false;
  const resolve = resolver;
  const settle = settler;
  const awaits = trimmed !== null && awaitsDestination;
  resolver = null;
  settler = null;
  awaitsDestination = false;
  // Set before the settle runs, since the settle is what asks for the row.
  expectingDestination = awaits;
  const close = (): void => {
    // A later ask has taken the modal over; its question stays open.
    if (snapshot.seq === seq) {
      expectingDestination = false;
      publish({ ...snapshot, open: false, waiting: false });
    }
    resolve?.(trimmed);
  };
  // A committed name that expects its destination closes once `to` is set,
  // or at the bound with none.
  const finish = (): void => {
    if (!awaits || snapshot.seq !== seq || destinationAnswered) {
      close();
      return;
    }
    if (!snapshot.waiting) publish({ ...snapshot, waiting: true });
    let done = false;
    let cancel: () => void = () => {};
    const once = (): void => {
      if (done) return;
      done = true;
      cancel();
      if (heldClose === once) heldClose = null;
      close();
    };
    heldClose = once;
    cancel = timer(once, WORKSPACE_NAME_DESTINATION_BOUND_MS);
  };
  const settling = trimmed !== null && settle !== null ? settle(trimmed) : undefined;
  if (settling === undefined) {
    finish();
    return true;
  }
  publish({ ...snapshot, waiting: true });
  void settling.then(finish, (error: unknown) => {
    console.error("workspace name: the committed name's settle failed", error);
    finish();
  });
  return true;
}

function sameRect(a: WorkspaceNameRect | null, b: WorkspaceNameRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** Take the shell's question, in the page that draws the modal for it. */
export function adoptWorkspaceNameRequest(next: WorkspaceNameRequest): void {
  if (
    next.open === snapshot.open &&
    next.seq === snapshot.seq &&
    next.verb === snapshot.verb &&
    next.proposed === snapshot.proposed &&
    next.waiting === snapshot.waiting &&
    sameRect(next.from, snapshot.from) &&
    sameRect(next.to, snapshot.to)
  ) {
    return;
  }
  publish(next);
}

/** Run the destination bound on `next` instead of the real clock: for tests only. */
export function setWorkspaceNameTimerForTests(next: WorkspaceNameTimer | null): void {
  timer = next ?? LIVE_TIMER;
}

/** Back to no question and no asker: for tests only. */
export function resetWorkspaceNameRequestForTests(): void {
  resolver = null;
  settler = null;
  awaitsDestination = false;
  expectingDestination = false;
  destinationAnswered = false;
  heldClose = null;
  timer = LIVE_TIMER;
  snapshot = CLOSED;
}
