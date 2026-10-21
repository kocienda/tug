/**
 * Verbs that cross the bus.
 *
 * - **A command** (`command`). A command row whose owner is the key card
 *   (`ownerOf`, `bus/command-route.ts`) dispatched in the shell while a body
 *   card is key runs in that card's body, against its own chain and
 *   registry. One action carries every such row: the command table stays
 *   the place commands are named.
 * - **The keyboard walk** (`focus.enter`, `focus.exit`). A body card's Tab
 *   walk is split: its own stops in its body, its chrome's in the shell. A
 *   walk that runs off a body's end says so to the shell (`focus.exit`),
 *   and one the shell hands into the body says at which end (`focus.enter`).
 * - **The verbs the shell asks of a card's body**, each the body's to run
 *   because what it acts on lives there: a press in, or the dismissal of,
 *   the surface the shell draws for it (`surface.*`); a chain action for the
 *   card's content (`card.contentAction`); a line revealed in a Text card
 *   (`text.revealLine`); a Settings section shown (`settings.reveal`); a
 *   jot captured (`jots.newJot`); a session the shell decided for the card
 *   after handing it off (`session.intent`); a refusal its modal hold
 *   speaks (`card.refuseHold`); Escape's shrink of the Cards table
 *   (`cards.shrink`); the shell's log for a devtools card
 *   (`devtools.logEntries`). Each is held for a card whose page has not said
 *   hello, and delivered behind the stores it reads.
 * - **The verbs a body asks of the shell**, which holds the deck: a command
 *   its own chain did not answer (`command.shell`); its card activated,
 *   closed, or given a sibling (`card.activate`, `card.close`,
 *   `card.addSibling`); a logout, which only the shell mounts
 *   (`app.logout`).
 * - **The two questions the shell asks a card's body**, each waiting on a
 *   person in the card: a question from outside the turn stream, shown in a
 *   Session card's dialog (`session.ask`), and whether a guarded close goes
 *   ahead (`card.closeDecision`).
 *
 * `bus.ping`, `bus.note` and `bus.probe` are the library's own: one of each
 * primitive, answered by nothing in the product, so a page can be probed
 * through the eval door and the conformance tests always have a row of each
 * kind to read.
 *
 * @module bus/declarations/verbs
 */

import type { PendingAsk } from "../../lib/code-session-store/types";
import { arr, bool, empty, literal, num, obj, opaque, optional, str } from "../codec";
import { defineAction } from "../routed-action";
import { defineRequest } from "../request";
import { defineSharedStore } from "../shared-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- Commands ----

/** A command row's id and the payload its dispatch carried. */
export interface CommandPayload {
  id: string;
  payload?: Record<string, unknown>;
}

/** Run a command in the key card's body (`ownerOf` says `"key-card"`). */
export const commandForCard = defineAction<CommandPayload>({
  id: "command",
  owner: "card",
  codec: obj({ id: str, payload: optional(opaque(isRecord, {})) }),
});

/**
 * Run a command in the shell that a body's own chain did not answer. Its key
 * is not `command`'s because keys are one namespace and an action has one
 * owner; the shell runs it as a local dispatch, so it never comes back.
 */
export const commandForShell = defineAction<CommandPayload>({
  id: "command.shell",
  owner: "shell",
  codec: obj({ id: str, payload: optional(opaque(isRecord, {})) }),
});

// ---- What a body asks of the shell's deck ----

/**
 * Make the sending body's card the key card. `reveal: false` is the
 * pointer's activation, which slides no strip under the hand
 * (`CardDeck.activateCard`); absent, the activation reveals.
 */
export const cardActivate = defineAction({
  id: "card.activate",
  owner: "shell",
  codec: obj({ reveal: optional(bool) }),
});

/** Close the sending body's card, through the deck's close guards. */
export const cardClose = defineAction({
  id: "card.close",
  owner: "shell",
  codec: empty,
});

/** Add a card of `componentId` to the sending body's pane. */
export const cardAddSibling = defineAction({
  id: "card.addSibling",
  owner: "shell",
  codec: obj({ componentId: str }),
});

/** Run the app's logout, which only the shell mounts. */
export const appLogout = defineAction({
  id: "app.logout",
  owner: "shell",
  codec: empty,
});

// ---- What the shell asks a card's body ----

function isPendingAsk(value: unknown): value is PendingAsk {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === "string" &&
    typeof value.title === "string" &&
    (value.description === null || typeof value.description === "string") &&
    Array.isArray(value.options) &&
    value.options.every((o) => isRecord(o) && typeof o.value === "string" && typeof o.label === "string") &&
    (value.unattendedChoice === null || typeof value.unattendedChoice === "string") &&
    (value.countdownSecs === null || typeof value.countdownSecs === "number")
  );
}

/** Where a question shown in a Session card's body ends: the person answers its dialog. */
export const SESSION_ASK_EXIT = "the ask dialog in the Session card";

/**
 * Show a question in a Session card's dialog and wait for the choice. It
 * stands across a reload of the card's page, and the shell withdraws it to
 * take the dialog down.
 */
export const sessionAsk = defineRequest({
  id: "session.ask",
  owner: "card",
  codec: opaque(isPendingAsk, {
    requestId: "r",
    title: "t",
    description: null,
    options: [{ value: "v", label: "l" }],
    unattendedChoice: null,
    countdownSecs: null,
  } as PendingAsk),
  replyCodec: obj({ choice: str }),
  onDetach: "redeliver",
});

/** How long the shell waits on a close decision whose guard said it would not ask. */
export const CLOSE_DECISION_MS = 2000;

/** Where a close decision whose guard asks ends: the person answers the card's close sheet. */
export const CLOSE_DECISION_EXIT = "the close sheet in the card";

/** Ask a card's own close guard whether its close goes ahead. */
export const cardCloseDecision = defineRequest({
  id: "card.closeDecision",
  owner: "card",
  codec: empty,
  replyCodec: obj({ answer: literal("close", "cancel") }),
  onDetach: "fail",
});

// ---- The keyboard walk ----

/** The shell hands the card's walk into its body, at its first or last stop. */
export const focusEnter = defineAction({
  id: "focus.enter",
  owner: "card",
  codec: obj({ edge: literal("first", "last") }),
});

/**
 * A body's walk ran off an end. `empty`: the body holds no stop at all, so
 * the shell keeps the walk rather than handing it back.
 */
export const focusExit = defineAction<{ direction: "next" | "previous"; empty?: boolean }>({
  id: "focus.exit",
  owner: "shell",
  codec: obj({ direction: literal("next", "previous"), empty: optional(bool) }),
});

// ---- What the shell asks of a card's body ----

/** A press in the surface the shell draws for the card, at the pressed node's child-index path. */
export const surfaceActivate = defineAction({
  id: "surface.activate",
  owner: "card",
  codec: obj({ path: arr(num) }),
});

/** The shell dismissed the surface it draws for the card. */
export const surfaceDismissed = defineAction({
  id: "surface.dismissed",
  owner: "card",
  codec: empty,
});

/**
 * The shell rang the card's pane (`flash-pane-border.ts`), or its ring went
 * out: the card's page lights or puts out the same ring on the frame it draws,
 * which is the one the reader sees.
 */
export const cardFlash = defineAction({
  id: "card.flash",
  owner: "card",
  codec: obj({ lit: bool }),
});

/** A chain action for the card's content responder, which lives in its body. */
export const cardContentAction = defineAction({
  id: "card.contentAction",
  owner: "card",
  codec: obj({ action: str }),
});

function isColumns(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");
}

/** An open of the file a Text card holds: the line asked for, revealed in its editor. */
export const textRevealLine = defineAction<{ line: number; endLine?: number; columns?: [number, number] }>({
  id: "text.revealLine",
  owner: "card",
  codec: obj({ line: num, endLine: optional(num), columns: optional(opaque(isColumns, [0, 0] as [number, number])) }),
});

/** A section the Settings card is to show. Validated against the sections where it is shown. */
export const settingsReveal = defineAction({
  id: "settings.reveal",
  owner: "card",
  codec: obj({ section: str }),
});

/** ⌘J's capture: a fresh jot, its editor open, in the Jots card's own store. */
export const jotsNewJot = defineAction({
  id: "jots.newJot",
  owner: "card",
  codec: empty,
});

/**
 * A session the shell decided for a card already in its body — a harness
 * spawn, a resume asked for from another card — replayed there. The body
 * parses the intent itself (`parseBodyIntent`), as it parses the one it was
 * bound with.
 */
export const sessionIntent = defineAction({
  id: "session.intent",
  owner: "card",
  codec: opaque((v: unknown): v is Record<string, unknown> & { kind: string } => isRecord(v) && typeof v.kind === "string", {
    kind: "restore",
  }),
});

/** A door in the shell met the card's modal hold: the run holding it speaks the refusal. */
export const cardRefuseHold = defineAction({
  id: "card.refuseHold",
  owner: "card",
  codec: empty,
});

/** Escape's shrink met a layout selection: the Cards table runs where its filter is. */
export const cardsShrink = defineAction({
  id: "cards.shrink",
  owner: "card",
  codec: empty,
});

/** The shell's log, for a devtools card's Log tab: entries as relayed, their ids left to the page. */
export const devtoolsLogEntries = defineAction({
  id: "devtools.logEntries",
  owner: "card",
  codec: obj({ entries: opaque(Array.isArray as (v: unknown) => v is unknown[], [] as unknown[]) }),
});

/** Ask a card's body to answer: the round trip, with its own deadline. */
export const busPing = defineRequest({
  id: "bus.ping",
  owner: "card",
  codec: obj({ sentAt: num }),
  replyCodec: obj({ sentAt: num }),
  onDetach: "fail",
});

/** A line for the shell's dev log, from any body. */
export const busNote = defineAction({
  id: "bus.note",
  owner: "shell",
  codec: obj({ text: str }),
});

/** A number the shell publishes to every body. */
export const busProbe = defineSharedStore({
  key: "bus.probe",
  owner: "shell",
  scope: { deck: true },
  codec: num,
  initial: 0,
});
