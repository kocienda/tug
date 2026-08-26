/**
 * lens-section-band.tsx — one Lens section: a band (glyph + title + live
 * collapsed-summary + fold chevron) over an internally-scrolling body.
 *
 * The band is a {@link BlockStrip} at `altitude="section"` ([P02]): the same
 * header-shell primitive the transcript tool-call header wears, one altitude
 * up — so the Lens sections and the transcript read as one component family.
 * The section keeps its own lensStore-driven collapse and conditional body
 * render; it is NOT a full `BlockChrome` (that would bridge two collapse
 * owners, see [Q01]).
 *
 * Every band is always visible: the Lens stack does not scroll — the section
 * is a flex band whose BODY scrolls internally when its content outgrows the
 * section's share of the height (the sizing lives in `lens-section-band.css`
 * / `lens-content.css`). No sticky pinning, no measured pin offsets.
 *
 * A `filterable` section carries a `TugFilterField` in its band's actions
 * cluster while expanded (`lens-filter-store` is the seam to the body's list —
 * see that module's docstring for why a store and not a delegate). The field is
 * live only while the section holds items: an empty section's filter is
 * disabled and out of the keyboard walk, read off the `populated` fact in
 * `lens-section-content` — never off the filtered count, which would disable
 * the field the moment a query narrowed to nothing.
 *
 * The band is itself a stop in the section's focus group, ahead of the filter
 * field, the section's own controls, and the fold chevron — which are stops too,
 * in the order they are read. So the arrow walk that runs down a section's rows
 * carries on into the next section's BAND, and folding a section is a keyboard
 * gesture: arrow to the band, Space. A collapsed section renders no body, so its
 * band and chevron are all it has — which is exactly what it takes to open it
 * again.
 *
 * On the band, Space FOLDS and Enter ENTERS. The two keys split because the band
 * stands for two things at once — the section's fold and its way in — and the
 * same split runs one level down, where a Cards group header takes Space as its
 * own fold. Space is the fold everywhere in the Lens; nothing has to remember
 * which level it is on.
 *
 * Clicking the band (anywhere except its buttons / the filter field) focuses
 * the section's list: it expands a collapsed section and lands the key view on
 * the section's focus group via a keyboard `place()`, so the band is a
 * one-click route to keyboard navigation of its items. DRAGGING the band
 * vertically carries the whole section to a new place in the stack — the band
 * is its own handle, so nothing is set aside at the right edge for one
 * ([P08]). The two gestures are told apart by travel, in `block-reorder`.
 *
 * Collapse is persisted via `lensStore.setCollapsed`; the expand/collapse
 * appearance is a `data-collapsed` attribute + CSS ([L06]). A collapsed
 * section renders its band's live `collapsedSummary` and hides its body.
 *
 * Laws: [L06] appearance via CSS + DOM attributes; [L02] collapse state
 * flows from `lensStore`; [L17]/[L20] the section sizes come from the
 * `data-altitude` token scale, not bespoke band CSS; [L19] file pair,
 * docstring, `data-slot`; [L22] the band-click focus goes through the
 * FocusManager (a keyboard `place()`), never a hand-rolled focus walk.
 *
 * @module components/lens/lens-section-band
 */

import React from "react";
import { lensStore } from "@/lib/lens-store/lens-store";
import { BlockStrip } from "@/components/tugways/blocks/block-strip";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import {
  useFocusable,
  useFocusManager,
} from "@/components/tugways/use-focusable";
import { getFilterQuery, setFilterQuery } from "./lens-filter-store";
import {
  getSectionContentVersion,
  sectionAttachedFilter,
  sectionIsPopulated,
  subscribeSectionContent,
} from "./lens-section-content";
import {
  LENS_BAND_ACTION_FOCUS_ORDER,
  LENS_BAND_FILTER_FOCUS_ORDER,
  LENS_BAND_FOCUS_ORDER,
  LENS_BAND_FOLD_FOCUS_ORDER,
  sectionFocusGroup,
} from "./lens-section-registry";
import type {
  LensSectionDefinition,
  LensSectionHost,
} from "./lens-section-registry";
import "./lens-section-band.css";

/** Render a section factory (body or collapsed-summary) inside its own
 *  component boundary so the factory may use hooks and collapse can
 *  mount/unmount it without breaking the rules of hooks. */
function LensSectionSlot({
  render,
  host,
}: {
  render: (host: LensSectionHost) => React.ReactNode;
  host: LensSectionHost;
}): React.ReactElement {
  return <>{render(host)}</>;
}

export interface LensSectionProps {
  def: LensSectionDefinition;
  host: LensSectionHost;
  collapsed: boolean;
  /** Arm a drag-reorder from the band itself (DOM-only preview, committed on
   *  drop by the owning `LensContent`). */
  onBandPointerDown?: (kind: string, event: React.PointerEvent) => void;
}

export function LensSection({
  def,
  host,
  collapsed,
  onBandPointerDown,
}: LensSectionProps): React.ReactElement {
  const focusManager = useFocusManager();

  // The band is a stop in its section's group, ahead of everything the body
  // holds ([P02]) — so the arrow walk that runs down one section's rows arrives
  // at the NEXT section's band rather than skipping straight into its list, and
  // a collapsed section (which renders no body at all) is still somewhere the
  // keyboard can go. A plain leaf: Enter reaches it as a synthesized press,
  // which is the same `onBandClick` a pointer makes — enter the section,
  // expanding it if it was folded. Space is the fold, taken below.
  const { focusableRef } = useFocusable({
    id: `lens-band-${def.kind}`,
    group: host.focusGroup,
    order: LENS_BAND_FOCUS_ORDER,
  });

  // Space on the band folds it. A leaf's act is a synthesized press — the engine
  // dispatches the keydown here and then completes it as a click unless the
  // keydown was consumed — so taking Space here is also what keeps it from
  // falling through to `onBandClick`, which means the opposite thing. Enter is
  // left alone and still enters the section, so the band's two meanings have a
  // key each.
  const onBandKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== " " && event.key !== "Spacebar") return;
      // A press that started on a control inside the band (the filter field's
      // caret, the fold chevron, a section's own button) is that control's.
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      lensStore.setCollapsed(def.kind, !collapsed);
    },
    [collapsed, def.kind],
  );

  // Band click → focus this section's list. Filtered to the band's inert
  // surface: clicks on the fold chevron or the header-action buttons keep
  // their own meaning. Expanding a collapsed section first means the list
  // mounts before the key view lands; the placement realizes immediately
  // against a mounted focusable and arms a late-mount resume for one still
  // mounting — both orderings land the ring. A click that concluded a
  // reorder drag never arrives here at all: `block-reorder` swallows it.
  const onBandClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      // The filter field is part of the band's chrome, not its inert surface —
      // a click into it must land the caret there, not yank focus to the list.
      if (target?.closest('button, [data-slot="tug-filter-field"]') !== null) {
        return;
      }
      if (collapsed) lensStore.setCollapsed(def.kind, false);
      focusManager?.place(
        host.lensCardId,
        { kind: "focus-key", focusKey: `${sectionFocusGroup(def.kind)}:0` },
        { modality: "keyboard" },
      );
    },
    [collapsed, def.kind, focusManager, host.lensCardId],
  );

  // The filter field's contract: publish each keystroke to the store the body
  // reads, and hand the key view down to the list on ArrowDown — the same
  // placement a band click makes. Escape is the field's own while it holds a
  // query; an empty field's Escape falls through to the Lens's own ladder.
  // Whether this section holds ANY item, filter or no filter — the fact the
  // field's enablement turns on. Read live from the section-content store
  // ([L02]); the body publishes it.
  React.useSyncExternalStore(subscribeSectionContent, getSectionContentVersion);
  const populated = sectionIsPopulated(host.focusGroup);

  // An empty section has nothing to filter, so it holds no query either. The
  // field is remounted across the flip (keyed below) and seeds from the store,
  // so clearing here is what keeps the disabled field's text and the list's
  // actual filter from drifting apart while items are away.
  React.useEffect(() => {
    if (!populated) setFilterQuery(def.kind, "");
  }, [populated, def.kind]);

  const filterDelegate = React.useMemo(
    () => ({
      filterFieldDidChangeQuery: (query: string) => {
        setFilterQuery(def.kind, query);
      },
      // ↑/↓ drive the body's list cursor with the caret staying here ([P08]).
      // The body publishes its handle under this section's focus group; the
      // lookup is per-keystroke because a collapsed section has no body.
      ...sectionAttachedFilter(host.focusGroup).delegate,
    }),
    [def.kind, focusManager, host.lensCardId, host.focusGroup],
  );

  return (
    <section
      className="lens-section"
      data-lens-section={def.kind}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <BlockStrip
        ref={focusableRef}
        altitude="section"
        className="tool-call-header"
        dataTestid="lens-section-band"
        dataCollapsed={collapsed}
        onClick={onBandClick}
        onKeyDown={onBandKeyDown}
        // The band IS the handle: a vertical drag from anywhere on it that is
        // not a control carries the section ([P08]).
        onPointerDown={
          onBandPointerDown !== undefined
            ? (e) => onBandPointerDown(def.kind, e)
            : undefined
        }
        leading={
          <span className="tool-call-header-leading" aria-hidden="true">
            {def.glyph}
          </span>
        }
        name={def.title}
        // Collapsed ⇒ the live one-line summary fills the detail column (the
        // flexible spacer), pushing the chevron right; expanded ⇒ an empty
        // detail is the spacer. The summary keeps its `lens-section-summary`
        // test hook.
        detail={
          collapsed ? (
            <span data-testid="lens-section-summary">
              <LensSectionSlot render={def.collapsedSummary} host={host} />
            </span>
          ) : undefined
        }
        actions={
          <>
            {/* The filter field leads the actions cluster while the section is
                expanded. It registers in the section's own group with the
                default `accept` policy, at the order that puts it between the
                band and the actions it precedes on screen, so the walk runs the
                band the way it reads: band → filter → controls → chevron →
                list. It is still never the ⌘L seed target, which addresses
                `<group>:0` by key — the list.

                A section with NO items disables its field: nothing to filter,
                so no caret and no Tab stop (`TugInput` declines to register a
                disabled stop, so the walk passes the whole band by). The gate
                is the UNFILTERED count and only ever that — a query that
                narrows to zero leaves the field live, because there it is the
                only way back ([R02]).

                The field is keyed on that flip so it remounts and re-seeds from
                the store, which the effect above clears while the section is
                empty; within a state it stays mounted, and it remounts per
                expand seeded the same way, so a query survives a collapse. */}
            {collapsed || def.filterable !== true ? null : (
              <TugFilterField
                key={populated ? "live" : "inert"}
                delegate={filterDelegate}
                attachment={sectionAttachedFilter(host.focusGroup)}
                placeholder={`Filter ${def.title}`}
                defaultValue={getFilterQuery(def.kind)}
                disabled={!populated}
                data-testid="lens-section-filter"
                focusGroup={host.focusGroup}
                focusOrder={LENS_BAND_FILTER_FOCUS_ORDER}
              />
            )}

            <BlockFoldCue
              collapsed={collapsed}
              onToggle={(next) => lensStore.setCollapsed(def.kind, next)}
              collapsedLabel="Expand"
              expandedLabel="Collapse"
              ariaLabelExpand={`Expand ${def.title}`}
              ariaLabelCollapse={`Collapse ${def.title}`}
              size="xs"
              subtype="icon"
              // The chevron is the keyboard's fold: the band's last stop, and
              // the only one a collapsed section still offers besides the band
              // itself. Authored into the section's group rather than left an
              // un-walked native button, so arrowing along the band reaches it.
              focusGroup={host.focusGroup}
              focusOrder={LENS_BAND_FOLD_FOCUS_ORDER}
              // The section body owns its own scrolling; a section fold is a
              // plain toggle, so skip the fold-cue's scroll-stabilization
              // machinery (a no-op here anyway).
              stabilizeScroll={false}
            />
          </>
        }
      />
      {collapsed ? null : (
        <div className="lens-section-body" data-testid="lens-section-body">
          <LensSectionSlot render={def.body} host={host} />
        </div>
      )}
    </section>
  );
}
