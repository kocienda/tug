/**
 * Every message the pages and the Swift host trade, listed once.
 *
 * Each lives in a file under `host/declarations/`, beside its codec and
 * samples, and is listed here. `__tests__/registry.test.ts` holds the two in
 * step and every codec to its samples; `__tests__/host-parity.test.ts`
 * writes the fixture `TugTests/HostChannelTests.swift` checks the Swift
 * twin, `HostMessages.swift`, against.
 *
 * @module host/registry
 */

import type { PageCall, ToHost, ToPage } from "./declare";
import {
  beatPlanToHost,
  bodyCrossingToPage,
  cardGestureToHost,
  cardGestureToPage,
  cardInsetsToPage,
  cardLandToHost,
  floorGridToHost,
  placeBodiesToHost,
  placeCardsToHost,
  pointerClaimToHost,
} from "./declarations/geometry";
import {
  bodyBindToPage,
  bodyCreateToHost,
  bodyDestroyToHost,
  bodyFocusToHost,
  bodyHelloToHost,
  bodyStateToPage,
  bodySurfaceToHost,
  crossingReadyToHost,
  frontendLaunchStalledToHost,
  frontendReadyToHost,
  hmrUpdateToHost,
  pageFaultToHost,
  paintedToHost,
  prepareForTerminationCall,
  reauthenticateCall,
  saveStateCall,
} from "./declarations/lifecycle";
import {
  activationClickToPage,
  choosePathToHost,
  clipboardReadToHost,
  clipboardReadToPage,
  clipboardWriteImageToHost,
  clipboardWriteToHost,
  devBadgeToHost,
  devModeErrorToPage,
  dictationToHost,
  dictationToPage,
  exportDoneToPage,
  exportSessionToHost,
  getSettingsToHost,
  hostFramesToHost,
  hostFramesToPage,
  lookUpInDictionaryToHost,
  menuStateToHost,
  networkPathToPage,
  openPathToHost,
  pageZoomApplyCall,
  pageZoomToHost,
  pageZoomToPage,
  pathChosenToPage,
  restorePathToHost,
  scrollPhaseToPage,
  setThemeToHost,
  settingsLoadedToPage,
  sourceTreeCancelledToPage,
  sourceTreeSelectedToPage,
  sourceTreeToHost,
  thumbnailPathToHost,
  thumbnailToPage,
  trashPathToHost,
  trashResultToPage,
  updateActionToHost,
  updateStateToPage,
} from "./declarations/services";

/** Every page→host message. */
export const TO_HOST: readonly ToHost<unknown>[] = [
  // geometry
  placeBodiesToHost,
  placeCardsToHost,
  cardGestureToHost,
  cardLandToHost,
  beatPlanToHost,
  pointerClaimToHost,
  floorGridToHost,
  // lifecycle
  bodyHelloToHost,
  paintedToHost,
  frontendReadyToHost,
  frontendLaunchStalledToHost,
  pageFaultToHost,
  crossingReadyToHost,
  bodySurfaceToHost,
  bodyCreateToHost,
  bodyDestroyToHost,
  bodyFocusToHost,
  hmrUpdateToHost,
  // services
  sourceTreeToHost,
  choosePathToHost,
  getSettingsToHost,
  setThemeToHost,
  devBadgeToHost,
  clipboardReadToHost,
  clipboardWriteToHost,
  clipboardWriteImageToHost,
  menuStateToHost,
  openPathToHost,
  lookUpInDictionaryToHost,
  trashPathToHost,
  restorePathToHost,
  thumbnailPathToHost,
  exportSessionToHost,
  updateActionToHost,
  dictationToHost,
  pageZoomToHost,
  hostFramesToHost,
] as readonly ToHost<unknown>[];

/** Every host→page message, one `window.__tugBridge` member each. */
export const TO_PAGE: readonly ToPage<unknown>[] = [
  // geometry
  cardGestureToPage,
  cardInsetsToPage,
  bodyCrossingToPage,
  // lifecycle
  bodyBindToPage,
  bodyStateToPage,
  // services
  settingsLoadedToPage,
  devModeErrorToPage,
  sourceTreeSelectedToPage,
  sourceTreeCancelledToPage,
  pathChosenToPage,
  exportDoneToPage,
  clipboardReadToPage,
  trashResultToPage,
  thumbnailToPage,
  hostFramesToPage,
  dictationToPage,
  updateStateToPage,
  pageZoomToPage,
  activationClickToPage,
  networkPathToPage,
  scrollPhaseToPage,
] as readonly ToPage<unknown>[];

/** Every call the host makes into a page and awaits. */
export const PAGE_CALLS: readonly PageCall<unknown, unknown>[] = [
  saveStateCall,
  prepareForTerminationCall,
  reauthenticateCall,
  pageZoomApplyCall,
] as readonly PageCall<unknown, unknown>[];
