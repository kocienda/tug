/**
 * Deck-level shims over the space-level `serialize` / `deserialize`.
 *
 * From layout v5 the wire format is a list of named spaces ([P02]), so
 * `serialize` takes a `SpacesState` and `deserialize` returns one. Most of the
 * unit tests in this directory are about ONE deck — what the v4 body carries,
 * what it refuses to carry, how a legacy blob migrates — and re-stating the
 * envelope at every call site would bury the thing each test is actually
 * pinning.
 *
 * So these two helpers put the envelope on and take it off. They are
 * deliberately not exported from `serialization.ts`: the envelope is the wire
 * format, and a production caller that wanted to skip it would be writing a
 * blob nothing can read back.
 */

import type { DeckState } from "../layout-tree";
import { serialize, deserialize } from "../serialization";
import { wrapAsMainSpace } from "../spaces";

/**
 * Serialize one deck to a standalone `version: 4` blob — the space's deck body
 * exactly as `serialize` writes it, under the version key the pre-v5 path
 * reads. That keeps a test free to reach into the blob's own keys, and keeps
 * the round trip below honest: what comes back out is what went in.
 */
export function serializeDeck(deck: DeckState): Record<string, unknown> {
  const blob = serialize(wrapAsMainSpace(deck)) as {
    spaces: { deck: Record<string, unknown> }[];
  };
  return { version: 4, ...blob.spaces[0].deck };
}

/** Deserialize any blob and hand back the active space's deck. */
export function deserializeDeck(
  json: string,
  canvasWidth: number,
  canvasHeight: number,
): DeckState {
  const spaces = deserialize(json, canvasWidth, canvasHeight);
  const active =
    spaces.spaces.find((s) => s.id === spaces.activeSpaceId) ?? spaces.spaces[0];
  return active.deck;
}
