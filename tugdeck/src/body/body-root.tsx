/**
 * The React root of a card's body page: the deck's provider stack around one
 * `CardHost`.
 *
 * The stack is `DeckManager`'s root render without the members only a deck
 * has — the canvas, the banner, the bulletins, the app-wide gates — with the
 * bridge standing in as the deck. `CardHost` finds its content, root and
 * frame elements by its `hostStackId` in the pane registries rather than by
 * props, so this root renders the frame / root / content trio a pane would
 * and registers each under the body's pane id before the host reads them
 * ([L03]), unregistering on teardown ([L27]). Rendered once, at mount ([L01]).
 *
 * @module body/body-root
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { getRegistration, isEngineManagedCard } from "../card-registry";
import { takeBiddenUnfold } from "../lib/card-fold";
import { useFocusManager } from "../components/tugways/use-focusable";
import { composeProviders } from "../lib/compose-providers";
import { useSyncExternalStore } from "../lib/gesture-scope";
import { TugThemeProvider } from "../contexts/theme-provider";
import { TugTooltipProvider } from "../components/tugways/tug-tooltip";
import { ErrorBoundary } from "../components/chrome/error-boundary";
import { ResponderChainProvider } from "../components/tugways/responder-chain-provider";
import { TugAlertProvider } from "../components/tugways/tug-alert";
import { DeckManagerContext } from "../deck-manager-context";
import { CardLifecycleContext } from "../lib/card-lifecycle";
import { AppLifecycleContext, type AppLifecycle } from "../lib/app-lifecycle";
import { SheetLifecycleContext, type SheetLifecycle } from "../lib/sheet-lifecycle";
import { BannerLifecycleContext, type BannerLifecycle } from "../lib/banner-lifecycle";
import { SpaceLayerShownContext } from "../components/chrome/space-layer";
import { CanvasOverlayRoot } from "../components/chrome/canvas-overlay-root";
import { CardHost } from "../components/chrome/card-host";
import { useResponder } from "../components/tugways/use-responder";
import type { ActionEvent } from "../components/tugways/responder-chain";
import { TUG_ACTIONS } from "../components/tugways/action-vocabulary";
import * as paneContentRegistry from "../components/chrome/pane-content-registry";
import * as paneFrameRegistry from "../components/chrome/pane-frame-registry";
import * as paneRootRegistry from "../components/chrome/pane-root-registry";
import { CANVAS_BACKGROUND_ATTRIBUTE } from "../lib/pane-frame-selectors";
import { RAIL_TREATMENT, RAIL_TREATMENT_ATTRIBUTE } from "../lib/layout-imposer";
import { bodyPaneId, type BodyDeckBridge } from "./body-deck-bridge";
import { refuseCardModalHold } from "../lib/card-modal-hold-store";
import { getCardCloseGuard } from "../lib/card-close-guard";
import { UsageContext } from "../lib/usage-context";
import type { UsageStore } from "../lib/usage-store";

export interface BodyRootProps {
  bridge: BodyDeckBridge;
  componentId: string;
  appLifecycle: AppLifecycle;
  sheetLifecycle: SheetLifecycle;
  bannerLifecycle: BannerLifecycle;
  /** This page's `/usage` store, which the Session card's sheet reads. */
  usageStore: UsageStore;
}

/**
 * The frame / root / content trio a pane renders, registered under the body's
 * pane id, and the `card`-kind responder a pane is. The chain finds a page's
 * key card by walking up from its first responder to a `card` node — in the
 * shell that is the card's pane — so without one here a key-card command
 * (Focus Prompt, Find, the turn items) would find no card in the body at all.
 * The card's own responders register beneath it, and its frame carries the
 * node's `data-responder-id` so the content scan finds them in the DOM.
 */
function BodyPane({
  bridge,
  cardId,
  componentId,
}: {
  bridge: BodyDeckBridge;
  cardId: string;
  componentId: string;
}): React.ReactElement {
  const paneId = bodyPaneId(cardId);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  // The pane currency a card's content can send its pane: `ADD_TAB` and
  // `CLOSE_TAB` are not commands, so the unhandled-target hook would not
  // forward them; answered here as the shell's pane answers them. A
  // `CLOSE_TAB` for this card — the unbound Session card's picker Cancel
  // sends one — meets the card's modal hold first and its own close guard
  // next, as the shell's tab × does, and then asks the shell to close it.
  const actions = React.useMemo(
    () => ({
      [TUG_ACTIONS.ADD_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        bridge.addCardToPane(paneId, event.value);
      },
      [TUG_ACTIONS.CLOSE_TAB]: (event: ActionEvent) => {
        if (event.value !== cardId) return;
        if (refuseCardModalHold(cardId)) return;
        const guard = getCardCloseGuard(cardId);
        if (guard === null) {
          bridge.removeCard(paneId, cardId);
          return;
        }
        void guard.run().then((answer) => {
          if (answer === "close") bridge.removeCard(paneId, cardId);
        });
      },
    }),
    [bridge, paneId, cardId],
  );
  const { ResponderScope, responderRef } = useResponder({ id: paneId, kind: "card", actions });
  // The shell's rule for a focused pane (`pane-focus-controller.ts`): it is
  // the deck's active pane. Here the deck is this card's, and its active
  // pane is set exactly when the card is the whole deck's first responder.
  // Written as an attribute the recede's layers key on ([L02], [L06]).
  const focused = useSyncExternalStore(
    bridge.subscribe,
    () => bridge.getSnapshot().activePaneId !== undefined,
  );
  useLayoutEffect(() => {
    for (const el of [frameEl, rootEl]) {
      if (el !== null) el.dataset.focused = focused ? "true" : "false";
    }
  }, [frameEl, rootEl, focused]);
  // The fold the shell's pane stands under, on this page's frame as the
  // shell's pane writes it on its own (`tug-pane.tsx`): the generic folded
  // form (`holdFoldedBody`) watches the frame's `data-folded` to land
  // `data-card-fold` and `inert` on the card host ([L06]). The crossing the
  // shell relays is mirrored on the frame before the context reaches the
  // bridge (`body-main.ts`), so the fold's end is heard here as there.
  //
  // The unfold's keyboard hand-back is this page's too. The shell's
  // `useCardFoldFocus` hands the keyboard back to an open card's content, and
  // a body card's content — its editor's engine hooks, its key view — is
  // here, where the shell's placement cannot reach. So on the flip to open,
  // a card in the generic folded form that holds first responder, and was
  // not opened for a surface that places its own focus (`takeBiddenUnfold`),
  // is handed its content as the shell's hook would hand it. Queued behind
  // the fold observer's microtask, which this write queued first and which
  // lifts the host's `inert`. The fold itself moves nothing here: the
  // keyboard goes to the shell's glyph.
  const focusManager = useFocusManager();
  const folded = useSyncExternalStore(bridge.subscribe, () => bridge.getContext().folded === true);
  const lastFoldedRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (frameEl === null) return;
    if (folded) frameEl.setAttribute("data-folded", "true");
    else frameEl.removeAttribute("data-folded");
    const wasFolded = lastFoldedRef.current;
    lastFoldedRef.current = folded;
    if (folded || wasFolded !== true) return;
    const bidden = takeBiddenUnfold(cardId);
    if (bidden || focusManager === null || getRegistration(componentId)?.ownsFoldedForm === true) return;
    queueMicrotask(() => {
      if (bridge.getContext().firstResponderCardId !== cardId) return;
      if (isEngineManagedCard(componentId)) {
        focusManager.place(cardId, { kind: "engine" }, { modality: "pointer" });
      } else {
        focusManager.adoptKeyCard(cardId);
      }
    });
  }, [frameEl, folded, bridge, cardId, componentId, focusManager]);
  // A pinned rail paints the rail's own surface: the shell's treatment rule
  // keys on the deck's treatment and the pane's pinned side, and this page's
  // `body` is where its surface token resolves, so both are written here
  // ([L06]). The treatment is the shell's constant; the side is the shell's
  // word in the card's context.
  const railSide = useSyncExternalStore(bridge.subscribe, bridge.getRailSide);
  useLayoutEffect(() => {
    document.documentElement.setAttribute(RAIL_TREATMENT_ATTRIBUTE, RAIL_TREATMENT);
    if (railSide === null) delete document.body.dataset.bodyRailSide;
    else document.body.dataset.bodyRailSide = railSide;
  }, [railSide]);
  const setFrame = useCallback(
    (el: HTMLDivElement | null) => {
      setFrameEl(el);
      responderRef(el);
    },
    [responderRef],
  );

  useLayoutEffect(() => {
    if (frameEl === null) return;
    paneFrameRegistry.register(paneId, frameEl);
    return () => paneFrameRegistry.unregister(paneId);
  }, [paneId, frameEl]);
  useLayoutEffect(() => {
    if (rootEl === null) return;
    paneRootRegistry.register(paneId, rootEl);
    return () => paneRootRegistry.unregister(paneId);
  }, [paneId, rootEl]);
  useLayoutEffect(() => {
    if (contentEl === null) return;
    paneContentRegistry.register(paneId, contentEl);
    return () => paneContentRegistry.unregister(paneId);
  }, [paneId, contentEl]);

  return (
    <>
      {/* The page's canvas: the box a pane-modal sheet measures its band
          against (`paneCanvasOf`), which in the shell is the deck's. A body's
          visible canvas is its viewport, so it stands here under the frame;
          without it the sheet's measure refused and a bottom-anchored cover
          rose from the top. The frame covers it, so no pointer meets it. */}
      <div className="body-canvas" {...{ [CANVAS_BACKGROUND_ATTRIBUTE]: "" }}>
        <div ref={setFrame} className="body-pane-frame" data-pane-id={paneId}>
          <div ref={setRootEl} className="body-pane-root" data-card-id={cardId}>
            <div ref={setContentEl} className="tug-pane-content" data-testid="tug-pane-content" />
          </div>
        </div>
      </div>
      <ResponderScope>
        <CardHost cardId={cardId} hostStackId={paneId} componentId={componentId} isActive />
      </ResponderScope>
    </>
  );
}

export function renderBodyRoot(props: BodyRootProps): React.ReactElement {
  const { bridge, componentId } = props;
  return composeProviders(
    [
      [TugThemeProvider, null],
      [TugTooltipProvider, null],
      [ErrorBoundary, null],
      [ResponderChainProvider, null],
      [DeckManagerContext.Provider, { value: bridge }],
      [UsageContext.Provider, { value: props.usageStore }],
      [CardLifecycleContext.Provider, { value: bridge.cardLifecycle }],
      [AppLifecycleContext.Provider, { value: props.appLifecycle }],
      [SheetLifecycleContext.Provider, { value: props.sheetLifecycle }],
      [BannerLifecycleContext.Provider, { value: props.bannerLifecycle }],
      [TugAlertProvider, null],
      [SpaceLayerShownContext.Provider, { value: bridge.layerShownSource }],
    ],
    React.createElement(
      React.Fragment,
      null,
      React.createElement(BodyPane, { bridge, cardId: bridge.cardId, componentId }),
      React.createElement(CanvasOverlayRoot, {}),
    ),
  );
}
