/**
 * `FileBlock` — Layer-1 body kind for read-only file viewing.
 *
 * A thin chrome around `TugCodeView`. FileBlock owns the framed look
 * (header strip with path / language pill / line counts / `Search` and
 * `Collapse` icon buttons), the long-file collapse-by-default behavior,
 * the embedded-mode variant for `ReadToolBlock` composition, and
 * nothing else. The CM6 substrate that actually renders the file
 * lives in `TugCodeView`; the bespoke per-line renderer that this
 * file used to ship was retired because it reimplemented features
 * the project already owns through `tug-text-editor`'s CM6
 * integration — and reimplemented them badly (per-line scrollbars,
 * stale search overlay, parallel-engine drift).
 *
 * Composition:
 *  - Header (chrome strip) — `path basename` + optional language pill
 *    + "N lines" / "Showing N of M lines" counts + a trailing
 *    affordances area (fold cue + `Search` `<TugIconButton>`). Hidden
 *    when `embedded=true` because the host wrapper (e.g.
 *    `BlockChrome`) owns identity in those cases; the affordances
 *    portal into the host's actions slot instead so they survive into
 *    the embedded composition.
 *  - Fold cue — a chevron `<button>` rendered whenever the file is
 *    `overThreshold`, in both states. Icon + label swap by state
 *    (chevron-down + "N lines folded" vs chevron-up icon-only). This
 *    is the persistent toggle handle: embedded-mode hosts hide the
 *    header, so the cue must also portal into the host's actions slot
 *    or the user could expand but not collapse back.
 *  - Body — `<TugCodeView>` (expanded) or nothing (collapsed). CM6
 *    isn't mounted while collapsed so a huge file doesn't pay the
 *    mount cost until the user reveals it.
 *
 * Long-file collapse:
 *  - Lines above `collapseThreshold` (default 80, per audit §5.1) fold
 *    by default. The fold cue invites the user to reveal. The
 *    threshold is visual policy; the audit measured Read P50 at 50
 *    lines, so the 80-line threshold catches the upper ~40% — long
 *    enough to scan-or-skip, short enough not to fold the average
 *    file.
 *  - The fold cue (`BlockFoldCue`) releases the host scroller's
 *    follow-bottom lock via `useScroller().disengage` *before* the
 *    React state update. A host like `TugListView` publishes the
 *    `Scroller` façade and the call flips its `isFollowingBottom` to
 *    false, so the ResizeObserver flush triggered by the cell-height
 *    change finds `shouldAutoPin` false and does not call
 *    `pinToBottom`. Without this, expanding a file inside a
 *    `followBottom` list scrolls the cue off-screen — violating
 *    "interacting with a control does not move that control out of
 *    view."
 *
 * Embedded mode:
 *  - `embedded=true` drops the standalone frame (background, border,
 *    radius, outer margin) and the header strip. The host wrapper
 *    owns identity and affordances. CM6 still renders the body, so
 *    the embedded host gets line wrapping + selection for free.
 *
 * What this body kind does NOT do (and never will):
 *  - Render text with a bespoke DOM tree. CM6 is the canonical text
 *    engine for any file-based content (`tuglaws/component-authoring.md`
 *    §Text content); FileBlock composes the substrate, not bytes.
 *  - Implement its own find / Cmd-F bar. A card has at most one
 *    text-entry surface, and for a session card that is the
 *    `tug-prompt-entry` — never a per-block find widget. The
 *    `TugCodeView` substrate still carries the dormant
 *    `@codemirror/search` plumbing for the future Find redesign,
 *    but FileBlock drives no find UI.
 *  - Implement click-line-to-copy. CM6's native selection + Cmd-C
 *    handles region copy more naturally and consistently across the
 *    rest of the codebase. (The bespoke per-line click gesture used
 *    to exist; it has been retired with the rest of the bespoke
 *    renderer.)
 *  - Implement syntax highlighting. The substrate is wired today
 *    with the prop, and a follow-up step bridges Shiki (or a
 *    Lezer-based grammar) into CM6 decorations without changing
 *    this file's API.
 *
 * Laws:
 *  - [L06] all FileBlock-visible state (collapse) lives in React
 *    state because it controls *what* is rendered (one of two
 *    branches), not *how* a rendered element looks. The substrate's
 *    own appearance state lives in CM6 per its module docstring.
 *  - [L11] FileBlock owns no responder. The `TugCodeView` substrate
 *    registers its own selection-only responder (`copy` /
 *    `selectAll`); FileBlock just composes it.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="file-body"` on the root, this docstring.
 *  - [L20] component-token sovereignty — owns the `--tugx-file-*`
 *    slot family; consumes `--tugx-block-*` directly for the shared
 *    block-surface scaffold. Position-coordination tokens
 *    (`--tugx-pin-stack-top`, `--tugx-block-header-height`) are
 *    read but never overridden, per the L20 carve-out documented in
 *    `tuglaws/component-authoring.md`.
 *
 * Decisions:
 *  - [D05] two-layer split: body kind (this file) vs. tool block
 *    (`read-tool-block.tsx`).
 *  - CM6 is the canonical engine for file-based text content
 *    (`tuglaws/component-authoring.md` §Text content).
 *
 * @module components/tugways/body-kinds/file-block
 */

import "./file-block.css";

import React from "react";
import { createPortal } from "react-dom";
import type { SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  useFindTargetRegistration,
} from "@/components/tugways/blocks/find-target-registry";
import {
  ToolBlockCollapseContext,
  ToolUseIdContext,
} from "@/components/tugways/blocks/collapse-context";
import {
  TugCodeView,
  type TugCodeViewDelegate,
} from "@/components/tugways/tug-code-view";
import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import { useOuterScrollport } from "@/components/tugways/internal/outer-scrollport-context";
import { basename } from "@/lib/display-path";
import { attachOuterScrollOnModifierWheel } from "@/components/tugways/internal/use-outer-scroll-on-modifier-wheel";
import { useSavedRegionScroll } from "@/components/tugways/use-component-state-preservation";
import { dispatchCommand } from "@/command-dispatch";
import { hostCardIdOf } from "@/lib/annotator/annotation-element";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  BlockActionsCluster,
  BlockCopyButton,
  BlockFoldCue,
  useBlockFoldState,
} from "./affordances";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured file-view data — the body's render input.
 *
 * `content` is the literal text of the (possibly windowed) file
 * region the producer wants to show. `startLine` (1-based) and
 * `numLines` describe what region of the source file this content
 * came from; `totalLines` (when known) drives the "Showing N of M"
 * header. All three are optional because they aren't always
 * meaningful (e.g., a generated paste has no source-file extent).
 */
export interface FileData {
  /**
   * Source path, used for language detection and the (consumer-owned)
   * header label. May be empty — "" disables both.
   */
  filePath: string;

  /** File contents to render, as a single newline-separated string. */
  content: string;

  /**
   * 1-based line number of the first line of `content`. Forwarded to
   * `TugCodeView`, which offsets its line-number gutter so a windowed
   * read (Read with `offset`) shows real file line numbers instead of
   * counting from 1. Defaults to 1.
   */
  startLine?: number;

  /**
   * Number of lines this view actually shows. When omitted, computed
   * from `content`. Mostly redundant with the parsed line count, but
   * useful when the producer knows the count up front (e.g., a Read
   * with `limit` set).
   */
  numLines?: number;

  /**
   * Total lines in the source file (not just the rendered window).
   * Drives the "Showing N of M lines" header. When equal to or less
   * than `numLines`, the header simplifies to "N lines" — a partial
   * window is the only case where M is interesting.
   */
  totalLines?: number;
}

export interface FileBlockProps {
  /**
   * The file data to render. When undefined, the block renders
   * nothing visible (empty `data-slot="file-body"` for layout
   * consistency).
   */
  data?: FileData;

  /**
   * Initial collapse state ([Spec S02]). When undefined, the
   * component picks the default from `collapseThreshold`: collapsed
   * if the line count exceeds the threshold, expanded otherwise.
   */
  collapsed?: boolean;

  /**
   * Notification callback fired when the user toggles the collapsed
   * state. Stateless when omitted (the component still tracks local
   * state internally — this is uncontrolled mode).
   */
  onToggleCollapsed?: (next: boolean) => void;

  /** Forwarded class name for cascade-scoped customization. */
  className?: string;

  /**
   * Threshold for default-folded behavior. Defaults to
   * `DEFAULT_COLLAPSE_THRESHOLD` (80, per audit §5.1). Files at or
   * below this many lines render expanded by default; files above it
   * fold by default.
   */
  collapseThreshold?: number;

  /**
   * Opt-in key for the [A9] Component State Preservation Protocol.
   * When set, FileBlock persists its uncontrolled `collapsed` flag
   * into `bag.components` so a Maker > Reload restores the fold.
   *
   * The CM6 inner scroller's `scrollTop` is persisted independently
   * via the [A9] region-scroll axis — FileBlock writes
   * `data-tug-scroll-key={componentStatePreservationKey}/file-scroll`
   * onto `view.scrollDOM` so CardHost's region-scroll capture/restore
   * loop picks it up. The two axes are split deliberately: fold is
   * React-state (component-owned, not DOM-authority); inner scroll is
   * DOM-authority (the scrollTop lives on the scroll element).
   *
   * Undefined opts out of both axes (gallery, standalone).
   */
  componentStatePreservationKey?: string;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome` in
   * `ReadToolBlock`). When `true`:
   *
   *   - The standalone frame (background / border / radius / outer
   *     margin) is dropped so the body sits flush with the host.
   *   - FileBlock's own header (basename + lang badge + line counts)
   *     is hidden — the wrapper owns the file's identity in its own
   *     header.
   *   - The resting affordances (fold cue, Search trigger) portal
   *     into the host's chrome actions slot via
   *     `ChromeActionsTargetContext`. This is the load-bearing
   *     contract: `embedded={true}` MUST be used under a
   *     `BlockChrome` so the affordances have somewhere to
   *     surface. Using `embedded={true}` outside a chrome is
   *     unsupported — the affordances have no host and the user
   *     loses access to Search and the fold toggle.
   *
   * Default `false` — standalone usage (gallery, RenderInput-routed)
   * keeps its frame and header.
   *
   * @default false
   */
  embedded?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default-collapse threshold in lines. 80 per the session-audit
 * §5.1: Read P50 = 50 so the previous threshold of 50 folded half of
 * every file by default — too aggressive. 80 lines catches the upper
 * ~40% — long enough to scan-or-skip, short enough not to fold the
 * average file.
 */
export const DEFAULT_COLLAPSE_THRESHOLD = 80;

const DATA_SLOT_ROOT = "file-body";
const DATA_SLOT_HEADER = "file-header";

// ---------------------------------------------------------------------------
// Pure helpers — exported because tests pin them
// ---------------------------------------------------------------------------

/**
 * Map filename extension → language identifier. Covers the common
 * languages used in `tugcode` sessions. Returns `undefined` when the
 * extension is unknown — the substrate then renders plain monospace,
 * which per audit §5.4 is the dominant case anyway (84% of fenced
 * blocks have no language).
 *
 * The identifiers match Shiki's vocabulary (kept so the future
 * Shiki-via-CM6 bridge can map directly), and a forward subset
 * matches Lezer's grammar names.
 */
const EXT_TO_LANG: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  fs: "fsharp",
  ml: "ocaml",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  scala: "scala",
  groovy: "groovy",
  lua: "lua",
  php: "php",
  pl: "perl",
  pm: "perl",
  r: "r",
  jl: "julia",
  zig: "zig",
  v: "v",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  sql: "sql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  tex: "latex",
  diff: "diff",
  patch: "diff",
});

/**
 * Detect the language identifier for a file path, by extension.
 * Returns `undefined` when the extension is unknown.
 *
 * Special-cases bare filenames whose name is itself the language hint
 * (`Dockerfile`, `Makefile`) since they have no extension.
 */
export function detectLanguage(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (base === "") return undefined;
  if (base === "Dockerfile") return "dockerfile";
  if (base === "Makefile" || base === "makefile") return "makefile";

  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext];
}

/**
 * Split content into an array of lines. The trailing newline (if
 * present) does NOT produce a final empty line — the editor
 * convention. An empty string returns `[]`.
 */
export function splitContentLines(content: string): string[] {
  if (content.length === 0) return [];
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Compose the "Showing N of M lines" header label.
 *  - When `totalLines` is unknown or equals `numLines`, returns
 *    "N lines".
 *  - When `totalLines > numLines`, returns "Showing N of M lines".
 */
export function composeLineCountLabel(
  numLines: number,
  totalLines: number | undefined,
): string {
  if (totalLines === undefined || totalLines <= numLines) {
    return `${numLines} ${numLines === 1 ? "line" : "lines"}`;
  }
  return `Showing ${numLines} of ${totalLines} lines`;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const FileBlock: React.FC<FileBlockProps> = ({
  data,
  collapsed: collapsedProp,
  onToggleCollapsed,
  className,
  collapseThreshold = DEFAULT_COLLAPSE_THRESHOLD,
  embedded = false,
  componentStatePreservationKey,
}) => {
  // Derived display state — line count + language detection drive
  // the header label and the collapse default.
  const lines = React.useMemo(
    () => (data === undefined ? [] : splitContentLines(data.content)),
    [data?.content],
  );
  const language = React.useMemo(
    () => (data === undefined ? undefined : detectLanguage(data.filePath)),
    [data?.filePath],
  );
  const numLines = data?.numLines ?? lines.length;
  const headerLabel = composeLineCountLabel(numLines, data?.totalLines);

  const overThreshold = lines.length > collapseThreshold;

  // Collapse state — controlled / uncontrolled resolution, mount-in-
  // saved-state, and [A9] capture are all owned by `useBlockFoldState`
  // (shared with the other fold-bearing body kinds). FileBlock supplies
  // only the uncontrolled default: long files fold by default.
  const { collapsed, setCollapsed } = useBlockFoldState({
    collapsed: collapsedProp,
    defaultCollapsed: overThreshold,
    onToggleCollapsed,
    componentStatePreservationKey,
  });

  // Root element ref. `handleScrollMatchIntoView` reads it to
  // compute the target line's viewport band when scrolling a search
  // match into view; it also carries the `ref` in both the embedded
  // and standalone render branches.
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Chrome actions target — non-null when this FileBlock is composed
  // inside a `BlockChrome` that has rendered its actions slot.
  // The resting affordance row lives INSIDE the chrome / identity
  // header rather than rendering as a separate sticky strip beneath.
  // When the target is present (embedded composition),
  // the affordance node portals into it; when absent (standalone),
  // affordances render inside `.tugx-file-header` directly. The body
  // kind never depends on this being non-null — `embedded={false}` and
  // a missing chrome both fall through to the inline-in-header path.
  const chromeActionsTarget = useChromeActionsTarget();

  // Dev-mode misconfiguration check — `embedded={true}` is a contract
  // that the body kind sits inside a `BlockChrome` so resting
  // affordances have a portal target. If `embedded` is set but no
  // chrome is above us, the affordances vanish silently: the
  // identity header is suppressed AND the portal target is `null`,
  // so the fold cue never appears. The user notices
  // a missing button; the author doesn't notice the misconfiguration.
  // Surface it at mount so it fails loud in dev and stays free in
  // production (the early-return tree-shakes when `NODE_ENV` is
  // statically `"production"`).
  //
  // The check is deferred one tick because `BlockChrome`
  // publishes its `actionsTarget` via a `useState`-tracked ref
  // callback. On the body kind's FIRST render under a chrome, the
  // chrome's ref hasn't fired yet, so the context value is still
  // `null`. A naive synchronous warn would fire even in the legal
  // composition. The setTimeout defers past React's reconciliation;
  // if the target becomes non-null on the next render, the effect's
  // cleanup cancels the pending warn before it fires.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!embedded) return;
    if (chromeActionsTarget !== null) return;
    const handle = window.setTimeout(() => {
      console.warn(
        "FileBlock: `embedded={true}` requires a parent `BlockChrome`. " +
          "Without one, the body kind's identity header is suppressed AND its " +
          "affordances (the fold cue) have nowhere to portal — the " +
          "user loses access to them silently. Either compose under a chrome " +
          "or set `embedded={false}`.",
      );
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [embedded, chromeActionsTarget]);

  // Position-stable click is encapsulated inside each affordance
  // (BlockCopyButton, BlockFoldCue) — they each call
  // `useOuterScrollport` + `usePositionStableClick` internally
  // against their own button refs. The hook holds the click target
  // under the cursor for layout changes that don't shrink the
  // document; for a fold-cue collapse near the bottom of a long
  // file, the document shrinks past the user's `scrollTop` and the
  // browser's natural clamp applies (accepted behavior — see the
  // longer note on diff-block.tsx for the rationale).

  // Ref to the embedded TugCodeView — used to resolve the live CM6
  // `EditorView` for Cmd/Ctrl-wheel routing and the region-scroll
  // restore loop.
  const codeViewRef = React.useRef<TugCodeViewDelegate | null>(null);

  // Find-target registration ([L03]): transcript Find counts this file's
  // matches from the store text (an `editor` segment keyed by the owning
  // tool call); navigation resolves this target to open the internal fold
  // (a folded FileBlock unmounts CM6 entirely) and to drive the embedded
  // editor's own search. No-op outside a transcript host.
  const collapseHandle = React.useContext(ToolBlockCollapseContext);
  const contextToolUseId = React.useContext(ToolUseIdContext);
  useFindTargetRegistration(collapseHandle?.toolUseId ?? contextToolUseId, {
    unfold: () => setCollapsed(false),
    codeView: () => codeViewRef.current,
  });

  // The fold flag is persisted on the [A9] component-state axis by
  // `useBlockFoldState` above. CM6 inner scroll position is preserved
  // separately, via the [A9] region-scroll axis — a `data-tug-scroll-key`
  // attribute on `view.scrollDOM` lands in `bag.regionScroll`, restored
  // by CardHost's MutationObserver loop on mount. The two axes are
  // deliberately split: fold is React-state (component-owned, not
  // DOM-authority), inner scroll is DOM-authority (the scrollTop lives
  // on the scroll element).

  // ---- Cmd/Ctrl-wheel routing to the outer scrollport ----------------
  //
  // CM6's `.cm-scroller` captures wheel events when the cursor is
  // over the file viewer. For a user skimming a long transcript, the
  // inner capture stutters the outer scroll. Holding Cmd/Ctrl while
  // wheeling forwards the delta straight to the outer card
  // scrollport. The hook attaches its non-passive capture-phase
  // listener; `useLayoutEffect` keys on `collapsed` so the listener
  // re-attaches whenever the CM6 view mounts/unmounts (the view
  // disappears entirely when collapsed).
  //
  // We attach imperatively (not via the `useOuterScrollOnModifierWheel`
  // hook) because the inner scroller — CM6's `.cm-scroller` — is the
  // CM6 EditorView's internal `scrollDOM`, not a React-tracked
  // element. We resolve it through the delegate at mount time and
  // bundle the detach into the effect's cleanup.
  const outerScrollport = useOuterScrollport();
  const outerScrollportRef = React.useRef<HTMLElement | null>(outerScrollport);
  React.useLayoutEffect(() => {
    outerScrollportRef.current = outerScrollport;
  }, [outerScrollport]);
  React.useLayoutEffect(() => {
    if (collapsed) return;
    const delegate = codeViewRef.current;
    if (delegate === null) return;
    const view = delegate.view();
    if (view === null) return;
    return attachOuterScrollOnModifierWheel(
      view.scrollDOM,
      () => outerScrollportRef.current,
    );
  }, [collapsed]);

  // ---- Outer scroll-into-view for CM6 scrollIntoView requests --------
  //
  // `TugCodeView` consumes every CM6 `scrollIntoView` request (the
  // viewer is sized to its content, so the inner `.cm-scroller` has
  // nothing to scroll). This callback runs in the consume path and
  // scrolls the OUTER transcript scrollport so the target lands in the
  // unobstructed viewport BELOW the stacked sticky chrome (transcript
  // entry header → toolblock chrome → file header).
  //
  // Sticky chrome height is read from:
  //   - `--tugx-pin-stack-top` (transcript entry header)
  //   - `--tugx-block-header-height` (embedded chrome wrapper)
  //   - `.tugx-file-header` (rendered height; suppressed in embedded
  //     mode where the variable above accounts for it)
  //
  // The scrollport is mutated directly per [L06] — scroll position is
  // DOM authority, not React state. The SmartScroll state machine
  // listens for the resulting `scroll` event and ticks through its
  // normal phases.
  const handleScrollMatchIntoView = React.useCallback(
    (view: EditorView, range: SelectionRange) => {
      const scrollport = outerScrollportRef.current;
      const root = rootRef.current;
      if (scrollport === null || root === null) return;

      // Use `lineBlockAt` + `contentDOM.getBoundingClientRect()` rather
      // than `view.coordsAtPos`. The latter walks the rendered DOM and
      // returns `null` for positions outside CM6's current viewport —
      // exactly the case we care about (the target is OFFSCREEN, that's
      // why we need to scroll). The height map underneath `lineBlockAt`
      // always covers the full document, so we get the line's
      // cm-content-relative offset whether or not the line is currently
      // rendered. Combined with the live `contentDOM` rect, that gives
      // a viewport-relative band for the target line.
      const block = view.lineBlockAt(range.head);
      const contentRect = view.contentDOM.getBoundingClientRect();
      const matchTop = contentRect.top + block.top;
      const matchBottom = contentRect.top + block.bottom;

      const outerRect = scrollport.getBoundingClientRect();

      // Stacked sticky chrome above the file body. Variables are
      // read from the file root because that's where the outer pin
      // context stamps its measured heights.
      const rootStyle = getComputedStyle(root);
      const parsePx = (name: string): number => {
        const raw = rootStyle.getPropertyValue(name).trim();
        if (raw === "") return 0;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : 0;
      };
      let stickyTop = parsePx("--tugx-pin-stack-top");
      stickyTop += parsePx("--tugx-block-header-height");

      const headerEl = root.querySelector<HTMLElement>(".tugx-file-header");
      if (headerEl !== null && headerEl.offsetParent !== null) {
        stickyTop += headerEl.getBoundingClientRect().height;
      }

      const yMargin = 8;
      const visibleTop = outerRect.top + stickyTop;
      const visibleBottom = outerRect.bottom;

      let delta = 0;
      if (matchTop < visibleTop + yMargin) {
        delta = matchTop - (visibleTop + yMargin);
      } else if (matchBottom > visibleBottom - yMargin) {
        delta = matchBottom - (visibleBottom - yMargin);
      }
      if (delta === 0) return;

      const max = scrollport.scrollHeight - scrollport.clientHeight;
      const next = Math.max(0, Math.min(max, scrollport.scrollTop + delta));
      scrollport.scrollTop = next;
    },
    [],
  );

  // ---- [A9] region-scroll axis: CM6 inner scrollport ------------------
  //
  // Stamp `data-tug-scroll-key={key}/file-scroll` onto CM6's
  // `view.scrollDOM` whenever the view is mounted. CardHost's
  // `captureRegionScrolls` walks all `[data-tug-scroll-key]` elements
  // in the card subtree on every capture moment ([A9] save).
  //
  // Mount-in-saved-state. Two write paths:
  //
  //  - **Line-relative restore (preferred).** When the saved bag
  //    carries `meta.line = { number, offsetPx }` (the writer
  //    effect below serializes this on every commit), the first
  //    mount of CM6's view computes
  //    `lineBlockAtPos(state.doc.line(number).from).top + offsetPx`
  //    and writes that as `scrollDOM.scrollTop`. Content-anchored,
  //    so a brief font-load reflow leaves the *same line* at the
  //    viewport top — sub-pixel font-metric drift is the worst
  //    case.
  //
  //  - **Pixel fallback.** When the bag has no `meta.line` (legacy
  //    sessions, or future tools whose scroll state is too granular
  //    for a line anchor), the raw saved `y` is written directly.
  //
  // The `initialFileScrollConsumedRef` one-shot keeps the write
  // tied to the FIRST mount per CM6 view instance. A later
  // collapse→expand cycle remounts the view; the new instance's
  // ref is fresh and the saved value applies again (correct: the
  // user wants to land back at the same place after expanding).
  // The element-identity-gated MutationObserver pass in
  // `card-host.tsx` covers any later scroller-rebuild path; the
  // saved value flows from `bag.regionScroll[key].y` either way.
  const fileScrollKey =
    componentStatePreservationKey === undefined
      ? undefined
      : `${componentStatePreservationKey}/file-scroll`;
  const savedFileScroll = useSavedRegionScroll(fileScrollKey);
  const savedFileScrollYRef = React.useRef<number | undefined>(
    savedFileScroll?.y,
  );
  // Snapshot the saved line at component mount so the write below
  // sees a stable value even if a later save updates the bag while
  // the component is still mid-mount.
  const savedFileLineRef = React.useRef<
    { number: number; offsetPx: number } | undefined
  >(undefined);
  if (savedFileLineRef.current === undefined) {
    const meta = savedFileScroll?.meta;
    if (meta !== null && typeof meta === "object") {
      const line = (meta as { line?: unknown }).line;
      if (line !== null && typeof line === "object" && "number" in line && "offsetPx" in line) {
        const ln = (line as { number: unknown }).number;
        const off = (line as { offsetPx: unknown }).offsetPx;
        if (
          typeof ln === "number" &&
          typeof off === "number" &&
          Number.isFinite(ln) &&
          Number.isFinite(off)
        ) {
          savedFileLineRef.current = {
            number: Math.max(1, Math.floor(ln)),
            offsetPx: off,
          };
        }
      }
    }
  }
  const initialFileScrollConsumedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (collapsed) return;
    if (fileScrollKey === undefined) return;
    const delegate = codeViewRef.current;
    if (delegate === null) return;
    const view = delegate.view();
    if (view === null) return;
    const scrollDOM = view.scrollDOM;
    scrollDOM.setAttribute("data-tug-scroll-key", fileScrollKey);
    if (!initialFileScrollConsumedRef.current) {
      initialFileScrollConsumedRef.current = true;
      // Prefer the line-relative payload when present — it survives
      // font-load reflow because the right LINE shows up at the
      // viewport top regardless of how the font metric resolves.
      const savedLine = savedFileLineRef.current;
      if (
        savedLine !== undefined &&
        savedLine.number >= 1 &&
        savedLine.number <= view.state.doc.lines
      ) {
        const linePos = view.state.doc.line(savedLine.number).from;
        const block = view.lineBlockAt(linePos);
        scrollDOM.scrollTop = Math.max(0, block.top + savedLine.offsetPx);
      } else {
        // Pixel fallback (legacy bags, or no line meta).
        const y = savedFileScrollYRef.current;
        if (typeof y === "number" && y > 0) {
          scrollDOM.scrollTop = y;
        }
      }
    }

    // The line-relative WRITER lives in the substrate. `cm6ScrollAnchor`
    // (installed by `TugCodeView`) publishes `data-tug-scroll-state` in the
    // same `{line: {number, offsetPx}, scrollHeight}` shape this block used
    // to write for itself, and holds that line across a card width change as
    // well — two occasions that want the same anchor in the same unit. What
    // stays here is what is genuinely this block's: which region key the
    // scroller answers to, and the one-shot restore off the saved bag.
    return () => {
      scrollDOM.removeAttribute("data-tug-scroll-key");
    };
  }, [collapsed, fileScrollKey]);

  // ---- Copy text source -----------------------------------------------
  //
  // `fileTextRef` carries the live file content so the
  // `BlockCopyButton`'s `getText` closure reads the freshest string
  // at fire time. The ref is written in a `useLayoutEffect` so a
  // click in the same frame as a `data.content` prop change sees
  // the new content ([L07]). The affordance owns the rest of the
  // Copy contract (confirmation flash, timer cleanup, clipboard
  // call, width-stabilize) — see `affordances/block-copy-button.tsx`.
  const fileTextRef = React.useRef<string>(data?.content ?? "");
  React.useLayoutEffect(() => {
    fileTextRef.current = data?.content ?? "";
  }, [data?.content]);
  const getFileText = React.useCallback(() => fileTextRef.current, []);

  // Empty data: render an empty marker for layout consistency. Same
  // contract as before — consumers may depend on the data-empty
  // attribute (e.g. for CSS rules that suppress the frame).
  if (data === undefined || lines.length === 0) {
    return (
      <div
        ref={rootRef}
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        className={
          className === undefined ? "tugx-file" : `tugx-file ${className}`
        }
      />
    );
  }

  const langClass =
    language === undefined ? "" : ` tugx-file--lang-${language}`;
  const rootClass =
    `tugx-file${langClass}` +
    (className === undefined ? "" : ` ${className}`);

  // Fold cue label. Library-side affordance (`BlockFoldCue`) owns
  // the chevron, position-stable click, and follow-bottom release;
  // FileBlock just formats the count.
  const showCue = overThreshold;
  const cueCountWord = lines.length === 1 ? "line" : "lines";
  const cueLabel = `${lines.length.toLocaleString()} ${cueCountWord}`;

  // Compose the affordances node ONCE. It renders either inline at
  // the trailing edge of `.tugx-file-header` (standalone) or via a
  // portal into the host's chrome actions slot (embedded). Ordering:
  // Copy → fold cue (rightmost). Both affordances come from the block
  // affordance library (`body-kinds/affordances/`), so the contract
  // (position-stable click, ghost typography, 2xs scale, focus-
  // refuse) is uniform across body kinds.
  // Under a chrome (embedded), the chrome header owns Copy + the whole-block
  // fold, so FileBlock contributes no affordances of its own — it has no
  // body-specific controls (Find/view-mode). The standalone composition
  // (gallery / RenderInput) still carries Copy + the in-body fold cue.
  const affordances = embedded ? null : (
    <>
      <BlockCopyButton
        data-slot="file-copy"
        disabled={collapsed}
        aria-label="Copy file contents"
        getText={getFileText}
      />
      {showCue ? (
        <BlockFoldCue
          className="tugx-file-fold-cue"
          data-slot="file-fold-cue"
          collapsed={collapsed}
          onToggle={setCollapsed}
          collapsedLabel={cueLabel}
          ariaLabelCollapse="Collapse file"
          ariaLabelExpand="Expand file"
        />
      ) : null}
    </>
  );

  // Embedded composition with a published chrome target: portal the
  // affordances into the chrome's actions slot. The chrome's slot has
  // its own layout (flex cluster); we wrap in a `data-slot` fragment
  // owner so tests can still locate "the file block's affordances"
  // unambiguously even when they live elsewhere in the DOM tree.
  const portaledAffordances =
    embedded && chromeActionsTarget !== null && affordances !== null
      ? createPortal(
          <BlockActionsCluster data-slot="file-actions">
            {affordances}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  return (
    <div
      ref={rootRef}
      data-slot={DATA_SLOT_ROOT}
      data-empty="false"
      data-language={language ?? "plain"}
      data-collapsed={collapsed ? "true" : "false"}
      data-embedded={embedded ? "true" : undefined}
      className={rootClass}
      tabIndex={-1}
    >
      {embedded ? null : (
        <div
          className="tugx-file-header"
          data-slot={DATA_SLOT_HEADER}
        >
          <span
            className="tugx-file-path"
            data-slot="file-path"
            title={data.filePath}
            data-tug-focus="refuse"
            onClick={(event) => {
              // Primary click opens the file in a Text card at the
              // block's starting line (open-file: path-keyed reuse).
              if (event.button !== 0 || event.metaKey || event.shiftKey) {
                return;
              }
              if (data.filePath === "") return;
              const originCardId = hostCardIdOf(event.currentTarget);
              dispatchCommand(TUG_ACTIONS.OPEN_FILE, {
                path: data.filePath,
                line: data.startLine,
                ...(originCardId !== undefined ? { originCardId } : {}),
              });
            }}
          >
            {basename(data.filePath)}
          </span>
          {language !== undefined ? (
            <span className="tugx-file-lang" data-slot="file-lang">
              {language}
            </span>
          ) : null}
          <span className="tugx-file-counts" data-slot="file-counts">
            {headerLabel}
          </span>
          <span className="tugx-file-header-spacer" />
          {affordances !== null ? (
            <BlockActionsCluster data-slot="file-actions">
              {affordances}
            </BlockActionsCluster>
          ) : null}
        </div>
      )}
      {portaledAffordances}

      {collapsed ? null : (
        <TugCodeView
          ref={codeViewRef}
          value={data.content}
          language={language}
          startLine={data.startLine}
          onScrollIntoView={handleScrollMatchIntoView}
          // File viewer defaults: wrap on, line numbers on. The CM6
          // substrate handles the per-line scrollbar bug by
          // construction — `lineWrapping` puts wide lines on their
          // own visual rows inside a single scroll container.
          wrap
          lineNumbers
        />
      )}
    </div>
  );
};
