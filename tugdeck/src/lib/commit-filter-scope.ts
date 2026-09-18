/**
 * commit-filter-scope.ts — which parts of a commit the History filter reads.
 *
 * A query that should have found one commit finds thirty when it is matched
 * against everything: a word common in file paths swamps the one commit whose
 * subject says it. So the reader aims the filter — four independent surfaces,
 * all on by default:
 *
 *  - `hash`    — the commit's sha, at its full 40 characters even though rows
 *                show eight, so a hash pasted from anywhere finds its commit.
 *  - `message` — the subject and the message body.
 *  - `detail`  — who and when: author, committer, email, and the date stamps
 *                AS DISPLAYED (so `July 24` matches what the row shows).
 *  - `files`   — the paths the commit touched.
 *
 * Hash leads the group because it is the narrowest of the four — one commit,
 * exactly — and because a query of bare hex is the one query that wants nothing
 * else looked at.
 *
 * All four off is a real state, not an error: the reader has switched every
 * surface off and nothing can match until one comes back. That is why a missing
 * entry (never set) and an empty entry (set to nothing) must stay
 * distinguishable — the former falls back to the default, the latter doesn't.
 * The shade says as much when a query in that state finds nothing.
 *
 * Persisted deck-wide through tugbank defaults
 * (`/api/defaults/dev.commit-filter/history-scope`, [D07],
 * `feedback_no_localstorage`), not per card: how a reader aims a filter is
 * about the reader, the same argument the row-metadata choice makes.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/commit-filter-scope
 */

import { useCallback } from "react";

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";

/** One aimable surface of a commit. */
export type CommitFilterScope = "hash" | "message" | "detail" | "files";

export const COMMIT_FILTER_SCOPE_DOMAIN = "dev.commit-filter";
export const COMMIT_FILTER_SCOPE_KEY = "history-scope";

/** Every surface, in the order the option group shows them. */
export const COMMIT_FILTER_SCOPES: readonly CommitFilterScope[] = [
  "hash",
  "message",
  "detail",
  "files",
];

/** All four — an unaimed filter reads the whole commit. */
export const DEFAULT_COMMIT_FILTER_SCOPE: readonly CommitFilterScope[] =
  COMMIT_FILTER_SCOPES;

/**
 * The query as far as one surface is concerned — itself when the filter reads
 * that surface, empty when it does not.
 *
 * A mark says "this is what the filter found". A commit kept by its subject
 * while `files` is off must not paint its paths just because the word appears
 * there too; the reader turned that surface off and the row should not argue.
 */
export function scopedQuery(
  query: string,
  scope: readonly CommitFilterScope[],
  surface: CommitFilterScope,
): string {
  return scope.includes(surface) ? query : "";
}

/** Parse a persisted scope list; `null` when nothing has ever been stored. */
export function parseCommitFilterScope(
  entry: TaggedValue | undefined,
): readonly CommitFilterScope[] | null {
  if (entry === undefined || typeof entry.value !== "string") return null;
  const parts = entry.value.split(",").map((s) => s.trim());
  return COMMIT_FILTER_SCOPES.filter((s) => parts.includes(s));
}

/**
 * Persist the scope list: optimistic local-cache write (so `useTugbankValue`
 * readers re-render instantly) plus the HTTP PUT. A failed PUT logs and
 * otherwise vanishes — the cache holds for the session.
 */
export function writeCommitFilterScope(scope: readonly CommitFilterScope[]): void {
  const value = scope.join(",");
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(COMMIT_FILTER_SCOPE_DOMAIN, COMMIT_FILTER_SCOPE_KEY, {
      kind: "string",
      value,
    });
  }
  fetch(`/api/defaults/${COMMIT_FILTER_SCOPE_DOMAIN}/${COMMIT_FILTER_SCOPE_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value }),
  }).catch((err) => {
    console.warn("[commit-filter-scope] PUT failed:", err);
  });
}

/** The persisted scope plus its setter — the shade's option group's state. */
export function useCommitFilterScope(): {
  scope: readonly CommitFilterScope[];
  setScope: (next: readonly string[]) => void;
} {
  const stored = useTugbankValue<readonly CommitFilterScope[] | null>(
    COMMIT_FILTER_SCOPE_DOMAIN,
    COMMIT_FILTER_SCOPE_KEY,
    parseCommitFilterScope,
    null,
  );
  const setScope = useCallback((next: readonly string[]) => {
    writeCommitFilterScope(COMMIT_FILTER_SCOPES.filter((s) => next.includes(s)));
  }, []);
  return { scope: stored ?? DEFAULT_COMMIT_FILTER_SCOPE, setScope };
}
