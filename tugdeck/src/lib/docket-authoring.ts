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

import type { DocketThread } from "./docket-types";
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
