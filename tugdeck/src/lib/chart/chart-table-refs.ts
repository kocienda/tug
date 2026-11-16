/**
 * `chart-table-refs` — what a chart's table refs say, read as data.
 *
 * A chart spec may name, beside its values, the things its rows, columns,
 * cells, dots and marks are about: a commit, a file, a session, an arc. The
 * engine carries those refs into the compiled table (`ChartTable.refs`),
 * addressed the way the table's text is. This module answers the three
 * questions every surface over that data asks, with no DOM and no resolver:
 *
 *  - which ref a mark the pointer is on stands for ({@link effectiveRef});
 *  - what a set reads as (`57 commits`, {@link slotLabel});
 *  - what one ref reads as when it is drawn as an atom ({@link refLabel}).
 *
 * Whether a ref names something real is not decided here. That is the
 * annotator's resolver, the one gate every reference passes
 * (`lib/annotator/chart-refs.ts`).
 *
 * @module lib/chart/chart-table-refs
 */

import { linkAtomLabel } from "@/lib/annotator/atom-segment";
import type { ChartRefSlot, ChartTableRefs } from "@/lib/lazy/load-tuggraphics";

/** The prefixes a ref may carry, in the order the spec documents them. */
export const REF_KINDS = ["commit", "file", "dir", "session", "arc", "url", "command"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** Where a hit sits in the table: the attributes the compiler writes on a `.tgh` path. */
export interface RefTarget {
  row: number;
  col?: number;
  item?: number;
  mark?: number;
}

function at<T>(list: readonly (T | null)[] | undefined, index: number | undefined): T | null {
  if (list === undefined || index === undefined) return null;
  return list[index] ?? null;
}

/**
 * The ref a mark at `target` stands for, first present wins:
 *
 *  1. a mark annotation's own ref;
 *  2. a dot's ref, then its row's;
 *  3. a cell's ref, then its row's, then its column's;
 *  4. otherwise its row's.
 *
 * A line or area hit is a whole-column band with no `col`, so it reads its
 * row; the cells under it are reached from the Table view and the bubble.
 */
export function effectiveRef(refs: ChartTableRefs | undefined, target: RefTarget): ChartRefSlot | null {
  if (refs === undefined) return null;
  const row = at(refs.rows, target.row);
  if (target.mark !== undefined) {
    return refs.marks.find((m) => m.index === target.mark)?.slot ?? null;
  }
  if (target.item !== undefined) {
    return at(refs.items[target.row], target.item) ?? row;
  }
  if (target.col !== undefined) {
    return at(refs.cells[target.row], target.col) ?? row ?? at(refs.cols, target.col);
  }
  return row;
}

/**
 * The slot a Table view atom stands for, by the address `buildTable` wrote
 * on it: `row:i`, `cell:i:j`, `col:j`, `mark:k`, or `items:i`. A row's dots
 * are folded into one atom per prefix, so an `items` address is answered by
 * folding the row again and taking the slot of `kind`. Null for an address
 * nothing is at.
 */
export function slotAt(refs: ChartTableRefs | undefined, address: string, kind: string | null): ChartRefSlot | null {
  if (refs === undefined) return null;
  const parts = address.split(":");
  const a = Number(parts[1]);
  const b = Number(parts[2]);
  switch (parts[0]) {
    case "row":
      return at(refs.rows, a);
    case "cell":
      return at(refs.cells[a], b);
    case "col":
      return at(refs.cols, a);
    case "mark":
      return refs.marks.find((m) => m.index === a)?.slot ?? null;
    case "items":
      return foldItemSlots(refs.items[a]).find((slot) => slotKind(slot) === kind) ?? null;
    default:
      return null;
  }
}

/** The prefix of a ref string, or `""` when it has none. */
export function refKindOf(ref: string): string {
  const colon = ref.indexOf(":");
  return colon < 0 ? "" : ref.slice(0, colon);
}

/** The value of a ref string: everything after its prefix. */
export function refValueOf(ref: string): string {
  const colon = ref.indexOf(":");
  return colon < 0 ? ref : ref.slice(colon + 1);
}

/** The prefix a slot's refs share. */
export function slotKind(slot: ChartRefSlot): string {
  return typeof slot === "string" ? refKindOf(slot) : slot.kind;
}

/** A slot's members: one for a ref, the list for a set, none for a count. */
export function slotMembers(slot: ChartRefSlot): string[] {
  if (typeof slot === "string") return [slot];
  return "members" in slot ? slot.members : [];
}

/** A set with members a press can list — not a single ref, not a count. */
export function isActionableSet(slot: ChartRefSlot): boolean {
  return typeof slot !== "string" && "members" in slot && slot.members.length > 0;
}

const NOUNS: Record<string, readonly [string, string]> = {
  commit: ["commit", "commits"],
  file: ["file", "files"],
  dir: ["directory", "directories"],
  session: ["session", "sessions"],
  arc: ["arc", "arcs"],
  url: ["link", "links"],
  command: ["command", "commands"],
};

function counted(n: number, kind: string): string {
  const [one, many] = NOUNS[kind] ?? ["item", "items"];
  return `${n} ${n === 1 ? one : many}`;
}

/** The last segment of a path, with any trailing separators ignored. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * What one ref reads as, drawn as an atom: `commit:<first 8>` (the spelling
 * the commit atom copies), a path's basename, the session ref as written,
 * the arc's name, a link's host, the command line.
 */
export function refLabel(ref: string): string {
  const kind = refKindOf(ref);
  const value = refValueOf(ref);
  switch (kind) {
    case "commit":
      return `commit:${value.slice(0, 8)}`;
    case "file":
    case "dir":
      return basename(value);
    case "url":
      return linkAtomLabel(value);
    case "session":
    case "arc":
    case "command":
      return value;
    default:
      return ref;
  }
}

/** What a slot reads as: a single ref's label, a set's or a count's `57 commits`. */
export function slotLabel(slot: ChartRefSlot): string {
  if (typeof slot === "string") return refLabel(slot);
  if ("members" in slot) return counted(slot.members.length, slot.kind);
  return counted(slot.count, slot.kind);
}

/**
 * One row's dots folded into the slots its atoms show: the distinct refs of
 * every dot, oldest first, one slot per prefix. A prefix with one distinct
 * ref is that ref; with more it is a set. Count forms among the dots carry
 * no members, so they add nothing a press could list.
 */
export function foldItemSlots(items: readonly (ChartRefSlot | null)[] | undefined): ChartRefSlot[] {
  if (items === undefined) return [];
  const byKind = new Map<string, string[]>();
  for (const slot of items) {
    if (slot === null) continue;
    const kind = slotKind(slot);
    const list = byKind.get(kind) ?? [];
    for (const member of slotMembers(slot)) if (!list.includes(member)) list.push(member);
    if (list.length > 0) byKind.set(kind, list);
  }
  return Array.from(byKind, ([kind, members]) => (members.length === 1 ? members[0] : { kind, members }));
}
