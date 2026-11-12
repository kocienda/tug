/**
 * `TugSpriteIcon` — render-once / reuse-many lucide icon.
 *
 * `lucide-react` re-materializes a full `<svg>` + `<path>` subtree on
 * every instance with zero sharing, so at transcript scale the icon
 * `<path>` nodes alone run into the thousands. This renders the SAME
 * `<svg>` lucide does — same tag, same `lucide`/`lucide-<name>` classes,
 * same presentation attributes, so every existing `.tug-button svg`
 * (and friends) style rule applies untouched and the pixels are
 * identical — but its body is a single `<use>` pointing at a `<symbol>`
 * defined ONCE in a shared sprite. Each instance is `<svg><use/></svg>`
 * (2 nodes) instead of `<svg>` + N `<path>` (3+).
 *
 * Geometry is lucide's own icon data (`lucide` base package exports each
 * icon as `[[tag, attrs], …]`), so the glyph is byte-for-byte the lucide
 * shape. Stroke/fill/width are set on the instance `<svg>` exactly as
 * lucide sets them and inherit through `<use>` into the symbol.
 *
 * Laws: [L19] component authoring guide
 */

import React from "react";

import { cn } from "@/lib/utils";

const SPRITE_ID = "tug-icon-sprite";

/** lucide icon-node shape: a list of [tag, attributes] element specs. */
export type LucideIconNode = ReadonlyArray<
  readonly [string, Record<string, string | number>]
>;

const registered = new Set<string>();

function spriteRoot(): SVGSVGElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(SPRITE_ID) as SVGSVGElement | null;
  if (el === null) {
    el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.id = SPRITE_ID;
    el.setAttribute("aria-hidden", "true");
    // Out of flow, zero-box, never painted — pure symbol storage.
    el.style.position = "absolute";
    el.style.width = "0";
    el.style.height = "0";
    el.style.overflow = "hidden";
    document.body.appendChild(el);
  }
  return el;
}

/** Define the icon's `<symbol>` in the shared sprite exactly once. */
function ensureSymbol(name: string, node: LucideIconNode): void {
  if (registered.has(name)) return;
  const root = spriteRoot();
  if (root === null) return;
  registered.add(name);
  const inner = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  // insertAdjacentHTML on an SVG element parses children in the SVG
  // namespace; the symbol carries lucide's 24×24 viewBox.
  root.insertAdjacentHTML(
    "beforeend",
    `<symbol id="tug-i-${name}" viewBox="0 0 24 24">${inner}</symbol>`,
  );
}

export interface TugSpriteIconProps extends Omit<React.ComponentPropsWithoutRef<"svg">, "children" | "name"> {
  /** Stable icon name (the symbol id + `lucide-<name>` class suffix). */
  name: string;
  /** lucide icon-node data (import from `lucide`, e.g. `Copy`). */
  node: LucideIconNode;
  /** Width/height in px — matches lucide's `size` prop. Default 24. */
  size?: number;
}

export const TugSpriteIcon = React.forwardRef<SVGSVGElement, TugSpriteIconProps>(function TugSpriteIcon(
  { name, node, size = 24, className, "aria-hidden": ariaHidden = true, ...rest },
  ref,
) {
  ensureSymbol(name, node);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
      ref={ref}
      data-slot="tug-sprite-icon"
      className={cn("lucide", `lucide-${name}`, className)}
      aria-hidden={ariaHidden}
    >
      <use href={`#tug-i-${name}`} />
    </svg>
  );
});
