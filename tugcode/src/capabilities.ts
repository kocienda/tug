// Pure parser for claude's `initialize` control-response into a
// `session_capabilities` IPC message.
//
// claude in stream-json mode is silent until the first user message, so
// the only turn-free way to learn a session's capabilities (available
// models, slash-command catalog, agents, output styles, account) is the
// standard `initialize` control-request handshake the SDKs send at spawn.
// claude answers immediately with a `control_response` whose nested
// `response` object carries those capabilities. This module turns that
// raw object into a strict-typed `SessionCapabilities` — unknown / extra
// fields are dropped, malformed entries skipped — so a forward-compatible
// claude can add fields without breaking the contract (per the
// strict-shape policy [R04]).
//
// What `initialize` does NOT carry: the exact current model id, version,
// permission mode, cwd, or session id. Those only arrive via
// `system_metadata` after the first turn. The default model appears only
// as prose inside `models[0].description`; the structured signal is the
// `value: "default"` / `displayName: "Default (recommended)"` convention
// on `models[0]`.

import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

import type {
  CapabilityCommand,
  CapabilityModel,
  SessionCapabilities,
} from "./types.ts";
import { extractFrontmatter } from "./context-breakdown.ts";
import { readFrontmatterField } from "./skills-inventory.ts";

/** Narrow an unknown to a plain object (not null, not array). */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a required string field; returns null if absent / wrong type. */
function readString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Keep only the string elements of an unknown array. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parse the `models` array. Each entry needs a string `value` +
 * `displayName`; `description` is optional. The reasoning-effort capability
 * (`supportsEffort` + `supportedEffortLevels`) is carried through for the Z4B
 * effort chip ([#step-4]): `supportsEffort` is absent on the wire when the
 * model does not support effort (e.g. haiku), so it is kept only when the
 * entry actually carries the flag — its absence IS the "unsupported" signal.
 * Malformed entries are skipped rather than failing the whole parse.
 */
function parseModels(value: unknown): CapabilityModel[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityModel[] = [];
  for (const raw of value) {
    const obj = asObject(raw);
    if (obj === null) continue;
    const v = readString(obj, "value");
    const displayName = readString(obj, "displayName");
    if (v === null || displayName === null) continue;
    const model: CapabilityModel = { value: v, displayName };
    const description = readString(obj, "description");
    if (description !== null) model.description = description;
    if (typeof obj.supportsEffort === "boolean") {
      model.supportsEffort = obj.supportsEffort;
    }
    if (Array.isArray(obj.supportedEffortLevels)) {
      model.supportedEffortLevels = stringArray(obj.supportedEffortLevels);
    }
    out.push(model);
  }
  return out;
}

/**
 * Parse the `commands` array. Each entry needs a string `name`;
 * `description` + `argumentHint` are optional.
 */
function parseCommands(value: unknown): CapabilityCommand[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityCommand[] = [];
  for (const raw of value) {
    const obj = asObject(raw);
    if (obj === null) continue;
    const name = readString(obj, "name");
    if (name === null) continue;
    const command: CapabilityCommand = { name };
    const description = readString(obj, "description");
    if (description !== null) command.description = description;
    const argumentHint = readString(obj, "argumentHint");
    if (argumentHint !== null) command.argumentHint = argumentHint;
    out.push(command);
  }
  return out;
}

/**
 * Build a `session_capabilities` IPC message from the nested `response`
 * object of an `initialize` `control_response`
 * (`control_response.response.response`).
 *
 * Returns null when the input is not an object (nothing to forward).
 * Always succeeds with a value otherwise — missing fields degrade to
 * empty arrays / `""` / `null`, never throw, so a partial response still
 * surfaces what it can.
 *
 * `effort` is the session's current reasoning-effort level, supplied by the
 * caller ([#step-4]): claude's `initialize` response carries no current-effort
 * field, so tugcode — the `--effort` owner — passes in the level it spawned
 * with (`null` when no override is in force).
 *
 * `version` is the Claude Code CLI version, likewise supplied by the caller:
 * the `initialize` response carries no version (only the post-turn
 * `system/init` does), so tugcode runs `claude --version` at spawn and folds
 * the result in here — making the frontend's Claude Code badge correct from
 * the drop. `null` when it could not be resolved.
 */
export function buildSessionCapabilities(
  response: unknown,
  effort: string | null = null,
  version: string | null = null,
): SessionCapabilities | null {
  const obj = asObject(response);
  if (obj === null) return null;
  return {
    type: "session_capabilities",
    models: parseModels(obj.models),
    commands: parseCommands(obj.commands),
    agents: stringArray(obj.agents),
    available_output_styles: stringArray(obj.available_output_styles),
    output_style: readString(obj, "output_style") ?? "",
    account: asObject(obj.account),
    effort,
    version,
    ipc_version: 2,
  };
}

/**
 * Parse the leading semver out of `claude --version` output, which looks like
 * `"2.1.195 (Claude Code)\n"`. Returns the bare `"2.1.195"`, or `null` when no
 * leading dotted-numeric version is present (an unexpected/empty output). Pure.
 */
export function parseClaudeVersion(output: string): string | null {
  const match = output.trim().match(/^(\d+\.\d+\.\d+)/);
  return match !== null ? match[1]! : null;
}

/**
 * The `request_id` a raw `control_response` line answers, or `null` when the
 * line is not a control response or carries no id.
 *
 * Correlation only — deliberately blind to `subtype` and to the payload. A
 * response proves claude read our request and replied, which is what a caller
 * waiting on "has this spawn loaded?" needs to know
 * ({@link SessionManager.awaitSpawnReady}); whether the payload also parsed as
 * capabilities is a separate question, asked by
 * {@link parseInitializeControlResponse}.
 */
export function readControlResponseRequestId(
  event: Record<string, unknown>,
): string | null {
  if (event.type !== "control_response") return null;
  const response = asObject(event.response);
  if (response === null) return null;
  return readString(response, "request_id");
}

/**
 * Extract the nested capability object from a raw `control_response`
 * event (the line claude writes to stdout answering our `initialize`
 * request). The shape is
 * `{ type: "control_response", response: { subtype, request_id, response: {...} } }`.
 * Returns `{ requestId, capabilities }` when this is a well-formed
 * success response, else null. The caller correlates `requestId` against
 * the id it sent for `initialize`.
 */
export function parseInitializeControlResponse(
  event: Record<string, unknown>,
  effort: string | null = null,
  version: string | null = null,
): { requestId: string; capabilities: SessionCapabilities } | null {
  if (event.type !== "control_response") return null;
  const response = asObject(event.response);
  if (response === null) return null;
  if (response.subtype !== "success") return null;
  const requestId = readString(response, "request_id");
  if (requestId === null) return null;
  const capabilities = buildSessionCapabilities(response.response, effort, version);
  if (capabilities === null) return null;
  return { requestId, capabilities };
}

// ---------------------------------------------------------------------------
// Plugin commands — turn-free catalog augmentation
// ---------------------------------------------------------------------------

/**
 * Enumerate a plugin's slash commands from disk as {@link CapabilityCommand}
 * entries (`<plugin>:<name>`, with the description / argument-hint from each
 * `SKILL.md` frontmatter, and any `commands/*.md`).
 *
 * **Why this exists.** claude's turn-free `initialize` handshake answers
 * *before* it has loaded `--plugin-dir` plugins, so its `commands` catalog
 * omits every plugin command — the full list only arrives with the first
 * turn's `system` init. A fresh Session card (no messages yet) would therefore
 * show no plugin commands in the `/` popup *and* reject a typed
 * `/<plugin>:<cmd>` as "Unknown" at submit. tugcode owns the (universal,
 * bundled) plugin dir, so it enumerates the plugin's commands here and merges
 * them into the turn-free catalog ({@link mergePluginCommands}), making them
 * available from the drop. The plugin name is the plugin dir's basename
 * (`tugplug`), matching claude's `<plugin>:<name>` namespacing.
 *
 * Best-effort and never throws: a missing dir / unreadable file is skipped.
 */
export function enumeratePluginCommands(pluginDir: string): CapabilityCommand[] {
  const pluginName = basename(pluginDir);
  const out: CapabilityCommand[] = [];

  // Skills → `<plugin>:<skill>`.
  const skillsRoot = join(pluginDir, "skills");
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(skillsRoot);
  } catch {
    skillDirs = [];
  }
  for (const dirName of skillDirs) {
    let text: string;
    try {
      text = readFileSync(join(skillsRoot, dirName, "SKILL.md"), "utf-8");
    } catch {
      continue; // not a skill directory.
    }
    const fm = extractFrontmatter(text);
    const skillName =
      (fm !== null ? readFrontmatterField(fm, "name") : null) ?? dirName;
    const command: CapabilityCommand = { name: `${pluginName}:${skillName}` };
    const description =
      fm !== null ? readFrontmatterField(fm, "description") : null;
    if (description !== null && description !== "") {
      command.description = description;
    }
    const argumentHint =
      fm !== null
        ? (readFrontmatterField(fm, "argument-hint") ??
          readFrontmatterField(fm, "argumentHint"))
        : null;
    if (argumentHint !== null && argumentHint !== "") {
      command.argumentHint = argumentHint;
    }
    out.push(command);
  }

  // `commands/*.md` → `<plugin>:<cmd>` (plugins that ship command files).
  const commandsRoot = join(pluginDir, "commands");
  let commandFiles: string[] = [];
  try {
    commandFiles = readdirSync(commandsRoot);
  } catch {
    commandFiles = [];
  }
  for (const file of commandFiles) {
    if (!file.endsWith(".md")) continue;
    out.push({ name: `${pluginName}:${file.slice(0, -3)}` });
  }

  return out;
}

/**
 * Return `caps` with the plugin's `extra` commands folded in, in their
 * **qualified** (`<plugin>:<leaf>`) form only — never both a bare `leaf` and
 * its qualified twin.
 *
 * claude's turn-free `initialize` handshake reports a plugin skill by its
 * *bare* leaf name (`commit`), while its loaded catalog (and the wire it
 * expands) use the *qualified* name (`tugplug:commit`). Listing both in the
 * Session card's `/` popup is the duplication this reconciles: for every
 * enumerated `<plugin>:<leaf>`, drop claude's bare `leaf` entry (it is the
 * same command, reported unqualified) and add the qualified one. Bare entries
 * that are NOT an enumerated plugin leaf (genuine user skills / built-ins like
 * `code-review`, `compact`) are untouched. Pure.
 */
export function mergePluginCommands(
  caps: SessionCapabilities,
  extra: CapabilityCommand[],
): SessionCapabilities {
  if (extra.length === 0) return caps;
  // leaf -> qualified, for each enumerated plugin command.
  const qualifiedByLeaf = new Map<string, string>();
  for (const cmd of extra) {
    const colon = cmd.name.lastIndexOf(":");
    if (colon >= 0) qualifiedByLeaf.set(cmd.name.slice(colon + 1), cmd.name);
  }
  // Drop claude's bare entries that are the unqualified twin of an enumerated
  // plugin command (a bare name with no `:` whose leaf we namespace).
  const reconciled = caps.commands.filter(
    (c) => !(!c.name.includes(":") && qualifiedByLeaf.has(c.name)),
  );
  const seen = new Set(reconciled.map((c) => c.name));
  const merged = [...reconciled];
  for (const cmd of extra) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      merged.push(cmd);
    }
  }
  return { ...caps, commands: merged };
}
