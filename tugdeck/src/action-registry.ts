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
import { TUG_ACTIONS } from "@/lib/action-vocabulary";

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
 * The deck actions a card may ask of the shell by name, though no command
 * names them. Each is a verb over a sampled target — a menu's session, a
 * right-clicked command line — whose work needs the deck and the connection,
 * which only the shell's `initActionDispatch` holds; a body registers none
 * of them, and the shell runs only these for a body.
 */
export const SHELL_ACTIONS_FOR_CARDS: ReadonlySet<string> = new Set<string>([
  TUG_ACTIONS.RESUME_SESSION,
  TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION,
  // The Overview composer's draft, held app-scoped in the shell across the
  // rail hidden and shown (`HOLD_OVERVIEW_DRAFT`, `overview-composer-draft.ts`;
  // spelled here because that module imports this one).
  "hold-overview-draft",
]);

/**
 * Takes a {@link SHELL_ACTIONS_FOR_CARDS} action this page has no handler
 * for, and says whether it took it. A body installs one that hands the
 * action to the shell; the shell, which registers them, installs none.
 */
export type ShellActionForwarder = (action: string, payload: Record<string, unknown>) => boolean;

let shellActionForwarder: ShellActionForwarder | null = null;

/** Install the forwarder for shell actions. Returns the uninstall. */
export function setShellActionForwarder(forwarder: ShellActionForwarder): () => void {
  shellActionForwarder = forwarder;
  return () => {
    if (shellActionForwarder === forwarder) shellActionForwarder = null;
  };
}

/**
 * Run one of the {@link SHELL_ACTIONS_FOR_CARDS} from whichever page the
 * card stands in, and say whether anything took it: this page's handler
 * where it has one (the shell), else the forwarder (a body, to the shell).
 * Calling the page's own registry handler from a body was a silent no-op.
 */
export function dispatchShellAction(action: string, payload: Record<string, unknown>): boolean {
  const handler = handlers.get(action);
  if (handler !== undefined) {
    handler(payload);
    return true;
  }
  if (!SHELL_ACTIONS_FOR_CARDS.has(action) || shellActionForwarder === null) {
    console.warn(`dispatchShellAction: ${action} has no handler in this page`, payload);
    return false;
  }
  return shellActionForwarder(action, payload);
}

/**
 * The shell's side of {@link dispatchShellAction}: run `id` when it is one
 * of the {@link SHELL_ACTIONS_FOR_CARDS} a body handed over, and say whether
 * it was one. Anything else a body hands over is a command, for the funnel.
 */
export function runShellActionForCard(id: string, payload: Record<string, unknown> | undefined): boolean {
  if (!SHELL_ACTIONS_FOR_CARDS.has(id)) return false;
  const handler = handlers.get(id);
  if (handler === undefined) console.warn(`runShellActionForCard: ${id} has no handler in the shell`, payload);
  else handler(payload ?? {});
  return true;
}

/**
 * Clear the handler map and the manager slot. Called by `action-dispatch`'s
 * `_resetForTest`; internal/test-only.
 */
export function _resetActionRegistryForTest(): void {
  handlers.clear();
  responderChainManagerRef = null;
  shellActionForwarder = null;
}
