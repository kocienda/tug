/**
 * slash-supported.ts — the [D14] slash-command allowlist: a three-tier
 * classifier over command names.
 *
 * In stream-json / print mode claude has no interactive UI, so a command's
 * fate in the session card is one of three things ([D14] refinement,
 * #slash-cmd-audit):
 *
 * - **`supported-local`** — a [D23] local command with a Tug surface
 *   (`lib/slash-commands.ts` registry). Typed, it dispatches to its surface;
 *   it is offered in the popup.
 * - **`pass-through`** — a name that is neither local nor hidden. By name
 *   alone this is the default, so a new/unknown command is never *silently*
 *   swallowed. At submit, the session card refines it against claude's reported
 *   command catalog (see {@link isUnknownRemoteCommand}): a pass-through name
 *   claude actually reports (`/init`, `/insights`, `/recap`, a skill or
 *   agent command) is **sent to claude verbatim** and runs a real turn; a
 *   pass-through name claude does *not* report is a genuine unknown (a typo)
 *   and is reported to the user client-side instead of burning a turn.
 *   Pass-throughs are offered in the popup.
 * - **`hidden`** — a known command with no useful behavior over the bridge
 *   (terminal-only UI flags, account/host surfaces, device/teleport,
 *   automation/plugin config deferred to a future plan, MCP). Absent from the
 *   popup, and **swallowed at submit** (silent drop, never sent to claude).
 *   The canonical user-facing list of these lives in
 *   `tuglaws/session-card-unsupported-slash-commands.md`, kept in sync with
 *   {@link HIDDEN_SLASH_COMMANDS} below.
 *
 * Two consumers read this module: the session-card completion layer filters
 * claude's reported commands through it (drop the `hidden` tier — see
 * `filterCommandProvider` in `completion-providers/local-commands.ts`), and
 * the prompt entry's submit path swallows a typed `hidden` command before it
 * reaches claude. Both are session-card / bridge policy, so the filter is applied
 * at the session-card composition layer rather than inside the generic
 * `SessionMetadataStore` — same reasoning that keeps the local-command merge
 * out of the store ([#step-1c]).
 *
 * Pure data + pure lookup — no React, no DOM, no store dependency.
 *
 * @module lib/slash-supported
 */

import { LOCAL_SLASH_COMMANDS } from "./slash-commands";

/** How a slash command is treated in the session card. */
export type SlashSupport = "supported-local" | "pass-through" | "hidden";

/**
 * Every command with a Tug surface — the [D23] registry, by name. Derived
 * from {@link LOCAL_SLASH_COMMANDS} so a command added there (e.g. `/copy`,
 * `/help` in a later sub-step) becomes `supported-local` automatically,
 * without a second edit here.
 */
const SUPPORTED_LOCAL: ReadonlySet<string> = new Set(
  LOCAL_SLASH_COMMANDS.map((cmd) => cmd.name),
);

/**
 * The known-unsupported set ([D14]): commands hidden from the popup and
 * swallowed at submit. Grouped by *why* — the same grouping the user-facing
 * `tuglaws/session-card-unsupported-slash-commands.md` uses. Names are without
 * the leading slash.
 *
 * Not in this set and not a local command ⇒ `pass-through` (sent to claude),
 * so genuine pass-throughs (`/init`, `/insights`, `/recap`),
 * skill/agent commands, and unknown names are all visible and reach claude.
 */
export const HIDDEN_SLASH_COMMANDS: ReadonlySet<string> = new Set<string>([
  // Terminal-only UI flags / view preferences — render Ink components or set
  // TUI state; nothing happens over a headless stream-json bridge.
  "vim",
  "theme",
  "color",
  "tui",
  "keybindings",
  "terminal-setup",
  "chrome",
  "focus",
  "fast",
  "status", // typed /status is a no-op — the Z4B chrome already shows it.
  "statusline", // configures the terminal status line; the Z4B chrome owns ours.
  "scroll-speed", // interactive mouse-wheel ruler, terminal-only.
  "voice", // voice-dictation TUI state; nothing to toggle over the bridge.

  // Conversation-structure / automation deferred to a future plan — no
  // surface this pass. Kept here (rather than dropped) as a marker for
  // possible future feature work; each is a substantial standalone surface.
  // (`/goal` and `/loop` graduated to pass-throughs — probe-verified on
  // claude 2.1.204, see tuglaws/slash-commands.md and
  // tugcode/probes/goal-loop/FINDINGS.md.)
  "branch",
  "plan",
  // (`/tasks` and `/bashes` graduated to Tug-local commands — they open
  // the TASKS and JOBS popovers respectively; see LOCAL_SLASH_COMMANDS.)
  // (`/btw` graduated to a Tug-local command — it drives claude's native
  // `side_question` control-request and renders the answer in a non-modal
  // overlay; see LOCAL_SLASH_COMMANDS and tugcode/probes/btw/FINDINGS.md.
  // The user-text path is still refused headless — the control-request is a
  // different door.)
  "autofix-pr",
  "workflows", // workflow-orchestration progress view.
  "fork", // forked-subagent spawn; interactive, no bridge surface yet.
  "ultraplan", // cloud plan → browser review → remote exec.
  "ultrareview", // cloud multi-agent review (/code-review ultra); user-triggered + billed.
  "schedule", // cloud routines / scheduled agents.
  "routines", // alias of /schedule.

  // Plugin / advisor / dev-loop config — host-app or a future plan.
  "advisor",
  "plugin",
  "reload-plugins",
  "reload-skills",

  // Account / auth / subscription / novelty — the Tug.app host's concern.
  // (`/logout` is now a supported Tug-local command — see LOCAL_SLASH_COMMANDS.
  // `/login` stays hidden: logging in is handled by ConfigureTug, not a command.)
  "login",
  "privacy-settings",
  "config",
  "settings", // alias of /config.
  "feedback",
  "share", // alias of /feedback.
  "install-github-app",
  "install-slack-app",
  "web-setup", // connects a GitHub account to Claude Code on the web.
  "setup-bedrock", // Bedrock auth/region/model config — host concern.
  "setup-vertex", // Vertex AI auth/project/model config — host concern.
  "upgrade", // opens the plan-upgrade page.
  "passes",
  "powerup",
  "radio",
  "stickers",
  "sandbox",
  // (`/usage` graduated to a Tug-local command — it opens the graphical usage
  // sheet; see LOCAL_SLASH_COMMANDS.)
  "cost", // alias of /usage — still hidden (the sheet is reached via /usage).
  "stats", // alias of /usage — still hidden.
  "usage-credits",
  "extra-usage",
  "team-onboarding",

  // Device / cross-app / teleport — not the session card's concern.
  "ide",
  "desktop",
  "app", // alias of /desktop.
  "mobile",
  "ios", // alias of /mobile.
  "android", // alias of /mobile.
  "remote-control",
  "rc", // alias of /remote-control.
  "remote-env",
  "background",
  "bg", // alias of /background.
  "stop", // stops a background session — none exist over the bridge.
  "teleport",
  "tp", // alias of /teleport.
  "cd", // moves the session's working dir — a host/terminal concern.

  // Diagnostics / info / process control.
  "doctor",
  "release-notes",
  "heapdump",
  "version",
  "quit",
  "exit",

  // Out of scope by prior decision.
  "mcp", // MCP fully out of scope ([Q06]).
  "bug", // files feedback to Anthropic — no meaning over the bridge.
]);

/**
 * Classify a command name (without the leading slash). `supported-local` and
 * `hidden` are explicit sets; everything else is `pass-through` — the safe
 * default that keeps unknown / new claude commands reaching claude rather
 * than being silently swallowed.
 */
export function classifySlashCommand(name: string): SlashSupport {
  if (SUPPORTED_LOCAL.has(name)) return "supported-local";
  if (HIDDEN_SLASH_COMMANDS.has(name)) return "hidden";
  return "pass-through";
}

/** Whether a command name is in the hidden tier (absent from popup, swallowed). */
export function isHiddenSlashCommand(name: string): boolean {
  return HIDDEN_SLASH_COMMANDS.has(name);
}

/**
 * Resolve a typed `/name` to its canonical entry in claude's command catalog,
 * accounting for namespacing. Claude reports plugin skills and agents
 * namespaced — `tugplug:devise`, not `devise` — but the user types the bare
 * `/devise`. Matching the typed name against the catalog by equality alone
 * never finds it, so a perfectly valid skill reads as a genuine unknown.
 *
 * The match is, in order:
 *  - **exact** — the typed name is a catalog entry verbatim (`/init`,
 *    or the fully-qualified `/tugplug:devise`);
 *  - **namespace suffix** — exactly one catalog entry's part after the last
 *    `:` equals the typed name (`devise` → `tugplug:devise`). A unique
 *    suffix match resolves; an ambiguous one (two namespaces expose the same
 *    leaf name) does NOT — we can't pick for the user, so it stays
 *    unresolved and is treated as unknown rather than guessed.
 *
 * Returns the canonical catalog name on a hit, or `null` when the name
 * matches nothing (a genuine unknown / typo). Pure lookup.
 */
export function resolveRemoteCommand(
  name: string,
  catalogNames: readonly string[],
): string | null {
  if (catalogNames.includes(name)) return name;
  const suffixHits = catalogNames.filter((entry) => {
    const colon = entry.lastIndexOf(":");
    return colon >= 0 && entry.slice(colon + 1) === name;
  });
  return suffixHits.length === 1 ? suffixHits[0]! : null;
}

/**
 * Rewrite a bare-typed command line to its **canonical** plugin-qualified
 * form so the wire (and thus the transcript) use the name claude actually
 * expands. Given a lone command line `"/<name><rest>"`, when `<name>` uniquely
 * resolves to a qualified `<plugin>:<name>` via {@link resolveRemoteCommand},
 * return `"/<plugin>:<name><rest>"`; otherwise return `null` (no rewrite).
 *
 * Returns `null` when:
 *  - the text is not a lone command line;
 *  - the name is unknown / ambiguous (no unique resolution); or
 *  - the name is already an **exact** catalog entry — the conflict /
 *    shadowing rule: a name the user typed verbatim wins over any qualified
 *    command that merely shares its leaf.
 *
 * Pure.
 */
export function canonicalizeBareCommandLine(
  text: string,
  catalogNames: readonly string[],
): string | null {
  const match = /^\/([^\s]+)([\s\S]*)$/.exec(text);
  if (match === null) return null;
  const name = match[1]!;
  const rest = match[2] ?? "";
  const canonical = resolveRemoteCommand(name, catalogNames);
  if (canonical === null || canonical === name) return null;
  return `/${canonical}${rest}`;
}

/**
 * Whether a typed `/name` is a *genuine unknown* — a command claude does not
 * recognize — given the names claude reports in its command catalog
 * (`slash_commands` ∪ `skills` ∪ `agents`). True only when:
 *
 * - the catalog is **non-empty** — before the `initialize` handshake lands we
 *   have no catalog to check against, so we must not reject (a valid command
 *   typed early would fall through to claude); and
 * - the name is a `pass-through` (not a local command, not hidden) — a local
 *   command is dispatched to its surface and a hidden one is swallowed
 *   silently, neither is "unknown"; and
 * - the name resolves to no catalog entry, **namespace-aware** — a bare
 *   `/devise` resolves to the catalogued `tugplug:devise` (see
 *   {@link resolveRemoteCommand}) and so is NOT unknown; only a name that
 *   matches nothing (a typo) is.
 *
 * The session card uses this at submit to surface an "unknown command" alert
 * instead of sending the line to claude (which would waste a turn and reply
 * with a terminal-flavored error that may even suggest a command we hide).
 */
export function isUnknownRemoteCommand(
  name: string,
  catalogNames: readonly string[],
): boolean {
  if (catalogNames.length === 0) return false;
  if (classifySlashCommand(name) !== "pass-through") return false;
  return resolveRemoteCommand(name, catalogNames) === null;
}
