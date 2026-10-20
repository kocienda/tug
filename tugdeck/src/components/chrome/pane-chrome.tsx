/**
 * PaneChrome — a pane's chrome, rendered from a model: the resize grips, the
 * `.tug-pane-chrome` root, the title bar, the accessory or tab bar, the
 * `.tug-pane-body` with its `.tug-pane-content` portal target, and the scrim.
 *
 * It reads nothing about where it runs. Everything it draws arrives as
 * {@link PaneChromeModel} (the `pane.chrome` value's facts, in the shape the
 * title bar takes them) and everything it does leaves through
 * {@link PaneChromeVerbs}. `TugPane` builds the model from its props and hands
 * verbs that call the deck; the frame element, its `data-*` attributes and
 * its geometry stay `TugPane`'s ([L09]). A tab gesture reaches the pane the
 * way it always has, through the responder chain (`SELECT_TAB`, `CLOSE_TAB`,
 * `ADD_TAB`), so the verbs carry none.
 *
 * @module components/chrome/pane-chrome
 */

import "../tugways/tug-pane.css";
import React, { createContext, type Ref, type RefObject } from "react";
import type { CardState } from "@/layout-tree";
import type { SlotStackEntry } from "@/deck-store-selectors";
import type { CardMastheadPayload } from "@/lib/card-title-store";
import type { ContentWidth } from "@/lib/layout-imposer";
import type { CardCloseDecision } from "@/lib/card-close-guard";
import type { CardCloseAdvice } from "@/lib/card-close-advice";
import type { ResizeEdge } from "@/lib/pane-chrome-projection";
import type { SlotFacts } from "@/lib/slot-facts";
import { TugTabBar } from "@/components/tugways/tug-tab-bar";
import {
  CardTitleBar,
  type CardTitleBarHandle,
  type CardTitleBarProps,
} from "./card-title-bar";

// ===========================================================================
// Portal contexts (card content consumes these)
// ===========================================================================

/**
 * React context: the pane frame's root element (`HTMLDivElement`, the
 * `.tug-pane-chrome` host). Sheet and tooltip layers portal here so overlays attach
 * inside the pane's chrome. Card content outside the `TugPane` tree
 * (e.g. `CardHost`) re-bridges this via `pane-root-registry`.
 */
export const TugPanePortalContext = createContext<HTMLDivElement | null>(null);

/**
 * React context: the pane frame element (`HTMLDivElement`, the `.tug-pane`
 * outer frame, parent of the chrome). Pane-modal surfaces (`TugSheet`,
 * future modal-class surfaces) portal into this element so their panel
 * moves with the pane through drags, resizes and column reflows with no
 * applier of its own [D19, D20]. Paint ORDER against peer panes is a
 * separate question and the frame answers it the other way: while a
 * pane-modal surface is up the frame wears `data-sheet-open` and is
 * lifted above every peer (`tug-pane.css`), because a surface the user
 * is being asked to answer should not be partly under a neighbour.
 * `tuglaws/pane-model.md` carries the argument.
 *
 * The frame's `position: absolute` + inline `z-index` makes it its own
 * stacking context. The frame has `overflow: visible` (default) so a
 * panel whose natural height exceeds the chrome's body can extend into
 * the canvas grid below, and past the frame's own edges in either
 * direction — which is what the ban on `overflow`/`transform`/`contain`
 * in `tug-pane.css` exists to keep possible.
 *
 * Standalone consumers (gallery preview, tests rendered without a
 * `TugPane` ancestor) read `null` and fall back to `document.body` —
 * same shape as `useCanvasOverlay`'s null fallback. Production code
 * always renders pane-modal surfaces inside a `TugPane`.
 */
export const TugPaneFrameContext = createContext<HTMLDivElement | null>(null);

// ===========================================================================
// The model and the verbs
// ===========================================================================

/** What a pane's chrome draws. */
export interface PaneChromeModel {
  paneId: string;
  /** The title bar's text, composed over the active card. */
  title: string;
  icon: string | undefined;
  closable: boolean;
  /** Whether the × asks before it closes the pane. */
  confirmClose: boolean;
  /** `"sidebar"` puts the bar in the rail tier and drops its rollup. */
  role: "content" | "sidebar";
  /** The pane's cards in tab order; the tab bar draws them past one. */
  tabs: readonly CardState[];
  activeCardId: string | undefined;
  /** The families the tab bar's add-tab menu offers. */
  acceptedFamilies: readonly string[] | undefined;
  /** How many cards the pane holds, which words the close confirm. */
  cardCount: number;
  /** The noun the single-card close confirm names the card by. */
  cardKind: string;
  /** The edges the hand may resize the pane from. */
  grips: readonly ResizeEdge[];
  /** Whether {@link grips} is a rail's one width edge rather than a pane's resize edges. */
  railGrip: boolean;
  /** The width menu with the preset it checks; null when it is not offered. */
  width: { preset: ContentWidth | null } | null;
  /** The Fill Height row with whether the pane fills its run; null when it is not offered. Read only beside {@link width}. */
  fillHeight: { fills: boolean } | null;
  /** The place badge's arrangement; null for a pane standing in no place. A column's offers its verbs, a rail's does not. */
  placeArrangement: NonNullable<CardTitleBarProps["placeArrangement"]> | null;
  /** The pane whose place the badge reads off the deck; omitted where no deck stands behind the chrome. */
  placePaneId?: string;
  /** The place badge's picker rows, where no deck stands behind the chrome to read them from. */
  slotStack?: readonly SlotStackEntry[];
  /** The slot badge's facts, where no deck stands behind the chrome to read them from. */
  slot?: SlotFacts | null;
  /** The move control's workspaces and the pane's own, where no deck stands behind the chrome. */
  spaces?: { spaces: readonly { id: string; name: string }[]; ownSpaceId: string | undefined };
  /** Whether the pane stands in bullseye; null when the verb is not offered (a rail), which drops the move control too. */
  bullseye: boolean | null;
  /** Whether the bar draws the folded form. */
  folded: boolean;
  /** Whether the bar carries the fold's door for the active card. */
  cardFold: boolean;
}

/** What a pane's chrome does: one callback per gesture it can start. */
export interface PaneChromeVerbs {
  onClosePane: () => void;
  onSetWidth: (preset: ContentWidth) => void;
  onFillHeight: () => void;
  onArrangePlace: (verb: "split" | "stack" | "equalize") => void;
  onToggleBullseye: () => void;
  onMoveToSpace?: (spaceId: string) => void;
  onRevealStackEntry?: (entry: SlotStackEntry) => void;
  onDragStart: (event: React.PointerEvent) => void;
  onResizeStart: (edge: ResizeEdge, event: React.PointerEvent) => void;
  /** The close gesture's live answers, asked at close time (see `CardTitleBarProps`). */
  resolveCloseGuard?: (scope: "active" | "pane") => CardCloseDecision | null;
  resolveModalHold?: (scope: "active" | "pane") => string | null;
  resolveCloseAdvice?: () => CardCloseAdvice | null;
}

export interface PaneChromeProps {
  model: PaneChromeModel;
  /** The active card's masthead request, or null for the one-line bar. */
  masthead: CardMastheadPayload | null;
  verbs: PaneChromeVerbs;
  /** The frame the chrome stands in, which pane-modal surfaces portal into. */
  frameEl: HTMLDivElement | null;
  /** The `.tug-pane-chrome` root, once mounted: the portal target for sheets and tooltips. */
  rootEl: HTMLDivElement | null;
  rootRef: Ref<HTMLDivElement>;
  titleBarRef: Ref<CardTitleBarHandle>;
  accessoryRef: RefObject<HTMLDivElement | null>;
  contentRef: Ref<HTMLDivElement>;
  /** The single-card accessory; a pane of several cards draws its tab bar instead. */
  accessory: React.ReactNode | null;
  /** The responder scope the pane body stands in. */
  ResponderScope: React.FC<{ children: React.ReactNode }>;
}

// ===========================================================================
// PaneChrome
// ===========================================================================

export function PaneChrome({
  model,
  masthead,
  verbs,
  frameEl,
  rootEl,
  rootRef,
  titleBarRef,
  accessoryRef,
  contentRef,
  accessory,
  ResponderScope,
}: PaneChromeProps) {
  const resolvedAccessory: React.ReactNode | null =
    model.tabs.length > 1 && model.activeCardId !== undefined ? (
      <TugTabBar
        stackId={model.paneId}
        cards={model.tabs}
        activeCardId={model.activeCardId}
        acceptedFamilies={model.acceptedFamilies}
      />
    ) : (
      accessory
    );
  const place = model.placeArrangement;
  return (
    <>
      {/* Resize handles: the edges the arrangement lets move, or a rail's one
          deck-facing edge, which drags the rail's width. */}
      {model.grips.map((edge) => (
        <div
          key={edge}
          className={
            model.railGrip
              ? `tug-pane-resize tug-pane-rail-edge tug-pane-resize-${edge}`
              : `tug-pane-resize tug-pane-resize-${edge}`
          }
          onPointerDown={(e) => verbs.onResizeStart(edge, e)}
        />
      ))}

      <TugPaneFrameContext value={frameEl}>
      <TugPanePortalContext value={rootEl}>
        <div
          ref={rootRef}
          className="tug-pane-chrome"
          data-slot="tug-pane"
          data-pane-id={model.paneId}
        >
          <CardTitleBar
            ref={titleBarRef}
            title={model.title}
            icon={model.icon}
            closable={model.closable}
            {...(model.width !== null
              ? {
                  widthPreset: model.width.preset,
                  onSetWidth: verbs.onSetWidth,
                  ...(model.fillHeight !== null
                    ? {
                        onFillHeight: verbs.onFillHeight,
                        fillsHeight: model.fillHeight.fills,
                      }
                    : {}),
                }
              : {})}
            cardCount={model.cardCount}
            cardKind={model.cardKind}
            resolveCloseGuard={verbs.resolveCloseGuard}
            resolveModalHold={verbs.resolveModalHold}
            confirmClose={model.confirmClose}
            resolveCloseAdvice={verbs.resolveCloseAdvice}
            activeCardId={model.activeCardId}
            placePaneId={model.placePaneId}
            {...(model.slotStack === undefined ? {} : { slotStack: model.slotStack })}
            {...(model.slot === undefined ? {} : { slot: model.slot })}
            {...(model.spaces === undefined ? {} : { spaces: model.spaces })}
            onRevealPane={verbs.onRevealStackEntry}
            // Neither verb is a rail's, and the bar is told so by being handed
            // neither handler — the same shape `onSetWidth` already takes
            // above. The bar drops its whole rollup on a sidebar card, so this
            // changes nothing it renders; what it changes is what the props
            // SAY, which is the thing a later reader has to be able to trust.
            {...(model.bullseye === null
              ? {}
              : {
                  onMoveToSpace: verbs.onMoveToSpace,
                  bullseye: model.bullseye,
                  onToggleBullseye: verbs.onToggleBullseye,
                })}
            // A rail is always divided, so its badge lists the side's members
            // and passes no `onArrangePlace`, which is what keeps the verbs off
            // its menu ([B02]). A column's badge is the door to arranging it.
            {...(place === null
              ? {}
              : place.kind === "rail"
                ? { placeArrangement: place }
                : { placeArrangement: place, onArrangePlace: verbs.onArrangePlace })}
            masthead={masthead}
            sidebar={model.role === "sidebar"}
            folded={model.folded}
            cardFold={model.cardFold}
            onClose={verbs.onClosePane}
            onDragStart={verbs.onDragStart}
          />

          <div className="tug-pane-body" data-testid="tug-pane-body">
            <ResponderScope>
              <div
                ref={accessoryRef}
                className="tug-pane-accessory"
                data-testid="tug-pane-accessory"
                data-pane-id={model.paneId}
                style={resolvedAccessory == null ? { height: 0, overflow: "hidden" } : undefined}
              >
                {resolvedAccessory}
              </div>

              <div
                ref={contentRef}
                className="tug-pane-content"
                data-testid="tug-pane-content"
              />
            </ResponderScope>
          </div>

          {/* Pane-owned scrim layer [D18]. Permanent element; visibility
              is driven by `data-scrim` on the chrome (set imperatively
              by `useTugPaneScrim()` consumers via the pane-scrim
              registry). Sized below the title bar so the title bar
              stays interactive while pane-modal surfaces are up. */}
          <div className="tug-pane-scrim" aria-hidden="true" data-testid="tug-pane-scrim" />
        </div>
      </TugPanePortalContext>
      </TugPaneFrameContext>
    </>
  );
}
