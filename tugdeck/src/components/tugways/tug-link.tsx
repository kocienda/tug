/**
 * `TugLink` — themed hyperlink primitive.
 *
 * Renders an `<a>` whose color, hover color, and underline pull
 * from theme tokens (`--tug7-element-global-text-normal-link-*`)
 * via the local `--tugx-link-*` slot family. Replaces the browser-
 * default cobalt-blue + harsh underline that an unstyled `<a>`
 * produces — that treatment is unreadable on Dev's dark surfaces
 * and inconsistent with how links read inside rendered markdown
 * (which uses the same underlying `--tug7-*` tokens).
 *
 * The component is intentionally small: a `<a>` wrapper around the
 * children, an `external` prop that wires `target="_blank"` +
 * `rel="noopener noreferrer"` AND appends a trailing
 * lucide `ExternalLink` glyph so the user knows the click will
 * leave the surface, and the standard `className` / `data-slot`
 * surface. Anything richer (tooltip-on-hover, copy-on-right-click,
 * route-aware client-side navigation) belongs in a downstream
 * composition or a separate primitive.
 *
 * Laws:
 *  - [L06] no React state for appearance — every visible variant
 *    is a CSS attribute / class swap driven by props.
 *  - [L17] one-hop token alias: `--tugx-link-*` → `--tug7-*` in
 *    a single resolution. The `--tug7-*` definitions live in the
 *    theme files; the `--tugx-link-*` aliases live in this
 *    component's CSS `body{}` block.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="tug-link"`, this module docstring.
 *  - [L20] component-token sovereignty — this component owns the
 *    `--tugx-link-*` family; no other component reaches into it.
 *
 * @module components/tugways/tug-link
 */

import "./tug-link.css";

import React from "react";
import { ExternalLink as ExternalLinkIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface TugLinkProps extends Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "ref"
> {
  /** Hyperlink target. Required — a `TugLink` with no href is a misuse. */
  href: string;
  /**
   * Treat the link as external — sets `target="_blank"` and
   * `rel="noopener noreferrer"`, and appends a trailing lucide
   * `ExternalLink` glyph so the user has a visual cue that the
   * click will open a new tab. Defaults to `false`.
   */
  external?: boolean;
  /**
   * Suppress the trailing `ExternalLink` glyph even when
   * `external` is `true`. Use sparingly — the glyph carries
   * accessibility information ("this opens elsewhere"); hiding it
   * shifts that disclosure to the link's surrounding context.
   * Defaults to `false`.
   */
  hideExternalIcon?: boolean;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
  /** Standard children. */
  children?: React.ReactNode;
}

/**
 * Resolve the `target` + `rel` attribute pair from the caller's
 * `external` toggle plus any explicit overrides. Pure for testing:
 *  - `external=true` with no explicit override → `target="_blank"`,
 *    `rel="noopener noreferrer"` (the safe external-link pair).
 *  - `external=false` with no override → both `undefined` (no
 *    attributes rendered).
 *  - Caller-supplied `target` / `rel` always win — `external` only
 *    fills in attributes the caller didn't set, so a caller can
 *    request `external={true}` but override `target="_self"` for
 *    an embedded-iframe edge case without losing the `rel` safety.
 *
 * Exported for the pure-logic test suite.
 */
export function resolveLinkAttrs(
  external: boolean,
  targetProp: string | undefined,
  relProp: string | undefined,
): { target: string | undefined; rel: string | undefined } {
  return {
    target: targetProp ?? (external ? "_blank" : undefined),
    rel: relProp ?? (external ? "noopener noreferrer" : undefined),
  };
}

export const TugLink = React.forwardRef<HTMLAnchorElement, TugLinkProps>(
  function TugLink(
    {
      href,
      external = false,
      hideExternalIcon = false,
      className,
      children,
      target: targetProp,
      rel: relProp,
      ...rest
    },
    ref,
  ) {
    const { target, rel } = resolveLinkAttrs(external, targetProp, relProp);

    return (
      <a
        ref={ref}
        href={href}
        target={target}
        rel={rel}
        className={cn("tug-link", className)}
        data-slot="tug-link"
        data-external={external ? "true" : undefined}
        {...rest}
      >
        {children}
        {external && !hideExternalIcon ? (
          <ExternalLinkIcon
            className="tug-link-external-icon"
            data-slot="tug-link-external-icon"
            aria-hidden="true"
          />
        ) : null}
      </a>
    );
  },
);
