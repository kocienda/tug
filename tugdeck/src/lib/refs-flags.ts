/**
 * refs-flags — the typed-flag grammar for `/match` and `/search` ([P07]).
 *
 * A refs command is `<needles…>` plus short flags. This module is the ONE
 * place that grammar lives: it parses a typed argument line into the needles
 * and the normalized flag record the feed's serde enums read, and it emits
 * the inverse — flags back to the tokens that would produce them. The
 * deferred option cluster (chips writing flags into the draft) calls the
 * emitter rather than growing a second grammar that can drift from this one.
 *
 * Typed flags are the truth ([P07]): whatever a future chip surface shows, it
 * has to be expressible as a line the user could have typed.
 *
 * Pure data + pure functions — no React, no DOM, no store.
 *
 * @module lib/refs-flags
 */

import type { RefsOpKind } from "./refs-session-store";

/**
 * The flag record the feed reads — every key absent unless the line set it.
 *
 * Mostly booleans. A flag that takes a value (`-c 64`) lands as a number,
 * which is the same shape the feed's serde field reads.
 */
export type RefsFlags = Record<string, boolean | number>;

/** What a typed argument line parsed to. */
export interface ParsedRefsCommand {
  /** The search terms, in typed order, quotes stripped. */
  needles: string[];
  /** Flags in the feed's own spelling. */
  flags: RefsFlags;
  /** Flags the line carried that this op does not have — reported, ignored. */
  unknown: string[];
}

/**
 * `/match` flags (List L01). Defaults are case-insensitive substring over
 * filenames, all needles required.
 */
const MATCH_FLAGS: Readonly<Record<string, string>> = {
  a: "any",
  e: "exact",
  d: "dirs",
  s: "case_sensitive",
  "1": "first_only",
};

/**
 * `/search` flags (List L02). Defaults are case-sensitive string search, all
 * needles on one line, gitignore + `SecretFilter` skipped.
 *
 * `-a` and `-s` are the same flag: `-a` reads as "all files" and `-s` was the
 * older spelling, and both are kept because a user who learned either is not
 * wrong. Note `-s` means case-SENSITIVE for `/match` and all-files here —
 * the two ops have separate tables precisely so neither has to compromise.
 */
const SEARCH_FLAGS: Readonly<Record<string, string>> = {
  i: "case_insensitive",
  e: "regex",
  y: "any",
  a: "all_files",
  s: "all_files",
  l: "per_line",
};

/**
 * Flags that take a value rather than standing alone.
 *
 * `/search -c N` sets how many chars of context a matched line keeps on
 * each side of a hit; `-c 0` turns excerpting off and shows the line whole.
 * Omitted, the feed's own default applies — the number lives there, not
 * here, so one side owns it.
 */
const VALUED_FLAGS: Readonly<Record<RefsOpKind, Readonly<Record<string, string>>>> = {
  match: {},
  search: { c: "context_chars" },
};

/** The flag table for an op. */
function flagTable(kind: RefsOpKind): Readonly<Record<string, string>> {
  return kind === "match" ? MATCH_FLAGS : SEARCH_FLAGS;
}

/**
 * Split an argument line into tokens, honoring single and double quotes so a
 * needle can carry a space. An unterminated quote runs to the end of the line
 * rather than dropping the token — a user mid-type has an odd quote count
 * most of the time.
 */
export function tokenizeRefsArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of args) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Parse a `/match` or `/search` argument line.
 *
 * Short flags cluster (`-ie` is `-i -e`). A valued flag takes the rest of
 * its token (`-c32`, `-c=32`) or, when the token ends at the letter, the
 * next token (`-c 32`) — so it can still ride at the end of a cluster
 * (`-ic 32`). A bare `--` ends flag parsing, so a needle that genuinely
 * starts with an arc is still reachable. An unknown flag — or a valued one
 * with no number after it — is collected rather than guessed at: the caller
 * surfaces it as a subdued notice and runs the rest of the line, because
 * dropping the whole command over one typo is worse than running the search
 * the user meant.
 */
export function parseRefsArgs(kind: RefsOpKind, args: string): ParsedRefsCommand {
  const table = flagTable(kind);
  const valued = VALUED_FLAGS[kind];
  const needles: string[] = [];
  const flags: RefsFlags = {};
  const unknown: string[] = [];
  let flagsEnded = false;
  const tokens = tokenizeRefsArgs(args);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!flagsEnded && token === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && token.length > 1 && token.startsWith("-")) {
      const letters = token.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const ch = letters[at];
        const valuedName = valued[ch];
        if (valuedName !== undefined) {
          // The rest of the token, or the next one. Either way the letter
          // ends the cluster — a value cannot be read as more flags.
          const inline = letters.slice(at + 1).replace(/^=/, "");
          const raw = inline !== "" ? inline : (tokens[(index += 1)] ?? "");
          const value = Number(raw);
          if (raw === "" || !Number.isInteger(value) || value < 0) {
            unknown.push(`-${ch}`);
          } else {
            flags[valuedName] = value;
          }
          break;
        }
        const name = table[ch];
        if (name === undefined) unknown.push(`-${ch}`);
        else flags[name] = true;
      }
      continue;
    }
    if (token !== "") needles.push(token);
  }
  return { needles, flags, unknown };
}

/**
 * The inverse: the flag tokens that would produce `flags` for this op, in
 * table order and clustered into one `-xyz` token (or `""` for no flags).
 * The option cluster ([P07], deferred) writes its state into the draft with
 * this, so what a chip sets is always a line the user could have typed.
 *
 * For `/search`, `all_files` emits `-a` — the two spellings mean one flag and
 * one of them has to be the canonical output.
 */
export function composeRefsFlagTokens(kind: RefsOpKind, flags: RefsFlags): string {
  const table = flagTable(kind);
  const emitted = new Set<string>();
  let letters = "";
  for (const [letter, name] of Object.entries(table)) {
    if (flags[name] !== true || emitted.has(name)) continue;
    emitted.add(name);
    letters += letter;
  }
  // A valued flag cannot join the cluster — it carries a number after it, so
  // it is its own token and comes last.
  const tokens = letters === "" ? [] : [`-${letters}`];
  for (const [letter, name] of Object.entries(VALUED_FLAGS[kind])) {
    const value = flags[name];
    if (typeof value === "number") tokens.push(`-${letter} ${value}`);
  }
  return tokens.join(" ");
}

/** The command line a run echoes in its block header — `/search -i foo bar`. */
export function composeRefsCommandLine(
  kind: RefsOpKind,
  needles: readonly string[],
  flags: RefsFlags,
): string {
  const tokens = composeRefsFlagTokens(kind, flags);
  return [`/${kind}`, ...(tokens === "" ? [] : [tokens]), ...needles].join(" ");
}
