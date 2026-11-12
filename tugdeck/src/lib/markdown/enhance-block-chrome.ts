/**
 * `enhance-block-chrome` — shared imperative-DOM chrome for markdown
 * block kinds (fenced code, tables, …).
 *
 * Markdown is rendered as sanitized HTML via `innerHTML`, not React, so
 * the per-block affordances every other block surface gets from React
 * components — `BlockActionsCluster`, `BlockCopyButton`, `BlockFoldCue`
 * — are built here in the DOM instead. This module is the imperative-DOM
 * counterpart of those components: one header strip primitive, one copy
 * button, one fold cue, all styled (in `styles/tugx-md.css`) off the
 * same `--tugx-block-*` / `--tug-button-xs-*` tokens so they read as the
 * same controls, same size, same hover as the tool-block header.
 *
 * The header strip is `position: sticky` and joins the transcript
 * pin-stack via `top: var(--tugx-pin-stack-top, 0)`, exactly like
 * `BlockHeader` / `FileBlock` / `TerminalBlock` — so a markdown
 * block's header telescopes under the entry header instead of forming
 * its own nested scroller. The fold cue toggles `data-collapsed` on the
 * frame; the CSS hides the `.tugx-md-chrome-body` and drops the header
 * divider while collapsed. The chevron direction is render-time DOM
 * structure (both glyphs painted, CSS shows the one matching
 * `data-collapsed`), matching `BlockFoldCue`'s structural icon swap.
 *
 * No listener cleanup is needed — when the parent block element is
 * replaced (the `el.innerHTML = ...` write the reconciler does on a
 * content change), the chrome and its listeners are detached and
 * garbage-collected together. Re-attachment per delta is cheap (a few
 * `addEventListener` calls); there is no React tree to mount.
 *
 * Laws: [L06] appearance via DOM/CSS, not React state — collapse and the
 * "copied" flash toggle attributes/classes, React never re-renders.
 *
 * @module lib/markdown/enhance-block-chrome
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** One element of an inlined lucide icon — a tag plus its attributes. */
interface IconChild {
  tag: string;
  attrs: Record<string, string>;
}

/** Lucide `Copy` icon (24×24 viewBox). */
const COPY_ICON: ReadonlyArray<IconChild> = [
  { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
  { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
];

/** Lucide `Check` icon (24×24 viewBox). */
const CHECK_ICON: ReadonlyArray<IconChild> = [
  { tag: "path", attrs: { d: "M20 6 9 17l-5-5" } },
];

/** Lucide `ChevronsDown` (collapsed → click to expand). */
const CHEVRONS_DOWN_ICON: ReadonlyArray<IconChild> = [
  { tag: "path", attrs: { d: "m7 6 5 5 5-5" } },
  { tag: "path", attrs: { d: "m7 13 5 5 5-5" } },
];

/** Lucide `ChevronsUp` (expanded → click to collapse). */
const CHEVRONS_UP_ICON: ReadonlyArray<IconChild> = [
  { tag: "path", attrs: { d: "m17 11-5-5-5 5" } },
  { tag: "path", attrs: { d: "m17 18-5-5-5 5" } },
];

/**
 * Build a 24×24-viewBox SVG icon with the standard lucide stroke
 * styling, classed `{baseClass}` + `{baseClass}--{variant}` so the CSS
 * can swap which of a button's two icons is visible by state.
 */
function buildIcon(
  children: ReadonlyArray<IconChild>,
  baseClass: string,
  variant: string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(baseClass);
  svg.classList.add(`${baseClass}--${variant}`);
  for (const child of children) {
    const node = document.createElementNS(SVG_NS, child.tag);
    for (const [k, v] of Object.entries(child.attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}

const COPIED_CLASS = "is-copied";
const COPIED_DURATION_MS = 1200;

/**
 * Build the icon-only Copy control — a Copy glyph that swaps to a Check
 * for ~1.2s after a successful clipboard write (the `is-copied` class
 * drives the CSS swap). `getText` is read at click time so the caller
 * can return live content (the latest code, a serialized table, …).
 * Accessible name only, no `title` (no browser tooltip), matching the
 * tool-block header's `BlockCopyButton subtype="icon"`.
 */
export function buildCopyButton(
  getText: () => string,
  ariaLabel: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-chrome-btn tugx-md-chrome-copy";
  button.setAttribute("aria-label", ariaLabel);
  button.appendChild(buildIcon(COPY_ICON, "tugx-md-chrome-copy-icon", "default"));
  button.appendChild(buildIcon(CHECK_ICON, "tugx-md-chrome-copy-icon", "copied"));

  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    const writer = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!writer) return;
    void writer(getText())
      .then(() => {
        button.classList.add(COPIED_CLASS);
        if (resetTimer !== null) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          button.classList.remove(COPIED_CLASS);
          resetTimer = null;
        }, COPIED_DURATION_MS);
      })
      .catch(() => {
        // Clipboard rejected (permission, non-secure context) — leave
        // the button at rest.
      });
  });
  return button;
}

/**
 * Build the icon-only fold cue — the imperative-DOM counterpart of
 * `BlockFoldCue subtype="icon"`. Markdown blocks default EXPANDED (no
 * `data-collapsed` on the frame), so the first click collapses; the CSS
 * hides the `.tugx-md-chrome-body` and swaps the chevron. Both glyphs
 * are painted; the wrapper's `data-collapsed` selects which shows.
 */
export function buildFoldButton(
  frame: HTMLElement,
  labels: { ariaExpand: string; ariaCollapse: string },
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-chrome-btn tugx-md-chrome-fold";
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", labels.ariaCollapse);
  button.appendChild(buildIcon(CHEVRONS_UP_ICON, "tugx-md-chrome-fold-icon", "expanded"));
  button.appendChild(buildIcon(CHEVRONS_DOWN_ICON, "tugx-md-chrome-fold-icon", "collapsed"));

  button.addEventListener("click", (e) => {
    e.preventDefault();
    const collapsed = frame.hasAttribute("data-collapsed");
    if (collapsed) {
      frame.removeAttribute("data-collapsed");
      button.setAttribute("aria-expanded", "true");
      button.setAttribute("aria-label", labels.ariaCollapse);
    } else {
      frame.setAttribute("data-collapsed", "");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", labels.ariaExpand);
    }
  });
  return button;
}

/**
 * Build the sticky header strip — an identity node at the leading edge,
 * a flexible spacer, then a trailing actions cluster holding the passed
 * controls (Copy, fold cue, …). The imperative-DOM counterpart of a
 * `BlockActionsCluster` riding a block header.
 */
export function buildBlockHeader(opts: {
  identity: HTMLElement | null;
  actions: ReadonlyArray<HTMLElement>;
}): HTMLDivElement {
  const header = document.createElement("div");
  header.className = "tugx-md-chrome-header";

  if (opts.identity !== null) header.appendChild(opts.identity);

  const spacer = document.createElement("span");
  spacer.className = "tugx-md-chrome-spacer";
  header.appendChild(spacer);

  const cluster = document.createElement("span");
  cluster.className = "tugx-md-chrome-actions";
  for (const action of opts.actions) cluster.appendChild(action);
  header.appendChild(cluster);

  return header;
}
