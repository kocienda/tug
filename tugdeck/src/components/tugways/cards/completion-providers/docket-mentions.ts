/**
 * docket-mentions.ts — the completion provider that offers dockets.
 *
 * Typing a fragment after `@` asks tugcast which of this checkout's dockets
 * it names (`search_dockets`), matched by name or id, newest first. A retired
 * docket is not offered: retiring is how a docket leaves the everyday lists.
 * Each row is offered as the docket atom it mints.
 *
 * @module components/tugways/cards/completion-providers/docket-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { getConnection } from "@/lib/connection-singleton";
import { docketAtomSegment } from "@/lib/docket-atom";
import { onDocketSearchAnswer } from "@/lib/docket-search-answers";
import { encodeSearchDockets, type SearchedDocket } from "@/protocol";
import {
  createRemoteSearchProvider,
  labelMatch,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

export interface DocketMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The wire. Omitted ⇒ the page's connection and the CONTROL fan-out. */
  transport?: RemoteSearchTransport<SearchedDocket>;
  now?: () => number;
}

/** The popup item for a searched docket, owned by the checkout it lives in. */
export function docketMentionItem(row: SearchedDocket, query: string): CompletionItem {
  const atom = docketAtomSegment({ id: row.id, name: row.name, projectDir: row.projectDir });
  const item: CompletionItem = { label: atom.label, atom, description: `docket:${row.id}` };
  const matches = labelMatch(atom.label, query);
  if (matches !== undefined) item.matches = matches;
  return item;
}

function liveTransport(): RemoteSearchTransport<SearchedDocket> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const frame = encodeSearchDockets({
        query: request.query,
        projectDir: request.scope,
        requestId: request.requestId,
      });
      connection.send(frame.feedId, frame.payload);
      return true;
    },
    onAnswer(listener) {
      return onDocketSearchAnswer((answer) => {
        if (answer.requestId === null) return;
        listener({
          requestId: answer.requestId,
          rows: answer.dockets.filter((d) => !d.retired),
        });
      });
    },
  };
}

export function createDocketMentionProvider(
  options: DocketMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<SearchedDocket>({
    idPrefix: "dm",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    stillMatches: (row, query) =>
      !row.retired && (row.id.startsWith(query) || row.name.toLowerCase().includes(query)),
    // The search is this checkout's store, so a composer with no project has
    // no docket to offer.
    toItem: (row, query) =>
      options.projectDir() === "" || row.retired ? null : docketMentionItem(row, query),
  });
}
