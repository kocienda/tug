/**
 * The overlay page's one React tree, rendered once at boot ([L01]).
 *
 * It holds the margin caps over every card, the deck's bulletin stack, the
 * app-modals and the update notice (`AppGates`), the singleton
 * alert the shell's alerts are shown in, Open Quickly and the zoom readout,
 * and the canvas overlay root they all portal into. Nothing in it reads a
 * card's geometry: the one surface that names a card at all reads
 * `overlay.surfaces`, which holds a card only at rest ([B07],
 * `overlay-census.ts`).
 *
 * @module overlay/overlay-root
 */

import React, { useLayoutEffect } from "react";
import { overlayAlert, overlayBulletin, overlayBulletinInsets } from "../bus/declarations/overlay";
import { CanvasOverlayRoot } from "../components/chrome/canvas-overlay-root";
import { OpenQuicklyOverlay } from "../components/chrome/open-quickly-overlay";
import { ZoomReadout } from "../components/chrome/zoom-readout";
import { OverlayMarginCaps } from "./overlay-margin-caps";
import { ErrorBoundary } from "../components/chrome/error-boundary";
import { AppGates } from "../components/tugways/app-gates";
import { ResponderChainProvider } from "../components/tugways/responder-chain-provider";
import { TugAlertProvider, useTugAlert } from "../components/tugways/tug-alert";
import { setBulletinInsets, showBulletinHere, TugBulletinProvider } from "../components/tugways/tug-bulletin";
import { TugTooltipProvider } from "../components/tugways/tug-tooltip";
import { TugThemeProvider } from "../contexts/theme-provider";
import { composeProviders } from "../lib/compose-providers";
import { GateDeckContext, type GateDeck } from "../lib/gate-deck";

/**
 * Answer the shell's alert requests with this page's alert: each is shown,
 * and its answer is the reply. Registered in a layout effect, because the
 * request may already be waiting when the page mounts ([L03]). A field the
 * shell left unset is dropped rather than passed as `undefined`: the alert
 * reads a present `cancelLabel` or `icon` as the caller's, so an `undefined`
 * one would take away its default Cancel.
 */
function AlertAnswerer(): null {
  const showAlert = useTugAlert();
  useLayoutEffect(
    () =>
      overlayAlert.handle(async (options) => {
        const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
        return { confirmed: await showAlert(given) };
      }),
    [showAlert],
  );
  return null;
}

/**
 * Show the shell's deck bulletins in this page's stack, above every card,
 * and keep the stack clear of the rails the shell lays out. Registered in a
 * layout effect, because a bulletin may already be waiting when the page
 * mounts ([L03]). The insets reach the stack through the DOM alone
 * (`setBulletinInsets`), so a rail's change renders nothing here ([L06]).
 */
function BulletinAnswerer(): null {
  useLayoutEffect(() => {
    const follow = (): void => setBulletinInsets(overlayBulletinInsets.getSnapshot());
    const releaseInsets = overlayBulletinInsets.subscribe(follow);
    follow();
    const releaseBulletins = overlayBulletin.handle((relayed) => showBulletinHere(relayed));
    return () => {
      releaseInsets();
      releaseBulletins();
    };
  }, []);
  return null;
}

export function renderOverlayRoot(props: { gateDeck: GateDeck }): React.ReactElement {
  return composeProviders(
    [
      [TugThemeProvider, null],
      [TugTooltipProvider, null],
      [ErrorBoundary, null],
      [ResponderChainProvider, null],
      [TugAlertProvider, null],
      [TugBulletinProvider, null],
      [GateDeckContext.Provider, { value: props.gateDeck }],
    ],
    React.createElement(
      React.Fragment,
      null,
      React.createElement(OverlayMarginCaps, {}),
      React.createElement(AppGates, {}),
      React.createElement(AlertAnswerer, {}),
      React.createElement(BulletinAnswerer, {}),
      React.createElement(CanvasOverlayRoot, {}),
      React.createElement(OpenQuicklyOverlay, {}),
      React.createElement(ZoomReadout, {}),
    ),
  );
}
