/**
 * A body's surfaces that stand outside its card's box, mirrored for the
 * overlay to draw.
 *
 * A body's viewport is its card's content box, so a surface built to stand
 * outside that box — the Z2 placard, which opens up off the status row over
 * the masthead and the wall above the card — has nowhere to stand in a body.
 * The overlay draws it instead, over every card, where the in-document card
 * would have drawn it (`overlay/overlay-surface-drawer.ts`).
 *
 * The body goes on rendering the surface exactly as it does in the shell,
 * hidden (`tug-placard-drawn-elsewhere`), so every reading, store and handler
 * behind it is the card's own and nothing about it is re-derived. What
 * crosses the bus is the content as the body rendered it: the markup, the
 * title, the panel's class, the line it hangs from and the x it centres on,
 * in the body's viewport points. A change to the rendered content, or to the
 * body's viewport (a card resized moves the line it hangs from), is published
 * once per frame as the card's `card.surface`. The shell relays it to the
 * overlay with the card's rest geometry, and sends a press in the drawn copy
 * back as `surface.activate` with the pressed node's child-index path; the
 * body clicks the same node in its own tree. A press or Escape outside the
 * drawn panel dismisses it (`surface.dismissed`), as one the body sees
 * outside its hidden panel does there.
 *
 * Laws: [L22] (the mirror observes the rendered DOM directly), [L27] (every
 * show returns its release).
 *
 * @module lib/surface-mirror
 */

import type { CardSurface } from "../bus/declarations/card";
import { cardSurface } from "../bus/declarations/card";
import { surfaceActivate, surfaceDismissed } from "../bus/declarations/verbs";
import { page } from "../bus/page";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `node`'s child-index path from `root`, or null when it is not inside it. */
export function pathOf(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let at: Node | null = node;
  while (at !== null && at !== root) {
    const parent: Node | null = at.parentNode;
    if (parent === null) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, at) as number);
    at = parent;
  }
  return at === root ? path : null;
}

/** The node at `path` under `root`, or null when the path leads nowhere. */
export function nodeAt(root: Node, path: readonly number[]): Node | null {
  let at: Node | null = root;
  for (const index of path) {
    at = at?.childNodes[index] ?? null;
    if (at === null) return null;
  }
  return at;
}

/** Every scroller under `root` that stands scrolled, by path. */
export function scrollsOf(root: Element): Array<{ path: number[]; top: number }> {
  const out: Array<{ path: number[]; top: number }> = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.scrollTop <= 0) continue;
    const path = pathOf(root, el);
    if (path !== null) out.push({ path, top: el.scrollTop });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The body's mirror
// ---------------------------------------------------------------------------

/** What a surface says about itself, beside its content. */
export type SurfaceMeta = Omit<CardSurface, "html" | "scroll">;

/** Where a body's deck-scope surfaces go. */
export interface SurfaceHost {
  /**
   * Have the overlay draw `content` — the rendered content of a hidden panel —
   * as `meta` says, until the release. `meta` is read at every publish, so
   * its line follows the body's viewport. `dismissed` runs when the drawn
   * copy is dismissed.
   */
  show(content: HTMLElement, meta: () => SurfaceMeta, dismissed: () => void): () => void;
}

let bodyMirror: SurfaceMirror | null = null;

/**
 * The page's surface host: in a body, the mirror that draws through the
 * overlay — made on first ask, publishing as the card's `card.surface` and
 * answering `surface.*` back — and null in the shell, where surfaces draw in
 * place.
 */
export function getSurfaceHost(): SurfaceHost | null {
  if (!page.isBody || page.cardId === null) return null;
  if (bodyMirror === null) {
    const mirror = createSurfaceMirror((surface) => cardSurface.set(surface));
    surfaceActivate.handle(({ path }) => mirror.activate(path));
    surfaceDismissed.handle(() => mirror.dismiss());
    bodyMirror = mirror;
  }
  return bodyMirror;
}

/** The body's surface host, and the two things the drawn copy can say back to it. */
export interface SurfaceMirror extends SurfaceHost {
  /** The node at `path` in the drawn content was pressed. */
  activate(path: readonly number[]): void;
  /** The drawn surface was dismissed. */
  dismiss(): void;
}

/**
 * A body's surface host: publishes the shown surface through `send` on show
 * and on every frame its content or the page's viewport changed, and `null`
 * on release.
 */
export function createSurfaceMirror(send: (surface: CardSurface | null) => void): SurfaceMirror {
  let current: { content: HTMLElement; dismissed: () => void } | null = null;
  return {
    show(content, meta, dismissed) {
      const shown = { content, dismissed };
      current = shown;
      let sent = meta();
      let html = content.innerHTML;
      send({ ...sent, html, scroll: scrollsOf(content) });
      let frame: number | null = null;
      const publish = (): void => {
        frame = null;
        if (current !== shown) return;
        const next = meta();
        if (content.innerHTML === html && JSON.stringify(next) === JSON.stringify(sent)) return;
        sent = next;
        html = content.innerHTML;
        send({ ...sent, html, scroll: [] });
      };
      const schedule = (): void => {
        if (frame === null) frame = requestAnimationFrame(publish);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
      window.addEventListener("resize", schedule);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", schedule);
        if (frame !== null) cancelAnimationFrame(frame);
        if (current !== shown) return;
        current = null;
        send(null);
      };
    },
    activate(path) {
      if (current === null) return;
      const node = nodeAt(current.content, path);
      const el = node instanceof Element ? node : (node?.parentElement ?? null);
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    },
    dismiss() {
      current?.dismissed();
    },
  };
}
