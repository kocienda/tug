#!/usr/bin/env bun
/**
 * layout-recording-fixture.ts — turn a lab layout recording into the committed
 * chord fixture.
 *
 *   bun scripts/lab/layout-recording-fixture.ts [pid.json] [session.json]
 *
 * Reads the two files `tests/app-test/readings/lab-layout-recording.test.ts`
 * writes in a lab guest (fetched with `just lab-app-test … --fetch`), and
 * writes `tugdeck/src/components/tugways/__tests__/fixtures/keyboard-layouts.json`:
 * one row per press, `[code, modifiers, key, keyCode]`, from the pid-mode
 * recording, every punctuation menu try with the item AppKit reached, and the
 * presses where the session-tap recording differs from the pid one. The rows
 * are one per line so a re-recording diffs by press.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const LOGS = join(ROOT, "tests", "app-test", "logs");
const pidPath = process.argv[2] ?? join(LOGS, "lab-layout-recording-pid.json");
const sessionPath = process.argv[3] ?? join(LOGS, "lab-layout-recording-session.json");
const OUT = join(ROOT, "tugdeck", "src", "components", "tugways", "__tests__", "fixtures", "keyboard-layouts.json");

interface Pressed { key: string; code: string; keyCode: number; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }
interface Press { code: string; mods: string[]; event: Pressed | null; skipped?: string }
interface MenuTry {
  chord: { key: string; mods: string[]; command: string; keyEquivalent: string };
  why: string;
  pressed: { code: string; mods: string[] };
  event: Pressed | null;
  fired: { identifier: string | null }[];
  skipped?: string;
}
interface Layout { id: string; name: string | null; keyboardType: number; presses: Press[]; menu: MenuTry[] }
interface Recording { recorded: string; guest: string; systemKeyboardType: number; layouts: Layout[] }

const pid = JSON.parse(readFileSync(pidPath, "utf8")) as Recording;
const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Recording;

const same = (a: Pressed | null, b: Pressed | null) =>
  a === b ||
  (a !== null && b !== null && a.key === b.key && a.code === b.code && a.keyCode === b.keyCode);

const lines: string[] = [];
lines.push("{");
lines.push(` "recorded": ${JSON.stringify(pid.recorded)},`);
lines.push(` "guest": ${JSON.stringify(`macOS ${pid.guest}, Tart lab guest`)},`);
lines.push(` "systemKeyboardType": ${pid.systemKeyboardType},`);
lines.push(` "source": "tests/app-test/readings/lab-layout-recording.test.ts, pid mode; rows are [code, modifiers, key, keyCode]",`);
lines.push(` "layouts": [`);
pid.layouts.forEach((layout, li) => {
  const other = session.layouts[li];
  const differs: string[] = [];
  layout.presses.forEach((p, pi) => {
    if (!same(p.event, other.presses[pi].event)) {
      differs.push(`${p.code}+${p.mods.join("+")}: ${other.presses[pi].event === null ? "no keydown" : JSON.stringify(other.presses[pi].event!.key)}`);
    }
  });
  lines.push("  {");
  lines.push(`   "id": ${JSON.stringify(layout.id)},`);
  lines.push(`   "name": ${JSON.stringify(layout.name)},`);
  lines.push(`   "keyboardType": ${layout.keyboardType},`);
  lines.push(`   "sessionTapDiffers": ${JSON.stringify(differs)},`);
  lines.push(`   "presses": [`);
  const rows = layout.presses.map((p) =>
    JSON.stringify(p.event === null ? [p.code, p.mods.join("+"), null, null] : [p.code, p.mods.join("+"), p.event.key, p.event.keyCode]),
  );
  rows.forEach((r, i) => lines.push(`    ${r}${i < rows.length - 1 ? "," : ""}`));
  lines.push("   ],");
  lines.push(`   "menu": [`);
  const tries = layout.menu.map((t) =>
    JSON.stringify({
      command: t.chord.command,
      chord: [t.chord.key, t.chord.mods.join("+")],
      keyEquivalent: t.chord.keyEquivalent,
      why: t.why,
      pressed: [t.pressed.code, t.pressed.mods.join("+")],
      event: t.event === null ? null : [t.event.key, t.event.keyCode],
      fired: t.skipped !== undefined ? "skipped" : (t.fired[0]?.identifier ?? null),
    }),
  );
  tries.forEach((r, i) => lines.push(`    ${r}${i < tries.length - 1 ? "," : ""}`));
  lines.push("   ]");
  lines.push(`  }${li < pid.layouts.length - 1 ? "," : ""}`);
});
lines.push(" ]");
lines.push("}");
writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(`wrote ${OUT}`);
