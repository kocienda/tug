#!/usr/bin/env bash
# app-test.sh — the body of `just app-test`, which execs it with its FILES.
#
# Run it through `just app-test [FILES…]`: the gate below re-executes the run
# through `just --quiet app-test`, so the recipe stays the door.
#
# Deliberately NOT `set -e` — we want to keep iterating past per-
# file failures so the summary captures every file's status.
set -uo pipefail

# A recipe runs from the justfile's directory; so does this script, wherever it
# is called from. REPO_ROOT stands where the recipe read `justfile_directory()`.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
cd "$REPO_ROOT" || exit 1

# Repo universe. Names the checkout that owns this run's repo universe,
# which is always the one the recipe was invoked from — worktree or main.
#
# Every `tugtool arc` verb resolves a repo root before it does anything
# (tugarc-core::ops::main_repo_root, via tugtool-core's
# find_repo_root_from), and that resolution hops from a linked worktree to
# the checkout that owns its common dir. Unscoped, a fixture arc made from
# a worktree is therefore created against the base checkout while the app
# under test has the WORKTREE open — the lane can never list the arc its
# own fixture just made, and the run leaves branches, worktrees and
# arc-log lines in someone else's checkout.
#
# The export names the owner instead of letting the hop assume it, so
# fixtures are born, listed, joined and torn down inside the checkout under
# test. The semantics — containment, canonicalization, and what an invalid
# universe does — are specified beside find_repo_root_from in
# tugrust/crates/tugtool-core/src/worktree.rs. It reaches the app through
# forwardableEnv (every TUG* var), and tugcast inherits it from the app.
export TUG_REPO_UNIVERSE="$(pwd -P)"

# App-test always drives the dedicated `dev.tugapp.app.apptest`
# identity — the same one `build-app` produces and `app-test-grant`
# granted AX to. This is baked in (no env-var prefix) so the build
# and the run can never disagree on which bundle to launch.
: "${TUG_FORCE_BUNDLE_ID:=dev.tugapp.app.apptest}"
export TUG_FORCE_BUNDLE_ID

# Worktree identity. Scopes the per-launch instance ids
# (apptest-<wtslug>-<uuid>, minted by the harness from
# TUG_APPTEST_ID_PREFIX) and every destructive sweep below to THIS
# worktree, so one worktree's run can never stop another worktree's
# instances, wipe its data dirs, or reap its tmux server. Same
# branch → slug derivation as bundle-id-from-cwd.sh.
if BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && [ "$BRANCH" != "HEAD" ]; then :; else
    SHA="$(git rev-parse HEAD 2>/dev/null | cut -c1-8)"
    BRANCH="detached-${SHA:-unknown}"
fi
WTSLUG="$(bash tugrust/scripts/branch-slug.sh "$BRANCH")"
export TUG_APPTEST_ID_PREFIX="apptest-${WTSLUG}"

# One app-test invocation at a time, machine-wide. Native CGEvent
# input, app activation, and key-window status are login-session
# singletons — two concurrent runs would interleave each other's
# gestures no matter how well files and ports are namespaced. The
# gate is a localhost port bind (tugtool host gate; kernel-released on
# any death, no lock file): the whole invocation — clean slate,
# build-if-missing, dist refresh, every file, exit cleanup — runs
# under it, so one run completes before the next begins. A waiting
# invocation prints who holds the gate and since when.
if [ "${TUG_APPTEST_GATED:-}" != "1" ]; then
    if [ ! -x tugrust/target/debug/tugtool ]; then
        echo "==> building tug (needed for the app-test gate)…"
        (cd tugrust && cargo build -p tugtool >/dev/null)
    fi

    # Most tests now run in the background and are nobody's business but
    # this shell's. A few genuinely cannot — their subject IS activation —
    # so they launch with `foreground: true` and take the screen. Those get
    # announced first, because a run that seizes the machine mid-thought
    # with no warning is the thing this gate exists to prevent.
    #
    # The question is RAISED here and answered later. It does not block:
    # the background tests start immediately and the screen-takers are run
    # last, by which time the answer has usually already arrived. Anything
    # that needed no permission must never wait on something that did.
    #
    # And it always arrives — the question carries `--unattended run-all`,
    # so thirty seconds of nobody saying otherwise IS the answer. Waiting
    # forever for a developer who has left the room was the same failure in
    # a slower form: the run stopped, and nothing was on screen to notice.
    #
    # It is raised before the gate re-exec, and never while holding the
    # gate — a run waiting on a human would otherwise block every other
    # worktree's run for as long as the dialog sat unanswered. The asker is
    # a detached process; the answer reaches the gated child through a file
    # named in $TUG_APPTEST_ASK_OUT.
    #
    # TUG_APPTEST_ASSUME=all|background|cancel answers ahead of time and
    # raises nothing. `cancel` is checked here, before any work starts,
    # because as an explicit directive it means "run nothing" — whereas
    # declining the DIALOG only skips the screen-takers, the background run
    # having already happened.
    if [ "${TUG_APPTEST_ASSUME:-}" = "cancel" ]; then
        echo "==> TUG_APPTEST_ASSUME=cancel — nothing was run." >&2
        exit 1
    fi

    if [ -z "${TUG_APPTEST_ASSUME:-}" ]; then
        if [ -z "$*" ]; then
            ASK_FILES="$(cd tests/app-test && bun scripts/select-tests.ts --core)"
        else
            ASK_FILES="$(printf '%s\n' "$@")"
        fi
        # ASK_FILES is a newline-separated list, split into arguments on purpose.
        # shellcheck disable=SC2086
        FG_FILES="$(cd tests/app-test && bun scripts/select-tests.ts --foreground $ASK_FILES)"

        if [ -n "$FG_FILES" ]; then
            FG_COUNT="$(printf '%s\n' "$FG_FILES" | grep -c .)"

            # Two choices, because by the time this is answered the
            # background run is already under way — "cancel everything" is
            # no longer a coherent thing to offer. Declining is last, which
            # is what Escape chooses.
            #
            # Neither the question nor its options carry a description.
            # The dialog renders a two-option question as a single header
            # row, and there is nothing to put on the rows it no longer
            # has: the test names are in the run's own report, and the
            # option descriptions only ever restated the labels.

            # The question is a chance to intervene, not a request for
            # permission: unanswered, it runs them. A developer at the
            # keyboard has the countdown to say otherwise (or Escape, which
            # says it immediately); a developer who has walked away no
            # longer leaves the run parked in a dialog nobody is reading.
            # TUG_APPTEST_COUNTDOWN overrides it — mostly for tests, which
            # cannot afford to sit out the real one.
            FG_COUNTDOWN_SECS="${TUG_APPTEST_COUNTDOWN:-30}"

            ASK_OUT="$(mktemp -t apptest-ask.XXXXXX)"
            export TUG_APPTEST_ASK_OUT="$ASK_OUT"
            (
                CHOICE="$(tugrust/target/debug/tugtool host ask \
                    ${TUG_INSTANCE:+--instance "$TUG_INSTANCE"} \
                    --title "$FG_COUNT app-test(s) want to take over the screen" \
                    --timeout-secs "$FG_COUNTDOWN_SECS" \
                    --unattended run-all \
                    --option "run-all:Run" \
                    --option "background:Skip" \
                    2>/dev/null)"
                ASK_STATUS=$?
                printf '%s\n%s\n' "$ASK_STATUS" "$CHOICE" > "$ASK_OUT.part"
                # Rename so the reader never sees a half-written answer.
                mv "$ASK_OUT.part" "$ASK_OUT.done"
            ) &
            # Hand the asker's pid forward so the gated child can reap it.
            # `disown` detaches it from THIS shell, which `exec` is about to
            # replace; without the pid, a ^C'd run would leave the question
            # standing in the Session card with nobody left to hear it.
            export TUG_APPTEST_ASK_PID=$!
            export TUG_APPTEST_COUNTDOWN="$FG_COUNTDOWN_SECS"
            disown 2>/dev/null || true
        fi
    fi

    export TUG_APPTEST_GATED=1
    # `--quiet` on the inner invocation, because a failing run otherwise
    # reports `error: Recipe \`app-test\` failed with exit code 1` twice —
    # once from the inner `just` under the gate and once from this one, the
    # recipe having re-exec'd itself. Quiet suppresses only that line; the
    # exit code, and everything the recipe body prints, are unchanged.
    exec tugrust/target/debug/tugtool host gate run --name apptest --label "$WTSLUG" -- just --quiet app-test "$@"
fi
echo "==> app-test instance prefix: $TUG_APPTEST_ID_PREFIX"

export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh debug)"
PRODUCT_NAME="$TUG_PRODUCT_NAME"
APP_DIR="$(bash tugrust/scripts/derived-data-path.sh debug)/Build/Products/Debug/${PRODUCT_NAME}.app"
APP_BIN="$APP_DIR/Contents/MacOS/${PRODUCT_NAME}"
# Build-if-missing: one command does the whole thing. Only builds when
# the bundle is ABSENT — changed Swift/Rust/harness source needs an
# explicit `just app-test-build` to force a fresh build. The build
# goes to the app-test variant's own DerivedData, never touching a
# live `app-debug` bundle.
if [ ! -x "$APP_BIN" ]; then
    echo "==> ${PRODUCT_NAME}.app not built yet — building once (slow only the first time)…"
    just build-app
fi

# Surface the identity we're about to drive and confirm the built
# bundle matches it. The Accessibility (AX) grant is keyed on this
# bundle ID's designated requirement; a mismatch fails the
# native-event preflight. The grant is given once via
# `just app-test-grant` and carries across every worktree.
# See tuglaws/code-signing-mac.md.
BUILT_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$APP_DIR/Contents/Info.plist" 2>/dev/null || echo '?')"
echo "==> app-test bundle id: $BUILT_BUNDLE_ID (identity: $TUG_FORCE_BUNDLE_ID)"
# The deck this run serves is the dist the refresh below builds, so the
# reach instrumentation follows the run's own environment, never how the
# bundle was built. Say which deck it is.
if [ "${TUG_APPTEST_REACH:-}" = "1" ]; then
    echo "==> deck instrumented for reach (TUG_APPTEST_REACH=1)"
fi
if [ "$BUILT_BUNDLE_ID" != "$TUG_FORCE_BUNDLE_ID" ]; then
    echo "[warn] built bundle is $BUILT_BUNDLE_ID but app-test drives $TUG_FORCE_BUNDLE_ID." >&2
    echo "       Run 'just build-app' to rebuild the app-test bundle." >&2
fi

# Refresh tugdeck/dist so the harness (which loads prod-built
# static files via tugcast's ServeDir, not Vite — see the
# TUGAPP_APP_TEST branch in AppDelegate.loadPreferences)
# reflects current source. A failed build MUST abort the run:
# continuing would silently test whatever stale dist is on disk,
# producing verdicts about old code.
# Its stderr is held rather than printed: a green build's rollup
# chunking advisories are several screens of noise ahead of the summary,
# and they are the same thing the per-file stream is being quieted for.
# On failure every held line is printed before aborting.
DIST_LOG="$(mktemp -t apptest-dist.XXXXXX)"
if ! (cd tugdeck && bun run build >/dev/null 2>"$DIST_LOG"); then
    cat "$DIST_LOG" >&2
    rm -f "$DIST_LOG"
    echo "[app-test] tugdeck dist build FAILED — aborting; a stale dist would test old code." >&2
    echo "           Run 'cd tugdeck && bunx vite build' to see the build error." >&2
    exit 1
fi
rm -f "$DIST_LOG"

# Clean slate before the first spawn: wipe THIS WORKTREE's
# apptest data dirs from earlier runs and stop any of its tugcasts
# that are still alive. Every match is scoped to
# $TUG_APPTEST_ID_PREFIX — another worktree's instances, like a
# developer's `app-debug` / `app-release`, are structurally out of
# reach (and the gate above means none should be running anyway).
rm -rf "$HOME/Library/Application Support/Tug/instances/${TUG_APPTEST_ID_PREFIX}-"* 2>/dev/null || true
while read -r ID; do
    case "$ID" in "${TUG_APPTEST_ID_PREFIX}-"*)
        tugrust/target/debug/tugtool host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
    esac
done < <(tugrust/target/debug/tugtool host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
# Registry-blind orphan backstop. An app that spawned but hung
# BEFORE its test socket accepted (e.g. a mid-run dist rebuild
# broke the splash load) is invisible to every layer above: the
# harness's connect-failure catch kills only the `open -n -W`
# wrapper (it never learned the GUI PID), and the instance-registry
# stop above never saw it (registration happens later in boot).
# Kill by EXACT binary path: the apptest bundle lives in THIS
# worktree's own DerivedData, and the gate guarantees no
# legitimate instance of it is running when a sweep starts — so a
# path-scoped pkill reaps exactly this orphan class and can never
# touch a developer's real Tug.app or another worktree's bundle.
pkill -f "$APP_BIN" 2>/dev/null || true
sleep 0.3

# Reclaim leaked runtime debris before the first spawn: orphaned
# per-instance tmux servers from SIGKILLed runs, dead control /
# notify / harness sockets, aged $TMPDIR test litter, and finished
# app-test data dirs. One janitor, shared with tugcast's startup
# sweep, so there is no second implementation to drift.
#
# This replaces a worktree-scoped shell reaper that could only ever
# match `cc-${TUG_APPTEST_ID_PREFIX}-*` — by construction it could
# not reach a server leaked by a since-deleted worktree, which is
# how one sat idle for 20 hours. The sweep is registry-anchored
# instead of slug-anchored, so it reaches every worktree's orphans
# while a live dev/release instance and an in-flight app-test are
# still never candidates.
#
# It also supersedes the old "no cross-instance socket sweep" rule.
# That rule existed because the only glob anyone had written
# (`tugcast-ctl-*.sock`) was unscoped and could reach a live
# instance's socket; the sweep probes and registry-checks every
# candidate instead, so cross-instance reclamation is now safe —
# and necessary, since $TMPDIR does not in fact reap these (9,833
# had accumulated).
#
# The sweep must never take the app-test gate: this whole recipe
# body already runs under it, so acquiring it here would deadlock
# against ourselves. Safety comes from the probes and the age
# floor, not from serialization.
tugrust/target/debug/tugtool host sweep --yes --quiet || true

# Sweep the scratch-fixture namespace a previous run left behind.
#
# No app-test cuts an arc in this checkout — `arc-fixture.ts` refuses
# the very attempt — so there are no stranded fixture branches here to
# janitor anymore. What a killed run *can* leave is its scratch
# repositories (`tug-scratch-*` under the system temp dir) and the
# transcript directories their encoded paths land under
# `~/.claude/projects`: `afterAll` never runs on a kill. Both carry
# the namespace in their names, no live run holds them (this recipe
# owns the machine-wide gate), and nothing a person made ever lives
# in either shape, so removal is safe by construction.
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'tug-scratch-*' -exec rm -rf {} + 2>/dev/null || true
find "$HOME/.claude/projects" -maxdepth 1 -name '*tug-scratch-*' -exec rm -rf {} + 2>/dev/null || true

TMPOUT="$(mktemp -t app-test.XXXXXX)"
# shellcheck disable=SC2317,SC2329  # invoked by the trap below
cleanup() {
    # Targeted teardown — stop only THIS WORKTREE's apptest
    # instances. Another worktree's run and a developer's
    # separately-running app-debug session continue unaffected
    # (and `instance stop` is identity-checked, so a recycled PID
    # is never signalled).
    while read -r ID; do
        case "$ID" in "${TUG_APPTEST_ID_PREFIX}-"*)
            tugrust/target/debug/tugtool host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
        esac
    done < <(tugrust/target/debug/tugtool host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
    # Registry-blind orphan backstop (same rationale as the
    # clean-slate copy above): reap any apptest app that hung
    # before registering, by its worktree-scoped binary path.
    pkill -f "$APP_BIN" 2>/dev/null || true
    # Reap any private tmux servers (and stale socket files) the
    # stopped apptest instances left behind, so a run leaves nothing.
    tugrust/target/debug/tugtool host sweep --yes --quiet || true
    rm -f "$TMPOUT"
}
trap cleanup EXIT INT TERM

export TUGAPP_APP_TEST=1
export TUGAPP_DEBUG_PATH="$APP_BIN"
REPO_ROOT_FAST="$(pwd)"
export TUGAPP_TUGCODE_BINARY="$REPO_ROOT_FAST/tugrust/target/debug/tugcode"
# tugbank binary path used by tests/app-test/_harness/tugbank-helpers.ts
# for cold-boot disk-side reads.
export TUGAPP_TUGBANK_BINARY="$REPO_ROOT_FAST/tugrust/target/debug/tugbank"
cd tests/app-test || exit 1

FILES_INPUT="$*"
if [ -z "$FILES_INPUT" ]; then
    # The CORE tier: one test per load-bearing surface, not a sweep. The
    # list itself lives in select-tests.ts, because the pre-gate approval
    # check above has to know which files a bare `just app-test` will run
    # before this point in the recipe is ever reached.
    read -r -a FILES <<< "$(bun scripts/select-tests.ts --core | tr '\n' ' ')"
    SWEEP_LABEL="core"
    SELECTION_DEFAULT="core"
else
    read -r -a FILES <<< "$FILES_INPUT"
    SWEEP_LABEL="explicit-files"
    SELECTION_DEFAULT="explicit"
fi

# How this run was *selected*, which the sweep label cannot say: every
# other app-test recipe reaches this body by delegating to
# `just app-test <files>`, so a changed-derived run and a hand-named one
# arrive here identical. The delegating recipe exports its own answer;
# absent, the run is what it looks like, and the runner never guesses.
SELECTION_LABEL="${TUG_APPTEST_SELECTION:-$SELECTION_DEFAULT}"

# Normalize paths so a repo-root-relative path (e.g. the
# `tests/app-test/at0001-...` form tab-completion produces) works the same as
# a bare filename. The suite runs from tests/app-test/, so strip that prefix
# (and any leading `./`) from each entry before bun sees it.
for i in "${!FILES[@]}"; do
    f="${FILES[$i]}"
    f="${f#./}"
    f="${f#tests/app-test/}"
    FILES[i]="$f"
done

# Background tests never wait on anybody. Screen-taking ones go LAST, and
# the question about them is answered while the background work is already
# running — a test that needs no permission must never be held up by one
# that does.
#
# The reordering happens here rather than before the gate re-exec because
# that exec re-passes the arguments `just app-test` was given, unreordered,
# so the pre-gate shell never hands a reordered list forward.
# It hands the pending question forward instead ($TUG_APPTEST_ASK_OUT), and
# this is where the answer is collected.
FG_FILES="$(bun scripts/select-tests.ts --foreground "${FILES[@]}")"
# Both queues are always built: the runner drives them separately, on
# different concurrency rules, so "there are no screen-takers" is an empty
# FG_QUEUE rather than an unpartitioned FILES.
declare -a FG_QUEUE=()
declare -a BG_QUEUE=()
for f in "${FILES[@]}"; do
    if [ -n "$FG_FILES" ] && printf '%s\n' "$FG_FILES" | grep -qx "$f"; then
        FG_QUEUE+=("$f")
    else
        BG_QUEUE+=("$f")
    fi
done
FILES=(${BG_QUEUE[@]+"${BG_QUEUE[@]}"} ${FG_QUEUE[@]+"${FG_QUEUE[@]}"})
if [ "${#FG_QUEUE[@]}" -gt 0 ] && [ "${#BG_QUEUE[@]}" -gt 0 ]; then
    echo "==> running ${#BG_QUEUE[@]} background test(s) now; the ${#FG_QUEUE[@]} that take the screen come last."
fi

# A ^C (or any other death) must not leave the question standing in the
# Session card with this run gone. Kill the detached asker — that drops its
# HTTP request, tugcast clears the pending entry, and the dialog's Escape is
# all that is left to tidy — and take the handoff files with it. Harmless
# when the answer already landed: the pid is reaped and the files are gone.
# shellcheck disable=SC2317,SC2329  # invoked by the trap below
cleanup_pending_ask() {
    [ -n "${TUG_APPTEST_ASK_PID:-}" ] && kill "$TUG_APPTEST_ASK_PID" 2>/dev/null
    [ -n "${TUG_APPTEST_ASK_OUT:-}" ] && rm -f \
        "$TUG_APPTEST_ASK_OUT" "$TUG_APPTEST_ASK_OUT.part" "$TUG_APPTEST_ASK_OUT.done" \
        2>/dev/null
    return 0
}
trap cleanup_pending_ask EXIT INT TERM

# Collect the answer to the question raised before the gate. Called just
# before the first screen-taking test, so the background run has already had
# however long it took as thinking time. Sets FG_DECISION to run|skip.
FG_DECISION=""
resolve_foreground_decision() {
    [ -n "$FG_DECISION" ] && return 0
    case "${TUG_APPTEST_ASSUME:-}" in
        all)        FG_DECISION=run;  return 0 ;;
        background) FG_DECISION=skip; return 0 ;;
    esac
    local out="${TUG_APPTEST_ASK_OUT:-}"
    if [ -z "$out" ]; then
        FG_DECISION=run
        return 0
    fi
    # The question resolves itself — the dialog counts down and commits, and
    # tugcast answers for a deck that stopped ticking — so this waits for
    # that answer rather than racing it. The ceiling is a backstop against
    # an asker that died with the answer still in it, which is a broken
    # pipe rather than silence; skipping is the safe reading of a break.
    local ceiling=$(( ${TUG_APPTEST_COUNTDOWN:-30} + 120 ))
    local waited=0
    while [ ! -f "$out.done" ]; do
        if [ "$waited" -ge "$ceiling" ]; then
            echo "==> the approval request never came back — skipping the screen-takers." >&2
            FG_DECISION=skip
            return 0
        fi
        [ "$waited" -eq 0 ] && echo "==> waiting on your answer about the ${#FG_QUEUE[@]} test(s) that take the screen…"
        sleep 1
        waited=$((waited + 1))
    done
    local status choice
    status="$(sed -n '1p' "$out.done")"
    choice="$(sed -n '2p' "$out.done")"
    rm -f "$out.done" "$out" 2>/dev/null || true
    case "$status:$choice" in
        # Exit 3 is "nobody to ask", not a refusal. A terminal-only run
        # could never have shown a dialog, and the developer typed the
        # command themselves — so it proceeds, having said so.
        3:*)
            echo "==> no Tug instance to ask — these take the screen: $(printf '%s\n' "${FG_QUEUE[@]}" | sed 's/\.test\.ts$//' | paste -sd ',' - | sed 's/,/, /g')" >&2
            FG_DECISION=run ;;
        0:run-all)
            FG_DECISION=run ;;
        # Declined. Note this also covers "the deck had no card to show it
        # on" — the store answers with the declining option rather than
        # leaving this run blocked, so a $TUG_SESSION_ID pointing at some
        # other instance lands here. Skipping is the safe reading either
        # way, and the summary lists every skipped file.
        0:*)
            echo "==> skipping the ${#FG_QUEUE[@]} test(s) that take the screen." >&2
            FG_DECISION=skip ;;
        *)
            echo "==> the approval request failed — skipping the screen-takers." >&2
            FG_DECISION=skip ;;
    esac
}

declare -a RESULT_ROWS=()
# Each entry: file US title US message US location. `note()` values and
# per-failure detail are extracted ONCE, here, and both the human summary
# and the JSON document render from these arrays — never by re-parsing
# printed text.
declare -a FAIL_DETAILS=()
# Each entry: file US <the raw TUG-NOTE json object>.
declare -a NOTE_ROWS=()
US=$'\037'
RS=$'\036'

# Quiet by default: the per-file bun stream is the single largest reason
# app-test output gets piped through grep/head. TUG_APPTEST_STREAM=1
# restores it verbatim.
STREAM="${TUG_APPTEST_STREAM:-}"

# Every file reports the moment it finishes — status, counts, seconds, its
# place in the run, and for a red file the first failure — whether stdout is
# a terminal, a file, or a model's context. A full-corpus run is an hour, and
# an hour with nothing on the wire is indistinguishable from a hang; a
# captured run is exactly the one somebody is tailing. The finished summary
# still follows, complete on its own. Off only under STREAM, which prints
# its own `---- file ----` framing.
PROGRESS=""
[ -z "$STREAM" ] && PROGRESS=1

# bun prints a failing test's error block BEFORE its `(fail) <title>` line,
# so each block is read forward and emitted when its title arrives. Only the
# first error and the first locator per test are kept — a file with ten
# identical timeouts should not reprint them ten times.
extract_failures() {
    awk -v US=$'\037' -v RS_OUT=$'\036' -v TESTFILE="${2##*/}" '
        # An `expect` failure announces itself with `error: …`; a thrown one
        # arrives as `SomeError: …` with no prefix. Both are the message.
        /^error:?( |$)/ {
            if (msg == "") { msg = substr($0, 8); capturing = 1 }
            else { capturing = 0 }
            next
        }
        /^[A-Za-z][A-Za-z0-9_]*(Error|Exception): / {
            if (msg == "") { msg = $0; capturing = 1; next }
        }
        capturing == 1 {
            if ($0 ~ /^[ \t]+at /) { capturing = 0 }
            else if (lines < 12) { msg = msg "\n" $0; lines++ }
        }
        # A stack whose top frames are harness internals still has to point
        # at the test, so a frame in the test file wins over the first one.
        /^[ \t]+at / {
            if (loc == "") loc = $0
            if (testloc == "" && TESTFILE != "" && index($0, TESTFILE) > 0) testloc = $0
        }
        /^\(fail\) / {
            title = substr($0, 8)
            sub(/ \[[0-9.]+ *m?s\]$/, "", title)
            where = (testloc != "" ? testloc : loc)
            if (match(where, /\(([^)]*)\)$/)) {
                where = substr(where, RSTART + 1, RLENGTH - 2)
            } else {
                sub(/^[ \t]*at +/, "", where)
            }
            sub(/.*\//, "", where)
            while (msg ~ /\n$/) sub(/\n$/, "", msg)
            printf "%s%s%s%s%s%s", title, US, msg, US, where, RS_OUT
            msg = ""; loc = ""; testloc = ""; lines = 0; capturing = 0
        }
    ' "$1"
}

# How many background files run at once.
#
# Serializing the whole corpus was never what the hardware required. Native
# input, app activation and the key window are login-session singletons, so
# the SCREEN-TAKING tier genuinely cannot be shared — but a background test
# posts its keys with `CGEvent.postToPid(ownPid)` and rebuilds its mouse
# events as in-process `NSEvent`s, and every per-instance resource it owns
# already derives from a UUID `TUG_INSTANCE_ID`. Two of them have nothing in
# common to fight over. The invocation gate still serializes whole runs
# against each OTHER, and the screen-takers below still run one at a time.
#
# 4 is measured, not guessed, and so is the fact that it is the ceiling. On a
# 16-core machine the core tier runs clean and repeatably at 4 — three runs at
# 59s/59s/60s against a 103s serial baseline, 29/29 tests each time.
#
# At 6 and above it does NOT hold, and the reason is worth knowing before
# anybody raises this. The failures are not timeouts (those are handled by the
# scale below): every file dies on its FIRST `evalJS` with "returned a result
# of an unsupported type", `evalJS("1 + 1")` included. That is the launch
# handshake reporting ready before the WebView can actually evaluate — a
# readiness race that only has a window wide enough to lose under load.
# Raising this number is a fix to that race, not an edit here.
JOBS="${TUG_APPTEST_JOBS:-4}"
case "$JOBS" in ''|*[!0-9]*) JOBS=4 ;; esac
[ "$JOBS" -lt 1 ] && JOBS=1
[ "$JOBS" -gt 8 ] && JOBS=8
if [ "$JOBS" -gt 4 ]; then
    echo "==> TUG_APPTEST_JOBS=$JOBS is above the measured-clean ceiling of 4; expect the launch-readiness race." >&2
fi
# Streaming interleaves each file's raw output; concurrent streams would be
# shuffled into nonsense, so asking for them asks for a serial run.
[ -n "$STREAM" ] && JOBS=1

# Timeout budgets are sized for a file that has the machine to itself. Under
# concurrency the same work takes longer in wall time with nothing wrong, so
# the budgets travel with the contention. At JOBS=1 this is unset and every
# byte on the wire is what a serial run always sent.
[ "$JOBS" -gt 1 ] && export TUG_APPTEST_TIMEOUT_SCALE="$JOBS"

# Bun's own per-test timeout (5000ms) is the other budget sized for a lone
# file, and it lives outside the RPC path, so it is scaled on the command line.
BUN_TIMEOUT_ARG=""
[ "$JOBS" -gt 1 ] && BUN_TIMEOUT_ARG="--timeout $(( 5000 * JOBS ))"

RUNDIR="$(mktemp -d -t apptest-run.XXXXXX)"

# Stop any of THIS WORKTREE's apptest stragglers. The harness's
# `app.close()` already targets its own instance; this is defence-in-depth
# for a test that panics before reaching `close`.
#
# It is prefix-scoped, so it reaches every concurrent file's app as readily
# as its own — which is why it runs BETWEEN batches and never inside one.
# Called per-file under concurrency, the first file to finish would SIGTERM
# every app still under test.
reap_stragglers() {
    while read -r ID; do
        case "$ID" in "${TUG_APPTEST_ID_PREFIX}-"*)
            tugrust/target/debug/tugtool host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
        esac
    done < <(tugrust/target/debug/tugtool host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
}

# Run one file and write its outcome to $RUNDIR, so a concurrent job can
# report without sharing a shell array with anybody.
run_one_file() {
    local f="$1"
    local out="$RUNDIR/$(printf '%s' "$f" | tr '/' '_')"
    local tmpout="$out.out"
    local file_start rc passed failed total secs status
    # Under TUG_APPTEST_REACH=1 the harness folds each page's reach map into
    # this file's own JSON before every teardown; empty, it writes nothing.
    local reach_out=""
    if [ "${TUG_APPTEST_REACH:-}" = "1" ]; then
        mkdir -p "$RUNDIR/reach"
        reach_out="$RUNDIR/reach/$(printf '%s' "$f" | tr '/' '_').json"
    fi
    file_start="$(date +%s)"
    # The file runs under its wedge cap (run-capped.sh), which kills it and
    # leaves $out.wedged behind when the app has stopped answering.
    local cap
    cap="$(wedge_cap_for "$f" | cut -f1)"
    if [ -n "$STREAM" ]; then
        echo "---- $f ----"
        # bun's stdout/stderr both stream to the user's terminal AND
        # land in $tmpout for parsing. `tee` truncates without `-a`.
        # shellcheck disable=SC2086  # BUN_TIMEOUT_ARG is empty or a flag and its value
        if TUG_APPTEST_REACH_OUT="$reach_out" bash scripts/run-capped.sh "$cap" "$out.wedged" \
                bun test $BUN_TIMEOUT_ARG "$f" 2>&1 | tee "$tmpout"; then
            rc=0
        else
            rc="${PIPESTATUS[0]}"
        fi
    else
        # shellcheck disable=SC2086  # BUN_TIMEOUT_ARG is empty or a flag and its value
        if TUG_APPTEST_REACH_OUT="$reach_out" bash scripts/run-capped.sh "$cap" "$out.wedged" \
                bun test $BUN_TIMEOUT_ARG "$f" > "$tmpout" 2>&1; then
            rc=0
        else
            rc=$?
        fi
    fi
    # Bun emits "  N pass\n  N fail" near the end of each file.
    # Match the LAST occurrence so per-test mentions earlier in
    # the output do not confuse the count.
    passed="$(grep -E '^[ \t]*[0-9]+ pass$' "$tmpout" | tail -n 1 | grep -oE '[0-9]+' | head -n 1)"
    failed="$(grep -E '^[ \t]*[0-9]+ fail$' "$tmpout" | tail -n 1 | grep -oE '[0-9]+' | head -n 1)"
    passed="${passed:-0}"
    failed="${failed:-0}"
    total=$((passed + failed))
    secs=$(( $(date +%s) - file_start ))

    # Diagnostics the test asked to be seen, on green runs as well as red.
    grep '^TUG-NOTE: ' "$tmpout" 2>/dev/null | sed 's/^TUG-NOTE: //' > "$out.notes" || true

    # A wedge outranks every count: the file was killed mid-run, so what it
    # printed before the kill is not a result. It has no failure records,
    # and the ledger never reads it as a red.
    if [ -e "$out.wedged" ]; then
        status=WEDGED
    elif [ "$rc" -eq 0 ] && [ "$total" -eq 0 ]; then
        status=SKIP; passed=0; total=0
    elif [ "$rc" -eq 0 ]; then
        status=PASS
    else
        if [ "$total" -gt 0 ]; then
            status=FAIL
        else
            status=ERR; passed=0; total=0
        fi
        extract_failures "$tmpout" "$f" > "$out.fails"
        # A file that died before any test reported has no `(fail)` line to
        # hang detail off — carry the tail of its output instead, so an
        # early crash is not silently reduced to `[ERR]`.
        if [ ! -s "$out.fails" ]; then
            printf '%s' "(the file failed before any test reported)$US$(tail -n 12 "$tmpout")$US$RS" > "$out.fails"
        fi
    fi
    printf '%s\n' "$status:$f:$passed:$total:$secs" > "$out.row"
    report_progress "$f" "$status" "$passed" "$total" "$secs" "$out.fails"
}

# One line per finished file, printed from inside the job that ran it, so a
# concurrent batch reports each file as it lands rather than when the batch's
# slowest file does. `nth` counts the rows already written — two files that
# finish in the same instant can share a number, which costs nothing. The
# whole report is one printf, so concurrent jobs never interleave mid-line.
#
# The live report to the calling Session card's block goes first, above the
# guard: `TUG_APPTEST_STREAM=1` empties PROGRESS, and the block's line must
# not depend on these text lines being on. The verb is silent and bounded.
report_progress() {
    local f="$1" status="$2" passed="$3" total="$4" secs="$5" fails="$6"
    local nth elapsed detail="" first title msg
    # shellcheck disable=SC2012  # counting rows the runner named itself
    nth="$(ls "$RUNDIR"/*.row 2>/dev/null | wc -l | tr -d ' ')"
    if [ -n "$TUGTOOL_BIN" ]; then
        "$TUGTOOL_BIN" progress --label app-test --done "$nth" --total "${#FILES[@]}" --failures "$(grep -lE '^(FAIL|ERR|WEDGED):' "$RUNDIR"/*.row 2>/dev/null | wc -l | tr -d ' ')" --needle "just app-test" -- "$f $status ($passed/$total) ${secs}s" >/dev/null 2>&1 || true
    fi
    [ -n "$PROGRESS" ] || return 0
    elapsed=$(( $(date +%s) - START_EPOCH ))
    # The first record's title and the first line of its message: enough to
    # know which test went red and why without waiting for the summary.
    if { [ "$status" = FAIL ] || [ "$status" = ERR ]; } && [ -s "$fails" ]; then
        first="$(head -n 1 "$fails")"
        title="${first%%"$US"*}"
        msg="${first#*"$US"}"
        msg="${msg%%"$US"*}"
        detail="$(printf '\n          ↳ %s\n            %s' "${title:0:140}" "${msg:0:160}")"
    fi
    if [ "$status" = WEDGED ]; then
        local cap last
        IFS=$'\t' read -r cap last <<< "$(wedge_cap_for "$f")"
        if [ "$last" = "-" ]; then
            detail="$(printf '\n          ↳ stopped at its %ss cap (no recorded time, so the floor) — the app stopped answering' "$cap")"
        else
            detail="$(printf '\n          ↳ stopped at its %ss cap (3× the median of its recent recorded times, %ss) — the app stopped answering' "$cap" "$last")"
        fi
    fi
    printf '%3d/%-3d %02d:%02d  %-6s %-56s (%d/%d)  %4ds%s\n' \
        "$nth" "${#FILES[@]}" $((elapsed / 60)) $((elapsed % 60)) \
        "[$status]" "$f" "$passed" "$total" "$secs" "$detail"
}

# Fold one finished file's $RUNDIR output into the arrays the summary reads.
collect_file() {
    local f="$1"
    local out="$RUNDIR/$(printf '%s' "$f" | tr '/' '_')"
    local row
    [ -f "$out.row" ] || return 0
    row="$(cat "$out.row")"
    RESULT_ROWS+=("$row")
    case "$row" in
        WEDGED:*) WEDGE_STREAK=$((WEDGE_STREAK + 1)) ;;
        *)        WEDGE_STREAK=0 ;;
    esac
    [ "$WEDGE_STREAK" -ge 2 ] && HALTED=1
    if [ -f "$out.notes" ]; then
        while IFS= read -r ln; do
            [ -n "$ln" ] && NOTE_ROWS+=("$f$US$ln")
        done < "$out.notes"
    fi
    if [ -f "$out.fails" ]; then
        while IFS= read -r -d "$RS" rec; do
            [ -n "$rec" ] && FAIL_DETAILS+=("$f$US$rec")
        done < "$out.fails"
    fi
}

# `tugtool` here is the workspace's own build, not whatever a PATH symlink
# resolves to: run from an arc worktree, a PATH `tugtool` is the base
# checkout's binary, which is exactly the wrong one to trust about a
# feature under development.
TUGTOOL_BIN="$REPO_ROOT/tugrust/target/debug/tugtool"
[ -x "$TUGTOOL_BIN" ] || TUGTOOL_BIN="$(command -v tugtool 2>/dev/null || true)"

# Every file's wedge cap, from one history call before anything runs: three
# times the median of its recent recorded wall times, floored at two minutes
# — or, with no recorded time, at the file's own declared timeout when that
# is longer (wedge-cap.ts).
# A file past its cap is killed and recorded as WEDGED rather than waited
# on — a hung app otherwise walks the rest of the selection into the same
# wall, one file at a time. No ledger means every file gets the floor: the
# cap is a backstop, and a missing one must never stop a run.
CAPS_FILE="$RUNDIR/caps"
if [ -n "$TUGTOOL_BIN" ]; then
    "$TUGTOOL_BIN" apptest history --root "$REPO_ROOT" --json "${FILES[@]}" 2>/dev/null || true
fi | bun scripts/wedge-cap.ts "${FILES[@]}" > "$CAPS_FILE" 2>/dev/null || true
wedge_cap_for() {
    local line
    line="$(awk -F'\t' -v f="$1" '$1 == f { print $2 "\t" $3; exit }' "$CAPS_FILE" 2>/dev/null)"
    [ -n "$line" ] || line="$(printf '120\t-')"
    printf '%s\n' "$line"
}

# Two wedges in a row is an app that is not answering, not two slow files:
# every file after them would wedge too, each at its own cap. The run halts
# instead, and the files it never reached are named in the summary.
WEDGE_STREAK=0
HALTED=""

START_EPOCH="$(date +%s)"
[ -n "$PROGRESS" ] && echo "==> running ${#FILES[@]} file(s), $JOBS at a time; each reports as it finishes."

# The background tier, JOBS at a time. Batched rather than a rolling pool:
# macOS ships bash 3.2, which has no `wait -n` to retire one job at a time.
declare -a BATCH=()
if [ "${#BG_QUEUE[@]}" -gt 0 ]; then
    for f in "${BG_QUEUE[@]}"; do
        BATCH+=("$f")
        if [ "${#BATCH[@]}" -ge "$JOBS" ]; then
            for b in "${BATCH[@]}"; do run_one_file "$b" & done
            wait
            reap_stragglers
            for b in "${BATCH[@]}"; do collect_file "$b"; done
            BATCH=()
            [ -n "$HALTED" ] && break
        fi
    done
    if [ -z "$HALTED" ] && [ "${#BATCH[@]}" -gt 0 ]; then
        for b in "${BATCH[@]}"; do run_one_file "$b" & done
        wait
        reap_stragglers
        for b in "${BATCH[@]}"; do collect_file "$b"; done
        BATCH=()
    fi
fi

# The screen-takers, strictly one at a time. The decision resolves here,
# after every background file has already run.
for f in ${FG_QUEUE[@]+"${FG_QUEUE[@]}"}; do
    [ -n "$HALTED" ] && break
    resolve_foreground_decision
    if [ "$FG_DECISION" = "skip" ]; then
        [ -n "$STREAM" ] && echo "---- $f (skipped — takes the screen) ----"
        RESULT_ROWS+=("SKIP:$f:0:0:0")
        [ -n "$PROGRESS" ] && printf '%3d/%-3d %5s  %-6s %-56s (skipped — takes the screen)\n' \
            "${#RESULT_ROWS[@]}" "${#FILES[@]}" "" "[SKIP]" "$f"
        continue
    fi
    TUG_APPTEST_TIMEOUT_SCALE=1 run_one_file "$f"
    reap_stragglers
    collect_file "$f"
    sleep 0.3
done

declare -a UNRUN_FILES=()
if [ -n "$HALTED" ]; then
    for f in "${FILES[@]}"; do
        ran=""
        for row in "${RESULT_ROWS[@]}"; do
            IFS=':' read -r _s rfile _rest <<< "$row"
            [ "$rfile" = "$f" ] && ran=1 && break
        done
        [ -z "$ran" ] && UNRUN_FILES+=("$f")
    done
    echo "==> two files in a row wedged — the app is not answering. Stopping with ${#UNRUN_FILES[@]} file(s) not run."
fi

END_EPOCH="$(date +%s)"
ELAPSED=$((END_EPOCH - START_EPOCH))

files_run=${#RESULT_ROWS[@]}
files_passed=0
files_failed=0
files_errored=0
files_skipped=0
files_wedged=0
tests_passed_total=0
tests_total=0
for row in "${RESULT_ROWS[@]}"; do
    IFS=':' read -r status _file rpassed rtotal _rsecs <<< "$row"
    case "$status" in
        PASS) files_passed=$((files_passed + 1)) ;;
        FAIL) files_failed=$((files_failed + 1)) ;;
        ERR)  files_errored=$((files_errored + 1)) ;;
        SKIP) files_skipped=$((files_skipped + 1)) ;;
        WEDGED) files_wedged=$((files_wedged + 1)) ;;
    esac
    tests_passed_total=$((tests_passed_total + rpassed))
    tests_total=$((tests_total + rtotal))
done

BANNER="========================================================"
echo
echo "$BANNER"
echo "APP-TEST SUMMARY"
echo "$BANNER"
printf '%-14s  %s\n' 'Sweep:' "$SWEEP_LABEL"
printf '%-14s  %d\n' 'Files run:' "$files_run"
printf '%-14s  %d\n' 'Files passed:' "$files_passed"
printf '%-14s  %d\n' 'Files failed:' "$files_failed"
printf '%-14s  %d\n' 'Files errored:' "$files_errored"
[ "$files_skipped" -gt 0 ] && printf '%-14s  %d\n' 'Files skipped:' "$files_skipped"
[ "$files_wedged" -gt 0 ] && printf '%-14s  %d\n' 'Files wedged:' "$files_wedged"
[ "${#UNRUN_FILES[@]}" -gt 0 ] && printf '%-14s  %d (%s)\n' 'Files not run:' "${#UNRUN_FILES[@]}" \
    "$(printf '%s\n' "${UNRUN_FILES[@]}" | sed 's/\.test\.ts$//' | paste -sd ',' - | sed 's/,/, /g')"
if [ "$ELAPSED" -lt 60 ]; then
    printf '%-14s  %ds\n' 'Wall time:' "$ELAPSED"
else
    printf '%-14s  %dm %ds\n' 'Wall time:' $((ELAPSED / 60)) $((ELAPSED % 60))
fi

echo
echo "Per-file results:"
for row in "${RESULT_ROWS[@]}"; do
    IFS=':' read -r status file rpassed rtotal rsecs <<< "$row"
    printf '  %-6s %-56s (%d/%d)  %4ds\n' "[$status]" "$file" "$rpassed" "$rtotal" "$rsecs"
done

if [ ${#NOTE_ROWS[@]} -gt 0 ]; then
    echo
    echo "Diagnostics:"
    note_file=""
    for row in "${NOTE_ROWS[@]}"; do
        nfile="${row%%"$US"*}"
        njson="${row#*"$US"}"
        if [ "$nfile" != "$note_file" ]; then
            echo "  $nfile"
            note_file="$nfile"
        fi
        if command -v jq >/dev/null 2>&1; then
            printf '%s' "$njson" | jq -r \
                '"    \(.label)" + (if has("value") then ": " + (if (.value|type) == "string" then .value else (.value|tojson) end) else "" end)' \
                2>/dev/null || printf '    %s\n' "$njson"
        else
            printf '    %s\n' "$njson"
        fi
    done
fi

# What the ledger already knows about the files that just went red. Asked
# BEFORE this run is recorded, so the answer is the history the reader is
# comparing against rather than one this run has already contaminated with
# its own failure. One call for the whole set, and never on a green run —
# the question only exists where there is a red file to ask it about.
# It asks the same TUGTOOL_BIN the wedge caps were read from.
HISTORY_JSON=""
HISTORY_ERR=""
declare -a RED_FILES=()
for row in "${RESULT_ROWS[@]}"; do
    IFS=':' read -r status file _p _t _s <<< "$row"
    case "$status" in FAIL|ERR) RED_FILES+=("$file") ;; esac
done
if [ "${#RED_FILES[@]}" -gt 0 ]; then
    if [ -z "$TUGTOOL_BIN" ]; then
        HISTORY_ERR="tugtool is not on PATH"
    elif ! command -v jq >/dev/null 2>&1; then
        HISTORY_ERR="jq is not on PATH"
    elif ! HISTORY_RAW="$("$TUGTOOL_BIN" apptest history --root "$REPO_ROOT" --json "${RED_FILES[@]}" 2>&1)"; then
        HISTORY_ERR="tugtool apptest history exited non-zero"
    elif ! HISTORY_JSON="$(printf '%s' "$HISTORY_RAW" | jq -c '[.files[] | {key: .file, value: .}] | from_entries' 2>/dev/null)"; then
        HISTORY_ERR="tugtool apptest history returned unreadable JSON"
        HISTORY_JSON=""
    fi
fi

# Render one file's recorded history as the line that sits under it in the
# Failures section. Formatted from the verb's JSON, never re-derived — the
# same rule that keeps the summary and the document from drifting.
#
# Every outcome names its run's batch size, because that is what tells a
# defect from contention: some files pass alone in six seconds and time
# out at eighty in a sixteen-file batch, and without the size the two
# shapes read identically.
#
# Skew: an older `tugtool` on PATH answers without the size fields, so
# every size clause degrades to nothing rather than printing "of null".
# The direction is the harness's usual one — the recipe ships with the
# binary, but nothing makes the two versions agree.
history_line() {
    if [ -n "$HISTORY_ERR" ]; then
        echo "    history: unavailable ($HISTORY_ERR)"
        return
    fi
    [ -n "$HISTORY_JSON" ] || return 0
    printf '%s' "$HISTORY_JSON" | jq -r --arg f "$1" '
        def ago($n):
            if $n == 0 then "the last recorded run"
            elif $n == 1 then "1 recorded run ago"
            else "\($n) recorded runs ago" end;
        def size($n):
            if $n == null then null
            elif $n == 1 then "alone"
            else "in a batch of \($n)" end;
        def sizes($lo; $hi):
            if $lo == null or $hi == null then null
            elif $lo == $hi then size($lo)
            else "in batches of \($lo)-\($hi)" end;
        def clause($sep; $phrase): if $phrase == null then "" else $sep + $phrase end;
        (.[$f] // empty) as $h
        | if $h == null then empty
          elif $h.answer == "no-history" then
            "    history: no recorded runs for this file"
          elif $h.answer == "last-green" then
            "    history: last green \($h.sha) (\($h.date), \(ago($h.runsAgo))"
            + clause(", "; size($h.filesInRun))
            + (if $h.dirty then ", dirty tree" else "" end) + ")"
          else
            "    history: red in the last "
            + (if $h.count == 1 then "recorded run" else "\($h.count) recorded runs" end)
            + clause(" "; sizes($h.minFilesInRun; $h.maxFilesInRun))
            + ", back to \($h.backToSha) (\($h.backToDate))"
            + (if $h.lastGreen then "; last green \($h.lastGreen.sha) (\($h.lastGreen.date)"
                 + clause(", "; size($h.lastGreen.filesInRun)) + ")" else "" end)
          end'
}

if [ ${#FAIL_DETAILS[@]} -gt 0 ]; then
    echo
    echo "Failures:"
    fail_file=""
    for row in "${FAIL_DETAILS[@]}"; do
        dfile="${row%%"$US"*}"; rest="${row#*"$US"}"
        dtitle="${rest%%"$US"*}"; rest="${rest#*"$US"}"
        dmsg="${rest%%"$US"*}"
        dloc="${rest##*"$US"}"
        if [ "$dfile" != "$fail_file" ]; then
            echo "  $dfile"
            history_line "$dfile"
            fail_file="$dfile"
        fi
        echo "    > $dtitle"
        [ -n "$dmsg" ] && printf '%s\n' "$dmsg" | sed 's/^/      /'
        [ -n "$dloc" ] && echo "      $dloc"
    done
fi

# The JSON document, when asked for. It is serialized from the SAME arrays
# the summary above renders — never by re-parsing the printed text — so the
# two renderings cannot drift. It never touches stdout: mixing a document
# into the human summary would recreate the parsing problem in a new form.
if [ -n "${TUG_APPTEST_JSON:-}" ]; then
    if ! command -v jq >/dev/null 2>&1; then
        echo "[app-test] TUG_APPTEST_JSON is set but jq is not on PATH — no document written." >&2
    else
        if [ "$files_failed" -eq 0 ] && [ "$files_errored" -eq 0 ] && [ "$files_wedged" -eq 0 ] && [ -z "$HALTED" ]; then
            json_verdict=PASS
        else
            json_verdict=FAIL
        fi
        {
            for row in "${RESULT_ROWS[@]}"; do
                IFS=':' read -r status file rpassed rtotal rsecs <<< "$row"
                fails="$(
                    for d in ${FAIL_DETAILS[@]+"${FAIL_DETAILS[@]}"}; do
                        dfile="${d%%"$US"*}"; rest="${d#*"$US"}"
                        [ "$dfile" = "$file" ] || continue
                        dtitle="${rest%%"$US"*}"; rest="${rest#*"$US"}"
                        jq -n --arg title "$dtitle" \
                              --arg message "${rest%%"$US"*}" \
                              --arg location "${rest##*"$US"}" \
                              '{title:$title,message:$message,location:$location}'
                    done | jq -s '.'
                )"
                # `fromjson? // empty` drops a note that is not valid JSON
                # instead of failing the whole object. Nothing but `note()`
                # should be emitting this sentinel, but a hand-written
                # `console.log("TUG-NOTE: …")` can, and one of those used to
                # take its entire FILE out of the document while `totals`
                # went on counting it — the two renderings disagreeing is
                # the one thing this channel promised could not happen. The
                # human summary already prints such a line raw, so it is
                # reported either way.
                notes="$(
                    for n in ${NOTE_ROWS[@]+"${NOTE_ROWS[@]}"}; do
                        [ "${n%%"$US"*}" = "$file" ] || continue
                        printf '%s\n' "${n#*"$US"}"
                    done | jq -R 'fromjson? // empty' | jq -s '.'
                )"
                # Belt and braces: `--argjson` on an empty string is a hard
                # error, and no single file is worth losing the document.
                [ -n "$notes" ] || notes='[]'
                [ -n "$fails" ] || fails='[]'
                # The same answer the text line formats, from the same
                # JSON — a red file carries its history in both renderings
                # or in neither. `null` on a green file, on a file the
                # lookup could not answer for, and on a lookup that failed.
                history='null'
                if [ -n "$HISTORY_JSON" ]; then
                    history="$(printf '%s' "$HISTORY_JSON" | jq -c --arg f "$file" '.[$f] // null')"
                    [ -n "$history" ] || history='null'
                fi
                jq -n --arg file "$file" --arg status "$status" \
                      --argjson passed "$rpassed" --argjson total "$rtotal" \
                      --argjson seconds "$rsecs" \
                      --argjson failures "$fails" --argjson notes "$notes" \
                      --argjson history "$history" \
                      '{file:$file,status:$status,passed:$passed,total:$total,seconds:$seconds,failures:$failures,notes:$notes,history:$history}'
            done
        } | jq -s \
            --arg sweep "$SWEEP_LABEL" \
            --arg verdict "$json_verdict" \
            --argjson wall "$ELAPSED" \
            --argjson filesRun "$files_run" \
            --argjson filesPassed "$files_passed" \
            --argjson filesFailed "$files_failed" \
            --argjson filesErrored "$files_errored" \
            --argjson filesSkipped "$files_skipped" \
            --argjson filesWedged "$files_wedged" \
            --argjson filesNotRun "${#UNRUN_FILES[@]}" \
            --argjson testsPassed "$tests_passed_total" \
            --argjson testsTotal "$tests_total" \
            '{sweep:$sweep, wallSeconds:$wall, verdict:$verdict,
              totals:{filesRun:$filesRun, filesPassed:$filesPassed,
                      filesFailed:$filesFailed, filesErrored:$filesErrored,
                      filesSkipped:$filesSkipped, filesWedged:$filesWedged,
                      filesNotRun:$filesNotRun, testsPassed:$testsPassed,
                      testsTotal:$testsTotal},
              files: .}' > "$TUG_APPTEST_JSON"
    fi
fi

# Leave the record behind. Assembled from the same arrays both renderings
# above came from, and written only through `tugtool` — the recipe never
# opens SQLite, so no foreign build ever joins a live ledger's WAL.
#
# This is telemetry, and telemetry never gates a run: every failure here is
# one stderr line naming the skip, and the verdict and exit code below do
# not move. A test runner that failed because its diagnostics failed would
# be a worse tool than the one we have.
if [ -z "$TUGTOOL_BIN" ]; then
    echo "[app-test] results not recorded: tugtool is not on PATH" >&2
elif ! command -v jq >/dev/null 2>&1; then
    echo "[app-test] results not recorded: jq is not on PATH" >&2
else
    record_verdict=PASS
    { [ "$files_failed" -eq 0 ] && [ "$files_errored" -eq 0 ] && [ "$files_wedged" -eq 0 ] && [ -z "$HALTED" ]; } || record_verdict=FAIL
    record_head="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    record_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    record_dirty=false
    [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] && record_dirty=true
    record_payload="$(
        {
            for row in "${RESULT_ROWS[@]}"; do
                IFS=':' read -r status file rpassed rtotal rsecs <<< "$row"
                fg=false
                for q in ${FG_QUEUE[@]+"${FG_QUEUE[@]}"}; do
                    [ "$q" = "$file" ] && fg=true && break
                done
                jq -n --arg file "$file" --arg status "$status" \
                      --argjson passed "$rpassed" --argjson total "$rtotal" \
                      --argjson secs "$rsecs" --argjson foreground "$fg" \
                      '{file:$file,status:$status,passed:$passed,total:$total,secs:$secs,foreground:$foreground}'
            done
        } | jq -s \
            --argjson startedAt "$START_EPOCH" --argjson endedAt "$END_EPOCH" \
            --arg runRoot "$REPO_ROOT" \
            --arg branch "$record_branch" --arg headSha "$record_head" \
            --argjson dirty "$record_dirty" \
            --arg sweep "$SWEEP_LABEL" --arg selection "$SELECTION_LABEL" \
            --argjson wallSecs "$ELAPSED" --arg verdict "$record_verdict" \
            '{startedAt:$startedAt, endedAt:$endedAt, runRoot:$runRoot,
              branch:$branch, headSha:$headSha, dirty:$dirty, sweep:$sweep,
              selection:$selection, wallSecs:$wallSecs, verdict:$verdict,
              files: .}'
    )"
    if [ -z "$record_payload" ]; then
        echo "[app-test] results not recorded: could not assemble the run payload" >&2
    elif ! printf '%s' "$record_payload" | "$TUGTOOL_BIN" apptest record >/dev/null; then
        echo "[app-test] results not recorded: tugtool apptest record exited non-zero" >&2
    fi

    # The reach maps of the files that passed: what each one's run actually
    # executed, which the selector ranks by. A red file's map is not a fact
    # about the test, so it is never recorded. Telemetry, like the record above.
    if [ "${TUG_APPTEST_REACH:-}" = "1" ]; then
        reach_payload="$(
            {
                for row in "${RESULT_ROWS[@]}"; do
                    IFS=':' read -r status file _ <<< "$row"
                    [ "$status" = PASS ] || continue
                    reach_file="$RUNDIR/reach/$(printf '%s' "$file" | tr '/' '_').json"
                    [ -s "$reach_file" ] || continue
                    jq -c --arg file "$file" '{file:$file, map:.}' "$reach_file"
                done
            } | jq -s \
                --arg runRoot "$REPO_ROOT" --arg headSha "$record_head" \
                --argjson recordedAt "$END_EPOCH" \
                'if length == 0 then empty else
                 {runRoot:$runRoot, headSha:$headSha, recordedAt:$recordedAt, files: .} end'
        )" || reach_payload=""
        if [ -n "$reach_payload" ] && \
            ! printf '%s' "$reach_payload" | "$TUGTOOL_BIN" apptest reach record >/dev/null; then
            echo "[app-test] reach maps not recorded: tugtool apptest reach record exited non-zero" >&2
        fi
    fi
fi

echo "$BANNER"
# The denominator is what RAN. `files_run` is the requested count and includes
# skipped files, so using it read as "5 files are not green" on a run where five
# files were never asked to be green. Skips are named in their own clause instead.
files_ran=$((files_run - files_skipped))
skip_clause=""
[ "$files_skipped" -gt 0 ] && skip_clause="; $files_skipped skipped"
# A wedge is not a red, but it is not a green either: nobody learned
# whether that file works, so the run cannot say PASS.
wedge_clause=""
[ "$files_wedged" -gt 0 ] && wedge_clause="; $files_wedged wedged"
[ "${#UNRUN_FILES[@]}" -gt 0 ] && wedge_clause="$wedge_clause; ${#UNRUN_FILES[@]} not run"
if [ "$files_failed" -eq 0 ] && [ "$files_errored" -eq 0 ] && [ -z "$wedge_clause" ]; then
    printf 'VERDICT: PASS  (%d/%d files green%s; %d/%d tests passed)\n' \
        "$files_passed" "$files_ran" "$skip_clause" "$tests_passed_total" "$tests_total"
    exit 0
else
    printf 'VERDICT: FAIL  (%d/%d files green; %d file(s) failed%s%s; %d/%d tests passed)\n' \
        "$files_passed" "$files_ran" $((files_failed + files_errored)) "$wedge_clause" "$skip_clause" \
        "$tests_passed_total" "$tests_total"
    exit 1
fi
