/**
 * zz-probe-restore-timing.test.ts — throwaway measurement, not a gate.
 *
 * Resumes four real transcripts at once, one per visible pane, and times
 * every stage `TugRestoreGate` holds across: the gate coming up, each change
 * of its readout, each card's replay ingest, list mount and first settle
 * (`perf.transcript_settle`), and the gate going down. A card whose reveal
 * ends with no settle logged was let go by `COLD_REVEAL_SETTLE_BOUND_MS`.
 *
 * @covers tugdeck/src/components/tugways/tug-restore-gate.tsx
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";
import { claudeProjectDir } from "./_harness/claude-home";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const GATE = '[data-slot="tug-restore-gate"]';
const TUG_SITE = join(homedir(), ".claude/projects/-Users-kocienda-Mounts-u-src-tug-site");

const FIXTURES: { card: string; label: string; path: string }[] = [
  { card: "R1", label: "a4250004 (2.9 MB)", path: join(TUG_SITE, "a4250004-8d3f-4825-9844-15acafc1d95f.jsonl") },
  { card: "R2", label: "b75d5dce (181 MB)", path: join(TUG_SITE, "b75d5dce-f7a3-45d9-b5fa-a146d5b2e8eb.jsonl") },
  { card: "R3", label: "cdf8120d (0.4 MB)", path: join(import.meta.dir, "corpus/snapshots/cdf8120d-b7fd-4c36-9689-15d6d87cdcfa.jsonl") },
  { card: "R4", label: "584933a1 (25 MB)", path: join(import.meta.dir, "corpus/snapshots/584933a1-24b7-4479-b2e2-4056fa9a4efc.jsonl") },
];

/** Copy a transcript under a fresh session id and cwd, so nothing touches the original. */
function seed(src: string, projectDir: string): string {
  const text = readFileSync(src, "utf8");
  const oldSid = src.split("/").pop()!.replace(/\.jsonl$/, "");
  let oldCwd: string | null = null;
  for (const line of text.split("\n")) {
    const m = /"cwd":"([^"]+)"/.exec(line);
    if (m) { oldCwd = m[1]!; break; }
  }
  const sid = randomUUID();
  let out = text.replaceAll(oldSid, sid);
  if (oldCwd !== null) out = out.replaceAll(`"cwd":"${oldCwd}"`, `"cwd":"${projectDir}"`);
  const dir = claudeProjectDir(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), out);
  return sid;
}

const deckShape = () => ({
  cards: FIXTURES.map((f) => ({ id: f.card, componentId: "session", title: f.label, closable: true })),
  panes: FIXTURES.map((f, i) => ({
    id: `p${f.card}`,
    position: { x: 20 + (i % 2) * 620, y: 20 + Math.floor(i / 2) * 440 },
    size: { width: 600, height: 420 },
    cardIds: [f.card], activeCardId: f.card, title: "", acceptsFamilies: ["maker"],
  })),
  activePaneId: "pR1",
  hasFocus: true,
});

const stamp = "performance.timeOrigin + performance.now()";

/** Overlay: gate presence and every distinct readout text. */
const INSTALL_GATE = `(function(){
  var log = []; var lastUp = null; var lastText = null;
  var check = function(){
    var el = document.querySelector(${JSON.stringify(GATE)});
    var up = el !== null;
    if (up !== lastUp) { log.push({ t: ${stamp}, kind: up ? "gate-up" : "gate-down" }); lastUp = up; }
    var text = up ? el.textContent : null;
    if (up && text !== lastText) { log.push({ t: ${stamp}, kind: "readout", text: text }); }
    lastText = text;
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  window.__probe = { log: log };
  return null;
})()`;

/** Body: list mount, and the session-lifecycle perf lines. */
const installBody = (card: string) => `(function(){
  var log = []; var seen = false;
  var orig = console.log;
  console.log = function(){
    var s = String(arguments[0]);
    if (s.indexOf("[dev::session-lifecycle]") === 0 && s.indexOf("perf.") >= 0) {
      log.push({ t: ${stamp}, kind: "lifecycle", card: "${card}", text: s.slice(25).split(" tug_session_id=")[0] + " " + (s.match(/ ms=\\d+/) || [""])[0] });
    }
    return orig.apply(console, arguments);
  };
  var check = function(){
    if (seen) return;
    if (document.querySelector('[data-card-id="${card}"] [data-slot="session-card-transcript"] [data-slot="tug-list-view"]') !== null) {
      seen = true; log.push({ t: ${stamp}, kind: "list-mount", card: "${card}" });
    }
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true });
  window.__probe = { log: log };
  return null;
})()`;

interface Ev { t: number; kind: string; card?: string; text?: string }

describe.skipIf(!SHOULD_RUN)("probe — restore gate stage timing", () => {
  test("four real transcripts restoring together", async () => {
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-probe-restore-")));
    writeFileSync(join(projectDir, "README.md"), "probe\n");
    const sids = FIXTURES.map((f) => seed(f.path, projectDir));
    const app = await launchTugApp({ testName: "zz-probe-restore-timing" });
    try {
      await app.seedDeckState({ state: deckShape(), focusCardId: "R1" });
      for (const f of FIXTURES) {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(f.card)})`,
          { timeoutMs: 30_000 },
        );
      }
      const overlay = await overlayReady(app);
      await overlay.evalJS<null>(INSTALL_GATE);
      for (const f of FIXTURES) {
        for (const deadline = Date.now() + 30_000; ;) {
          if ((await app.bodies()).some((b) => b.cardId === f.card && b.state === "ready")) break;
          if (Date.now() > deadline) throw new Error(`${f.card} body not ready`);
          await Bun.sleep(50);
        }
        await app.body(f.card).evalJS<null>(installBody(f.card));
      }
      const t0 = await app.evalJS<number>(`(${stamp})`);
      await app.evalJS<null>(
        `(function(){ ${FIXTURES.map(
          (f, i) => `window.__tug.spawnSessionResume(${JSON.stringify(f.card)}, ${JSON.stringify({ tugSessionId: sids[i], projectDir })});`,
        ).join(" ")} return null; })()`,
      );
      await overlay.waitForCondition<boolean>(
        `window.__probe.log.some(function(e){ return e.kind === "gate-up"; }) && document.querySelector(${JSON.stringify(GATE)}) === null`,
        { timeoutMs: 90_000 },
      );
      await Bun.sleep(300);
      const all: Ev[] = [...(await overlay.evalJS<Ev[]>("window.__probe.log"))];
      for (const f of FIXTURES) all.push(...(await app.body(f.card).evalJS<Ev[]>("window.__probe.log")));
      const log = all
        .filter((e) => e.t >= t0)
        .sort((a, b) => a.t - b.t)
        .map((e) => `${String(Math.round(e.t - t0)).padStart(6)} ms  ${e.card ?? "gate"}  ${e.kind}${e.text ? `  ${e.text.replace("Restoring", "| Restoring").replace("Tug is rebuilding your transcripts. Just a moment.", " | ")}` : ""}`);
      const endedBy = Object.fromEntries(FIXTURES.map((f) => [
        `${f.card} ${f.label}`,
        all.some((e) => e.card === f.card && e.text?.includes("transcript_settle")) ? "settle" : "bound",
      ]));
      note("ended by", endedBy);
      note("timeline", log);
      expect(log.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(claudeProjectDir(projectDir), { recursive: true, force: true });
    }
  }, 200_000);
});
