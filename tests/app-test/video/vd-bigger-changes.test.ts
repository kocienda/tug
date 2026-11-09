/**
 * vd-bigger-changes.test.ts — the video's "bigger changes" sequence, timed to
 * the narration in the `vids` repo (`incoming/bigger-changes-audio.wav`): one
 * Session card that starts an arc from an idea and later joins it from the
 * Changes shade, in two bursts of one launch around two rendered graphics,
 * for a half-width frame. The second part of the "managing change" section;
 * `vd-smaller-changes.test.ts` is the first.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its assertions are that frames were written and the join landed. It lives
 * beside the site's drivers and shares their helpers and gate
 * (`../site-clips/_site-clips.ts`): run by path, once per mode, with
 * `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set. The `vids` repo's
 * `tools/shot.py bigger-changes` is the usual caller, and its
 * `tools/assemble.py bigger-changes` lays the bursts and the graphics
 * (`tools/graphic/arcs.html`) under the narration.
 *
 * The scene: a scratch clone of this checkout under a directory named `tug`,
 * with a minimal `.tugtool/config.toml` committed on `main` (no post-create
 * hooks, no declared checks), and one Session card on a stub session. The arc
 * is real — cut by the built `tugtool` in the clone, on its own worktree —
 * and the stub turns are what a person sees of `/arc`. In seconds of audio:
 *
 *   0.0 – 19.5   burst A: the card at rest; at "typing an idea" the idea is
 *                typed and sent, and the stub talks it over and writes the
 *                brief; at "I run slash arc" `/arc` is typed and sent, the
 *                arc is bound to the card, and the Changes shade is revealed
 *                so its arc lane shows the track; the steps tick through
 *                "an ordered set of steps"
 *  19.5 – 30.2   the replay graphic (not recorded here)
 *  30.2 – 37.4   burst B: the arc is built and on offer; at "I join an arc
 *                from the Changes tab" ⌃⌘C opens the shade in join mode, and
 *                at "like a regular commit" the Join button is pressed; the
 *                receipt and the boundary land, and the worktree is gone
 *  37.4 – 50.6   the proof graphic (not recorded here)
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, note, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { arcBriefPath, arcTasksPath, commitRound, createArc, fixturePlanDocument, markArcBuilt, tugtoolPath, type ArcFixtureOpts } from "../arc-fixture";
import { pollFor } from "../body-grounding/_frames";
import { kindPane } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 900_000;
const IPC_VERSION = 2;
/** This checkout, cloned for the scene; its built `tugtool` cuts the arc. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
/** Where the scratch clone lives: a readable path, since the masthead names the directory. Removed when the run ends. */
const SCRATCH_ROOT = process.env.TUG_VIDS_SCRATCH ?? resolve(CHECKOUT, "..", "scratch");

/** The narration's windows, in seconds of audio. */
const BURST_A_AT = 0.0;
const BURST_A_END = 19.5;
const BURST_B_AT = 30.2;
const BURST_B_END = 37.4;

/** Half a 4K frame's shape: 3080 × 3464 pixels at 2×, scaled to 1920 × 2160 by assemble.py. */
const CONTENT_SIZE = { width: 1540, height: 1732 };

/** Milliseconds between the stub's outputs: slow enough that a turn is seen arriving. */
const PACE_MS = 350;

const CARD = "vd-bgc-arc";
const EDITOR = '[data-slot="tug-text-editor"] .cm-content';
const SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const JOIN_BUTTON = '.tug-prompt-entry-commit-button[aria-label="Join"]';
const READY = '[data-slot="arc-join-register"][data-word="ready"]';
const JOIN_RECEIPT = '[data-boundary="join"]';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;

/** The idea, as typed. */
const IDEA = "Show each session's token spend as a sparkline in its masthead.";
/** The plugin's skills, as a session reports them in its catalog; the descriptions are the skills' own front matter. */
const SKILLS = [
  { name: "tugplug:arc", description: "Arc — sharpen an idea into a brief, decide whether it wants a plan, and hand it to the wheel, which walks the work and audits the landed code on fresh sessions of its own", category: "skill" },
  { name: "tugplug:brief", description: "Write the conversation's settled findings and decisions as a brief", category: "skill" },
  { name: "tugplug:viz", description: "Draw a chart, plot, graph or visualisation in the transcript", category: "skill" },
];
/** Claude's own commands beside them. */
const SLASH_COMMANDS = ["compact", "clear", "help", "model", "review", ...SKILLS.map((s) => s.name)];
/** The join's message, as typed: the squash commit's subject. */
const JOIN_MESSAGE = "feat(spend): a token-spend sparkline in the masthead";

/** The arc: its name, the brief's one line, and its four steps, each editing one file with a comment above the file's first `export`. */
const ARC = {
  name: "spend-sparkline",
  description: "Show a session's token spend as a sparkline in the masthead",
  steps: [
    { title: "Sample the spend per turn into the instrument", file: "tugdeck/src/lib/sparkline-instrument.ts", comment: "// The spend curve: one sample per turn, so a long turn reads as one tall bin rather than a ramp." },
    { title: "Draw the spend sparkline in the masthead", file: "tugdeck/src/components/tugways/session-masthead.tsx", comment: "// The spend sparkline rides the resting line's end, at the cap height, beside the activity tape." },
    { title: "Elide the sparkline under a squeeze", file: "tugdeck/src/components/tugways/session-identity-row.tsx", comment: "// Under a squeeze the spend sparkline goes before the name does: a reading, not an identity." },
    { title: "Pass the spend through the activity host", file: "tugdeck/src/components/tugways/session-activity-sparkline.tsx", comment: "// The host passes the spend series through beside the activity series; the geometry is shared." },
  ],
} as const;

const BRIEF = `# spend-sparkline

**Idea.** ${IDEA}

**Decided.** The spend is sampled once per turn, not per token, so a long turn reads as one tall bin. The sparkline rides the masthead's resting line at the cap height, beside the activity tape, and a squeeze elides it before the session's name: it is a reading, not an identity.

**Steps.**
${ARC.steps.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}
`;
/** The brief's commit subject, in the brief skill's own grammar. */
const BRIEF_COMMIT_SUBJECT = `briefs(${ARC.name}): Add brief for the masthead spend sparkline`;
/** The hand-off line the brief skill prints last: the arc's name and the brief, for `/arc` to open on. */
const ARC_COMMAND_ARGS = `${ARC.name} @briefs/${ARC.name}.md`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The scratch clone: this checkout at HEAD under a directory named `tug`, with a minimal arc config committed on `main`. */
function makeRepo(root: string): string {
  const repo = join(root, "tug");
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", CHECKOUT, repo]);
  git(repo, "config", "user.email", "kocienda@mac.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  // No post-create hooks and no declared checks: the arc's worktree is cut in a second and its join verifies at once.
  writeFileSync(join(repo, ".tugtool", "config.toml"), "[tugtool.arc]\n");
  git(repo, "commit", "-qam", "chore: the scene's arc config");
  // The brief, landed as `/tugplug:brief` lands it: its own commit, so the arc's worktree forks with the document it opens on.
  writeFileSync(join(repo, "briefs", `${ARC.name}.md`), BRIEF);
  git(repo, "add", join("briefs", `${ARC.name}.md`));
  git(repo, "commit", "-qm", BRIEF_COMMIT_SUBJECT);
  // The remote-tracking ref follows, so the shade's header does not count the clone as a commit ahead.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const resolver = join(root, "resolver.sh");
  writeFileSync(resolver, "#!/bin/sh\nexit 0\n");
  chmodSync(resolver, 0o755);
  git(repo, "config", "tugarc.joinresolver", resolver);
  return repo;
}

/** A task list with the arc's step titles, in the fixture's grammar. */
function tasks(): string {
  let doc = fixturePlanDocument(ARC.steps.length);
  const fixtureTitles = ["The only step", "The second step", "The third step", "The fourth step"];
  ARC.steps.forEach((s, i) => {
    doc = doc.split(fixtureTitles[i]!).join(s.title);
  });
  return doc;
}

/** One step's edit, applied in `tree`: the comment above the file's first `export` line. */
function applyStep(tree: string, i: number): void {
  const s = ARC.steps[i]!;
  const file = join(tree, s.file);
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("export "));
  if (at < 0) throw new Error(`no export line in ${s.file}`);
  lines.splice(at, 0, s.comment);
  writeFileSync(file, lines.join("\n"));
}

/** `tugtool arc <args>` in the clone, asynchronously, so an act never blocks the scene; `sid` is the session the verb acts as. */
async function arcVerb(repo: string, cli: ArcFixtureOpts, args: string[], sid = ""): Promise<string> {
  const proc = Bun.spawn([tugtoolPath(cli.binaryRoot ?? repo), "arc", ...args], {
    cwd: repo,
    env: { ...process.env, ...cli.env, TUG_SESSION_ID: sid },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tugtool arc ${args.join(" ")} failed (${code})\n${out}\n${err}`);
  return out;
}

/** The stub's two turns: the idea talked over and the brief written, then `/arc` and the arc on its worktree. */
function transcript(repo: string): unknown {
  type Item = { text: string } | { tool: string; input: Record<string, unknown>; output: string };
  const turn = (index: number, description: string, items: Item[]) => {
    const outputs: unknown[] = [];
    items.forEach((it, i) => {
      const msgId = `${CARD}-t${index}-m${i}`;
      if ("text" in it) {
        outputs.push({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text", ipc_version: IPC_VERSION });
        outputs.push({ type: "assistant_text", msg_id: msgId, block_index: 0, seq: i, rev: 0, text: it.text, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
      } else {
        const id = `toolu_${CARD}_${index}_${i}`;
        outputs.push({ type: "tool_use", msg_id: msgId, seq: i, tool_name: it.tool, tool_use_id: id, input: it.input, ipc_version: IPC_VERSION });
        outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: it.tool, elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
        outputs.push({ type: "tool_result", tool_use_id: id, output: it.output, is_error: false, ipc_version: IPC_VERSION });
      }
    });
    outputs.push({ type: "turn_complete", msg_id: `${CARD}-t${index}-end`, seq: items.length, result: "success", ipc_version: IPC_VERSION });
    return { index, description, outputs };
  };
  const briefPath = join(repo, "briefs", `${ARC.name}.md`);
  const briefSha = git(repo, "rev-parse", "--short", "HEAD");
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [
      turn(0, "the idea, talked over", [
        { text: "Worth doing. Two things I'd settle in the brief: sample the spend once per turn rather than per token, so a long turn reads as one tall bin; and let a squeeze elide the sparkline before the session's name, since it is a reading, not an identity." },
        { tool: "Write", input: { file_path: briefPath, content: BRIEF }, output: `File created successfully at: ${briefPath}` },
        {
          tool: "Bash",
          input: { command: `tugtool commit --paths briefs/${ARC.name}.md --message "${BRIEF_COMMIT_SUBJECT}"`, description: "Land the brief" },
          output: `committed ${briefSha} on main\n1 file(s), +${BRIEF.split("\n").length - 1} -0\n  A briefs/${ARC.name}.md`,
        },
        { text: `Wrote \`briefs/${ARC.name}.md\` — four steps, one commit each — and landed it as \`${briefSha}\`.\n\n\`/arc ${ARC_COMMAND_ARGS}\`` },
      ]),
      turn(1, "/arc", [
        {
          tool: "Bash",
          input: { command: `tugtool arc create ${ARC.name} --description "${ARC.description}" --base main`, description: "Cut the arc on its own worktree" },
          output: `created ${ARC.name}\n  branch    tugarc/${ARC.name}\n  worktree  .tug/worktrees/${ARC.name}\n  base      main`,
        },
        { text: `The arc is on its own worktree, \`.tug/worktrees/${ARC.name}\`, with the brief's four steps as its task list. Starting step 1: ${ARC.steps[0]!.title.toLowerCase()}.` },
      ]),
    ],
  };
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [kindPane("session", CARD, 0)],
    activePaneId: `${CARD}-pane`,
    // Fit: the window fixes the card's height, so the shade opening and the receipt landing move nothing.
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** Type a line a word at a time, so the typing is seen. */
async function typeSlowly(app: App, text: string, wordMs = 70): Promise<void> {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    await app.nativeType(i === 0 ? words[i]! : ` ${words[i]}`);
    await Bun.sleep(wordMs);
  }
}

describe.skipIf(!RUNS)("video: the bigger-changes sequence", () => {
  test(
    "records one session starting an arc from an idea, then joining it from the Changes shade, timed to the narration",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, "run-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      note("cloning the checkout");
      const repo = makeRepo(scratch);
      const dataRoot = join(scratch, "data");
      mkdirSync(dataRoot, { recursive: true });
      // The clone has no built CLI of its own; the checkout's runs against it, writing arc state into the scene's data root.
      const cli: ArcFixtureOpts = { binaryRoot: CHECKOUT, env: { TUG_DATA_DIR: dataRoot, TUG_SESSION_ID: "" } };
      const stubDir = stubDirectory();
      const sid = randomUUID();
      writeFileSync(join(stubDir, `${sid}.json`), JSON.stringify(transcript(repo)));

      const app = await launchForMode("vd-bigger-changes", deck(), stubDir, { contentSize: CONTENT_SIZE, env: { TUG_DATA_DIR: dataRoot } });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await Bun.sleep(800);
        const body = app.body(CARD);
        const focus = () => app.dispatchControlAction("focus-pane", { paneId: `${CARD}-pane` });
        const phase = () => body.evalJS<string | null>(PROMPT_PHASE).catch(() => null);
        const has = (sel: string) => body.evalJS<boolean>(`document.querySelector(${JSON.stringify(sel)}) !== null`).catch(() => false);

        note("binding the card");
        await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`, { timeoutMs: 30_000 });
        await app.spawnSessionNew(CARD, { tugSessionId: sid, projectDir: repo });
        await pollFor(
          () => body.evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`).catch(() => false),
          (bound) => bound,
          30_000,
        );
        // The command catalog a real session reports after its first turn, so `/arc` completes to the plugin's `/tugplug:arc`.
        await app.ingestSessionMetadata(CARD, { type: "system_metadata", cwd: repo, model: "claude-fable-5-1", version: "2.1.285", permissionMode: "auto", slash_commands: SLASH_COMMANDS, skills: SKILLS, ipc_version: IPC_VERSION });
        await Bun.sleep(600);

        // The arc, cut before the first frame: it is unbound and the shade is down, so nothing of it shows until `/arc` is sent.
        note("cutting the arc");
        const created = createArc(repo, ARC.name, ARC.description, cli);
        writeFileSync(arcBriefPath(repo, ARC.name), BRIEF);
        writeFileSync(arcTasksPath(repo, ARC.name), tasks());
        // No run record (`arc-start`, `arc-kind`, `arc-stage`): a record with a bound session is what the server's wheel
        // rotates a stage onto, and a stage prompt would exhaust the two-turn stub. The steps' ledger carries the track.
        await focus();
        await Bun.sleep(600);
        const rects = await standIns(app);

        const ms = (audioSecs: number, offset: number) => Math.round((audioSecs - offset) * 1000);
        const notes: Record<string, unknown> = {};
        const pending: Promise<unknown>[] = [];
        /** Start a verb and move on: the act returns at once, and the verb is awaited after the burst. */
        const later = (p: Promise<unknown>): Promise<void> => {
          pending.push(p.catch((e) => note(`deferred verb failed: ${String(e)}`)));
          return Promise.resolve();
        };

        // ---- Burst A: the idea, the brief, /arc, the steps -----------------
        const a = scene().mark("loop-start", 0);
        const A = (t: number) => ms(t, BURST_A_AT);
        // "I start an arc by typing an idea": typed into the composer and sent.
        a.at(A(7.2), () => body.nativeClickAtElement(EDITOR));
        a.at(A(7.45), () => typeSlowly(app, IDEA));
        a.at(A(9.05), () => app.nativeKey("Return", ["cmd"]));
        // "and then I run slash arc": `/arc` typed and its completion accepted, so the composer holds the plugin's own
        // `/tugplug:arc`; then the brief's hand-off arguments — the arc's name and the brief's path — with the `@`
        // file popup dismissed (it lists the root, unfiltered, for a path query), and ⌘Return sends the whole line;
        // the stub answers with the arc on its worktree.
        a.at(A(12.2), () => body.nativeClickAtElement(EDITOR));
        a.at(A(12.4), () => typeSlowly(app, "/arc", 0));
        a.at(A(12.95), () => app.nativeKey("Return"));
        a.at(A(13.1), () => typeSlowly(app, ARC_COMMAND_ARGS, 0));
        a.at(A(13.8), () => app.nativeKey("Escape"));
        a.at(A(14.1), () => app.nativeKey("Return", ["cmd"]));
        // The arc's first step starts and the arc is bound to this card, in the ledger and on the deck.
        a.at(A(14.4), async () => {
          await arcVerb(repo, cli, ["step", ARC.name, "start", "1", "--through", String(ARC.steps.length)]);
          for (let tries = 0; ; tries++) {
            try {
              await arcVerb(repo, cli, ["bind", ARC.name, "--json"], sid);
              break;
            } catch (e) {
              if (tries >= 6) throw e;
              await Bun.sleep(300);
            }
          }
          const bindOk = { tug_session_id: sid, arc_id: created.id, arc_name: ARC.name };
          await app.dispatchControlAction("bind_arc_ok", bindOk);
          await body.evalJS<null>(`(window.__tug.dispatchControlAction("bind_arc_ok", ${JSON.stringify(bindOk)}), null)`);
        });
        // "The work moves onto a git worktree and through an ordered set of steps": the shade's arc lane, with the track.
        a.at(A(15.2), () => app.dispatchControlAction("reveal-session-changes", { cardId: CARD }));
        [16.4, 17.5, 18.6].forEach((t, i) => {
          a.at(A(t), () => later(arcVerb(repo, cli, ["step", ARC.name, "done", String(i + 1)]).then(() => arcVerb(repo, cli, ["step", ARC.name, "start", String(i + 2), "--through", String(ARC.steps.length)]))));
        });
        a.at(A(19.2), async () => {
          notes.laneA = await has(LANE);
          notes.rowA = await has(`${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC.name}"]`);
          notes.phaseA = await phase();
        });
        a.mark("loop-end", A(BURST_A_END));
        const readingA = await a.record(app, { outDir: outDirFor("bigger-changes-a"), settleMs: 300 });
        expectRecorded(readingA);
        await Promise.all(pending);

        // ---- Between the bursts: the rounds, the build, the offer ---------
        // The shade from burst A goes down first (⌃⌘C toggles it), so the offer's own reveal is what stands when burst B opens.
        await focus();
        await Bun.sleep(200);
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await pollFor(() => has(SHEET), (up) => !up, 10_000).catch(() => note("the burst-A shade stayed up"));
        note("committing the rounds");
        for (let i = 0; i < ARC.steps.length; i++) {
          applyStep(created.worktree, i);
          commitRound(repo, ARC.name, `feat(spend): ${ARC.steps[i]!.title.toLowerCase()}`, cli);
        }
        await arcVerb(repo, cli, ["step", ARC.name, "done", String(ARC.steps.length)]);
        // A verify pass, so the report reads verified rather than "no verify has passed"; the clone declares no surfaces.
        await arcVerb(repo, cli, ["verify", ARC.name]).catch((e) => note(`verify: ${String(e).slice(0, 300)}`));
        note("marking the arc built");
        markArcBuilt(repo, ARC.name, cli);
        // The offer reveals the shade in join mode by itself; its register settles to `ready` once the join is resolved and verified.
        const registerRead = `(function(){ var r = document.querySelector('[data-slot="arc-join-register"]'); return r === null ? null : { word: r.getAttribute("data-word"), text: r.textContent }; })()`;
        await pollFor(() => has(JOIN_BUTTON), (up) => up, 90_000).catch(async (e) => {
          // Why the room stayed shut: the arc's own records and the register's word.
          notes.offerStatus = await arcVerb(repo, cli, ["status", ARC.name, "--json"]).catch((x) => String(x));
          notes.offerRecord = await arcVerb(repo, cli, ["record", ARC.name, "--json"]).catch((x) => String(x));
          notes.register = await body.evalJS<unknown>(registerRead).catch(() => null);
          notes.sheetUp = await has(SHEET);
          note(`offer timed out: ${JSON.stringify(notes)}`);
          throw e;
        });
        note("join offered; waiting for ready");
        await pollFor(() => has(READY), (ready) => ready, 240_000);
        notes.ready = true;
        // The shade goes down for the cut (⌃⌘C toggles it), and stays down: the offer re-reveals it once more as its
        // attention settles, so the toggle is repeated until the shade has been down for a while. Burst B opens it on camera.
        await Bun.sleep(3_000);
        for (let tries = 0; tries < 4; tries++) {
          if (!(await has(SHEET))) {
            await Bun.sleep(2_000);
            if (!(await has(SHEET))) break;
          }
          await focus();
          await Bun.sleep(200);
          await app.nativeKey("c", ["ctrl", "cmd"]);
          await Bun.sleep(1_200);
        }
        notes.sheetDownBeforeB = !(await has(SHEET));
        await Bun.sleep(800);

        // ---- Burst B: the join --------------------------------------------
        const b = scene().mark("loop-start", 0);
        const B = (t: number) => ms(t, BURST_B_AT);
        // "I join an arc from the Changes tab": ⌃⌘C on the bound card opens the shade in join mode.
        b.at(B(30.7), async () => {
          await focus();
          await Bun.sleep(120);
          await app.nativeKey("c", ["ctrl", "cmd"]);
        });
        // The join wants a message of the user's own, like a commit does: typed, then the Join button, the card fronted first.
        b.at(B(32.1), () => body.nativeClickAtElement(EDITOR));
        b.at(B(32.3), () => typeSlowly(app, JOIN_MESSAGE, 60));
        b.at(B(34.0), () => focus());
        b.at(B(34.25), () => body.nativeClickAtElement(JOIN_BUTTON));
        b.mark("loop-end", B(BURST_B_END));
        const readingB = await b.record(app, { outDir: outDirFor("bigger-changes-b"), settleMs: 300 });

        await pollFor(() => has(JOIN_RECEIPT), (landed) => landed, 120_000);
        notes.baseTip = git(repo, "log", "-1", "--format=%s", "main");
        notes.worktreeGone = !existsSync(created.worktree);
        notes.receiptAt = Date.now();

        const size = await contentSize(app);
        for (const [name, reading, from, to] of [
          ["bigger-changes-a", readingA, BURST_A_AT, BURST_A_END],
          ["bigger-changes-b", readingB, BURST_B_AT, BURST_B_END],
        ] as const) {
          writeFileSync(
            join(outDirFor(name), "shot.json"),
            JSON.stringify({ shot: name, mode: MODE, audioOffsetSecs: from, audioEndSecs: to, contentSize: size, cards: [CARD], rects, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
          );
        }
        expectRecorded(readingB);
        expect(notes.laneA, "the arc lane stood in burst A").toBe(true);
        expect(notes.baseTip, "the join moved main").not.toBe("chore: the scene's arc config");
        expect(notes.worktreeGone, "the join cleaned up the worktree").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
