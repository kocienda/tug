#!/usr/bin/env bun
/**
 * slash-tui-advisory.ts — name the claude commands the Session card has not
 * classified and the headless catalog does not carry.
 *
 * The parity test (`tugdeck/src/lib/__tests__/slash-parity.test.ts`) gates
 * every built-in in the `capabilities/LATEST` capture, but a TUI-only command
 * never reaches that capture: claude leaves it out of the print-mode catalog.
 * Typed in the Session card, such a name gets the *Unknown command* alert
 * where the doctrine wants *Command not available*, so it belongs in
 * `HIDDEN_SLASH_COMMANDS`. The only place those names can be read is the
 * command table inside the installed, minified `claude` binary.
 *
 * That read is fragile — a command whose name the minifier does not write as a
 * `name:"…"` literal is invisible to it — so this is an advisory and never a
 * gate: it prints what it finds and always exits 0 once it has read the binary.
 * A gate over a minified extraction would go red on a minifier change rather
 * than on a real new command.
 *
 * Usage: bun scripts/slash-tui-advisory.ts [path-to-claude-binary]
 * With no path, the `claude` on PATH is resolved through its symlinks.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  LOCAL_SLASH_COMMANDS,
  LOCAL_SLASH_COMMAND_ALIASES,
} from "../tugdeck/src/lib/slash-commands";
import {
  ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS,
  HIDDEN_SLASH_COMMANDS,
  UNLISTED_SLASH_COMMANDS,
} from "../tugdeck/src/lib/slash-supported";

const ROOT = join(import.meta.dir, "..");

function resolveBinary(arg: string | undefined): string {
  if (arg !== undefined) return realpathSync(arg);
  const onPath = Bun.which("claude");
  if (onPath === null) {
    console.error("slash-tui-advisory: claude not found on PATH");
    process.exit(1);
  }
  return realpathSync(onPath);
}

/** One entry of claude's command table, as far as the minified text shows it. */
interface TableEntry {
  name: string;
  aliases: string[];
}

const NAME_MARK = 'name:"';
const COMMAND_NAME = /^[a-z_][a-z0-9_-]*$/;
/** How far past a name the entry's other keys are looked for. */
const ENTRY_REACH = 1500;
/** A command-table entry declares how it runs; other `name:` objects do not. */
const COMMAND_TYPE = /type:"(?:local|local-jsx|prompt)"|load:\(\)=>import\(/;

/**
 * Read the command table out of the binary's text: every `name:"x"` object
 * literal that, before the next `name:"`, carries a description and declares
 * how it runs. Aliases come from the same span's `aliases:[…]`.
 */
function readCommandTable(text: string): TableEntry[] {
  const entries: TableEntry[] = [];
  let at = text.indexOf(NAME_MARK);
  while (at !== -1) {
    const start = at + NAME_MARK.length;
    const close = text.indexOf('"', start);
    const next = text.indexOf(NAME_MARK, start);
    const name = close === -1 ? "" : text.slice(start, close);
    const end = Math.min(next === -1 ? text.length : next, start + ENTRY_REACH);
    const span = text.slice(start, end);
    if (
      COMMAND_NAME.test(name) &&
      span.includes("description") &&
      COMMAND_TYPE.test(span)
    ) {
      const aliasList = /aliases:\[([^\]]*)\]/.exec(span)?.[1] ?? "";
      const aliases = [...aliasList.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      entries.push({ name, aliases });
    }
    at = next;
  }
  return entries;
}

/** Every name the `LATEST` capture's catalog carries, by leaf. */
function readCaptureLeaves(): Set<string> {
  const capabilities = join(ROOT, "capabilities");
  const version = readFileSync(join(capabilities, "LATEST"), "utf-8").trim();
  const frame = readFileSync(
    join(capabilities, version, "system-metadata.jsonl"),
    "utf-8",
  )
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => Array.isArray(record.slash_commands));
  const names = [
    ...((frame?.slash_commands ?? []) as string[]),
    ...((frame?.skills ?? []) as string[]),
  ];
  return new Set(names.map((n) => n.slice(n.lastIndexOf(":") + 1)));
}

const binary = resolveBinary(process.argv[2]);
const table = readCommandTable(readFileSync(binary).toString("latin1"));
const catalogued = readCaptureLeaves();
const local: ReadonlySet<string> = new Set<string>([
  ...LOCAL_SLASH_COMMANDS.map((cmd) => cmd.name),
  ...LOCAL_SLASH_COMMAND_ALIASES.keys(),
]);

function classified(name: string): boolean {
  return (
    local.has(name) ||
    HIDDEN_SLASH_COMMANDS.has(name) ||
    ACKNOWLEDGED_PASS_THROUGH_SLASH_COMMANDS.has(name) ||
    UNLISTED_SLASH_COMMANDS.has(name) ||
    name.startsWith("__") ||
    catalogued.has(name)
  );
}

const unclassified = new Map<string, string[]>();
for (const entry of table) {
  for (const name of [entry.name, ...entry.aliases]) {
    if (classified(name) || unclassified.has(name)) continue;
    unclassified.set(
      name,
      name === entry.name ? entry.aliases : [`alias of ${entry.name}`],
    );
  }
}

console.log(
  `slash-tui-advisory: ${table.length} command-table entries read from ${binary}`,
);
if (unclassified.size === 0) {
  console.log(
    "slash-tui-advisory: every TUI-only name read is classified (advisory only; the read can miss entries)",
  );
} else {
  console.log(
    `slash-tui-advisory: ${unclassified.size} name(s) neither local, hidden, acknowledged nor in the headless catalog — classify each in tugdeck/src/lib/slash-supported.ts (advisory, not a failure):`,
  );
  for (const [name, notes] of [...unclassified].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`  /${name}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`);
  }
}
