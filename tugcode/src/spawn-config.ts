// Spawn configuration for the claude CLI: binary and plugin resolution, the
// spawn environment, and the argument array.

import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseClaudeVersion } from "./capabilities.ts";

/**
 * Resolve the `claude` executable: the user's PATH first, then the native
 * installer's `~/.local/bin/claude` fallback — so Tug finds a `claude`
 * installed by `claude.ai/install.sh` even when `~/.local/bin` isn't on the
 * user's shell PATH (we don't edit their shell environment). Mirrors
 * `claude_auth::claude_executable` on the tugcast side. Returns null when
 * nothing is found. Resolved per spawn so a just-installed `claude` is found
 * without relaunch.
 */
export function resolveClaudePath(): string | null {
  const onPath = Bun.which("claude");
  if (onPath) return onPath;
  const fallback = join(homedir(), ".local", "bin", "claude");
  return existsSync(fallback) ? fallback : null;
}

/**
 * Resolve the Claude Code CLI version by running `claude --version` (output:
 * `"2.1.195 (Claude Code)"`) and parsing the leading semver. claude's
 * `initialize` handshake carries no version — only the post-turn `system/init`
 * does — so tugcode sources it locally and folds it into
 * `session_capabilities`, making the frontend's Claude Code badge correct from
 * the drop rather than "?" until the first turn.
 *
 * Best-effort: a spawn failure / unexpected output yields `null` (the badge
 * then falls back to its last-known / post-turn value). Synchronous and cheap
 * (one short-lived process), run once per spawn.
 */
export function resolveClaudeCodeVersion(claudePath: string): string | null {
  try {
    const proc = Bun.spawnSync([claudePath, "--version"]);
    if (!proc.success) return null;
    return parseClaudeVersion(proc.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Resolve the tugplug `--plugin-dir`.
 *
 * tugplug is an **app-level resource** — universal across every project
 * directory and bundled into every app variant. It is ALWAYS the bundled copy
 * that sits beside this binary (`Contents/Resources/tugplug`, one level up
 * from the `MacOS` dir), so a Session card on any directory gets the same
 * skills/agents. It is **never** the open project's source tree — there is no
 * per-project resolution and no fall-back to `<projectDir>/tugplug`.
 *
 * `TUG_PLUGIN_DIR` overrides the path for the dev-only `bun run` harness,
 * where there is no app bundle to resolve against. That is an explicit
 * injection, not a per-project fallback.
 *
 * Shared by the spawn ({@link SessionManager}) and the context-breakdown
 * emitter so both read the same plugin dir.
 */
export function resolvePluginDir(): string {
  const override = process.env.TUG_PLUGIN_DIR;
  if (override && override.length > 0) {
    console.log(`Plugin dir (env override): ${override}`);
    return override;
  }
  const bundled = resolve(
    dirname(process.execPath),
    "..",
    "Resources",
    "tugplug",
  );
  console.log(`Plugin dir (bundled app resource): ${bundled}`);
  return bundled;
}

/**
 * The environment a claude spawn runs under: the process environment, minus
 * the auth keys, plus the three variables tugcode sets per spawn.
 *
 * Pure and exported so the one fact that used to be silent — which session id
 * a rotated card's Bash calls see — is a test rather than a hope.
 *
 * **`TUG_SESSION_ID` is re-stamped, not inherited.** tugcast sets it once, on
 * the tugcode spawn. A Wheel rotation does not respawn tugcode: `newSession`
 * mints a fresh session id and respawns only claude, inside this same
 * process. Inherited, the variable would name the segment the card was born
 * on for the whole life of the card — the stranding a rotation is capable of
 * ([D167]). Stamping it from the
 * manager's own id keeps it current, though a shell already running when the
 * rotation lands still holds the old value; `tugtool`'s resolver, not this
 * function, is what makes a stale id harmless.
 *
 * Keep the auth list in sync with `AUTH_ENV_VARS` in
 * `tugrust/crates/tugcast/tests/common/catalog.rs` and the `env_remove` calls
 * in `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`.
 */
export function buildClaudeSpawnEnv(
  processEnv: Record<string, string | undefined>,
  sessionId: string,
  arc: string | null,
): Record<string, string | undefined> {
  const {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN,
    ...scrubbedEnv
  } = processEnv;
  void ANTHROPIC_API_KEY;
  void ANTHROPIC_AUTH_TOKEN;
  void CLAUDE_CODE_OAUTH_TOKEN;

  // claude forwards its environment to Bash tool calls, so this is the chain
  // that lets a skill or CLI run inside the session self-identify.
  scrubbedEnv.TUG_SESSION_ID = sessionId;

  // File checkpointing, so the card's `/rewind` can restore the *code*
  // dimension. The terminal has this on by default; in stream-json/SDK mode
  // it is opt-in via this variable.
  scrubbedEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";

  // Under an arc, the stage's claude carries the arc name so the stage skills
  // can read it from a Bash step. Absent is what *clears* it: the variable
  // belongs to an arc, not to a card.
  if (arc !== null) {
    scrubbedEnv.TUG_ARC = arc;
  } else {
    delete scrubbedEnv.TUG_ARC;
  }
  return scrubbedEnv;
}

/**
 * Configuration for building claude CLI spawn arguments.
 */
export interface ClaudeSpawnConfig {
  pluginDir: string;
  /**
   * Model selector for `--model`. When omitted / null, no `--model` flag is
   * passed and the claude CLI uses its own configured default model — which
   * is exactly what the `default` selector means, so it records as null.
   */
  model?: string | null;
  permissionMode: string;
  /**
   * Reasoning-effort level for `--effort` ([#step-4]). When omitted / null,
   * no `--effort` flag is passed and the model runs at its built-in default
   * (claude exposes no current-effort value, so unset is genuinely unset).
   */
  effort?: string | null;
  /**
   * Extra working directories granted as claude read roots ([#step-13c]),
   * each emitted as an additional `--add-dir`. Accumulated by `/add-dir` and
   * re-applied on every (re)spawn, like {@link effort}.
   */
  additionalDirectories?: readonly string[];
  /**
   * The plugin's prompt texts, appended to the system prompt after the nudge
   * in the order {@link PLUGIN_PROMPT_FILES} names them. Read from the plugin
   * at every (re)spawn; an absent file contributes nothing, and with none the
   * appended prompt is the nudge alone, byte for byte.
   */
  pluginPrompts?: readonly string[];
  sessionId: string | null;
  continue?: boolean;
  forkSession?: boolean;
  sessionIdOverride?: string;
}

/**
 * The plugin-root markdown files whose text rides the system prompt, in the
 * order they are appended: what passes between user and model first (the work
 * grammar), then how to edit a project's files so the change stays attributed,
 * then the three rules about what the Session card does with the model's
 * output — how its prose is rendered, what a tool call's exit status tells the
 * reader, and the shape a question must have to arrive — then what a session
 * reference in a prompt means and how to read the session it names, and what
 * a landings block reports, then the working rules that hold on every project.
 */
export const PLUGIN_PROMPT_FILES: readonly string[] = [
  "work-grammar.md",
  "file-editing.md",
  "transcript-prose.md",
  "tool-calls.md",
  "ask-user-question.md",
  "session-references.md",
  "landings.md",
  "working-rules.md",
];

/**
 * Read the prompt files shipped beside the plugin, in order, skipping any that
 * are not there.
 *
 * Each is prose the bundle carries — something the model must know to drive
 * the app correctly — and the system prompt is the one channel that reaches
 * every project the app opens, including those with no documentation of ours
 * in them at all. Each file is read independently, and its absence is a state
 * rather than an error: the session spawns without that text and says so once.
 */
export function readPluginPrompts(pluginDir: string): string[] {
  const texts: string[] = [];
  for (const file of PLUGIN_PROMPT_FILES) {
    const path = join(pluginDir, file);
    try {
      texts.push(readFileSync(path, "utf8").trim());
    } catch (err) {
      console.log(`Plugin prompt: ${path} not readable (${err}); spawning without it`);
    }
  }
  return texts;
}

/**
 * Dev-side system-prompt nudge appended to every spawn.
 *
 * Dev renders each tool call as a structured visual block (icon +
 * verb-qualified header + per-tool body), so the user sees the input
 * and result without the model needing to restate it in prose. Without
 * a nudge, Claude defaults to "tool result + prose summary" — which
 * reads as redundant duplication once the bespoke rendering lands.
 * The nudge is intentionally short: one sentence stating the surface
 * contract, one sentence carving out the legitimate restate case
 * (synthesis across multiple results, analysis the user can't derive
 * from the raw output, framing for what to do next).
 *
 * Companion to the tool-block chrome's `fold` opt-in
 * (`tugdeck/src/components/tugways/cards/tool-blocks/tool-block-chrome.tsx`)
 * — the chrome lets users hide the block once they've read it; this
 * nudge reduces the volume of restatement that makes hiding feel
 * necessary in the first place. Tackling redundancy from both ends.
 */
const SESSION_SYSTEM_PROMPT_NUDGE =
  "The user is reading this conversation in Dev, which renders each " +
  "tool call as a structured visual block — icon, verb-qualified header, " +
  "and per-tool body showing inputs and results. The block is the user's " +
  "primary surface for what the tool did and what it returned. Do not " +
  "restate or summarize a tool's input or result in prose unless you are " +
  "adding analysis, synthesis across multiple calls, or framing for what " +
  "comes next — repeating what the block already shows is duplication, " +
  "not communication. " +
  "This applies with extra force to summary-shaped tools like WebFetch " +
  "and Read whose result IS the model-readable rendering of the source: " +
  "the block already shows the markdown summary or file contents the " +
  "user asked for; restating those bullets or paragraphs in prose is " +
  "pure noise. The block stands on its own — your prose should add what " +
  "the block can't (cross-source synthesis, a specific judgment call, " +
  "the next step you're about to take).";

/**
 * The Tug application-data root (`<data_dir>/Tug`).
 *
 * Registered as a claude read root on every spawn (via `--add-dir`) so the
 * per-project runtime state that now lives outside the repo — the arc-log,
 * the code-sign sentinel, and future side-command output — is readable without
 * a permission prompt. One entry covers every `Tug/projects/<slug>/` subdir.
 *
 * Honors `TUG_DATA_DIR` as the base override (matching
 * `tugtool_core::project_state_dir`); otherwise the macOS app-support dir.
 */
export function tugDataRoot(): string {
  const override = process.env.TUG_DATA_DIR;
  const base =
    override && override.length > 0
      ? override
      : join(homedir(), "Library", "Application Support");
  return join(base, "Tug");
}

/**
 * Build the CLI argument array for spawning the claude process.
 * Exported for unit tests.
 */
export function buildClaudeArgs(config: ClaudeSpawnConfig): string[] {
  // Validate session flag combinations per D10.
  const sessionFlagCount = [
    !!config.sessionId,
    !!config.continue,
    !!config.sessionIdOverride,
  ].filter(Boolean).length;
  // The one allowed pair is a fork that claims its id: `--resume <parent>
  // --fork-session --session-id <new>` — how a directory change forks the
  // conversation into the target directory under the deck-minted id.
  const forkClaimsId =
    !!config.sessionId &&
    !!config.forkSession &&
    !!config.sessionIdOverride &&
    !config.continue;
  if (sessionFlagCount > 1 && !forkClaimsId) {
    throw new Error("Only one of sessionId, continue, or sessionIdOverride may be set");
  }

  if (config.forkSession && !config.sessionId && !config.continue) {
    throw new Error("forkSession requires either sessionId or continue to be set");
  }

  // One flag, one value. The CLI option is a string and a repeated
  // `--append-system-prompt` is not documented to concatenate, so joining is
  // the only spelling that reliably carries every text. With no plugin prompt
  // the value is the nudge alone, byte for byte.
  const systemPromptAppend = [
    SESSION_SYSTEM_PROMPT_NUDGE,
    ...(config.pluginPrompts ?? []).filter((text) => text !== ""),
  ].join("\n\n");

  const args: string[] = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
    "--include-partial-messages",
    "--replay-user-messages",
    "--plugin-dir", config.pluginDir,
    "--permission-mode", config.permissionMode,
    "--append-system-prompt", systemPromptAppend,
    // Grant frictionless reads of out-of-repo Tug runtime state (arc-log,
    // code-sign sentinel, side-command output) for every session.
    "--add-dir", tugDataRoot(),
  ];

  // Extra working directories from `/add-dir` ([#step-13c]) — one `--add-dir`
  // each, applied on every (re)spawn so they survive resume / fork / continue.
  for (const dir of config.additionalDirectories ?? []) {
    args.push("--add-dir", dir);
  }

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.effort) {
    args.push("--effort", config.effort);
  }

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  if (config.continue) {
    args.push("--continue");
  }

  if (config.forkSession) {
    args.push("--fork-session");
  }

  if (config.sessionIdOverride) {
    args.push("--session-id", config.sessionIdOverride);
  }

  return args;
}
