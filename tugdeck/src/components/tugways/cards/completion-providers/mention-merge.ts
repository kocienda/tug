/**
 * mention-merge.ts — one `@` provider over files, sessions and commits.
 *
 * `mergeCommandProviders` beside it merges synchronous command lists into one
 * ranked list. This is the other shape: three sources of different kinds,
 * two of them answered by the server after the keystroke, presented as
 * groups rather than interleaved.
 *
 * - **Files keep their place.** Whatever the file provider answers comes
 *   first, whole and in its own order, so `@` followed by a path behaves
 *   exactly as it did when files were all `@` offered.
 * - **Sessions, then commits, follow as short groups** of at most
 *   {@link MENTION_GROUP_CAP} rows each. With nothing typed these are the
 *   most recent sessions and the newest commits, which is how a bare `@`
 *   shows that the two kinds are there to be had.
 * - **`session:` and `commit:` narrow to one kind, uncapped.** The fragment
 *   after the colon is the query; an empty one browses that kind.
 *
 * `subscribe` forwards from every source that has one ([L22]), so an answer
 * arriving for any group re-queries the popup. Dropping an answer the user
 * has typed past is each source's own business — a source that notifies is
 * saying its current answer changed.
 *
 * @module components/tugways/cards/completion-providers/mention-merge
 */

import type { CompletionItem, CompletionProvider } from "@/lib/tug-text-types";
import { splitMentionKind } from "@/lib/mention-kinds";

/** How many sessions, and how many commits, follow the files. */
export const MENTION_GROUP_CAP = 3;

export interface MentionSources {
  files: CompletionProvider;
  sessions: CompletionProvider;
  commits: CompletionProvider;
}

export function mergeMentionProviders(
  sources: MentionSources,
  groupCap: number = MENTION_GROUP_CAP,
): CompletionProvider {
  const provider = ((query: string): CompletionItem[] => {
    const { kind, rest } = splitMentionKind(query);
    if (kind === "session") return sources.sessions(rest);
    if (kind === "commit") return sources.commits(rest);
    return [
      ...sources.files(query),
      ...sources.sessions(query).slice(0, groupCap),
      ...sources.commits(query).slice(0, groupCap),
    ];
  }) as CompletionProvider;

  provider.subscribe = (listener: () => void): (() => void) => {
    const releases: Array<() => void> = [];
    for (const source of [sources.files, sources.sessions, sources.commits]) {
      if (source.subscribe !== undefined) releases.push(source.subscribe(listener));
    }
    return () => {
      for (const release of releases) release();
    };
  };

  return provider;
}
