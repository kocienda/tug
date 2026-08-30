#!/usr/bin/env bun
/**
 * tugplug-lint — the plugin ships inside Tug.app to projects that are not this
 * one, so nothing under `tugplug/` may lean on this repository or this machine.
 * This reads every file the plugin ships and refuses each shape that would.
 *
 * Contract: tugplug/CLAUDE.md, "The standalone contract". That file is repo
 * guidance about the plugin rather than a skill the model runs, and it is the
 * one file here allowed to name what the rules forbid.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLUGIN = join(ROOT, "tugplug");

interface Rule {
  name: string;
  /** Tested per line, against the line with any shell comment stripped. */
  pattern: RegExp;
  /** Only files with one of these extensions. */
  only?: string[];
  why: string;
}

const RULES: Rule[] = [
  {
    name: "just-recipe",
    pattern: /`just\s|^\s*just\s+[a-z][a-z0-9-]*\b/,
    why: "a `just` recipe exists only in this checkout; the build and the checks are the project's to declare in .tugtool/config.toml",
  },
  {
    name: "repo-source-path",
    pattern: /\b(tugdeck|tugrust|tugcode|tugapp|tests\/app-test)\//,
    why: "a path into this source tree does not exist in a user's project",
  },
  {
    name: "machine-path",
    pattern: /\/Users\/|kocienda|~\/\.local\/bin/,
    why: "a path on the author's machine",
  },
  {
    name: "this-repository",
    pattern: /[Ii]n this (repository|repo)\b|[Ii]n Tug(tool)?(?![\w.])|\bexemplar\b/,
    why: "a skill runs in the user's project; what is true here is not true there",
  },
  {
    name: "jq",
    pattern: /(^|[\s|(;&])jq(\s|$)/,
    only: [".sh"],
    why: "jq is not in the bundle; hook decisions are computed by `tugtool hook`",
  },
];

/**
 * A skill that reads a doctrine document must say what survives without it.
 * The link is fine — it is a pointer into a project that has one — but the
 * sentence that makes the skill work on a project that does not is required.
 */
const TUGLAWS_LINK = /tuglaws\//;
const ABSENCE_CLAUSE = /(has no|without|absent)[^\n]{0,40}`tuglaws\/|`tuglaws\/`[^\n]{0,60}\babsent\b/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p, out);
    } else if (/\.(md|sh|json)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function stripShellComment(line: string, ext: string): string {
  return ext === ".sh" ? line.replace(/^\s*#.*$/, "") : line;
}

export function lintPlugin(pluginDir = PLUGIN): string[] {
  const failures: string[] = [];
  for (const file of walk(pluginDir)) {
    const rel = relative(pluginDir, file);
    if (rel === "CLAUDE.md") continue;
    const ext = file.slice(file.lastIndexOf("."));
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const rule of RULES) {
      if (rule.only && !rule.only.includes(ext)) continue;
      lines.forEach((raw, i) => {
        const line = stripShellComment(raw, ext);
        if (rule.pattern.test(line)) {
          failures.push(`${rel}:${i + 1}: [${rule.name}] ${rule.why}\n    ${raw.trim().slice(0, 140)}`);
        }
      });
    }
    if (rel.startsWith("skills/") && TUGLAWS_LINK.test(text) && !ABSENCE_CLAUSE.test(text)) {
      failures.push(
        `${rel}: [tuglaws-without-absence-clause] cites tuglaws/ but never says what survives on a project that has none`,
      );
    }
  }
  return failures;
}

if (import.meta.main) {
  const failures = lintPlugin();
  if (failures.length > 0) {
    console.error(`tugplug-lint: ${failures.length} standalone-contract violation(s) in tugplug/\n`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log("tugplug-lint: tugplug/ depends on nothing outside the bundle");
}
