/**
 * Which page runs a command, and how the shell hands one to the key card's
 * body.
 *
 * A command row says who runs it ({@link ownerOf}): the shell, the key card,
 * or AppKit. A key-card command dispatched in the shell while the key card is
 * a body card runs in that card's body, whose chain and registry hold the
 * card's responders; the shell's chain holds only the card's placeholder.
 * Which body, if any, is the shell's key-card route's to say — the deck's
 * first-responder card, when it is a body card and no shell surface holds the
 * chain ahead of it (`bodyCommandRoute`). `installBodyShell` installs it once.
 * With none installed — a body page, a unit test, a shell with no bodies —
 * every command runs where it was dispatched.
 *
 * The same route takes the shell's Tab walk where it runs off the end of the
 * shell's own stops of a body card ({@link keyCardWalkEdge}).
 *
 * The other way, a command a body's own chain did not answer goes to the
 * shell ({@link forwardToShell}), whose chain holds the pane and the deck,
 * and which runs it as a local dispatch so it is never sent back.
 *
 * @module bus/command-route
 */

import { COMMANDS_BY_ID, type CommandEntry } from "../components/tugways/command-registry";
import { bodyUnhandledRoute } from "../lib/body-command-route";
import { TUG_ACTIONS } from "../lib/action-vocabulary";
import { commandForCard, commandForShell } from "./declarations/verbs";
import { page } from "./page";

/** Who runs a command: the shell, the key card (in its body when it is one), or AppKit. */
export type CommandOwner = "shell" | "key-card" | "here";

/**
 * The row's owner: its explicit `owner`, or else what its routing implies —
 * a chain routing is the key card's, `registry` the shell's, `native`
 * AppKit's, here.
 */
export function ownerOf(entry: Pick<CommandEntry, "routing" | "owner">): CommandOwner {
  if (entry.owner !== undefined) return entry.owner;
  switch (entry.routing) {
    case "first-responder":
    case "key-card":
    case "target":
      return "key-card";
    case "registry":
      return "shell";
    case "native":
      return "here";
  }
}

/** The shell's answers about the key card, which only it can give. */
export interface KeyCardRoute {
  /** The body card a key-card command goes to now, or null to run it in the shell. */
  target(entry: Pick<CommandEntry, "id" | "routing" | "owner">): string | null;
  /** A command went to `cardId`'s body: the keyboard follows it there. */
  sent(cardId: string): void;
  /** The shell's walk ran off an end of its stops: whether a body took the step. */
  walkEdge(direction: 1 | -1): boolean;
}

let installed: KeyCardRoute | null = null;

/** Install the shell's key-card route. Returns the uninstall. */
export function installKeyCardRoute(route: KeyCardRoute): () => void {
  installed = route;
  return () => {
    if (installed === route) installed = null;
  };
}

/**
 * Send a key-card command to the key card's body, if the route names one,
 * and say whether it went. The body runs it as its own dispatch.
 */
export function routeToKeyCard(
  entry: Pick<CommandEntry, "id" | "routing" | "owner">,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (installed === null) return false;
  const cardId = installed.target(entry);
  if (cardId === null) return false;
  commandForCard.dispatch({ id: entry.id, ...(payload !== undefined ? { payload } : {}) }, { card: cardId });
  installed.sent(cardId);
  return true;
}

/** Offer the step off the end of the shell's walk to the key body; whether it was taken. */
export function keyCardWalkEdge(direction: 1 | -1): boolean {
  return installed !== null && installed.walkEdge(direction);
}

/**
 * In a bound body, hand the shell a command this page's chain did not
 * answer, and say whether this page should count it handled.
 *
 * `bodyUnhandledRoute` filters it: Undo and Redo are declined, since an
 * edit history is the focused surface's and what is left unanswered here is
 * a native control's; Cancel is sent and not claimed, so the key goes on to
 * the surface in this page that owns it while the shell's chain may still
 * take Escape's last rung. Anything else is sent and claimed. In the shell,
 * or in a body with no card yet, nothing is sent.
 */
export function forwardToShell(
  entry: Pick<CommandEntry, "id">,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (!page.isBody || page.cardId === null) return false;
  const route = bodyUnhandledRoute(entry.id);
  if (route === "decline") return false;
  commandForShell.dispatch({ id: entry.id, ...(payload !== undefined ? { payload } : {}) });
  return route === "forward";
}

/**
 * A targeted dispatch that walked off a bound body's root unanswered: when
 * its action is a command row, the shell runs it, and the walk counts it
 * handled. A control sends its own action to its parent responder, and in
 * a body that action's handler may be the deck's, which the shell holds.
 * Cancel is not sent: a dialog's own Escape is never the shell's.
 */
export function forwardUnansweredTarget(event: { action: string; value?: unknown }): boolean {
  if (!page.isBody || page.cardId === null) return false;
  const entry = COMMANDS_BY_ID.get(event.action);
  if (entry === undefined || entry.id === TUG_ACTIONS.CANCEL_DIALOG) return false;
  commandForShell.dispatch({ id: entry.id, ...(event.value !== undefined ? { payload: { value: event.value } } : {}) });
  return true;
}
