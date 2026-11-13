/**
 * commit-mentions.ts — the completion provider that offers commits.
 *
 * Typing a fragment after `@` asks tugcast to search the composer's
 * repository (`GIT_LOG_QUERY` with a `query`): a fragment of a subject, or a
 * sha prefix, over the whole history. An empty fragment is the newest commits.
 * Each row of the answer is offered as the commit atom every other surface
 * mints — the same type, label and value the annotator builds.
 *
 * It asks for itself rather than reading `GitLogStore`. That store is one
 * walk of one project, the one the Git History section follows, and a
 * composer in another project would either read the wrong repository or
 * steer the section away from its own. The two share a feed and nothing else:
 * every `GIT_LOG` answer is correlated by request id, and this provider's ids
 * are its own.
 *
 * A popup row reads the short sha, with the subject as its description.
 *
 * @module components/tugways/cards/completion-providers/commit-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { COMMIT_ATOM_TYPE } from "@/lib/command-atom";
import { COMMIT_LABEL_LENGTH, commitAtomLabel } from "@/lib/commit-format";
import { getConnection } from "@/lib/connection-singleton";
import { parseGitLogPayload, type GitLogCommit } from "@/lib/git-log-store";
import { FeedId } from "@/protocol";
import {
  createRemoteSearchProvider,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

/** How many commits one ask is answered with. */
export const COMMIT_MENTION_LIMIT = 20;

/** Characters of a sha a hex query must have before it reads as a prefix. */
const SHA_PREFIX_MIN = 4;

export interface CommitMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The wire. Omitted ⇒ the page's connection and the `GIT_LOG` feed. */
  transport?: RemoteSearchTransport<GitLogCommit>;
  now?: () => number;
}

/** The popup item for a searched commit ([B10]). */
export function commitMentionItem(commit: GitLogCommit, query: string): CompletionItem {
  const label = commit.sha.slice(0, COMMIT_LABEL_LENGTH);
  const item: CompletionItem = {
    label,
    atom: {
      kind: "atom",
      type: COMMIT_ATOM_TYPE,
      label: commitAtomLabel(commit.sha),
      // The full sha: the log is where it came from, and a reference that
      // carries all of it cannot become ambiguous as the history grows.
      value: commit.sha,
    },
  };
  // A sha is matched from its first character or not at all: a fragment found
  // mid-sha was matched on the subject, and marks nothing.
  if (query.length > 0 && label.startsWith(query.toLowerCase())) {
    item.matches = [[0, Math.min(query.length, label.length)]];
  }
  if (commit.subject.length > 0) item.description = commit.subject;
  return item;
}

/** The transport a running page uses: its connection, and the `GIT_LOG` feed. */
function liveTransport(): RemoteSearchTransport<GitLogCommit> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const query = {
        root: request.scope,
        requestId: request.requestId,
        offset: 0,
        limit: COMMIT_MENTION_LIMIT,
        query: request.query,
      };
      connection.send(FeedId.GIT_LOG_QUERY, new TextEncoder().encode(JSON.stringify(query)));
      return true;
    },
    onAnswer(listener) {
      const connection = getConnection();
      if (connection === null) return () => {};
      return connection.onFrame(FeedId.GIT_LOG, (payload: Uint8Array) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          return;
        }
        const parsed = parseGitLogPayload(decoded);
        if (parsed === null) return;
        listener({ requestId: parsed.request_id, rows: parsed.commits });
      });
    },
  };
}

export function createCommitMentionProvider(
  options: CommitMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<GitLogCommit>({
    idPrefix: "cm",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    // The server's match, repeated for a held answer: a fragment of the
    // subject, or a sha prefix once the query is long enough to be one.
    stillMatches: (commit, query) =>
      commit.subject.toLowerCase().includes(query) ||
      (query.length >= SHA_PREFIX_MIN && commit.sha.toLowerCase().startsWith(query)),
    toItem: commitMentionItem,
  });
}
