#!/usr/bin/env bun
/**
 * select-tests.ts — resolve changed source paths to the app-test files that cover them.
 *
 * Every `*.test.ts` under `tests/app-test/` declares the source it exercises with `@covers`
 * lines in its header docblock:
 *
 *     /**
 *      * at0241-jots-editor.test.ts — ...prose...
 *      *
 *      * @covers tugdeck/src/components/jots/
 *      * @covers tugdeck/src/components/cards/cards-store/
 *      *\/
 *
 * A `@covers` value is either a repo-relative path prefix (a trailing `/` means the whole
 * subtree) or a glob. A changed file selects a test when it matches any of that test's
 * `@covers` values.
 *
 * A test that takes the screen also declares that, with `@foreground` on its own docblock
 * line. The `app-test` recipe reads the declaration before it launches anything, so it can
 * tell the developer that a run is about to seize the machine.
 *
 * There are two ways a test takes the screen, and the check knows both. The declared one is
 * the `foreground` launch option, which puts the app in the activating event mode. The other
 * is calling an app-lifecycle RPC verb: those drive `NSApp.activate` and a Finder activation
 * inside the app, whatever mode it launched in, so a background launch does not make them
 * background. Reading only the launch option missed that second class entirely.
 *
 * Usage:
 *   bun scripts/select-tests.ts                  # derive changed paths from this session's changes
 *   bun scripts/select-tests.ts <path>...        # explicit changed paths
 *   bun scripts/select-tests.ts --print          # print the selection and skip the budget refusal
 *   bun scripts/select-tests.ts --check          # lint: @covers present, resolving, and scoped
 *   bun scripts/select-tests.ts --core           # the core tier's file list
 *   bun scripts/select-tests.ts --foreground <f>...   # the @foreground subset of <f>...
 *   bun scripts/select-tests.ts --foreground-check    # lint: @foreground matches behavior
 *
 * Selected test filenames go to stdout, one per line (feed straight to `just app-test`).
 * Reasons, advisories, and diagnostics go to stderr.
 *
 * ## The selection budget
 *
 * A derived selection is only useful if it stays small. Past MAX_SELECTED files the run
 * stops being "the tests for my change" and becomes a sweep in disguise — twenty minutes
 * of serialized Tug.app launches nobody asked for. So the budget is a REFUSAL, and it is
 * final: over it, this script emits no filenames and exits EXIT_OVER_BUDGET.
 *
 * There is deliberately NO opt-in flag. A budget with an override is not a budget — the
 * override becomes the habit, and every over-budget run gets waved through with a reason
 * that felt good at the time. Narrow the diff, or name the handful of tests you actually
 * mean. MAX_SELECTED is the limit.
 *
 * `--check` enforces the same ceiling ahead of time: no single source path may fan out to
 * more than MAX_SELECTED tests. Today's hub files already exceed it and are recorded in
 * ACCEPTED_FANOUT as known debt, and the lint holds that line: it compares each entry
 * against the same entry in the COMMITTED file and fails when a number went up, so the
 * recorded debt can be paid down but never quietly refinanced. A NEW hub fails the check
 * on the commit that creates it, and a new ACCEPTED_FANOUT key is the deliberate — and
 * visible — way to accept one.
 */

import { Glob } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const REPO_ROOT = resolve(APP_TEST_DIR, "..", "..");

/**
 * The few paths whose breakage a `@covers` line genuinely cannot scope: they run before
 * any test's first assertion, so a mistake there takes the whole corpus down at once
 * rather than failing the tests that named them.
 *
 * The answer is the CORE TIER (`just app-test`, ~20 tests, one per load-bearing
 * surface) — NOT the full corpus. The core tier is what "did I break everything?"
 * actually asks, and it costs a minute rather than twenty.
 *
 * This list is deliberately tiny and stays that way. An ordinary component — even a
 * heavily-used one like the session card, the transcript, or the text editor — does NOT
 * belong here: those are covered by name, they change constantly, and flagging them
 * turned the advisory into noise that fired on every substantial diff. If a component's
 * honest `@covers` fan-out is too wide, that is the selection budget's problem to state,
 * not this list's.
 */
const CORE_TIER_TRIGGERS = [
    "tests/app-test/_harness/",
    "tugapp/Sources/TestHarness/",
    "tugdeck/src/main.tsx",
    "tugdeck/index.html",
];

/**
 * The CORE tier: one test per load-bearing surface, not a sweep. Everyday work should run
 * `just app-test-changed` (coverage-derived from your diff) — this list is the broad smoke
 * you reach for when you want a fast read on whether the app still works at all.
 *
 * It lives here rather than in the `justfile` because the `app-test` recipe has to know
 * which files a bare `just app-test` will run BEFORE it takes the machine-wide gate, and
 * the recipe's own file list is not resolved until well after that point.
 */
const CORE_TIER = [
    "harness-smoke/smoke.test.ts", // bridge floor: boot, handshake, close
    "harness-smoke/smoke-native.test.ts", // native CGEvent gesture pipeline
    "harness-smoke/smoke-cold-boot.test.ts", // two-process tugbank round-trip
    "at0001-tab-switch-fc.test.ts", // intra-pane tab switch + caret restore
    "at0003-pane-activation.test.ts", // cross-pane activation
    "at0016-tab-close-handoff.test.ts", // close-the-active-tab focus handoff
    "at0014-scroll-persistence.test.ts", // region scroll across activation paths
    "at0024-prompt-state-roundtrip.test.ts", // prompt state across reload + relaunch
    "at0084-session-lifecycle-coordination.test.ts", // session lifecycle state-to-zone matrix
    "at0109-focus-ring.test.ts", // the one app-owned focus ring
    "at0126-keyboard-ring-cold-boot.test.ts", // focus axis survives relaunch
    "at0145-permission-dialog-keyboard.test.ts", // card-modal dialog keyboard model
    "at0165-activation-first-responder.test.ts", // responder-chain accelerators
    "at0191-turns-end-to-end.test.ts", // canonical turns through the transcript
    "at0201-session-card-activation-click-focus.test.ts", // session card activation focus
    "at0209-text-card-live-autosave.test.ts", // Text card core loop on real files
    "at0216-shell-exchange.test.ts", // $ shell route end-to-end
    "at0231-sidebar-toggle.test.ts", // sidebar rail toggle + focus + reload
    "at0253-commit-dialog.test.ts", // commit mode open/dismiss
];

/**
 * The most test files a derived selection may run without an explicit opt-in. Sized to
 * the core tier (~20 files, a few minutes): past this, selection has stopped scoping the
 * change and the caller should be the one deciding to spend the time.
 */
const MAX_SELECTED = 20;

/** Exit code for a selection that exceeds {@link MAX_SELECTED}; distinct from a hard error. */
const EXIT_OVER_BUDGET = 3;

/**
 * Seconds one app-test file costs, used to price a selection in the refusal message.
 *
 * Measured 2026-08-21 over the core tier: 15 files ran in 97s, a mean of 6.5s. It is a
 * MEAN, not a flat rate — the spread is 2s (at0003) to 18s (at0024), so a selection of
 * long files costs materially more than this predicts and a selection of short ones less.
 * What the figure is for is sizing a refusal, where the order of magnitude is the whole
 * argument. The recipe now records each file's own duration in its summary and in
 * `TUG_APPTEST_JSON`, so this can be re-measured rather than re-guessed.
 */
const SECONDS_PER_TEST_FILE = 7;

/**
 * Source paths already fanning out past {@link MAX_SELECTED}, with the count observed when
 * each was recorded. These are real coupling, not sloppy `@covers` — `focus-manager.ts` is
 * genuinely exercised by most focus tests — so the lint accepts them at their CURRENT number
 * and fails if it climbs. Lower a number when the fan-out shrinks; adding an entry should be
 * a deliberate, argued act, not a reflex to make the lint quiet.
 */
const ACCEPTED_FANOUT: Record<string, number> = {
    // The navigator. Every surface that can hold the keyboard names it, so it is
    // the one path with structural coupling wide enough to outrun the budget.
    // It was 68 while the suite carried a test per widget for the same ring
    // contract; retiring those clones took it to 26 without giving up a single
    // behavior the engine actually owns.
    //
    // 26 → 29, deliberately, for three suites that pin KBF-mode invariants no
    // other file drives: at0397 (the paint keys on the ROUTE — a granted caret
    // stands the marks down while the mode stays engaged), at0399 (a covered
    // stop leaves the walk; a shade signal carries its name), and at0402 (a
    // live caret owns its caret keys). The first two were graded deletable as
    // pixel cosmetics and restored when that grading was found wrong: they read
    // computed style, but what they assert is an engine rule, and the phase's
    // recorded failure mode is exactly an attribute-green/pixel-dark ring.
    "tugdeck/src/components/tugways/focus-manager.ts": 29,

    // The deck's one canvas. Every arrangement rule the deck has is expressed
    // there — the frames' placements, the seam elements, and every custom
    // property the imposer's `calc()`s read — so a test that asserts geometry
    // in pixels has nowhere else to name. It sat at exactly 20 for a long time,
    // which was the budget holding by luck rather than by design.
    //
    // 20 → 21 for at0456, which pins the overflow column: past two members a
    // column stops dividing and starts scrolling, and BOTH halves of that live
    // in this file — the seam handles are not rendered, and the per-slot offset
    // property is published in its place. Naming a narrower module instead
    // would be a fiction; the alternative of not naming it at all would leave
    // the seam gate covered by nothing, which is the failure the declaration
    // exists to prevent.
    //
    // Held at 21 across the ⌃⌘-digit handover: at0466 arrived naming this file
    // (the handler that turns the chord into a committed band offset is one of
    // its action cases) and at0371 stopped naming it in the same change, since
    // the width verb it drives no longer reaches the canvas through a chord.
    "tugdeck/src/components/chrome/deck-canvas.tsx": 21,

    // The transcript. Every row kind a session can paint — user, assistant,
    // shell, refs, ghost — renders through this one host, so a test that
    // asserts what a transcript ROW looks like has nowhere narrower to name.
    // It sat at exactly 20 until at0507 arrived pinning the quiet-row branch
    // of `ShellTurnCell` (an arc-note row renders as one sentence, not as an
    // exchange entry) — that branch lives here, so the declaration is honest
    // and the alternative was leaving the new row shape covered by nothing.
    "tugdeck/src/components/tugways/cards/session-card-transcript.tsx": 21,

    // The agent supervisor. Every CONTROL verb the deck sends lands in this one
    // file, so a test that drives a button and asserts what the server did has
    // nowhere narrower to name. It sat at exactly 20 until at0486 began driving
    // the Resolve press rather than stopping in front of it: the outcome frame
    // that press turns on is built here, and that frame carrying the arc it
    // names is the whole of what the test now proves on screen. The declaration
    // is honest and the alternative was leaving the frame builder covered by no
    // app-test at all.
    "tugrust/crates/tugcast/src/feeds/agent_supervisor.rs": 21,

    // The composer. It is the single field every route types into — the plain
    // prompt, the `$` shell route, the `/` command route, commit mode and the
    // landing draft — so a test that drives the app the way a user does has to
    // reach through this file to say anything at all. The fan-out is the price
    // of one entry point rather than five, and splitting it per route to quiet
    // the lint would trade a real design for a smaller number.
    //
    // Recorded at 21 when at0497 (the landing stream's scroll: the wave stays
    // in view while the scribe writes) and at0496 (a join press leaves the
    // Changes shade) arrived. Both drive the shipping composer through real
    // control frames, so neither could name a narrower module honestly.
    "tugdeck/src/components/tugways/tug-prompt-entry.tsx": 21,

    // The deck itself. Every card the deck can stand — free, slotted, or on a
    // rail — is created, activated, closed and persisted through this one
    // manager, so an app-test that asserts what the deck DID has nowhere
    // narrower to name. It sat at exactly 20 for a long time, which was the
    // budget holding by luck rather than by design.
    //
    // Recorded at 21 when at0506 (the factory rail: a fresh install's first
    // card stands all four sidebar cards, Cards frontmost) arrived. The rail's
    // plan is a pure function a unit test already covers; what the app-test
    // pins is the commit — four panes appended in one state change, in the
    // z-order that settles which member a stack draws — and that lives here.
    "tugdeck/src/deck-manager.ts": 21,
};

interface TestCoverage {
    file: string;
    covers: string[];
    /** Declared by `@foreground`: this file takes the screen for its duration. */
    foreground: boolean;
    /** Passes a possibly-true `foreground` launch option at some launch site. */
    foregroundOption: boolean;
    /** Calls an app-lifecycle RPC verb, which takes the screen whatever the launch mode. */
    activatingVerb: boolean;
}

/** Repo-relative paths of every app-test file, in run order (smoke first). */
function testFiles(): string[] {
    const bare = readdirSync(APP_TEST_DIR)
        .filter((n) => n.endsWith(".test.ts"))
        .sort();
    const smoke = readdirSync(join(APP_TEST_DIR, "harness-smoke"))
        .filter((n) => n.endsWith(".test.ts"))
        .sort()
        .map((n) => `harness-smoke/${n}`);
    return [...smoke, ...bare];
}

const COVERS_LINE = /^\s*\*?\s*@covers\s+(\S+)/;
const FOREGROUND_LINE = /^\s*\*?\s*@foreground\b/;

/**
 * The launch option the `@foreground` tag declares. Matched anywhere in the file body.
 *
 * Anything that is not literally `false` counts. A launch site may compute the flag
 * (`foreground: SOAK_SECS === 0`), and a static read cannot know which way it lands — so
 * the safe reading is "this file might take the screen, declare it." Only an explicit
 * `foreground: false` is exempt, because that one says what it means.
 */
const FOREGROUND_OPTION = /\bforeground:\s*(?!false\b)\S/;

/**
 * The app-lifecycle RPC verbs. Each one reaches `AppLifecycleHandlers` in the app, which
 * drives the real activation machinery — `NSApp.activate(ignoringOtherApps:)` to become
 * active, a Finder activation to resign — and neither is gated on the launch mode. So a
 * file calling one of these takes the screen even though it launched in the background,
 * which is exactly the unannounced seizure `@foreground` exists to prevent.
 *
 * They also cannot *work* in a background launch: the app was never active, so
 * `NSApp.deactivate()` is a silent no-op, the `didResignActive` notification never posts,
 * and the verb fails on its 1000ms timeout — after having activated Finder on the way.
 * That is why calling one demands the launch option too, and not merely the tag.
 */
const ACTIVATING_VERB = /\bsimulateApp(?:Resign|BecomeActive|Hide|Unhide)\b/;

function readCoverage(file: string): TestCoverage {
    const text = readFileSync(join(APP_TEST_DIR, file), "utf8");
    const covers: string[] = [];
    let foreground = false;
    for (const line of text.split("\n")) {
        const m = COVERS_LINE.exec(line);
        if (m) covers.push(m[1]);
        if (FOREGROUND_LINE.test(line)) foreground = true;
        // Declarations live in the header docblock; stop at the first import.
        if (/^import\s/.test(line)) break;
    }
    return {
        file,
        covers,
        foreground,
        foregroundOption: FOREGROUND_OPTION.test(text),
        activatingVerb: ACTIVATING_VERB.test(text),
    };
}

/** Whether a file takes the screen — by launch option, by lifecycle verb, or both. */
function takesScreen(c: TestCoverage): boolean {
    return c.foregroundOption || c.activatingVerb;
}

/** A `@covers` value matches a changed path by subtree prefix or by glob. */
function matches(pattern: string, path: string): boolean {
    if (pattern.endsWith("/")) return path === pattern.slice(0, -1) || path.startsWith(pattern);
    if (!/[*?[\]{}]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`);
    if (new Glob(pattern).match(path)) return true;
    // `dir/**` should also match `dir` itself and its direct children.
    if (pattern.endsWith("/**")) {
        const base = pattern.slice(0, -3);
        return path === base || path.startsWith(`${base}/`);
    }
    return false;
}

/**
 * The `tugtool` this checkout built, resolved by absolute path from `REPO_ROOT`.
 *
 * Never by bare name: `~/.local/bin/tugtool` symlinks into the main checkout, so a
 * `PATH` lookup from a worktree silently answers about a different tree — which is
 * exactly the mis-scoping this whole path exists to end.
 */
function tugtoolPath(): string | null {
    for (const profile of ["debug", "release"]) {
        const p = join(REPO_ROOT, "tugrust", "target", profile, "tugtool");
        if (existsSync(p)) return p;
    }
    return null;
}

/**
 * The changed paths this run selects from.
 *
 * The session's own changes when the ledger can name them, and the whole working tree
 * when it cannot. A whole-tree read is every concurrent session's work at once, so it
 * selects tests that have nothing to do with this session — correct but wildly
 * over-broad. The ledger's classification narrows it to what this session touched.
 *
 * The `foreign` bucket is never consulted: those files are another session's to test.
 * The `unattributed` bucket contributes only entries carrying a this-session hint
 * (`origin !== "none"`), because an unattributed file with no hint at all is as likely
 * to be the user's own hand-save as anything this session did.
 *
 * Every fallback says which one it took and why — a selection that silently changed
 * its own meaning is worse than no selection.
 */
function changedPaths(): string[] {
    const session = process.env.TUG_SESSION_ID;
    if (!session) {
        process.stderr.write(
            "[select-tests] no TUG_SESSION_ID — selecting from the whole working tree.\n",
        );
        return changedFromGit();
    }

    const bin = tugtoolPath();
    if (bin === null) {
        process.stderr.write(
            "[select-tests] tugtool unavailable (no built binary under tugrust/target) — " +
                "selecting from the whole working tree.\n",
        );
        return changedFromGit();
    }

    // The RAW root, never a realpath: canonicalization belongs to tugtool's [L29]
    // gateway, and a second spelling resolved here is how the two drift apart.
    const proc = Bun.spawnSync([bin, "changes", "--json", "--project", REPO_ROOT], {
        cwd: REPO_ROOT,
    });

    if (proc.exitCode === 2) {
        process.stderr.write(
            `[select-tests] session ${session} not resolvable — selecting from the whole working tree.\n`,
        );
        return changedFromGit();
    }
    if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim().split("\n")[0];
        const reason = stderr.length > 0 ? stderr : `exit ${proc.exitCode}`;
        process.stderr.write(
            `[select-tests] tugtool unavailable (${reason}) — selecting from the whole working tree.\n`,
        );
        return changedFromGit();
    }

    let data: {
        files?: { path: string }[];
        unattributed?: { path: string; origin?: string }[];
        foreign?: { path: string }[];
    };
    try {
        data = JSON.parse(new TextDecoder().decode(proc.stdout)).data ?? {};
    } catch {
        process.stderr.write(
            "[select-tests] tugtool unavailable (unreadable JSON) — selecting from the whole working tree.\n",
        );
        return changedFromGit();
    }

    const attributed = (data.files ?? []).map((f) => f.path);
    const unattributed = data.unattributed ?? [];
    const hinted = unattributed.filter((f) => f.origin !== "none").map((f) => f.path);
    const foreignCount = (data.foreign ?? []).length;

    process.stderr.write(
        `[select-tests] session ${session}: ${attributed.length} attributed + ` +
            `${hinted.length} unattributed-hinted (${foreignCount} foreign ignored)\n`,
    );

    // An empty classification over a dirty tree is not a clean tree — it is the
    // signature of a --project the ledger spelled differently, which would otherwise
    // read as "nothing to run" and select nothing, forever, silently.
    if (attributed.length === 0 && unattributed.length === 0 && foreignCount === 0) {
        const dirty = changedFromGit().length;
        if (dirty > 0) {
            process.stderr.write(
                `[select-tests] the ledger classified nothing while ${dirty} file(s) are dirty.\n` +
                    "               That is a --project spelling mismatch, not a clean tree.\n" +
                    `               Asked about: ${REPO_ROOT}\n`,
            );
        }
    }

    return [...new Set([...attributed, ...hinted])];
}

/**
 * {@link ACCEPTED_FANOUT} as the committed file spells it, or `null` when that file
 * cannot be read — a detached or shallow checkout, or a `select-tests.ts` that is new
 * and has no committed side yet.
 *
 * Null is not a failure. The ratchet compares against history, so a run with no history
 * to compare against has nothing to say; it warns and stands down rather than failing a
 * checkout for the shape it arrived in.
 */
function committedFanout(): Record<string, number> | null {
    const proc = Bun.spawnSync(["git", "show", "HEAD:tests/app-test/scripts/select-tests.ts"], {
        cwd: REPO_ROOT,
    });
    if (proc.exitCode !== 0) return null;
    const src = new TextDecoder().decode(proc.stdout);
    const start = src.indexOf("const ACCEPTED_FANOUT");
    if (start < 0) return null;
    const open = src.indexOf("{", start);
    const close = src.indexOf("\n};", open);
    if (open < 0 || close < 0) return null;
    // Line comments carry prose about the numbers; strip them so only entries are read.
    const body = src
        .slice(open, close)
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
    const out: Record<string, number> = {};
    for (const m of body.matchAll(/"([^"]+)"\s*:\s*(\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
}

/** Changed paths in the working tree: staged, unstaged, and untracked. */
function changedFromGit(): string[] {
    const proc = Bun.spawnSync(["git", "status", "--porcelain", "-z", "--untracked-files=all"], {
        cwd: REPO_ROOT,
    });
    if (proc.exitCode !== 0) {
        process.stderr.write("[select-tests] git status failed — pass changed paths explicitly.\n");
        process.exit(1);
    }
    const out = new TextDecoder().decode(proc.stdout);
    const paths: string[] = [];
    // -z records are `XY <path>\0`, with renames adding a second `<origPath>\0` record.
    const records = out.split("\0").filter((r) => r.length > 0);
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const status = record.slice(0, 2);
        paths.push(record.slice(3));
        if (status.includes("R")) i++; // skip the rename's origin record
    }
    return paths;
}

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const checkOnly = args.includes("--check");
const holesOnly = args.includes("--holes");
const coreOnly = args.includes("--core");
const foregroundOnly = args.includes("--foreground");
const foregroundCheck = args.includes("--foreground-check");
const explicit = args.filter((a) => !a.startsWith("--"));

if (coreOnly) {
    // **A core-tier entry that names nothing is a stale list, not a red test.**
    // A missing file reaches the runner as `[ERR] (the file failed before any
    // test reported)` wrapped around bun's "filters did not match any test
    // files" — which reads as the app being broken and is instead this list
    // having outlived a rename: a tier entry kept naming a file that had been
    // renamed under it — `at0231-sidebar-toggle.test.ts` is the one that got
    // caught — and the core tier was red for everyone until somebody read the
    // message closely.
    // `@covers` paths are already checked this way; the tier itself was not.
    const missing = CORE_TIER.filter(
        (f) => !existsSync(join(APP_TEST_DIR, f)),
    );
    if (missing.length > 0) {
        process.stderr.write(
            `[select-tests] the core tier names ${missing.length} file(s) that do not exist:\n` +
                missing.map((f) => `  ${f}\n`).join("") +
                "Renamed or deleted — fix CORE_TIER in tests/app-test/scripts/select-tests.ts.\n",
        );
        process.exit(1);
    }
    for (const f of CORE_TIER) process.stdout.write(`${f}\n`);
    process.exit(0);
}

const coverage = testFiles().map(readCoverage);

/**
 * A test filename as the corpus knows it. Callers hand us whatever their shell produced —
 * a bare name, a `./` form, or the repo-root-relative path tab-completion generates — and
 * all three name the same file. Matching is on the whole name, never a prefix: `at0209`
 * alone is ambiguous between two unrelated tests.
 */
function normalizeTestName(name: string): string {
    return name.replace(/^\.\//, "").replace(/^tests\/app-test\//, "");
}

if (foregroundOnly) {
    const tagged = new Set(coverage.filter((c) => c.foreground).map((c) => c.file));
    for (const name of explicit.map(normalizeTestName)) {
        if (tagged.has(name)) process.stdout.write(`${name}\n`);
    }
    process.exit(0);
}

if (foregroundCheck) {
    // Three findings, for three different harms. A tag with no screen-taking behavior
    // prompts about a test that never takes the screen — noise that trains dismissal.
    // Screen-taking behavior with no tag runs unannounced, which is the harm the tag exists
    // to prevent. And a lifecycle verb without the launch option is a test that both seizes
    // the screen and cannot pass, because the verb needs an app that is really active.
    const undeclared = coverage.filter((c) => !c.foreground && takesScreen(c));
    const overdeclared = coverage.filter((c) => c.foreground && !takesScreen(c));
    const verbWithoutOption = coverage.filter((c) => c.activatingVerb && !c.foregroundOption);

    if (undeclared.length > 0) {
        process.stderr.write(
            `[select-tests] ${undeclared.length} test file(s) take the screen but carry no\n` +
                `               @foreground tag — they would seize it unannounced:\n`,
        );
        for (const c of undeclared) process.stderr.write(`  ${c.file}\n`);
    }
    if (overdeclared.length > 0) {
        process.stderr.write(
            `[select-tests] ${overdeclared.length} test file(s) declare @foreground but neither pass a\n` +
                `               foreground launch option nor call a lifecycle verb — they\n` +
                `               would prompt for nothing:\n`,
        );
        for (const c of overdeclared) process.stderr.write(`  ${c.file}\n`);
    }
    if (verbWithoutOption.length > 0) {
        process.stderr.write(
            `[select-tests] ${verbWithoutOption.length} test file(s) call an app-lifecycle verb without\n` +
                `               launching foreground. The verb activates Finder on its way to\n` +
                `               timing out, so the test steals focus AND fails:\n`,
        );
        for (const c of verbWithoutOption) process.stderr.write(`  ${c.file}\n`);
    }
    if (undeclared.length === 0 && overdeclared.length === 0 && verbWithoutOption.length === 0) {
        const n = coverage.filter((c) => c.foreground).length;
        process.stderr.write(
            `[select-tests] @foreground matches behavior across ${coverage.length} test files.\n` +
                `               ${n} take the screen; the other ${coverage.length - n} run in the background.\n`,
        );
        process.exit(0);
    }
    process.exit(1);
}

/** A `@covers` value that resolves to nothing on disk can never select its test. */
function resolvesOnDisk(pattern: string): boolean {
    const literal = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern.replace(/\/?\*\*?$/, "");
    if (existsSync(join(REPO_ROOT, literal))) return true;
    if (!/[*?[\]{}]/.test(pattern)) return false;
    const dir = literal.includes("/") ? literal.slice(0, literal.lastIndexOf("/")) : "";
    return existsSync(join(REPO_ROOT, dir));
}

/**
 * A concrete changed-file path standing in for a `@covers` value, so a pattern's fan-out can
 * be measured with the same {@link matches} the real selection uses. A subtree pattern is
 * probed with a file inside it; a bare path is probed as itself.
 */
function representativePath(pattern: string): string {
    if (pattern.endsWith("/")) return `${pattern}__probe__.ts`;
    return pattern.replace(/\/?\*\*?$/, "/__probe__.ts");
}

/** How many test files a change to `path` would select. */
function fanOut(path: string): number {
    return coverage.filter((c) => c.covers.some((q) => matches(q, path))).length;
}

/**
 * Source roots an app-test can meaningfully cover. Everything outside these is either not
 * app-test territory (Rust unit-tested crates, build scripts) or is a CORE_TIER_TRIGGER,
 * whose blast radius no `@covers` line can scope anyway.
 */
const HOLE_ROOTS = ["tugdeck/src/", "tugdeck/styles/", "tugcode/src/"];

/** Source files no app-test selects — a change there runs nothing. */
function coverageHoles(): string[] {
    const proc = Bun.spawnSync(["git", "ls-files", "-z", ...HOLE_ROOTS], { cwd: REPO_ROOT });
    if (proc.exitCode !== 0) return [];
    return new TextDecoder()
        .decode(proc.stdout)
        .split("\0")
        .filter((p) => /\.(ts|tsx|css)$/.test(p))
        .filter((p) => !p.includes("/__tests__/") && !p.endsWith(".test.ts"))
        // Retired code nothing mounts — a "hole" there is not a gap to close.
        .filter((p) => !p.includes("/_archive/"))
        .filter((p) => !CORE_TIER_TRIGGERS.some((t) => matches(t, p)))
        .filter((p) => fanOut(p) === 0);
}

if (holesOnly) {
    const holes = coverageHoles();
    const byDir = new Map<string, number>();
    for (const h of holes) {
        const dir = h.slice(0, h.lastIndexOf("/") + 1);
        byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
    process.stderr.write(
        `[select-tests] ${holes.length} source file(s) no app-test selects, by directory:\n`,
    );
    for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1])) {
        process.stderr.write(`  ${String(n).padStart(4)}  ${dir}\n`);
    }
    for (const h of holes) process.stdout.write(`${h}\n`);
    process.exit(0);
}

if (checkOnly) {
    const missing = coverage.filter((c) => c.covers.length === 0);
    const dangling = coverage.flatMap((c) =>
        c.covers.filter((p) => !resolvesOnDisk(p)).map((p) => ({ file: c.file, pattern: p })),
    );

    // Every distinct declared path, measured for blast radius.
    const patterns = [...new Set(coverage.flatMap((c) => c.covers))];
    const overBudget: { pattern: string; count: number; accepted: number | undefined }[] = [];
    for (const pattern of patterns) {
        const count = fanOut(representativePath(pattern));
        if (count <= MAX_SELECTED) continue;
        const accepted = ACCEPTED_FANOUT[pattern];
        if (accepted !== undefined && count <= accepted) continue;
        overBudget.push({ pattern, count, accepted });
    }

    // The ratchet: an ACCEPTED_FANOUT number may fall, never rise. Raising one in place
    // turns recorded debt into a rubber stamp, because the edit that widens a hub is the
    // same edit that raises its ceiling and the widening never has to be argued.
    const raised: { pattern: string; from: number; to: number }[] = [];
    const committed = committedFanout();
    if (committed === null) {
        process.stderr.write(
            "[select-tests] WARNING: the committed select-tests.ts is unreadable (detached, shallow,\n" +
                "               or newly added) — the accepted-fan-out ratchet is not enforced this run.\n",
        );
    } else {
        for (const [pattern, to] of Object.entries(ACCEPTED_FANOUT)) {
            const from = committed[pattern];
            if (from !== undefined && to > from) raised.push({ pattern, from, to });
        }
    }

    if (raised.length > 0) {
        process.stderr.write(
            `[select-tests] ${raised.length} accepted fan-out number(s) went UP. Recorded debt may be\n` +
                "               paid down, never refinanced in place:\n",
        );
        for (const r of raised) {
            process.stderr.write(`  ${r.pattern}  →  ${r.from} raised to ${r.to}\n`);
        }
        process.stderr.write(
            "               Narrow the @covers lines that name it, or split the module. If the wider\n" +
                "               coupling is genuinely right, delete the entry and re-add it — a new key is\n" +
                "               not subject to this rule, and the delete-then-re-add is what makes the\n" +
                "               decision visible in the diff instead of hiding it in a changed digit.\n",
        );
    }

    if (overBudget.length > 0) {
        process.stderr.write(
            `[select-tests] ${overBudget.length} path(s) fan out past the ${MAX_SELECTED}-file selection\n` +
                `               budget — a one-line edit there turns 'app-test-changed' into a sweep:\n`,
        );
        for (const o of overBudget) {
            const was = o.accepted === undefined ? "not accepted" : `accepted at ${o.accepted}`;
            process.stderr.write(`  ${o.pattern}  →  ${o.count} tests (${was})\n`);
        }
        process.stderr.write(
            `               Narrow the @covers lines that name it, split the module, or — if the\n` +
                `               coupling is real — record it in ACCEPTED_FANOUT with its count.\n`,
        );
    }

    if (missing.length > 0) {
        process.stderr.write(
            `[select-tests] ${missing.length} test file(s) declare no @covers — they can never be\n` +
                `               selected by 'just app-test-changed'. Add @covers to each:\n`,
        );
        for (const m of missing) process.stderr.write(`  ${m.file}\n`);
    }
    if (dangling.length > 0) {
        process.stderr.write(
            `[select-tests] ${dangling.length} @covers path(s) resolve to nothing on disk — a moved or\n` +
                `               mistyped path silently stops selecting its test:\n`,
        );
        for (const d of dangling) process.stderr.write(`  ${d.file}  →  ${d.pattern}\n`);
    }
    if (
        missing.length === 0 &&
        dangling.length === 0 &&
        overBudget.length === 0 &&
        raised.length === 0
    ) {
        const worst = patterns
            .map((p) => ({ p, n: fanOut(representativePath(p)) }))
            .sort((a, b) => b.n - a.n)
            .slice(0, 3);
        process.stderr.write(
            `[select-tests] ${coverage.length} test files: @covers present, resolving, and\n` +
                `               within the ${MAX_SELECTED}-file budget. Widest fan-out: ` +
                `${worst.map((w) => `${w.p} (${w.n})`).join(", ")}\n`,
        );
        process.exit(0);
    }
    process.exit(1);
}

const changed = explicit.length > 0 ? explicit : changedPaths();

if (changed.length === 0) {
    process.stderr.write("[select-tests] no changed files — nothing to select.\n");
    process.exit(0);
}

const tripped = changed.filter((p) => CORE_TIER_TRIGGERS.some((t) => matches(t, p)));

const selected: { file: string; because: string[] }[] = [];
for (const c of coverage) {
    const because = changed.filter((p) => c.covers.some((pattern) => matches(pattern, p)));
    if (because.length > 0) selected.push({ file: c.file, because });
}

process.stderr.write(`[select-tests] ${changed.length} changed file(s) → ${selected.length} test file(s)\n`);
for (const s of selected) {
    process.stderr.write(`  ${s.file}  ←  ${s.because.slice(0, 3).join(", ")}${s.because.length > 3 ? ", …" : ""}\n`);
}

const uncovered = changed.filter(
    (p) => !p.startsWith("tests/app-test/") && !selected.some((s) => s.because.includes(p)),
);
if (uncovered.length > 0) {
    process.stderr.write(`[select-tests] no app-test covers these changed files:\n`);
    for (const p of uncovered) process.stderr.write(`  ${p}\n`);
}

if (tripped.length > 0) {
    process.stderr.write(
        `\n[select-tests] CORE TIER ADVISED — these changed paths run before any test's\n` +
            `               first assertion, so no \`@covers\` line can scope them:\n`,
    );
    for (const p of tripped) process.stderr.write(`  ${p}\n`);
    process.stderr.write(
        `               Add 'just app-test' (the ~20-file core tier) to this run.\n\n`,
    );
}

// The budget refusal. Deliberately AFTER the per-test reasons above, so an over-budget
// caller still sees exactly what would have run and why before deciding.
if (!printOnly && selected.length > MAX_SELECTED) {
    process.stderr.write(
        `\n[select-tests] REFUSED — ${selected.length} test files exceeds the ${MAX_SELECTED}-file\n` +
            `               selection budget. That is ~${Math.round((selected.length * SECONDS_PER_TEST_FILE) / 60)} minutes of\n` +
            `               serialized Tug.app launches, which is a sweep, not a scoped run.\n\n` +
            `               Narrow the diff, or name the few tests you actually want:\n` +
            `                 just app-test <file>...\n`,
    );
    process.exit(EXIT_OVER_BUDGET);
}

for (const s of selected) process.stdout.write(`${s.file}\n`);
