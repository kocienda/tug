/**
 * The pieces a composer's preserved draft is read back with — shared by the
 * Session card's prompt entry and the Overview rail's composer, because both
 * write the same payload: one editing-state snapshot plus the image bytes its
 * atoms stand for.
 *
 * They live here rather than in either composer for the reason every other
 * piece of this arc does: a payload read by two surfaces has one reader, or
 * the two drift and a draft written by one restores wrong in the other.
 *
 * @module lib/composer-draft-payload
 */

import type { TugTextEditingState } from "./tug-text-types";

/**
 * One entry as it comes back off the durable bag: either real bytes (the HMR
 * path, where the in-memory cache carried everything) or a reference to the
 * original on disk with an empty `content`.
 */
export interface RestoredAttachmentEntry {
  content: string;
  mediaType: string;
  path?: string;
}

/**
 * Defensive runtime check: does `value` look enough like a
 * `TugTextEditingState` to feed into `delegate.restoreState` without
 * crashing? Validates only the shape, not the content — a truly
 * malformed atom will surface inside the substrate's own restore
 * path.
 */
export function isEditingState(value: unknown): value is TugTextEditingState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { text?: unknown; atoms?: unknown };
  return typeof candidate.text === "string" && Array.isArray(candidate.atoms);
}

/**
 * Defensive coercion for the persisted `attachmentBytes` map. Filters
 * out non-object payloads (corrupt persistence, schema drift) and
 * entries missing the required `content` / `mediaType` shape. Returns
 * `undefined` when the input contains zero valid entries — that
 * value round-trips through the snapshot pipeline cleanly and gates
 * `restore` from being called with an empty object.
 *
 * `path` is forwarded when present. It has to be: a durably-restored entry
 * carries nothing else — the bytes were left on disk and the path is the
 * only way back to them — so dropping it here (this function reconstructs
 * the entry field by field) would make the whole restore a silent no-op.
 */
export function coerceAttachmentBytes(
  value: unknown,
): Record<string, RestoredAttachmentEntry> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, RestoredAttachmentEntry> = {};
  let any = false;
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as { content?: unknown; mediaType?: unknown; path?: unknown };
    if (typeof e.content !== "string" || typeof e.mediaType !== "string") {
      continue;
    }
    out[id] =
      typeof e.path === "string" && e.path.length > 0
        ? { content: e.content, mediaType: e.mediaType, path: e.path }
        : { content: e.content, mediaType: e.mediaType };
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Drop image atoms from a restored draft when the payload carries no route
 * back to their bytes — neither inline content nor a path on disk. An atom
 * with no bytes paints a reserved slot forever and submits as nothing, so it
 * is worse than the character it stood at. (Non-image atoms carry their whole
 * meaning in the payload and so are never pruned here.) [L23].
 *
 * Returns the draft unchanged when nothing is orphaned, and `null` straight
 * through. A self-consistent payload where every surviving image atom has
 * bytes or a route to them is the postcondition.
 */
export function pruneOrphanedImageAtoms(
  draft: TugTextEditingState | null,
  attachmentBytes: Record<string, RestoredAttachmentEntry> | undefined,
): TugTextEditingState | null {
  if (draft === null) return null;
  const hasBytes = (id: string | undefined): boolean => {
    if (id === undefined || attachmentBytes === undefined) return false;
    const entry = attachmentBytes[id];
    if (entry === undefined) return false;
    return entry.content.length > 0 || typeof entry.path === "string";
  };
  const dropPositions = draft.atoms
    .filter((a) => a.type === "image" && !hasBytes(a.id))
    .map((a) => a.position)
    .sort((x, y) => x - y);
  if (dropPositions.length === 0) return draft;

  const dropSet = new Set(dropPositions);
  let text = "";
  for (let i = 0; i < draft.text.length; i += 1) {
    if (!dropSet.has(i)) text += draft.text.charAt(i);
  }
  // Shift a surviving offset left by the count of dropped chars before it.
  const shift = (offset: number): number => {
    let n = 0;
    for (const p of dropPositions) {
      if (p < offset) n += 1;
      else break;
    }
    return offset - n;
  };
  const atoms = draft.atoms
    .filter((a) => !dropSet.has(a.position))
    .map((a) => ({ ...a, position: shift(a.position) }));
  const selection =
    draft.selection === null
      ? null
      : {
          start: shift(draft.selection.start),
          end: shift(draft.selection.end),
        };
  return { ...draft, text, atoms, selection };
}
