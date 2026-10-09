/**
 * command-dispatch.ts — funnel #1: the one front door every command goes
 * through.
 *
 * A command can arrive from a Swift menu item's control frame, a chord, a
 * button, or a slash bridge. Each of those resolves a command id and calls
 * `dispatchCommand`; the mechanism that carries it to its implementation is
 * read from the registry entry's `routing` field rather than chosen at the
 * call site ([P04]).
 *
 * ## Validation gates doors, not dispatch
 *
 * `validateCommand` answers whether a command is applicable right now, and
 * its consumers are the surfaces that show a command: the native menu's
 * enablement mirror, buttons, context menus. `dispatchCommand` does not
 * consult it — the responder that would perform the command is the thing
 * that decides what happens, and a command nobody handles is already a
 * silent no-op at the end of the chain walk. This is Cocoa's split:
 * `validateUserInterfaceItem:` dims the door; `sendAction:` just sends.
 */

import type {
  CommandEntry,
} from "@/components/tugways/command-registry";
import {
  COMMANDS_BY_ID,
  commandAction,
  commandWire,
} from "@/components/tugways/command-registry";
import {
  getRegistryHandler,
  getResponderChainManager,
} from "./action-dispatch";

/** Notified after every dispatch, handled or not. */
export type CommandObserver = (id: string, handled: boolean) => void;

const observers = new Set<CommandObserver>();

/** Observe every command dispatch. Returns an unsubscribe. */
export function observeCommands(observer: CommandObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

function notifyCommandObservers(id: string, handled: boolean): void {
  for (const observer of observers) observer(id, handled);
}

/**
 * The record a `registry` handler receives. An entry with a static payload
 * object ([P05]) overlays it on the caller's frame, so the handler sees the
 * same fields the Swift wire would have sent.
 */
function registryPayload(
  entry: CommandEntry,
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base = payload ?? {};
  if (typeof entry.payload === "object" && entry.payload !== null) {
    return { ...base, ...(entry.payload as Record<string, unknown>) };
  }
  return base;
}

/**
 * The `ActionEvent.value` a chain dispatch carries.
 *
 * Three shapes reach here, in priority order:
 *
 * 1. The entry's static payload — a per-value row ([P05]) says what it
 *    carries and no caller may override it.
 * 2. The caller's `value` — what a chain-native caller sends, and the shape
 *    a context-menu item or a button uses.
 * 3. The caller's remaining fields — what a **control frame** sends. The
 *    host's `sendControl(action, params:)` puts its parameters at the top
 *    level of the frame (`{ action: "focus-pane", paneId: "p1" }`), because
 *    that is the wire the registered handlers were written against. A
 *    command that has since moved onto a responder still has to receive
 *    them, so the frame's own fields become the value rather than being
 *    dropped on the floor.
 *
 * `action` is stripped: it is the frame's envelope, not a parameter, and a
 * handler reading it back would be reading its own name.
 */
function resolveValue(
  entry: CommandEntry,
  payload: Record<string, unknown> | undefined,
): unknown {
  if (entry.payload !== undefined) return entry.payload;
  if (payload === undefined) return undefined;
  if (payload.value !== undefined) return payload.value;
  const { action: _envelope, ...params } = payload;
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Dispatch a command by id. Returns whether anything handled it.
 *
 * An unknown id warns and returns unhandled — the same posture
 * `dispatchAction` takes for an unregistered wire.
 */
export function dispatchCommand(
  id: string,
  payload?: Record<string, unknown>,
): boolean {
  const entry = COMMANDS_BY_ID.get(id);
  if (entry === undefined) {
    console.warn(`dispatchCommand: unknown command: ${id}`, payload);
    // Observers hear this one too — a typo'd id is exactly the failed
    // dispatch an observer counting failures most wants to see.
    notifyCommandObservers(id, false);
    return false;
  }

  if (entry.routing === "registry") {
    const handler = getRegistryHandler(commandWire(entry));
    if (handler === undefined) {
      console.warn(`dispatchCommand: ${id} has no registered handler`);
      notifyCommandObservers(id, false);
      return false;
    }
    handler(registryPayload(entry, payload));
    notifyCommandObservers(id, true);
    return true;
  }

  if (entry.routing === "native") {
    // AppKit performs these; the entry exists so the keymap UI can show
    // Hide, Quit, Minimize and the NSText five rather than leaving them
    // as commands the user cannot find.
    console.warn(`dispatchCommand: ${id} is performed natively and is not JS-routable`);
    notifyCommandObservers(id, false);
    return false;
  }

  const manager = getResponderChainManager();
  if (manager === null) {
    console.warn(`dispatchCommand: ${id}: responder chain manager not registered yet`);
    notifyCommandObservers(id, false);
    return false;
  }

  const action = commandAction(entry);
  if (action === null) {
    console.warn(`dispatchCommand: ${id} declares no chain action`);
    notifyCommandObservers(id, false);
    return false;
  }

  const event = {
    action,
    value: resolveValue(entry, payload),
    phase: "discrete",
  } as const;

  let handled = false;
  switch (entry.routing) {
    case "first-responder": {
      // Continuation-aware, and the continuation runs immediately. Handlers
      // built for the in-app context menu defer their visible side effect
      // into a returned continuation so it lands after the menu blink; a
      // native menu round-trip arrives after AppKit already played its own
      // blink, so there is nothing left to defer past.
      const result = manager.sendToFirstResponderForContinuation(event);
      result.continuation?.();
      handled = result.handled;
      break;
    }
    case "key-card": {
      // Continuation-aware for the same reason first-responder is: a handler
      // that defers its visible work into a continuation gets that work run.
      // `sendToKeyCard` drops it, which would be a silent no-op for exactly
      // the handlers careful enough to two-phase themselves.
      const result = manager.sendToKeyCardForContinuation(event);
      result.continuation?.();
      handled = result.handled;
      break;
    }
    case "target": {
      const targetId = payload?.targetId;
      if (typeof targetId !== "string") {
        console.warn(`dispatchCommand: ${id} needs a targetId on its payload`, payload);
        break;
      }
      // `sendToTarget` throws on an unregistered target ([D03]); a target
      // named by a stale id (a row outliving its pane by a frame) is an
      // unhandled dispatch here, not an exception in the emitter's click
      // handler.
      if (!manager.hasResponder(targetId)) {
        console.warn(`dispatchCommand: ${id}: target ${targetId} is not registered`);
        break;
      }
      handled = manager.sendToTarget(targetId, event);
      break;
    }
  }

  notifyCommandObservers(id, handled);
  return handled;
}

/**
 * Validity and state live on the table itself — every surface that shows a
 * command asks the same function there. Re-exported here because this is
 * the module a caller reaches for when it is thinking about commands.
 */
export {
  queryCommandState,
  validateCommand,
  validateCommandId,
} from "@/components/tugways/command-registry";
