/**
 * workspace-name-request.ts — the question New Workspace and Duplicate
 * Workspace ask before they make anything: what is the workspace called?
 *
 * One module-singleton store ([L02]). The shell asks ({@link askWorkspaceName})
 * and gets back the name the user committed, or `null` for a cancel. The
 * naming modal (`tug-workspace-name-dialog.tsx`) reads the open question
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
 * @module lib/workspace-name-request
 */

import { createSubscribable } from "./subscribable";

/** Which verb is asking: what the modal's title and commit button say. */
export type WorkspaceNameVerb = "new" | "duplicate";

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
}

/**
 * The work a committed name starts, run before the question closes: a
 * promise keeps the modal up, waiting, until it settles.
 */
export type WorkspaceNameSettle = (name: string) => Promise<void> | void;

const CLOSED: WorkspaceNameRequest = { open: false, seq: 0, verb: "new", proposed: "", waiting: false };

let snapshot: WorkspaceNameRequest = CLOSED;
let resolver: ((name: string | null) => void) | null = null;
let settler: WorkspaceNameSettle | null = null;
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
  settle?: WorkspaceNameSettle,
): Promise<string | null> {
  const superseded = resolver;
  resolver = null;
  superseded?.(null);
  return new Promise((resolve) => {
    resolver = resolve;
    settler = settle ?? null;
    publish({ open: true, seq: snapshot.seq + 1, verb, proposed, waiting: false });
  });
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
  resolver = null;
  settler = null;
  const close = (): void => {
    // A later ask has taken the modal over; its question stays open.
    if (snapshot.seq === seq) publish({ ...snapshot, open: false, waiting: false });
    resolve?.(trimmed);
  };
  const settling = trimmed !== null && settle !== null ? settle(trimmed) : undefined;
  if (settling === undefined) {
    close();
    return true;
  }
  publish({ ...snapshot, waiting: true });
  void settling.then(close, (error: unknown) => {
    console.error("workspace name: the committed name's settle failed", error);
    close();
  });
  return true;
}

/** Take the shell's question, in the page that draws the modal for it. */
export function adoptWorkspaceNameRequest(next: WorkspaceNameRequest): void {
  if (
    next.open === snapshot.open &&
    next.seq === snapshot.seq &&
    next.verb === snapshot.verb &&
    next.proposed === snapshot.proposed &&
    next.waiting === snapshot.waiting
  ) {
    return;
  }
  publish(next);
}

/** Back to no question and no asker: for tests only. */
export function resetWorkspaceNameRequestForTests(): void {
  resolver = null;
  settler = null;
  snapshot = CLOSED;
}
