/**
 * AT0441 — the whole join arc, on one dash, in the real app.
 *
 * ## Why this exists
 *
 * The dash-join pipeline was broken for days in a way no single test could
 * see, because every test held one beat still. The face had its own coverage,
 * the gate had its own coverage, the ladder had its own coverage — and the
 * defect lived in the seams between them: the resolution store was written
 * under one spelling of a directory and read under another, so a candidate the
 * server had built and logged was invisible to the surface that had to review
 * it. Every part passed. The arc did not exist.
 *
 * So this walks the arc, beat by beat, and asserts the thing the incident
 * actually lacked: **at every point where the landing is refused, the control
 * that clears it is on screen.** That is [P08] — the reachability invariant —
 * and the unit half of it lives in `join-resolve-face.test.ts`. This is the
 * half that only the real app can answer, because "on screen" is a fact about
 * the DOM the deck rendered from the state the server sent.
 *
 * ## The arc
 *
 * conflicted → Resolve → progress → resolved, with each path's diff and the
 * rung that decided it → **reload the deck** → still resolved → Reviewed →
 * the row states its landing route and offers no control → enter join mode by
 * that route → type a message → the composer's land control is armed.
 *
 * The reload is not decoration. Three candidates were built and abandoned in
 * one day because nothing durable held them; the candidate is a git ref now,
 * and this is where that claim is tested against a deck that has genuinely
 * forgotten everything it knew.
 *
 * ## Where it stops, and why
 *
 * It does not press the land control. A dash's base is the branch the base
 * checkout has out — the developer's `main` — so a real landing here would
 * squash a fixture commit onto their live branch. at0426 drew that line first
 * and it holds: the arc is driven until landing is armed and refused by
 * nothing, which is the last state the deck owns. What happens after the press
 * is `join_in`'s, and it is covered where it is safe to cover — the Rust
 * layer's `test_dash_join_lands_resolved_candidate`.
 *
 * ## The fixture
 *
 * Built the way at0426 builds its conflict, for the same reasons: rewind the
 * dash branch to the parent of a base commit that modified a small file, then
 * rewrite that file wholesale in the dash worktree. Both sides move the same
 * lines, so `merge-tree` genuinely conflicts and the `merge-file` rung
 * genuinely declines. A stub merge driver (rung 4) then resolves it to a fixed
 * body, so the ladder reaches a candidate without the AI rung and without this
 * repo's `rr-cache`. Nothing touches the base branch or the developer's
 * checkout.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000441";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;
const COMPOSER = `${CARD} [data-slot="tug-prompt-entry"]`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0441-arc";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const LANDING = `${ROW} [data-slot="session-changes-dash-landing"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const REVIEW = `${ROW} [data-slot="session-changes-dash-landing-review"]`;
const REVIEWED = `${ROW} [data-slot="session-changes-dash-landing-reviewed"]`;
const READY = `${ROW} [data-slot="session-changes-dash-landing-ready"]`;
const CONFLICTS = `${ROW} [data-slot="session-changes-dash-landing-conflicts"]`;
const BLOCKERS = `${ROW} [data-slot="session-changes-dash-landing-blockers"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The body the stub driver resolves the conflict to, asserted verbatim. */
const DRIVER_BODY = "at0441 resolved by the stub driver\n";

/**
 * The dash side of the conflict, unique per run — the nonce keeps a rerere
 * entry from a killed run out of this one (at0426 explains the mechanism).
 */
const DASH_BODY = `at0441 dash side — the whole file, rewritten (${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)})\n`;

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

let conflictFile = "";
let stubDir = "";
let fixtureDir = "";
let rrCacheBefore = new Set<string>();

function unsetDriver(): void {
  Bun.spawnSync(["git", "-C", PROJECT_DIR, "config", "--unset", "tugdash.mergedriver"], {});
}

function rrCacheEntries(): Set<string> {
  const dir = git(PROJECT_DIR, "rev-parse", "--git-path", "rr-cache").trim();
  const path = dir.startsWith("/") ? dir : join(PROJECT_DIR, dir);
  try {
    return new Set(readdirSync(path));
  } catch {
    return new Set();
  }
}

/** One clean Claude turn, so the reload's `claude --resume` has something to replay. */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const t0 = new Date(Date.now() - 2000).toISOString();
  const t1 = new Date(Date.now() - 1000).toISOString();
  return (
    [
      {
        ...base,
        parentUuid: null,
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000f01",
        timestamp: t0,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000f01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000f02",
        timestamp: t1,
        message: {
          id: "msg-441-1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi there" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1200,
            output_tokens: 50,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 8000,
          },
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  unsetDriver();
  rrCacheBefore = rrCacheEntries();
  discardDash(PROJECT_DIR, DASH);
  const created = createDash(PROJECT_DIR, DASH, "at0441 full-arc fixture");

  const subject = smallConflictSubject(PROJECT_DIR);
  conflictFile = subject.path;
  git(created.worktree, "reset", "--hard", `${subject.commit}~1`);
  writeFileSync(join(created.worktree, conflictFile), DASH_BODY);
  commitRound(PROJECT_DIR, DASH, `at0441(round): rewrite ${conflictFile}`);

  stubDir = mkdtempSync(join(tmpdir(), "at0441-driver-"));
  const stub = join(stubDir, "stub-driver.sh");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s' '${DRIVER_BODY}' > "$4"\n`);
  chmodSync(stub, 0o755);
  git(PROJECT_DIR, "config", "tugdash.mergedriver", stub);

  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(PROJECT_DIR));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(PROJECT_DIR, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  unsetDriver();
  if (stubDir !== "") rmSync(stubDir, { recursive: true, force: true });
  discardDash(PROJECT_DIR, DASH);
  if (fixtureDir !== "") rmSync(join(fixtureDir, `${SID}.jsonl`), { force: true });
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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** Press a control on the dash row, scrolling it into the shade first (at0426). */
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
 * The reachability assertion, in the form the invariant actually claims: the
 * landing is refused, the face says so, and the slot that clears it is in the
 * DOM. A sentence pointing at a control nobody can see is the failure this
 * whole file is about, so it is checked as one fact, not two.
 */
async function refusalIsReachable(
  app: App,
  beat: string,
  expectedSlot: string,
): Promise<void> {
  const state = await app.evalJS<{ ready: boolean; line: string; slotPresent: boolean }>(
    `(function(){
      var line = document.querySelector(${JSON.stringify(READY)});
      return {
        ready: line !== null && line.getAttribute("data-ready") === "true",
        line: line === null ? "" : (line.textContent || ""),
        slotPresent: document.querySelector(${JSON.stringify(expectedSlot)}) !== null,
      };
    })()`,
  );
  expect(state.ready, `${beat}: the row must not read as landable`).toBe(false);
  expect(state.slotPresent, `${beat}: the control that clears this must be on screen`).toBe(
    true,
  );
  note(`at0441 ${beat}: refused, ${expectedSlot} mounted — line ${JSON.stringify(state.line)}`);
}

/** Bring the card up on the fixture dash, with the lane composed. */
async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0441: the join arc, end to end", () => {
  test(
    "conflicted resolves, survives a reload, reviews, and arms the landing — every refusal pointing at a mounted control",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0441-join-arc-end-to-end",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await openOnDash(app);
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

        // ── Beat 1: conflicted, with the ladder as the way out ────────────
        // Nothing is asked of the server here. The dash's entry already
        // carries what a landing would do, so the face is up as soon as the
        // row is.
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)})?.getAttribute("data-fronted") === "true"`,
          { timeoutMs: 20000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDING)})?.getAttribute("data-outcome") === "conflicted"`,
          { timeoutMs: 40000 },
        );
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(CONFLICTS)})?.textContent || "")`,
          ),
          "the conflicted face names the path it conflicts on",
        ).toContain(conflictFile);
        // A blocked dash would point somewhere else entirely; this one points
        // at the ladder, and the ladder is on screen.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BLOCKERS)}) === null`,
          ),
          "a conflicted dash is not a blocked one",
        ).toBe(true);
        await refusalIsReachable(app, "conflicted", RESOLVE);

        // ── Beat 2: the run, visible while it runs ────────────────────────
        await settle(400);
        await revealAndClick(app, RESOLVE);
        // The overlay flips synchronously, so the offer leaves on the click
        // itself — which is what tells a dead press apart from a slow ladder.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}) === null`,
          { timeoutMs: 5000 },
        );
        note("at0441 Resolve registered: the offer face left on the press");

        // ── Beat 3: resolved, with the diff and the rung that decided ─────
        // The ladder checks out scratch worktrees of this repo, so it is
        // slower here than against a tempdir fixture.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REVIEW)}) !== null`,
          { timeoutMs: 180000 },
        );
        const reviewText = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(REVIEW)})?.textContent || "")`,
        );
        expect(reviewText, "the review names the file it resolved").toContain(conflictFile);
        expect(reviewText, "and the rung that decided it").toContain("driver");
        expect(reviewText, "and what that rung actually chose").toContain(
          "at0441 resolved by the stub driver",
        );
        await refusalIsReachable(app, "resolved but unread", REVIEWED);

        // ── Beat 4: the reload ────────────────────────────────────────────
        // The candidate is a git ref and the review mark is branch config, so
        // a deck that has forgotten everything must come back to the same
        // state. This is the beat three abandoned candidates paid for: before
        // it, the resolution lived only in a client store, and a reload — or a
        // dropped socket, or a relaunch — threw it away silently.
        await app.appReload();
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: PROJECT_DIR });
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REVIEW)}) !== null`,
          { timeoutMs: 60000 },
        );
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(REVIEW)})?.getAttribute("data-reviewed") ?? null`,
          ),
          "the resolution survived the reload, and is still unread",
        ).toBe("false");
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(REVIEW)})?.textContent || "")`,
          ),
          "with the same diff it had before",
        ).toContain("at0441 resolved by the stub driver");
        await refusalIsReachable(app, "resolved after reload", REVIEWED);
        note("at0441 reload beat: the candidate came back from git, still unreviewed");

        // ── Beat 5: the review, which is a round trip ─────────────────────
        // The mark is written server-side against this candidate's sha and
        // comes back on the feed, so the face flips on the recomposed entry
        // rather than on a local boolean.
        await revealAndClick(app, REVIEWED);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REVIEW)})?.getAttribute("data-reviewed") === "true"`,
          { timeoutMs: 30000 },
        );

        // ── Beat 6: landable — a sentence, and no control ─────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          { timeoutMs: 30000 },
        );
        const readyLine = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(READY)})?.textContent || "")`,
        );
        // With nothing to press on the row, this sentence is the entire way
        // forward — so it has to name the route, not merely assert readiness.
        expect(readyLine).toContain("Ready to land");
        expect(readyLine).toContain("/dash-join");
        note(`at0441 landable: ${JSON.stringify(readyLine)}`);

        // ── Beat 7: the route the sentence named ──────────────────────────
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)}) !== null`,
          { timeoutMs: 12000 },
        );

        // An empty message is the last refusal in the gate's order, and its
        // control is the composer's own editor — which is mounted, because the
        // route that got here is the one that opens it.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          ),
          "empty-message points at the composer, which is on screen",
        ).toBe(true);

        // ── Beat 8: a message, and a landing with nothing left refusing ───
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeType("at0441: land this dash");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this dash") !== -1`,
          { timeoutMs: 5000 },
        );
        const armed = await app.evalJS<{ disabled: boolean; label: string }>(
          `(function(){
            var b = document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)});
            return {
              disabled: b === null ? true : b.disabled === true,
              label: b === null ? "" : (b.getAttribute("aria-label") || ""),
            };
          })()`,
        );
        expect(armed.label).toBe("Join");
        expect(armed.disabled, "with a message and a reviewed candidate, nothing refuses").toBe(
          false,
        );
        note("at0441 arc complete: the landing is armed with nothing left refusing it");

        // Deliberately not pressed. The dash's base is the branch the base
        // checkout has out — the developer's own — so firing this would squash
        // a fixture commit onto their live branch. What happens after the press
        // is covered where it is safe: `test_dash_join_lands_resolved_candidate`.
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
