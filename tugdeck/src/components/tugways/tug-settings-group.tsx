/**
 * TugSettingsGroup — one bordered group of settings, its legend painted on the
 * border line.
 *
 * The Settings card's sections and the cards' own option sheets lay their
 * controls out in these: a bordered {@link TugBox} filling its column, the
 * legend taken out of flow and set on the top border, a generous inset that
 * clears the overhanging legend, and a left-packed column of controls. The
 * shape is fixed — every caller drew the same one — so the props are the
 * box's own, less the two the shape decides (`variant`, `labelPosition`).
 * A caller that lays its controls out differently styles
 * `.its-class > .tug-box-body` on top, the way a box's body is always styled.
 *
 * Laws: [L06] appearance through CSS; [L19] `.tsx`/`.css` pair, `data-slot`,
 * `forwardRef`, `cn()`, `...rest` onto the box; [L20] composes `TugBox` and
 * scopes no tokens of its own.
 *
 * @module components/tugways/tug-settings-group
 */

import "./tug-settings-group.css";

import React from "react";

import { cn } from "@/lib/utils";
import { TugBox, type TugBoxProps } from "./tug-box";

/** Props for {@link TugSettingsGroup}: a box's, less the two the shape fixes. */
export interface TugSettingsGroupProps
  extends Omit<TugBoxProps, "variant" | "labelPosition"> {
  /** The group's name, painted on its top border. */
  label: string;
  /** `data-slot` on the root; defaults to `"tug-settings-group"`. */
  "data-slot"?: string;
}

/** A bordered settings group with its legend on the border. */
export const TugSettingsGroup = React.forwardRef<HTMLFieldSetElement, TugSettingsGroupProps>(
  function TugSettingsGroup(
    { "data-slot": dataSlot = "tug-settings-group", className, children, ...rest },
    ref,
  ) {
    return (
      <TugBox
        ref={ref}
        variant="bordered"
        labelPosition="legend"
        data-slot={dataSlot}
        className={cn("tug-settings-group", className)}
        {...rest}
      >
        {children}
      </TugBox>
    );
  },
);
