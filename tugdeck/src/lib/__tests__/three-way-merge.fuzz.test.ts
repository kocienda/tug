/**
 * three-way-merge, fuzzed against git as the oracle.
 *
 * `mergeThreeWay` is the highest-impact piece of the disk-sync work: when it
 * is wrong the user gets a file neither they nor the agent wrote, silently,
 * with no surface saying anything happened. Six hand-written fixtures in
 * `three-way-merge.test.ts` say the module refuses what it should refuse; they
 * cannot say anything about the cases nobody thought to write down.
 *
 * So this suite generates them, from a seeded PRNG, and checks every accepted
 * merge against `git merge-file` — a diff3 implementation with thirty years of
 * adversarial use behind it.
 *
 * ## One direction only
 *
 * The assertion is: **whenever `mergeThreeWay` returns `ok`, git also merges
 * clean and produces byte-identical text.** The converse is deliberately NOT
 * asserted, because this merge is stricter than git's on purpose — abutting
 * hunks, two insertions at one point, and a coarse diff are all refusals here
 * and clean merges for git. Refusing more than git is the design ([B06]); a
 * suite that asserted the other direction would be asserting the design is
 * wrong.
 *
 * That asymmetry is also why the oracle runs only on the accepted cases: a
 * refusal has nothing to check, and skipping it keeps the suite's git spend
 * proportional to what it actually verifies.
 *
 * ## The shapes, and why they are named rather than only random
 *
 * Pure random edits on a 30-line file land far apart most of the time, so an
 * unbiased generator would spend thousands of cases re-checking the easy case
 * and reach the interesting ones by luck. Each shape below constructs the
 * situation it is named for, and the suite asserts that every shape actually
 * produced accepted merges — a generator bug that made a category vacuous
 * would otherwise read as a pass.
 *
 * ## How git is resolved, and why not by running it
 *
 * `tugcore::host_tools` is the one implementation of this and its ORDER is
 * load-bearing ([D171]): on a Mac with no active developer directory
 * `/usr/bin/git` is Apple's shim, and running it pops a system modal. So the
 * resolution here mirrors `host_tools::route` — resolve `git` on `PATH` with
 * its symlinks followed, and treat it as real git unless it IS the shim; only
 * the shim (or nothing) asks the silent `xcode-select -p`, and only its exit 0
 * makes running git safe. There is no bare `git --version` probe anywhere in
 * this file.
 *
 * With no usable git the whole suite skips. That is the intended shape: it is
 * a dev-machine suite that borrows a host tool Tug does not ship.
 *
 * ## What this suite was proven able to fail on
 *
 * A `tugtool file probe` loosening `touches` in `three-way-merge.ts` to a
 * half-open comparison — `x.a0 < y.a1 && y.a0 < x.a1`, which is the obvious
 * and wrong spelling, and makes abutting hunks mergeable: **red inside the
 * first dozen generated cases**, on three different shapes, each failure
 * reporting the triple that produced it and git's conflicted output beside
 * ours. The hand-written refusals catch that same loosening, so what the
 * probe establishes here is that the generator reaches the class on its own
 * rather than that it is the only guard against it.
 *
 * With `touches` correct, 3000 generated cases produce no disagreement with
 * git at all — which is the reading this suite exists to give, and the one
 * the fixtures could not.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeThreeWay } from "@/lib/three-way-merge";

// ---------------------------------------------------------------------------
// Resolving git the way `tugcore::host_tools` does
// ---------------------------------------------------------------------------

/** Apple's shim: present on every booted Mac, and running it may prompt. */
const SHIM_GIT = "/usr/bin/git";
/**
 * Absolute on purpose, exactly as `host_tools` has it: `xcode-select` is a
 * sealed-System Apple binary, and resolving it through `PATH` would let
 * somebody's shim answer for the OS.
 */
const XCODE_SELECT = "/usr/bin/xcode-select";

/**
 * A git that is safe to run, or `null`. Mirrors `host_tools::route`: a `PATH`
 * resolution that is not the shim is real git and is used as-is; the shim, or
 * nothing at all, has to clear `xcode-select -p` first.
 */
function resolveGit(): string | null {
  const found = Bun.which("git");
  // The shim is a FILE rather than a spelling — a `git` symlinked onto
  // `/usr/bin/git` pops the same modal — so follow the symlinks first.
  const resolved = found === null ? null : safeRealpath(found);
  const isShim = process.platform === "darwin" && resolved === SHIM_GIT;
  if (resolved !== null && !isShim) return resolved;
  if (process.platform !== "darwin") return null;
  const probe = spawnSync(XCODE_SELECT, ["-p"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  return resolved ?? SHIM_GIT;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const GIT = resolveGit();

// ---------------------------------------------------------------------------
// The seeded generator
// ---------------------------------------------------------------------------

/** How many triples the suite generates. */
const CASES = 3000;
/** Fixed, so a failure is reproducible from the message alone. */
const SEED = 0x7f4a7c15;
/** How many mismatches to collect before giving up — the first few carry it. */
const MAX_REPORTED = 5;

/** mulberry32: small, seedable, and good enough to generate text fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;

function int(rand: Rand, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[int(rand, 0, items.length - 1)] as T;
}

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"] as const;

/** A triple, with the LF-normalized texts every caller of the merge hands in. */
interface Triple {
  base: string;
  ours: string;
  theirs: string;
}

/** Base lines, each already carrying its terminator (what `splitLines` yields). */
function baseLines(rand: Rand): string[] {
  const n = int(rand, 6, 40);
  return Array.from(
    { length: n },
    (_, i) => `line ${String(i).padStart(3, "0")} ${pick(rand, WORDS)}\n`,
  );
}

function edited(lines: string[], i: number, text: string): string[] {
  const out = lines.slice();
  out[i] = text;
  return out;
}

function inserted(lines: string[], i: number, added: string[]): string[] {
  const out = lines.slice();
  out.splice(i, 0, ...added);
  return out;
}

function deleted(lines: string[], i: number, k: number): string[] {
  const out = lines.slice();
  out.splice(i, k);
  return out;
}

/** Drop the final terminator — the "no trailing newline" file. */
function unterminated(lines: string[]): string[] {
  const out = lines.slice();
  const last = out.length - 1;
  if (last >= 0) out[last] = (out[last] as string).replace(/\n$/, "");
  return out;
}

/** One edit applied at a named line, so a shape can place two of them. */
function editAt(rand: Rand, lines: string[], i: number): string[] {
  const kind = int(rand, 0, 2);
  if (kind === 0) return edited(lines, i, `EDITED ${pick(rand, WORDS)} at ${i}\n`);
  if (kind === 1) {
    const k = int(rand, 1, 3);
    return inserted(
      lines,
      i,
      Array.from({ length: k }, (_, j) => `INSERTED ${j} ${pick(rand, WORDS)}\n`),
    );
  }
  return deleted(lines, i, 1);
}

interface Shape {
  name: string;
  /** Whether the shape is built to produce refusals as well as merges. */
  refusesToo: boolean;
  build(rand: Rand): Triple;
}

const SHAPES: readonly Shape[] = [
  {
    // Edits far enough apart that both must survive — the case the disk-sync
    // work exists for, and the one a regression would break first.
    name: "distant",
    refusesToo: false,
    build(rand) {
      const a = baseLines(rand);
      const lo = int(rand, 0, Math.max(0, Math.floor(a.length / 2) - 2));
      const hi = int(rand, Math.floor(a.length / 2) + 2, a.length - 1);
      return {
        base: a.join(""),
        ours: editAt(rand, a, lo).join(""),
        theirs: editAt(rand, a, hi).join(""),
      };
    },
  },
  {
    // The same line, or the line next to it. Mostly refusals — and the ones
    // that are NOT refusals are exactly what the oracle is here to check.
    name: "touching",
    refusesToo: true,
    build(rand) {
      const a = baseLines(rand);
      const i = int(rand, 0, a.length - 2);
      const j = rand() < 0.5 ? i : i + 1;
      return {
        base: a.join(""),
        ours: editAt(rand, a, i).join(""),
        theirs: editAt(rand, a, j).join(""),
      };
    },
  },
  {
    // Both sides made the same change — the user saved what the agent had
    // already written. It must be applied ONCE, which is the assertion git
    // checks by producing the same single copy.
    name: "identical",
    // Never a refusal: the identical change is the one mergeable touch, and
    // adding a distant change to one side cannot make it conflict. That the
    // tally holds this to zero is itself the assertion.
    refusesToo: false,
    build(rand) {
      const a = baseLines(rand);
      const i = int(rand, 0, Math.max(0, Math.floor(a.length / 2) - 2));
      const shared = editAt(rand, a, i);
      if (rand() < 0.5) return { base: a.join(""), ours: shared.join(""), theirs: shared.join("") };
      // The same change on both sides plus one distant change on one side.
      const far = int(rand, Math.floor(a.length / 2) + 2, shared.length - 1);
      return {
        base: a.join(""),
        ours: shared.join(""),
        theirs: editAt(rand, shared, far).join(""),
      };
    },
  },
  {
    // Appends at EOF. Two different appends are the refusal the hand-written
    // fixtures pin; one-sided appends and identical appends are merges.
    name: "eof-append",
    refusesToo: true,
    build(rand) {
      const a = baseLines(rand);
      const base = a.join("");
      const mine = `APPENDED ours ${pick(rand, WORDS)}\n`;
      const yours = `APPENDED theirs ${pick(rand, WORDS)}\n`;
      const roll = int(rand, 0, 2);
      if (roll === 0) return { base, ours: base + mine, theirs: base };
      if (roll === 1) return { base, ours: base, theirs: base + yours };
      return { base, ours: base + mine, theirs: base + yours };
    },
  },
  {
    // A file with no final terminator, which is where line-based merges go
    // wrong: the last line is a different string on the two sides even when
    // nobody edited its text.
    name: "no-trailing-newline",
    refusesToo: true,
    build(rand) {
      const a = unterminated(baseLines(rand));
      const base = a.join("");
      const roll = int(rand, 0, 2);
      if (roll === 0) {
        // One side restores the terminator; the other edits a distant line.
        const ours = base + "\n";
        const theirs = editAt(rand, a, int(rand, 0, Math.max(0, a.length - 4))).join("");
        return { base, ours, theirs };
      }
      if (roll === 1) {
        // One side extends the unterminated last line.
        const ours = edited(a, a.length - 1, `${a[a.length - 1]} EXTENDED`).join("");
        const theirs = editAt(rand, a, int(rand, 0, Math.max(0, a.length - 4))).join("");
        return { base, ours, theirs };
      }
      // Both sides touch the last line — a refusal, unless they agree.
      return {
        base,
        ours: edited(a, a.length - 1, `${a[a.length - 1]} OURS`).join(""),
        theirs: edited(a, a.length - 1, `${a[a.length - 1]} THEIRS`).join(""),
      };
    },
  },
  {
    // Several uncoordinated edits per side: the general case, and the one that
    // finds interactions the named shapes were not built to produce.
    name: "scatter",
    refusesToo: true,
    build(rand) {
      const a = baseLines(rand);
      let ours = a;
      let theirs = a;
      for (let k = int(rand, 1, 4); k > 0; k--) {
        ours = editAt(rand, ours, int(rand, 0, ours.length - 1));
      }
      for (let k = int(rand, 1, 4); k > 0; k--) {
        theirs = editAt(rand, theirs, int(rand, 0, theirs.length - 1));
      }
      return { base: a.join(""), ours: ours.join(""), theirs: theirs.join("") };
    },
  },
];

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

interface OracleAnswer {
  /** `git merge-file`'s exit status: 0 clean, >0 the conflict count. */
  status: number;
  text: string;
}

/**
 * `git merge-file -p <ours> <base> <theirs>` — the whole oracle. `-p` writes
 * the result to stdout instead of over the first file, and the exit status is
 * the number of conflicts, so `0` is "merged clean".
 *
 * `--diff3` is deliberately not passed: the default output is what a clean
 * merge produces, and conflict markers are never compared here because a
 * conflicted merge fails on its status first.
 */
function gitMergeFile(paths: { base: string; ours: string; theirs: string }, triple: Triple): OracleAnswer {
  writeFileSync(paths.base, triple.base, "utf8");
  writeFileSync(paths.ours, triple.ours, "utf8");
  writeFileSync(paths.theirs, triple.theirs, "utf8");
  const run = spawnSync(GIT as string, ["merge-file", "-p", paths.ours, paths.base, paths.theirs], {
    encoding: "utf8",
  });
  if (run.error !== undefined && run.error !== null) {
    throw new Error(`[merge-fuzz] git merge-file did not run: ${String(run.error)}`);
  }
  return { status: run.status ?? -1, text: run.stdout ?? "" };
}

/** A failure's whole corpse: the triple, both answers, and the case index. */
function describeCase(index: number, shape: string, triple: Triple, mine: string, oracle: OracleAnswer): string {
  const show = (label: string, text: string) =>
    `${label} (${text.length}b):\n${JSON.stringify(text)}`;
  return [
    `case ${index} of shape "${shape}" (seed 0x${SEED.toString(16)})`,
    show("base", triple.base),
    show("ours", triple.ours),
    show("theirs", triple.theirs),
    show("mergeThreeWay", mine),
    `git merge-file status ${oracle.status}`,
    show("git merge-file", oracle.text),
  ].join("\n");
}

// ---------------------------------------------------------------------------

describe.skipIf(GIT === null)("mergeThreeWay — fuzzed against git merge-file", () => {
  test(
    "every accepted merge is one git also makes, byte for byte",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "merge-fuzz-"));
      const paths = {
        base: join(dir, "base.txt"),
        ours: join(dir, "ours.txt"),
        theirs: join(dir, "theirs.txt"),
      };
      const rand = mulberry32(SEED);
      const tally = new Map<string, { merged: number; refused: number }>(
        SHAPES.map((s) => [s.name, { merged: 0, refused: 0 }]),
      );
      const mismatches: string[] = [];

      try {
        for (let i = 0; i < CASES; i++) {
          const shape = SHAPES[i % SHAPES.length] as Shape;
          const triple = shape.build(rand);
          const counts = tally.get(shape.name) as { merged: number; refused: number };

          const merged = mergeThreeWay(triple.base, triple.ours, triple.theirs);
          if (!merged.ok) {
            counts.refused++;
            continue;
          }
          counts.merged++;

          const oracle = gitMergeFile(paths, triple);
          if (oracle.status !== 0 || oracle.text !== merged.text) {
            mismatches.push(describeCase(i, shape.name, triple, merged.text, oracle));
            if (mismatches.length >= MAX_REPORTED) break;
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(
        mismatches,
        `accepted merges git does not agree with:\n\n${mismatches.join("\n\n")}`,
      ).toEqual([]);

      // A generator bug that made a shape produce nothing checkable would
      // otherwise read as a pass, so every shape has to have reached the
      // oracle — and the shapes built to be refused have to have been.
      for (const shape of SHAPES) {
        const counts = tally.get(shape.name) as { merged: number; refused: number };
        expect(counts.merged, `shape "${shape.name}" produced accepted merges`).toBeGreaterThan(0);
        if (shape.refusesToo) {
          expect(counts.refused, `shape "${shape.name}" produced refusals`).toBeGreaterThan(0);
        } else {
          // And a shape declared unrefusable really is: `distant` and
          // `identical` are built so that every triple MUST merge, and a
          // regression that started refusing them would otherwise hide behind
          // the one-directional oracle, which checks only what was accepted.
          // The seed and the case count are fixed, so this is as deterministic
          // as the rest of the suite.
          expect(counts.refused, `shape "${shape.name}" refused nothing`).toBe(0);
        }
      }
    },
    120_000,
  );
});
