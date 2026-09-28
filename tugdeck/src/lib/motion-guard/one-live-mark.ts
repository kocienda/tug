/**
 * One live mark per live thing — the rule a list draws a session under.
 *
 * A live session is drawn live once per view, not once per reference. The
 * Overview card lists hundreds of posts from one session and every post cites
 * it, so without this rule one working session is two hundred breathing dots,
 * which is wrong before it is expensive: a mark is the session's presence,
 * and presence is one thing. The count of live figures per live session in a
 * list is bounded by what is on screen, and the list does not pay for what
 * is not.
 *
 * ## The mechanism
 *
 * Every mark that draws under the rule registers under a key — the session
 * id — and the group elects one: the first member in document order whose box
 * is in view. Every other member is an **understudy**, marked
 * `data-tug-understudy`, and the stylesheet resolves `--tug-loop-iterations:
 * 0` under that mark — the same knob the off-screen rule and the circuit
 * breaker turn, honoured by every loop the audit lets ship. An understudy
 * still draws its phase: the pose is the stylesheet's, the phase subscription
 * is the dot's own, and only the loop is stilled. So a reader sees the
 * session's state on every reference and its breath on one.
 *
 * Which member is in view is the off-screen observer's fact
 * ({@link observeOffscreen}): each member is watched, and a crossing
 * re-elects. The group re-elects on every registration too, so the live mark
 * moves as posts arrive and leave, and as the reader scrolls — a scrolled-away
 * live mark hands the breath to the first member still in view, and there is
 * never a moment with two.
 *
 * Elections are batched to a microtask: an observer delivery carries every
 * crossing of a scroll at once, and a page of posts registers in one commit,
 * so the group settles once per batch rather than once per member.
 *
 * Nothing here is React state ([L06]): the mark is an attribute, the pause is
 * a stylesheet rule, and the hook is a registration in a layout effect
 * ([L03]).
 *
 * @module lib/motion-guard/one-live-mark
 */

import * as React from "react";

import { observeOffscreen, OFFSCREEN_ATTRIBUTE } from "./offscreen";

/** The mark a member wears while another member of its group is the live one. */
export const UNDERSTUDY_ATTRIBUTE = "data-tug-understudy";

interface Group {
  members: Set<Element>;
  live: Element | null;
}

const groups = new Map<string, Group>();
const pending = new Set<string>();
let flushQueued = false;

function inView(el: Element): boolean {
  return !el.hasAttribute(OFFSCREEN_ATTRIBUTE);
}

function byDocumentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function elect(key: string): void {
  const group = groups.get(key);
  if (group === undefined) return;
  const ordered = Array.from(group.members).sort(byDocumentOrder);
  const live = ordered.find(inView) ?? ordered[0] ?? null;
  group.live = live;
  for (const member of ordered) {
    if (member === live) member.removeAttribute(UNDERSTUDY_ATTRIBUTE);
    else member.setAttribute(UNDERSTUDY_ATTRIBUTE, "");
  }
}

function flush(): void {
  flushQueued = false;
  const keys = Array.from(pending);
  pending.clear();
  for (const key of keys) elect(key);
}

function scheduleElection(key: string): void {
  pending.add(key);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flush);
}

/**
 * Draw `el` as one of `key`'s marks: live if it is the first of them in view,
 * an understudy otherwise. Returns the release, which withdraws the member,
 * clears its mark, and re-elects.
 */
export function observeOneLiveMark(el: Element, key: string): () => void {
  let group = groups.get(key);
  if (group === undefined) {
    group = { members: new Set(), live: null };
    groups.set(key, group);
  }
  group.members.add(el);
  const unobserve = observeOffscreen(el, () => scheduleElection(key));
  scheduleElection(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unobserve();
    el.removeAttribute(UNDERSTUDY_ATTRIBUTE);
    const current = groups.get(key);
    if (current === undefined) return;
    current.members.delete(el);
    if (current.members.size === 0) {
      groups.delete(key);
      pending.delete(key);
      return;
    }
    scheduleElection(key);
  };
}

export interface LiveMarksReading {
  /** Keys with at least one member. */
  groups: number;
  /** Members across every group. */
  members: number;
  /** Members currently wearing the understudy mark. */
  understudies: number;
}

/** What the rule is holding right now. Diagnostics and tests. */
export function liveMarks(): LiveMarksReading {
  let members = 0;
  let understudies = 0;
  for (const group of groups.values()) {
    for (const member of group.members) {
      members += 1;
      if (member.hasAttribute(UNDERSTUDY_ATTRIBUTE)) understudies += 1;
    }
  }
  return { groups: groups.size, members, understudies };
}

/**
 * The hook form of {@link observeOneLiveMark}: draw the element under `ref`
 * as one of `key`'s marks for as long as `active` is true. A layout effect,
 * taken in the same commit as the hold the mark's loop takes ([L03]).
 */
export function useOneLiveMark(
  ref: React.RefObject<Element | null>,
  key: string,
  active: boolean = true,
): void {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!active || el === null) return;
    return observeOneLiveMark(el, key);
  }, [ref, key, active]);
}
