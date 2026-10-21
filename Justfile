# Tug development commands

default:
    @just --list

# Build all Rust binaries + tugcode (Claude Code bridge), symlink to ~/.local/bin
build:
    #!/usr/bin/env bash
    set -euo pipefail
    bash tugrust/scripts/report-phase.sh build 0 "Rust debug binaries" --of "Rust debug binaries" "tugcode" --needle "just app-debug" --needle "just launch"
    cd tugrust && cargo build -p tugcast -p tugexec -p tugtool -p tugrelaunch -p tugbank
    cd ..
    bash tugrust/scripts/report-phase.sh build 1 "tugcode"
    bash tugrust/scripts/compile-tugcode.sh tugrust/target/debug/tugcode
    bash tugrust/scripts/report-phase.sh build 2
    # Only the main checkout owns ~/.local/bin. A linked worktree (an arc under
    # .tug/worktrees/) builds its own ephemeral binaries; pointing the global
    # symlinks at them would dangle every tug* tool the moment the arc is torn
    # down. A linked worktree's --git-dir differs from its --git-common-dir.
    if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
        mkdir -p ~/.local/bin
        # tugutil became tugtool on 2026-08-30; drop the old symlink so it
        # does not dangle after this rebuild. Delete this line once every
        # checkout has rebuilt — a stale-cleanup line that outlives its
        # rename is how ~/.local/bin collects junk in the first place.
        rm -f ~/.local/bin/tugutil
        for bin in tugcast tugexec tugtool tugedit tugcode tugrelaunch tugbank; do
            ln -sf "$(pwd)/tugrust/target/debug/$bin" ~/.local/bin/"$bin"
        done
    else
        echo "[build] linked worktree — skipping ~/.local/bin symlinks (main checkout owns them)"
    fi

# Build all binaries, then run tugexec (auto-detects source tree, activates dev mode via control socket)
dev: build
    tugrust/target/debug/tugexec

# Build binaries, run tugexec + cargo-watch for hands-free Rust hot reload
dev-watch: build
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v cargo-watch &>/dev/null; then
        echo "cargo-watch not found. Install with: cargo install cargo-watch"
        exit 1
    fi
    (cd tugrust && cargo watch -w crates -s "cargo build -p tugcast") &
    CARGO_WATCH_PID=$!
    trap "kill $CARGO_WATCH_PID 2>/dev/null" EXIT
    tugrust/target/debug/tugexec

# Vendor IBM Plex woff2 faces from npm into tugdeck/public/fonts (no runtime web loading).
# No args = all phase-1 script families; pass a package short name to fetch one (e.g. plex-math).
fetch-fonts *ARGS:
    cd tugdeck && bun run scripts/fetch-fonts.ts {{ARGS}}

# Run all tests (Rust + TypeScript)
test: test-rust test-ts test-swift test-standalone

# Drive the shipped plugin the way a user's machine would: the real hook
# script and the real `tugtool arc` verbs, from a scratch project with no
# tuglaws/, no CLAUDE.md, no .tugtool/, an empty PATH, and a fresh HOME —
# only a bundle-shaped directory holding tugtool and the plugin.
test-standalone:
    @bash tugrust/scripts/report-phase.sh test-standalone 0 "build tugtool" --of "build tugtool" "tugplug tests" --needle "just test"
    cd tugrust && cargo build -p tugtool
    @bash tugrust/scripts/report-phase.sh test-standalone 1 "tugplug tests"
    cd tugplug && bun test __tests__/
    @bash tugrust/scripts/report-phase.sh test-standalone 2

# Run Rust tests. `--no-fail-fast`: one pass names every failure, so a red
# gate is one round of fixing rather than one round per broken test.
#
# The run goes through `tugtool test run`, which copies the output through
# unchanged, keeps the exit status, and records the run's junit document so
# `tugtool test last --failures` names a red run's failures without a second
# run. With no tugtool that knows `test run` — no build, or only an app build
# that predates the verb — the bare command runs, unrecorded.
test-rust:
    #!/usr/bin/env bash
    TUGTOOL_BIN="{{justfile_directory()}}/tugrust/target/debug/tugtool"
    [ -x "$TUGTOOL_BIN" ] || TUGTOOL_BIN="$(command -v tugtool 2>/dev/null || true)"
    [ -z "$TUGTOOL_BIN" ] || "$TUGTOOL_BIN" test run --help >/dev/null 2>&1 || TUGTOOL_BIN=""
    cd tugrust || exit 1
    if [ -z "$TUGTOOL_BIN" ]; then
        echo "[test] not recorded: no tugtool that knows test run" >&2
        exec cargo nextest run --workspace --no-fail-fast
    fi
    exec "$TUGTOOL_BIN" test run --suite rust --kind nextest --junit target/nextest/default/junit.xml --label rust --needle "just test" --needle "cargo nextest" -- cargo nextest run --workspace --no-fail-fast

# Run TypeScript tests (tugdeck frontend + tugcode bridge + app-test pure logic)
#
# The app-test line names two directories on purpose. `scripts/` and `_harness/`
# hold pure-logic tests that spawn no `Tug.app`; the corpus itself lives at the
# tests/app-test root and under harness-smoke/ and body-grounding/, and is not reached from here.
#
# The tugdeck line runs twice for one reason: `tugdeck/bunfig.toml` pins
# `[test] root = "src"`, so a test outside `src/` — the audit scripts' own
# self-checks under `scripts/__tests__/` — is never discovered by a bare
# `bun test`. Naming the path explicitly is what runs it, and a self-check
# nobody runs is no check at all.
#
# Each line goes through `tugtool test run`, which copies the output through
# unchanged and records the run under its own suite, so `tugtool test last
# --failures` names a red line's failures without a second run. Every line
# runs even after one fails, and the recipe exits non-zero if any did, so one
# pass names every failure. With no tugtool that knows `test run` — no build,
# or only an app build that predates the verb — the bare commands run,
# unrecorded.
test-ts:
    #!/usr/bin/env bash
    # The app-test selection tests drive the real `tugtool apptest reach`
    # verb from `tugrust/target/debug/`, so the binary is built here rather
    # than assumed — a CI cache that happens to hold one is not a dependency.
    # The many-pages suite spawns a real `tugcast` from the same directory;
    # it builds one itself, and building it here keeps a cold compile out of
    # a bun hook.
    # tugcast is built ALONE, exactly as `real-tugcast.ts` builds it: `-p
    # tugtool -p tugcast` unifies features across both crates, so its tugcast
    # is not the artifact `cargo build -p tugcast` looks for, and the hook
    # recompiled tugcast and its deps inside the suite (97 s on CI).
    (cd tugrust && cargo build -p tugtool && cargo build -p tugcast) || exit 1
    TUGTOOL_BIN="{{justfile_directory()}}/tugrust/target/debug/tugtool"
    [ -x "$TUGTOOL_BIN" ] || TUGTOOL_BIN="$(command -v tugtool 2>/dev/null || true)"
    [ -z "$TUGTOOL_BIN" ] || "$TUGTOOL_BIN" test run --help >/dev/null 2>&1 || TUGTOOL_BIN=""
    [ -n "$TUGTOOL_BIN" ] || echo "[test] not recorded: no tugtool that knows test run" >&2
    status=0
    suite() {
        local dir="$1" name="$2"
        shift 2
        if [ -n "$TUGTOOL_BIN" ]; then
            (cd "$dir" && "$TUGTOOL_BIN" test run --suite "$name" --kind bun --label "bun test · $name" --needle "just test" --needle "bun test" -- "$@") || status=1
        else
            (cd "$dir" && "$@") || status=1
        fi
    }
    suite tugdeck tugdeck bun test
    suite tugdeck tugdeck-scripts bun test ./scripts/__tests__
    suite tugcode tugcode bun test
    suite tugproto tugproto bun test
    suite tests/app-test app-test-logic bun test scripts/ _harness/
    exit "$status"

# Run the Swift unit tests.
#
# `TugTests` is a host-less XCTest bundle: it compiles the app's
# Foundation-only sources into itself, so it never launches Tug.app and a
# run takes seconds. Its own derived-data directory keeps it from contending
# with an app build in the same worktree.
# A source joins the bundle when it gets a test, and only a source that
# imports nothing past Foundation can: a test that needs AppKit, a window or
# a menu is an app-test and lives in tests/app-test/.
test-swift:
    @bash tugrust/scripts/report-phase.sh test-swift 0 "xcodebuild TugTests" --of "xcodebuild TugTests" --needle "just test"
    bash tugrust/scripts/xcodebuild-quiet.sh "TugTests" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug \
        -destination 'platform=macOS,arch=arm64' \
        -derivedDataPath "$(bash tugrust/scripts/derived-data-path.sh debug)-tests" \
        test -only-testing:TugTests
    @bash tugrust/scripts/report-phase.sh test-swift 1

# Regenerate every checked-in golden fixture from the code that produces it.
#
# A golden is DERIVED: retune a constant its producer reads and the file is
# stale by construction, which is a fact about the retune, not a test failure
# to be diagnosed. Each entry below pairs a golden with the one command that
# rebuilds it, so the knowledge lives here instead of in a test docstring
# nobody reads until the gate is already red. Adding a new golden means adding
# its line here — an unlisted golden is one nothing here can rebuild.
golden:
    @bash tugrust/scripts/report-phase.sh golden 0 "imposer solutions" --of "imposer solutions" "card plan" "host parity" "session digest" "tugmark golden"
    cd tugdeck && IMPOSER_GOLDEN_UPDATE=1 bun test src/lib/__tests__/layout-imposer-solutions.test.ts
    @bash tugrust/scripts/report-phase.sh golden 1 "card plan"
    cd tugdeck && CARD_PLAN_GOLDEN_UPDATE=1 bun test src/lib/__tests__/card-plan.test.ts
    @bash tugrust/scripts/report-phase.sh golden 2 "host parity"
    cd tugdeck && HOST_PARITY_UPDATE=1 bun test src/host/__tests__/host-parity.test.ts
    @bash tugrust/scripts/report-phase.sh golden 3 "session digest"
    cd tugrust && TUG_DIGEST_GOLDEN_UPDATE=1 cargo nextest run -p tugcast session_digest
    @bash tugrust/scripts/report-phase.sh golden 4 "tugmark golden"
    just tugmark-golden
    @bash tugrust/scripts/report-phase.sh golden 5

# Regenerate the tugmark drift golden (tugdeck/crates/tugmark/corpus/golden.json)
# from the corpus and the newest stream-json catalog, then hold the page's
# pipeline to it. A changed golden is a changed rendering: review its diff.
tugmark-golden:
    cd tugrust && TUGMARK_GOLDEN_WRITE=1 cargo nextest run -p tugcast --test tugmark_drift
    cd tugdeck && bun test src/lib/markdown/__tests__/tugmark-drift.test.ts

# Fuzz both sanitizers at a fresh seed (`just tugmark-fuzz 1234` repeats one).
# tugcast's renderer and sanitizer run 200,000 cases reparsed by html5ever; the
# page's markdown pipeline runs `batches` runs of 1,000 reparsed by
# jsdom, seeds `seed` upward, each in its own process because DOMPurify on
# jsdom slows as one process ages. CI runs each once, at the fixed seed in
# its test file. A failure names its seed and case.
tugmark-fuzz seed="" batches="20":
    #!/usr/bin/env bash
    set -euo pipefail
    seed="{{seed}}"
    [ -n "$seed" ] || seed=$(( (RANDOM << 15) | RANDOM ))
    echo "tugmark-fuzz: seed $seed"
    # One phase for the Rust invariant, then one per bun batch.
    phases=("rust invariant")
    for i in $(seq 1 {{batches}}); do phases+=("bun batch $i"); done
    report="{{justfile_directory()}}/tugrust/scripts/report-phase.sh"
    bash "$report" tugmark-fuzz 0 "rust invariant" --of "${phases[@]}"
    (cd tugrust && TUGMARK_FUZZ_SEED="$seed" TUGMARK_FUZZ_CASES=200000 cargo nextest run -p tugcast --test tugmark_invariant fuzz)
    cd tugdeck
    for i in $(seq 0 $(( {{batches}} - 1 ))); do
        bash "$report" tugmark-fuzz $(( i + 1 )) "bun batch $(( i + 1 ))"
        TUGMARK_FUZZ_SEED=$(( seed + i )) TUGMARK_FUZZ_CASES=1000 \
            bun test src/lib/markdown/__tests__/sanitize-invariant.test.ts -t "holds the invariant over"
    done
    bash "$report" tugmark-fuzz $(( {{batches}} + 1 ))

# Capture Claude Code fixtures + capabilities snapshot (~2-3 min; real-claude)
capture-capabilities:
    #!/usr/bin/env bash
    set -eo pipefail
    if ! command -v claude &>/dev/null; then
        echo "error: claude not found on PATH" >&2
        exit 1
    fi
    # Dirty-tugplug guard. The capture spawns claude with `--plugin-dir tugplug`,
    # so the golden `system_metadata` (skills / slash_commands / agents) reflects
    # whatever is in `tugplug/` AT CAPTURE TIME. Uncommitted skill changes there
    # silently bake into the committed baseline and desync its consumers (e.g.
    # tugdeck/src/__tests__/system-metadata-fixture.test.ts) — exactly the
    # contamination that the recipe/devise + bake/implement rename caused. Refuse
    # on a dirty `tugplug/` tree so the baseline always reflects committed state.
    # Override with TUG_ALLOW_DIRTY_TUGPLUG=1 for an intentional pre-commit capture.
    if [ -z "${TUG_ALLOW_DIRTY_TUGPLUG:-}" ] && [ -n "$(git status --porcelain -- tugplug)" ]; then
        echo "error: tugplug/ has uncommitted changes — the capture would bake them into the golden" >&2
        echo "  commit or stash them first, or set TUG_ALLOW_DIRTY_TUGPLUG=1 to capture anyway" >&2
        git status --porcelain -- tugplug >&2
        exit 1
    fi
    echo "---- claude version ----"
    claude --version
    echo
    # Single stability run by default. Shape flakiness (e.g., optional
    # thinking_text appearing on some runs) surfaces downstream via the
    # drift regression, which canonicalizes sequences and already
    # classifies findings per Benign/Semantic/Ambiguous. Running the
    # capture 3× front-loaded detection that drift already does with
    # one extra run — empirically (v2.1.104..v2.1.112, 3 captures × 35
    # probes), the 3× caught only 2 flakes total, both Benign-class.
    # Override with `TUG_STABILITY=N just capture-capabilities` if you
    # specifically want to probe flapping at baseline time.
    STABILITY="${TUG_STABILITY:-1}"
    echo "---- running capture (TUG_STABILITY=$STABILITY, ~$((STABILITY * 2))-$((STABILITY * 3)) min) ----"
    (cd tugrust && env -u ANTHROPIC_API_KEY TUG_STABILITY="$STABILITY" TUG_REAL_CLAUDE=1 \
        cargo nextest run -p tugcast --features real-claude-tests \
        --run-ignored only --no-capture capture_all_probes)
    VER="$(tr -d '[:space:]' < capabilities/LATEST)"
    echo
    echo "---- capabilities/LATEST → $VER ----"
    ls -la "capabilities/$VER/"
    # Previous baseline = second-newest version dir under capabilities/ in
    # semver order. Used for the stream-json-catalog stat summary.
    PREV_VER="$(ls -d capabilities/*/ 2>/dev/null \
        | sed -E 's|capabilities/||; s|/$||' \
        | grep -v "^$VER$" \
        | sort -V \
        | tail -1 || true)"
    if [ -n "$PREV_VER" ]; then
        echo
        echo "---- stream-json-catalog diff (v$PREV_VER → v$VER) — file-stat summary ----"
        # git diff returns 1 when files differ — expected, not an error.
        git --no-pager diff --no-index --stat \
            "tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$PREV_VER/" \
            "tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$VER/" \
            || true
        echo
        # TTY-guarded: a non-interactive shell (CI, an agent, a piped
        # invocation) has no stdin to read, and an unguarded `read` would
        # hit EOF, return non-zero, and — under `set -e` — abort the recipe
        # BEFORE the drift regression below. The pager is a convenience for
        # a human at a terminal; headless runs skip it and proceed.
        if [ -t 0 ]; then
            read -r -p "View full stream-json diff in pager? [y/N] " ans
            if [[ "$ans" =~ ^[Yy] ]]; then
                git diff --no-index \
                    "tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$PREV_VER/" \
                    "tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$VER/" \
                    || true
            fi
        else
            echo "(non-interactive shell: skipping full-diff pager; stat summary above)"
        fi
    fi
    echo
    echo "---- running drift regression (~2 min) ----"
    # Drift test exit code: 0 = clean or Benign-only warnings; non-zero =
    # Semantic or Ambiguous findings that require consumer classification
    # before a version bump can land. Capture that distinction here.
    DRIFT_OK=1
    (cd tugrust && env -u ANTHROPIC_API_KEY TUG_REAL_CLAUDE=1 \
        cargo nextest run -p tugcast --features real-claude-tests \
        --run-ignored only --no-capture stream_json_catalog_drift_regression) \
        || DRIFT_OK=0
    echo
    if [ "$DRIFT_OK" -eq 0 ]; then
        echo "---- drift regression FAILED ----"
        echo "Classify findings above as Benign / Semantic / Ambiguous per"
        echo "  tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md"
        echo "Nothing staged. Resolve or reclassify, then commit manually."
        exit 1
    fi
    echo "---- drift regression clean (Benign-or-better) ----"
    echo
    COMMIT_MSG="test(tugcast): advance golden baseline to claude $VER"
    echo "Proposed commit:"
    echo "  files: tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$VER/"
    echo "         capabilities/$VER/ + capabilities/LATEST"
    echo "  msg:   $COMMIT_MSG"
    echo
    # TTY-guarded (see the pager note above). A non-interactive run never
    # auto-commits a golden-baseline advance — that's a deliberate review
    # gate. It leaves the refreshed fixtures in the working tree for a
    # human to inspect and commit; the drift regression has already run
    # and passed by this point, which is the leg that must not be skipped.
    if [ -t 0 ]; then
        read -r -p "Approve, stage, and commit? [y/N] " ans
    else
        ans="n"
        echo "(non-interactive shell: skipping interactive baseline commit; review and commit manually)"
    fi
    if [[ ! "$ans" =~ ^[Yy] ]]; then
        echo "Skipped. Working tree left untouched — review, then commit manually."
        exit 0
    fi
    git add "tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$VER/"
    git add "capabilities/$VER/" capabilities/LATEST
    git commit -m "$COMMIT_MSG"
    echo
    echo "---- committed ----"
    git --no-pager log -1 --oneline

# Inspect a Tug ledger database SAFELY: copies db + WAL/shm to a temp dir
# and opens sqlite3 there. NEVER point sqlite3 (Apple's build) at the live
# files — a foreign SQLite participating in WAL recovery/checkpointing on
# a live ledger is a corruption vector (2026-07-27 incident). Pass a name
# (changes / sessions / shell_exchanges) or an absolute .db path; any
# extra args go to sqlite3 (e.g. a quoted SQL string).
db-inspect DB *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{DB}}" in
        /*) src="{{DB}}" ;;
        *)  src="$HOME/Library/Application Support/Tug/{{DB}}.db" ;;
    esac
    [ -f "$src" ] || { echo "no such database: $src" >&2; exit 1; }
    tmp="$(mktemp -d /tmp/tug-db-inspect.XXXXXX)"
    cp -p "$src" "$tmp/"
    for ext in -wal -shm; do
        [ -f "$src$ext" ] && cp -p "$src$ext" "$tmp/"
    done
    db="$tmp/$(basename "$src")"
    echo "inspecting COPY at $db (live files untouched)" >&2
    if [ -n {{ quote(ARGS) }} ]; then
        sqlite3 "$db" {{ quote(ARGS) }}
    else
        sqlite3 "$db"
    fi

# Regenerate the Rust session-tag lexicon from its TypeScript source.
# tugdeck/src/lib/session-tag-lexicon.ts owns the words; the ledger's mint
# reroll needs the same pools. Run this after editing the lexicon — a Rust
# drift test reads the TS file at test time and fails when the two part.
gen-session-tag-lexicon:
    cd tugdeck && bun run scripts/generate-session-tag-lexicon.ts
    cd tugrust && cargo fmt -p tugcast

# Format Rust code
fmt:
    cd tugrust && cargo fmt --all

# Run clippy + fmt check, plus the deck's own tripwires. audit:visibility is
# [L32]'s: a mechanism that decides visibility must own the state it fails to.
# audit:motion is the deck's motion tripwire. Rules 1 and 2 are the settle
# pipeline's, and they are [D9]'s static half.
# Rule 1: a pane frame is a containing block for its `position: fixed`
# descendants, so a surface that positions from the viewport inside one
# positions from the frame's corner instead — silently, and only once the
# frames have moved. Rule 2: the settle window is compositor-only, so a
# `transition` or `animation` on a frame may name only `transform` and
# `opacity` unless it stands itself down under `[data-imposer-settling]`.
# [D9]'s runtime half is the settle's own `settle-frames` trace row — which
# catches the effects no stylesheet scan can see.
# Rule 3 is `tuglaws/animation-doctrine.md`'s: a loop that runs for as long as
# the deck is up must be one Core Animation can hold, because the alternative
# is a per-frame style commit and the whole page's compositing walk behind it.
# It reads CodeMirror's JavaScript-authored styles as well as the stylesheets,
# and it requires the `var(--tug-loop-iterations, infinite)` count the motion
# circuit breaker demotes through. Its runtime half is `animationCensus()`,
# which sees what a selector cannot say — an SVG target, an effect built with
# `element.animate()`.
# audit:type-alignment is the vertical type rhythm's, and it is the static
# half of `tuglaws/type-alignment.md`. Text sharing a row shares a baseline by
# a mechanism and never by a hand-tuned offset: rule 1 refuses a micro `top` /
# `translateY` / length `vertical-align` on a rule that also carries text,
# rule 2 refuses a re-derived `.tug-line-box` stanza, and rule 3 refuses a
# heavily tracked uppercase legend that does not hand its trailing track back.
# A genuine optical correction is not banned — it carries an
# `@tug-optical-nudge:` comment saying what it corrects, which is what makes
# the remaining ones countable. The runtime half is `at0625-type-baseline`,
# because no stylesheet scan can see a rendered baseline.
lint: tugplug-lint recipe-lint shellcheck wasm-check
    cd tugdeck && bun run audit:visibility
    cd tugdeck && bun run audit:motion
    cd tugdeck && bun run check
    cd tugdeck && bun run lint
    cd tugcode && bun run check
    cd tugcode && bun run lint
    cd tests/app-test && bun run check
    cd tests/app-test && bun run lint
    cd tugdeck && bun run audit:type-alignment
    cd tugdeck && bun run audit:tokens lint
    cd tugrust && cargo clippy --workspace --all-targets -- -D warnings
    cd tugrust && cargo fmt --all -- --check
    bun scripts/third-party-notices.ts --check

# shellcheck over the runner and build scripts. The few codes the house style
# disables are in .shellcheckrc, each with its reason.
shellcheck:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v shellcheck >/dev/null 2>&1; then
        echo "shellcheck is not installed: brew install shellcheck" >&2
        exit 1
    fi
    shellcheck tests/app-test/scripts/*.sh tugrust/scripts/*.sh

# The plugin ships inside Tug.app to projects that are not this one. Refuse
# every shape under tugplug/ that leans on this checkout or this machine —
# `just` recipes, source-tree paths, commit hashes, jq, a tuglaws citation
# with no absence clause. Contract: tugplug/CLAUDE.md.
tugplug-lint:
    bun scripts/tugplug-lint.ts

# A long recipe reports with a unit — `tugtool report phase` through
# tugrust/scripts/report-phase.sh, `tugtool report count --unit`, or
# `tugtool test run` — or delegates to a recipe or script that does, so the
# Bash block draws its report panel instead of sitting silent for minutes. The
# list of long recipes and the named exemptions (each with its reason) are in
# the script; the test drives the check over a fixture Justfile.
recipe-lint:
    bun scripts/recipe-lint.ts
    bun test scripts/__tests__/recipe-lint.test.ts

# Regenerate the "Libraries shipped inside Tug.app" half of
# THIRD_PARTY_NOTICES.md from the lockfiles. `just lint` runs the same script
# with `--check`, which fails when the committed section has drifted from the
# lockfiles or when a shipped package's license is outside the permissive
# allow-list — L21's rule, and the no-GPL rule, as a check. Run this after any
# dependency change.
notices:
    bun scripts/third-party-notices.ts

# Apply the clippy suggestions `cargo clippy --fix` refuses to, and print the
# ones no tool should apply unattended. `--fix` applies only what rustc marked
# `MachineApplicable`, so a lint like `ptr_arg` survives every `--fix` pass
# forever; this reads the same diagnostics out of `--message-format=json` and
# decides for itself. `--explain` reports without applying. The trust criteria
# live at the top of the script.
clippy-repair *ARGS:
    bun scripts/clippy-repair.ts {{ARGS}}

# Full pre-merge gate (lint + test).
ci: lint test

# Build every WASM crate under tugdeck/crates/ via scripts/build-wasm.sh.
# The script auto-discovers crates by globbing tugdeck/crates/*/Cargo.toml
# and normalizes pkg/.gitignore so the built artifacts can be committed
# without `git add -f`. See tuglaws/wasm-crates.md for the convention.
# Build every WASM crate under tugdeck/crates/.
wasm:
    scripts/build-wasm.sh

# Rebuild every WASM package and fail if it differs from the committed one,
# so a `pkg/` is always the build of its crates' source under the pinned
# toolchain (`tugdeck/crates/rust-toolchain.toml`). A failure means the
# rebuilt package is in the tree: commit it with the source that moved it.
wasm-check: wasm
    git diff --exit-code --stat -- tugdeck/crates/*/pkg
    @untracked="$(git ls-files --others --exclude-standard -- tugdeck/crates/*/pkg)"; if [ -n "$untracked" ]; then echo "wasm-check: untracked package files:"; echo "$untracked"; exit 1; fi

# Build the Mac app (with all dependencies), and run/restart it.
#
# Signing: after xcodebuild's ad-hoc signing, the recipe re-signs via
# tugrust/scripts/sign-bundle.sh — inside-out, per [D16] in
# tuglaws/code-signing-mac.md. This gives the dev bundle a stable
# designated requirement (signed by Apple Developer ID) so the AX
# grant persists across rebuilds. Without it, every rebuild would
# invalidate the grant.
#
# (Note: Step 15 of the multi-instance plan will retire this recipe
# in favor of `just app-debug`. Until then, this is the canonical
# debug loop.)
# ── Multi-instance recipe surface ────────────────────────────────────────────
#
# The debug/release axis (per [D17] in tuglaws/code-signing-mac.md,
# tokens renamed per [D19]): `app-debug` / `app-release` build +
# relaunch a per-(profile, branch) instance. Running `app-release`
# from a worktree branch produces a `(release, <branch>)` instance,
# not `(release, main)` — the axis is build-flavor, not
# identity-fork.
#
# Distribution-flow recipes (`dmg`, `notarize`) live separately and
# operate on bundles, not running instances.

# Build a Debug bundle and (re)launch the cwd-derived debug
# instance. Identity is computed from the current git branch and the
# `debug` profile.
#
# The quit-prior step is the FIRST thing the recipe does, before
# cargo/wasm/xcodebuild/sign. sign-bundle.sh rewrites the bundle's
# binaries in place; if the previous instance is still running, the
# kernel notices the signature change under its live mmap'd code and
# SIGKILLs tugcast — the WebView then flashes a disconnect banner
# during what should be a smooth handoff. Quitting first avoids that.
# Build a Debug bundle and (re)launch the cwd-derived debug instance.
app-debug: build wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # TUG_FORCE_BUNDLE_ID belongs ONLY to the app-test / unattended build
    # path (build-app / app-test, where it pins a stable AX grant across
    # worktrees). The interactive dev loop is always the cwd-derived
    # debug identity, so clear any value the shell exported for app-test —
    # otherwise product-name / bundle-id / capture-build-info would honor
    # it and `app-debug` would build and launch an apptest instance
    # instead of Tug-debug (debug-main).
    unset TUG_FORCE_BUNDLE_ID
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh debug)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh debug)"
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh debug)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    echo "==> Quitting prior $INSTANCE_ID, if running"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    # Debug bundles serve the frontend via Vite HMR — no `bun run build`
    # is needed here. The xcodebuild build phase tolerates an empty
    # tugdeck/dist; release builds (`app-release`) run the full vite
    # build before xcodebuild.
    # TUG_PRODUCT_NAME gives each variant its own `.app` (Tug-debug.app /
    # Tug-worktree.app) AND `-derivedDataPath` gives it its own build
    # directory, so build outputs are fully isolated — building the
    # app-test bundle never clobbers this debug bundle, and vice-versa.
    # The default DerivedData is shared per-project, so without this every
    # variant overwrites the same target product. See derived-data-path.sh.
    # It travels as an environment variable that the Tug target's PRODUCT_NAME
    # setting reads, NOT as an xcodebuild command-line setting: a command-line
    # setting applies to every target in the graph, so the SPM packages'
    # resource-bundle targets would all take the same name and collide
    # ("Multiple commands produce ....bundle").
    DERIVED="$(bash tugrust/scripts/derived-data-path.sh debug)"
    bash tugrust/scripts/report-phase.sh app-debug 0 "Xcode build" --of "Xcode build" "sign" "launch"
    bash tugrust/scripts/xcodebuild-quiet.sh "${PRODUCT_NAME}.app (Debug)" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug \
        -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DERIVED" build
    APP_DIR="$DERIVED/Build/Products/Debug/${PRODUCT_NAME}.app"
    # With no Developer ID certificate, sign ad-hoc rather than fail: the
    # interactive bundle runs either way. See sign-bundle.sh's header.
    bash tugrust/scripts/report-phase.sh app-debug 1 "sign"
    TUG_SIGN_ALLOW_ADHOC=1 bash tugrust/scripts/sign-bundle.sh "$APP_DIR"
    # Non-blocking orphan-detection preamble so users get a nudge to
    # clean up bundle-less data dirs without ever failing the build.
    if tugrust/target/debug/tugtool host instance prune --json 2>/dev/null | grep -q instance_id; then
        echo "[warn] orphaned per-instance data dirs detected. Run 'tugtool host instance prune' to clean up." >&2
    fi
    # Seed the per-instance source-tree-path so the first launch knows
    # where to find tugdeck/, tugcode, etc. AppDelegate also falls
    # back to BuildInfo.sourceTree (capture-build-info.sh writes
    # $SRCROOT into Info.plist), but writing it explicitly here keeps
    # the user's chosen tree wins over any stale build-time value.
    tugrust/target/debug/tugbank --instance "$INSTANCE_ID" write dev.tugapp.app source-tree-path "$(pwd)" >/dev/null
    # Bodies are a switch, off on the shipping build (the grounding brief's
    # [B01]); the dev instance runs with it on. Seeded only while the key is
    # absent, so the Layout card's Bodies row on this instance holds across
    # relaunches instead of being flipped back on at each one.
    if ! tugrust/target/debug/tugbank --instance "$INSTANCE_ID" read dev.tugapp.deck bodies >/dev/null 2>&1; then
        tugrust/target/debug/tugbank --instance "$INSTANCE_ID" write dev.tugapp.deck bodies --type bool true >/dev/null
    fi
    echo "==> Launching $INSTANCE_ID ($APP_DIR)"
    bash tugrust/scripts/report-phase.sh app-debug 2 "launch"
    # Scrub the launching instance's env before `open` propagates it: one
    # shared list, in launch-scrubbed.sh, so the launches cannot drift.
    bash tugrust/scripts/launch-scrubbed.sh open "$APP_DIR"
    bash tugrust/scripts/report-phase.sh app-debug 3

# Build a Release bundle and (re)launch the cwd-derived release
# instance. Quit-prior runs first for the same reason as app-debug.
# Build a Release bundle and (re)launch the cwd-derived release instance.
#
# No `build` dependency: the bundle copies its binaries from
# tugrust/target/release, so the dev binaries `build` compiles would be
# wasted work here (a full dev tugcast rebuild after any Rust edit). The
# recipe itself needs only the dev tugbank, built below. `just build` is
# still what refreshes the ~/.local/bin symlinks.
app-release: wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    (cd tugrust && cargo build -p tugbank)
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh release)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    echo "==> Quitting prior $INSTANCE_ID, if running"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    # Compile the shared release inputs (Rust binaries, tugcode, tugdeck
    # assets) — the same script build-app.sh uses, so the developer
    # launch build and the distribution build can't drift on what they compile.
    # The xcodebuild copy phase reads these from tugrust/target/release/.
    # --dev makes the Rust build incremental and skips an unchanged tugdeck
    # build; it changes caching only, never what is built.
    bash tugrust/scripts/report-phase.sh app-release 0 "release inputs" --of "release inputs" "Xcode build" "sign" "launch"
    bash tugrust/scripts/build-release-inputs.sh --dev
    DERIVED="$(bash tugrust/scripts/derived-data-path.sh release)"
    bash tugrust/scripts/report-phase.sh app-release 1 "Xcode build"
    bash tugrust/scripts/xcodebuild-quiet.sh "${PRODUCT_NAME}.app (Release)" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Release \
        -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DERIVED" build
    APP_DIR="$DERIVED/Build/Products/Release/${PRODUCT_NAME}.app"
    # Ad-hoc fallback when there is no Developer ID certificate, as in app-debug.
    bash tugrust/scripts/report-phase.sh app-release 2 "sign"
    TUG_SIGN_ALLOW_ADHOC=1 bash tugrust/scripts/sign-bundle.sh "$APP_DIR"
    # Seed source-tree-path for the release instance too. AppDelegate
    # falls back to BuildInfo.sourceTree if the tugbank value is
    # missing, but release builds intentionally omit BuildSourceTree
    # ([D03]), so this write is the only path for release from a
    # developer checkout.
    tugrust/target/debug/tugbank --instance "$INSTANCE_ID" write dev.tugapp.app source-tree-path "$(pwd)" >/dev/null
    echo "==> Launching $INSTANCE_ID ($APP_DIR)"
    bash tugrust/scripts/report-phase.sh app-release 3 "launch"
    # Scrub the launching instance's env before `open` propagates it: one
    # shared list, in launch-scrubbed.sh, so the launches cannot drift.
    bash tugrust/scripts/launch-scrubbed.sh open "$APP_DIR"
    bash tugrust/scripts/report-phase.sh app-release 4

# Relaunch the cwd-derived debug instance without rebuilding.
launch-debug:
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh debug)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    APP_DIR="$(bash tugrust/scripts/derived-data-path.sh debug)/Build/Products/Debug/${PRODUCT_NAME}.app"
    if [ ! -d "$APP_DIR" ]; then
        echo "error: ${PRODUCT_NAME}.app not built at $APP_DIR" >&2
        echo "       Run 'just app-debug' first." >&2
        exit 1
    fi
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh debug)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh debug)"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    # Scrub the launching instance's env before `open` propagates it: one
    # shared list, in launch-scrubbed.sh, so the launches cannot drift.
    bash tugrust/scripts/launch-scrubbed.sh open "$APP_DIR"

# Relaunch the cwd-derived release instance without rebuilding.
launch-release:
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh release)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    APP_DIR="$(bash tugrust/scripts/derived-data-path.sh release)/Build/Products/Release/${PRODUCT_NAME}.app"
    if [ ! -d "$APP_DIR" ]; then
        echo "error: ${PRODUCT_NAME}.app not built at $APP_DIR" >&2
        echo "       Run 'just app-release' first." >&2
        exit 1
    fi
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    # Scrub the launching instance's env before `open` propagates it: one
    # shared list, in launch-scrubbed.sh, so the launches cannot drift.
    bash tugrust/scripts/launch-scrubbed.sh open "$APP_DIR"

# Stop the cwd-derived debug instance (idempotent). Quits the GUI app
# AND the tugcast registry entry — `just app-debug` then re-launches
# fresh, instead of LaunchServices bringing the previous (stale)
# Tug.app to front.
# Stop the cwd-derived debug instance (idempotent).
stop-debug:
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh debug)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh debug)"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"

# Stop the cwd-derived release instance (idempotent).
stop-release:
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"

# Stop every live Tug instance.
stop:
    #!/usr/bin/env bash
    set -uo pipefail
    TUGTOOL="$(bash tugrust/scripts/tugtool-bin.sh)" || exit 1
    FAILED=0
    while read -r LINE; do
        ID="$(printf '%s' "$LINE" | awk '{print $1}')"
        BUNDLE_PATH="$(printf '%s' "$LINE" | awk '{print $4}')"
        [ -n "$ID" ] || continue
        # The bundle id, from the bundle's Info.plist, is the script's
        # last check that no process still holds it; an entry whose
        # bundle cannot be read skips that check and is quit all the same.
        BUNDLE_ID=""
        if [ -n "$BUNDLE_PATH" ] && [ -f "$BUNDLE_PATH/Contents/Info.plist" ]; then
            BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BUNDLE_PATH/Contents/Info.plist" 2>/dev/null || true)"
        fi
        # One instance that will not quit does not keep the rest running;
        # the recipe still fails at the end.
        bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$ID" || FAILED=1
    done < <("$TUGTOOL" host instance list 2>/dev/null | tail -n +2)
    exit "$FAILED"

# One-line wrapper around `tugtool host instance list`. Forwards any extra
# args (e.g. `--json`).
# List running Tug instances (wraps `tugtool host instance list`).
instances *FLAGS:
    tugrust/target/debug/tugtool host instance list {{FLAGS}}

# The system log for an instance's host app — AppKit's lines, the Apple
# Event traffic, NSLog — which `tugapp.log` does not carry. The pid comes
# from the instance registry.
# Show an instance's app system log (`--last 5m`, `--grep X`).
[positional-arguments]
app-log INSTANCE *ARGS:
    @bash tugrust/scripts/app-inspect.sh log "$@"

# Sample an instance's host app (default 3 s) and print the file written.
[positional-arguments]
app-sample INSTANCE *ARGS:
    @bash tugrust/scripts/app-inspect.sh sample "$@"

# Print an instance's host run-loop state from `/api/host/state`.
[positional-arguments]
app-state INSTANCE:
    @bash tugrust/scripts/app-inspect.sh state "$@"

# Profile what the cwd-derived debug instance's renderer does per frame.
#
# MODE is `resize` (drive a paced window resize while sampling — the
# jank the user feels) or `idle` (steady state). The verdict reports
# main-thread busy share and the sample counts of the frames motion
# residency turns on: keyframe blending in style resolution, and the
# compositing walk it triggers. See tuglaws/motion-residency.md.
#
# This is a hand tool, not a gate — `sample` numbers move with machine
# load. Compare a before and an after taken minutes apart, not across
# days. Resize mode needs accessibility permission for this terminal.
# Profile the debug instance's renderer (MODE = resize | idle).
perf-resize-profile MODE="resize" SECONDS="6":
    #!/usr/bin/env bash
    set -euo pipefail
    unset TUG_FORCE_BUNDLE_ID
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh debug)"
    bash scripts/perf-resize-profile.sh "$BUNDLE_ID" {{MODE}} {{SECONDS}}

# Tail the debug instance's newest tugcast + tugapp logs.
logs-debug:
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh debug)"
    bash tugrust/scripts/tail-instance-logs.sh "$INSTANCE_ID"

# Tail the release instance's newest tugcast + tugapp logs.
logs-release:
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    bash tugrust/scripts/tail-instance-logs.sh "$INSTANCE_ID"

# Tug-aware wrapper around `git worktree remove`. Cleans up the
# worktree's instance state first (bundle, LaunchServices entry,
# per-instance data dir, optionally TCC), then removes the worktree.
# Eliminates the "did I forget to clean up first" failure mode.
# Tug-aware `git worktree remove` — tears down instance state first.
worktree-remove WORKTREE *FLAGS:
    #!/usr/bin/env bash
    set -euo pipefail
    WORKTREE="{{WORKTREE}}"
    FLAGS="{{FLAGS}}"
    if [ ! -d "$WORKTREE" ]; then
        echo "error: $WORKTREE is not a directory" >&2
        exit 1
    fi
    if ! git worktree list | awk '{print $1}' | grep -qFx "$(cd "$WORKTREE" && pwd)"; then
        echo "error: $WORKTREE is not a registered git worktree" >&2
        echo "       run 'git worktree list' to see what's tracked" >&2
        exit 1
    fi
    BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD)"
    if [ "$BRANCH" = "HEAD" ]; then
        BRANCH="detached-$(git -C "$WORKTREE" rev-parse HEAD | cut -c1-8)"
    fi
    SLUG="$(bash tugrust/scripts/branch-slug.sh "$BRANCH")"
    INSTANCE_ID="debug-$SLUG"
    echo "==> worktree-remove: $WORKTREE"
    echo "    branch:      $BRANCH"
    echo "    instance ID: $INSTANCE_ID"
    tugrust/target/debug/tugtool host instance remove "$INSTANCE_ID" $FLAGS
    git worktree remove --force "$WORKTREE"
    echo "==> Removed worktree $WORKTREE and its instance state ($INSTANCE_ID)."

# Use this during transcript-resume smoke runs so
# the relevant `[dev::replay::started|progress|complete|error]`
# and `[dev::session-lifecycle event=...]` lines stand out without
# the full firehose. `--line-buffered` keeps grep's output flowing
# live even when the pipe stage downstream block-buffers.
# Tail tugcast log filtered to replay + lifecycle targets.
tail-replay:
    #!/usr/bin/env bash
    set -euo pipefail
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh debug)"
    LOGS="$HOME/Library/Application Support/Tug/instances/$INSTANCE_ID/Logs"
    LOG="$(ls -t "$LOGS"/tugcast.log.* 2>/dev/null | head -1 || true)"
    if [ -z "$LOG" ]; then
        echo "no log for $INSTANCE_ID in $LOGS. Launch Tug.app with 'just app-debug' first."
        exit 1
    fi
    tail -F "$LOG" | grep --line-buffered -E "dev::replay::|dev::session-lifecycle"

# Remedial resource cleanup — release the runtime debris crashed runs and
# out-of-band worktree deletion leave behind (`git worktree remove` /
# `rm -rf` instead of `tugtool arc join|release` / `instance remove`).
#
# A thin front end over `tugtool host sweep`, which is the one janitor:
# tugcast calls the same `tugcore::janitor` code at startup, so there is
# no second implementation to drift.
#
# Nothing is released on a name pattern alone. Sockets must fail a
# connect probe AND not belong to a live registered instance; tmux
# servers and data dirs must have no live registry entry; and every
# registry-gated deletion has a minimum-age floor, because a booting
# instance is invisible to the registry until after its port bind. A
# developer's app-debug / app-release and an in-flight app-test are
# never touched.
#
# Releases: dead tugcast-ctl / tugbank-notify / harness sockets,
# orphaned per-instance tmux servers, legacy default-server `cc-*`
# sessions, aged $TMPDIR test litter, finished app-test data dirs, and
# tugcode / claude processes reparented to PID 1.
#
# Reports only (removal can delete a possibly-shared app bundle, so it
# stays deliberate): data dirs whose bundle is gone → `tugtool host
# instance prune`.
#
# Usage:
#   just reap          # diagnose only — report what's leaked, change nothing
#   just reap apply    # release everything reported
reap *MODE:
    #!/usr/bin/env bash
    set -uo pipefail
    # The janitor is the source of truth for what is live, so it is a
    # hard dependency — build it rather than risk reaping blind.
    TUGTOOL="tugrust/target/debug/tugtool"
    if [ ! -x "$TUGTOOL" ]; then
        echo "==> building tugtool (needed to identify live instances)…"
        (cd tugrust && cargo build -p tugtool) || { echo "error: could not build tugtool" >&2; exit 1; }
    fi
    if [ "{{MODE}}" = "apply" ]; then
        "$TUGTOOL" host sweep --yes
    else
        echo "== reap (diagnose — nothing will change; run 'just reap apply' to release) =="
        "$TUGTOOL" host sweep --dry-run
    fi

# Render the styled DMG background art (resources/dmg-preview.svg) into the
# multi-representation HiDPI TIFF the dmgbuild step consumes. Two reps —
# 720x460 @1x + 1440x920 @2x — combined via `tiffutil -cathidpicheck`.
# Re-run after editing the SVG; the live app/Applications icons are NOT
# painted in (Finder draws them), so only the art changes here.
# Render resources/dmg-preview.svg into the HiDPI dmg-background.tiff (run after editing the SVG).
dmg-background:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v rsvg-convert &>/dev/null; then
        echo "error: rsvg-convert not found (brew install librsvg)" >&2
        exit 1
    fi
    SRC=resources/dmg-preview.svg
    OUT=resources/dmg-background.tiff
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    rsvg-convert -w 720  -h 460 "$SRC" -o "$TMP/bg-1x.png"
    rsvg-convert -w 1440 -h 920 "$SRC" -o "$TMP/bg-2x.png"
    tiffutil -cathidpicheck "$TMP/bg-1x.png" "$TMP/bg-2x.png" -out "$OUT"
    echo "==> wrote $OUT"
    tiffutil -info "$OUT" | grep -iE "image width|image length"

# Build unsigned DMG (no Developer ID, no notarization). Fastest
# distribution-shape artifact; suitable for sharing a build locally
# (e.g., to a tester on the same Mac) but Gatekeeper will reject it
# on a clean machine.
# Build an unsigned Tug.dmg — fast; local testing only (Gatekeeper blocks it on other Macs).
dmg:
    tugrust/scripts/build-app.sh --skip-sign --skip-notarize

# Build a signed + notarized DMG. Submits to Apple's notary service
# and waits for the ticket (typically 5-15 min, ceiling 30 min via
# notarytool --timeout). Requires the `tug-notary` keychain profile
# from #apple-prereqs and an active network connection.
#
# Prereqs (one-time per machine):
#   just setup-dev-signing                 # verifies Developer ID cert
#   # plus #apple-prereqs step 5:
#   #   xcrun notarytool store-credentials tug-notary \
#   #       --apple-id <apple-id> --team-id <team-id> --password <app-password>
#
# This is the canonical distribution build. Use `just dmg` for the
# fast unsigned variant.
# Build a signed + notarized Tug.dmg — the canonical shippable build.
notarize:
    tugrust/scripts/build-app.sh

# ─── Cutting a release ──────────────────────────────────────────────────────

# The CFBundleVersion for a M.m.p version, by version.sh's own formula
# (major*10000 + minor*100 + patch). Hidden, and the only copy in this file:
# `version` prints it and `bless` checks Info.plist against it, so a second
# copy would be a second thing to keep in agreement. version.sh exposes no
# subcommand for it, and this is not the change that alters version.sh.
_bundle-version VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    IFS='.' read -r MAJ MIN PAT <<< "{{VERSION}}"
    echo $(( MAJ * 10000 + MIN * 100 + PAT ))

# Print the current version and the CFBundleVersion derived from it.
version:
    #!/usr/bin/env bash
    set -euo pipefail
    VERSION="$(tugrust/scripts/version.sh show)"
    echo "version          $VERSION"
    echo "CFBundleVersion  $(just _bundle-version "$VERSION")"

# Bump the version everywhere and say what has to be written next. The bump
# is version.sh's — Cargo.toml, both package.json files, Info.plist, the
# lockfile, and a seeded release-notes/<version>.md. What this adds is the
# hand-off: the seeded notes file is the step that gets skipped, so the bump
# ends by naming it rather than leaving it to be remembered.
#
# Bump the version everywhere (major|minor|patch) and name the notes to write.
version-bump COMPONENT:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{COMPONENT}}" in
        major|minor|patch) ;;
        *) echo "usage: just version-bump major|minor|patch" >&2; exit 1 ;;
    esac
    OLD="$(tugrust/scripts/version.sh show)"
    NEW="$(tugrust/scripts/version.sh bump {{COMPONENT}})"
    echo
    echo "$OLD -> $NEW (CFBundleVersion $(just _bundle-version "$NEW"))"
    echo
    echo "Not ready to release. Write release-notes/$NEW.md first: the update"
    echo "popover renders that file in front of the user, so leaving it seeded"
    echo "ships the placeholder rather than nothing at all. just bless refuses"
    echo "a release until it is written."
    echo
    echo "    just release-notes"

# Open this version's release notes in the editor. No version argument: the
# notes that matter are always the current version's, and having to name it
# is how you end up editing the wrong file.
#
# Open release-notes/<current version>.md in $VISUAL or $EDITOR.
release-notes:
    #!/usr/bin/env bash
    set -euo pipefail
    VERSION="$(tugrust/scripts/version.sh show)"
    NOTES="release-notes/$VERSION.md"
    if [ ! -f "$NOTES" ]; then
        echo "error: $NOTES does not exist — a version bump seeds it" >&2
        exit 1
    fi
    exec "${VISUAL:-${EDITOR:-vi}}" "$NOTES"

# Would I be happy to have shipped this? A local, read-only gate that never
# builds, signs, pushes or dispatches, and answers in seconds. Everything it
# checks is something CI either cannot check or checks too late to be useful:
# the version has to read the same in four files, the release notes for that
# version have to have actually been written, the tree has to be clean and
# pushed (CI builds the pushed ref, not yours), and the version must not
# already be published.
#
# CI's own state on HEAD is REPORTED, NOT REQUIRED. Two facts decided that:
# over the last 40 recorded runs of ci.yml on main, 15 were red; and the
# workflow does not run on every commit, so an arbitrary HEAD usually has no
# run at all. A gate that blocked on either would be a gate that is always
# forced, which teaches the habit this recipe exists to build against.
#
# Read-only by construction: it writes no file and moves no ref — the remote
# is asked with `gh api`, which is a GET: it writes nothing under .git/ and
# moves no ref, where a fetch would write FETCH_HEAD and move
# refs/remotes/origin/main.
#
# Check a release before cutting it — version, notes, tree, remote (read-only).
bless:
    #!/usr/bin/env bash
    set -uo pipefail
    #
    # Findings accumulate; the recipe reports all of them rather than stopping
    # at the first, because fixing one at a time is how a gate becomes tedious.
    FAILED=0
    fail() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
    ok()   { printf '  ok  %s\n' "$1"; }
    note() { printf 'note  %s\n' "$1"; }
    #
    VERSION="$(tugrust/scripts/version.sh show)"
    if [ -z "$VERSION" ]; then
        echo "bless: cannot read a version from tugrust/Cargo.toml" >&2
        exit 1
    fi
    BUNDLE="$(just _bundle-version "$VERSION")"
    echo "bless $VERSION (CFBundleVersion $BUNDLE)"
    echo
    #
    # 1. One version, four files.
    pkg_version() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }
    plist_get()   { /usr/libexec/PlistBuddy -c "Print :$1" tugapp/Info.plist 2>/dev/null; }
    TUGCODE_V="$(pkg_version tugcode/package.json)"
    TUGDECK_V="$(pkg_version tugdeck/package.json)"
    PLIST_SHORT="$(plist_get CFBundleShortVersionString)"
    PLIST_BUNDLE="$(plist_get CFBundleVersion)"
    VERSIONS_AGREE=1
    [ "$TUGCODE_V" = "$VERSION" ] || { fail "tugcode/package.json says '$TUGCODE_V', not $VERSION"; VERSIONS_AGREE=0; }
    [ "$TUGDECK_V" = "$VERSION" ] || { fail "tugdeck/package.json says '$TUGDECK_V', not $VERSION"; VERSIONS_AGREE=0; }
    [ "$PLIST_SHORT" = "$VERSION" ] || { fail "Info.plist CFBundleShortVersionString is '$PLIST_SHORT', not $VERSION"; VERSIONS_AGREE=0; }
    [ "$PLIST_BUNDLE" = "$BUNDLE" ] || { fail "Info.plist CFBundleVersion is '$PLIST_BUNDLE', not the derived $BUNDLE"; VERSIONS_AGREE=0; }
    [ "$VERSIONS_AGREE" -eq 1 ] && ok "version $VERSION reads the same in all four files"
    #
    # 2. The release notes exist and are not still the seed. This is the check
    #    with the most value in it: the notes are rendered in the update
    #    popover, so a stub ships in front of the user rather than merely
    #    being absent. The test is for version.sh's known seed text, never a
    #    length heuristic — a word count gets this wrong in both directions.
    NOTES="release-notes/$VERSION.md"
    if [ ! -f "$NOTES" ]; then
        fail "$NOTES does not exist (version.sh seeds it on a bump)"
    elif grep -q "What changed, for someone who has been using" "$NOTES" || grep -q "Delete this comment" "$NOTES"; then
        fail "$NOTES is still version.sh's seeded stub — write it before releasing"
    elif [ -z "$(sed -e 's/<!--.*-->//' -e '/<!--/,/-->/d' -e '/^#/d' -e '/^[[:space:]]*$/d' "$NOTES")" ]; then
        fail "$NOTES has a heading and nothing else — write it before releasing"
    else
        ok "$NOTES is written"
    fi
    #
    # 3. The commit CI would build is the one you are looking at.
    if [ -n "$(git status --porcelain)" ]; then
        fail "the working tree is dirty — CI builds the pushed ref, not this one"
    else
        ok "the working tree is clean"
    fi
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$BRANCH" != "main" ]; then
        fail "HEAD is on '$BRANCH', not main"
    else
        ok "HEAD is on main"
    fi
    HEAD_SHA="$(git rev-parse HEAD)"
    # `gh api`, not `fetch`: asking is enough, and a GET keeps this recipe's
    # read-only claim true. `git fetch origin main` writes FETCH_HEAD and,
    # under origin's wildcard refspec, moves refs/remotes/origin/main — a gate
    # that reports on the tree should not be editing it. `gh api` is also the
    # spelling that needs no SSH, and the idiom the tag check below now uses.
    if ! command -v gh >/dev/null 2>&1; then
        fail "gh not found — cannot compare HEAD against origin/main"
    else
        REMOTE_SHA="$(gh api 'repos/{owner}/{repo}/branches/main' --jq '.commit.sha' 2>/dev/null)"
        if [ -z "$REMOTE_SHA" ]; then
            fail "cannot reach origin to compare HEAD against origin/main"
        elif [ "$HEAD_SHA" != "$REMOTE_SHA" ]; then
            fail "HEAD ${HEAD_SHA:0:9} is not origin/main ${REMOTE_SHA:0:9} — push before releasing"
        else
            ok "HEAD is pushed and equals origin/main"
        fi
    fi
    #
    # 4. This version is not already published. release.yml checks the second
    #    of these itself, but only after a run has been queued and the
    #    keychain built; asking here costs a second.
    #
    #    Three outcomes, never two: `git ls-remote --tags` returned empty both
    #    when the tag was absent and when origin was unreachable, so the row
    #    read `ok` on a dead network. The `gh api` ref read distinguishes them
    #    — exit 0 is present, an HTTP 404 in the error is absent, and anything
    #    else is unknown and says so.
    if ! command -v gh >/dev/null 2>&1; then
        fail "gh not found — cannot check for tag v$VERSION on origin"
    else
        TAG_ERR="$(gh api "repos/{owner}/{repo}/git/ref/tags/v$VERSION" 2>&1 >/dev/null)"; TAG_RC=$?
        if [ "$TAG_RC" -eq 0 ]; then
            fail "tag v$VERSION already exists on origin — bump the version first"
        elif printf '%s' "$TAG_ERR" | grep -q "HTTP 404"; then
            ok "no v$VERSION tag on origin"
        else
            fail "cannot reach origin to check for tag v$VERSION"
        fi
    fi
    if command -v gh >/dev/null 2>&1; then
        ASSETS="$(gh release view updates --json assets --jq '.assets[].name' 2>/dev/null || true)"
        if printf '%s\n' "$ASSETS" | grep -qx "Tug-$VERSION.zip"; then
            fail "Tug-$VERSION.zip is already on the 'updates' release — bump the version first"
        else
            ok "Tug-$VERSION.zip is not published yet"
        fi
        # `.[]` rather than `.[0]`: an empty array yields no line at all,
        # where `.[0]` would render the string "null/null null".
        CI_STATE="$(gh run list --workflow ci.yml --commit "$HEAD_SHA" --limit 1 --json status,conclusion,url --jq '.[] | "\(.status)/\(.conclusion) \(.url)"' 2>/dev/null || true)"
        if [ -z "$CI_STATE" ]; then
            note "no ci.yml run recorded for ${HEAD_SHA:0:9} (reported, not required)"
        else
            note "ci.yml on ${HEAD_SHA:0:9}: $CI_STATE (reported, not required)"
        fi
    else
        note "gh not found — skipped the published-version and CI checks"
    fi
    #
    echo
    if [ "$FAILED" -ne 0 ]; then
        echo "NOT blessed — fix the FAIL lines above."
        exit 1
    fi
    # The last thing seen before a dispatch is the thing being shipped.
    echo "Blessed:"
    echo "  version          $VERSION"
    echo "  CFBundleVersion  $BUNDLE"
    echo "  commit           $(git log -1 --format='%h %s')"
    echo
    echo "  $NOTES"
    sed 's/^/  | /' "$NOTES" | head -20
    echo
    echo "bless is read-only: nothing was built, signed or dispatched."
    exit 0

# Cut a release. One command that knows the order the other release recipes
# go in — scripts/release.py — and asks before every command that changes
# state. The script probes where the release already stands, runs `just lint`
# as a gate, works out which step is next, and walks bump → draft the notes →
# show them → commit → push → wait for CI → bless → dispatch → watch, printing
# the exact command and asking Y/n (default Y) each time — running this is the
# decision to release, so Enter goes on and n is the deliberate answer.
# Read-only probes and gates run without asking.
#
# CI on the pushed commit gates the dispatch. release.yml builds the app and
# ci.yml runs the tests and lints, so a release run can be green over a commit
# CI fails; 0.8.16 shipped that way, dispatched before CI had answered. bless only
# reports CI, because an arbitrary HEAD may have no run; the release walk has
# just pushed, so its HEAD always does, and it waits for that run to finish.
#
# A version number names a build that worked. When the probe finds the current
# version already published from a commit CI failed, the next step is to
# retract it — delete the tag, the release and its archive on the update feed
# — and release the same version again, with release-notes/<version>.md as
# written, from the fixed commit. Bumping past it would strand those notes on
# a build nobody should have. `--redo` asks for the retraction even over a
# green CI. Nothing is deleted until the replacement is pushed and green, so
# the feed's dead-link window is only the release build itself.
#
# The lint gate comes before anything changes, and before the bump rather than
# beside the blessing, because `just lint` is what CI's format and clippy jobs
# run: a tree that fails it is a tree whose release build is already doomed,
# and catching that here costs a minute where catching it from a red CI run
# costs a published version and a second commit on main to repair the first.
# It is a precondition rather than a step, so it runs on every invocation
# including a resume.
#
# It composes the recipes beside it rather than replacing them: version-bump,
# release-notes and bless are untouched and are what it calls, and the watch
# is scripts/watch-release-run.sh. The one thing it adds is a single
# tool-less `claude -p` call that drafts release-notes/<version>.md from the
# commits since the last release; the model never touches the tree, and
# written notes are never drafted over.
#
# Every step is idempotent and the run is resumable. Declining a row ends the
# run, and running the same command again picks up from the probe — so n is
# never a dead end, and an abandoned bump or a release already in flight is
# continued rather than started over.
#
# There is deliberately no local release path: CI is the reproducible one and
# the one whose credential handling has been thought about, and a second
# implementation of signing, notarizing, appcast generation and asset upload
# would be a second thing to keep correct.
#
# The blessing and the CI gate block rather than warning, because a gate that
# warns is a gate that is read past. `--force` dispatches over either, and it
# exists because a checklist this young will be wrong about something — the
# right answer to a wrong check is to ship and then fix the check, not to
# delete the gate. The escape lives on this composed gesture only; `just
# bless` on its own stays a pure query with no flags at all.
#
# `--dry-run` prints every row and runs none. `--redo` re-releases the current
# version (see above). Anything else on the line is emphasis for the notes
# draft: `just release patch emphasise the update pill`.
#
# Walk a release: bump, notes, commit, push, CI, bless, dispatch, watch (Y/n each).
release *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    exec python3 scripts/release.py {{ARGS}}

# Watch the update pill without publishing anything. Resolves the Release
# bundle out of DerivedData (building one if there is none), stands up the
# local signed feed through tests/update/local-appcast.sh, and runs that
# bundle under TUG_SPARKLE_FEED — which is the only way to see the pill and
# the popover before two releases exist, since Sparkle offers an update only
# to an installed app already polling a feed.
#
# It quits the cwd-derived release instance first, through the same
# quit-tug-bundle.sh that `just app-release` and `just launch-release`
# already call. Every recipe in the release lane quits before it launches;
# a rehearsal that refused to would leave the user doing by hand the one
# thing all of its neighbours do for them.
#
# "If one is not current" is read as "if one is not there". Deciding whether
# an Xcode bundle is stale is xcodebuild's job, not this recipe's, so a
# bundle that exists is reported with its build time and the call is left to
# you — `just app-release` rebuilds.
#
# The app is run directly rather than through `open`, the way
# local-appcast.sh's own printed instruction does: that spelling is the one
# that certainly hands TUG_SPARKLE_FEED to the process, and it puts the
# "UpdateController: <stage>" lines in this terminal, which is the thing
# being watched. The cost is that ^C ends the whole rehearsal — feed,
# scratch directory and app together.
#
# A rate in kilobytes per second throttles the archive so the download can be
# watched, and paused and resumed by hand ([B14] of the wizard-downloads
# brief); 0 serves at loopback speed.
#
# Stand up a local signed feed and run the app against it (watch the pill).
update-rehearse PORT="8765" RATE="0":
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh release)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    APP_DIR="$(bash tugrust/scripts/derived-data-path.sh release)/Build/Products/Release/${PRODUCT_NAME}.app"
    if [ ! -d "$APP_DIR" ]; then
        echo "==> No Release bundle at $APP_DIR — building one"
        just app-release
    else
        echo "==> Release bundle: $APP_DIR"
        echo "    built $(date -r "$APP_DIR" '+%Y-%m-%d %H:%M') — run 'just app-release' first if that predates your work"
    fi
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"
    echo "==> Quitting $INSTANCE_ID, if running"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    FEED_URL="http://127.0.0.1:{{PORT}}/appcast.xml"
    # The feed clones, re-signs and archives a ~90 MB bundle before it serves
    # anything, so this takes a minute. It has to be answering before the app
    # starts: automatic checks are on, and a check against a dead port is an
    # error alert rather than a pill.
    bash tests/update/local-appcast.sh "$APP_DIR" "{{PORT}}" "{{RATE}}" &
    FEED_PID=$!
    echo "==> Waiting for $FEED_URL"
    for _ in $(seq 1 300); do
        if /usr/bin/curl -fsS "$FEED_URL" >/dev/null 2>&1; then break; fi
        if ! kill -0 "$FEED_PID" 2>/dev/null; then
            echo "error: the feed exited before it came up — see its output above" >&2
            exit 1
        fi
        sleep 1
    done
    if ! /usr/bin/curl -fsS "$FEED_URL" >/dev/null 2>&1; then
        echo "error: $FEED_URL never came up" >&2
        kill "$FEED_PID" 2>/dev/null || true
        exit 1
    fi
    echo "==> Launching $INSTANCE_ID under TUG_SPARKLE_FEED=$FEED_URL"
    echo "    Drive it from the app: check for updates, then watch the pill and"
    echo "    its popover. Every transition logs as 'UpdateController: <stage>'."
    echo "==> ^C ends the rehearsal — feed, scratch directory and app together."
    # Scrub the launching instance's env, through the same shared list every
    # other launch in this file goes through. TUG_SPARKLE_FEED is set for
    # this launch and is not on it.
    TUG_SPARKLE_FEED="$FEED_URL" \
        bash tugrust/scripts/launch-scrubbed.sh \
        "$APP_DIR/Contents/MacOS/$PRODUCT_NAME" &
    wait "$FEED_PID" || true

# Generate the Sparkle appcast for a release archive. This is the rare one:
# the CI release path runs make-appcast.sh itself, with the signing key in
# the environment, so reaching for this by hand means inspecting what a feed
# would advertise or regenerating one outside a release. Nothing here is a
# second implementation — the script is the implementation, and every
# argument goes straight through to it.
#
# With SPARKLE_ED_PRIVATE_KEY set the feed is signed with it; unset, the
# script signs with the login-Keychain key that `generate_keys` wrote. Output
# defaults to products/appcast.xml.
#
#   just appcast products/Tug-0.8.0.zip
#   just appcast --notes notes.md products/Tug-0.8.0.zip /tmp/appcast.xml
#
# Generate the Sparkle appcast for a release archive (CI runs its own).
appcast *ARGS:
    tugrust/scripts/make-appcast.sh {{ARGS}}

# Build a Tug.dmg and stage it on the external VM-lab disk for the
# share-into-guest step (`lab-run <run> --dir=drop:/Volumes/Lab-A/share`).
# Default mode is the canonical signed+notarized build (installs like a
# real customer download on a clean VM). Pass `unsigned` for the fast
# variant — Gatekeeper will block it on a fresh guest, so bypass with a
# right-click → Open inside the VM.
#
#   just lab-dmg            # signed + notarized
#   just lab-dmg unsigned   # fast, unsigned
#
# Override the staging dir with LAB_SHARE=/some/path.
#
# Build Tug.dmg and stage it on the VM-lab disk (MODE: notarized|unsigned).
lab-dmg MODE="notarized":
    #!/usr/bin/env bash
    set -euo pipefail
    LAB_SHARE="${LAB_SHARE:-/Volumes/Lab-A/share}"
    LAB_ROOT="$(dirname "$LAB_SHARE")"
    if [ ! -d "$LAB_ROOT" ]; then
        echo "error: VM-lab disk not mounted (missing $LAB_ROOT)" >&2
        exit 1
    fi
    case "{{MODE}}" in
        notarized) tugrust/scripts/build-app.sh ;;
        unsigned)  tugrust/scripts/build-app.sh --skip-sign --skip-notarize ;;
        *) echo "unknown mode: {{MODE}} (use 'notarized' or 'unsigned')" >&2; exit 1 ;;
    esac
    mkdir -p "$LAB_SHARE"
    cp -f products/Tug.dmg "$LAB_SHARE/Tug.dmg"
    # A marker left by a prior `lab-release-dmg` would now name a release these
    # bytes did not come from.
    rm -f "$LAB_SHARE/Tug.dmg.release"
    echo "==> staged for the VM lab: $LAB_SHARE/Tug.dmg"
    ls -lh "$LAB_SHARE/Tug.dmg"

# Download a *published* Tug.dmg and stage it on the VM-lab disk — the exact
# bytes a first-install customer downloads, signed and notarized, so a clean
# guest installs it without the right-click -> Open bypass an unsigned local
# build needs. That bypass is the one thing a lab run must never rehearse.
#
#   just lab-release-dmg          # newest stable v* release
#   just lab-release-dmg 0.7.2    # a pinned version (leading 'v' optional)
#
# Override the staging dir with LAB_SHARE=/some/path.
#
# Download a published Tug.dmg and stage it on the VM-lab disk (default: newest stable).
lab-release-dmg VERSION="":
    #!/usr/bin/env bash
    set -euo pipefail
    LAB_SHARE="${LAB_SHARE:-/Volumes/Lab-A/share}"
    LAB_ROOT="$(dirname "$LAB_SHARE")"
    if [ ! -d "$LAB_ROOT" ]; then
        echo "error: VM-lab disk not mounted (missing $LAB_ROOT)" >&2
        exit 1
    fi
    if ! command -v gh >/dev/null 2>&1; then
        echo "error: gh is not installed — it is how a release is fetched (brew install gh)" >&2
        exit 1
    fi
    # No argument means the newest stable release: bare `gh release view`
    # resolves the one GitHub marks Latest, which skips the `updates` and
    # `nightly` prereleases. A pinned version is the v<version> tag.
    WANT='{{VERSION}}'
    if [ -n "$WANT" ]; then
        TAG="v${WANT#v}"
    else
        TAG="$(gh release view --json tagName -q .tagName)"
    fi
    echo "==> downloading Tug.dmg from release $TAG"
    mkdir -p "$LAB_SHARE"
    gh release download "$TAG" --pattern Tug.dmg --dir "$LAB_SHARE" --clobber
    # Record which release is sitting in the share. A cycle that boots the
    # wrong dmg is otherwise indistinguishable from one that boots the right
    # one, and the guest cannot tell you.
    printf '%s\n' "$TAG" > "$LAB_SHARE/Tug.dmg.release"
    echo "==> staged for the VM lab: $LAB_SHARE/Tug.dmg ($TAG)"
    ls -lh "$LAB_SHARE/Tug.dmg"

# VM-lab (Tart) recipes — thin wrappers over scripts/lab/*, vendored into the
# repo from the former /Volumes/Lab-A/bin copies (now a stale mirror). LAB_ROOT
# (default /Volumes/Lab-A) and TART_HOME (default $LAB_ROOT/tart) parameterize
# the lab disk so the workflow rides version-controlled tooling, not disk-local
# one-offs.
#
#   just lab-ls                        # bases + runs + lab-disk free space
#   just lab-new sequoia [run]         # clone base-sequoia -> run-<run>
#   just lab-run <run> [tart flags]    # boot a run (e.g. --dir=drop:$LAB_SHARE)
#   just lab-wipe <run> | --all        # delete throwaway run(s); bases untouched

# List golden bases, throwaway runs, and lab-disk free space.
lab-ls:
    scripts/lab/lab-ls

# Clone a golden base into a throwaway run (lab-new <base> [run]).
lab-new *ARGS:
    scripts/lab/lab-new {{ARGS}}

# Boot a run VM; extra args pass through to `tart run`.
lab-run *ARGS:
    scripts/lab/lab-run {{ARGS}}

# Delete a throwaway run (lab-wipe <run> | --all); golden bases untouched.
lab-wipe *ARGS:
    scripts/lab/lab-wipe {{ARGS}}

# The one reliable inner loop ([P02]): stage a Tug.dmg on the lab share, wipe
# any prior run for this OS, clone a fresh factory-fresh guest, and boot it
# with the share mounted — in one command. There is deliberately NO
# install-into-running-VM path: VirtioFS caching + a stale /Applications/Tug.app
# make reinstall-in-place unreliable, so every cycle boots a fresh clone. The
# run for OS <x> is run-<x> (replacing the prior one).
#
# SOURCE decides where that dmg comes from, and the default is `release`: a
# clean guest is where a *shipped* build earns its trust, and only the
# signed + notarized release installs the way a customer's does. `local` is the
# working-tree unsigned build — faster, but Gatekeeper blocks it on a fresh
# guest, so it needs a right-click -> Open that proves nothing about the real
# install. Reach for it when the change under test is not yet released.
#
#   just lab-cycle sequoia                  # newest stable release
#   just lab-cycle sequoia release 0.7.2    # a pinned release
#   just lab-cycle sequoia local            # this working tree, unsigned
#
# Inside the booted guest, the dmg appears at:
#   /Volumes/My Shared Files/drop/Tug.dmg
# Stage a dmg (released by default), then boot a fresh clone with it mounted (the inner loop).
lab-cycle OS="sequoia" SOURCE="release" VERSION="":
    #!/usr/bin/env bash
    set -euo pipefail
    # Export so the nested lab-dmg recipe and scripts/lab/* honor overrides.
    export LAB_SHARE="${LAB_SHARE:-/Volumes/Lab-A/share}"
    export LAB_ROOT="${LAB_ROOT:-/Volumes/Lab-A}"
    [ -n "${TART_HOME:-}" ] && export TART_HOME
    if [ ! -d "$LAB_ROOT" ]; then
        echo "error: VM-lab disk not mounted (missing $LAB_ROOT)" >&2
        exit 1
    fi
    case "{{SOURCE}}" in
        release)
            echo "==> [1/4] Download + stage the released Tug.dmg -> $LAB_SHARE"
            just lab-release-dmg '{{VERSION}}'
            ;;
        local)
            if [ -n "{{VERSION}}" ]; then
                echo "error: a VERSION only means something with SOURCE=release" >&2
                exit 1
            fi
            echo "==> [1/4] Build + stage unsigned Tug.dmg -> $LAB_SHARE"
            just lab-dmg unsigned
            ;;
        *)
            echo "unknown source: {{SOURCE}} (use 'release' or 'local')" >&2
            exit 1
            ;;
    esac
    echo "==> [2/4] Wipe any prior run-{{OS}} (fresh-clone discipline)"
    scripts/lab/lab-wipe {{OS}} || true
    echo "==> [3/4] Clone a fresh run-{{OS}} from base-{{OS}}"
    scripts/lab/lab-new {{OS}}
    echo "==> [4/4] Boot run-{{OS}} with the share mounted"
    echo "    In the guest, install from: /Volumes/My Shared Files/drop/Tug.dmg"
    exec scripts/lab/lab-run {{OS}} --dir=drop:"$LAB_SHARE"

# One-time per-machine signing check. Verifies that an Apple
# Developer ID Application certificate is installed in the login
# keychain (the identity every Tug build signs with per [D11]).
# Prints actionable instructions if the cert is missing — the
# install is a one-click flow via Xcode → Settings → Accounts.
#
# Idempotent: prints success and exits 0 when the cert is present.
#
# Renamed-in-spirit: this used to provision a self-signed `Tug Dev`
# cert via openssl. Real Developer ID certs have stable designated
# requirements (signed by Apple), so TCC Accessibility grants
# persist across rebuilds without a fragile self-signed shim.
# Verify a Developer ID Application cert is installed (one-time per machine).
setup-dev-signing:
    scripts/setup-dev-signing.sh

# Clear the per-machine code-sign drift sentinel. Use this if the
# `code-sign-fingerprint` file ever gets out of sync (e.g. after
# manually re-issuing the Developer ID cert in Xcode).
#
# The sentinel lives in the per-project runtime-state dir (out of the
# repo), resolved via `tugtool host state-dir`.
#
# Does NOT touch the Developer ID cert in the login keychain — that's
# the user's Apple-issued identity, not project-specific.
#
# Idempotent: reports "nothing to remove" and exits 0 if the
# sentinel doesn't exist.
# Clear the per-machine code-sign drift sentinel.
teardown-dev-signing:
    #!/usr/bin/env bash
    set -euo pipefail
    SENTINEL_FILE="$(tugtool host state-dir 2>/dev/null || tugrust/target/debug/tugtool host state-dir)/code-sign-fingerprint"
    if [ -f "$SENTINEL_FILE" ]; then
        rm -f "$SENTINEL_FILE"
        echo "✓ Sentinel $SENTINEL_FILE cleared."
    else
        echo "Sentinel not present ($SENTINEL_FILE); nothing to remove."
    fi
    echo
    echo "Note: the Developer ID Application cert in the login keychain"
    echo "      is intentionally preserved. To remove it, use Keychain"
    echo "      Access manually (it's your Apple-issued identity, not a"
    echo "      project-scoped self-signed cert)."
    echo
    echo "Next: 'just build-app' will rebuild the sentinel on first run."

# Build the app-test bundle (Debug) end-to-end: Rust debug binaries,
# tugdeck deps + production dist, app-test deps, xcodebuild, and a
# re-sign with the user's Developer ID Application identity (per [D11])
# so the designated requirement is stable across rebuilds and the
# Accessibility grant persists. After this finishes, run `just app-test`.
#
# Always builds the dedicated app-test identity (`dev.tugapp.app.apptest`
# → `Tug-apptest.app`) so the one-time AX grant from `just app-test-grant`
# always matches — no `TUG_FORCE_BUNDLE_ID=…` prefix to remember. The
# interactive dev/release bundles are built by `app-debug` / `app-release`,
# which own their own identities; this recipe is app-test only.
#
# Prereqs (one-time per machine):
#   just setup-dev-signing                 # verifies Developer ID cert
# Build the signed app-test bundle (stable bundle id) for 'just app-test'.
build-app:
    #!/usr/bin/env bash
    set -euo pipefail

    # Pin the app-test identity unless the caller forced another (e.g.
    # app-test-grant). This is the ONLY identity app-test ever uses.
    : "${TUG_FORCE_BUNDLE_ID:=dev.tugapp.app.apptest}"
    export TUG_FORCE_BUNDLE_ID

    # Verify the Developer ID Application identity is present. Without
    # it, the dev-loop AX grant story breaks (ad-hoc signing produces
    # per-build cdhash DRs, invalidating the grant on every rebuild).
    if ! security find-identity -v -p codesigning 2>/dev/null \
            | grep -q "Developer ID Application:"; then
        echo "error: Developer ID Application identity not found in login keychain." >&2
        echo "       Run: just setup-dev-signing" >&2
        exit 1
    fi
    SIGNING_IDENTITY="$(
        security find-identity -v -p codesigning 2>/dev/null \
            | awk -F'"' '/Developer ID Application:/ {print $2; exit}'
    )"

    # Each phase also reports to the calling Session card's running block, so
    # a `just app-test` that rebuilds first does not sit silent for minutes.
    # The block draws the build as its five phases: those landed with their
    # times, the one running since when, the rest to come. `report phase`
    # keeps the phase state and builds the rows; this writes one line each.
    PHASES=("Rust debug binaries" "tugdeck build" "app-test deps" "Xcode build" "re-sign")
    report_phase() {
        bash tugrust/scripts/report-phase.sh build-app "$1" ${PHASES[$1]:+"${PHASES[$1]}"} \
            --of "${PHASES[@]}" --needle "just app-test"
    }

    echo "==> [1/5] Rust debug binaries"
    report_phase 0
    (cd tugrust && cargo build -p tugcast -p tugexec -p tugtool -p tugrelaunch -p tugbank)
    bash tugrust/scripts/compile-tugcode.sh tugrust/target/debug/tugcode

    echo "==> [2/5] tugdeck deps + prebuilt dist"
    report_phase 1
    (cd tugdeck && bun install && bun run build)

    echo "==> [3/5] tests/app-test deps"
    report_phase 2
    (cd tests/app-test && bun install)

    # PRODUCT_NAME names the built `.app` per variant (Tug-apptest under
    # TUG_FORCE_BUNDLE_ID=…apptest) so each variant is its own bundle file
    # that never clobbers or re-signs another. Matches bundle-id-from-cwd.sh.
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh debug)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    # Per-variant derivedDataPath isolates this build from the interactive
    # app-debug build (and every other variant): they no longer share one
    # DerivedData and so never clobber each other's `.app`.
    DERIVED="$(bash tugrust/scripts/derived-data-path.sh debug)"
    echo "==> [4/5] Build ${PRODUCT_NAME}.app (Debug)"
    report_phase 3
    find tugapp/Sources -name '*.swift' -exec touch {} +
    bash tugrust/scripts/xcodebuild-quiet.sh "${PRODUCT_NAME}.app (Debug)" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug \
        -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DERIVED" build
    APP_DIR="$DERIVED/Build/Products/Debug/${PRODUCT_NAME}.app"
    APP_BIN="$APP_DIR/Contents/MacOS/${PRODUCT_NAME}"
    [ -x "$APP_BIN" ] || { echo "${PRODUCT_NAME}.app binary missing: $APP_BIN"; exit 1; }

    # Re-sign inside-out with Developer ID per [D16]. The script
    # walks the bundle, signs each Rust helper with default hardened
    # runtime, signs tugcode with the bun-permissive entitlements,
    # then seals the outer .app with Tug.entitlements. `--deep` is
    # intentionally absent — see tugrust/scripts/sign-bundle.sh.
    echo "==> [5/5] Re-sign inside-out with Developer ID"
    report_phase 4
    bash tugrust/scripts/sign-bundle.sh "$APP_DIR" "$SIGNING_IDENTITY"
    report_phase 5

    # Capture the bundle's designated requirement (DR) into a
    # sentinel so subsequent `app-test` runs can detect drift. Under
    # Developer ID signing the DR is stable across rebuilds (signed
    # by an Apple intermediate), so this is now belt-and-suspenders
    # rather than load-bearing — but the comparison still catches
    # the case where someone replaces the Developer ID cert in the
    # keychain and the new cert produces a different DR string.
    #
    # `sed -nE 's/^#?[[:space:]]*designated[[:space:]]+=>[[:space:]]+(.*)$/\1/p'`
    # tolerates both the `# designated => ...` form (ad-hoc) and the
    # `designated => identifier "..." and anchor apple generic ...`
    # form (Developer ID).
    SENTINEL_DIR="$(tugtool host state-dir 2>/dev/null || tugrust/target/debug/tugtool host state-dir)"
    SENTINEL_FILE="${SENTINEL_DIR}/code-sign-fingerprint"
    CURRENT_DR="$(codesign -d -r- "$APP_DIR" 2>&1 | sed -nE 's/^#?[[:space:]]*designated[[:space:]]+=>[[:space:]]+(.*)$/\1/p' | head -1)"
    if [ -z "$CURRENT_DR" ]; then
        echo "warn: could not extract designated requirement; skipping fingerprint capture" >&2
    else
        mkdir -p "$SENTINEL_DIR"
        SENTINEL_TMP="$(mktemp "${SENTINEL_DIR}/code-sign-fp.XXXXXX")"
        printf '%s\n' "$CURRENT_DR" > "$SENTINEL_TMP"
        mv "$SENTINEL_TMP" "$SENTINEL_FILE"
        echo "    Sentinel: $SENTINEL_FILE"
    fi

    echo "    ${PRODUCT_NAME}.app binary: $APP_BIN"
    echo
    echo "==> Built. Now run 'just app-test' to run tests."

# Run app-tests by name: build-if-needed, then run the given files.
#
# NOT the everyday command — that's `just app-test-changed`, which
# derives its selection from your diff via each test's `@covers` header.
# Reach for `app-test` when you already know which files you want, and
# for the no-argument CORE tier (~20 tests, one per load-bearing
# surface) when you want a fast broad read on the app's health. The
# core tier is deliberately NOT everything: `just app-test-all` runs
# every file.
#
# Builds the dedicated app-test bundle (`dev.tugapp.app.apptest` →
# Tug-apptest.app) ONLY when it's missing, then launches each test file
# as its own Tug.app subprocess via `launchTugApp`. Output streams
# per-file; the last line is exactly `VERDICT: PASS` / `VERDICT: FAIL`
# (recipe exit code matches, greppable via `tail -n 1`).
#
# Fully isolated from your interactive instances AND from other
# worktrees: the bundle has its own identity, its own per-worktree
# DerivedData (so a build here never clobbers a live `app-debug`
# bundle or another worktree's app-test bundle), its own port window /
# sockets / private tmux server, and `apptest-<wtslug>-<uuid>`
# per-launch runtime state whose destructive sweeps match only this
# worktree's prefix. Whole invocations are serialized machine-wide by
# a port gate (`tugtool host gate --name apptest`) — native input and app
# activation are login-session singletons, so only one app-test run
# ever drives them at a time; a second invocation queues with a
# visible "held by <worktree>" message. AX is granted once via
# `just app-test-grant` and covers every worktree's bundle (the TCC
# grant keys on the path-independent designated requirement).
#
# Prereq (one-time per machine): `just setup-dev-signing`.
#
# Usage:
#   just app-test-changed                          # <- the everyday command
#   just app-test                                  # the ~20-test core tier
#   just app-test at0001-tab-switch-fc.test.ts     # one file (bare name or repo path)
#   just app-test harness-smoke/smoke.test.ts at0003-pane-activation.test.ts
#   just app-test-all                              # every test file
#
# Changed Swift / Rust / harness source? `app-test` only builds when the
# bundle is ABSENT — use `just app-test-build` to force a fresh build.
#
# Tests run in the BACKGROUND and leave your machine alone. They start
# immediately and never wait for you.
#
# The few whose subject is activation itself declare `@foreground` and really do
# take over the screen. When a run contains any of those, it raises the question
# in the Session card right away, runs every background test while you decide,
# and saves the screen-takers for last — so by the time the answer matters, it
# is usually already in. Declining skips them; the background run has already
# happened either way.
#
# The question is a chance to intervene, not a gate: it counts thirty seconds
# down and then runs them. Say no while it counts (Escape says it at once) and
# it skips them. Nobody there to say no means nobody there to disturb, and a
# run must not sit parked in a dialog because you stepped away.
#
# Set TUG_APPTEST_ASSUME to answer ahead of time and raise nothing:
#
#   TUG_APPTEST_ASSUME=all         run everything, screen-takers included
#   TUG_APPTEST_ASSUME=background  skip the screen-takers, keep working
#   TUG_APPTEST_ASSUME=cancel      run nothing at all
#
# Scripted and non-interactive runs should set it. With no Tug instance to ask,
# a run proceeds after naming the tests that will take the screen — blocking a
# terminal-only run that could never show a dialog is worse.
#
# Build the app-test bundle if missing, then run the given files (core tier if none).
app-test *FILES:
    #!/usr/bin/env bash
    exec tests/app-test/scripts/app-test.sh {{FILES}}

# Run the app-tests that cover your working diff.
#
# Every `*.test.ts` declares the source it exercises with `@covers`
# lines in its header docblock. This recipe reads the changed files out
# of `git status`, resolves them through those declarations, prints the
# selection with the changed file that pulled each test in, and runs
# exactly that set. This — not `just app-test` — is the everyday
# command: it names what it is testing and why.
#
#   just app-test-changed                        # from the working diff
#   just app-test-changed tugdeck/src/components/cards/cards-card.tsx   # from explicit paths
#
# A few paths run before any test's first assertion (the harness, the deck
# entry point), so no `@covers` line can scope them; the selector prints a
# CORE TIER ADVISED advisory in that case, and `just app-test` — the ~20-file
# core tier — is the honest answer to it.
#
# Run the app-tests whose @covers match your working diff.
app-test-changed *PATHS:
    #!/usr/bin/env bash
    set -uo pipefail
    FILES="$(cd tests/app-test && bun scripts/select-tests.ts {{PATHS}})"
    STATUS=$?
    if [ "$STATUS" -ne 0 ]; then
        echo "==> select-tests failed (status $STATUS)." >&2
        exit "$STATUS"
    fi
    if [ -z "$FILES" ]; then
        echo "==> no app-test covers the changed files — nothing to run."
        exit 0
    fi
    TUG_APPTEST_SELECTION=changed just app-test $FILES

# Print the app-test selection for the working diff without running it.
app-test-select *PATHS:
    @cd tests/app-test && bun scripts/select-tests.ts --print {{PATHS}}

# Reach for this when a harness or app-shell change invalidates
# coverage-based selection, or before landing substantial work.
#
# Every app-test file, in run order. Slow — one Tug.app launch per file.
app-test-all:
    #!/usr/bin/env bash
    set -uo pipefail
    FILES="$(cd tests/app-test && { ls harness-smoke/*.test.ts | sort; ls *.test.ts | sort; ls body-grounding/*.test.ts | sort; })"
    TUG_APPTEST_SELECTION=all just app-test $FILES

# Every app-test file, on a deck instrumented to record which named functions
# each test executes. The one recipe besides `app-test-all` that runs more than
# twenty files: it IS `app-test-all`, with `TUG_APPTEST_REACH=1` so the run's own
# dist refresh instruments the deck and each passing file's reach map lands in
# the results ledger, where `app-test-changed` ranks by it. The instrumentation
# costs frames (tuglaws/app-test-harness.md), so frame-sensitive files may go
# red here and only green files' maps are recorded. A sweep by design — run it
# on purpose, never as a selection.
app-test-reach:
    #!/usr/bin/env bash
    set -uo pipefail
    FILES="$(cd tests/app-test && { ls harness-smoke/*.test.ts | sort; ls *.test.ts | sort; ls body-grounding/*.test.ts | sort; })"
    TUG_APPTEST_REACH=1 TUG_APPTEST_SELECTION=reach just app-test $FILES

# Print each test's executed share of the modules it covers, from the recorded
# reach maps, and the tests that execute nearly everything they cover.
app-test-reach-report *FILES:
    @cd tests/app-test && bun scripts/select-tests.ts --reach {{FILES}}

# An unannotated test can never be selected by `app-test-changed`, so it
# silently stops guarding its surface — this is the guard against that
# drift, along with a check that every @covers path still resolves.
#
# Lint the @covers declarations across every app-test file.
app-test-covers-check:
    @cd tests/app-test && bun scripts/select-tests.ts --check

# A card that is a body keeps its DOM in its own page, so a test reaches it
# only through `app.body(cardId)`. This lists every app-test call that still
# evaluates a card selector in the shell's page and fails on one whose
# {file, kind} pair `tests/app-test/scripts/card-dom-allow.json` does not
# allow; the list shrinks as each kind becomes a body.
app-test-body-scope-check:
    @cd tests/app-test && bun scripts/card-dom-census.ts --check

# A test that takes the screen declares it with `@foreground`; the app-test
# recipe reads that declaration before it launches anything, so it can warn
# before a run seizes the machine. The declaration is only worth trusting if
# it matches behavior, which is what this checks — in both directions. An
# untagged `foreground: true` seizes the screen unannounced; a tag with no
# such launch prompts about a test that was never disruptive.
app-test-foreground-check:
    @cd tests/app-test && bun scripts/select-tests.ts --foreground-check

# Score the SharedAgent's session descriptions against a RUNNING instance.
#
# Frozen digests go over the control socket to the live app, so what gets
# scored is the shipped prompt + the Haiku worker + the synopsis register
# together — the one sentence a session row actually wears. On-demand, not part
# of `just test`: it needs an instance up, and it spends subscription tokens.
#
# Run it after touching `SYNOPSIS_INSTRUCTIONS` in
# `tugrust/crates/tugcast/src/shared_agent.rs` or `synopsis_register_report` in
# `feeds/session_synopsis.rs` — both change what a session says about itself,
# and neither has a unit test that can tell you whether the wording got better.
#
#   just app-debug          # then, once it is up:
#   just model-eval
#   just model-eval release-main
model-eval INSTANCE="debug-main":
    @python3 tests/model-eval/run.py {{INSTANCE}}

# Score shell routing against a RUNNING instance: did that line mean the shell?
#
# The one agent harness with ground truth, so unlike `model-eval` it is a
# gate rather than a rate — and the gate is one-sided. It fails only on a false
# SHELL, the verdict that already ran a command nobody asked for; a command sent
# to Claude instead costs one keystroke and is reported without failing.
#
# Run it after touching `CLASSIFY_INSTRUCTIONS` or the `verdict` parse in
# `tugrust/crates/tugcast/src/shared_agent.rs`, or `shell-line-classifier.ts`.
#
#   just model-classify
#   just model-classify release-main
model-classify INSTANCE="debug-main":
    @python3 tests/model-eval/classify.py {{INSTANCE}}

# Is the live SharedAgent path answering, and inside its ceiling?
#
# On-demand, not CI: it needs a running instance and it spends subscription
# tokens. Without an instance it skips with exit 0 and names the remedy. Asks
# nothing about what the description says — that is `just model-eval`'s question.
#
#   just model-liveness
#   just model-liveness release-main
model-liveness INSTANCE="debug-main":
    @python3 tests/model-eval/liveness.py {{INSTANCE}}

# What accumulated logs say about the SharedAgent: how fast, how often it
# fails, how often the register normalizer had to step in, and how often the
# grounding gate refused a description. Reads both log files in the instance's
# Logs directory; the numbers are only as good as the usage behind them.
#
#   just model-stats
#   just model-stats release-main
model-stats INSTANCE="debug-main":
    @python3 tests/model-eval/analyze.py {{INSTANCE}}

# Force a fresh app-test build, then run the files you name. Use after
# changing Swift / Rust / harness source — `just app-test` only builds when
# the bundle is ABSENT, so it would otherwise run against a stale bundle. The
# build goes to the app-test variant's own DerivedData and never touches a
# live `app-debug` bundle.
#
#   just app-test-build                       # rebuild, and stop
#   just app-test-build at0003-pane-activation.test.ts  # rebuild + one file
#
# Name no files and it builds and stops. That is deliberate: this recipe's job
# is the bundle, and a run must never launch tests nobody asked for. The core
# tier is still exactly one sentence away — `just app-test` with no arguments.
# Force a fresh app-test build, then run the given files (none: build only).
app-test-build *FILES:
    #!/usr/bin/env bash
    set -euo pipefail
    export TUG_FORCE_BUNDLE_ID=dev.tugapp.app.apptest
    # build-app runs OUTSIDE the app-test gate, which is fine: it
    # targets this worktree's own per-worktree DerivedData, so it can
    # never clobber a bundle another worktree's gated run is executing.
    # The `just app-test` call below re-execs itself under the gate.
    just build-app
    if [ -z "{{FILES}}" ]; then
        echo "==> Named no files, so nothing ran. 'just app-test-changed' runs what your"
        echo "    working diff could have broken; 'just app-test' is the core tier."
        exit 0
    fi
    just app-test {{FILES}}

# One-time, reliable Accessibility grant for the app-test identity.
#
# macOS has no scripted way to grant Accessibility (the system TCC
# database is SIP-protected; `tccutil` only resets). Exactly one human
# gesture is required — but only ONCE, ever, because the grant is keyed
# on the bundle's designated requirement (identifier + team), which is
# path-independent. After this, every worktree build with the same
# TUG_FORCE_BUNDLE_ID inherits the grant, so unattended app-test runs
# (e.g. inside tugplug:implement) work without prompting.
#
# This builds the pinned-identity app, reveals it in Finder, and opens
# the Accessibility pane. Drag the revealed app into the list (or use
# "+"), and toggle it on. The entry is named "Tug-apptest" so it's
# distinct from the interactive "Tug" debug instance.
# One-time Accessibility grant for the app-test identity.
app-test-grant:
    #!/usr/bin/env bash
    set -euo pipefail
    export TUG_FORCE_BUNDLE_ID="${TUG_FORCE_BUNDLE_ID:-dev.tugapp.app.apptest}"
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh debug)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    echo "==> Building ${PRODUCT_NAME}.app pinned to $TUG_FORCE_BUNDLE_ID"
    just build-app
    APP_DIR="$(bash tugrust/scripts/derived-data-path.sh debug)/Build/Products/Debug/${PRODUCT_NAME}.app"
    echo "==> Revealing the app in Finder and opening the Accessibility pane"
    open -R "$APP_DIR"
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    echo
    echo "    One-time Accessibility grant:"
    echo "      1. In System Settings -> Privacy & Security -> Accessibility,"
    echo "         click \"+\" (or drag the Finder-highlighted ${PRODUCT_NAME}.app into the list)."
    echo "      2. Toggle \"${PRODUCT_NAME}\" ON."
    echo
    echo "    That's it -- forever. Every worktree build pinned to"
    echo "    $TUG_FORCE_BUNDLE_ID matches the same designated requirement"
    echo "    and inherits this grant."
    echo "      Verify with:  just app-test harness-smoke/smoke-native.test.ts"

# Three-file smoke: bridge basics + handshake + one AT scenario.
# Useful after a Swift / harness change or right after `just build-app`
# to confirm the pipeline still works without running the full sweep.
# Runtime ~20-30s (vs ~3min for the full sweep).
# Fast smoke: bridge + handshake + one AT scenario (~20-30s).
app-test-smoke: (app-test "harness-smoke/smoke.test.ts" "harness-smoke/version-handshake.test.ts" "at0001-tab-switch-fc.test.ts")

# Read the Overview a real session would have produced, at a cadence you choose.
#
# Cadence is a question about feel, and feel is not answerable from a desk.
# This replays a Claude Code transcript through the production wake core and
# the real `observer-post` job, then prints the channel as markdown: one
# section per wake, its reason and window size, and the post — or the silence.
#
# Read two or three cadences side by side rather than validating one:
#
#   just overview-replay ~/.claude/projects/<slug>/<id>.jsonl --no-model
#   just overview-replay ~/.claude/projects/<slug>/<id>.jsonl --sitrep-secs 120
#   just overview-replay ~/.claude/projects/<slug>/<id>.jsonl --sitrep-secs 180
#
# `--no-model` segments and reports without calling anything: free, instant,
# and the right first look — it answers how OFTEN the Observer would be asked,
# which is half the question, before you spend tokens on what it would say.
# A run without it spawns a real `claude` per wake, so it is deliberate work,
# not something to leave running.
#
# Other flags: --last-k, --max-frames, --token-wake-tokens, --model.
# Nothing here reads or writes tugbank, and the subcommand returns before any
# listener binds — a replay never contends with a live tugcast.
overview-replay JSONL *FLAGS:
    #!/usr/bin/env bash
    set -euo pipefail
    # Resolve before the cd, and expand a leading ~ ourselves: just substitutes
    # the argument as literal text, so the shell never gets a chance to.
    JSONL="{{JSONL}}"
    JSONL="${JSONL/#\~/$HOME}"
    JSONL="$(cd "$(dirname "$JSONL")" && pwd)/$(basename "$JSONL")"
    cd tugrust
    cargo build -p tugcast
    ./target/debug/tugcast overview-replay "$JSONL" {{FLAGS}}

# Remove the interactive debug build's per-variant DerivedData (matches
# `app-debug` — the cwd-derived debug variant, e.g. Tug-debug / Tug-worktree).
# Remove the interactive debug build's per-variant DerivedData.
clean-debug:
    #!/usr/bin/env bash
    set -euo pipefail
    unset TUG_FORCE_BUNDLE_ID
    rm -rf "$(bash tugrust/scripts/derived-data-path.sh debug)"

# Remove the interactive release build's per-variant DerivedData (matches
# `app-release`).
# Remove the interactive release build's per-variant DerivedData.
clean-release:
    #!/usr/bin/env bash
    set -euo pipefail
    unset TUG_FORCE_BUNDLE_ID
    rm -rf "$(bash tugrust/scripts/derived-data-path.sh release)"

# Clean the Rust workspace target dir (shared by debug + release)
clean-rust:
    cd tugrust && cargo clean

# Wipe every build artifact: ALL per-variant Xcode DerivedData (debug,
# release, apptest, worktree — plus the legacy shared per-project default)
# and the Rust target/.
# Wipe every build artifact: all per-variant DerivedData + the Rust target/.
clean-all: clean-rust
    #!/usr/bin/env bash
    set -euo pipefail
    DD="${HOME}/Library/Developer/Xcode/DerivedData"
    # Named per-variant dirs (Tug, Tug-debug, Tug-apptest, Tug-worktree, …)
    # plus the legacy shared `Tug-<projecthash>` default that predates the
    # per-variant split.
    rm -rf "$DD"/Tug "$DD"/Tug-* 2>/dev/null || true
    echo "cleaned all Tug DerivedData under $DD"
