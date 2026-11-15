/**
 * TugPushButton — standalone action button for app code.
 *
 * Uppercase, letter-spaced styling for clear call-to-action buttons
 * ("Save", "Cancel", "Delete"). Wraps TugButton with the .tug-push-button CSS class.
 *
 * A push button is a **toggle** when it is given `pressed`: it then carries
 * `aria-pressed` and reads lit while on. The caller owns the on/off value (it
 * is data some other code acts on) and passes it back down; the lit look is
 * CSS over the attribute.
 *
 * Laws: [L06] appearance via CSS, [L11] the control emits and its owner holds
 *       the state, [L19] component authoring guide
 * Decisions: [D02] emphasis x role system
 */

import "./tug-push-button.css";

import React from "react";
import { cn } from "@/lib/utils";
import { TugButton } from "./internal/tug-button";
import type { TugButtonProps } from "./internal/tug-button";

// Re-export types that app code needs
export type { TugButtonConfirmation, TugButtonEmphasis, TugButtonLayout, TugButtonRole, TugButtonSize } from "./internal/tug-button";

export interface TugPushButtonProps extends TugButtonProps {
  /**
   * Makes the button a toggle and says whether it is on. `true` and `false`
   * both render `aria-pressed`, so assistive technology announces a toggle in
   * either state; `true` also lights the button. Omit it and the button is a
   * plain action button with no `aria-pressed` of its own.
   */
  pressed?: boolean;
}

/** The DOM attributes a `pressed` value puts on the button. */
export interface TugPushButtonToggleAttributes {
  "aria-pressed"?: boolean;
  /** Marks a button whose `aria-pressed` came from `pressed`; the lit rule keys on it. */
  "data-tug-toggle"?: "";
}

/**
 * Resolve `pressed` to the button's toggle attributes.
 *
 * An omitted `pressed` yields nothing, so a caller's own `aria-pressed`
 * passes through untouched and unlit: the lit look belongs to buttons that
 * asked to be toggles, and several action buttons already stamp
 * `aria-pressed` for assistive technology alone.
 */
export function tugPushButtonToggleAttributes(
  pressed: boolean | undefined,
): TugPushButtonToggleAttributes {
  if (pressed === undefined) return {};
  return { "aria-pressed": pressed, "data-tug-toggle": "" };
}

export const TugPushButton = React.forwardRef<HTMLButtonElement, TugPushButtonProps>(
  function TugPushButton({ className, pressed, ...rest }: TugPushButtonProps, ref) {
    return (
      <TugButton
        ref={ref}
        data-slot="tug-push-button"
        className={cn("tug-push-button", className)}
        {...rest}
        {...tugPushButtonToggleAttributes(pressed)}
      />
    );
  }
);
