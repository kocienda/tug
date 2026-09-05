/**
 * Verdict keys — the identity a resolver's answer is about, and the ledger
 * of which keys a pass consulted.
 *
 * A verdict is an answer about one *thing*: this absolute path, this
 * filename under this project, this sha in this repository, this session
 * callsign. The annotator never needs to know which resolver answered —
 * only that the ink it painted was painted under some set of answers, and
 * that when one of those answers moves, that ink is wrong until it is
 * walked again.
 *
 * **Why a key and not a flag.** The flag this replaced recorded only that a
 * pass had met a `pending` verdict, which made re-marking correct for
 * exactly one of the four states an answer can be in. A container that met
 * `missing` — a path named before the tool call that creates it — was never
 * flagged and so was never re-walked, and the answer flipping to
 * `confirmed` reached nothing. A container that met `confirmed` was in the
 * same position for a deletion. Keys have no such asymmetry: every answer a
 * pass consulted is recorded, whatever it said, and a change names the keys
 * that moved.
 *
 * **The store names its own key, from inside its own lookup.** A path
 * candidate can be routed to the filesystem probe, to the project's file
 * index, or to both in turn (`resolve-reference.ts`), and a multi-root
 * surface asks each root — so no caller upstream of the stores can say
 * which keys an answer rested on. Each store notes its key as it answers,
 * into whatever collection is open, and {@link collectVerdictKeys} is what
 * opens one around a pass. Outside a pass the note is a no-op, so a lookup
 * from a portal or a menu costs nothing.
 *
 * @module lib/annotator/verdict-keys
 */

/**
 * The identity of one resolver answer. Opaque: only ever compared for
 * equality, never parsed. Namespaced by resolver so two stores cannot
 * collide on one spelling.
 */
export type VerdictKey = string;

/**
 * Join the two halves of a compound key so no two distinct pairs can spell
 * one key. A path, a filename and a sha are all free to contain any
 * printable byte the separator might otherwise have been, so the first
 * half's length is what says where it ends.
 */
function compound(scope: string, head: string, tail: string): VerdictKey {
  return `${scope}:${head.length}:${head}${tail}`;
}

/** The key for one absolute path the filesystem probe answers about. */
export function pathVerdictKey(resolved: string): VerdictKey {
  return `path:${resolved}`;
}

/** The key for one bare name the project's file index answers about. */
export function nameVerdictKey(projectDir: string, name: string): VerdictKey {
  return compound("name", projectDir, name);
}

/** The key for one sha in one repository. */
export function commitVerdictKey(root: string, sha: string): VerdictKey {
  return compound("commit", root, sha);
}

/** The key for one session spelling the ledger answers about. */
export function sessionVerdictKey(queried: string): VerdictKey {
  return `session:${queried}`;
}

/**
 * The collection open right now, or `null` outside a pass. Module-scoped
 * because the notes come from four stores at the bottom of a call stack the
 * annotator does not own; threading a collector through every resolver
 * signature would put the plumbing in the one place — the routing in
 * `resolve-reference.ts` — that has the least to say about it.
 */
let openCollection: Set<VerdictKey> | null = null;

/**
 * Record that the answer just given rests on `key`. A no-op when no
 * collection is open, which is every call from outside an annotation pass.
 */
export function noteVerdictKey(key: VerdictKey): void {
  openCollection?.add(key);
}

/**
 * Run `pass`, collecting every key the resolvers it called noted.
 *
 * A nested collection returns its own keys *and* files them with the
 * collection around it — `annotateContent` delegates to `annotateElement`,
 * and a future caller that wraps either should not have to know which. The
 * inner pass is part of the outer one, so its answers are the outer
 * container's dependencies too; keeping them to itself would under-record
 * the outer ledger, which is the exact shape of the defect this whole
 * mechanism replaced.
 */
export function collectVerdictKeys(pass: () => void): Set<VerdictKey> {
  const outer = openCollection;
  const keys = new Set<VerdictKey>();
  openCollection = keys;
  try {
    pass();
  } finally {
    openCollection = outer;
    if (outer !== null) for (const key of keys) outer.add(key);
  }
  return keys;
}

/**
 * Whether ink painted under `consulted` is stale now that `changed` has
 * moved.
 *
 * `consulted` absent means the element carries no ledger — nothing was ever
 * painted under an answer, so nothing can be wrong. An empty `changed` is
 * the same statement from the other side: no answer moved, so no ink is
 * stale. Neither is a wildcard; every store names the keys it changed, and
 * a notification naming none would be a store reporting that nothing
 * happened.
 */
export function dependsOnKeys(
  consulted: ReadonlySet<VerdictKey> | undefined,
  changed: readonly VerdictKey[],
): boolean {
  if (consulted === undefined || consulted.size === 0) return false;
  for (const key of changed) {
    if (consulted.has(key)) return true;
  }
  return false;
}
