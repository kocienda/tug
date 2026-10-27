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
 * Beside those three tiers, and orthogonal to them, is the **unlisted** set
 * ({@link UNLISTED_SLASH_COMMANDS}): the arc's four stage skills and claude's
 * own internal commands. Unlisted is
 * *presentation only* — it is not a {@link SlashSupport} member and it changes
 * no classification, no submit behavior, and no catalog membership. It says one
 * thing: do not offer this name in the popup. A stage skill is machinery an arc
 * seats rather than vocabulary anyone speaks, so a user scrolling the popup for
 * a door should not have to read past four names that refuse to run outside an
 * arc. Typed anyway, one still reaches claude exactly as before.
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

import {
  LOCAL_SLASH_COMMANDS,
  LOCAL_SLASH_COMMAND_ALIASES,
} from "./slash-commands";

/** How a slash command is treated in the session card. */
export type SlashSupport = "supported-local" | "pass-through" | "hidden";

/**
 * Every command with a Tug surface — the [D23] registry, by name. Derived
 * from {@link LOCAL_SLASH_COMMANDS} so a command added there (e.g. `/copy`,
 * `/help` in a later sub-step) becomes `supported-local` automatically,
 * without a second edit here. Claude's aliases for those commands
 * ({@link LOCAL_SLASH_COMMAND_ALIASES}) are local too: typed, each dispatches
 * to its command's surface.
 */
const SUPPORTED_LOCAL: ReadonlySet<string> = new Set<string>([
  ...LOCAL_SLASH_COMMANDS.map((cmd) => cmd.name),
  ...LOCAL_SLASH_COMMAND_ALIASES.keys(),
]);

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
  "fast", // typed `/fast on` is refused headless, even opted in (slash-parity FINDINGS).
  "status", // typed /status is a no-op — the Z4B chrome already shows it.
  "statusline", // configures the terminal status line; the Z4B chrome owns ours.
  "scroll-speed", // interactive mouse-wheel ruler, terminal-only.
  "voice", // voice-dictation TUI state; nothing to toggle over the bridge.
  "artifacts", // browses published and shared artifacts in the TUI.
  "pause-memory", // pauses auto-memory for the session from the TUI.
  "memory-pause", // alias of /pause-memory.
  "toggle-memory", // alias of /pause-memory.

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
  "subtask", // subagent sent off with the full context; deferred beside /fork.
  "ultraplan", // cloud plan → browser review → remote exec.
  "ultrareview", // cloud multi-agent review; user-triggered + billed. Its live spelling,
  // `/code-review ultra`, is refused by argument (HIDDEN_SLASH_ARGUMENTS).
  "schedule", // cloud routines / scheduled agents.
  "routines", // alias of /schedule.

  // Plugin / advisor config — host-app or a future plan. (`/reload-plugins`
  // and `/reload-skills` graduated to pass-throughs: both reload in place over
  // the bridge on claude 2.1.311, tugcode/probes/slash-parity/FINDINGS.md.)
  "advisor",
  "plugin",
  "plugins", // alias of /plugin.
  "marketplace", // alias of /plugin.
  "cloud-plugins", // whether cloud sessions use this machine's plugins.
  "peers", // alias of /list-agents; claude catalogs the command headless, not the alias.

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
  "design-login", // authorizes design-system access for /design-sync.
  "rate-limit-options", // usage-limit and upgrade options.

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
  "daemon", // manages claude's background services and routines.
  "session", // shows a cloud session's URL and QR code.
  "remote", // alias of /session.

  // Diagnostics / info / process control.
  "doctor", // a bundled skill that wanders headless, a prompt per denied call (slash-parity FINDINGS).
  "release-notes",
  "heapdump",
  "version",
  "quit",
  "exit",
  "install", // installs the native claude build.
  "restart", // restarts claude, onto a newer build when one is waiting.
  "update", // alias of /restart.

  // Disabled or hidden by claude itself — the alert is accurate, and listing
  // them keeps this set a complete account of what claude names.
  "loops",
  "wellbeing",
  "breaks", // alias of /wellbeing.
  "break-reminder", // alias of /wellbeing.
  "downtime", // alias of /wellbeing.
  "pro-trial-expired",

  // Out of scope by prior decision.
  "mcp", // MCP fully out of scope ([Q06]).
  "bug", // files feedback to Anthropic — no meaning over the bridge.
]);

/**
 * The acknowledged pass-throughs: claude built-ins somebody has looked at and
 * decided to send to claude verbatim. Membership changes no behavior — every
 * name here classifies as `pass-through` exactly as an unknown name would. What
 * it records is that the decision was made, so the parity test over the
 * `capabilities/LATEST` capture can require every built-in in it to be exactly
 * one of local, hidden, or acknowledged, and a capture that brings a built-in
 * nobody has classified goes red the moment it lands.
 *
 * Built-ins only. Skills and agents vary with the capturing account and are
 * pass-throughs by construction, so they are never listed here.
 */
export const ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS: ReadonlySet<string> =
  new Set<string>([
    // Established pass-throughs: prompt expansions that run a real turn, and
    // `/goal`, probe-verified on 2.1.204 (tugcode/probes/goal-loop/FINDINGS.md).
    "goal",
    "init",
    "insights",
    "recap",
    "security-review",

    // Probe-verified on 2.1.311 (tugcode/probes/slash-parity/FINDINGS.md).
    "autocompact",
    "import",
    "list-agents",
    "output-style",
    "reload-plugins",
    "reload-skills",
    "skill-doctor",

    // Unprobed: a wizard-driven setup (`--wizard posture=… --propose |
    // --apply-file`) that is not meant to be typed by hand. It passes through
    // so a typed line still reaches claude rather than being swallowed.
    "auto-mode-setup",

    // Design-tool consent toggles.
    "design-consent",
    "design-revoke",

    // Claude-internal, for server-launched sessions only — also unlisted, so
    // the popup does not offer them (see UNLISTED_SLASH_COMMANDS).
    "__remote-workflow",
    "workflow-launch-exec",
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
 * Arguments that hide an otherwise-supported command, keyed by the command's
 * leaf name. The three tiers classify a *name*, but a command can reach a
 * hidden surface through one of its arguments: claude now spells its billed
 * cloud review `/code-review ultra`, with `/ultrareview` a deprecated alias,
 * and the typed line launches it headless with no confirmation (probe and
 * binary evidence in tugcode/probes/slash-parity/FINDINGS.md). Plain
 * `/code-review` is a local review and stays a pass-through; only the argument
 * is refused, exactly as the alias is.
 */
export const HIDDEN_SLASH_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map<string, ReadonlySet<string>>([["code-review", new Set(["ultra"])]]);

/**
 * Whether a typed command line is refused at submit, and as what. Returns the
 * invocation to name in the *not available* notice — the command for a hidden
 * name (`"vim"`), the command and its argument for a hidden argument
 * (`"code-review ultra"`) — or `null` when the line is not refused.
 *
 * A hidden argument is matched as the first argument that is not a flag, case
 * insensitively, because that is the position claude reads a mode from: in
 * `/code-review --fix ultra` the mode is still `ultra`.
 *
 * Pure.
 */
export function hiddenSlashCommandLine(commandLine: string): string | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(commandLine.trim());
  if (match === null) return null;
  const name = match[1]!;
  if (HIDDEN_SLASH_COMMANDS.has(name)) return name;
  const refused = HIDDEN_SLASH_ARGUMENTS.get(
    name.slice(name.lastIndexOf(":") + 1),
  );
  if (refused === undefined) return null;
  const mode = (match[2] ?? "")
    .split(/\s+/)
    .find((token) => token.length > 0 && !token.startsWith("-"));
  if (mode === undefined) return null;
  const lowered = mode.toLowerCase();
  return refused.has(lowered) ? `${name} ${lowered}` : null;
}

/**
 * Names the popup does not offer, by leaf name, in two groups.
 *
 * - **The arc's stage skills.** Each refuses to run outside an arc, so none is a
 *   door and none belongs in the popup's vocabulary.
 * - **Claude's internal commands.** Claude marks these hidden in its own
 *   command table ("server-launched sessions only"), but the handshake carries
 *   no hidden flag, so they arrive in the catalog by name. Any `__`-prefixed
 *   name belongs to this group without being listed (see
 *   {@link isUnlistedSlashCommand}). Unlisting rather than hiding keeps them
 *   sendable: claude does accept them, so a *not available* alert would lie.
 *
 * Held as leaves rather than as `tugplug:`-qualified names because the catalog
 * reports a plugin skill namespaced and the user types it bare, and the tier is
 * the same fact either way.
 */
export const UNLISTED_SLASH_COMMANDS: ReadonlySet<string> = new Set<string>([
  // The arc's stage skills.
  "arc-devise",
  "arc-review",
  "arc-implement",
  "arc-audit",

  // Claude-internal, for server-launched sessions only.
  "__remote-workflow",
  "workflow-launch-exec",
]);

/**
 * Whether a command name is unlisted — absent from the popup, and nothing else.
 *
 * Matches on the part after the last `:`, so `tugplug:arc-devise` and the bare
 * `arc-devise` answer alike, and any leaf beginning `__` is claude-internal and
 * unlisted whether or not the set names it. A name that is *also* a local
 * command is exempt:
 * `/arc-review` is both a stage skill's leaf and a card verb ({@link
 * LOCAL_SLASH_COMMANDS}), and the card verb is a door the user does speak. The
 * local provider is not run through the filter today, so the exemption changes
 * nothing now — it is here so the predicate is honest on its own terms, whatever
 * provider it is someday applied to.
 */
export function isUnlistedSlashCommand(name: string): boolean {
  if (SUPPORTED_LOCAL.has(name)) return false;
  const leaf = name.slice(name.lastIndexOf(":") + 1);
  return leaf.startsWith("__") || UNLISTED_SLASH_COMMANDS.has(leaf);
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
 * Whether a `/name` names something the card can actually run — the gate the
 * transcript uses to decide which inline `` `/code` `` spans become clickable
 * command chips.
 *
 * True for a local command, and for any name that resolves against claude's
 * catalog **namespace-aware** ({@link resolveRemoteCommand}): a bare `/arc`
 * is known because the catalog holds `tugplug:arc`. Testing the catalog for
 * literal membership instead would answer no to every bare plugin-skill name,
 * which is why skills historically printed the qualified `/tugplug:<leaf>`
 * form in their own prose.
 *
 * Resolution is the *same* function the submit path runs, deliberately: what
 * is clickable and what is sendable then agree by construction rather than by
 * two implementations kept in step. Ambiguity stays safe — a leaf two
 * namespaces expose resolves to `null`, so it simply is not a chip, matching
 * the conservative answer submit gives.
 *
 * Clicking a chip seeds the composer draft rather than submitting, and submit
 * canonicalizes, so a bare name resolved here still reaches claude qualified.
 *
 * Pure lookup.
 */
export function isKnownSlashCommandName(
  name: string,
  catalogNames: readonly string[],
): boolean {
  if (SUPPORTED_LOCAL.has(name)) return true;
  return resolveRemoteCommand(name, catalogNames) !== null;
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
