/**
 * settlePickedPath — deliver a native picker's choice to the file chooser's
 * host, if the host is still there to take it.
 *
 * Internal building block — app code should use `TugFileChooser` instead.
 *
 * The picker is the system's file panel, and it stays up for as long as the
 * user leaves it there. The chooser's host can go away in that time — Open
 * Quickly dismissed, a Configure Tug step advanced, the card closed — and a
 * targeted dispatch to a responder that has unregistered throws: that is the
 * chain's contract, and it catches real wiring errors elsewhere. So the guard
 * is here, at the one dispatch that can outlive its sender: the choice is
 * delivered only when the chooser is still mounted and its target is still
 * registered, and is otherwise dropped, as the callback this replaced did.
 *
 * Laws: [L11] the choice travels the chain to the parent responder, as a
 * `set-value` `change` and then `commit`.
 *
 * @module components/tugways/internal/file-chooser-browse
 */

import { TUG_ACTIONS } from "../action-vocabulary";
import type { ResponderChainManager } from "../responder-chain";

/** Where the choice would go, read at the moment it arrives. */
export interface PickedPathTarget {
  /** Whether the chooser that opened the picker is still mounted. */
  mounted: boolean;
  /** The page's responder chain, or `null` outside a provider. */
  manager: ResponderChainManager | null;
  /** The chooser's parent responder, or `null` outside one. */
  parentId: string | null;
}

/**
 * Wait for the picker's choice and, if the target still stands, settle the
 * field on it. Resolves `true` when the choice was dispatched and `false`
 * when it was cancelled or dropped. Never rejects over a host that is gone.
 */
export async function settlePickedPath(
  picked: Promise<string | null>,
  sender: string,
  target: () => PickedPathTarget,
): Promise<boolean> {
  const path = await picked;
  if (path === null) return false;
  const { mounted, manager, parentId } = target();
  if (!mounted || manager === null || parentId === null) return false;
  if (!manager.hasResponder(parentId)) return false;
  // Choosing in the native panel is a finished act, not a keystroke: the
  // panel closes on a path the user picked deliberately, and focus comes
  // back to a field that is already done. It settles on the spot — there
  // is no later gesture that would.
  manager.sendToTarget(parentId, { action: TUG_ACTIONS.SET_VALUE, value: path, sender, phase: "change" });
  manager.sendToTarget(parentId, { action: TUG_ACTIONS.SET_VALUE, value: path, sender, phase: "commit" });
  return true;
}
