/**
 * arc-mentions.ts — the completion provider that offers arcs.
 *
 * Typing a fragment after `@` asks tugcast which of this project's arcs it
 * names (`search_arcs`): the server matches the name and the brief's title,
 * newest generation first, and reads ended arcs out of the archive as well as
 * live ones. Each row is offered as the arc atom it mints, pinned to its
 * generation, with the brief's title as its description.
 *
 * @module components/tugways/cards/completion-providers/arc-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { getConnection } from "@/lib/connection-singleton";
import { arcAtomSegment } from "@/lib/arc-atom";
import { projectLeafOf } from "@/lib/record-atom-shape";
import { onArcSearchAnswer } from "@/lib/arc-search-answers";
import { encodeSearchArcs, type SearchedArc } from "@/protocol";
import {
  createRemoteSearchProvider,
  labelMatch,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

export interface ArcMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The wire. Omitted ⇒ the page's connection and the CONTROL fan-out. */
  transport?: RemoteSearchTransport<SearchedArc>;
  now?: () => number;
}

/** The popup item for a searched arc, under the project it was searched in. */
export function arcMentionItem(
  row: SearchedArc,
  query: string,
  projectDir: string,
): CompletionItem {
  const atom = arcAtomSegment({
    projectLeaf: projectLeafOf(projectDir),
    projectDir,
    name: row.name,
    created: row.created,
  });
  const item: CompletionItem = { label: atom.label, atom };
  const matches = labelMatch(atom.label, query);
  if (matches !== undefined) item.matches = matches;
  if (row.title !== null) item.description = row.title;
  return item;
}

function liveTransport(): RemoteSearchTransport<SearchedArc> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const frame = encodeSearchArcs({
        query: request.query,
        projectDir: request.scope,
        requestId: request.requestId,
      });
      connection.send(frame.feedId, frame.payload);
      return true;
    },
    onAnswer(listener) {
      return onArcSearchAnswer((answer) => {
        if (answer.requestId === null) return;
        listener({ requestId: answer.requestId, rows: answer.arcs });
      });
    },
  };
}

export function createArcMentionProvider(
  options: ArcMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<SearchedArc>({
    idPrefix: "am",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    // The server's match, repeated for a held answer.
    stillMatches: (row, query) =>
      row.name.toLowerCase().includes(query) ||
      (row.title ?? "").toLowerCase().includes(query),
    // An arc is an entry in one checkout's log, so a composer with no project
    // has no arc to offer.
    toItem: (row, query) => {
      const projectDir = options.projectDir();
      return projectDir === "" ? null : arcMentionItem(row, query, projectDir);
    },
  });
}
