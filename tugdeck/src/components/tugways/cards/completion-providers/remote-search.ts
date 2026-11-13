/**
 * remote-search.ts — the half a server-searched completion provider shares.
 *
 * A file completion filters an index the deck already holds. A session or a
 * commit mention cannot: the machine's sessions and a repository's history are
 * searched in tugcast, so each keystroke is an ask and each answer arrives
 * later, possibly after the user has typed past it. This module is that
 * exchange and nothing else — what was asked, what was answered, and which
 * answer is still wanted. What a row *is*, and how it becomes an item, belong
 * to the provider built on it.
 *
 * Three rules it holds:
 *
 * - **One ask per question.** The substrate calls a provider on every
 *   keystroke and again on every notify; only a change of scope or query
 *   sends. A question whose answer is older than {@link DEFAULT_MAX_AGE_MS} is
 *   asked again the next time it is put, which is what keeps a bare `@` from
 *   showing the recents of an hour ago. That is a reading taken when the
 *   provider is called — there is no timer here.
 * - **A stale answer is dropped.** Every ask carries its own id, and only the
 *   answer to the latest ask is kept. One that arrives for a query the user
 *   has typed past changes nothing and notifies nobody.
 * - **The popup does not blank between keystrokes.** Until the new answer
 *   lands, the rows of the last one are still offered where they still match
 *   what is typed. Narrowing a held answer is sound because typing more only
 *   ever narrows a fragment search; a change of scope drops them outright.
 *
 * `subscribe` is the store-observer door the completion substrate reads
 * ([L22]). The transport's answer subscription is acquired at creation and
 * released by `dispose` ([L27]).
 *
 * @module components/tugways/cards/completion-providers/remote-search
 */

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";

/** How old an answer may be before the same question is asked again. */
export const DEFAULT_MAX_AGE_MS = 5000;

/** One ask, as the transport sends it. */
export interface RemoteSearchRequest {
  /** The provider's own mark on this ask; the answer must echo it. */
  requestId: string;
  /** What the search is scoped to — a project dir. */
  scope: string;
  query: string;
}

/** An answer, as the transport hands it back. */
export interface RemoteSearchAnswer<Row> {
  requestId: string;
  rows: readonly Row[];
}

/**
 * The wire, as a provider sees it. `send` answers whether the ask left: a
 * `false` is a page with no connection, and the provider then offers nothing
 * and asks again the next time it is called.
 */
export interface RemoteSearchTransport<Row> {
  send(request: RemoteSearchRequest): boolean;
  /** Hear every answer; the returned function stops listening ([L27]). */
  onAnswer(listener: (answer: RemoteSearchAnswer<Row>) => void): () => void;
}

export interface RemoteSearchOptions<Row> {
  /** Prefix of every request id, so two kinds of provider never collide. */
  idPrefix: string;
  transport: RemoteSearchTransport<Row>;
  /** The scope of the next ask, read fresh on every call. */
  scope: () => string;
  /**
   * Whether a held row still answers `query` — the deck's copy of the
   * server's match, used only to narrow the last answer while the next is in
   * flight. `query` arrives lowercased.
   */
  stillMatches: (row: Row, query: string) => boolean;
  /** Build the popup item for a row; `null` leaves the row out. */
  toItem: (row: Row, query: string) => CompletionItem | null;
  now?: () => number;
  maxAgeMs?: number;
}

/** A server-searched provider and the release of what it holds. */
export interface RemoteSearchProvider {
  provider: CompletionProvider;
  dispose(): void;
}

let nextProviderId = 0;

/**
 * The `[start, end)` of `query` in `label`, case-insensitively, as the
 * highlight range a popup row marks — or none when the match was on something
 * the label does not show.
 */
export function labelMatch(label: string, query: string): [number, number][] | undefined {
  if (query.length === 0) return undefined;
  const at = label.toLowerCase().indexOf(query.toLowerCase());
  return at < 0 ? undefined : [[at, at + query.length]];
}

export function createRemoteSearchProvider<Row>(
  options: RemoteSearchOptions<Row>,
): RemoteSearchProvider {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const providerId = ++nextProviderId;
  const listeners = new Set<() => void>();
  let seq = 0;

  // The latest ask. `null` until the first, and again after one that could
  // not be sent, so the next call tries again.
  let asked: { requestId: string; scope: string; query: string; at: number } | null = null;
  // The latest answer kept, and the question it answered.
  let answered: { scope: string; query: string; rows: readonly Row[] } | null = null;

  const release = options.transport.onAnswer((answer) => {
    // Only the answer to the latest ask is wanted: anything else is for a
    // query the user has typed past, or for another provider altogether.
    if (asked === null || answer.requestId !== asked.requestId) return;
    answered = { scope: asked.scope, query: asked.query, rows: answer.rows };
    for (const listener of [...listeners]) listener();
  });

  const provider = ((rawQuery: string): CompletionItem[] => {
    const scope = options.scope();
    const query = rawQuery.trim();
    const sameQuestion = asked !== null && asked.scope === scope && asked.query === query;
    const stale = sameQuestion && asked !== null && now() - asked.at > maxAgeMs;
    if (!sameQuestion || stale) {
      const requestId = `${options.idPrefix}-${providerId}-${++seq}`;
      const sent = options.transport.send({ requestId, scope, query });
      asked = sent ? { requestId, scope, query, at: now() } : null;
    }
    // Rows held for another project are about the wrong sessions or the wrong
    // repository, whatever was typed.
    if (answered === null || answered.scope !== scope) return [];
    const needle = query.toLowerCase();
    const rows =
      answered.query === query
        ? answered.rows
        : answered.rows.filter((row) => options.stillMatches(row, needle));
    const items: CompletionItem[] = [];
    for (const row of rows) {
      const item = options.toItem(row, query);
      if (item !== null) items.push(item);
    }
    return items;
  }) as CompletionProvider;

  provider.subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    provider,
    dispose(): void {
      release();
      listeners.clear();
      asked = null;
      answered = null;
    },
  };
}
