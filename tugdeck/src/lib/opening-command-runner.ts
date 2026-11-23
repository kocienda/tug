/**
 * opening-command-runner — a card opened to run a command runs it.
 *
 * Run in New Session opens a Session card whose whole reason to exist is one
 * command. That command used to travel the reader's road: seeded into the new
 * card's composer, then submitted by the composer once the card could send.
 * The road has too many places to lose a passenger on a card that is still
 * being born — the composer mounts, restores a saved draft, remounts under a
 * transport flip — and every one of those losses looked the same: an empty
 * card with nothing to say why.
 *
 * This card is ours from the first frame, so its first turn is too. The runner
 * belongs to the card's services bag, watches the two stores that decide
 * whether the turn can go — the session (replay done, able to submit) and its
 * metadata (the command catalog, which names the qualified command claude
 * expands) — and sends the command itself, once, the moment both say yes. No
 * composer, no React, no effect ordering.
 *
 * The payload is the one a typed command line produces: a leading command atom
 * carrying the catalog's qualified name, the arguments as text, and each
 * `@path` mention as the file atom the `@` completion would have placed — so
 * the transcript row and the wire bytes are a typed command's.
 *
 * The catalog normally lands with the session's first handshake. If it has not
 * landed by {@link CATALOG_WAIT_MS} the command goes out under the name it was
 * written with rather than waiting forever ([L31]: a deadline, said in the
 * lifecycle log, never a silent stall).
 *
 * @module lib/opening-command-runner
 */

import type { CodeSessionStore } from "./code-session-store";
import type { SessionMetadataStore } from "./session-metadata-store";
import { atomizeCommandArgs } from "./command-atom";
import { resolveRemoteCommand } from "./slash-supported";
import type { AtomSegment } from "./tug-atom-img";
import { TUG_ATOM_CHAR } from "./tug-atom-char";
import { logSessionLifecycle } from "./session-lifecycle-log";

/** How long the runner waits for the command catalog before sending anyway. */
export const CATALOG_WAIT_MS = 5000;

let catalogWaitMs = CATALOG_WAIT_MS;

/**
 * Test-only: shorten the catalog wait, so a test of the deadline does not
 * spend five real seconds on it. Restore with {@link CATALOG_WAIT_MS}.
 */
export function _setCatalogWaitMsForTest(ms: number): void {
  catalogWaitMs = ms;
}

/** A command to run: the bare name (no slash) and its argument text. */
export interface OpeningCommand {
  name: string;
  args: string;
}

/**
 * A card's first turn: a command (a leading command atom and its arguments)
 * or a plain prompt, which is sent as typed text with no atoms and so has no
 * catalog to wait for.
 */
export type Opening =
  | ({ kind: "command" } & OpeningCommand)
  | { kind: "prompt"; text: string };

/**
 * Read an opening from an untyped value: the union's two shapes, and a bare
 * `{name, args}` — the shape before prompts existed — as a command. Anything
 * else is `undefined`.
 */
export function parseOpening(value: unknown): Opening | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const r = value as { kind?: unknown; name?: unknown; args?: unknown; text?: unknown };
  if (r.kind === "prompt") {
    return typeof r.text === "string" && r.text.trim().length > 0
      ? { kind: "prompt", text: r.text }
      : undefined;
  }
  if (r.kind !== undefined && r.kind !== "command") return undefined;
  if (typeof r.name !== "string" || r.name.length === 0 || typeof r.args !== "string") {
    return undefined;
  }
  return { kind: "command", name: r.name, args: r.args };
}

/** A one-word label for the lifecycle log: the command's name, or `prompt`. */
export function openingLabel(opening: Opening): string {
  return opening.kind === "command" ? opening.name : "prompt";
}

/**
 * The wire payload for `command`, given the catalog's names. Pure.
 *
 * The name is resolved to the catalog's qualified form (`arc` →
 * `tugplug:arc`) when the catalog names it uniquely, and left as written
 * otherwise. Exported for the pure-logic test suite.
 */
export function openingCommandPayload(
  command: OpeningCommand,
  catalogNames: readonly string[],
): { text: string; atoms: AtomSegment[] } {
  const name = resolveRemoteCommand(command.name, catalogNames) ?? command.name;
  const args = atomizeCommandArgs(command.args.trim(), TUG_ATOM_CHAR);
  const text =
    args.text.length > 0 ? `${TUG_ATOM_CHAR} ${args.text}` : TUG_ATOM_CHAR;
  return {
    text,
    atoms: [
      { kind: "atom", type: "command", label: name, value: name },
      ...args.atoms,
    ],
  };
}

/**
 * Send `opening` as the session's first turn as soon as it can go. Returns
 * the disposer, which the services bag calls when it is torn down; firing
 * disposes the runner too, so it sends at most once. A prompt goes as plain
 * text with no atoms the moment the session can submit: it names no command,
 * so the catalog has nothing to tell it.
 */
export function runOpeningCommand(
  cardId: string,
  opening: Opening,
  codeSessionStore: CodeSessionStore,
  sessionMetadataStore: SessionMetadataStore,
): () => void {
  let done = false;
  let catalogDeadlinePassed = false;
  const unsubscribes: Array<() => void> = [];
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const dispose = (): void => {
    if (done) return;
    done = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
  };

  const tryFire = (): void => {
    if (done) return;
    const session = codeSessionStore.getSnapshot();
    if (!session.replayEverCompleted || !session.canSubmit) return;
    if (opening.kind === "prompt") {
      dispose();
      logSessionLifecycle("opening_command.sent", { card_id: cardId, name: "prompt" });
      codeSessionStore.send(opening.text, []);
      return;
    }
    const catalog = sessionMetadataStore.getSnapshot().slashCommands.map((c) => c.name);
    if (catalog.length === 0 && !catalogDeadlinePassed) return;
    const payload = openingCommandPayload(opening, catalog);
    dispose();
    logSessionLifecycle("opening_command.sent", {
      card_id: cardId,
      name: payload.atoms[0]?.value,
      catalog_size: catalog.length,
    });
    codeSessionStore.send(payload.text, payload.atoms);
  };

  unsubscribes.push(codeSessionStore.subscribe(tryFire));
  if (opening.kind === "command") {
    unsubscribes.push(sessionMetadataStore.subscribe(tryFire));
    deadline = setTimeout(() => {
      deadline = null;
      catalogDeadlinePassed = true;
      logSessionLifecycle("opening_command.catalog_deadline", {
        card_id: cardId,
        name: opening.name,
      });
      tryFire();
    }, catalogWaitMs);
  }
  logSessionLifecycle("opening_command.armed", { card_id: cardId, name: openingLabel(opening) });
  tryFire();
  return dispose;
}
