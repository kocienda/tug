/**
 * idea-mentions.ts — the completion provider that offers ideas.
 *
 * Typing a fragment after `@` asks tugcast which of this checkout's ideas it
 * names (`search_ideas`), matched by line or id, newest first. Each row is
 * offered as the idea atom it mints, owned by the composer's checkout, which
 * is the store the search read.
 *
 * @module components/tugways/cards/completion-providers/idea-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { getConnection } from "@/lib/connection-singleton";
import { ideaAtomSegment } from "@/lib/idea-atom";
import { onIdeaSearchAnswer } from "@/lib/idea-search-answers";
import { encodeSearchIdeas, type IdeaRef } from "@/protocol";
import {
  createRemoteSearchProvider,
  labelMatch,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

export interface IdeaMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The wire. Omitted ⇒ the page's connection and the CONTROL fan-out. */
  transport?: RemoteSearchTransport<IdeaRef>;
  now?: () => number;
}

/** The popup item for a searched idea, owned by the checkout that was searched. */
export function ideaMentionItem(row: IdeaRef, query: string, projectDir: string): CompletionItem {
  const atom = ideaAtomSegment({ id: row.id, text: row.text, projectDir });
  const item: CompletionItem = { label: atom.label, atom, description: `idea:${row.id}` };
  const matches = labelMatch(atom.label, query);
  if (matches !== undefined) item.matches = matches;
  return item;
}

function liveTransport(): RemoteSearchTransport<IdeaRef> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const frame = encodeSearchIdeas({
        query: request.query,
        projectDir: request.scope,
        requestId: request.requestId,
      });
      connection.send(frame.feedId, frame.payload);
      return true;
    },
    onAnswer(listener) {
      return onIdeaSearchAnswer((answer) => {
        if (answer.requestId === null) return;
        listener({ requestId: answer.requestId, rows: answer.ideas });
      });
    },
  };
}

export function createIdeaMentionProvider(
  options: IdeaMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<IdeaRef>({
    idPrefix: "im",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    stillMatches: (row, query) =>
      row.id.startsWith(query) || row.text.toLowerCase().includes(query),
    // The search is this checkout's store, so a composer with no project has
    // no idea to offer.
    toItem: (row, query) => {
      const projectDir = options.projectDir();
      return projectDir === "" ? null : ideaMentionItem(row, query, projectDir);
    },
  });
}
