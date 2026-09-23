/**
 * jots-card.tsx — the **Jots** card: a keyboard-navigable `TugListView` of
 * reusable prompt fragments backed by the machine-global `jots.json`
 * (`jotsStore`).
 *
 * Jots is a capture surface, not a mirror of the deck, so it stands as its own
 * sidebar card rather than as a band inside a shared rail card. It brings its own chrome
 * — filter field, `+`, focus group — where it used to rent that band's.
 *
 * The list is authored into the card's focus group, so it is one Tab stop.
 * The grammar:
 *  - **Arrows** rove the cursor and carry the selection with it
 *    (`selectionFollowsCursor`) — the green fill is always on the row the
 *    keyboard is on, which is also the row the section verbs act on;
 *    **ArrowRight** descends onto the row's Copy / ✕, which the horizontal
 *    arrows then walk; **Enter** opens the cursor row's editor
 *    (`onActivate` → `beginEdit`), which mounts a `TugMessageEditor` (the
 *    `TugTextEditor` CM6 substrate, markdown-styled) inside a focusable
 *    wrapper authored into the row's descend scope; the row claims the CM6
 *    caret itself (the engine's ladder yields keys to a focused editor).
 *    **Escape** ascends the row scope (the wrapper's handler — the surface
 *    owns its Escape) and the resulting **blur** commits; **⌘Return**
 *    commits and chains a new jot. **Space** selects only.
 *  - Card verbs while the list holds the key view (delivered via the
 *    list's `onKeyViewKey` delegate — the [P05] channel): **Space** creates
 *    below the cursor, **Delete** removes the cursor row (read from the
 *    projected `data-key-cursor`) and lands the cursor on the surviving
 *    neighbor, **⌘Z / ⇧⌘Z** undo/redo (via a chain responder, active only
 *    in list mode so the editor's CM6 undo wins while typing). Each display
 *    row also carries a hover-reveal delete button for the pointer.
 *  - A **right-click** on a display row opens the jot's own menu — Edit, the
 *    four standard clipboard verbs acting on the whole jot, New and Delete
 *    (`jot-row-menu`). Every one of them names the jot the press landed on,
 *    which is why none is a chord.
 *  - A row's incipit is draggable into a session prompt (native HTML5 drag,
 *    `jotDragStart`); dragging the row VERTICALLY reorders instead
 *    (commit on drop, [Q02]). One surface, two drags, told apart by axis in
 *    `block-reorder`.
 *
 * One cell kind (`"jot"`) branches display/editor on `editingId` — never
 * two kinds for one row ([L26]). Laws: [L02] store via `useSyncExternalStore`;
 * [L06] cursor/selection appearance is CSS on engine attributes; [L22] the
 * FocusManager owns the cursor and the descend scope; [L11] the editor's
 * CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO responders ride the composed substrate.
 *
 * @module components/jots/jots-card
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Copy, Plus, X } from "lucide-react";
import type { Extension } from "@codemirror/state";

import { PLACEMENT_POLICY_ATTRIBUTE } from "@/gesture-interpreter";
import { fileNameResolverFor } from "@/lib/annotator/file-name-resolution";
import { pathResolutionStore } from "@/lib/annotator/path-resolution";
import { makeMultiRootReferenceResolver } from "@/lib/annotator/resolve-reference";
import { VerdictBatcher } from "@/lib/annotator/verdict-batching";
import { useFrontmostProjectBinding } from "@/lib/frontmost-project";
import { getJotsStore } from "@/lib/jots-store";
import { jotAtomSegments, jotIncipit, type Jot } from "@/lib/jots-doc";
import { jotDragStart } from "@/lib/jot-drag";
import { renderBeatLine } from "@/lib/beat-line/render-beat-line";
import { copyAtomTextWithOrigins, formatAtomTextForCopy } from "@/lib/atom-text";
import type { TugTextSubstrate } from "@/lib/tug-text-types";
import { animate } from "@/components/tugways/tug-animator";
import { annotationLinkExtension } from "@/components/tugways/tug-text-editor/annotation-links";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
  TugListViewDelegate,
  TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import {
  TugMessageEditor,
  type TugMessageEditorHandle,
} from "@/components/tugways/tug-message-editor";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import type { TugPopoverMeasurable } from "@/components/tugways/tug-popover";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import {
  useAttachedFilter,
  type AttachedFilterBinding,
} from "@/components/tugways/attached-filter";
// Every rail card's one-line list is the same kind of surface — a dense index
// of one-line handles read by scanning — so they share one presentation. A
// second copy here would be two lists disagreeing about what a row looks like.
import { RAIL_LIST_PRESENTATION } from "@/components/tugways/rail-list-presentation";
import { BlockDropCaret } from "@/components/tugways/block-drop-caret";
import { useBlockReorder } from "@/components/tugways/block-reorder";
import {
  useFocusable,
  useFocusManager,
  useSeedKeyView,
} from "@/components/tugways/use-focusable";
import { useResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { useJotRowMenu } from "./jot-row-menu";
import { JotsDataSource, useJotsDataSource } from "./jots-data-source";
import "./jots-card.css";

/** The card's focus group — every stop it offers lives here, so the Tab walk
 *  runs the card's chrome and then its rows. */
const JOTS_FOCUS_GROUP = "jots-card";

/** Chrome stands ahead of the list, which registers at 0: the walk reads the
 *  card the way it looks — filter, `+`, then the rows. */
const JOTS_FILTER_FOCUS_ORDER = -1;

/** @see JOTS_FILTER_FOCUS_ORDER */
const JOTS_ADD_FOCUS_ORDER = -0.75;

const ROW_SELECTOR = ".jot-row-content[data-jot-id]";
const ROW_KIND_ATTR = "data-jot-id";

// Space is reserved so the card's key-view delegate can create a new jot below
// the cursor (Things-style) rather than the engine's default item-container
// select.
const JOTS_CAPTURE_KEYS: readonly string[] = [" "];

// The card's remembered selection — the last-touched jot id, mapped to a cursor
// seed on the next entry into the card. Module-level so it outlives the body's
// unmount across a hide/show; valid while Jots is a singleton card.
let lastSelectedJotId: string | null = null;

/** Unwrap the single enclosing `<p>…</p>` the block markdown renderer wraps a
 *  one-line string in, so a jot incipit renders as INLINE markdown (its text
 *  reads on the row's baseline, not as a block paragraph). A multi-block or
 *  non-paragraph render is left as-is. */
function inlineMarkdownHtml(html: string): string {
  const match = /^<p>([\s\S]*)<\/p>$/.exec(html.trim());
  return match !== null ? match[1] : html;
}

/** Copy a jot's raw text to the clipboard — native bridge in Tug.app (no
 *  permission popup), the async Clipboard API in browser-dev.
 *
 *  The jot's own origins ride along, so provenance survives another hop: a
 *  passage copied out of a transcript into a jot and on into a prompt is still
 *  about the project it started in. This is the one surface whose roots are
 *  DATA rather than a DOM stamp — and the one that can carry more than one.
 *
 *  The atoms ride with them, as the clipboard's sidecar: a chip copied out of
 *  a jot pastes back into a Tug editor as that chip. What an app outside Tug
 *  reads is the [B03] plain form, which is the one place the flattening
 *  happens. */
function copyJotText(jot: Jot): void {
  if (jot.text === "") return;
  const atoms = jotAtomSegments(jot);
  void copyAtomTextWithOrigins(
    jot.text,
    atoms,
    formatAtomTextForCopy(jot.text, atoms),
    jot.origins ?? [],
  );
}

/**
 * An anchor over a row's trailing accessory that cannot collapse under its
 * own popover.
 *
 * The ✕ is a hover reveal, and opening the popover takes the pointer off the
 * row: the accessory slot goes to `inline-size: 0` and the button's own rect
 * becomes a sliver at the row's trailing edge, so a popover anchored to the
 * button visibly hops there. The ROW is present for as long as the question it
 * is asking about — so measure the accessory's column once, against the row,
 * and re-derive it from the row on every reposition. The popover keeps
 * pointing at the ✕ and still tracks scroll and relayout.
 *
 * The rect spans the row vertically (the popover sits above the row, as a
 * row-anchored one did) and the accessory horizontally (which is the part the
 * user asked for back).
 */
function accessoryColumnAnchor(
  row: HTMLElement,
  accessory: HTMLElement,
): TugPopoverMeasurable {
  const inset =
    row.getBoundingClientRect().right -
    accessory.getBoundingClientRect().right;
  const width = accessory.getBoundingClientRect().width;
  return {
    getBoundingClientRect(): DOMRect {
      const live = row.getBoundingClientRect();
      return new DOMRect(
        live.right - inset - width,
        live.top,
        width,
        live.height,
      );
    },
  };
}

/** Row verbs and the live filter, provided by the card body to the
 *  module-level cell. */
interface JotsCellContextValue {
  onRowPointerDown: (id: string, event: React.PointerEvent) => void;
  /** Open the destructive-delete confirm popover over the row's ✕. */
  onRequestDelete: (id: string, anchor: TugPopoverMeasurable) => void;
  /** Open the row's context menu over the press — the jot's text verbs. */
  onRowContextMenu: (jot: Jot, event: React.MouseEvent) => void;
  /** The query the rows mark their matches against. */
  filterQuery: string;
}
const JotsCellContext =
  React.createContext<JotsCellContextValue | null>(null);

function useJots() {
  const store = getJotsStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}

/**
 * The card's toolbar: the filter field and the `+`.
 *
 * A section band used to hang these; a card has to bring its
 * own. Both stops are authored into the card's focus group ahead of the list,
 * so arrowing up out of the rows reaches them.
 *
 * The field is disabled while the card holds no jots at all — nothing to
 * filter, so no caret and no Tab stop. The gate is the UNFILTERED count and
 * only ever that: a query that narrows to zero must leave the field live,
 * because there it is the only way back.
 */
function JotsToolbar({
  query,
  onQueryChange,
  populated,
  onAdvance,
  filter,
}: {
  query: string;
  onQueryChange: (next: string) => void;
  populated: boolean;
  onAdvance: () => void;
  /** The pairing with the jot list ([P08]) — ↑/↓ drive its cursor while the
   *  caret stays here, and a character typed at the list lands here. */
  filter: AttachedFilterBinding;
}): React.ReactElement {
  const store = getJotsStore();
  const delegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: onQueryChange,
      ...filter.delegate,
    }),
    [onQueryChange, onAdvance, filter],
  );
  return (
    <div className="jots-toolbar" data-testid="jots-toolbar">
      <TugFilterField
        key={populated ? "live" : "inert"}
        delegate={delegate}
        attachment={filter}
        placeholder="Filter Jots"
        defaultValue={query}
        disabled={!populated}
        data-testid="jots-filter"
        focusGroup={JOTS_FOCUS_GROUP}
        focusOrder={JOTS_FILTER_FOCUS_ORDER}
      />
      <TugIconButton
        icon={<Plus size={14} />}
        size="xs"
        aria-label="New jot"
        title="New jot"
        data-testid="jots-add-button"
        focusGroup={JOTS_FOCUS_GROUP}
        focusOrder={JOTS_ADD_FOCUS_ORDER}
        onClick={() => store.createJot(null)}
      />
    </div>
  );
}

/**
 * Focus group for a display row's copy / delete accessories. The rows render
 * inside `TugListView`'s per-row `FocusModeContext`, so the buttons register
 * into their own row's descend scope — the mode scopes the walk, this constant
 * is only the within-row ordering. ArrowRight on the cursor row lands on Copy;
 * the trailing cluster is already revealed by the row's keyboard cursor, so the
 * affordance is on screen before the descend reaches it. Same authoring as the
 * session picker's row trash button.
 */
const ROW_ACTION_FOCUS_GROUP = "jots-row-actions";

/** The display row on the shared `TugListRow` chrome: the draggable incipit is
 *  the content column and a hover-reveal copy / delete pair is the trailing
 *  accessory. The row is also its own reorder handle. Row padding / hover /
 *  divider / caret come from the row + the enclosing flush `TugListView`. */
function JotDisplayRow({
  jot,
  selected,
}: {
  jot: Jot;
  selected: boolean;
}): React.ReactElement {
  const ctx = React.useContext(JotsCellContext);
  const filterQuery = ctx?.filterQuery ?? "";
  const incipit = jotIncipit(jot);
  const empty = incipit.length === 0;
  // The incipit renders INLINE markdown (`*hello*` → italic) via the same
  // sanitized one-line renderer the beat line uses, unwrapped to inline. An
  // empty `html` is its plain-text signal (no markup, or a parse fallback).
  // While a filter is active the row shows PLAIN text instead, so the match can
  // be marked: highlight ranges are offsets into the incipit string, which
  // rendered markup would not agree with.
  const rendered = empty || filterQuery !== "" ? null : renderBeatLine(incipit);
  const incipitHtml =
    rendered !== null && rendered.html.length > 0
      ? inlineMarkdownHtml(rendered.html)
      : null;
  return (
    <TugListRow
      className="jot-row-content"
      data-jot-id={jot.id}
      selected={selected}
      // The row is its own reorder handle. A VERTICAL drag carries it; a
      // horizontal one is left to the incipit's native drag-out below, which
      // is why the two can share the same surface ([P08]).
      onPointerDown={(e) => ctx?.onRowPointerDown(jot.id, e)}
      // Every text verb the row offers is behind this press ([D132] — no
      // surface in the suite answers a right-click with "No Actions").
      onContextMenu={(e) => ctx?.onRowContextMenu(jot, e)}
      trailing={
        ctx !== null ? (
          <>
            <TugIconButton
              icon={<Copy size={12} />}
              size="xs"
              aria-label="Copy jot"
              title="Copy jot"
              focusGroup={ROW_ACTION_FOCUS_GROUP}
              focusOrder={0}
              onClick={(e) => {
                // A copy is not a row activation — stop it reaching the cell.
                e?.stopPropagation();
                copyJotText(jot);
              }}
            />
            <TugIconButton
              className="jot-row-delete"
              icon={<X size={12} />}
              size="xs"
              tone="danger"
              aria-label="Delete jot"
              title="Delete jot"
              focusGroup={ROW_ACTION_FOCUS_GROUP}
              focusOrder={1}
              onClick={(e) => {
                // Never let the delete read as a row activation (open) on the
                // cell wrapper above.
                e?.stopPropagation();
                // Point the confirm at this ✕ — but measured off the ROW, which
                // outlives the hover reveal the button depends on. See
                // `accessoryColumnAnchor`.
                const button = e?.currentTarget;
                const cell = button?.closest?.(".tug-list-view-cell");
                if (cell instanceof HTMLElement && button instanceof HTMLElement) {
                  ctx.onRequestDelete(
                    jot.id,
                    accessoryColumnAnchor(cell, button),
                  );
                }
              }}
            />
          </>
        ) : undefined
      }
      trailingReveal="claim"
    >
      <span
        className={
          empty ? "jot-row-label jot-row-label-empty" : "jot-row-label"
        }
        // An empty jot has nothing to carry, so it isn't a drag source.
        draggable={!empty}
        onDragStart={(e) => jotDragStart(e, jot.text, jotAtomSegments(jot))}
      >
        {empty ? (
          "New jot"
        ) : incipitHtml !== null ? (
          <span
            className="jot-row-incipit"
            dangerouslySetInnerHTML={{ __html: incipitHtml }}
          />
        ) : (
          renderFilterHighlight(incipit, filterQuery)
        )}
      </span>
    </TugListRow>
  );
}

/**
 * The in-place editor — a `TugMessageEditor` (CM6 substrate, markdown-styled)
 * inside a wrapper registered as the row's descend-scope focusable. The engine
 * lands DOM focus on the wrapper (`tabIndex={-1}`); the wrapper forwards it
 * into the CM6 caret. Escape ascends (engine) and the resulting blur commits;
 * ⌘Return (the substrate's `onSubmit`) commits + chains a new jot.
 */
/**
 * One animator slot for the editor well's open AND close. Sharing the slot is
 * what makes the two loops exclusive: whichever starts second cancels the first
 * on the same element rather than compositing against it.
 */
const JOT_WELL_MOTION_SLOT = "jot-editor-well";

/**
 * The annotator's file references, followable from inside the jot.
 *
 * A jot is most often a passage lifted straight out of a transcript, and a
 * transcript passage cites files. The text survives the copy — the link does
 * not, because the annotator marks rendered ink and a jot is a CM6 document.
 * `annotationLinkExtension` runs the same grammar and the same resolvers over
 * the buffer, so the citation the user copied is ⌘-clickable where they
 * parked it.
 *
 * **Which project.** Jots are machine-global (`jots.json`), so unlike the
 * transcript there is no session binding to read a root from. The frontmost
 * bound card's project stands in — the same root Open Quickly searches, and
 * for the same reason: whatever project is in front is very likely the one
 * the jot is about. A jot carried to another project simply resolves to
 * nothing and stays plain text, which is what every unconfirmed reference
 * does anywhere else.
 *
 * The extension is minted once per editor: the substrate reads its host
 * extensions at mount and never again. So the inputs are handed over as
 * stable closures that read the live values — a project binding landing while
 * a jot is open still lights its references up, through the verdict fan-out
 * below rather than through a new extension identity.
 */
function useJotAnnotationLinks(jot: Jot): Extension {
  const binding = useFrontmostProjectBinding();
  const projectDir = binding?.projectDir ?? null;
  const workspaceKey = binding?.workspaceKey ?? null;
  const names = fileNameResolverFor(projectDir, workspaceKey);
  // The jot's OWN roots first — the projects its text was pasted out of, which
  // is the only thing that knows what a relative path in it means. The
  // frontmost bound project comes last as a fallback, for a jot typed rather
  // than pasted and for every jot written before provenance was carried at
  // all: a guess, but the same one the card made before, and a wrong guess
  // resolves nothing rather than resolving something else.
  const origins = jot.origins;
  const cwds = useMemo(
    () => [...(origins ?? []), projectDir],
    [origins, projectDir],
  );
  const resolvePath = useMemo(
    () =>
      makeMultiRootReferenceResolver({
        paths: pathResolutionStore,
        names,
        cwds,
      }),
    [names, cwds],
  );
  const subscribe = useMemo(() => {
    const sources = [pathResolutionStore, names].filter(
      (source): source is NonNullable<typeof source> => source !== null,
    );
    return new VerdictBatcher(sources).subscribe;
  }, [names]);

  // Both inputs reach the mount-captured extension through one indirection:
  // the resolver is read at call time, and verdicts fan out from a listener
  // set this effect re-attaches whenever the batcher changes. Without the
  // fan-out the extension would hold a subscription to whichever batcher
  // existed at mount, and a workspace acquired afterwards would answer into
  // a channel nobody was listening on.
  const resolveRef = useRef(resolvePath);
  resolveRef.current = resolvePath;
  const listenersRef = useRef<Set<() => void>>(new Set());
  useEffect(() => {
    const listeners = listenersRef.current;
    return subscribe(() => {
      for (const listener of listeners) listener();
    });
  }, [subscribe]);

  return useMemo(
    () =>
      annotationLinkExtension({
        resolvePath: (reference) => resolveRef.current(reference),
        subscribe: (listener) => {
          const listeners = listenersRef.current;
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      }),
    [],
  );
}

function JotEditorRow({
  jot,
  store,
}: {
  jot: Jot;
  store: ReturnType<typeof getJotsStore>;
}): React.ReactElement {
  const manager = useFocusManager();
  const editorRef = useRef<TugMessageEditorHandle | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const wellRef = useRef<HTMLDivElement | null>(null);
  const focusableId = useId();
  const annotationLinks = useJotAnnotationLinks(jot);

  // Slide the editor OPEN — the WELL grows from zero to its natural height so
  // the card visibly opens rather than snapping ([L06] via WAAPI, not React
  // state; reduced-motion honored by the animator). The clip + grow ride the
  // WELL, never the `.jot-editor` wrapper: the wrapper must stay
  // `overflow: visible` so the sticky header can pin against the LIST scroller
  // (an `overflow: hidden` ancestor would capture the sticky as its own scroll
  // context and the header would scroll away with the body). The header shows
  // at full height from the first frame; the well opens beneath it.
  useLayoutEffect(() => {
    const el = wellRef.current;
    if (el === null) return;
    const target = el.getBoundingClientRect().height;
    if (target <= 0) return;
    const prevOverflow = el.style.overflow;
    el.style.overflow = "hidden";
    const restore = (): void => {
      el.style.overflow = prevOverflow;
      // The animator commits the final keyframe as inline styles (`height`,
      // `opacity`). Release them so the well returns to auto height and keeps
      // growing line-by-line as the jot is typed — a committed `height`
      // would clamp the well at its open size.
      el.style.height = "";
      el.style.opacity = "";
    };
    animate(
      el,
      [
        { height: "0px", opacity: 0 },
        { height: `${target}px`, opacity: 1 },
      ],
      {
        duration: "--tug-motion-duration-moderate",
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        key: JOT_WELL_MOTION_SLOT,
      },
    ).finished.then(restore, restore);
  }, []);

  // Slide the editor SHUT — the mirror of the open above, and the reason every
  // close routes through here.
  //
  // There is no exit animation to run after the fact: closing clears the
  // store's `editingId`, the cell swaps back to the display row, and React
  // tears this subtree down inside that same commit. So the collapse has to run
  // BEFORE the commit — play the well to zero, then commit, and the unmount
  // lands on a well that is already closed, which is why the swap is invisible.
  //
  // Both loops share one motion slot with the open, so a close that catches an
  // open still in flight cancels it (snap-to-end, which runs the open's own
  // `restore` and releases its committed inline height) instead of racing it.
  const closingRef = useRef(false);

  // Closing must not move the jot's title line, and what decides where that
  // line sits is the CARD ROOT's `scrollTop` (the card's one scroller). The
  // ascend every close performs re-reveals the key view, and while the editor
  // is open the key view is the EDITING CELL — a cell taller than the
  // scrollport, which `revealFocusTarget` brings in by its leading edge and so
  // scrolls the card to do it. Revealing a cell that is one animation away
  // from not existing moves the whole card content for nothing: the hop.
  //
  // So the card's resting scroll position is SAMPLED as it settles and the
  // close puts it back. Sampled rather than latched at the gesture because the
  // gesture is not always this component's to see: Escape is claimed by the
  // responder chain, which ascends and stops the event before the row's own
  // handler runs. A `scroll` event is dispatched asynchronously, while the
  // ascend's reveal, the blur it produces, and the close that blur starts are
  // all one task — so the sample the close reads is still the pre-reveal one,
  // whichever gesture asked. Freezing it for the duration is what keeps the
  // reveal's own write from being mistaken for the user's position.
  //
  // Clamping still has the last word: a position the shortened content cannot
  // hold is geometry, not a jump.
  const scrollHoldRef = useRef<{ el: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = wrapRef.current?.closest<HTMLElement>(".jots-card") ?? null;
    if (el === null) return;
    scrollHoldRef.current = { el, top: el.scrollTop };
    const onScroll = (): void => {
      if (closingRef.current) return;
      scrollHoldRef.current = { el, top: el.scrollTop };
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const holdScroll = useCallback((): void => {
    const hold = scrollHoldRef.current;
    if (hold === null) return;
    if (Math.round(hold.el.scrollTop) !== Math.round(hold.top)) {
      hold.el.scrollTop = hold.top;
    }
  }, []);
  const closeWithCollapse = useCallback((): void => {
    // Re-entrancy: ✕ ascends, and the ascend's blur arrives right behind it.
    if (closingRef.current) return;
    closingRef.current = true;
    holdScroll();
    const el = wellRef.current;
    const commit = (): void => {
      if (store.getSnapshot().editingId === jot.id) {
        store.commitEdit();
        // The swap puts the display row back at the header's own height, so
        // there is nothing for the scroller to clamp — but the commit is the
        // last beat of the close, and the hold is only honest if it outlives
        // it. Once more after the commit paints, then release.
        holdScroll();
        requestAnimationFrame(() => {
          holdScroll();
          scrollHoldRef.current = null;
        });
        return;
      }
      // Editing moved on without us (a second jot opened mid-collapse) —
      // this row is staying, so hand its well back its natural height.
      if (el !== null) {
        el.style.overflow = "";
        el.style.height = "";
        el.style.opacity = "";
      }
      scrollHoldRef.current = null;
      closingRef.current = false;
    };
    if (el === null) {
      commit();
      return;
    }
    const from = el.getBoundingClientRect().height;
    el.style.overflow = "hidden";
    animate(
      el,
      [
        { height: `${from}px`, opacity: 1 },
        { height: "0px", opacity: 0 },
      ],
      {
        duration: "--tug-motion-duration-moderate",
        // Accelerating out, against the open's decelerating in: a card settles
        // into place when it arrives and leaves briskly when dismissed.
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        key: JOT_WELL_MOTION_SLOT,
      },
    ).finished.then(commit, commit);
  }, [store, jot.id, holdScroll]);
  // Registers into the cell's per-row FocusModeContext, so `descendIntoRow`
  // finds this wrapper as the row's inner focusable. No key-view behavior:
  // a behavior-less leaf keeps Enter as a newline in the editor and leaves
  // Escape to the engine's ascend.
  const { focusableRef } = useFocusable({
    id: focusableId,
    group: "jot-row-editor",
    order: 0,
  });

  // Claim the CM6 caret on open. The editor row only ever mounts from an
  // explicit open gesture (Enter / + / ⌘N via `editingId`), so taking focus
  // here is always the user's intent. The engine's `focusKeyView` cannot
  // land it: its generic DOM walk refuses a `tabIndex={-1}` wrapper and
  // cannot focus a contenteditable caret, and the substrate's responder
  // focus contract is keyed to the editor's responder id, not this wrapper's
  // focusable id. The delegate's `focus()` routes through `focusResponder`,
  // so first-responder state tracks the caret ([L11]).
  //
  // Deferred to a microtask deliberately: this child layout effect runs
  // BEFORE the section body's descend effect, and the focus claim must run
  // AFTER it — the descend's `pushFocusMode` captures the current key view
  // as the scope's Escape-restore target, and claiming first would make the
  // chain reflection coarsen the key view onto the editor's responder, so
  // Escape would "restore" focus straight back into the caret it should be
  // leaving. The microtask runs after the whole commit's effects, before
  // paint; the CM6 view exists by then.
  useLayoutEffect(() => {
    queueMicrotask(() => editorRef.current?.focus());
  }, []);

  // A pointerdown on the card's own CHROME (the sticky header, the well padding
  // around the text — anything that is NOT the editor's contenteditable) is not
  // a departure from the editor. Left alone, the engine's pointer placement
  // resolves such a click to the row's plain wrapper focusable, which is
  // engine-routed: it parks focus at the key sink, blurring the caret and
  // committing (closing) the jot. The wrapper declares itself
  // placement-suppressing and the editor re-declares itself placeable
  // (`PLACEMENT_POLICY_ATTRIBUTE`, nearest marker wins), so the gesture
  // interpreter classifies a chrome click as `placement: "suppressed"` and the
  // caret stays put. A pointerdown in the text, in another row, or outside the
  // jots list is untouched, so those still place / commit as before.
  //
  // Timestamp of the last card-chrome pointerdown, read by `onBlur` as a
  // last-resort net. A recency window (not a one-shot boolean) is robust to the
  // blur firing either synchronously in the gesture OR a tick later — both land
  // inside the window. A non-chrome pointerdown or any keydown resets it to 0,
  // so clicking a different row / Escape / Tab still commits.
  const chromeClickTsRef = useRef(0);

  // The editor's own contenteditable is placeable — the marker on the wrapper
  // above would otherwise suppress placement for the text too, and a click in
  // the text must still resolve to the editor's dom-granted responder. Stamped
  // on the mounted CM6 root, which `TugMessageEditor` owns.
  useLayoutEffect(() => {
    wellRef.current
      ?.querySelector(".cm-editor")
      ?.setAttribute(PLACEMENT_POLICY_ATTRIBUTE, "place");
  }, []);

  useLayoutEffect(() => {
    const inChrome = (t: EventTarget | null): boolean => {
      const el = wrapRef.current;
      return (
        el !== null &&
        t instanceof Node &&
        el.contains(t) &&
        (!(t instanceof Element) || t.closest(".cm-editor") === null)
      );
    };
    // On a chrome pointerdown: stamp the recency window. Any other pointerdown
    // clears it.
    const onDown = (e: PointerEvent): void => {
      chromeClickTsRef.current = inChrome(e.target) ? Date.now() : 0;
    };
    // Stop the browser's OWN mousedown focus default too: the chrome is not
    // focusable, so the native default would pull DOM focus off the caret
    // (toward the nearest focusable ancestor, or clear it to the body), blurring
    // and committing the editor. `preventDefault` keeps the caret put; the click
    // still fires, so the header's buttons (copy / ✕) keep working.
    const onMouseDown = (e: MouseEvent): void => {
      if (inChrome(e.target)) e.preventDefault();
    };
    // A keyboard departure (Escape / Tab) is never a chrome click: close the
    // window so its blur commits.
    //
    // This listener claims no chord at all — it reads *that* a key was
    // pressed, never which one, and neither prevents the default nor stops
    // propagation. There is nothing here for the keymap to see because there
    // is nothing here to take.
    const onKey = (): void => {
      chromeClickTsRef.current = 0;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [manager]);

  const onFocus = useCallback((e: React.FocusEvent<HTMLDivElement>): void => {
    // A later engine focus lands on the wrapper itself; forward into the CM6
    // caret. Focus arriving already inside the editor passes through.
    if (e.target === e.currentTarget) editorRef.current?.focus();
  }, []);

  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>): void => {
      // Commit when focus leaves the row entirely (Escape-ascend, Tab,
      // click-away) — the single close path. Focus moves within the row
      // (wrapper → CM6) are not an exit.
      if (
        e.relatedTarget instanceof Node &&
        e.currentTarget.contains(e.relatedTarget)
      ) {
        return;
      }
      // Last-resort net for a blur that a chrome click still produced (the
      // engine placement was suppressed, so the caret can be restored without a
      // watchdog re-park fighting it). A blur within the recency window of a
      // chrome pointerdown is that click's — keep the editor and restore the
      // caret. The window is closed by a non-chrome pointerdown / keydown, so a
      // genuine departure still commits.
      if (Date.now() - chromeClickTsRef.current < 500) {
        queueMicrotask(() => editorRef.current?.focus());
        return;
      }
      closeWithCollapse();
    },
    [closeWithCollapse],
  );

  // ⌘Return commits and chains a new jot; the new row's editor opens via
  // the store's `editingId` + the descend effect. Deliberately NOT routed
  // through `closeWithCollapse`: this is a typing gesture, and the caret has to
  // land in the next jot on the same beat the key is pressed — a collapse
  // would hold it for the duration first. Closing is what animates; chaining is
  // what stays instant.
  const onSubmit = useCallback((): void => {
    manager?.ascend();
    store.commitEdit();
    store.createJot(jot.id);
  }, [manager, store, jot.id]);

  // Keep the caret in view as the jot is edited. The editor grows uncapped
  // and the jots list is the single scroller (see `jots-card.css`), so a
  // jot taller than the card makes the LIST scroll — nothing auto-follows
  // the caret there. The substrate owns the reveal (it owns the caret): it
  // schedules on CM6's measure cycle and clears the card's pinned header. This
  // is why the edit can never scroll off, even when the content dwarfs the card.
  const onChange = useCallback(
    ({ text, atoms }: TugTextSubstrate): void => {
      // Both halves, straight onto the record: a jot is where a chip goes to be
      // kept, and the text alone would keep only the placeholder it stands at.
      store.updateJot(jot.id, text, atoms);
      editorRef.current?.revealCaret();
    },
    [store, jot.id],
  );

  // Escape closes the editor. The engine's Escape ladder yields to a focused
  // CM6 editor (`data-tug-tab-consume` marks it as owning its keys), so the
  // ascend is this surface's to perform: CM6's completion keymap consumes
  // Escape first when a popup is open (arriving here `defaultPrevented`);
  // a bare Escape ascends the row scope, and the resulting blur commits.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      manager?.ascend();
    },
    [manager],
  );

  // The ✕ closes the open card: ascend (restores the list's key view) and the
  // resulting blur commits — the same path Escape takes.
  const onClose = useCallback(
    (e?: React.MouseEvent): void => {
      e?.stopPropagation();
      manager?.ascend();
      closeWithCollapse();
    },
    [manager, closeWithCollapse],
  );

  // The card header's title is the jot's LIVE incipit — it re-renders with
  // every keystroke (the store update round-trips through the list), so the
  // header always names what the first line currently says. Same inline-
  // markdown rendering as the display row.
  const ctx = React.useContext(JotsCellContext);
  const incipit = jotIncipit(jot);
  const empty = incipit.length === 0;
  const rendered = empty ? null : renderBeatLine(incipit);
  const incipitHtml =
    rendered !== null && rendered.html.length > 0
      ? inlineMarkdownHtml(rendered.html)
      : null;

  // The open card: the jot's own row stays as the card HEADER (selection
  // fill, copy / close), and the editor is the WELL beneath it. The two
  // compose as one full-width card whose edges are the list's existing lines —
  // no border of its own, so no nested rectangles are possible.
  return (
    <div
      className="jot-editor"
      ref={(el) => {
        wrapRef.current = el;
        focusableRef(el);
      }}
      {...{ [PLACEMENT_POLICY_ATTRIBUTE]: "suppress" }}
      tabIndex={-1}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <TugListRow
        className="jot-editor-header"
        data-jot-id={jot.id}
        selected
        onPointerDown={(e) => ctx?.onRowPointerDown(jot.id, e)}
        trailing={
          <>
            <TugIconButton
              icon={<Copy size={12} />}
              size="xs"
              aria-label="Copy jot"
              title="Copy jot"
              onClick={(e) => {
                e?.stopPropagation();
                copyJotText(jot);
              }}
            />
            <TugIconButton
              icon={<X size={12} />}
              size="xs"
              aria-label="Close editor"
              title="Close editor"
              onClick={onClose}
            />
          </>
        }
      >
        <span
          className={
            empty
              ? "jot-row-label jot-row-label-empty"
              : "jot-row-label"
          }
        >
          {empty ? (
            "New jot"
          ) : incipitHtml !== null ? (
            <span
              className="jot-row-incipit"
              dangerouslySetInnerHTML={{ __html: incipitHtml }}
            />
          ) : (
            incipit
          )}
        </span>
      </TugListRow>
      <div className="jot-editor-well" ref={wellRef}>
        <TugMessageEditor
          ref={editorRef}
          value={jot.text}
          // Reopening the jot puts its chips back where they were — the atoms
          // were saved with the text, so there is something to put back.
          atoms={jot.atoms}
          placeholder="Type a jot…"
          // A transient, in-list editor — NOT the card's primary text surface.
          // Registering the card's engine hooks as it mounts / unmounts churns
          // the card's hooks set, which re-fires the card's `applyBagFocus`
          // restore and yanks the keyboard key view off the Jots list to the
          // card's own default on close. Opt out.
          suppressCardEngineHooks
          markdownTextStyling
          lineWrap
          fontSize="var(--tugx-jot-editor-font-size)"
          maxRows={120}
          // A file the jot cites is ⌘-clickable in place — the annotator's
          // gate, the annotator's gesture, in a buffer that is still editable.
          extensions={annotationLinks}
          // A pasted passage brings the project it was written against, and
          // the jot keeps it: this is the whole reason a relative path copied
          // out of a transcript still resolves here, in a card that is bound
          // to no session and belongs to no project.
          onPastedOrigins={(origins) => store.addJotOrigins(jot.id, origins)}
          onChange={onChange}
          onSubmit={onSubmit}
          aria-label="Jot text"
          data-testid="jot-editor-field"
        />
      </div>
    </div>
  );
}

/** The `"jot"` cell — one kind, branching display/editor on `editingId`.
 *  `selected` is the list-view-owned selection state; thread it to the display
 *  row so `TugListRow` paints its real selection fill (the picker look). */
const JotCell: TugListViewCellRenderer<JotsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<JotsDataSource>) => {
  const jot = dataSource.rowAt(index);
  const store = getJotsStore();
  const editingId = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().editingId,
  );
  return editingId === jot.id ? (
    <JotEditorRow jot={jot} store={store} />
  ) : (
    <JotDisplayRow jot={jot} selected={selected} />
  );
};

const JOTS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<JotsDataSource>
> = { jot: JotCell };

/**
 * The Jots card's content ([L25]: the pane owns geometry and chrome; this owns
 * the surface inside it).
 */
export function JotsContent({ cardId }: { cardId: string }): React.ReactElement {
  const { store, snapshot } = useJots();
  const jots = snapshot.doc.jots;
  const editingId = snapshot.editingId;
  // The filter is card-local and ephemeral ([L24]): it is a way of looking at
  // the list right now, not a preference the card should still be wearing the
  // next time it opens.
  const [filterQuery, setFilterQuery] = useState("");
  const dataSource = useJotsDataSource(jots, filterQuery, editingId);
  const filtering = filterQuery.trim().length > 0;
  // Content is what the list actually SHOWS — a card filtered to zero seeds no
  // cursor, exactly like an empty one. The filter field registers
  // independently, so it stays reachable.
  const hasContent = dataSource.numberOfItems() > 0;
  // …and what it holds BEFORE the filter, the separate question the filter
  // field's enablement turns on: a card filtered to zero still has items.
  const hasItems = dataSource.unfilteredCount() > 0;

  // A card with nothing in it holds no query either — otherwise the disabled
  // field's text and the list's actual filter drift apart while items are away.
  useLayoutEffect(() => {
    if (!hasItems) setFilterQuery("");
  }, [hasItems]);

  // Seed the opening key view onto the list, so the first arrival lands the
  // movement cursor on a real jot rather than on the card's chrome. Nothing to
  // seed while the list shows nothing: an empty list is not a focus stop, and
  // `useSeedKeyView` re-arms when one appears.
  useSeedKeyView(hasContent ? `${JOTS_FOCUS_GROUP}:0` : null);

  const listRef = useRef<TugListViewHandle>(null);
  const filter = useAttachedFilter(() => listRef.current);
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const focusManager = useFocusManager();

  // ArrowDown out of the filter field hands the key view to the list — the
  // field's advance contract, routed through the FocusManager ([L22]).
  const advanceToList = useCallback((): void => {
    focusManager?.place(
      cardId,
      { kind: "focus-key", focusKey: `${JOTS_FOCUS_GROUP}:0` },
      { modality: "keyboard" },
    );
  }, [focusManager, cardId]);

  // Descend into a row when it opens for editing ([P06]/[R01]): the editor cell
  // mounts in the same commit that set `editingId`; this parent layout effect
  // runs after the child editor has registered its focusable, so the descend
  // finds it. Guarded so it fires once per open (not on every keystroke).
  const prevEditingRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (editingId !== null && editingId !== prevEditingRef.current) {
      const index = dataSource.indexForId(editingId);
      if (index >= 0) listRef.current?.descendIntoRow(index);
    }
    prevEditingRef.current = editingId;
  }, [editingId, dataSource]);

  const initialSelectedIndex = useMemo(() => {
    if (lastSelectedJotId === null) return undefined;
    const i = dataSource.indexForId(lastSelectedJotId);
    return i >= 0 ? i : undefined;
    // Recompute when membership changes (the version bump re-runs on length).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, jots.length]);

  // The Things model on the list view's own `selectionRequired` shape: the list
  // owns a never-null selected row and stamps `data-selected`, so the REAL
  // `TugListRow` selection fill paints (the session-picker look — no hand-rolled
  // styling). A single click (`onSelect`) SELECTS + focuses the row but NEVER
  // opens it; the row OPENS only on Enter (`onActivate`, via `commitOnEnter`) or
  // a double-click (`onActivate`, via `activateOnDoubleClick`) — the first click
  // of the pair selects, the second opens. Both remember the jot for the
  // next Cmd-L / Tab seed ([P10]).
  const delegate = useMemo<TugListViewDelegate>(() => {
    const remember = (index: number): void => {
      const row = dataSource.rowAt(index);
      if (row !== undefined) lastSelectedJotId = row.id;
    };
    const open = (index: number): void => {
      const row = dataSource.rowAt(index);
      if (row === undefined) return;
      lastSelectedJotId = row.id;
      store.beginEdit(row.id);
    };
    return { onSelect: remember, onActivate: open };
  }, [dataSource, store]);

  // State-mirror for the list-view-owned selection ([L24]) — keep the remembered
  // jot id in step with the selection as it moves (seed, click).
  const onSelectionChange = useCallback(
    (index: number): void => {
      const row = dataSource.rowAt(index);
      if (row !== undefined) lastSelectedJotId = row.id;
    },
    [dataSource],
  );

  // Destructive-delete confirmation ([D15] controlled `TugConfirmPopover`): the
  // row ✕ opens the popover over itself instead of deleting immediately.
  // Local UI state ([L24]) — the pending row id + the anchor to point at.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    anchor: TugPopoverMeasurable;
  } | null>(null);

  // Delete `id` and land the cursor on the surviving neighbor (same index,
  // clamped) so the keyboard position never vanishes with the row. Shared by
  // the keyboard Delete verb and the row's pointer delete button.
  const deleteJotKeepingCursor = useCallback(
    (id: string): void => {
      const index = dataSource.indexForId(id);
      if (index < 0) return;
      const survivorCount = dataSource.numberOfItems() - 1;
      // The survivor is read from the PROJECTION before the delete — under a
      // filter the doc's neighbor is not the list's neighbor, and indexing the
      // doc by a list index would remember the wrong jot.
      const survivor = dataSource.rowAt(index + 1) ?? dataSource.rowAt(index - 1);
      store.deleteJot(id);
      if (survivorCount <= 0) return;
      const landing = Math.min(index, survivorCount - 1);
      if (survivor !== undefined) lastSelectedJotId = survivor.id;
      listRef.current?.moveCursorTo(landing);
    },
    [dataSource, store],
  );

  // Raise the confirm — or don't. The popover guards written words; an EMPTY
  // jot has none, so there is nothing to ask about and the question would only
  // be a second gesture on the way to the same place. Both delete routes (the
  // row's ✕ and the keyboard verb) come through here so the two cannot drift.
  const requestDeleteJot = useCallback(
    (id: string, anchor: TugPopoverMeasurable): void => {
      const index = dataSource.indexForId(id);
      const jot = index >= 0 ? dataSource.rowAt(index) : undefined;
      if (jot !== undefined && jot.text.trim().length === 0) {
        deleteJotKeepingCursor(id);
        return;
      }
      setPendingDelete({ id, anchor });
    },
    [dataSource, deleteJotKeepingCursor],
  );

  // Reorder by carrying the row: commit on drop ([Q02]). Rows are matched by
  // their stable `data-jot-id`; the FLIP animates the row content, the
  // store commit reorders the document.
  const { onRowPointerDown: beginRowReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () => snapshot.doc.jots.map((s) => s.id),
    commit: (order) => store.setOrder([...order]),
    selector: ROW_SELECTOR,
    kindAttr: ROW_KIND_ATTR,
    // The incipit is a native drag source into a session prompt, so the arm
    // must not cancel the press the browser starts that drag from.
    nativeDragSource: true,
    // Hand the keyboard to the row that was set down. A row's press normally
    // places it here itself; the drop swallows the trailing click so a carry
    // never reads as an activation, and this is that landing handed back.
    // Both registers move — the list takes the key view through `place()`
    // ([L22]), the movement cursor parks on the row — and the remembered
    // selection follows, so a later return to the card lands on the row the
    // user moved rather than on whatever it was before the drag.
    landKeyboard: (id) => {
      const index = dataSource.indexForId(id);
      if (index < 0) return;
      lastSelectedJotId = id;
      focusManager?.place(
        cardId,
        { kind: "focus-key", focusKey: `${JOTS_FOCUS_GROUP}:0` },
        { modality: "keyboard" },
      );
      listRef.current?.moveCursorTo(index);
    },
  });
  // Reorder is unavailable while a filter is active: the drop order the drag
  // computes describes the VISIBLE rows, and `store.setOrder` expects the whole
  // document — there is no coherent way to splice a partial order back in. The
  // gesture is simply never armed while the filter is on.
  const onRowPointerDown = useCallback(
    (id: string, event: React.PointerEvent): void => {
      if (filtering) return;
      beginRowReorder(id, event);
    },
    [filtering, beginRowReorder],
  );
  // ---- The row's context menu ----

  // The row a menu stands over wears the pointer's own graze for as long as
  // the menu is up, so the reader can still see which jot it is about once the
  // pointer has left the row to reach the menu. A DOM attribute and a CSS rule
  // ([L06]) — the mark is appearance, and routing it through React would
  // re-render every cell to paint one of them.
  const menuRowRef = useRef<HTMLElement | null>(null);
  const markMenuRow = useCallback((row: HTMLElement | null): void => {
    menuRowRef.current?.removeAttribute("data-menu-open");
    menuRowRef.current = row;
    row?.setAttribute("data-menu-open", "true");
  }, []);

  // The ✕'s column on the row holding `id` — the anchor the delete confirm
  // wants, found from the ROW rather than from the press. The menu's Delete is
  // the ✕'s act, so its question has to sit over the ✕ and not over wherever
  // the right-click happened to land (`accessoryColumnAnchor`). A row rendering
  // no verbs anchors on itself, the same fallback the keyboard verb takes.
  const anchorForJot = useCallback((id: string): TugPopoverMeasurable | null => {
    const row = listWrapRef.current?.querySelector<HTMLElement>(
      `.jot-row-content[data-jot-id="${CSS.escape(id)}"]`,
    );
    const cell = row?.closest(".tug-list-view-cell");
    if (!(cell instanceof HTMLElement)) return null;
    const button = cell.querySelector(".jot-row-delete");
    return button instanceof HTMLElement
      ? accessoryColumnAnchor(cell, button)
      : cell;
  }, []);

  const rowMenu = useJotRowMenu({
    onEdit: (jot) => {
      lastSelectedJotId = jot.id;
      store.beginEdit(jot.id);
    },
    onCreateBelow: (jot) => store.createJot(jot.id),
    // Through `requestDeleteJot`, never around it: the confirm, the
    // empty-jot carve-out, and the cursor landing are all on that one path.
    onRequestDelete: (jot) => {
      const anchor = anchorForJot(jot.id);
      if (anchor !== null) requestDeleteJot(jot.id, anchor);
    },
    // Cut's second half. No confirm — see `jot-row-menu`.
    onDelete: (jot) => deleteJotKeepingCursor(jot.id),
    onReplace: (jot, paste) => {
      store.updateJot(jot.id, paste.text, paste.atoms);
      // The roots the pasted text was read against, ADDED to whatever the jot
      // already carried: a jot pasted into twice from two projects is about
      // both, which is the whole reason `origins` is a list.
      if (paste.origins.length > 0) store.addJotOrigins(jot.id, paste.origins);
    },
    onClose: () => markMenuRow(null),
  });

  const onRowContextMenu = useCallback(
    (jot: Jot, event: React.MouseEvent): void => {
      event.preventDefault();
      // Claimed, not merely handled: the row is inside the card's own
      // right-click ground, and a press that only suppressed the native menu
      // would open this one under whatever claims the card.
      event.stopPropagation();
      markMenuRow(event.currentTarget as HTMLElement);
      // Carry the movement cursor to the row the menu names, so the keyboard
      // and the menu can never be pointed at two different jots.
      const index = dataSource.indexForId(jot.id);
      if (index >= 0) {
        lastSelectedJotId = jot.id;
        listRef.current?.moveCursorTo(index);
      }
      rowMenu.openAt(jot, event.clientX, event.clientY);
    },
    [dataSource, markMenuRow, rowMenu],
  );

  const cellContext = useMemo<JotsCellContextValue>(
    () => ({
      onRowPointerDown,
      onRequestDelete: requestDeleteJot,
      onRowContextMenu,
      filterQuery,
    }),
    [onRowPointerDown, requestDeleteJot, onRowContextMenu, filterQuery],
  );

  // The keyboard's current row — the movement cursor's cell (`data-key-cursor`),
  // projected by the engine ([L06]). In `selectionRequired` mode a click also
  // commits selection here, so the cursor row and the selected (`data-selected`)
  // fill coincide under the pointer; the section verbs (create-below / delete)
  // act on the cursor row.
  const cursorCell = useCallback(
    (): HTMLElement | null =>
      listWrapRef.current?.querySelector<HTMLElement>("[data-key-cursor]") ?? null,
    [],
  );
  const cursorJotId = useCallback((): string | null => {
    const idxAttr = cursorCell()?.getAttribute("data-tug-list-cell-index");
    if (idxAttr === null || idxAttr === undefined) return null;
    const idx = Number.parseInt(idxAttr, 10);
    // A list index names a row in the PROJECTION, never a position in the doc.
    return dataSource.rowAt(idx)?.id ?? null;
  }, [cursorCell, dataSource]);

  // Section verbs — Space / ⌘N create a new jot below the cursor (the
  // Things-style gesture), Delete removes the cursor row. Delivered through
  // the list's key-view delegate (`onKeyViewKey` — the [P05] channel): in
  // engine-routed mode keydown lands on the key sink, never in this
  // subtree, so a bubble-phase container `onKeyDown` is structurally dead.
  // The list reserves Space via `captureKeys` (otherwise it would resolve
  // to the item-container select before reaching this delegate). Only in
  // list mode; the editor owns keys while open (dom-granted — the delegate
  // never fires — plus the `editingId` guard for the descended-scope
  // fallback delivery).
  const onCardKeyViewKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (editingId !== null) return false; // the editor owns keys while open
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // `createJot(afterId)` inserts after `afterId` and opens the new
        // row for editing (its descend effect focuses the caret). A null
        // cursor (empty list / no landing) appends at the end.
        store.createJot(cursorJotId());
        return true;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        const id = cursorJotId();
        const cell = cursorCell();
        if (id === null || cell === null) return false;
        // Destructive — raise the SAME confirm popover the mouse ✕ does, over the
        // cursor row's ✕: the key cursor reveals the trailing accessory, so the
        // keyboard sees the popover point at the same control the pointer would
        // have pressed. Without a ✕ to find (a row rendered with no verbs), the
        // row itself is the anchor. Confirm deletes, keeping the cursor on a
        // neighbor.
        const button = cell.querySelector(".jot-row-delete");
        requestDeleteJot(
          id,
          button instanceof HTMLElement
            ? accessoryColumnAnchor(cell, button)
            : cell,
        );
        return true;
      }
      return false;
    },
    [editingId, store, cursorJotId, cursorCell, requestDeleteJot],
  );
  // ⌘/⌃ chords never reach the key-view delegate (they belong to the
  // bindings tier), so the old ⌘N-in-list-mode alias does not ride it;
  // Space and the band's + button are the create gestures.

  // ⌘Z / ⇧⌘Z route through the responder chain as UNDO/REDO. Handle them only
  // in list mode: while editing, omit the handlers so the chain walks past to
  // the editor's own undo responder ([the KeyZ binding does not preventDefault]).
  const responderId = useId();
  const responderActions = useMemo(
    () =>
      editingId === null
        ? {
            [TUG_ACTIONS.UNDO]: () => store.undo(),
            [TUG_ACTIONS.REDO]: () => store.redo(),
          }
        : undefined,
    [editingId, store],
  );
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: responderActions,
  });

  // The card's own root, kept alongside the chain registration: the delete
  // confirm names it as its collision boundary. Anchored over the ✕ the popover
  // sits at the card's trailing edge, and an unbounded shift would let it spill
  // onto whatever card is next door — leaving which row it is asking about
  // ambiguous. Bounded, it slides back inside and keeps its arrow on the ✕.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const attachCardRoot = useCallback(
    (el: HTMLDivElement | null): void => {
      cardRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  return (
    <ResponderScope>
      <div
        ref={attachCardRoot}
        className="jots-card"
        data-testid="jots-card"
        data-jots-card-id={cardId}
        // Focusable root so `transferFocusForActivation` → `applyBagFocus` has
        // a target to land the ring on when the card is focused.
        tabIndex={-1}
      >
        {/* The content element ([B01]): the toolbar and the list as one
            in-flow column. Its border-box height is what the rail measures,
            and nothing above it inside the scroller stretches, so the pane's
            run cannot move it ([B02]). */}
        <div
          className="jots-card-content"
          data-testid="jots-card-content"
          data-card-content=""
        >
        <JotsToolbar
          query={filterQuery}
          onQueryChange={setFilterQuery}
          populated={hasItems}
          onAdvance={advanceToList}
          filter={filter}
        />
        {snapshot.error !== null ? (
          <div className="jots-error" role="status">
            Jots are read-only: {snapshot.error}
          </div>
        ) : null}
        {jots.length === 0 ? (
          // Empty label instead of the list — an empty `flex: 1` list would
          // grow and open a gap under the toolbar.
          <div className="jots-empty">None</div>
        ) : dataSource.numberOfItems() === 0 ? (
          // Distinct from "None": there ARE jots, the filter is hiding them.
          <div className="jots-empty" data-testid="jots-no-matches">
            No matches
          </div>
        ) : (
          <div
            className="jots-list-wrap"
            ref={listWrapRef}
            data-filter-active={filtering ? "true" : undefined}
          >
            <BlockDropCaret ref={caretRef} />
            <JotsCellContext value={cellContext}>
              <TugListView<JotsDataSource>
                ref={listRef}
                dataSource={dataSource}
                delegate={delegate}
                cellRenderers={JOTS_CELL_RENDERERS}
                scrollKey="jots-card"
                inline
                rowLayout="flush"
                focusGroup={hasContent ? JOTS_FOCUS_GROUP : undefined}
                commitOnEnter="act"
                activateOnDoubleClick
                selectionRequired
                selectionFollowsCursor
                captureKeys={JOTS_CAPTURE_KEYS}
                onKeyViewKey={onCardKeyViewKey}
                attachedFilter={filter}
                onSelectionChange={onSelectionChange}
                initialSelectedIndex={initialSelectedIndex}
                {...RAIL_LIST_PRESENTATION}
                className="jots-list"
              />
            </JotsCellContext>
          </div>
        )}
        </div>
        {/* One controlled confirm popover serves every row — it sits over the ✕
            the question is about and points down at it, anchored to the ✕'s
            COLUMN measured off the row rather than to the hover-revealed button
            itself, which collapses under its own popover
            (`accessoryColumnAnchor`). Confirm deletes (keeping the cursor on a
            surviving neighbor); cancel / outside-click / Escape dismisses. */}
        <TugConfirmPopover
          open={pendingDelete !== null}
          anchorEl={pendingDelete?.anchor ?? null}
          message="Delete this jot?"
          confirmLabel="Delete"
          confirmRole="danger"
          side="top"
          align="center"
          collisionBoundary={cardRef.current}
          collisionPadding={6}
          arrow
          onConfirm={() => {
            if (pendingDelete !== null) deleteJotKeepingCursor(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
        {/* One menu serves every row, beside the one confirm that already
            does: the target is the jot the press landed on, so a menu per row
            would be as many idle portals as there are jots. */}
        {rowMenu.menu}
      </div>
    </ResponderScope>
  );
}
