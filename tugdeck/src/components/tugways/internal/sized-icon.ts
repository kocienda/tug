/**
 * sized-icon — give a caller's icon element the size its slot draws at.
 *
 * Primitives take `icon?: React.ReactNode` (`<TriangleAlert />`), and the
 * slot the icon lands in has a fixed size the caller should not have to
 * know. A Lucide element takes that size as its `size` prop, so the element
 * is cloned with it; anything that is not an element (a string, `null`) is
 * returned as it came.
 *
 * @module components/tugways/internal/sized-icon
 */

import React from "react";

/** `icon` with `size` set on it when it is an element. */
export function sizedIcon(icon: React.ReactNode, size: number | string): React.ReactNode {
  if (!React.isValidElement<{ size?: number | string }>(icon)) return icon;
  return React.cloneElement(icon, { size });
}
