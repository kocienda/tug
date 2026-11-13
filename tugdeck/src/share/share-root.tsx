/**
 * share-root.tsx — what the share page draws: the header, then the shared
 * turns through the card's own transcript cells, in one 720-pixel column.
 *
 * The cells were written for a Session card, and the providers here are the
 * ones a card's page sets up around them, each holding the honest empty a
 * page with no card has: a theme provider and a tooltip provider, a
 * responder chain with nobody in it, no card id (so an annotation resolves
 * no binding, as it does for any card with none), and no find registry. The
 * two values this page does have are its own: the tool blocks' collapsed
 * state, seeded from the share's tool mode, and each turn's number in the
 * card it came from. No cell carries a share branch beyond that number.
 *
 * @module share/share-root
 */

import React from "react";
import { TugThemeProvider } from "../contexts/theme-provider";
import { TugTooltipProvider } from "../components/tugways/tug-tooltip";
import { ResponderChainProvider } from "../components/tugways/responder-chain-provider";
import { ToolBlockExpansionContext } from "../components/tugways/blocks/collapse-context";
import type { ToolBlockExpansionState } from "../components/tugways/blocks/expansion-state";
import {
  SessionShareTranscript,
  ShareTurnNumberContext,
} from "../components/tugways/cards/session-card-transcript";
import type { CodeSessionStore } from "../lib/code-session-store";
import type { SessionMetadataStore } from "../lib/session-metadata-store";
import type { ShareHeader } from "../lib/share-turns";

export interface ShareRootProps {
  header: ShareHeader;
  codeSessionStore: CodeSessionStore;
  sessionMetadataStore: SessionMetadataStore;
  expansion: ToolBlockExpansionState;
  turnNumbers: ReadonlyMap<string, number>;
}

/** The facts line under the title: whichever of project, dates and turns are known. */
function factsLine(header: ShareHeader): string {
  return [header.project, header.dates, header.turns].filter((part) => part !== "").join(" · ");
}

export function ShareRoot({
  header,
  codeSessionStore,
  sessionMetadataStore,
  expansion,
  turnNumbers,
}: ShareRootProps): React.ReactElement {
  const facts = factsLine(header);
  return (
    <TugThemeProvider>
      <TugTooltipProvider>
        <ResponderChainProvider>
          <ToolBlockExpansionContext.Provider value={expansion}>
            <ShareTurnNumberContext.Provider value={turnNumbers}>
              <main className="share-page" data-slot="share-page">
                <header className="share-page__header" data-slot="share-page-header">
                  <h1 className="share-page__title">{header.title}</h1>
                  {facts !== "" ? <p className="share-page__facts">{facts}</p> : null}
                </header>
                <SessionShareTranscript
                  codeSessionStore={codeSessionStore}
                  sessionMetadataStore={sessionMetadataStore}
                />
              </main>
            </ShareTurnNumberContext.Provider>
          </ToolBlockExpansionContext.Provider>
        </ResponderChainProvider>
      </TugTooltipProvider>
    </TugThemeProvider>
  );
}
