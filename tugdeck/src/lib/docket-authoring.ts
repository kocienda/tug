/**
 * docket-authoring.ts — what a docket thread can be carried forward with.
 *
 * A thread on the Docket card shows the gestures that move its work one rung
 * up the ladder — idea, sketch, brief, arc — and each gesture that needs a
 * model opens a fresh Session card whose first turn is armed: a prompt for
 * Sketch it, a plugin command for the rest. This module is the pure half of
 * that: which gestures a thread offers, the opening each one sends, the slug
 * an arc is opened under, and the inbox — the ideas nothing has been made
 * from yet, which the card lists first.
 *
 * @module lib/docket-authoring
 */

import type { DocketRevisionCell, DocketThread } from "./docket-types";
import type { Opening } from "./opening-command-runner";

/** A thread's authoring gestures, in the order the strip draws them. */
export const DOCKET_GESTURES = [
  "sketch-it",
  "keep-sketch",
  "edit-sketch",
  "write-brief",
  "revise-brief",
  "open-arc",
  "reopen-arc",
] as const;

export type DocketGesture = (typeof DOCKET_GESTURES)[number];

/** The label each gesture's button and menu row carry. */
export const DOCKET_GESTURE_LABELS: Readonly<Record<DocketGesture, string>> = {
  "sketch-it": "Sketch it",
  "keep-sketch": "Keep sketch",
  "edit-sketch": "Edit Sketch",
  "write-brief": "Write brief",
  "revise-brief": "Revise brief",
  "open-arc": "Open arc",
  "reopen-arc": "Reopen arc",
};

/** The stage the derivation gives a session an idea was sketched in. */
const SKETCH_STAGE = "sketch";

/**
 * The idea's sketching sessions: a thread's sessions that ran no arc stage —
 * the ones the idea lists, which arrive staged `sketch`, and any unstaged.
 */
function ideaSessionCount(thread: DocketThread): number {
  return thread.sessions.filter(
    (s) => s.stage === undefined || s.stage === null || s.stage === SKETCH_STAGE,
  ).length;
}

/** The path of the thread's latest brief version, when it has one. */
function latestBriefPath(thread: DocketThread): string | null {
  const brief = thread.brief;
  if (brief === undefined || brief === null) return null;
  if (brief.version === undefined || brief.version === null) return null;
  const path = brief.source_path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** True when the thread's brief was written from an older sketch version than the latest. */
export function briefIsStale(thread: DocketThread): boolean {
  return thread.brief?.stale === true;
}

/** True when `gesture` asks before it opens: an arc opened on a stale brief. */
export function needsStaleConfirm(gesture: DocketGesture, thread: DocketThread): boolean {
  return (gesture === "open-arc" || gesture === "reopen-arc") && briefIsStale(thread);
}

/** The question asked before an arc is opened on a stale brief. */
export function staleConfirmMessage(thread: DocketThread): string {
  const from = thread.brief?.sketch_version ?? null;
  const now = thread.sketch?.versions ?? null;
  return from !== null && now !== null
    ? `This brief was written from sketch v${from}; the sketch is now v${now}. Open the arc on it anyway?`
    : "This brief was written from an older sketch. Open the arc on it anyway?";
}

/** The gestures `thread` offers, in strip order. */
export function gesturesFor(thread: DocketThread): DocketGesture[] {
  const idea = thread.idea ?? null;
  const sketch = thread.sketch ?? null;
  const brief = thread.brief ?? null;
  const arc = thread.arc ?? null;
  const out: DocketGesture[] = [];
  if (idea !== null && arc?.fate !== "live") out.push("sketch-it");
  if (idea !== null && ideaSessionCount(thread) > 0) out.push("keep-sketch");
  if (sketch !== null) out.push("edit-sketch");
  if (sketch !== null && brief === null) out.push("write-brief");
  if (sketch !== null && brief !== null) out.push("revise-brief");
  const briefPath = latestBriefPath(thread);
  if (briefPath !== null && arc === null) out.push("open-arc");
  if (briefPath !== null && arc !== null && (arc.fate === "joined" || arc.fate === "discarded")) {
    out.push("reopen-arc");
  }
  return out;
}

/**
 * An arc's name from its brief's path: the file stem with a trailing `-brief`
 * taken off (`briefs/one-door-brief.md` → `one-door`).
 */
export function briefSlug(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const stem = base.endsWith(".md") ? base.slice(0, -".md".length) : base;
  const slug = stem.endsWith("-brief") ? stem.slice(0, -"-brief".length) : stem;
  return slug.length > 0 ? slug : stem;
}

/**
 * The first turn `gesture` opens its session with, or `null` when the
 * gesture opens no session (Edit Sketch is the card's own editor) or the
 * thread lacks what the gesture names. `ideaBody` is the idea's longer text,
 * when the caller holds it; Sketch it sends it after the line.
 */
export function openingFor(
  gesture: DocketGesture,
  thread: DocketThread,
  ideaBody?: string,
): Opening | null {
  const idea = thread.idea ?? null;
  const sketch = thread.sketch ?? null;
  switch (gesture) {
    case "sketch-it": {
      if (idea === null || idea.text.trim().length === 0) return null;
      const body = ideaBody?.trim() ?? "";
      return { kind: "prompt", text: body.length > 0 ? `${idea.text}\n\n${body}` : idea.text };
    }
    case "keep-sketch":
      return idea === null ? null : { kind: "command", name: "tugplug:keep-sketch", args: idea.id };
    case "edit-sketch":
      return null;
    case "write-brief":
      return sketch === null
        ? null
        : { kind: "command", name: "tugplug:brief", args: `--sketch ${sketch.id}` };
    case "revise-brief":
      return sketch === null
        ? null
        : { kind: "command", name: "tugplug:brief", args: `--sketch ${sketch.id} --revise` };
    case "open-arc":
    case "reopen-arc": {
      const path = latestBriefPath(thread);
      return path === null
        ? null
        : { kind: "command", name: "tugplug:arc", args: `${briefSlug(path)} ${path}` };
    }
  }
}

/**
 * A kept version of a sketch as one string, `<sketch id>@<n>`: what a
 * versions popup item carries, since a popup's payload is a primitive.
 */
export function keptVersionRef(sketchId: string, n: number): string {
  return `${sketchId}@${n}`;
}

/** Read a {@link keptVersionRef} back; `null` when it is not one. */
export function parseKeptVersionRef(value: unknown): { id: string; n: number } | null {
  if (typeof value !== "string") return null;
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const n = Number(value.slice(at + 1));
  if (!Number.isInteger(n) || n < 1) return null;
  return { id: value.slice(0, at), n };
}

/** True when nothing has been made from the thread's idea yet. */
export function isInboxThread(thread: DocketThread): boolean {
  return (
    (thread.idea ?? null) !== null &&
    (thread.sketch ?? null) === null &&
    (thread.brief ?? null) === null &&
    (thread.arc ?? null) === null
  );
}

/**
 * Split a docket's threads into its inbox — idea threads with no sketch,
 * brief or arc, newest first — and the rest, in their derived order.
 */
export function partitionInbox(threads: readonly DocketThread[]): {
  inbox: DocketThread[];
  rest: DocketThread[];
} {
  const inbox: DocketThread[] = [];
  const rest: DocketThread[] = [];
  for (const thread of threads) (isInboxThread(thread) ? inbox : rest).push(thread);
  inbox.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  return { inbox, rest };
}

// ---------------------------------------------------------------------------
// Inbox proposals: an audit's follow-ups, awaiting the user's answer
// ---------------------------------------------------------------------------

/** One audit follow-up offered in the Inbox, with the thread its arc is. */
export interface DocketProposal {
  /** The list id and action payload: {@link proposalKey}. */
  key: string;
  threadKey: string;
  arc: string;
  /** The arc generation's start. */
  created: string;
  k: number;
  text: string;
}

/** A proposal's key: `proposal:<arc>@<created>#<k>`. */
export function proposalKey(arc: string, created: string, k: number): string {
  return `proposal:${arc}@${created}#${k}`;
}

/**
 * Every follow-up the docket's arcs still propose, in thread order and then
 * by `k`. A joined arc keeps its proposals until each is answered.
 */
export function docketProposals(threads: readonly DocketThread[]): DocketProposal[] {
  const out: DocketProposal[] = [];
  for (const thread of threads) {
    const arc = thread.arc ?? null;
    if (arc === null) continue;
    const proposals = [...(arc.proposals ?? [])].sort((a, b) => a.k - b.k);
    for (const p of proposals) {
      out.push({
        key: proposalKey(arc.name, arc.created, p.k),
        threadKey: thread.key,
        arc: arc.name,
        created: arc.created,
        k: p.k,
        text: p.text,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The revision notice: an arc's answers to a newer brief
// ---------------------------------------------------------------------------

/**
 * A successor's name: the old arc's name with any trailing `-v<digits>` taken
 * off, then `-v<version>` (`foo` → `foo-v3`, `foo-v2` → `foo-v3`).
 */
export function successorName(oldName: string, version: number): string {
  const stem = oldName.replace(/-v\d+$/, "");
  return `${stem.length > 0 ? stem : oldName}-v${version}`;
}

/**
 * The successor a thread's arc parks for and opens: the one its standing park
 * request already names, else {@link successorName} of the brief version it
 * would open on. The park and the opening read this one answer, so the arc
 * log's `arc-park` and the door's new arc always name the same successor.
 */
export function successorFor(thread: DocketThread): string | null {
  const arc = thread.arc ?? null;
  if (arc === null) return null;
  if (arc.successor !== null && arc.successor !== undefined) return arc.successor;
  const version = arc.revision?.to_version ?? thread.brief?.version ?? null;
  return version === null ? null : successorName(arc.name, version);
}

/** One boundary a successor may start from, as the Open successor menu lists it. */
export interface BoundaryChoice {
  /** The wire form: `tip`, `fork` or `step:<K>`. */
  boundary: string;
  label: string;
  /** The one the revision's offer pre-selects. */
  suggested: boolean;
}

/** The boundary a revision's offer pre-selects, or `null` when it suggests none. */
function suggestedBoundary(revision: DocketRevisionCell): string | null {
  switch (revision.offer.kind) {
    case "successor_tip":
      return "tip";
    case "successor_step":
      return `step:${revision.offer.after}`;
    case "successor_fork":
      return "fork";
    case "keep_going":
    case "pick":
      return null;
  }
}

function boundaryLabel(boundary: string): string {
  if (boundary === "tip") return "Where it stands";
  if (boundary === "fork") return "From the start";
  return `After step ${boundary.slice("step:".length)}`;
}

/**
 * The boundaries Open successor offers: the suggested one first and marked,
 * then each finished step in order, then the fork point. Keep going and Pick
 * suggest no boundary — Keep going's answer is not a successor, and Pick is
 * the case the user chooses for.
 */
export function boundaryChoices(revision: DocketRevisionCell): BoundaryChoice[] {
  const suggested = suggestedBoundary(revision);
  const rest = [...[...revision.done_steps].sort((a, b) => a - b).map((k) => `step:${k}`), "fork"];
  const order = suggested === null ? rest : [suggested, ...rest.filter((b) => b !== suggested)];
  return order.map((boundary) => ({
    boundary,
    label: boundaryLabel(boundary),
    suggested: boundary === suggested,
  }));
}

function stepWords(steps: readonly number[]): string {
  const sorted = [...steps].sort((a, b) => a - b);
  return `${sorted.length === 1 ? "step" : "steps"} ${sorted.join(", ")}`;
}

/**
 * The notice's one line: which versions, what moved, and which finished
 * steps it reaches — "Brief moved v1 → v2: 2 changed, 1 added; touches step 3".
 */
export function revisionSummary(revision: DocketRevisionCell): string {
  const counts = [
    revision.changed.length > 0 ? `${revision.changed.length} changed` : null,
    revision.added.length > 0 ? `${revision.added.length} added` : null,
    revision.removed.length > 0 ? `${revision.removed.length} removed` : null,
  ].filter((s): s is string => s !== null);
  const head = `Brief moved v${revision.from_version} → v${revision.to_version}`;
  const reach =
    revision.affected_steps.length > 0
      ? `touches ${stepWords(revision.affected_steps)}`
      : revision.uncited_steps.length > 0
        ? `${stepWords(revision.uncited_steps)} name no decisions`
        : null;
  return [counts.length > 0 ? `${head}: ${counts.join(", ")}` : head, reach]
    .filter((s): s is string => s !== null)
    .join("; ");
}

/** True when the thread's arc carries a revision the user has not kept going past. */
export function revisionPending(thread: DocketThread): boolean {
  const revision = thread.arc?.revision ?? null;
  if (revision === null) return false;
  return (revision.kept_through ?? 0) < revision.to_version;
}

/**
 * The first turn a successor's Session card opens with:
 * `/tugplug:arc <stem>-v<N> <brief path> --successor-of <old> --from <sha>`,
 * or `null` when the thread has no arc or no kept brief to open it on.
 */
export function successorOpening(thread: DocketThread, from: string): Opening | null {
  const arc = thread.arc ?? null;
  const path = latestBriefPath(thread);
  const successor = successorFor(thread);
  if (arc === null || path === null || successor === null) return null;
  return {
    kind: "command",
    name: "tugplug:arc",
    args: `${successor} ${path} --successor-of ${arc.name} --from ${from}`,
  };
}

/** True when the thread's arc is parked, so it belongs in the Parked group. */
export function isParkedThread(thread: DocketThread): boolean {
  return thread.arc?.parked === true && thread.arc.fate === "live";
}

/** True when the thread's arc joined, so it belongs in the Landed group. */
export function isLandedThread(thread: DocketThread): boolean {
  return thread.arc?.fate === "joined";
}

/** Landed threads in the order their arcs joined, oldest first. */
export function landedOrder(threads: readonly DocketThread[]): DocketThread[] {
  const at = (t: DocketThread): string => t.arc?.joined_at ?? "";
  return threads.filter(isLandedThread).sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

/** What a revert's dry run said: the files its join touched and the later work on them. */
export interface RevertPreview {
  paths: number;
  later: readonly { sha: string; subject: string; arc: string | null }[];
}

/**
 * The revert confirm's sentence: how many files the arc's join touched, and
 * each later commit on the base that touched one of them, named by its arc
 * when it has one and by its subject otherwise.
 */
export function revertConfirmMessage(arc: string, preview: RevertPreview): string {
  const files = preview.paths === 1 ? "1 file" : `${preview.paths} files`;
  const lines = [`Revert ${arc}? Its join touched ${files}; a revert commit undoes them on the base.`];
  for (const later of preview.later) {
    lines.push(`Later work on the same files: ${later.arc ?? later.subject}`);
  }
  return lines.join("\n");
}
