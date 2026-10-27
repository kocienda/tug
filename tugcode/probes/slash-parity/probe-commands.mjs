#!/usr/bin/env bun
// Slash-command parity probe: drive claude directly over stream-json with the
// argument vector tugcode's buildClaudeArgs produces, send each command the
// Session card has never had evidence for, and capture the raw wire.
//
//   /fast on, /fast off            — does a typed toggle set fast mode, and
//                                     does `fast_mode_state` echo it?
//   /reload-plugins, /reload-skills — do they reload over the bridge?
//   /doctor                         — a bundled skill: what does it do headless?
//   /output-style, /output-style default
//   /autocompact
//   /import --dry-run
//   /skill-doctor, /list-agents
//   /code-review ultra              — does the cloud review launch headless?
//
// Safety, because some of these touch the user's own setup or a bill:
//   - cwd is a scratch dir that is NOT a git repository. Claude's own
//     `/code-review ultra` path checks a `not_git_repo` precondition before it
//     bundles a branch, so in a non-repo it can establish what claude does
//     without launching (or billing) a cloud review.
//   - `--permission-mode default` with no `--permission-prompt-tool`: any tool
//     call a skill like /doctor wants to make is asked for and, with nobody to
//     answer, denied — so no command here can edit files.
//   - /import runs with --dry-run; /fast is turned on and straight back off.
//   - `~/.claude/settings.json` is hashed before and after and the meta says
//     whether it moved.
//
// Output: capture-<timestamp>.{stdout,stderr,meta.json} in this dir.
//
// PROBE_FAST_OPTIN=1 runs the fast-mode leg alone with claude spawned under
// `--settings '{"fastMode":true}'`. In SDK mode claude refuses a typed
// `/fast on` with `sdk_opt_in_required` unless the flag settings opt in, so
// that leg says whether an opted-in session can toggle and whether
// `fast_mode_state` echoes it. It sends no prompt, so no fast-mode tokens are
// spent. Its files are capture-fast-optin-<timestamp>.*.
//
// PROBE_OUTPUT_STYLE=1 runs the output-style leg alone: switch to a style that
// is not the current one, read it back, and switch home, so the capture says
// whether a typed switch takes effect mid-session and whether `output_style`
// echoes it. Its files are capture-output-style-<timestamp>.*.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_DIR = "/private/tmp/slash-parity-probe";
const SESSION_ID = crypto.randomUUID();
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = new URL(".", import.meta.url).pathname;
const PLUGIN_DIR = join(OUT_DIR, "..", "..", "..", "tugplug");
const SETTINGS = join(homedir(), ".claude", "settings.json");

mkdirSync(PROJECT_DIR, { recursive: true });
if (existsSync(join(PROJECT_DIR, ".git"))) {
  console.error("[probe] refusing: the scratch dir is a git repository");
  process.exit(1);
}

const hashSettings = () =>
  existsSync(SETTINGS)
    ? createHash("sha256").update(readFileSync(SETTINGS)).digest("hex")
    : null;
const settingsBefore = hashSettings();

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.CLAUDE_CODE_OAUTH_TOKEN;

const FAST_OPTIN = process.env.PROBE_FAST_OPTIN === "1";
const OUTPUT_STYLE = process.env.PROBE_OUTPUT_STYLE === "1";

const args = [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-mode", "default",
  "--plugin-dir", PLUGIN_DIR,
  "--session-id", SESSION_ID,
  ...(FAST_OPTIN ? ["--settings", JSON.stringify({ fastMode: true })] : []),
];

const COMMANDS = OUTPUT_STYLE
  ? [
      { text: "/output-style Concise", wait: 60 },
      { text: "/output-style", wait: 60 },
      { text: "/output-style default", wait: 60 },
      { text: "/output-style", wait: 60 },
    ]
  : FAST_OPTIN
  ? [
      { text: "/fast", wait: 60 },
      { text: "/fast on", wait: 60 },
      { text: "/fast", wait: 60 },
      { text: "/fast off", wait: 60 },
    ]
  : [
  { text: "/fast on", wait: 60 },
  { text: "/fast off", wait: 60 },
  { text: "/reload-plugins", wait: 60 },
  { text: "/reload-skills", wait: 60 },
  { text: "/output-style", wait: 60 },
  { text: "/output-style default", wait: 60 },
  { text: "/autocompact", wait: 60 },
  { text: "/import --dry-run", wait: 60 },
  { text: "/skill-doctor", wait: 60 },
  { text: "/list-agents", wait: 60 },
  { text: "/code-review ultra", wait: 90 },
  { text: "/doctor", wait: 240 },
];

console.error(`[probe] session=${SESSION_ID}`);
console.error(`[probe] spawning: claude ${args.join(" ")}`);

const stdoutLines = [];
const stderrLines = [];
let pending = "";
let onResult = null;
const proc = spawn("claude", args, {
  cwd: PROJECT_DIR,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stdout.on("data", (c) => {
  const t = new Date().toISOString();
  pending += c.toString();
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const l of lines) {
    if (!l) continue;
    stdoutLines.push(`${t}\t${l}`);
    if (l.includes('"type":"result"') && onResult) onResult();
  }
});
proc.stderr.on("data", (c) => {
  const t = new Date().toISOString();
  for (const l of c.toString().split("\n")) if (l) stderrLines.push(`${t}\t${l}`);
});

let exited = false;
proc.on("exit", (code, signal) => {
  exited = true;
  console.error(`[probe] claude exited code=${code} signal=${signal}`);
  if (onResult) onResult();
});

function sendUser(text) {
  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** Send one command and wait for the result that closes it, or the deadline. */
async function run(cmd) {
  const from = stdoutLines.length;
  const got = await Promise.race([
    new Promise((resolve) => {
      onResult = () => resolve(true);
    }),
    sleep(cmd.wait).then(() => false),
    (sendUser(cmd.text), new Promise(() => {})),
  ]);
  onResult = null;
  await sleep(1);
  return { from, to: stdoutLines.length, closed: got };
}

await sleep(3);

const spans = [];
COMMANDS.forEach((c, i) => {
  console.error(`[probe] queued ${i + 1}/${COMMANDS.length} ${c.text}`);
});
console.log(`[probe] starting — ${COMMANDS.length} commands`);
for (const [i, cmd] of COMMANDS.entries()) {
  if (exited) break;
  const span = await run(cmd);
  spans.push({ command: cmd.text, ...span });
  console.log(
    `[probe] [${i + 1}/${COMMANDS.length}] ${cmd.text.replaceAll(" ", "_")} — ${span.closed ? "ok" : "fail"}`,
  );
}

if (!exited) {
  proc.stdin.end();
  await sleep(8);
}
if (!exited) {
  proc.kill("SIGTERM");
  await sleep(3);
  if (!exited) proc.kill("SIGKILL");
}

const base = OUTPUT_STYLE
  ? `capture-output-style-${TS}`
  : FAST_OPTIN
    ? `capture-fast-optin-${TS}`
    : `capture-${TS}`;
writeFileSync(join(OUT_DIR, `${base}.stdout`), stdoutLines.join("\n") + "\n");
writeFileSync(join(OUT_DIR, `${base}.stderr`), stderrLines.join("\n") + "\n");

/** What one command's span of the wire says, reduced to the facts that rule it. */
function summarize(span) {
  const events = stdoutLines
    .slice(span.from, span.to)
    .map((l) => {
      try {
        return JSON.parse(l.slice(l.indexOf("\t") + 1));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const texts = [];
  let result = null;
  const inits = [];
  const toolUses = [];
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      inits.push({ fast_mode_state: e.fast_mode_state, output_style: e.output_style });
    }
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "text") texts.push(b.text);
        if (b.type === "tool_use") toolUses.push(b.name);
      }
    }
    if (e.type === "user" && !e.isReplay) {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b.type === "text" && b.text.includes("local-command-stdout")) texts.push(b.text);
      }
    }
    if (e.type === "result") {
      result = {
        subtype: e.subtype,
        is_error: e.is_error,
        num_turns: e.num_turns,
        total_cost_usd: e.total_cost_usd,
        result: typeof e.result === "string" ? e.result.slice(0, 600) : e.result,
      };
    }
  }
  return {
    command: span.command,
    closed: span.closed,
    events: events.length,
    inits,
    toolUses,
    texts: texts.map((t) => t.slice(0, 600)),
    result,
  };
}

const settingsAfter = hashSettings();
const meta = {
  sessionId: SESSION_ID,
  capture: base,
  cwd: PROJECT_DIR,
  cwdIsGitRepo: existsSync(join(PROJECT_DIR, ".git")),
  stdoutLines: stdoutLines.length,
  settingsJsonChanged: settingsBefore !== settingsAfter,
  commands: spans.map(summarize),
};
writeFileSync(join(OUT_DIR, `${base}.meta.json`), JSON.stringify(meta, null, 2));
console.error(`[probe] wrote ${base}.{stdout,stderr,meta.json}`);
