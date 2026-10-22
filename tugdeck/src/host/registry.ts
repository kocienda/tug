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
  cardPlanToHost,
  bodyCrossingToPage,
  cardGestureToHost,
  cardGestureToPage,
  cardInsetsToPage,
  placeCardsToHost,
} from "./declarations/geometry";
import {
  bodyBindToPage,
  bodyCreateToHost,
  bodyDestroyToHost,
  bodyEvictAfterToHost,
  bodyFocusToHost,
  bodyHelloToHost,
  bodyPressureToPage,
  bodyStateToPage,
  bodySurfaceToHost,
  bodyVisibilityToPage,
  crossingReadyToHost,
  frontendLaunchStalledToHost,
  launchLapToHost,
  frontendReadyToHost,
  hmrUpdateToHost,
  pageFaultToHost,
  paintedToHost,
  prepareForTerminationCall,
  railEdgeCall,
  railLandCall,
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
  sourceTreeToHost,
  thumbnailPathToHost,
  thumbnailToPage,
  trashPathToHost,
  trashResultToPage,
  updateActionToHost,
  updateStateToPage,
} from "./declarations/services";
import { overlayClaimToHost, overlayCreateToHost } from "./declarations/overlay";

/** Every page→host message. */
export const TO_HOST: readonly ToHost<unknown>[] = [
  // geometry
  placeCardsToHost,
  cardGestureToHost,
  cardPlanToHost,
  // overlay
  overlayCreateToHost,
  overlayClaimToHost,
  // lifecycle
  bodyHelloToHost,
  paintedToHost,
  frontendReadyToHost,
  frontendLaunchStalledToHost,
  launchLapToHost,
  pageFaultToHost,
  crossingReadyToHost,
  bodySurfaceToHost,
  bodyCreateToHost,
  bodyDestroyToHost,
  bodyEvictAfterToHost,
  bodyFocusToHost,
  hmrUpdateToHost,
  // services
  sourceTreeToHost,
  choosePathToHost,
  getSettingsToHost,
  setThemeToHost,
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
  bodyPressureToPage,
  bodyStateToPage,
  bodyVisibilityToPage,
  // services
  settingsLoadedToPage,
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
  railEdgeCall,
  railLandCall,
  reauthenticateCall,
  pageZoomApplyCall,
] as readonly PageCall<unknown, unknown>[];
