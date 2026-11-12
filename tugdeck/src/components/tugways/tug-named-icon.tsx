/**
 * TugNamedIcon — a lucide icon drawn from its name.
 *
 * Cards, panes, tabs, faces and alerts name their icon as a string — a card's
 * registration, a pane's meta, an alert off the wire — and every surface that
 * drew one looked the string up in lucide's `icons` table with the same cast,
 * `icons[name as keyof typeof icons]`, and the same guard for a name the table
 * does not hold. This is that lookup once: {@link iconNamed} for a surface
 * that needs the component itself (to hand to a menu row or a button), and
 * {@link TugNamedIcon} for one that draws it.
 *
 * An unknown name is not an error. A name comes from data, and data written
 * against one lucide release meets another; the answer to a name lucide no
 * longer has is no icon, which is what every hand-written lookup said.
 *
 * Laws: [L19] `data-slot`, `forwardRef`, `cn()`, `...rest` onto the svg.
 *
 * @module components/tugways/tug-named-icon
 */

import React from "react";
import { icons, type LucideIcon, type LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";

/** The lucide component a name stands for, or `null` for none. */
export function iconNamed(name: string | null | undefined): LucideIcon | null {
  if (name === null || name === undefined || name === "") return null;
  return Object.prototype.hasOwnProperty.call(icons, name)
    ? icons[name as keyof typeof icons]
    : null;
}

/** Props for {@link TugNamedIcon}: lucide's, plus the name to draw. */
export interface TugNamedIconProps extends Omit<LucideProps, "name"> {
  /** The lucide icon's name (`"FileText"`); unknown or empty draws nothing. */
  name: string | null | undefined;
}

/** Draw the lucide icon a name stands for; nothing for an unknown name. */
export const TugNamedIcon = React.forwardRef<SVGSVGElement, TugNamedIconProps>(
  function TugNamedIcon({ name, className, ...rest }, ref) {
    const Icon = iconNamed(name);
    if (Icon === null) return null;
    return (
      <Icon
        ref={ref}
        data-slot="tug-named-icon"
        className={cn("tug-named-icon", className)}
        {...rest}
      />
    );
  },
);
