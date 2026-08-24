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
 * `/commit` and `/dash-join`, whose subject is a commit on the base branch.
 * Attributing those to the shell that carried them names the transport instead
 * of the act.
 *
 * **It lives on the registration** because a bespoke receipt already knows what
 * it is, and the alternative is a second enumeration of the same commands
 * somewhere else — which is exactly how `/dash-join` came to render its own
 * commit block under a `Shell` header while `/commit` rendered the identical
 * kind of block under a git one.
 */
export type CommandBlockAttribution = "shell" | "git";

/** Optional facts a registration may declare beyond matcher and renderer. */
export interface CommandBlockOptions {
  /** Defaults to `shell` — see {@link CommandBlockAttribution}. */
  attribution?: CommandBlockAttribution;
}

interface CommandBlockRegistration {
  name: string;
  matcher: CommandBlockMatcher;
  renderer: CommandBlockRenderer;
  attribution: CommandBlockAttribution;
}

const COMMAND_BLOCK_REGISTRY: CommandBlockRegistration[] = [];

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
  if (COMMAND_BLOCK_REGISTRY.some((r) => r.name === name)) {
    throw new Error(`Command block "${name}" is already registered`);
  }
  COMMAND_BLOCK_REGISTRY.push({
    name,
    matcher,
    renderer,
    attribution: options.attribution ?? "shell",
  });
}

/**
 * Resolve the renderer for a command. Total: a command no matcher
 * claims — including every command today, with no bespoke renderers
 * shipped ([P05]) — renders through the generic `ShellExchangeBlock`.
 */
export function resolveCommandBlock(command: string): CommandBlockRenderer {
  const trimmed = command.trim();
  for (const registration of COMMAND_BLOCK_REGISTRY) {
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
  for (const registration of COMMAND_BLOCK_REGISTRY) {
    if (registration.matcher(trimmed)) return registration.attribution;
  }
  return "shell";
}

/** Enumerate registered names, in registration (= resolution) order. */
export function registeredCommandBlocks(): ReadonlyArray<string> {
  return COMMAND_BLOCK_REGISTRY.map((r) => r.name);
}

/**
 * Test-only: clear the registry so each test starts from the shipped
 * (empty) state. Production code never calls this.
 */
export function _resetCommandBlockRegistryForTests(): void {
  COMMAND_BLOCK_REGISTRY.length = 0;
}
