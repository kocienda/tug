/**
 * session-command-block-registry.ts — the command-block registry for
 * `$`-route exchange rows ([P05], on the [D101] registry grammar).
 *
 * Rich rendering for shell commands accretes the way tool blocks do:
 * a module-static registry that bespoke renderers join as they ship,
 * with a total default underneath. `resolveCommandBlock(command)`
 * walks the registrations in order and returns the first whose
 * matcher claims the command; a miss lands on the generic
 * `ShellExchangeBlock` — raw output always renders, richness is
 * opt-in per command family (`git status`, `ls`, build progress —
 * follow-ons; none ship here).
 *
 * Contrast with the tool-block registry
 * (`session-assistant-renderer-dispatch.ts`): tool names are a closed,
 * case-normalized vocabulary, so that registry keys on name and
 * resolves by lookup. Commands are open-ended text, so this registry
 * keys each registration on a unique `name` (the governance handle)
 * and resolves by matcher predicate in registration order.
 *
 * # Invariants (enforced by `session-command-block-registry.test.ts`)
 *
 *  - Registration is append-only and named: re-registering a `name`
 *    throws — a double registration is always a mistake, never an
 *    override (there is no alias or bucket system to mediate one).
 *  - Resolution is total: every command resolves to a renderer; the
 *    default is the generic exchange block, never `undefined`.
 *  - No bespoke renderers ship with the skeleton ([P05]) — the
 *    registry is empty at module load.
 *
 * @module components/tugways/cards/session-command-block-registry
 */

import type React from "react";

import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import { ShellExchangeBlock } from "./shell-exchange-block";

/**
 * Props every command-block renderer receives — identical to the
 * generic `ShellExchangeBlock`'s, so the default and any bespoke
 * renderer are interchangeable at the render site.
 */
export interface CommandBlockProps {
  message: ShellExchangeMessage;
  /**
   * Add-to-context toggle ([P08]): stage this exchange to ride the next `❯`
   * submission as attributed context, or un-stage it. The one path from a
   * shell row into Claude's context. Omitted where no staged-context queue
   * is available.
   */
  onToggleContext?: () => void;
  /**
   * Send the original command to Claude as a message instead ([P09]) — the
   * auto-route undo. Rendered only for a `message.autoRouted` row.
   */
  onSendAsMessage?: () => void;
  /** Whether this exchange is currently staged (drives the toggle's pose). */
  staged?: boolean;
  /**
   * Whether a later row in this same transcript has answered what this receipt
   * says — a join receipt for the arc an `arc stopped` row named, or a later
   * arc receipt for it (Spec S04).
   *
   * **A fact derived from the session's own rows, never live feed state.** The
   * prop boundary this header describes is exactly what keeps a receipt a
   * frozen record: a renderer that subscribed to a store to ask whether the arc
   * had since joined would be reading the present into a row that reports a
   * past. The transcript already carries the later receipt, so the answer is in
   * the record — and what it changes is the row's pose, never its text.
   */
  superseded?: boolean;
}

export type CommandBlockRenderer = React.ComponentType<CommandBlockProps>;

/** Predicate over the exchange's command text (as submitted, trimmed). */
export type CommandBlockMatcher = (command: string) => boolean;

/**
 * Who a claimed row is attributed to — the speaker its entry header names.
 *
 * `shell` is the default and the literal truth for a `$`-route row: the user
 * typed a command and this is its output. `git` is for the rows that ride the
 * shell ledger without anybody having typed a shell command — the landings,
 * `/commit` and `/arc-join`, whose subject is a commit on the base branch.
 * Attributing those to the shell that carried them names the transport instead
 * of the act.
 *
 * `wheel` is for the one row nobody performed at all. An arc ends on a
 * server tick: the wheel rotated its last stage, wrote the record, and left a
 * receipt on whichever card happened to be bound. Nothing was shelled and
 * nothing was committed on the base, so neither of the other two is true of
 * it — and the row that says `Shell · exit 0 · 0ms` over a four-stage arc is
 * announcing a process that never ran.
 *
 * `tug` is the app itself speaking — neither the user, nor the model, nor the
 * wheel. A notice from tugcast reporting an act it performed on somebody's
 * files is Tug's own voice, and it wore the model's name and avatar until it
 * had a word of its own (the 2026-09-03 incident). Nothing was shelled and
 * nothing was committed by the reader, so the same chrome suppression `wheel`
 * earns applies for the same reason.
 *
 * **It lives on the registration** because a bespoke receipt already knows what
 * it is, and the alternative is a second enumeration of the same commands
 * somewhere else — which is exactly how `/arc-join` came to render its own
 * commit block under a `Shell` header while `/commit` rendered the identical
 * kind of block under a git one.
 */
export type CommandBlockAttribution = "shell" | "git" | "wheel" | "tug";

/**
 * How a claimed row occupies the transcript.
 *
 * `entry` is the default: a full transcript entry — participant header,
 * timestamp • cwd, `#s{n}` address, body, end-state — the shape every
 * `$`-route exchange has always worn. `quiet` is for the derived lines nobody
 * ran: an arc gesture's note is one sentence painted from the record
 * ([P12]), and dressing it as a command exchange announces a process that
 * never ran — a header, a command block, and an output panel wrapping one
 * line of prose. A `quiet` row renders as that line alone; the renderer owns
 * the whole of it.
 */
export type CommandBlockPresentation = "entry" | "quiet";

/** Optional facts a registration may declare beyond matcher and renderer. */
export interface CommandBlockOptions {
  /** Defaults to `shell` — see {@link CommandBlockAttribution}. */
  attribution?: CommandBlockAttribution;
  /** Defaults to `entry` — see {@link CommandBlockPresentation}. */
  presentation?: CommandBlockPresentation;
  /**
   * The projection half of `data-tugx-findable` for this row kind — the
   * text this renderer puts on screen, in the order it renders it, one
   * entry per marked container.
   *
   * A bespoke renderer does not show the exchange's raw output; it shows
   * what it parsed out of it, rearranged. So the transcript's search index
   * cannot project a claimed row the way it projects a generic one, and the
   * two halves have to be declared together or they drift: a receipt whose
   * body the index counted but whose DOM carried no marked container
   * produced matches that could be counted and never painted, revealed, or
   * flashed — a find that reported "1 of 18" and moved nothing.
   *
   * Declare it beside the matcher, mark the same containers in the
   * renderer, and the two stay one edit apart. A registration that declares
   * nothing is projected as its COMMAND alone (the header the chrome always
   * renders), which is the safe floor: never a match the painter cannot
   * reach.
   *
   * Returning `null` says "this output fell through to the generic block" —
   * a receipt whose text would not parse renders as a plain exchange, and
   * projects like one.
   *
   * `collapsed` is the row's fold state, resolved from the same expansion
   * store the renderer's collapse handle reads and keyed on the exchange id,
   * with the renderer's own default applied. A renderer that folds part of
   * what it parsed behind a chevron — the join boundary folds its whole
   * receipt — must gate those parts on it, exactly as the generic block gates
   * its terminal output. A part projected while its container is unmounted is
   * a match that can be counted and never painted, which is the one failure
   * this declaration exists to prevent.
   */
  findParts?: (message: ShellExchangeMessage, collapsed: boolean) => string[] | null;
}

interface CommandBlockRegistration {
  name: string;
  matcher: CommandBlockMatcher;
  renderer: CommandBlockRenderer;
  attribution: CommandBlockAttribution;
  presentation: CommandBlockPresentation;
  findParts:
    | ((message: ShellExchangeMessage, collapsed: boolean) => string[] | null)
    | undefined;
}

/**
 * The registrations, held in a `var` and created on first touch.
 *
 * **This is deliberate, and a `const` array literal here is a live defect.**
 * Registration is a module-load side effect, and the modules that register are
 * reachable from this module's own import of {@link ShellExchangeBlock} — so
 * entering the graph here evaluates a block module *before* this body runs,
 * and that block calls {@link registerCommandBlock} on the way past. The
 * function is a hoisted declaration and is callable at that moment; a `const`
 * binding is not yet initialized, so the call died in the temporal dead zone
 * with a `ReferenceError` naming whichever block happened to be first. A `var`
 * hoists to `undefined` instead, and the first-touch `??=` is what makes the
 * array exist for the caller that arrives early.
 *
 * The failure was worth the ugliness: which module entered the graph first
 * depended on a test file's import order, so the same suites passed
 * individually and threw when run together.
 */
// biome-ignore lint/style/noVar: hoisting is the point — see above.
var COMMAND_BLOCK_REGISTRY: CommandBlockRegistration[] | undefined;

function registry(): CommandBlockRegistration[] {
  return (COMMAND_BLOCK_REGISTRY ??= []);
}

/**
 * Register a bespoke command block. Called by renderer modules at
 * import time as they ship. `name` is the registration's governance
 * handle — unique, lowercase-kebab (e.g. `"git-status"`). Matchers
 * are consulted in registration order; the first claim wins.
 *
 * Throws on a duplicate `name`: a double registration is a wiring
 * mistake, and there is no bucket/alias system to make an override
 * legitimate.
 */
export function registerCommandBlock(
  name: string,
  matcher: CommandBlockMatcher,
  renderer: CommandBlockRenderer,
  options: CommandBlockOptions = {},
): void {
  if (registry().some((r) => r.name === name)) {
    throw new Error(`Command block "${name}" is already registered`);
  }
  registry().push({
    name,
    matcher,
    renderer,
    attribution: options.attribution ?? "shell",
    presentation: options.presentation ?? "entry",
    findParts: options.findParts,
  });
}

/**
 * Resolve the renderer for a command. Total: a command no matcher
 * claims — including every command today, with no bespoke renderers
 * shipped ([P05]) — renders through the generic `ShellExchangeBlock`.
 */
export function resolveCommandBlock(command: string): CommandBlockRenderer {
  const trimmed = command.trim();
  for (const registration of registry()) {
    if (registration.matcher(trimmed)) return registration.renderer;
  }
  return ShellExchangeBlock;
}

/**
 * Resolve who a command's row is attributed to. Total on the same terms as
 * {@link resolveCommandBlock}, and resolved by the *same* walk in the *same*
 * order — so a row's header and its block can never be decided by two
 * different readings of one command.
 */
export function resolveCommandAttribution(command: string): CommandBlockAttribution {
  const trimmed = command.trim();
  for (const registration of registry()) {
    if (registration.matcher(trimmed)) return registration.attribution;
  }
  return "shell";
}

/**
 * Resolve how a command's row occupies the transcript. Total on the same
 * terms as {@link resolveCommandBlock}, and resolved by the *same* walk in
 * the *same* order — a row's shape and its block are one reading of the
 * command, exactly as its attribution is.
 */
export function resolveCommandPresentation(command: string): CommandBlockPresentation {
  const trimmed = command.trim();
  for (const registration of registry()) {
    if (registration.matcher(trimmed)) return registration.presentation;
  }
  return "entry";
}

/**
 * The searchable text of a claimed exchange row, or `null` when no bespoke
 * renderer claims it (the caller then projects the generic block's command +
 * terminal output itself). Resolved by the same walk in the same order as
 * {@link resolveCommandBlock}, so what a row renders and what the search
 * index counts for it are decided by one reading of the command.
 *
 * A claimed row with no declared projection answers with its command alone —
 * see {@link CommandBlockOptions.findParts} for why that floor is the safe
 * one.
 *
 * `collapsed` is the row's fold state; a renderer that folds part of what it
 * shows reads it to project only what is mounted.
 */
export function resolveCommandBlockSearchParts(
  message: ShellExchangeMessage,
  collapsed: boolean,
): string[] | null {
  const trimmed = message.command.trim();
  for (const registration of registry()) {
    if (!registration.matcher(trimmed)) continue;
    const parts =
      registration.findParts !== undefined
        ? registration.findParts(message, collapsed)
        : [message.command];
    if (parts === null) return null;
    return parts.filter((part) => part !== "");
  }
  return null;
}

/** Enumerate registered names, in registration (= resolution) order. */
export function registeredCommandBlocks(): ReadonlyArray<string> {
  return registry().map((r) => r.name);
}

/**
 * Test-only: clear the registry so each test starts from the shipped
 * (empty) state. Production code never calls this.
 */
export function _resetCommandBlockRegistryForTests(): void {
  registry().length = 0;
}

/**
 * Test-only: clear the registry and hand back what was in it, for a file that
 * needs an empty population and must put the shipped one back afterwards.
 *
 * The registry is module-static, and a test runner shares one module graph
 * across files. A file that merely clears it therefore un-registers the
 * shipped receipts for every file that runs after it in the same process —
 * which reads as "the arc receipt is attributed to the shell", a failure in a
 * file that touched nothing. Re-importing the receipt modules cannot undo it,
 * because their registration is an import side effect and imports are cached.
 *
 * So the population is handed back rather than rebuilt: nothing here has to
 * know which receipts ship, which is the same reason the attribution lives on
 * the registration in the first place.
 */
export function _takeCommandBlockRegistryForTests(): unknown[] {
  return registry().splice(0, registry().length);
}

/** Test-only: put back what {@link _takeCommandBlockRegistryForTests} took. */
export function _putCommandBlockRegistryForTests(saved: unknown[]): void {
  registry().length = 0;
  registry().push(...(saved as CommandBlockRegistration[]));
}
