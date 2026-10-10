// Build the `/hooks` inventory ([#step-12c]) — the hook configuration merged
// across Claude Code's `settings.json` scopes (user, project, project-local),
// keyed by event name. Read-only: the `/hooks` sheet displays this; edits
// happen in `settings.json`.
//
// Claude Code applies hooks from all settings files, so we concatenate each
// event's matcher groups across scopes (the same "all of them fire" semantics
// CC uses). Pure + best-effort: a missing / unreadable / malformed file
// contributes nothing rather than failing the inventory. Invoked once per
// `hooks_query`, reading three small files — no caching.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeHome, projectClaudeDir } from "./claude-home.ts";

import type {
  HookCommand,
  HookMatcherGroup,
  HooksInventory,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";

/** Narrow an unknown to a plain object (not null, not array). */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse one hook command entry, or `null` when malformed. */
function parseHookCommand(raw: unknown): HookCommand | null {
  const obj = asObject(raw);
  if (obj === null || typeof obj.type !== "string") return null;
  const cmd: HookCommand = { type: obj.type };
  if (typeof obj.command === "string") cmd.command = obj.command;
  if (typeof obj.timeout === "number") cmd.timeout = obj.timeout;
  return cmd;
}

/** Parse one matcher group (`{ matcher?, hooks: [...] }`), or `null`. */
function parseMatcherGroup(raw: unknown): HookMatcherGroup | null {
  const obj = asObject(raw);
  if (obj === null || !Array.isArray(obj.hooks)) return null;
  const hooks = obj.hooks
    .map(parseHookCommand)
    .filter((c): c is HookCommand => c !== null);
  const group: HookMatcherGroup = { hooks };
  if (typeof obj.matcher === "string") group.matcher = obj.matcher;
  return group;
}

/** Read the `hooks` block of one settings file: event → matcher groups. */
function readHooksFile(path: string): Record<string, HookMatcherGroup[]> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {}; // no settings file at this scope — fine.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON — best-effort skip.
  }
  const hooks = asObject(parsed)?.hooks;
  const hooksObj = asObject(hooks);
  if (hooksObj === null) return {};
  const out: Record<string, HookMatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) continue;
    const parsedGroups = groups
      .map(parseMatcherGroup)
      .filter((g): g is HookMatcherGroup => g !== null);
    if (parsedGroups.length > 0) out[event] = parsedGroups;
  }
  return out;
}

export interface BuildHooksInventoryOptions {
  /** The session this inventory answers for (echoed on the frame). */
  sessionId: string;
  /** The correlating request id from the {@link HooksQuery}. */
  requestId: string;
  /** Home dir — `~/.claude/settings.json` is the user scope. */
  /** Where Claude Code keeps the user scope's `settings.json`. */
  claudeHome: ClaudeHome;
  /** Project cwd — `<cwd>/.claude/settings{,.local}.json` are project scopes. */
  cwd: string;
}

/**
 * Assemble the {@link HooksInventory}: the `hooks` blocks of the user
 * (`~/.claude/settings.json`), project (`<cwd>/.claude/settings.json`), and
 * project-local (`<cwd>/.claude/settings.local.json`) settings files, with
 * each event's matcher groups concatenated across scopes (CC's all-scopes-fire
 * semantics). Scope order: user, project, local.
 */
export function buildHooksInventory(
  options: BuildHooksInventoryOptions,
): HooksInventory {
  const { sessionId, requestId, claudeHome, cwd } = options;
  const files = [
    claudeHome.settingsPath(),
    join(projectClaudeDir(cwd), "settings.json"),
    join(projectClaudeDir(cwd), "settings.local.json"),
  ];

  const events: Record<string, HookMatcherGroup[]> = {};
  for (const file of files) {
    for (const [event, groups] of Object.entries(readHooksFile(file))) {
      (events[event] ??= []).push(...groups);
    }
  }

  return {
    type: "hooks_inventory",
    tug_session_id: sessionId,
    request_id: requestId,
    events,
    ipc_version: IPC_VERSION,
  };
}
