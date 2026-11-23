/**
 * sketch-mentions.ts — the completion provider that offers sketches.
 *
 * Typing a fragment after `@` asks tugcast which of this checkout's sketches
 * it names (`search_sketches`), matched by id, arc name or want, the most
 * recently written first. Each row is offered as the sketch atom it mints,
 * with the sketch's want as its description.
 *
 * @module components/tugways/cards/completion-providers/sketch-mentions
 */

import type { CompletionItem } from "@/lib/tug-text-types";
import { getConnection } from "@/lib/connection-singleton";
import { sketchAtomSegment } from "@/lib/sketch-atom";
import { onSketchSearchAnswer } from "@/lib/sketch-search-answers";
import { encodeSearchSketches, type SearchedSketch } from "@/protocol";
import {
  createRemoteSearchProvider,
  labelMatch,
  type RemoteSearchProvider,
  type RemoteSearchTransport,
} from "./remote-search";

export interface SketchMentionProviderOptions {
  /** The composer's project dir, read fresh on every query. */
  projectDir: () => string;
  /** The wire. Omitted ⇒ the page's connection and the CONTROL fan-out. */
  transport?: RemoteSearchTransport<SearchedSketch>;
  now?: () => number;
}

/** The popup item for a searched sketch, owned by the checkout it was searched in. */
export function sketchMentionItem(
  row: SearchedSketch,
  query: string,
  projectDir: string,
): CompletionItem {
  const atom = sketchAtomSegment({ id: row.id, projectDir });
  const item: CompletionItem = { label: atom.label, atom };
  const matches = labelMatch(atom.label, query);
  if (matches !== undefined) item.matches = matches;
  if (row.want !== null) item.description = row.want;
  return item;
}

function liveTransport(): RemoteSearchTransport<SearchedSketch> {
  return {
    send(request) {
      const connection = getConnection();
      if (connection === null) return false;
      const frame = encodeSearchSketches({
        query: request.query,
        projectDir: request.scope,
        requestId: request.requestId,
      });
      connection.send(frame.feedId, frame.payload);
      return true;
    },
    onAnswer(listener) {
      return onSketchSearchAnswer((answer) => {
        if (answer.requestId === null) return;
        listener({ requestId: answer.requestId, rows: answer.sketches });
      });
    },
  };
}

export function createSketchMentionProvider(
  options: SketchMentionProviderOptions,
): RemoteSearchProvider {
  return createRemoteSearchProvider<SearchedSketch>({
    idPrefix: "km",
    transport: options.transport ?? liveTransport(),
    scope: options.projectDir,
    now: options.now,
    stillMatches: (row, query) =>
      row.id.includes(query) ||
      (row.arc?.name ?? "").toLowerCase().includes(query) ||
      (row.want ?? "").toLowerCase().includes(query),
    // The search is this checkout's store, so a composer with no project has
    // no sketch to offer.
    toItem: (row, query) => {
      const projectDir = options.projectDir();
      return projectDir === "" ? null : sketchMentionItem(row, query, projectDir);
    },
  });
}
