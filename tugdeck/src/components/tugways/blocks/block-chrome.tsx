/**
 * `BlockChrome` — shared header/footer frame around Layer-2
 * tool blocks.
 *
 * Per [D05]'s two-layer hybrid architecture and [Spec S03]'s
 * tool-block contract, every per-tool block composes:
 *
 *   1. A chrome frame (this component) — header (icon + tool name +
 *      args summary), optional footer (badges), optional inline
 *      caution badge, status-aware styling. Token vocabulary:
 *      `--tugx-block-*`.
 *   2. A body kind — `TerminalBlock`, `DiffBlock`, `FileBlock`, etc.
 *      Token vocabulary: `--tugx-{term,diff,file,…}-*`.
 *
 * The chrome's job is to give every tool a consistent frame so the
 * user can scan the transcript and spot tool calls at a glance.
 * Per-tool blocks handle the body composition and the
 * tool-specific bits (e.g., the shell-syntax-highlighted command on
 * `BashToolBlock`).
 *
 * Status states map to the [Spec S03] `ToolBlockStatus` enum. The
 * header's lifecycle dot is the single status signal (the Quiet Line) —
 * there is no stripe; the chrome frame is uniform across states:
 *
 *   - `streaming` — the tool input is partial; the wrapper passes an
 *     empty body (`null`) into `children`. The header dot pulses
 *     in-flight — the single streaming signal ([D02]). (The Agent
 *     block fills the window with real child blocks as they stream.)
 *   - `ready`    — steady-state render. The dot reads success.
 *   - `error`    — `tool_result.is_error === true`. The header's
 *     lifecycle dot reads danger; everything else (name, result, body)
 *     stays neutral — the dot is the only red. Consumers pass a `notice`
 *     (tone `error`) so the failure is readable WITHOUT expanding.
 *
 * ## Notice band — collapse-independent explanation
 *
 * Between the header and the body the chrome renders an optional
 * {@link BlockNoticeBand} from the `notice` prop. Unlike the body it
 * sits OUTSIDE the collapse guard, so a one-to-three-line explanation
 * (a failed command's first error line, a warning, an info note) stays
 * visible while collapsed — the common case for transcript history. It is
 * general, not error-only: the tone selects the icon. The full detail still
 * lives in the body, one expand away.
 *
 * `caution` is rendered as an inline `SessionCautionBadge` in the header
 * per [D04] / [Q03] — three reasons surface: `unknown_tool`,
 * `unknown_shape`, `version_drift`. The chrome owns only the
 * placement; the chip is `chrome/session-caution-badge.tsx`.
 *
 * ## Actions slot — body-kind affordance host
 *
 * The chrome's header carries an actions target at its trailing edge:
 * `<div data-slot="tool-block-actions">`. It is exposed to descendants
 * via the `ChromeActionsTargetContext` so a body kind composed inside
 * (under `embedded={true}`) can `createPortal` its resting affordances
 * (Find trigger, Copy, view-mode toggle, fold cue) into the chrome header
 * itself. Per [L20] the chrome owns only the SLOT (a placeholder div with
 * layout-only styling); the affordances inside the slot are React-rendered
 * by the body kind and carry the body kind's tokens. Standalone callers
 * (gallery, RenderInput-routed) get a null context value and render
 * affordances in their own identity header.
 *
 * Why a portal and not a `headerActions` prop: the affordance state
 * (find session, view-mode toggle, fold collapsed-set) is owned by the
 * body kind. Hoisting that state to the wrapper level so the wrapper
 * could pass `headerActions` would invert the data flow and require
 * every wrapper to re-implement the affordance UI. The portal lets the
 * body kind keep all state local while still placing the rendered
 * affordance node inside the chrome's header in the DOM tree — exactly
 * where it needs to sit for layout, sticky-pin coverage, and accessibility.
 *
 * ## Copy — for `body-bits/` wrappers
 *
 * Body-bits wrappers (`SkillToolBlock`, `MonitorToolBlock`,
 * `WorktreeToolBlock`, `TaskMgmtToolBlock`) don't compose an embedded
 * body kind. They pass `copyText` so the HEADER's built-in Copy writes
 * their tailored payload; folding is the header's whole-block chevron
 * (every block is collapsible), so they need nothing else.
 *
 * Laws:
 *  - [L06] all visible state lives on data attributes / class
 *    swaps; the chrome never renders prose into React state.
 *  - [L19] component-authoring guide — `.tsx` + `.css` pair,
 *    module docstring, exported props interface,
 *    `data-slot="tool-block-chrome"` on the root.
 *  - [L20] component-token sovereignty — the chrome owns the
 *    `--tugx-block-*` slot family. Body kinds composed inside
 *    keep their own `--tugx-{kind}-*` tokens; chrome rules never
 *    reach into them.
 *
 * @module components/tugways/blocks/block-chrome
 */

import "./block-chrome.css";

import React from "react";

import { cn } from "@/lib/utils";
import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import { BlockFoldSuppressedContext } from "@/components/tugways/body-kinds/affordances";

import { ToolBlockCollapseContext, ToolUseIdContext } from "./collapse-context";
import { BlockHeader } from "./block-header";
import type { BlockAltitude } from "./block-strip";
import { BlockNoticeBand, type BlockNotice } from "./block-notice";
import type { ToolResultSummary } from "./tool-result-summary";
import type { CautionFlag, ToolBlockStatus } from "./types";

/**
 * Map the chrome's body-composition `status` onto a header-dot
 * {@link ToolCallPhase} when the wrapper hasn't passed a richer
 * `phase`. `streaming → in_flight`, `ready → success`, `error →
 * error`. The `awaiting` and `interrupted` readings can't be derived
 * from `status` alone — a wrapper (or the dispatch, #step-6) supplies
 * those via the explicit `phase` prop, which always wins.
 */
function statusToPhase(status: ToolBlockStatus): ToolCallPhase {
  switch (status) {
    case "streaming":
      return "in_flight";
    case "error":
      return "error";
    case "ready":
    default:
      return "success";
  }
}

/**
 * Context exposing the chrome's actions-slot DOM node to descendants.
 * Body kinds nested under a `BlockChrome` (typically with
 * `embedded={true}`) read this and portal their resting affordances
 * into the slot, so the chrome header carries the icon row at its
 * trailing edge without the chrome needing to know what affordances
 * exist. The value is `null` when no chrome is above — standalone
 * callers detect that and render affordances in their own header.
 */
const ChromeActionsTargetContext = React.createContext<HTMLDivElement | null>(
  null,
);

/**
 * Read the chrome actions target from context. Returns `null` when the
 * caller renders outside a `BlockChrome` (standalone composition).
 * Body kinds key their "portal or render inline" branch on the truthiness
 * of this value combined with their own `embedded` prop.
 */
export function useChromeActionsTarget(): HTMLDivElement | null {
  return React.useContext(ChromeActionsTargetContext);
}

/**
 * The block-variant vocabulary — the shared contract every block surface
 * keys on. `BlockChrome` (this React frame) implements `tool` and `receipt`:
 * the same dot/identity/trailing-actions header, restyled via
 * `[data-variant]`. The `note` (Thinking) and `data` (markdown-table)
 * surfaces adopt the SAME contract — the `--tugx-block-*` token scope under
 * `[data-variant="…"]`, the collapse/affordance shapes, and the
 * `data-variant` attribute — from their own roots, rather than rendering
 * through `BlockHeader`. A frame-level change therefore lands across all four
 * without one component carrying every variant's structure.
 */
export type BlockVariant = "tool" | "receipt" | "note" | "data";

export interface BlockChromeProps {
  /**
   * Canonical tool name as it should display in the header (e.g.
   * "Bash"). Wrappers pass the wire-shape `toolName` after any
   * casing normalization they prefer. Optional: a verb-less block (a
   * changeset file row) omits it, so the header renders no name span and
   * the identity leads the row.
   */
  toolName?: string;
  /**
   * Accessible name for the row when `toolName` is deliberately omitted.
   * Forwarded verbatim to {@link BlockHeader}, where `ariaSubject` resolves
   * `toolName ?? ariaName ?? "block"` for the copy and fold affordances. A
   * block that seats its name inside the identity run rather than the strip's
   * name slot (the session boundary) passes it here.
   */
  ariaName?: string;
  /**
   * Leading glyph rendered in the header's leftmost slot IN PLACE of the
   * lifecycle dot (a changeset file row's commit checkbox). Forwarded to
   * {@link BlockHeader}; when absent the lifecycle dot renders as usual.
   */
  leading?: React.ReactNode;
  /**
   * Visual variant of the frame. `BlockChrome` renders the `tool` (default)
   * and `receipt` shapes — same header structure, restyled via
   * `[data-variant]`. The broader {@link BlockVariant} contract also covers
   * `note` / `data`, but those live on their own roots, so this prop only
   * accepts what the chrome itself renders. Stamps `data-variant` on the root
   * so CSS can scope the `--tugx-block-*` overrides.
   */
  variant?: "tool" | "receipt";
  /**
   * Altitude tier for the header shell ([P03]), forwarded to
   * {@link BlockHeader} → {@link BlockStrip} as `data-altitude`. `leaf`
   * (default) is the tool-call header, pixel-unchanged; a session-entry card
   * passes `entry` for a marginally roomier strip. `section` is the rail band
   * (composed directly on `BlockStrip`, not through the chrome).
   */
  altitude?: BlockAltitude;
  /**
   * Args summary — typically the most-relevant single field of the
   * tool input rendered as a one-liner (e.g. the shell command, the
   * file path being read). Wrappers pass a `<code>` element for
   * mono-styling; the chrome treats it opaquely.
   */
  argsSummary?: React.ReactNode;
  /**
   * Single-row identity content for the header (a path atom-chip, a
   * short label). When omitted, the chrome falls back to `argsSummary`
   * for back-compat — wrappers migrate to passing `identity` + `command`
   * + `meta` explicitly (#step-7 onward). Sits on the identity row and
   * ellipsizes there.
   */
  identity?: React.ReactNode;
  /**
   * Command-shaped args rendered on their own wrapping row. For bash
   * commands, grep patterns, cron expressions. Omit for chip-identity
   * tools. A long command (or any text target) clamps to
   * `--tugx-toolheader-clamp-lines` while collapsed when the wrapper tags
   * its text node with `tool-call-header-clamp`; expanding shows the whole
   * command above the body ([D05], nothing is lost).
   */
  command?: React.ReactNode;
  /**
   * The call's one-line result as DATA — the trailing-info element, rendered
   * quietly (plain muted text) in BOTH states. Tools supply it so collapsed
   * and expanded read identically. Pass a list to report more than one fact
   * (a commit's `5 files │ +39 −17`); each renders as its own pipe-section.
   * See {@link ToolResultSummary}.
   */
  resultSummary?: ToolResultSummary | readonly ToolResultSummary[];
  /** Lifecycle state per Spec S03's `ToolBlockStatus`. */
  status?: ToolBlockStatus;
  /**
   * Header-dot lifecycle phase ([D03]). When omitted, the chrome
   * derives it from `status` via `statusToPhase` — so the dot lights up
   * on every block without a wrapper change. A wrapper (or the dispatch,
   * #step-6) passes the richer phase to express `awaiting` /
   * `interrupted`, which `status` alone can't.
   */
  phase?: ToolCallPhase;
  /** Drift caution surfaced as an inline badge in the header. */
  caution?: CautionFlag;
  /**
   * Footer badges — exit code, duration, interrupted, etc.
   * Rendered in a flex row at the bottom of the chrome. Empty /
   * undefined skips the footer entirely.
   */
  footerBadges?: React.ReactNode;
  /**
   * Optional notice band — a one-to-three-line explanation rendered between
   * the header and the body in BOTH collapse states (so it's readable while
   * collapsed). Tones: `error` (a failure's first line / message), plus
   * `warning` / `info` / `success` for non-error notes. See
   * {@link BlockNotice}.
   */
  notice?: BlockNotice;
  /**
   * Body content — typically a body-kind component
   * (`TerminalBlock`, `DiffBlock`, etc.). The chrome hosts it
   * inside a region with `data-slot="tool-block-body"`.
   */
  children: React.ReactNode;
  /**
   * `data-slot` on the root. Per Spec S03, every wrapper's root
   * carries `data-slot="<tool>-tool-block"`. The chrome accepts an
   * override here so `BashToolBlock` can stamp
   * `data-slot="bash-tool-block"` on its root without the chrome
   * needing to know about Bash specifically.
   *
   * @default "tool-block-chrome"
   */
  rootSlot?: string;
  /**
   * Copy payload for the header's built-in Copy. A wrapper passes its
   * tailored result text (e.g. the formatted task list, the monitor tail)
   * and the header's Copy writes it in both states; when omitted the
   * header falls back to the collapse handle's command+result markdown.
   */
  copyText?: string | (() => string);
  /**
   * Wrapper-supplied affordance(s) rendered in the header's actions slot,
   * LEFT of the chrome-owned Copy + chevron (the same slot embedded body
   * kinds portal their controls into). For a host-specific gesture that
   * belongs beside Copy — e.g. the shell exchange row's Share ([D111]).
   * Rendered in the expanded state only, matching the body-affordance slot;
   * a bodyless chrome (not collapsible) shows it always.
   */
  headerActions?: React.ReactNode;
  /**
   * Wrapper-supplied affordance(s) on the header's trailing edge, RIGHT of the
   * chrome-owned Copy — where the whole-block chevron sits. For a block that
   * discloses part of its OWN body, as distinct from the transcript's
   * whole-block collapse. Visible in both states. No block uses this today.
   */
  headerActionsTrailing?: React.ReactNode;
  /**
   * Force the block expanded and the whole-block chevron disabled,
   * overriding the history-collapse handle WITHOUT swapping the wrapper.
   * The wrapper (`ToolBlockHistoryCollapse`) stays mounted — only its
   * effective collapsed view is pinned open here — so a block that must
   * not be foldable while it owns a blocking interaction (the live
   * `AskUserQuestion` wizard) can't be collapsed away, and mount identity
   * holds across the lifecycle ([L26]). Default `false`.
   */
  forceExpanded?: boolean;
  /** Forwarded class name. */
  className?: string;
}

export const BlockChrome: React.FC<BlockChromeProps> = ({
  toolName,
  ariaName,
  leading,
  argsSummary,
  identity,
  command,
  resultSummary,
  status = "ready",
  phase,
  caution,
  footerBadges,
  notice,
  variant = "tool",
  altitude = "leaf",
  children,
  rootSlot = "tool-block-chrome",
  copyText,
  headerActions,
  headerActionsTrailing,
  forceExpanded = false,
  className,
}) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  // History-collapse handle ([P02]). Non-null when a
  // `ToolBlockHistoryCollapse` wraps this block — which the transcript now
  // does for EVERY tool, so every block is collapsible. While
  // block-collapsed the body subtree is NOT mounted (the header is the
  // whole block) and the footer/error bands are withheld with it. The
  // chrome's own mount identity is untouched across the toggle ([L26]);
  // only the child subtree appears/disappears.
  const blockCollapse = React.useContext(ToolBlockCollapseContext);
  // `forceExpanded` pins the view open without touching the wrapper's own
  // collapsed boolean (so the wrapper stays mounted, [L26]); the chevron
  // is disabled below so the user can't fold a blocking interaction away.
  const blockCollapsed =
    !forceExpanded && blockCollapse !== null && blockCollapse.collapsed;
  // The id for `data-tool-use-id`: the collapse handle when wrapped,
  // else the dispatch-level context the transcript provides around
  // every top-level tool — so the attribute is present on every tool
  // root, not just collapsed ones ([P01]).
  const toolUseIdFromContext = React.useContext(ToolUseIdContext);
  const toolUseId = blockCollapse?.toolUseId ?? toolUseIdFromContext ?? undefined;
  // The actions-slot target is a real DOM node that descendants portal
  // into. Tracking it in React state (rather than a ref alone) so the
  // context value re-publishes once the node mounts — the body kind's
  // `createPortal` call on its first render-after-mount will then find
  // a non-null target. Stale-null reads can't happen because the body
  // kind re-renders whenever the chrome's render does.
  const [actionsTarget, setActionsTarget] =
    React.useState<HTMLDivElement | null>(null);

  // Telescoping pin support — write the live measured chrome-header
  // height into `--tugx-block-header-height` on the chrome root so
  // a body-kind actions row inside can pin at
  // `top: calc(var(--tugx-pin-stack-top, 0) + var(--tugx-block-header-height, 0))`
  // and telescope cleanly under the identity header. Mirrors the
  // entry-header → block-header relationship one level deeper.
  //
  // [L03] `useLayoutEffect` so the variable is written before paint —
  // an inner actions row reading the variable in its first sticky
  // pass gets the correct offset rather than a one-frame-late value.
  // [L06] DOM write, never React state — appearance flows through
  // CSS variables, not re-renders.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const header = headerRef.current;
    if (root === null || header === null) return;

    const write = (px: number): void => {
      root.style.setProperty("--tugx-block-header-height", `${px}px`);
    };

    // NOTE: no synchronous `write(header.offsetHeight)` seed here. That
    // forced layout read, run in EVERY tool block's mount
    // `useLayoutEffect` and interleaved with the `setProperty` write,
    // makes an all-rich transcript mount O(n²): a dev session has 2000+
    // tool blocks, and each read forces a full reflow of the growing
    // document the previous block's write just dirtied (measured: the
    // dominant cost of a ~14s, 212-row mount). The `ResizeObserver`
    // below fires an initial callback on `observe()` with the real
    // height — rAF-coalesced, so all blocks' writes batch into one
    // reflow — and consumers read `var(--tugx-block-header-height,
    // 0)` for the one frame before it lands (nothing is scrolled at
    // mount, so the pin offset is unobservable until then).

    // Coalesce the callback write via rAF to avoid "ResizeObserver loop
    // completed with undelivered notifications" — the write sets a CSS
    // var consumed by sticky descendant chrome, whose relayout can queue
    // a sibling observer notification within the same delivery pass.
    let rafId = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      // `borderBoxSize` is preferred — it reports the box-model height
      // the browser actually laid out, matching `offsetHeight`. Fall
      // back to `contentRect` for older WebKit if needed.
      const boxes = entry.borderBoxSize;
      const next =
        boxes !== undefined && boxes.length > 0
          ? boxes[0].blockSize
          : entry.contentRect.height;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        write(next);
      });
    });
    observer.observe(header);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
    // Re-measure across a collapse toggle: the one `BlockHeader` keeps
    // its `headerRef` in both states, but its height changes when the body
    // appears/disappears, so the observer re-runs to refresh the
    // telescoping-pin variable once the block opens or closes.
  }, [blockCollapsed]);

  // ONE header for every tool, in every state — the Quiet Line
  // `BlockHeader`. There is no fork: the same component renders whether
  // the block is collapsed (header is the whole block), expanded (header
  // above the mounted body), or a tool that never collapses (no chevron).
  // `disclosure` is non-null only for history-collapse-wrapped blocks
  // ([P06] table); it drives the chevron + collapsed/expanded presentation.
  // The body's own self-fold is suppressed for those blocks so the header
  // chevron is the single fold (no double-dip). No left-edge status stripe
  // anywhere — the lifecycle dot carries status.
  // A block is expandable only if expanding would reveal something: a body
  // (`children`) or footer badges. The notice band lives OUTSIDE the collapse
  // guard (visible in both states), so it does NOT count. When neither is
  // present — e.g. an errored Edit whose body is `null`, its message carried
  // by the always-visible notice — the whole-block chevron has nothing to
  // show, so it renders disabled (visible, non-interactive).
  const hasBody =
    children !== null && children !== undefined && children !== false;
  const hasExpandableContent = hasBody || footerBadges !== undefined;
  const disclosure =
    blockCollapse !== null
      ? {
          // `forceExpanded` pins the chevron to the expanded pose and
          // disables it — the block can't be folded while it owns a
          // blocking interaction.
          collapsed: forceExpanded ? false : blockCollapse.collapsed,
          onToggle: blockCollapse.toggle,
          disabled: forceExpanded || !hasExpandableContent,
        }
      : undefined;

  return (
    <div
      ref={rootRef}
      data-slot={rootSlot}
      data-variant={variant}
      data-caution={caution?.reason ?? undefined}
      data-block-collapsed={blockCollapsed ? "true" : undefined}
      data-empty-body={hasExpandableContent ? undefined : "true"}
      data-tool-use-id={toolUseId}
      className={cn("tool-block-chrome", className)}
    >
      <BlockHeader
        ref={headerRef}
        altitude={altitude}
        phase={phase ?? statusToPhase(status)}
        toolName={toolName}
        ariaName={ariaName}
        leading={leading}
        target={command ?? identity ?? argsSummary}
        summary={resultSummary}
        caution={caution}
        // The header owns Copy in both states. Prefer a wrapper's tailored
        // `copyText` (body-bits wrappers compute a formatted payload); fall
        // back to the collapse handle's command+result markdown.
        copyText={copyText ?? blockCollapse?.copyText}
        disclosure={disclosure}
        actions={headerActions}
        actionsTrailing={headerActionsTrailing}
        actionsSlotRef={setActionsTarget}
      />
      {/* The notice band sits OUTSIDE the collapse guard — between the header
          and the body — so a short explanation stays readable while
          collapsed. The full detail lives in the body below. */}
      {notice !== undefined ? <BlockNoticeBand {...notice} /> : null}
      {blockCollapsed ? null : (
        <BlockFoldSuppressedContext.Provider value={blockCollapse !== null}>
          {/* Mounted only when a body exists — an empty region under the
              header would still claim the header's bottom divider and
              paint a stray hairline (see [data-empty-body] in the CSS). */}
          {hasBody ? (
            <div className="tool-block-chrome-body" data-slot="tool-block-body">
              <ChromeActionsTargetContext.Provider value={actionsTarget}>
                {children}
              </ChromeActionsTargetContext.Provider>
            </div>
          ) : null}
          {footerBadges !== undefined ? (
            <div className="tool-block-chrome-footer" data-slot="tool-block-footer">
              {footerBadges}
            </div>
          ) : null}
        </BlockFoldSuppressedContext.Provider>
      )}
    </div>
  );
};
