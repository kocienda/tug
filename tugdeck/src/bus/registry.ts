/**
 * Every shared store, routed action and request the deck declares.
 *
 * Each lives in a file under `bus/declarations/`, beside its payload type and
 * codec, and is listed here. `__tests__/registry.test.ts` holds the two in
 * step: nothing is declared outside `declarations/`, everything declared
 * there is listed here, and every codec round-trips its sample.
 *
 * @module bus/registry
 */

import {
  appInfo,
  arrangementCardFacts,
  arrangementDeck,
  arrangementSpaces,
  cardFollowed,
  cardsLedgerBindings,
  cardsSpaceVerb,
  deckActivateCard,
  deckActivateSpace,
  deckCardActivities,
  deckCardBindings,
  deckChooseSpaceTheme,
  deckMoveCardToSpace,
  deckPreviewFlowOffset,
  deckRenameSpace,
  deckReorderSpaces,
  deckSetFlowOffset,
  layoutSelection,
} from "./declarations/arrangement";
import {
  cardContent,
  cardContext,
  cardCrossing,
  cardFacts,
  cardHolds,
  cardInspected,
  cardInspection,
  cardKbfPaint,
  cardPainted,
  cardReservations,
  cardRestoreHold,
  cardSurface,
  devtoolsInspection,
} from "./declarations/card";
import { deckFacts, deckFrontmostProject, deckMenu } from "./declarations/deck";
import {
  cardBinding,
  miniatureCarry,
  miniatureCommit,
  miniatureDemand,
  miniatureGauges,
  miniatureOutline,
  miniatureZones,
  overviewDraft,
} from "./declarations/relays";
import {
  busNote,
  busPing,
  busProbe,
  cardContentAction,
  cardRefuseHold,
  cardsShrink,
  appLogout,
  cardActivate,
  cardAddSibling,
  cardClose,
  cardCloseDecision,
  commandForCard,
  commandForShell,
  devtoolsLogEntries,
  focusEnter,
  focusExit,
  jotsNewJot,
  sessionAsk,
  sessionIntent,
  settingsReveal,
  surfaceActivate,
  surfaceDismissed,
  textRevealLine,
} from "./declarations/verbs";
import type { RoutedAction } from "./routed-action";
import type { Request } from "./request";
import type { SharedStore } from "./shared-store";

/** A store of any value type, with or without proposals. */
export type AnySharedStore = SharedStore<any, any> | SharedStore<any, never>;

export const SHARED_STORES: readonly AnySharedStore[] = [
  deckFacts,
  deckMenu,
  deckFrontmostProject,
  cardCrossing,
  cardContext,
  cardFacts,
  cardHolds,
  cardReservations,
  cardSurface,
  cardPainted,
  cardRestoreHold,
  cardContent,
  cardKbfPaint,
  cardInspection,
  cardInspected,
  devtoolsInspection,
  deckCardBindings,
  deckCardActivities,
  arrangementDeck,
  arrangementSpaces,
  arrangementCardFacts,
  cardsLedgerBindings,
  layoutSelection,
  cardFollowed,
  appInfo,
  cardBinding,
  overviewDraft,
  miniatureDemand,
  miniatureGauges,
  busProbe,
];

export const ROUTED_ACTIONS: readonly RoutedAction<any>[] = [
  deckActivateCard,
  deckSetFlowOffset,
  deckPreviewFlowOffset,
  deckActivateSpace,
  deckRenameSpace,
  deckChooseSpaceTheme,
  deckMoveCardToSpace,
  deckReorderSpaces,
  cardsSpaceVerb,
  miniatureOutline,
  miniatureCarry,
  miniatureCommit,
  commandForCard,
  commandForShell,
  cardActivate,
  cardClose,
  cardAddSibling,
  appLogout,
  focusEnter,
  focusExit,
  surfaceActivate,
  surfaceDismissed,
  cardContentAction,
  textRevealLine,
  settingsReveal,
  jotsNewJot,
  sessionIntent,
  cardRefuseHold,
  cardsShrink,
  devtoolsLogEntries,
  busNote,
];

export const REQUESTS: readonly Request<any, any>[] = [miniatureZones, sessionAsk, cardCloseDecision, busPing];
