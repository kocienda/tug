/**
 * at0871-arc-sketch-atom-reach.test.ts — an arc atom and a sketch atom placed
 * in a prompt give the model something it can actually read.
 *
 * ## What this gates
 *
 * at0602's shape, for the two records that joined the session as citable
 * objects. The unit tests know each half: the blocks' grammar, the wire
 * builder that appends them, the synthesizer that strips them. What only the
 * app can show is the two halves at once over one submission, and the
 * commands the blocks print answering from a real record.
 *
 *   A. **The blocks ride out.** The submission's `user_message` ends with a
 *      `tug:arc-refs` block and then a `tug:sketch-refs` block, each naming
 *      the checkout that owns the record and a verdict that is not
 *      `unverified`. The card is open on another project, so both say
 *      `elsewhere` and the arc's read carries `--project`.
 *
 *   B. **And they are not in the transcript.** The same submission's row
 *      shows an arc pill and a sketch chip and none of the blocks' text.
 *
 *   C. **The commands the blocks print answer.** The arc's read, with
 *      `--document sketch`, and the sketch's read, run against the seeded
 *      record, both print the sketch's text. The arc was discarded and its
 *      documents deleted, so the arc's answer comes from the archive alone.
 *
 *   D. **A replay keeps the identity.** The captured wire content fed back
 *      through `add_user_message` comes out as an arc pill and a sketch chip
 *      whose attributes carry the owning checkout, which only the blocks
 *      could have supplied: the markers hold names and nothing more.
 *
 * The record is seeded through this checkout's real `tugtool` under a scratch
 * `TUG_DATA_DIR`, so nothing here touches the user's own Tug data. The
 * server's answers reach the card through the production `resolve_arcs_ok`
 * and `resolve_sketches_ok` handlers, built from that record's own JSON.
 *
 * @covers tugdeck/src/lib/arc-ref-block.ts
 * @covers tugdeck/src/lib/sketch-ref-block.ts
 * @covers tugdeck/src/lib/build-wire-payload.ts
 * @covers tugdeck/src/lib/synthesize-user-message.ts
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT

/** This checkout's own `tugtool`, which `just app-test-build` builds. */
const TUGTOOL = resolve(import.meta.dir, "../../tugrust/target/debug/tugtool");

const SESSION_A = "aa11bb22-0000-4000-8000-00000000a871";
/** The project the card is open on — not the one that owns the arc. */
const ALPHA_DIR = "/Users/tester/src/alpha";

const ARC = "scratchy";
const SKETCH_TEXT = "the scratchy sketch says hello";

const CARD = '[data-card-id="A"]';
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
/**
 * The arc pill's outer span, which carries the atom's identity. `ArcSigil`
 * inside it wears the same slot, so the slot alone counts each pill twice.
 */
const ARC_PILL = '[data-slot="tug-arc-atom"][data-atom-type="arc"]';
const SKETCH_CHIP = '[data-atom-type="sketch"]';

interface Seed {
  root: string;
  repo: string;
  env: Record<string, string>;
  created: string;
  sketchId: string;
  /** `tugtool sketch show --versions --json`'s data: a resolve row's shape. */
  sketchRow: Record<string, unknown>;
}

/** Run this checkout's tugtool against the scratch data dir, and only it. */
function tug(seed: Pick<Seed, "env">, args: string[], cwd: string) {
  const out = Bun.spawnSync([TUGTOOL, ...args], { cwd, env: seed.env });
  return {
    code: out.exitCode,
    stdout: out.stdout.toString(),
    stderr: out.stderr.toString(),
  };
}

/**
 * A scratch repository with one arc that was opened, sketched, discarded and
 * stripped of its documents, so only the archive can answer for it.
 */
function seedRecord(): Seed {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "at0871-")));
  const repo = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  // A clean environment: no session id to bind to, no instance to resolve
  // into, and a data dir that is the scratch one.
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    TUG_DATA_DIR: join(root, "data"),
  };
  const git = (args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, env });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git(["init", "-q", "-b", "main", "."]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const seed = { env };
  const step = (args: string[]) => {
    const r = tug(seed, args, repo);
    if (r.code !== 0) throw new Error(`tugtool ${args.join(" ")}: ${r.stderr}${r.stdout}`);
    return r.stdout;
  };
  step(["arc", "create", ARC, "--json"]);
  const docs = join(repo, ".tug", "arcs", ARC);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "brief.md"), "# The scratchy brief\n\nbody\n");
  writeFileSync(join(docs, "sketch.md"), `${SKETCH_TEXT}\n`);
  step(["sketch", "record", ARC]);
  step(["arc", "discard", ARC]);
  step(["arc", "delete-documents", ARC]);
  const shown = JSON.parse(step(["arc", "show", ARC, "--json"])) as {
    data: { created: string; status: string; sketch_id: string };
  };
  expect(shown.data.status).toBe("discarded");
  const sketchId = shown.data.sketch_id;
  const versions = JSON.parse(step(["sketch", "show", sketchId, "--versions", "--json"])) as {
    data: Record<string, unknown>;
  };
  return {
    root,
    repo,
    env,
    created: shown.data.created,
    sketchId,
    sketchRow: versions.data,
  };
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 820, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface WireMessage {
  type: string;
  content: Array<{ type: string; text?: string }>;
}

/** The command a block line offers after `read:`, as argv. */
function readCommand(block: string, marker: string): string[] {
  const line = block.split("\n").find((l) => l.startsWith(marker)) ?? "";
  const m = / — read: (.+)$/.exec(line);
  expect(m).not.toBeNull();
  const argv = (m?.[1] ?? "").split(" ");
  expect(argv[0]).toBe("tugtool");
  return argv.slice(1);
}

describe.skipIf(!SHOULD_RUN)("at0871 — an arc atom and a sketch atom the model can read", () => {
  test(
    "both reference blocks ride the wire, stay out of the transcript, and name commands that answer",
    async () => {
      const seed = seedRecord();
      const leaf = basename(seed.repo);
      const arcAtom = {
        kind: "atom" as const,
        type: "arc",
        label: ARC,
        value: `${leaf}/${ARC}`,
        arc: { projectDir: seed.repo, created: seed.created },
      };
      const sketchAtom = {
        kind: "atom" as const,
        type: "sketch",
        label: `sketch:${seed.sketchId}`,
        value: seed.sketchId,
        sketch: { projectDir: seed.repo },
      };
      const app = await launchTugApp({ testName: "at0871-arc-sketch-atom-reach" });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SESSION_A, projectDir: ALPHA_DIR });
        await ingest({ type: "replay_started", tug_session_id: SESSION_A });
        await ingest({
          type: "replay_complete",
          tug_session_id: SESSION_A,
          count: 0,
          firstLoadedTurnIndex: 0,
          totalTurns: 0,
          hasOlder: false,
        });

        // The server's answers, through the production handlers, built from
        // the seeded record's own JSON. Delivered in A's body, whose page
        // holds the stores the send reads.
        await app.body("A").evalJS<boolean>(
          `window.__tug.dispatchControlAction("resolve_arcs_ok", ${JSON.stringify({
            project_dir: seed.repo,
            found: [{ name: ARC, fate: "discarded", created: seed.created }],
            missing: [],
          })})`,
        );
        await app.body("A").evalJS<boolean>(
          `window.__tug.dispatchControlAction("resolve_sketches_ok", ${JSON.stringify({
            project_dir: ALPHA_DIR,
            found: [seed.sketchRow],
            missing: [],
          })})`,
        );

        await app.driveSession("A", {
          op: "send",
          text: "compare ￼ with ￼ please",
          atoms: [arcAtom, sketchAtom],
        });

        // ---- A. The blocks ride out. ---------------------------------------
        await app.body("A").waitForCondition<boolean>(
          `window.__tug.lastSentUserMessage("A") !== null`,
          { timeoutMs: 10_000 },
        );
        const wire = JSON.parse(
          (await app.body("A").evalJS<string>(`window.__tug.lastSentUserMessage("A")`))!,
        ) as WireMessage;
        note("at0871 wire", JSON.stringify(wire).slice(0, 900));
        expect(wire.type).toBe("user_message");
        const texts = wire.content.map((b) => b.text ?? "");
        const arcBlock = texts[texts.length - 2];
        const sketchBlock = texts[texts.length - 1];
        expect(arcBlock.startsWith("<!-- tug:arc-refs -->")).toBe(true);
        expect(sketchBlock.startsWith("<!-- tug:sketch-refs -->")).toBe(true);
        expect(arcBlock).toContain(`- @arc:${leaf}/${ARC} — project ${seed.repo}`);
        expect(arcBlock).toContain("fate: discarded, verdict: elsewhere");
        expect(arcBlock).not.toContain("unverified");
        expect(sketchBlock).toContain(`- @sketch:${seed.sketchId} — project ${seed.repo}`);
        expect(sketchBlock).toContain(`arc ${ARC}, versions 1, verdict: elsewhere`);
        expect(sketchBlock).not.toContain("unverified");
        const body = texts.slice(0, -2).join("");
        expect(body).toContain(`\`@arc:${leaf}/${ARC}\``);
        expect(body).toContain(`\`@sketch:${seed.sketchId}\``);

        // ---- B. And they are not in the transcript. ------------------------
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var body = document.querySelector(${JSON.stringify(USER_BODY)});
            return body !== null
              && body.querySelector(${JSON.stringify(ARC_PILL)}) !== null
              && body.querySelector(${JSON.stringify(SKETCH_CHIP)}) !== null;
          })()`,
          { timeoutMs: 10_000 },
        );
        const row = await app.body("A").evalJS<{ text: string; arcs: number; sketches: number }>(
          `(function(){
            var body = document.querySelector(${JSON.stringify(USER_BODY)});
            return {
              text: (body.textContent || "").replace(/\\s+/g, " ").trim(),
              arcs: body.querySelectorAll(${JSON.stringify(ARC_PILL)}).length,
              sketches: body.querySelectorAll(${JSON.stringify(SKETCH_CHIP)}).length,
            };
          })()`,
        );
        note("at0871 row", JSON.stringify(row));
        expect(row.arcs).toBe(1);
        expect(row.sketches).toBe(1);
        expect(row.text).not.toContain("tug:arc-refs");
        expect(row.text).not.toContain("tug:sketch-refs");
        expect(row.text).not.toContain("verdict:");

        // ---- C. The commands the blocks print answer. ----------------------
        const arcRead = tug(seed, [...readCommand(arcBlock, "- @arc:"), "--document", "sketch"], seed.root);
        note("at0871 arc read", `exit ${arcRead.code} ${arcRead.stdout.slice(0, 200)}${arcRead.stderr.slice(0, 200)}`);
        expect(arcRead.code).toBe(0);
        expect(arcRead.stdout).toContain(SKETCH_TEXT);
        const sketchRead = tug(seed, readCommand(sketchBlock, "- @sketch:"), seed.root);
        note("at0871 sketch read", `exit ${sketchRead.code} ${sketchRead.stdout.slice(0, 200)}${sketchRead.stderr.slice(0, 200)}`);
        expect(sketchRead.code).toBe(0);
        expect(sketchRead.stdout).toContain(SKETCH_TEXT);

        // ---- D. A replay keeps the identity. -------------------------------
        await ingest({ type: "replay_started", tug_session_id: SESSION_A });
        await ingest({ type: "add_user_message", tug_session_id: SESSION_A, content: wire.content });
        await ingest({
          type: "replay_complete",
          tug_session_id: SESSION_A,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var bodies = document.querySelectorAll(${JSON.stringify(USER_BODY)});
            var last = bodies[bodies.length - 1];
            return last !== undefined
              && last.querySelector(${JSON.stringify(ARC_PILL)}) !== null
              && last.querySelector(${JSON.stringify(SKETCH_CHIP)}) !== null;
          })()`,
          { timeoutMs: 10_000 },
        );
        const replayed = await app.body("A").evalJS<{
          arcDir: string | null;
          arcCreated: string | null;
          sketchDir: string | null;
          text: string;
        }>(
          `(function(){
            var bodies = document.querySelectorAll(${JSON.stringify(USER_BODY)});
            var last = bodies[bodies.length - 1];
            var arc = last.querySelector(${JSON.stringify(ARC_PILL)});
            var sketch = last.querySelector(${JSON.stringify(SKETCH_CHIP)});
            return {
              arcDir: arc.getAttribute("data-atom-arc-project-dir"),
              arcCreated: arc.getAttribute("data-atom-arc-created"),
              sketchDir: sketch.getAttribute("data-atom-sketch-project-dir"),
              text: (last.textContent || "").replace(/\\s+/g, " ").trim(),
            };
          })()`,
        );
        note("at0871 replayed", JSON.stringify(replayed));
        expect(replayed.arcDir).toBe(seed.repo);
        expect(replayed.arcCreated).toBe(seed.created);
        expect(replayed.sketchDir).toBe(seed.repo);
        expect(replayed.text).not.toContain("tug:arc-refs");
        expect(replayed.text).not.toContain("tug:sketch-refs");
      } finally {
        await app.close();
        rmSync(seed.root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
