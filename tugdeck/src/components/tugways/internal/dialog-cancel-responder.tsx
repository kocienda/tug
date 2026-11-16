/**
 * DialogCancelResponder — makes an open app-modal panel the overlay page's
 * first responder for `cancelDialog`, so Escape and ⌘. close it.
 *
 * The keyboard's Escape reaches the overlay page as the `cancelDialog`
 * command, dispatched to the first responder at capture; a command nothing
 * answers is forwarded to the shell and counted handled. So a panel that
 * leaned on Radix's own `onEscapeKeyDown` never heard Escape at all — the
 * Configure Tug and Update Tug wizards both stayed up (#173).
 *
 * Mounted INSIDE the panel's content, so it is registered only while the
 * panel is: a responder registered by a closed panel's component has no
 * element, and the chain auto-promotes the first root responder it is given,
 * which left such a hidden responder answering every Escape in the overlay.
 * While mounted it claims the first responder outright, the way an open sheet
 * does ([D126]): focus-in promotion from the panel's key sink is not
 * something the panel can count on. A first responder already inside the
 * panel keeps it.
 *
 * The wrapper is `display: contents`, so the panel's layout is its children's.
 */

import { type ReactNode, useId, useLayoutEffect, useRef } from "react";

import { TUG_ACTIONS } from "../action-vocabulary";
import { useResponderChain } from "../responder-chain-provider";
import { useOptionalResponder } from "../use-responder";
import "../tug-alert.css";

export interface DialogCancelResponderProps {
  /** The panel's Escape / ⌘. — the same act as its own way out. */
  onCancel: () => void;
  children: ReactNode;
}

export function DialogCancelResponder({ onCancel, children }: DialogCancelResponderProps) {
  const id = useId();
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const { responderRef } = useOptionalResponder({
    id,
    actions: { [TUG_ACTIONS.CANCEL_DIALOG]: () => onCancelRef.current() },
  });
  const manager = useResponderChain();
  useLayoutEffect(() => {
    if (manager === null || !manager.hasResponder(id)) return;
    const current = manager.getFirstResponder();
    if (current !== null && manager.nodeIsWithin(current, id)) return;
    manager.makeFirstResponder(id);
  }, [manager, id]);
  return (
    <div ref={responderRef} className="tug-dialog-cancel-responder">
      {children}
    </div>
  );
}
