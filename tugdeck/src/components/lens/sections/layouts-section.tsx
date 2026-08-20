/**
 * layouts-section.tsx — the Lens **Layout** section: the deck's layout picker.
 *
 * Every layout decision the deck has is made here, on five axes. **Cards** says
 * how many the arrangement holds; **Layout** says how a slot resolves into a
 * place — `Fit`, where the cards share the band and crowd when it is narrow, or
 * `Flow`, where they keep their width and the deck runs past the edge; **Card
 * Width** says how wide they read; **Sidebar positions** says which edge each
 * sidebar card holds; and a **rail row** per shared side says whether the cards
 * on that side stack front-to-back or divide it between them. All five write
 * the deck's `imposition` record — so
 * "where is the Lens" and "how wide is a Session card" are layout questions
 * answered beside the other layout questions rather than in an app-wide
 * preference somewhere else.
 *
 * The sidebar controls are **registry-driven**: one Left/Right group per card
 * that registered `layoutRole: "sidebar"`, in registration order. A third
 * sidebar card appears here by registering, with nothing to add in this file.
 * The rail rows are derived the same way — a side gets one when the registry
 * assigns two or more sidebar cards to it, open or not. That is deliberately
 * not a live read of what is standing: this section reads no panes at all, and
 * a row gated on visible members would both disagree with the miniature drawn
 * directly above it and disappear at the moment a split side dropped to one
 * card, taking the only way to un-split it along.
 *
 * The Cards axis has no *off*. One-up is the quietest arrangement rather than
 * the absence of one — a single anchor, which a card occupies only by being put
 * there — so the deck always stands under an imposition and every row's slot
 * picker is live from the first frame.
 *
 * The section draws the deck **once**: the plan at the top states the current
 * answers as a heading, and under that heading stands a scale picture of the
 * deck ({@link LayoutMiniature}). Every control below is a compact segmented group
 * (`TugChoiceGroup`) that writes the plan. The picture-per-option idiom this
 * replaced spent a full deck drawing on every option and asked the eye to
 * diff them; here the options are words and numerals, and the *plan* is where
 * an option shows what it would do — resting a pointer on a segment, or
 * standing the movement cursor on it, swaps the plan for that option's
 * arrangement, drawn tentative (hollow blocks) rather than committed (filled).
 *
 * The plan is a readout, and takes no pointer at all (`pointer-events: none`):
 * it is drawn in chrome neutrals rather than the control palette, and the hand
 * that tries it finds nothing to press.
 *
 * The previews are pre-rendered: React renders one hidden plan layer per
 * offerable option from the same store read as the committed layer, and the
 * hover/cursor handlers only toggle DOM attributes to choose which layer
 * shows. A preview is ephemeral appearance, so no React state is involved in
 * showing one ([L06]); the layers themselves are semantic data — drawings of
 * the store's candidate arrangements — and re-render when the store moves.
 *
 * Laws: [L02] the imposition record enters React through `useSyncExternalStore`
 * on the deck store; [L03] the section's content declaration is a
 * `useLayoutEffect`; [L06] preview visibility is DOM attributes toggled in
 * event handlers and a `MutationObserver`, never React state; [L11] every
 * control emits `selectValue` through the responder chain, which this section
 * turns into `set-imposition` / `set-imposition-layout` / `set-content-width` /
 * `set-sidebar-side` / `set-rail-mode` dispatches; [L19] every control is a `TugChoiceGroup` and
 * every caption a `TugLabel`, composed rather than hand-rolled; [L30] the section never touches
 * the deck store — it goes through the command funnel like any other door.
 *
 * @module components/lens/sections/layouts-section
 */

import "./layouts-section.css";

import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { Columns3 } from "lucide-react";

import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { setSectionContent } from "@/components/lens/lens-section-content";
import { LayoutMiniature } from "@/components/lens/layout-miniature";
import type { MiniatureRails } from "@/components/lens/layout-miniature";
import { dispatchCommand } from "@/command-dispatch";
import { getAllRegistrations } from "@/card-registry";
import { getDeckStore } from "@/lib/deck-store-registry";
import {
  CONTENT_WIDTH_LABELS,
  CONTENT_WIDTH_PRESETS,
  CONTENT_WIDTH_PX,
  IMPOSITION_KINDS,
  isContentWidth,
  isImpositionKind,
  isImpositionLayout,
  impositionLayout,
  isRailMode,
  isSidebarSide,
  railModeOf,
  sidebarSide,
  slotCount,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_IMPOSITION_KIND,
  DEFAULT_SIDEBAR_SIDE,
  type ContentWidth,
  type DeckImposition,
  type ImpositionKind,
  type ImpositionLayout,
  type RailMode,
  type SidebarSide,
} from "@/lib/layout-imposer";
import { LENS_CARD_ID } from "@/lib/lens-card-id";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import type { TugChoiceItem } from "@/components/tugways/tug-choice-group";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

/** This section's kind — its key in the section registry and section order. */
const SECTION_KIND = "layouts";

/** Stable `event.sender` per group, so the section's one `selectValue` handler
 *  can tell the axes apart. A sidebar group's sender carries the componentId it
 *  moves, which is how one handler serves however many sidebar cards register. */
const KIND_SENDER_ID = "lens-layouts-kind";
const LAYOUT_SENDER_ID = "lens-layouts-layout";
const WIDTH_SENDER_ID = "lens-layouts-width";
const SIDE_SENDER_PREFIX = "lens-layouts-side:";
const RAIL_SENDER_PREFIX = "lens-layouts-rail:";

/** Ids of the captions, so each group can point `aria-labelledby` at its own
 *  `TugLabel`. */
const KIND_CAPTION_ID = "lens-layouts-kind-caption";
const LAYOUT_CAPTION_ID = "lens-layouts-layout-caption";
const WIDTH_CAPTION_ID = "lens-layouts-width-caption";
const SIDE_CAPTION_ID_PREFIX = "lens-layouts-side-caption-";
const RAIL_CAPTION_ID_PREFIX = "lens-layouts-rail-caption-";

/** The groups' focus orders. Distinct, and declared rather than defaulted,
 *  because they are separate stops: sharing an order would give two groups one
 *  focus key ([Q12]) between them, and the engine resolves a key to exactly one
 *  stop — so the other would be unreachable by any addressed placement. Being
 *  separately ordered is also what makes them separate rows of the Lens's arrow
 *  plane, so a vertical arrow steps from one group to the next. The sidebar
 *  groups take the orders after these, one each, in registration order, and the
 *  rail rows the orders after those. */
const LAYOUTS_KIND_FOCUS_ORDER = 0;
const LAYOUTS_LAYOUT_FOCUS_ORDER = 1;
const LAYOUTS_WIDTH_FOCUS_ORDER = 2;
const LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER = 3;

/** User-facing label for each kind. */
const KIND_LABELS: Record<ImpositionKind, string> = {
  "one-up": "One Up",
  "two-up": "Two Up",
  "three-up": "Three Up",
  "four-up": "Four Up",
  "five-up": "Five Up",
  "six-up": "Six Up",
};

/** The two sides, in the order the control offers them. */
const SIDES: readonly SidebarSide[] = ["left", "right"];

/** The two geometry modes, in the order the control offers them — fit first,
 *  because it is what the deck has always done and what an unchosen deck is. */
const LAYOUTS: readonly ImpositionLayout[] = ["fit", "flow"];

/** User-facing label for each mode. Named for what the CARDS do, not for the
 *  mechanism: under "Fit" they share the band and crowd; under "Flow" they keep
 *  their width and the deck runs past the edge. */
const LAYOUT_LABELS: Record<ImpositionLayout, string> = {
  fit: "Fit",
  flow: "Flow",
};

const SIDE_LABELS: Record<SidebarSide, string> = {
  left: "Left",
  right: "Right",
};

/** The two arrangements a shared rail can stand under, in the order the control
 *  offers them — stack first, because stack is the default. */
const RAIL_MODES: readonly RailMode[] = ["stack", "split"];

const RAIL_MODE_LABELS: Record<RailMode, string> = {
  stack: "Stack",
  split: "Split",
};

/** The caption for a side's rail row. */
const RAIL_CAPTIONS: Record<SidebarSide, string> = {
  left: "Left Rail",
  right: "Right Rail",
};

/** A sidebar card the deck can place, as this section needs it. */
interface SidebarEntry {
  componentId: string;
  /** The card's own name — the caption for its position control. */
  title: string;
}

/**
 * Every card registered as a sidebar, in registration order.
 *
 * The registry is fixed by the time any Lens section renders (registration is a
 * boot step), so this is a plain read rather than store-observed state — there
 * is no moment at which a card registers behind a rendered Layouts section.
 */
function sidebarEntries(): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const [componentId, registration] of getAllRegistrations()) {
    if (registration.layoutRole !== "sidebar") continue;
    entries.push({
      componentId,
      title: registration.defaultMeta.title || componentId,
    });
  }
  return entries;
}

/** How many sidebar cards stand on each side. `override` places one card on a
 *  stated side regardless of the imposition — the rails a side preview draws. */
function railsOf(
  imposition: DeckImposition,
  sidebars: readonly SidebarEntry[],
  override?: { componentId: string; side: SidebarSide },
): MiniatureRails {
  const rails: MiniatureRails = {};
  for (const entry of sidebars) {
    const side =
      override !== undefined && override.componentId === entry.componentId
        ? override.side
        : sidebarSide(imposition, entry.componentId);
    rails[side] = (rails[side] ?? 0) + 1;
  }
  return rails;
}

/** The deck's imposition record — every axis — straight from the store ([L02]). */
function useImposition(): DeckImposition {
  const deckStore = getDeckStore();
  const deck = useSyncExternalStore(
    deckStore?.subscribe ?? (() => () => {}),
    deckStore !== null ? deckStore.getSnapshot : () => null,
    () => null,
  );
  return (
    deck?.imposition ?? {
      sidebars: { [LENS_CARD_ID]: { side: DEFAULT_SIDEBAR_SIDE } },
    }
  );
}

/** Live collapsed summary: the active kind's label. The side is not summarized
 *  — the band has room for one fact and the arrangement is it. */
function LayoutsCollapsedSummary(): React.ReactElement {
  const { kind } = useImposition();
  return <>{KIND_LABELS[kind ?? DEFAULT_IMPOSITION_KIND]}</>;
}

/**
 * What an arrangement COMES TO, in plain words — the note under the caption.
 *
 * The caption names the answers (`Three Up · Slim`); this says what they mean
 * on screen, in the same voice the AI mixer's channel descriptions use. It is
 * the only place the width presets' actual measures are stated, so the note
 * earns its line rather than paraphrasing the caption: `Slim` is a name, `675
 * px` is the fact behind it.
 *
 * The card count is a DIGIT, matching the Cards control's own segments (`1 2 3
 * 4 5 6`) rather than the caption's spelled-out kind — the note reads as a
 * reading of the controls, which is what it is.
 */
function planNote(
  kind: ImpositionKind,
  width: ContentWidth,
  layout: ImpositionLayout = "fit",
): string {
  const slots = slotCount(kind);
  const px = CONTENT_WIDTH_PX[width];
  const cards =
    slots === 1
      ? `1 card at a time, ${px} px wide`
      : `${slots} cards side by side, ${px} px each`;
  // What the modes actually differ about, said once: fit spends the crowding
  // on overlap, flow spends it on the right edge. The clause is on flow only —
  // fit is the deck the reader already knows, and a note that explained both
  // would make the familiar answer look like a new choice.
  return layout === "flow" ? `${cards} — the deck scrolls` : cards;
}

/** One plan layer: a drawing, the caption naming it, and the note under it. */
interface PlanLayer {
  /** `axis:value` — the id a hovered/cursored segment resolves to. */
  previewId: string;
  /** The caption's values, in order — rendered with the separator between
   *  them, so the punctuation is the stylesheet's rather than the string's. */
  caption: readonly string[];
  /** What those values come to — see {@link planNote}. */
  note: string;
  kind: ImpositionKind;
  rails: MiniatureRails;
  /** How each side's rail is arranged in this drawing. */
  railModes: Partial<Record<SidebarSide, RailMode>>;
  width: ContentWidth;
  /** Which geometry this drawing stands under. */
  layout: ImpositionLayout;
}

/** The caption's values, with a muted separator between them and the first
 *  carrying the weight — the AI mixer's readout, worn by the Lens. */
function PlanCaption({
  values,
}: {
  values: readonly string[];
}): React.ReactElement {
  return (
    <span className="layouts-plan-caption">
      {values.map((value, index) => (
        <React.Fragment key={value}>
          {index > 0 && (
            // The spaces live in the text, not in a margin, so the caption
            // reads correctly when it is taken as a string.
            <span className="layouts-plan-caption-sep"> · </span>
          )}
          <span className="layouts-plan-caption-value">{value}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * The preview id a segment stands for, or `null` when the element is not a
 * previewable segment. The already-active segment resolves to `null` on
 * purpose: hovering the current answer shows the committed plan, not a
 * tentative copy of it.
 */
function previewIdOf(el: Element | null): string | null {
  const segment = el?.closest("[data-choice-value]") ?? null;
  if (segment === null) return null;
  if (segment.getAttribute("data-state") === "active") return null;
  const row = segment.closest("[data-preview-axis]");
  if (row === null) return null;
  return `${row.getAttribute("data-preview-axis")}:${segment.getAttribute(
    "data-choice-value",
  )}`;
}

function LayoutsSectionBody({
  host,
}: {
  host: LensSectionHost;
}): React.ReactElement {
  const imposition = useImposition();
  const kind = imposition.kind ?? DEFAULT_IMPOSITION_KIND;
  const contentWidth = imposition.contentWidth ?? DEFAULT_CONTENT_WIDTH;
  const layout = impositionLayout(imposition);
  const sidebars = sidebarEntries();
  const rails = railsOf(imposition, sidebars);
  const railModes: Partial<Record<SidebarSide, RailMode>> = {
    left: railModeOf(imposition, "left"),
    right: railModeOf(imposition, "right"),
  };
  // A side the section counts two or more sidebar cards on — the same
  // registration-derived count the miniature above draws from, deliberately not
  // a live read of what is open. The section reads no panes at all, and a row
  // gated on visible members would sit under a miniature that disagreed with
  // it; worse, it would vanish exactly when a split side dropped to one card,
  // taking the only Lens-side way to un-split with it ([P08]).
  //
  // Both sides get a row EITHER WAY; a side with nothing to arrange gets a
  // disabled one. A row that came and went as cards moved edges made the
  // panel's own height a function of the arrangement — the rows below it
  // jumped every time, and the reader had to notice an absence to learn that
  // a side could be split at all. A dimmed control states the same fact and
  // holds its place.
  const isShared = (side: SidebarSide): boolean => (rails[side] ?? 0) > 1;
  const sharedSides = SIDES.filter(isShared);

  // Every control reports selection by dispatching `selectValue` up the
  // responder chain ([L11]) — there are no change callbacks — so the section
  // hosts one responder and routes by sender.
  const { ResponderScope, responderRef } = useResponder({
    id: "lens-layouts-section",
    actions: {
      [TUG_ACTIONS.SELECT_VALUE]: (event: ActionEvent) => {
        const value = event.value;
        if (typeof value !== "string") return;
        const sender = event.sender;
        if (typeof sender === "string" && sender.startsWith(RAIL_SENDER_PREFIX)) {
          const side = sender.slice(RAIL_SENDER_PREFIX.length);
          if (isSidebarSide(side) && isRailMode(value)) {
            dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE, { side, mode: value });
          }
          return;
        }
        if (typeof sender === "string" && sender.startsWith(SIDE_SENDER_PREFIX)) {
          if (isSidebarSide(value)) {
            dispatchCommand(TUG_ACTIONS.SET_SIDEBAR_SIDE, {
              componentId: sender.slice(SIDE_SENDER_PREFIX.length),
              side: value,
            });
          }
          return;
        }
        if (sender === WIDTH_SENDER_ID) {
          if (isContentWidth(value)) {
            dispatchCommand(TUG_ACTIONS.SET_CONTENT_WIDTH, { preset: value });
          }
          return;
        }
        if (sender === LAYOUT_SENDER_ID) {
          if (isImpositionLayout(value)) {
            dispatchCommand(TUG_ACTIONS.SET_IMPOSITION_LAYOUT, {
              layout: value,
            });
          }
          return;
        }
        if (sender === KIND_SENDER_ID && isImpositionKind(value)) {
          dispatchCommand("set-imposition", { kind: value });
        }
      },
    },
  });

  // The picker is always present and always focusable, so the section is
  // always a navigable stop for the Cmd-L seed and the Tab walk.
  useLayoutEffect(() => {
    setSectionContent(host.focusGroup, { navigable: true, populated: true });
    return () =>
      setSectionContent(host.focusGroup, {
        navigable: false,
        populated: false,
      });
  }, [host.focusGroup]);

  // ---- The plan's preview switch ([L06]) ----
  //
  // Which layer shows is DOM attributes on the plan, toggled here: the layer
  // whose id matches gets `data-plan-active`, and the plan carries
  // `data-previewing` whenever one does (which is what hides the committed
  // layer). No React state — a preview is visible-only and lives exactly as
  // long as the pointer or cursor that asked for it.
  const planRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  const setPreview = useCallback((id: string | null) => {
    const plan = planRef.current;
    if (plan === null) return;
    let matched = false;
    for (const layer of plan.querySelectorAll("[data-plan-preview-id]")) {
      const on = id !== null && layer.getAttribute("data-plan-preview-id") === id;
      layer.toggleAttribute("data-plan-active", on);
      matched = matched || on;
    }
    plan.toggleAttribute("data-previewing", matched);
  }, []);

  // The keyboard cursor previews the same way the pointer does: the engine
  // marks the ringed group `data-key-view-kbd` and the cursor segment
  // `data-key-cursor`, so an observer on those attributes resolves the
  // cursored segment to its preview id whenever either moves. Deferred
  // commit ([P24]) then reads: arrows audition arrangements in the plan,
  // Space makes one real.
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (rows === null) return;
    const recompute = () => {
      const segment = rows.querySelector(
        "[data-key-view-kbd] [data-key-cursor][data-choice-value]",
      );
      setPreview(previewIdOf(segment));
    };
    const observer = new MutationObserver(recompute);
    observer.observe(rows, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-key-cursor", "data-key-view-kbd"],
    });
    return () => observer.disconnect();
  }, [setPreview]);

  // ---- The layers: the committed plan and every offerable answer ----

  const committedCaption = [
    KIND_LABELS[kind],
    CONTENT_WIDTH_LABELS[contentWidth],
    ...(layout === "flow" ? [LAYOUT_LABELS[layout]] : []),
  ];

  const layers: PlanLayer[] = [
    ...IMPOSITION_KINDS.map((k) => ({
      previewId: `kind:${k}`,
      caption: [KIND_LABELS[k], CONTENT_WIDTH_LABELS[contentWidth]],
      note: planNote(k, contentWidth, layout),
      kind: k,
      rails,
      railModes,
      width: contentWidth,
      layout,
    })),
    ...LAYOUTS.map((mode) => ({
      previewId: `layout:${mode}`,
      caption: [KIND_LABELS[kind], LAYOUT_LABELS[mode]],
      note: planNote(kind, contentWidth, mode),
      kind,
      rails,
      railModes,
      width: contentWidth,
      layout: mode,
    })),
    ...CONTENT_WIDTH_PRESETS.map((preset) => ({
      previewId: `width:${preset}`,
      caption: [KIND_LABELS[kind], CONTENT_WIDTH_LABELS[preset]],
      note: planNote(kind, preset, layout),
      kind,
      rails,
      railModes,
      width: preset,
      layout,
    })),
    ...sidebars.flatMap((entry) =>
      SIDES.map((side) => ({
        previewId: `side:${entry.componentId}:${side}`,
        caption: [`${entry.title} ${SIDE_LABELS[side]}`],
        // The arrangement is unchanged by a rail moving sides, so the note
        // stands as it is: the caption says what the preview would change,
        // the note what it would leave alone.
        note: planNote(kind, contentWidth, layout),
        kind,
        rails: railsOf(imposition, sidebars, {
          componentId: entry.componentId,
          side,
        }),
        railModes,
        width: contentWidth,
        layout,
      })),
    ),
    ...sharedSides.flatMap((side) =>
      RAIL_MODES.map((mode) => ({
        previewId: `railmode:${side}:${mode}`,
        caption: [`${RAIL_CAPTIONS[side]} ${RAIL_MODE_LABELS[mode]}`],
        // Splitting a rail divides that side's run and leaves the cards'
        // band exactly as it was, so the note says what stands.
        note: planNote(kind, contentWidth, layout),
        kind,
        rails,
        railModes: { ...railModes, [side]: mode },
        width: contentWidth,
        layout,
      })),
    ),
  ];

  // ---- The rows: one compact segmented group per axis ----

  const kindItems: TugChoiceItem[] = IMPOSITION_KINDS.map((k) => ({
    value: k,
    label: String(slotCount(k)),
    "aria-label": KIND_LABELS[k],
    tooltip: KIND_LABELS[k],
  }));

  const layoutItems: TugChoiceItem[] = LAYOUTS.map((mode) => ({
    value: mode,
    label: LAYOUT_LABELS[mode],
  }));

  const widthItems: TugChoiceItem[] = CONTENT_WIDTH_PRESETS.map((preset) => ({
    value: preset,
    label: CONTENT_WIDTH_LABELS[preset],
  }));

  const sideItems: TugChoiceItem[] = SIDES.map((side) => ({
    value: side,
    label: SIDE_LABELS[side],
  }));

  const railModeItems: TugChoiceItem[] = RAIL_MODES.map((mode) => ({
    value: mode,
    label: RAIL_MODE_LABELS[mode],
  }));

  return (
    <ResponderScope>
      <div
        className="layouts-section"
        data-testid="lens-layouts-section"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <div
          className="layouts-plan"
          data-testid="lens-layouts-plan"
          ref={planRef}
          aria-hidden="true"
        >
          <div className="layouts-plan-layer" data-plan-layer="committed">
            <div className="layouts-plan-summary">
              <PlanCaption values={committedCaption} />
              <span className="layouts-plan-note">
                {planNote(kind, contentWidth, layout)}
              </span>
            </div>
            <LayoutMiniature
              kind={kind}
              rails={rails}
              railModes={railModes}
              width={contentWidth}
              layout={layout}
              committed
            />
          </div>
          {layers.map((layer) => (
            <div
              className="layouts-plan-layer"
              data-plan-preview-id={layer.previewId}
              key={layer.previewId}
            >
              <div className="layouts-plan-summary">
                <PlanCaption values={layer.caption} />
                <span className="layouts-plan-note">{layer.note}</span>
              </div>
              <LayoutMiniature
                kind={layer.kind}
                rails={layer.rails}
                railModes={layer.railModes}
                width={layer.width}
                layout={layer.layout}
              />
            </div>
          ))}
        </div>

        <div
          className="layouts-section-rows"
          ref={rowsRef}
          onPointerOver={(event) =>
            setPreview(previewIdOf(event.target as Element))
          }
          onPointerLeave={() => setPreview(null)}
          onClick={() => setPreview(null)}
        >
          <div className="layouts-section-row" data-preview-axis="kind">
            <TugLabel
              id={KIND_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Cards
            </TugLabel>
            <TugChoiceGroup
              items={kindItems}
              value={kind}
              senderId={KIND_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_KIND_FOCUS_ORDER}
              aria-labelledby={KIND_CAPTION_ID}
              data-testid="lens-layouts-kind"
            />
          </div>

          <div className="layouts-section-row" data-preview-axis="layout">
            <TugLabel
              id={LAYOUT_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Layout
            </TugLabel>
            <TugChoiceGroup
              items={layoutItems}
              value={layout}
              senderId={LAYOUT_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_LAYOUT_FOCUS_ORDER}
              aria-labelledby={LAYOUT_CAPTION_ID}
              data-testid="lens-layouts-layout"
            />
          </div>

          <div className="layouts-section-row" data-preview-axis="width">
            <TugLabel
              id={WIDTH_CAPTION_ID}
              size="md"
              emphasis="proposal"
              className="layouts-section-caption"
            >
              Card Width
            </TugLabel>
            <TugChoiceGroup
              items={widthItems}
              value={contentWidth}
              senderId={WIDTH_SENDER_ID}
              size="xs"
              sidePadding="xs"
              reselect
              focusGroup={host.focusGroup}
              focusOrder={LAYOUTS_WIDTH_FOCUS_ORDER}
              aria-labelledby={WIDTH_CAPTION_ID}
              data-testid="lens-layouts-width"
            />
          </div>

          {sidebars.map((entry, index) => {
            const side = sidebarSide(imposition, entry.componentId);
            const captionId = `${SIDE_CAPTION_ID_PREFIX}${entry.componentId}`;
            return (
              <div
                className="layouts-section-row"
                data-preview-axis={`side:${entry.componentId}`}
                key={entry.componentId}
              >
                <TugLabel
                  id={captionId}
                  size="md"
                  emphasis="proposal"
                  className="layouts-section-caption"
                >
                  {entry.title}
                </TugLabel>
                <TugChoiceGroup
                  items={sideItems}
                  value={side}
                  senderId={`${SIDE_SENDER_PREFIX}${entry.componentId}`}
                  size="xs"
                  sidePadding="xs"
                  reselect
                  focusGroup={host.focusGroup}
                  focusOrder={LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER + index}
                  aria-labelledby={captionId}
                  data-testid={`lens-layouts-side-${entry.componentId}`}
                />
              </div>
            );
          })}

          {/* One row per side, always both: the arrangement that side's rail
              stands under. Below the position rows, because which edge a card
              holds is the question you answer first — a side has to be shared
              before it can be split. A side carrying fewer than two sidebar
              cards has nothing to arrange, so its row is disabled rather than
              absent, and it previews nothing: a hover cannot rehearse a
              gesture the control will not accept. */}
          {SIDES.map((side, index) => {
            const captionId = `${RAIL_CAPTION_ID_PREFIX}${side}`;
            const shared = isShared(side);
            return (
              <div
                className="layouts-section-row"
                data-preview-axis={shared ? `railmode:${side}` : undefined}
                data-disabled={shared ? undefined : ""}
                key={side}
              >
                <TugLabel
                  id={captionId}
                  size="md"
                  emphasis="proposal"
                  className="layouts-section-caption"
                >
                  {RAIL_CAPTIONS[side]}
                </TugLabel>
                <TugChoiceGroup
                  items={railModeItems}
                  value={railModes[side] ?? "stack"}
                  senderId={`${RAIL_SENDER_PREFIX}${side}`}
                  size="xs"
                  sidePadding="xs"
                  reselect
                  disabled={!shared}
                  focusGroup={host.focusGroup}
                  focusOrder={
                    LAYOUTS_FIRST_SIDEBAR_FOCUS_ORDER + sidebars.length + index
                  }
                  aria-labelledby={captionId}
                  data-testid={`lens-layouts-rail-${side}`}
                />
              </div>
            );
          })}
        </div>
      </div>
    </ResponderScope>
  );
}

/** Register the Layouts section. Called once at boot from `main.tsx`. */
export function registerLayoutsSection(): void {
  registerLensSection({
    kind: SECTION_KIND,
    title: "Layout",
    glyph: <Columns3 size={14} />,
    collapsedSummary: () => <LayoutsCollapsedSummary />,
    body: (host) => <LayoutsSectionBody host={host} />,
  });
}
