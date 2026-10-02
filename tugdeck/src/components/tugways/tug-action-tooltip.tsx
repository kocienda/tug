/**
 * TugActionTooltip — a tooltip that names a control's action and its chord.
 *
 * The pairing a control deserves when it duplicates a keyboard shortcut: a
 * phrase saying what the control does, and beside it the chord that does the
 * same thing without the mouse. The phrase is authored at the call site; the
 * chord is never authored anywhere — it is read from the keymap registry
 * through `commandShortcut`, the single renderer for a displayed shortcut
 * ([P11]).
 *
 * That asymmetry is the whole point. A hand-written "⌃⌘M" in a tooltip is a
 * second statement of a fact the command table already holds, and it has
 * nothing to disagree with until a reader believes it — which is how a context
 * menu came to advertise ⇧⌘C for a command bound to ⌥⇧⌘C. Once chords are the
 * user's to rebind, an authored string is not merely at risk of being wrong;
 * it is guaranteed wrong for anyone who rebinds.
 *
 * So this component subscribes to the registry with `useSyncExternalStore`
 * ([L02]) and re-renders when a binding changes. Rebind Auto-Message in
 * Settings and the composer's tooltip says the new chord on its next hover —
 * no reload, no second source of truth.
 *
 * ```tsx
 * <TugActionTooltip action={TUG_ACTIONS.COMMIT_AUTO_MESSAGE} content="Generate a commit message">
 *   <TugPushButton subtype="icon" onClick={draft} icon={<Wand />} />
 * </TugActionTooltip>
 * ```
 *
 * A command with no binding renders the phrase alone — the same bubble, minus
 * the chip. A control is therefore free to use this wrapper before its command
 * has a chord, and it gains the chip the day one is assigned.
 *
 * Laws: [L02] external state via useSyncExternalStore,
 *       [L11] controls emit actions; responders handle actions,
 *       [L16] pairings declared (inherited — renders TugTooltip's bubble),
 *       [L19] component authoring guide
 */

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { TugTooltip, type TugTooltipProps } from "./tug-tooltip";
import { commandShortcut, keymapRegistry } from "./keymap-registry";

/** TugActionTooltip props. */
export interface TugActionTooltipProps
  extends Omit<TugTooltipProps, "shortcut"> {
  /**
   * The command whose chord is displayed — a `TUG_ACTIONS` member, or a
   * parameterized command id (`"select-composer-route:prompt"`). When the
   * command holds no binding, no chip is rendered.
   */
  action: string;
  /**
   * The phrase describing what the control does. Authored here rather than
   * derived from the command's title, which is written for a menu ("Auto-
   * Message") and often reads wrong in a tooltip ("Generate a commit
   * message").
   */
  content: React.ReactNode;
}

/**
 * Wrap any control that duplicates a keyboard shortcut.
 *
 * Does not use forwardRef — like TugTooltip, this is a wrapper, not a DOM
 * element. The child is the Radix trigger via `asChild`; no wrapper node
 * enters the layout.
 */
export function TugActionTooltip({
  action,
  content,
  children,
  ...tooltipProps
}: TugActionTooltipProps) {
  // Re-render when a binding changes so a rebind reaches the tooltip
  // without a reload. The registry's version counter is the snapshot;
  // the value we actually want is recomputed below. [L02]
  useSyncKeymap();

  return (
    <TugTooltip {...tooltipProps} content={content} shortcut={commandShortcut(action)}>
      {children}
    </TugTooltip>
  );
}

/**
 * Subscribe to the keymap registry for its side effect on rendering.
 *
 * Exported because the same subscription is what a surface needs when it
 * renders several chords at once (a menu, a help sheet) and would otherwise
 * repeat the three arguments at every site.
 */
export function useSyncKeymap(): void {
  useSyncExternalStore(keymapRegistry.subscribe, keymapRegistry.getSnapshot, () => 0);
}
