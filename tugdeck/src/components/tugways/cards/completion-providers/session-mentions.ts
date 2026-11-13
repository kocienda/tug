/**
 * session-mentions.ts — the completion provider that offers sessions.
 *
 * Typing a fragment after `@` asks tugcast which sessions on this machine it
 * names (`search_sessions`), and each row of the answer is offered as the
 * session atom that row mints. The search — its match, its order, and what it
 * leaves out — is the server's; see `feeds/session_search.rs`. The one thing
 * decided here is that the session being typed in is not offered: a prompt
 * that cites its own session cites nothing the model does not already hold.
 *
 * A popup row reads `<project>/<callsign>`, the string the chip shows and the
 * wire marker carries, with the session's title as its description.
 *
 * @module components/tugways/cards/completion-providers/session-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { getConnection } from "@/lib/connection-singleton";
import { sessionAtomSegment } from "@/lib/session-atom";
import { SESSION_SHORT_ID_LENGTH, type SessionIdentity } from "@/lib/session-identity";
import { onSessionSearchAnswer } from "@/lib/session-search-answers";
import { encodeSearchSessions, type SearchedSession } from "@/protocol";
import {
  createRemoteSearchProvider,
  labelMatch,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

export interface SessionMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The session the composer belongs to, or `null` when it has none. */
  ownSessionId: () => string | null;
  /** The wire. Omitted ⇒ the page's connection and the CONTROL fan-out. */
  transport?: RemoteSearchTransport<SearchedSession>;
  now?: () => number;
}

/** The project half of a row's reference: the server's leaf, else derived. */
function projectOf(row: SearchedSession): string {
  if (row.projectLeaf.length > 0) return row.projectLeaf;
  const trimmed = row.projectDir.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The identity a searched row stands for. The server answered from a ledger
 * or the machine-wide index, so this is a session the machine can find:
 * `resolved`, with both the id and the dir the atom's `session` pair needs.
 */
function identityOf(row: SearchedSession): SessionIdentity {
  return {
    project: projectOf(row),
    projectDir: row.projectDir,
    branch: null,
    tag: row.callsign,
    customName: null,
    description: row.title,
    state: null,
    id: row.sessionId,
    shortId: row.sessionId.slice(0, SESSION_SHORT_ID_LENGTH),
    resolved: true,
  };
}

/** The popup item for a searched session ([B10]). */
export function sessionMentionItem(row: SearchedSession, query: string): CompletionItem {
  const atom = sessionAtomSegment(identityOf(row));
  const item: CompletionItem = { label: atom.label, atom };
  const matches = labelMatch(atom.label, query);
  if (matches !== undefined) item.matches = matches;
  if (row.title !== null) item.description = row.title;
  return item;
}

/** The transport a running page uses: its connection, and the CONTROL fan-out. */
function liveTransport(): RemoteSearchTransport<SearchedSession> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const frame = encodeSearchSessions({
        query: request.query,
        projectDir: request.scope,
        requestId: request.requestId,
      });
      connection.send(frame.feedId, frame.payload);
      return true;
    },
    onAnswer(listener) {
      return onSessionSearchAnswer((answer) => {
        if (answer.requestId === null) return;
        listener({ requestId: answer.requestId, rows: answer.sessions });
      });
    },
  };
}

export function createSessionMentionProvider(
  options: SessionMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<SearchedSession>({
    idPrefix: "sm",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    // The server's match, repeated for a held answer: a fragment of
    // `<project>/<callsign>` or of the title.
    stillMatches: (row, query) =>
      `${projectOf(row)}/${row.callsign}`.toLowerCase().includes(query) ||
      (row.title ?? "").toLowerCase().includes(query),
    toItem: (row, query) =>
      row.sessionId === options.ownSessionId() ? null : sessionMentionItem(row, query),
  });
}
