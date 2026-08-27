#!/usr/bin/env bun
// Empirical S3 calibration validation for #step-20-4-7-d.
//
// Compares `@anthropic-ai/tokenizer` (local BPE, Claude 2 vocab — documented
// as "very rough" for Claude 3+) against Anthropic's `count_tokens` API
// (ground truth for current Claude models) across representative content
// categories the breakdown popover will surface.
//
// Then demonstrates the calibration trick: pick one category as the
// "session-init anchor", compute `calibration_ratio = api / local`, apply
// to every other category, measure residual per-category drift. Goal: keep
// the residual inside the 5–10% bar.
//
// Run:  ANTHROPIC_API_KEY=... bun run tugcode/scripts/benchmark-context-tokenizer.ts
//
// Without ANTHROPIC_API_KEY the script runs local-only and prints what we
// would need to validate the calibration trick — useful for sanity-checking
// the harness shape.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { countTokens } from "@anthropic-ai/tokenizer";

const REPO_ROOT = "/Users/kocienda/Mounts/u/src/tugtool";
const HOME_CLAUDE = `${process.env.HOME}/.claude`;
const MODEL = "claude-sonnet-4-5";

interface Sample {
  label: string;
  category: string;
  text: string;
}

async function readFile(p: string): Promise<string> {
  return fs.readFile(p, "utf-8");
}

async function readAll(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (p) => {
      try {
        return await readFile(p);
      } catch {
        return "";
      }
    }),
  );
  return parts.filter((s) => s.length > 0).join("\n\n");
}

async function gatherSamples(): Promise<Sample[]> {
  const projectClaudeMd = await readFile(path.join(REPO_ROOT, "CLAUDE.md"));

  const skillPaths = [
    "tugplug/skills/dash-devise/SKILL.md",
    "tugplug/skills/dash-implement/SKILL.md",
    "tugplug/skills/dash/SKILL.md",
  ].map((p) => path.join(REPO_ROOT, p));
  const skillsConcatenated = await readAll(skillPaths);

  const memoryIndex = await readFile(
    `${HOME_CLAUDE}/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/MEMORY.md`,
  );
  const memoryEntries = await readAll(
    [
      "feedback_test_reality.md",
      "feedback_use_bun.md",
      "feedback_tuglaws_cross_check.md",
      "project_tide.md",
      "feedback_no_localstorage.md",
    ].map(
      (n) =>
        `${HOME_CLAUDE}/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/${n}`,
    ),
  );

  const shortUserMsg = "Run the tests and show me what fails.";
  const longCodeMsg = await readFile(
    path.join(REPO_ROOT, "tugcode/src/types.ts"),
  );
  const naturalLanguageMsg = projectClaudeMd.slice(0, 4000);

  return [
    {
      label: "Project CLAUDE.md (system-prompt-shaped proxy)",
      category: "system_prompt_proxy",
      text: projectClaudeMd,
    },
    {
      label: "tugplug skill manifests (recipe, bake, dash)",
      category: "skills",
      text: skillsConcatenated,
    },
    {
      label: "MEMORY.md index",
      category: "memory_files",
      text: memoryIndex,
    },
    {
      label: "Five memory entry files concatenated",
      category: "memory_files_entries",
      text: memoryEntries,
    },
    {
      label: "Short user message (natural language)",
      category: "messages_short",
      text: shortUserMsg,
    },
    {
      label: "Long code file (TypeScript types.ts)",
      category: "messages_code",
      text: longCodeMsg,
    },
    {
      label: "Long natural-language excerpt (CLAUDE.md head)",
      category: "messages_natural",
      text: naturalLanguageMsg,
    },
  ];
}

async function countViaApi(
  text: string,
  apiKey: string,
): Promise<number | null> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!r.ok) {
      console.error(`[api] HTTP ${r.status}: ${await r.text()}`);
      return null;
    }
    const data = (await r.json()) as { input_tokens?: number };
    return data.input_tokens ?? null;
  } catch (e) {
    console.error(`[api] fetch error: ${e}`);
    return null;
  }
}

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + " ".repeat(w - str.length);
}

function rpad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : " ".repeat(w - str.length) + str;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const samples = await gatherSamples();

  console.log(`# S3 calibration benchmark — model=${MODEL}`);
  console.log(`# Samples: ${samples.length}`);
  console.log(`# Ground-truth API: ${apiKey ? "available" : "NOT SET — local-only run"}\n`);

  type Row = {
    sample: Sample;
    bytes: number;
    local: number;
    api: number | null;
    rawDrift: number | null;
  };

  const rows: Row[] = [];
  for (const s of samples) {
    const local = countTokens(s.text);
    const api = apiKey ? await countViaApi(s.text, apiKey) : null;
    const rawDrift = api !== null ? (local - api) / api : null;
    rows.push({ sample: s, bytes: s.text.length, local, api, rawDrift });
  }

  console.log(
    `${pad("category", 30)} ${rpad("bytes", 8)} ${rpad("local", 8)} ${rpad("api", 8)} ${rpad("raw_drift", 10)}`,
  );
  console.log("-".repeat(70));
  for (const r of rows) {
    console.log(
      `${pad(r.sample.category, 30)} ${rpad(r.bytes, 8)} ${rpad(r.local, 8)} ${rpad(r.api ?? "—", 8)} ${rpad(r.rawDrift === null ? "—" : pct(r.rawDrift), 10)}`,
    );
  }
  console.log();

  if (apiKey === undefined) {
    console.log(
      "# No ANTHROPIC_API_KEY set — calibration demo requires API ground truth.",
    );
    console.log(
      "# Set ANTHROPIC_API_KEY=sk-... and re-run to validate the calibration trick.",
    );
    return;
  }

  // Calibration demo. Pick the largest "static-shaped" sample as the anchor —
  // that mirrors the real-world case where session-init categories collectively
  // form the calibration anchor before message turns arrive.
  const anchorCategory = "system_prompt_proxy";
  const anchor = rows.find((r) => r.sample.category === anchorCategory);
  if (!anchor || anchor.api === null) {
    console.log("# Anchor sample has no API count — skipping calibration demo.");
    return;
  }

  const calibrationRatio = anchor.api / anchor.local;
  console.log(`# Calibration anchor: ${anchorCategory}`);
  console.log(`#   anchor.local = ${anchor.local}`);
  console.log(`#   anchor.api   = ${anchor.api}`);
  console.log(`#   ratio (api/local) = ${calibrationRatio.toFixed(4)}`);
  console.log();
  console.log("# Applying calibration to remaining categories:");
  console.log(
    `${pad("category", 30)} ${rpad("local", 8)} ${rpad("calibrated", 11)} ${rpad("api", 8)} ${rpad("residual", 10)}`,
  );
  console.log("-".repeat(72));

  let withinBar = 0;
  let outsideBar = 0;
  for (const r of rows) {
    if (r.sample.category === anchorCategory || r.api === null) continue;
    const calibrated = Math.round(r.local * calibrationRatio);
    const residual = (calibrated - r.api) / r.api;
    if (Math.abs(residual) <= 0.1) withinBar++;
    else outsideBar++;
    console.log(
      `${pad(r.sample.category, 30)} ${rpad(r.local, 8)} ${rpad(calibrated, 11)} ${rpad(r.api, 8)} ${rpad(pct(residual), 10)}`,
    );
  }
  console.log();
  console.log(
    `# Categories inside 5–10% bar (|residual| ≤ 10%): ${withinBar} / ${withinBar + outsideBar}`,
  );
  console.log(
    `# Calibration trick verdict: ${outsideBar === 0 ? "PASS — every category inside the bar" : `${outsideBar} categor${outsideBar === 1 ? "y" : "ies"} OUTSIDE — revisit`}`,
  );
}

await main();
