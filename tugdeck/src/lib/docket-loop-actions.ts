/**
 * docket-loop-actions.ts — an arc's three answers to a newer brief, as plain
 * functions both surfaces call: the Docket card from its responder, and the
 * arc shade's revision notice from its buttons. One implementation, so the two
 * surfaces cannot drift.
 *
 * - **Keep going** sends `arc_keep_going`: the notice quiets until the brief
 *   moves again, and each decision the newer brief added is filed as an idea
 *   on the docket the press came from.
 * - **Open successor** sends `arc_park` for a boundary. Parked now, it opens a
 *   fresh Session card whose first turn is the `/tugplug:arc` successor
 *   command; still running, it answers with where the arc will park.
 * - **Discard and reopen** discards the arc through the changeset verb store,
 *   as the Arcs card does, and when the discard settles done opens the Reopen
 *   arc opening on the same brief.
 * - **Accept** and **Dismiss** answer an audit follow-up the Inbox proposes:
 *   Accept sends `follow_up_accept`, which makes it an idea filed on the
 *   docket the press came from; Dismiss sends `follow_up_dismiss`.
 * - **Revert** undoes a landed arc's join: a dry run of `arc_revert` says what
 *   the confirm shows, and the confirm sends it for real.
 *
 * Each function settles with one {@link LoopOutcome}: a sentence for the
 * caller's quiet line, or `null` when the act landed and there is nothing to
 * say. A refusal is the server's own sentence ([L31]), and silence past the
 * sender's deadline is said rather than waited on ([L33]).
 *
 * @module lib/docket-loop-actions
 */

import { TUG_ACTIONS } from "./action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";
import { getChangesetVerbStore } from "./changeset-verb-store";
import { getConnection } from "./connection-singleton";
import {
  openingFor,
  successorFor,
  successorOpening,
  type DocketProposal,
  type RevertPreview,
} from "./docket-authoring";
import type { DocketThread } from "./docket-types";
import { docketVerbs, type DocketVerbs } from "./docket-verbs";

/** What a press came to: a sentence for the quiet line, or `null` when it landed quietly. */
export type LoopOutcome = string | null;

/** Where a press came from: the project, its docket, and the card a session opens beside. */
export interface LoopContext {
  projectDir: string;
  /** The docket the thread was read from; Keep going files on it. */
  docketId: string;
  /** The card a fresh Session card opens beside. */
  originCardId: string | null;
  /** The surface's own sender; absent, one lives for the length of the ask. */
  verbs?: DocketVerbs | null;
}

export const UNANSWERED_LOOP_LINE = "Tug did not answer — nothing changed";

/** Run `ask` over the context's sender, or over one made for this ask alone. */
async function withVerbs<T>(
  ctx: LoopContext,
  ask: (verbs: DocketVerbs) => Promise<T>,
): Promise<T | null> {
  if (ctx.verbs !== undefined && ctx.verbs !== null) return ask(ctx.verbs);
  const connection = getConnection();
  if (connection === null) return null;
  const verbs = docketVerbs(connection);
  try {
    return await ask(verbs);
  } finally {
    verbs.dispose();
  }
}

/** Open a fresh Session card in `ctx`'s project whose first turn is `opening`. */
function openSession(ctx: LoopContext, opening: NonNullable<ReturnType<typeof openingFor>>): void {
  dispatchCommand(TUG_ACTIONS.OPEN_AUTHORING_SESSION, {
    projectDir: ctx.projectDir,
    sessionId: crypto.randomUUID(),
    opening,
    originCardId: ctx.originCardId,
  });
}

/** Keep going past the thread's revision. */
export async function keepGoing(ctx: LoopContext, thread: DocketThread): Promise<LoopOutcome> {
  const arc = thread.arc ?? null;
  const revision = arc?.revision ?? null;
  if (arc === null || revision === null) return null;
  const result = await withVerbs(ctx, (verbs) =>
    verbs.keepGoing({
      projectDir: ctx.projectDir,
      arc: arc.name,
      version: revision.to_version,
      docketId: ctx.docketId,
    }),
  );
  if (result === null || result.kind === "unanswered") return UNANSWERED_LOOP_LINE;
  if (result.kind === "refused") return result.message;
  const filed = result.reply.ideas.length;
  return filed === 0
    ? null
    : `${filed === 1 ? "1 added decision was" : `${filed} added decisions were`} filed as ${filed === 1 ? "an idea" : "ideas"}`;
}

/**
 * Open a successor from `boundary` (`tip`, `fork` or `step:<K>`). A parked
 * arc opens at once; a running one says where it will park.
 */
export async function openSuccessor(
  ctx: LoopContext,
  thread: DocketThread,
  boundary: string,
): Promise<LoopOutcome> {
  const arc = thread.arc ?? null;
  if (arc === null) return null;
  const successor = successorFor(thread);
  if (successor === null) return "This arc's brief has no kept version to open a successor on";
  const result = await withVerbs(ctx, (verbs) =>
    verbs.park({ projectDir: ctx.projectDir, arc: arc.name, successor, boundary }),
  );
  if (result === null || result.kind === "unanswered") return UNANSWERED_LOOP_LINE;
  if (result.kind === "refused") return result.message;
  const reply = result.reply;
  if (!reply.parked || reply.from === null) {
    return reply.waiting !== null ? `Parks at the end of ${reply.waiting}` : "Parks at its next step";
  }
  const opening = successorOpening(thread, reply.from);
  if (opening === null) return "This arc's brief has no kept version to open a successor on";
  openSession(ctx, opening);
  return null;
}

/** Accept an Inbox proposal: its follow-up becomes an idea on `ctx`'s docket. */
export async function acceptFollowUp(
  ctx: LoopContext,
  proposal: DocketProposal,
): Promise<LoopOutcome> {
  const result = await withVerbs(ctx, (verbs) =>
    verbs.followUpAccept({
      projectDir: ctx.projectDir,
      arc: proposal.arc,
      created: proposal.created,
      k: proposal.k,
      docketId: ctx.docketId,
    }),
  );
  if (result === null || result.kind === "unanswered") return UNANSWERED_LOOP_LINE;
  return result.kind === "refused" ? result.message : null;
}

/** Dismiss an Inbox proposal. */
export async function dismissFollowUp(
  ctx: LoopContext,
  proposal: DocketProposal,
): Promise<LoopOutcome> {
  const result = await withVerbs(ctx, (verbs) =>
    verbs.followUpDismiss({
      projectDir: ctx.projectDir,
      arc: proposal.arc,
      created: proposal.created,
      k: proposal.k,
    }),
  );
  if (result === null || result.kind === "unanswered") return UNANSWERED_LOOP_LINE;
  return result.kind === "refused" ? result.message : null;
}

/**
 * Ask what reverting the thread's landed arc would undo, committing nothing:
 * the preview for the confirm, or the sentence for the quiet line when the
 * server refused or did not answer.
 */
export async function previewRevert(
  ctx: LoopContext,
  thread: DocketThread,
): Promise<{ preview: RevertPreview } | { said: string }> {
  const arc = thread.arc ?? null;
  if (arc === null) return { said: "This thread has no arc to revert" };
  const result = await withVerbs(ctx, (verbs) =>
    verbs.revert({ projectDir: ctx.projectDir, arc: arc.name, created: arc.created, dryRun: true }),
  );
  if (result === null || result.kind === "unanswered") return { said: UNANSWERED_LOOP_LINE };
  if (result.kind === "refused") return { said: result.message };
  return { preview: { paths: result.reply.paths, later: result.reply.later } };
}

/** Revert the thread's landed arc: a revert commit of its join on the base. */
export async function revertLanded(ctx: LoopContext, thread: DocketThread): Promise<LoopOutcome> {
  const arc = thread.arc ?? null;
  if (arc === null) return null;
  const result = await withVerbs(ctx, (verbs) =>
    verbs.revert({ projectDir: ctx.projectDir, arc: arc.name, created: arc.created, dryRun: false }),
  );
  if (result === null || result.kind === "unanswered") return UNANSWERED_LOOP_LINE;
  return result.kind === "refused" ? result.message : null;
}

/**
 * Discard the thread's arc, then — once the discard settles done — open the
 * Reopen arc opening on the same brief. `entryKey` names the discard's
 * round trip in the changeset verb store.
 */
export function discardAndReopen(
  ctx: LoopContext,
  thread: DocketThread,
  entryKey: string,
): Promise<LoopOutcome> {
  return discardArc(ctx, thread, entryKey, true);
}

/** Discard the thread's arc and nothing more: the Parked group's Discard. */
export function discardParked(
  ctx: LoopContext,
  thread: DocketThread,
  entryKey: string,
): Promise<LoopOutcome> {
  return discardArc(ctx, thread, entryKey, false);
}

function discardArc(
  ctx: LoopContext,
  thread: DocketThread,
  entryKey: string,
  reopen: boolean,
): Promise<LoopOutcome> {
  const arc = thread.arc ?? null;
  const store = getChangesetVerbStore();
  if (arc === null) return Promise.resolve(null);
  if (store === null) return Promise.resolve(UNANSWERED_LOOP_LINE);
  // The reopen is the brief's, read before the discard moves the thread.
  const opening = reopen ? openingFor("reopen-arc", thread) : null;
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      const state = store.discardState(entryKey);
      if (state.phase === "error") {
        unsubscribe();
        resolve(state.error ?? "The discard did not land");
      } else if (state.phase === "done") {
        unsubscribe();
        store.clearDiscard(entryKey);
        if (opening !== null) openSession(ctx, opening);
        resolve(null);
      }
    });
    store.discard(entryKey, ctx.projectDir, arc.name);
  });
}
