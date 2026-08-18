/**
 * AT0426 — a candidate the ladder built cannot land unreviewed.
 *
 * The 2026-08-15 landing's worst lesson: the resolution ladder resolved a file
 * by machine, the lane armed `Join` exactly as it would over a clean preview,
 * and nothing on screen said which files a *replayed* resolution had decided or
 * what it decided. A stale rerere entry can keep one side wholesale and discard
 * the other — green build, green tests, broken at runtime. So a candidate built
 * out of per-file resolutions is refused until the diffs have been shown and
 * acknowledged.
 *
 * This drives that on the real path, over a real dash and a real conflict:
 *
 * - The fixture rewinds the dash branch to the parent of a base commit that
 *   modified a file, then rewrites that file wholesale in the dash worktree.
 *   Both sides changed the same lines, so `merge-tree` genuinely conflicts and
 *   the `merge-file` rung genuinely declines. Nothing touches the base branch
 *   or the developer's checkout.
 * - A stub merge driver (`tugdash.mergedriver`, rung 4) resolves it to a fixed
 *   body, so the ladder reaches a candidate deterministically without needing
 *   the AI rung or this repo's `rr-cache`.
 * - The assertions: after Resolve the outcome reads `clean` and yet the row
 *   still refuses to call the dash landable, naming the review as the act that
 *   clears it; the review renders the resolution's diff through the shared diff
 *   document; and the `Reviewed` beat is what finally makes the row state its
 *   landing route.
 *
 * The join is never fired. This test proves the gate, not the landing — landing
 * would rewrite the developer's `main`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  gitRetry as git,
  discardDash,
  smallConflictSubject,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "at0426-session";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0426-review";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const OUTCOME = `${ROW} [data-slot="session-changes-dash-landing-outcome"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const READY = `${ROW} [data-slot="session-changes-dash-landing-ready"]`;
const REVIEW = `${ROW} [data-slot="session-changes-dash-landing-review"]`;
const REVIEWED = `${ROW} [data-slot="session-changes-dash-landing-reviewed"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * The body the stub driver resolves every conflict to.
 *
 * Asserted verbatim in the review face, so it must stay fixed — the per-run
 * nonce below goes in the *dash side* of the conflict, never here.
 */
const DRIVER_BODY = "at0426 resolved by the stub driver\n";

/**
 * The dash side of the conflict, unique per run.
 *
 * The nonce is not cosmetic. rerere is rung 2 and the merge driver is rung 4,
 * so a cached rerere resolution short-circuits ahead of the driver this test
 * exists to exercise — and the ladder teaches rerere whatever the driver
 * decided, writing an entry keyed on the conflict's exact text. Before the
 * conflict subject was pinned, the base side moved with `main` and a stale
 * entry rarely matched. Pinned, the same conflict recurs byte for byte, so a
 * cache entry surviving a killed run (its `afterAll` skipped) would replay,
 * `resolved_by` would come back `rerere`, and the assertion below looking for
 * `driver` would fail. A nonce in this body makes each run's conflict its own.
 */
const DASH_BODY = `at0426 dash side — the whole file, rewritten (${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)})\n`;

/** The base-tip file both sides rewrite — the conflict's subject. */
let conflictFile = "";
/** Where the stub driver lives; outside the repo, so it is not dash work. */
let stubDir = "";

/** Drop the fixture's driver config; safe to call when it was never set. */
function unsetDriver(): void {
  Bun.spawnSync(["git", "-C", PROJECT_DIR, "config", "--unset", "tugdash.mergedriver"], {});
}

/** The repo's `rr-cache` entries, by name. Missing directory ⇒ empty. */
function rrCacheEntries(): Set<string> {
  const dir = git(PROJECT_DIR, "rev-parse", "--git-path", "rr-cache").trim();
  const path = dir.startsWith("/") ? dir : join(PROJECT_DIR, dir);
  try {
    return new Set(readdirSync(path));
  } catch {
    return new Set();
  }
}

/** `rr-cache` names present before the fixture ran, so the run leaves none behind. */
let rrCacheBefore = new Set<string>();

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // Defensive: a previous run killed mid-flight would have left this set, and a
  // stray merge driver would silently decide real joins.
  unsetDriver();
  // The driver rung teaches rerere what it resolved, which writes an entry into
  // this repo's real `rr-cache`. The entry is keyed by the conflict's exact
  // text, so a fixture conflict can never replay onto real work — but it is
  // still the developer's repo, and the run puts it back as it found it.
  rrCacheBefore = rrCacheEntries();
  discardDash(PROJECT_DIR, DASH);
  const created = createDash(PROJECT_DIR, DASH, "at0426 resolution-review fixture");

  // A base commit that modified a SMALL text file, and that file. Rewinding
  // the dash to that commit's parent and rewriting the file wholesale puts
  // both sides on the same lines — a content conflict the `merge-file` rung
  // declines, so the driver rung is the one that resolves it.
  //
  // The size bound is what makes this test about the code rather than about
  // whatever `main` last touched: the server caps a resolution's review diff
  // at 400 lines, so a large subject truncates the driver's decision out of
  // the face and the assertion below looking for it fails for a reason that
  // has nothing to do with the gate under test.
  const subject = smallConflictSubject(PROJECT_DIR);
  conflictFile = subject.path;

  git(created.worktree, "reset", "--hard", `${subject.commit}~1`);
  writeFileSync(join(created.worktree, conflictFile), DASH_BODY);
  commitRound(PROJECT_DIR, DASH, `at0426(round): rewrite ${conflictFile}`);

  // Rung 4's stub: <base> <ours> <theirs> <output> <ext> → write the output.
  stubDir = mkdtempSync(join(tmpdir(), "at0426-driver-"));
  const stub = join(stubDir, "stub-driver.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${DRIVER_BODY}' > "$4"\n`);
  chmodSync(stub, 0o755);
  git(PROJECT_DIR, "config", "tugdash.mergedriver", stub);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  unsetDriver();
  if (stubDir !== "") rmSync(stubDir, { recursive: true, force: true });
  discardDash(PROJECT_DIR, DASH);
  // Remove only what this run taught rerere.
  const dir = git(PROJECT_DIR, "rev-parse", "--git-path", "rr-cache").trim();
  const cacheRoot = dir.startsWith("/") ? dir : join(PROJECT_DIR, dir);
  for (const name of rrCacheEntries()) {
    if (!rrCacheBefore.has(name)) {
      rmSync(join(cacheRoot, name), { recursive: true, force: true });
    }
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/**
 * Press a control on the dash row, scrolling it into the shade's scrollport
 * first. The dash lane renders *below* the changed-file list, whose length is
 * whatever the developer's working tree happens to be, so on a busy tree the
 * row starts under the composer and a bare click lands on the editor instead.
 */
async function revealAndClick(app: App, selector: string): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.scrollIntoView({ block: "center" });
      return true;
    })()`,
  );
  await settle(250);
  await app.nativeClickAtElement(selector);
}

/**
 * Whether the row says this dash can land, and what it says instead.
 *
 * A landable row carries a sentence naming ⌃⌘C and `/dash-join`; every refusing
 * state carries the gate's own words in the same place. The reason has to be
 * face text — a disabled control takes no pointer events, so a tooltip on one
 * is unreachable by construction.
 */
const LANDING_STATE = `(function(){
  var line = document.querySelector(${JSON.stringify(READY)});
  return {
    ready: line !== null && line.getAttribute("data-ready") === "true",
    reason: line === null ? "" : (line.textContent || ""),
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0426: the ladder's candidate is gated on a review", () => {
  test(
    "a resolved candidate refuses Join until the resolution's diff is shown and acknowledged",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0426-dash-resolution-review",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The aggregate has composed the dash once the Lens roster lists it.
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── A conflicted join, aimed by name ──────────────────────────────
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
            return el !== null && el.getAttribute("data-choice-value") === "changes";
          })()`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)})?.getAttribute("data-fronted") === "true"`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(OUTCOME)})?.textContent || "").trim() === "conflicted"`,
          { timeoutMs: 30000 },
        );
        note(`outcome: conflicted over ${conflictFile}`);

        // Nothing claims a conflicted dash is ready — before any of this is
        // about the review.
        const preResolve = await app.evalJS<{ ready: boolean; reason: string }>(LANDING_STATE);
        expect(preResolve.ready).toBe(false);

        // ── Resolve: the driver rung builds a candidate ───────────────────
        // The row's controls settle as the conflict list renders under them;
        // clicking into a still-moving row lands the press on nothing.
        await settle(400);
        await revealAndClick(app, RESOLVE);
        // The store flips to `resolving` synchronously, so the offer face leaves
        // on the click itself. Separating this from the wait below is what tells
        // a dead click apart from a slow ladder.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}) === null`,
          { timeoutMs: 5000 },
        );
        note("Resolve click registered: the offer face left");
        // Wait for whichever terminal face lands, so a ladder that declined
        // reports what it said instead of timing out on a missing selector.
        const terminal = await app.waitForCondition<string>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(ROW)});
            if (row === null) return null;
            if (row.querySelector('[data-slot="session-changes-dash-landing-review"]') !== null) return "review";
            if (row.querySelector('.session-changes-dash-landing-error') !== null)
              return "error: " + row.querySelector('.session-changes-dash-landing-error').textContent;
            return null;
          })()`,
          // The ladder checks out two scratch worktrees of this repo (the rerere
          // rung, then teaching rerere the driver's resolution), so it is slower
          // here than against a tempdir fixture.
          { timeoutMs: 180000 },
        );
        note(`ladder terminal face: ${terminal}`);
        expect(terminal).toBe("review");
        // The outcome flips to `clean` — a resolved candidate is landable
        // history — which is exactly why the review has to be a separate gate.
        // If the gate read the outcome word alone, this is where it would arm.
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(OUTCOME)})?.textContent || "").trim()`,
          ),
        ).toBe("clean");

        // ── The gate: a landable candidate, and the landing still refuses ──
        const refused = await app.evalJS<{ ready: boolean; reason: string }>(LANDING_STATE);
        expect(refused.ready).toBe(false);
        // The sentence names the act that clears it, and it is on screen right
        // above the diffs it is talking about.
        expect(refused.reason).toContain("Review what the ladder resolved first");
        note(`landing refused over a resolved candidate: ${refused.reason}`);

        // What the review puts on screen: the resolved file, and the body the
        // driver actually chose. This is the artifact the incident lacked.
        const reviewText = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(REVIEW)})?.textContent || "")`,
        );
        expect(reviewText).toContain(conflictFile);
        expect(reviewText).toContain("driver");
        expect(reviewText).toContain("at0426 resolved by the stub driver");
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(REVIEW)})?.getAttribute("data-reviewed") ?? null`,
          ),
        ).toBe("false");

        // ── The second beat arms it ───────────────────────────────────────
        // The press is a round trip, not a local flip: the server writes the
        // mark against this candidate's sha and bumps the feed, and the face
        // changes when that recomposed entry arrives. That is the whole point —
        // a review nobody wrote down is one a reload forgets.
        await revealAndClick(app, REVIEWED);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REVIEW)})?.getAttribute("data-reviewed") === "true"`,
          { timeoutMs: 30000 },
        );
        const armed = await app.evalJS<{ ready: boolean; reason: string }>(LANDING_STATE);
        expect(armed.ready).toBe(true);
        // Landable, and the row says where to land it rather than offering a
        // button — the sentence is the only way forward from here.
        expect(armed.reason).toContain("/dash-join");
        note(`Reviewed cleared the gate: ${armed.reason}`);

        // Deliberately not clicked: landing would rewrite the developer's main.
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
