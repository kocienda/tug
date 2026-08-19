/**
 * lens-content.tsx — the Lens card's content: a fixed, non-scrolling stack
 * of reorderable, collapsible sections. A registered section renders unless it
 * declares itself absent through `presence` (there is still no hidden-sections
 * set and no title-bar `…` menu — absence is the section's own answer about its
 * content, not a preference someone toggles);
 * each section's BODY scrolls internally when its list outgrows the
 * section's flex share, so every band stays on-screen. The stack itself
 * never scrolls — a section can scroll its own rows out of view, but never
 * another section's header.
 *
 * Hosted by the normal `CardHost` inside an anchored pane (the Lens
 * rail). This file is the ordinary registered card's content component;
 * it owns nothing about geometry or chrome (those belong to the pane per
 * [L25]/[L09]).
 *
 * Responsibilities:
 *   - Derive the section order from `lensStore` over the registered
 *     sections ([L02] via `useSyncExternalStore`).
 *   - Drag-reorder sections by carrying their bands: a DOM-only live preview
 *     (flex `order`) during the drag, committing `lensStore.setSectionOrder`
 *     only on drop ([P08], [L06]/[L08]).
 *   - Keep the FocusManager group-walk order in lock-step with the
 *     rendered order via `setGroupOrder` ([P08], [L22]).
 *   - Escape, in two jobs and one press: while a layout selection stands it
 *     DROPS that selection; with nothing selected it focuses out, a
 *     content-local `CANCEL_DIALOG` responder re-dispatching `FOCUS_LENS`
 *     (the deck-canvas toggle-out restores the stashed prior card, [P05]).
 *     The focus-out half lives here, NOT at the deck-canvas level, so it is
 *     only in the chain when focus is actually inside the Lens — an
 *     unconditional deck-canvas `CANCEL_DIALOG` entry would consume every
 *     Escape (marking it handled → preventDefault), blocking unrelated Escape
 *     gestures such as a mid-drag abort.
 *
 *     The CLEARING half has two siblings, because a selection is deck state and
 *     outlives the keyboard's presence here: the Cards list captures Escape
 *     while it holds the keyboard and a set stands (the engine's ladder
 *     outranks the whole chain, so this responder would otherwise never see the
 *     press), and `deck-canvas` registers the same clear CONDITIONALLY — only
 *     while a set stands at all — for the case a click fronted a card and took
 *     the keyboard out of the Lens with it. Between the three, the answer to
 *     Escape does not depend on how the selection was made.
 *
 * @module components/lens/lens-content
 */

import React, {
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { lensStore } from "@/lib/lens-store/lens-store";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponder } from "@/components/tugways/use-responder";
import { dispatchCommand } from "@/command-dispatch";
import {
  useFocusManager,
  useSeedKeyView,
} from "@/components/tugways/use-focusable";
import { BASE_FOCUS_MODE } from "@/components/tugways/focus-manager";
import { lensSelectionStore } from "./lens-selection-store";
import { lensSpatialOrder } from "./lens-spatial-order";
import {
  getRegisteredLensSections,
  mergeHiddenIntoOrder,
  resolveSectionRenderOrder,
  sectionFocusGroup,
  type LensSectionHost,
} from "./lens-section-registry";
import { LensSection } from "./lens-section-band";
import {
  getSectionContentVersion,
  sectionHasContent,
  subscribeSectionContent,
} from "./lens-section-content";
import {
  getSectionPresenceVersion,
  sectionIsPresent,
  subscribeSectionPresence,
} from "./lens-section-presence";
import { LensSectionPresenceProbe } from "./lens-section-presence-probe";
import { useBlockReorder } from "./block-reorder";
import { BlockDropCaret } from "./block-drop-caret";
import {
  LensFollowedCardContext,
  useTrackLastNonLensKeyCard,
} from "./lens-followed-card";
import "./lens-content.css";

export interface LensContentProps {
  /** The Lens card's id (the registered `"lens"` singleton). */
  cardId: string;
}

export function LensContent({ cardId }: LensContentProps): React.ReactElement {
  const lens = useSyncExternalStore(lensStore.subscribe, lensStore.getSnapshot);
  const sections = getRegisteredLensSections();
  const registeredKinds = [...sections.keys()];
  const fullOrder = resolveSectionRenderOrder(registeredKinds, lens.sectionOrder);
  // A section may declare itself absent ([P03]). Everything downstream — the
  // rendered map, the group walk, the arrow plane, the ⌘L seed, and the
  // reorder's index arithmetic — runs off the VISIBLE order, because that is
  // what the reader sees and what the bands on screen agree with. `fullOrder`
  // survives only to give a hidden kind its place back when the order is
  // persisted (`mergeHiddenIntoOrder`).
  useSyncExternalStore(subscribeSectionPresence, getSectionPresenceVersion);
  const order = fullOrder.filter(sectionIsPresent);
  const orderKey = order.join(" ");
  const collapsed = new Set(lens.collapsedSections);

  const sectionsRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const focusManager = useFocusManager();

  // Seed the opening key view onto the first *expanded* section that has
  // navigable content, so the first Cmd-L lands the movement cursor on a real
  // Lens item ([P02], the focus-language seed) — never on an empty band (an
  // empty list is not a focus stop; seeding it would arm a pending restore that
  // shows a ring on emptiness). A collapsed section unmounts its body (no
  // focusable), so it is skipped; a Lens with no content anywhere seeds nothing
  // until a section gains content (`useSeedKeyView` re-arms while the key is
  // null). Subsequent Cmd-L presses (after a toggle-out) are handled by
  // `adoptKeyCard` restoring this card's stored key view — this seed is only
  // the first landing.
  useSyncExternalStore(subscribeSectionContent, getSectionContentVersion);
  const seedKind =
    order.find(
      (k) => !collapsed.has(k) && sectionHasContent(sectionFocusGroup(k)),
    ) ?? null;
  useSeedKeyView(
    seedKind !== null ? `${sectionFocusGroup(seedKind)}:0` : null,
  );

  // The card the Lens is contextually about — tracked once here (mounted
  // the whole time the pane is open) and shared with sections via context
  // so a section's body and collapsed-summary always agree ([P11]).
  const followedCardId = useTrackLastNonLensKeyCard(cardId);

  // Keep the FocusManager group-walk order in lock-step with the rendered
  // order ([P08]/[L22]) — group order is structure owned by the
  // FocusManager, driven off the store, never a parallel useState — and build
  // the arrow plane ([P22]/[P23]) from the same pass.
  //
  // The Lens is the first surface to declare a spatial order on the BASE mode
  // rather than inside a trap, and it is the right call for the same reason the
  // dialogs declare theirs: the liveliness net cannot tell Down from Right, and
  // a rail whose bands carry a row of controls over a column of rows needs it
  // to. An order registers on the declaring card's own `FocusContext`, so it
  // governs the Lens and nothing else.
  //
  // The plane is DERIVED, not declared: it reads each section's live focus
  // orders back off the engine rather than from a table someone maintains, so a
  // control authored into a section's group joins the plane the moment it
  // registers (`lens-spatial-order.ts` holds the row rules). That is why this
  // runs in a layout effect and not in render — the sections' own registrations
  // are layout effects, and a child's runs before its parent's ([L03]), so by
  // here every band, field, control, and list of this render has registered.
  //
  // `shapeKey` is what re-runs it: the rendered order, each section's collapse,
  // and whether each section holds navigable content — the three things that
  // change which stops exist. All three already re-render this component (the
  // store subscriptions above), so the effect fires on the same commit their
  // registrations land in.
  const shapeKey = order
    .map((kind) => {
      const group = sectionFocusGroup(kind);
      return `${kind}${collapsed.has(kind) ? "-" : "+"}${
        sectionHasContent(group) ? "1" : "0"
      }`;
    })
    .join(" ");
  useLayoutEffect(() => {
    if (focusManager === null) return;
    const ctx = focusManager.contextFor(cardId);
    const groups = order.map(sectionFocusGroup);
    ctx.setGroupOrder(groups);
    ctx.registerSpatialOrder(
      BASE_FOCUS_MODE,
      lensSpatialOrder(
        groups.map((group) => ({
          group,
          orders: ctx.focusOrdersInGroup(group),
        })),
      ),
    );
    return () => ctx.unregisterSpatialOrder(BASE_FOCUS_MODE);
    // `orderKey` captures the rendered order and `shapeKey` the membership that
    // follows from it; `order`/`focusManager`/`cardId` are derived from those
    // plus stable identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, shapeKey, focusManager, cardId]);

  // Drag-reorder by carrying the band itself: FLIP visuals (ghost + close-up +
  // drop caret + settle), DOM/CSS only, committing the store on drop ([P08]).
  const { onRowPointerDown } = useBlockReorder({
    containerRef: sectionsRef,
    caretRef,
    getVisibleOrder: () =>
      resolveSectionRenderOrder(
        [...getRegisteredLensSections().keys()],
        lensStore.getSnapshot().sectionOrder,
      ).filter(sectionIsPresent),
    // The drag can only ever produce a visible order, so an absent section's
    // place is restored before the order is persisted — otherwise a section
    // that happened to be empty during somebody else's drag would lose its
    // position permanently ([P05]).
    commit: (newVisible) => {
      lensStore.setSectionOrder(
        mergeHiddenIntoOrder(
          resolveSectionRenderOrder(
            [...getRegisteredLensSections().keys()],
            lensStore.getSnapshot().sectionOrder,
          ),
          newVisible,
        ),
      );
    },
    // The keyboard follows the band that was set down — the same destination
    // and the same modality a band CLICK reaches (`lens-section-band`'s
    // `onBandClick`). A carry suppresses that click on purpose, so this is the
    // click's landing handed back rather than a new behavior: a section the
    // user just moved is the section they are working on.
    //
    // A collapsed band has no body and therefore no focusable, so it is left
    // alone: a keyboard placement on a key that has not mounted arms a
    // late-mount resume, and a band that expands minutes later must not yank
    // the keyboard off whatever the user was doing by then.
    landKeyboard: (kind) => {
      if (collapsed.has(kind)) return;
      focusManager?.place(
        cardId,
        { kind: "focus-key", focusKey: `${sectionFocusGroup(kind)}:0` },
        { modality: "keyboard" },
      );
    },
  });

  // Escape inside the Lens has two jobs now, in this order.
  //
  // FIRST, it drops the layout selection. A selection is a standing statement
  // about what the next verb acts on, and it outlives the gesture that made it
  // — so the user needs a way to take it back that is not "select something
  // else". Escape is that key everywhere else in the app, and a selection is
  // the nearest thing the Lens has to an open modal state.
  //
  // THEN, with nothing selected, it focuses back out: re-dispatch FOCUS_LENS
  // via the registry (the same path Cmd-L-again takes), which the deck-canvas
  // handler turns into a toggle-out restoring the stashed prior card.
  //
  // One press, one job — the two never happen together, because a press that
  // both cleared a selection and threw the keyboard out of the Lens would give
  // the user no way to see what they had just undone.
  //
  // This responder is only in the chain when focus is inside the Lens.
  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.CANCEL_DIALOG]: () => {
        if (lensSelectionStore.getSnapshot().ids.length > 0) {
          lensSelectionStore.clear();
          return;
        }
        dispatchCommand(TUG_ACTIONS.FOCUS_LENS);
      },
    },
  });

  return (
    <LensFollowedCardContext value={followedCardId}>
      <ResponderScope>
      <div
        ref={responderRef as (el: HTMLDivElement | null) => void}
        className="lens-content"
        data-testid="lens-content"
        data-lens-card-id={cardId}
        // Focusable root so `transferFocusForActivation` → `applyBagFocus`
        // has a target to land the ring on when the Lens is focused.
        tabIndex={-1}
      >
        {/* One presence probe per REGISTERED kind — mounted whether or not
            that section renders, which is the only way the answer can come
            back once it has been "no" (see `lens-section-presence.ts`). Each
            renders null; they sit outside `.lens-sections` so they cannot be
            mistaken for bands by the reorder's index arithmetic. */}
        {registeredKinds.map((kind) => {
          const def = sections.get(kind);
          if (!def) return null;
          return (
            <LensSectionPresenceProbe
              key={kind}
              def={def}
              host={{ lensCardId: cardId, focusGroup: sectionFocusGroup(kind) }}
            />
          );
        })}
        <div className="lens-sections" data-testid="lens-sections" ref={sectionsRef}>
          {/* The reorder drop indicator — a persistently-mounted hairline the
              drag handler positions imperatively ([P08]); hidden at rest. */}
          <BlockDropCaret ref={caretRef} />
          {order.map((kind) => {
            const def = sections.get(kind);
            if (!def) return null;
            const host: LensSectionHost = {
              lensCardId: cardId,
              focusGroup: sectionFocusGroup(kind),
            };
            return (
              <LensSection
                key={kind}
                def={def}
                host={host}
                collapsed={collapsed.has(kind)}
                onBandPointerDown={onRowPointerDown}
              />
            );
          })}
        </div>
      </div>
      </ResponderScope>
    </LensFollowedCardContext>
  );
}
