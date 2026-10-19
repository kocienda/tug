/**
 * The action handler map and the registered ResponderChainManager — the two
 * pieces of `action-dispatch` state that modules below it need to read.
 *
 * `action-dispatch` imports the command funnel, focus transfer, and the
 * sidebar toggles to wire its handlers, and those modules in turn need the
 * handler map (`dispatchCommand`'s `registry` routing target) and the chain
 * manager. Held here, in a module that imports none of them, they can read
 * both without importing `action-dispatch`. `action-dispatch` re-exports
 * every symbol here, so its callers are unchanged.
 *
 * @module action-registry
 */

import type { ResponderChainManager } from "./components/tugways/responder-chain";
import { COMMANDS_BY_ID } from "@/components/tugways/command-registry";

/** Handler function for an action */
export type ActionHandler = (payload: Record<string, unknown>) => void;

/** Map of action names to handler functions */
const handlers = new Map<string, ActionHandler>();

/**
 * Module-level reference to the ResponderChainManager, populated by
 * ResponderChainProvider on mount via `registerResponderChainManager`.
 *
 * Used by the `add-card-to-active-pane` and `show-component-gallery` Control-frame actions
 * to dispatch through the responder chain, which routes them to DeckCanvas's
 * registered handlers.
 *
 * [D06] Add-tab action uses DeckManager + responder chain
 * [D09] Add-tab routed as DeckCanvas responder action
 */
let responderChainManagerRef: ResponderChainManager | null = null;

/**
 * Register the ResponderChainManager from ResponderChainProvider.
 * Called by ResponderChainProvider on mount so the `add-tab` and
 * `show-component-gallery` action handlers can dispatch through the chain.
 *
 * Last-registration-wins: calling again replaces the previous manager.
 *
 * [D06] Add-tab action uses DeckManager + responder chain
 */
export function registerResponderChainManager(manager: ResponderChainManager): void {
  responderChainManagerRef = manager;
}

/**
 * Get the registered ResponderChainManager, or `null` if
 * `ResponderChainProvider` has not mounted (standalone gallery use,
 * unit tests, the brief pre-mount window).
 *
 * Lets non-React modules — e.g. the CM6 caret layer's dev-only
 * focus/first-responder invariant probe — read first-responder state
 * without threading the manager through React context.
 */
export function getResponderChainManager(): ResponderChainManager | null {
  return responderChainManagerRef;
}

/**
 * Register an action handler.
 *
 * A handler whose name is a *chain-routed* registry command would be
 * unreachable from the wire — the fork in `dispatchAction` reroutes
 * such frames through `dispatchCommand`, which dispatches into the chain
 * and never consults this map. Registration is runtime, so no static lint
 * can see the collision; this warning is where it surfaces.
 */
export function registerAction(action: string, handler: ActionHandler): void {
  const routing = COMMANDS_BY_ID.get(action)?.routing;
  if (routing !== undefined && routing !== "registry") {
    console.warn(
      `registerAction: "${action}" is a ${routing}-routed command; control frames named this will never reach this handler`,
    );
  }
  handlers.set(action, handler);
}

/**
 * The handler registered for an action, or `undefined`.
 *
 * This is the `registry` routing target: `dispatchCommand` reaches a
 * command whose body lives here without importing `initActionDispatch`.
 */
export function getRegistryHandler(action: string): ActionHandler | undefined {
  return handlers.get(action);
}

/**
 * Clear the handler map and the manager slot. Called by `action-dispatch`'s
 * `_resetForTest`; internal/test-only.
 */
export function _resetActionRegistryForTest(): void {
  handlers.clear();
  responderChainManagerRef = null;
}
