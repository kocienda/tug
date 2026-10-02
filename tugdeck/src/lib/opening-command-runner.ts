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
import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";
import { logSessionLifecycle } from "./session-lifecycle-log";

/** How long the runner waits for the command catalog before sending anyway. */
export const CATALOG_WAIT_MS = 5000;

/** A command to run: the bare name (no slash) and its argument text. */
export interface OpeningCommand {
  name: string;
  args: string;
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
 * Send `command` as the session's first turn as soon as it can go. Returns
 * the disposer, which the services bag calls when it is torn down; firing
 * disposes the runner too, so it sends at most once.
 */
export function runOpeningCommand(
  cardId: string,
  command: OpeningCommand,
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
    const catalog = sessionMetadataStore.getSnapshot().slashCommands.map((c) => c.name);
    if (catalog.length === 0 && !catalogDeadlinePassed) return;
    const payload = openingCommandPayload(command, catalog);
    dispose();
    logSessionLifecycle("opening_command.sent", {
      card_id: cardId,
      name: payload.atoms[0]?.value,
      catalog_size: catalog.length,
    });
    codeSessionStore.send(payload.text, payload.atoms);
  };

  unsubscribes.push(codeSessionStore.subscribe(tryFire));
  unsubscribes.push(sessionMetadataStore.subscribe(tryFire));
  deadline = setTimeout(() => {
    deadline = null;
    catalogDeadlinePassed = true;
    logSessionLifecycle("opening_command.catalog_deadline", {
      card_id: cardId,
      name: command.name,
    });
    tryFire();
  }, CATALOG_WAIT_MS);
  logSessionLifecycle("opening_command.armed", { card_id: cardId, name: command.name });
  tryFire();
  return dispose;
}
