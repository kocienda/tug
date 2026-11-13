/**
 * mention-kinds.ts — the words that narrow an `@` mention to one kind.
 *
 * `@session:` and `@commit:` are typed the way a submitted session atom is
 * spelled on the wire, so the form a user types and the form they read back
 * are one. Two places need the words and neither may own them: the completion
 * substrate, which has to leave the colon on the query for the narrowing to
 * be seen at all, and the mention merge, which reads it.
 *
 * @module lib/mention-kinds
 */

/** The kinds an `@` mention can be narrowed to. */
export const MENTION_KINDS = ["session", "commit"] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/**
 * Split an `@` query into the kind its prefix names and the fragment after
 * it. A query with no kind prefix answers `kind: null` and itself.
 */
export function splitMentionKind(query: string): { kind: MentionKind | null; rest: string } {
  for (const kind of MENTION_KINDS) {
    if (query.startsWith(`${kind}:`)) {
      return { kind, rest: query.slice(kind.length + 1) };
    }
  }
  return { kind: null, rest: query };
}
