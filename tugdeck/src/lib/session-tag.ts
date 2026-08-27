/**
 * session-tag.ts — pure minting for mnemonic session tags.
 *
 * A tag is an `adjective-noun` pair (e.g. `azure-heron`) drawn from the curated
 * lexicon (`session-tag-lexicon.ts`). The client mints one "from the drop" and
 * re-rolls it against the tags it already knows, so this module only needs to
 * avoid the tags already in hand.
 *
 * **The ledger is the authority, and its answer can differ from ours.** A tag
 * any session ever minted is spent forever (the append-only `minted_tags`
 * arbiter), so the server does not suffix a collision — it rerolls a complete
 * fresh pair. The client adopts that on the `session_updated` / spawn-ack path
 * it already rides, which means a freshly shown callsign may change **once**,
 * seconds after spawn, and is then immutable for the life of the session.
 * Nothing may cache the optimistic tag past that ack.
 *
 * **No suffix, ever.** A collision NEVER produces `azure-heron-2`: the bare
 * `-N` backstop is retired, along with the silent NULL tag it landed on at
 * exhaustion. The lineage-suffix grammar (`stocky-pixie-A1-B2`) is retired
 * too: the callsign belongs to the **line of work**, and an id change writes
 * another segment against the same line rather than a session that needs a
 * name of its own — so the only path to a fresh pair is a line being born
 * ([D167]). Legacy composed spellings survive only in old citations, resolved
 * server-side through the `minted_tags` alias arm.
 *
 * Pure logic — no React, no DOM, no store. Unit-testable in isolation. The
 * exact-match `tag → session_id` resolution this header once deferred now lives
 * on `session-tag-store.ts` as `lineWearing`, because it needs the live index
 * rather than a pure function — and it answers with the line, since that is
 * what a callsign names.
 *
 * @module lib/session-tag
 */

import { TAG_ADJECTIVES, TAG_NOUNS } from "@/lib/session-tag-lexicon";

/** Re-roll attempts before giving up and letting the ledger reroll the tag. */
const MINT_REROLL_CAP = 8;

/**
 * Mint a fresh `adjective-noun` tag not present in `known`.
 *
 * Picks a random adjective + noun; if the pair is already in `known`, re-rolls
 * up to {@link MINT_REROLL_CAP} times. If every attempt collides (astronomically
 * unlikely against 524k combinations), returns the last candidate — the ledger
 * rerolls it authoritatively. `rng` defaults to `Math.random` and
 * is injectable for deterministic tests.
 */
export function mintTag(
  known: ReadonlySet<string>,
  rng: () => number = Math.random,
): string {
  const pick = (pool: readonly string[]): string =>
    pool[Math.floor(rng() * pool.length)];
  let candidate = `${pick(TAG_ADJECTIVES)}-${pick(TAG_NOUNS)}`;
  for (let i = 0; i < MINT_REROLL_CAP && known.has(candidate); i++) {
    candidate = `${pick(TAG_ADJECTIVES)}-${pick(TAG_NOUNS)}`;
  }
  return candidate;
}
