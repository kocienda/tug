# Tugtool development commands

default:
    @just --list

# Build all Rust binaries + tugcode (Claude Code bridge), symlink to ~/.local/bin
build:
    #!/usr/bin/env bash
    set -euo pipefail
    cd tugrust && cargo build -p tugcast -p tugexec -p tugutil -p tugrelaunch -p tugbank
    cd ..
    bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode
    bun build --compile tugcode/src/pulse/main-pulse.ts --outfile tugrust/target/debug/tugpulse
    # Only the main checkout owns ~/.local/bin. A linked worktree (a dash under
    # .tug/worktrees/) builds its own ephemeral binaries; pointing the global
    # symlinks at them would dangle every tug* tool the moment the dash is torn
    # down. A linked worktree's --git-dir differs from its --git-common-dir.
    if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
        mkdir -p ~/.local/bin
        # The tug/tugdash/tugmark binaries are gone (tug is now tugutil;
        # tugdash/tugmark were folded in); drop any stale symlinks so they
        # don't dangle after this rebuild.
        rm -f ~/.local/bin/tug ~/.local/bin/tugdash ~/.local/bin/tugmark
        for bin in tugcast tugexec tugutil tugcode tugpulse tugrelaunch tugbank; do
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
test: test-rust test-ts

# Run Rust tests. `--no-fail-fast`: one pass names every failure, so a red
# gate is one round of fixing rather than one round per broken test.
test-rust:
    cd tugrust && cargo nextest run --workspace --no-fail-fast

# Run TypeScript tests (tugdeck frontend + tugcode bridge)
test-ts:
    cd tugdeck && bun test
    cd tugcode && bun test

# Regenerate every checked-in golden fixture from the code that produces it.
#
# A golden is DERIVED: retune a constant its producer reads and the file is
# stale by construction, which is a fact about the retune, not a test failure
# to be diagnosed. Each entry below pairs a golden with the one command that
# rebuilds it, so the knowledge lives here instead of in a test docstring
# nobody reads until the gate is already red. `fix` runs this, so the ordinary
# path regenerates goldens for you and shows the diff. Adding a new golden
# means adding its line here — an unlisted golden is one `just fix` cannot fix.
golden:
    cd tugdeck && IMPOSER_GOLDEN_UPDATE=1 bun test src/lib/__tests__/layout-imposer-solutions.test.ts

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

# Run clippy + fmt check
lint:
    cd tugrust && cargo clippy --workspace --all-targets -- -D warnings
    cd tugrust && cargo fmt --all -- --check

# Repair everything repairable, then run the full gate.
#
# `lint` only reports; this is the recipe that EDITS. It repairs in three
# passes, cheapest first — clippy's machine-applicable rewrites, formatting,
# then the derived goldens (`just golden`) — and only then runs `ci`. So a
# stale golden, which is arithmetic rather than a bug, is fixed on the way
# through instead of failing the gate with a 245-line diff to read.
#
# It rewrites files in place, so review the diff afterwards; when it changes
# a golden it says so and shows you which.
#
# What is left when this recipe still fails is, by construction, the part no
# tool can do: a lint clippy has no mechanical rewrite for (`large_enum_variant`,
# `if_same_then_else` — these want a judgment call about the code's shape), or
# a genuinely failing test. The recipe names which of the two before it stops.
fix:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{justfile_directory()}}"

    (cd tugrust && cargo clippy --fix --workspace --all-targets --allow-dirty --allow-staged)
    (cd tugrust && cargo fmt --all)

    just golden
    if ! git diff --quiet -- '*/__tests__/golden/*'; then
        echo
        echo "REGENERATED GOLDENS — a producer's constants moved. Review this diff:"
        git diff --stat -- '*/__tests__/golden/*'
        echo
    fi

    if ! just lint; then
        echo
        echo "STOPPED: lint failures survived --fix. These have no mechanical" >&2
        echo "rewrite; each one above needs a decision about the code's shape" >&2
        echo "(restructure it, or #[allow(...)] it with the reason)." >&2
        exit 1
    fi
    just test

# Full pre-merge gate (lint + test). `fix` runs these same two recipes rather
# than calling `ci`, so that it can speak between them; keep the pair in step.
ci: lint test

# Build every WASM crate under tugdeck/crates/ via scripts/build-wasm.sh.
# The script auto-discovers crates by globbing tugdeck/crates/*/Cargo.toml
# and normalizes pkg/.gitignore so the built artifacts can be committed
# without `git add -f`. See tuglaws/wasm-crates.md for the convention.
# Build every WASM crate under tugdeck/crates/.
wasm:
    scripts/build-wasm.sh

# Build the Mac app (with all dependencies), and run/restart it.
#
# Signing: after xcodebuild's ad-hoc signing, the recipe re-signs via
# tugrust/scripts/sign-bundle.sh — inside-out, per [D16] of
# roadmap/tug-multi-instance.md. This gives the dev bundle a stable
# designated requirement (signed by Apple Developer ID) so the AX
# grant persists across rebuilds. Without it, every rebuild would
# invalidate the grant.
#
# (Note: Step 15 of the multi-instance plan will retire this recipe
# in favor of `just app-debug`. Until then, this is the canonical
# debug loop.)
# ── Multi-instance recipe surface ────────────────────────────────────────────
#
# The debug/release axis (per [D17] of roadmap/tug-multi-instance.md,
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
    # Touch Swift sources so xcodebuild detects changes on this mount.
    find tugapp/Sources -name '*.swift' -exec touch {} +
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
    bash tugrust/scripts/xcodebuild-quiet.sh "${PRODUCT_NAME}.app (Debug)" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Debug \
        -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DERIVED" build
    APP_DIR="$DERIVED/Build/Products/Debug/${PRODUCT_NAME}.app"
    bash tugrust/scripts/sign-bundle.sh "$APP_DIR"
    # Non-blocking orphan-detection preamble so users get a nudge to
    # clean up bundle-less data dirs without ever failing the build.
    if tugrust/target/debug/tugutil host instance prune --json 2>/dev/null | grep -q instance_id; then
        echo "[warn] orphaned per-instance data dirs detected. Run 'tugutil host instance prune' to clean up." >&2
    fi
    # Seed the per-instance source-tree-path so the first launch knows
    # where to find tugdeck/, tugcode, etc. AppDelegate also falls
    # back to BuildInfo.sourceTree (capture-build-info.sh writes
    # $SRCROOT into Info.plist), but writing it explicitly here keeps
    # the user's chosen tree wins over any stale build-time value.
    tugrust/target/debug/tugbank --instance "$INSTANCE_ID" write dev.tugtool.app source-tree-path "$(pwd)" >/dev/null
    echo "==> Launching $INSTANCE_ID ($APP_DIR)"
    # Scrub the launching instance's identity/resource env: `open`
    # propagates the caller's environment, so a launch from inside a Dev
    # card would otherwise hand the new bundle the host's TUG_INSTANCE_ID.
    env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT open "$APP_DIR"

# Build a Release bundle and (re)launch the cwd-derived release
# instance. Quit-prior runs first for the same reason as app-debug.
# Build a Release bundle and (re)launch the cwd-derived release instance.
app-release: build wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # Dev loop = cwd-derived identity; the forced bundle id is app-test-only.
    unset TUG_FORCE_BUNDLE_ID
    INSTANCE_ID="$(bash tugrust/scripts/instance-id-from-cwd.sh release)"
    BUNDLE_ID="$(bash tugrust/scripts/bundle-id-from-cwd.sh release)"
    export TUG_PRODUCT_NAME="$(bash tugrust/scripts/product-name-from-cwd.sh release)"
    PRODUCT_NAME="$TUG_PRODUCT_NAME"
    echo "==> Quitting prior $INSTANCE_ID, if running"
    bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$INSTANCE_ID"
    # Compile the shared release inputs (Rust binaries, tugcode/tugpulse,
    # tugdeck assets) — the same script build-app.sh uses, so the developer
    # launch build and the distribution build can't drift on what they compile.
    # The xcodebuild copy phase reads these from tugrust/target/release/.
    bash tugrust/scripts/build-release-inputs.sh
    find tugapp/Sources -name '*.swift' -exec touch {} +
    DERIVED="$(bash tugrust/scripts/derived-data-path.sh release)"
    bash tugrust/scripts/xcodebuild-quiet.sh "${PRODUCT_NAME}.app (Release)" \
        -project tugapp/Tug.xcodeproj -scheme Tug -configuration Release \
        -destination 'platform=macOS,arch=arm64' -derivedDataPath "$DERIVED" build
    APP_DIR="$DERIVED/Build/Products/Release/${PRODUCT_NAME}.app"
    bash tugrust/scripts/sign-bundle.sh "$APP_DIR"
    # Seed source-tree-path for the release instance too. AppDelegate
    # falls back to BuildInfo.sourceTree if the tugbank value is
    # missing, but release builds intentionally omit BuildSourceTree
    # ([D03]), so this write is the only path for release from a
    # developer checkout.
    tugrust/target/debug/tugbank --instance "$INSTANCE_ID" write dev.tugtool.app source-tree-path "$(pwd)" >/dev/null
    echo "==> Launching $INSTANCE_ID ($APP_DIR)"
    # Scrub the launching instance's identity/resource env: `open`
    # propagates the caller's environment, so a launch from inside a Dev
    # card would otherwise hand the new bundle the host's TUG_INSTANCE_ID.
    env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT open "$APP_DIR"

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
    # Scrub the launching instance's identity/resource env: `open`
    # propagates the caller's environment, so a launch from inside a Dev
    # card would otherwise hand the new bundle the host's TUG_INSTANCE_ID.
    env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT open "$APP_DIR"

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
    # Scrub the launching instance's identity/resource env: `open`
    # propagates the caller's environment, so a launch from inside a Dev
    # card would otherwise hand the new bundle the host's TUG_INSTANCE_ID.
    env -u TUG_INSTANCE_ID -u TUG_BUNDLE_PATH -u TUGCAST_RESOURCE_ROOT open "$APP_DIR"

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
    while read -r LINE; do
        ID="$(printf '%s' "$LINE" | awk '{print $1}')"
        BUNDLE_PATH="$(printf '%s' "$LINE" | awk '{print $4}')"
        [ -n "$ID" ] || continue
        # Derive bundle ID from the bundle path's Info.plist when
        # available — that's the source of truth for a running app.
        # Fall back to plain `tugutil host instance stop` if the plist
        # can't be read (registry entry without a live bundle).
        BUNDLE_ID=""
        if [ -n "$BUNDLE_PATH" ] && [ -f "$BUNDLE_PATH/Contents/Info.plist" ]; then
            BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BUNDLE_PATH/Contents/Info.plist" 2>/dev/null || true)"
        fi
        if [ -n "$BUNDLE_ID" ]; then
            bash tugrust/scripts/quit-tug-bundle.sh "$BUNDLE_ID" "$ID"
        else
            tugrust/target/debug/tugutil host instance stop "$ID" --timeout 5 || true
        fi
    done < <(tugrust/target/debug/tugutil host instance list 2>/dev/null | tail -n +2)

# One-line wrapper around `tugutil host instance list`. Forwards any extra
# args (e.g. `--json`).
# List running Tug instances (wraps `tugutil host instance list`).
instances *FLAGS:
    tugrust/target/debug/tugutil host instance list {{FLAGS}}

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
    tugrust/target/debug/tugutil host instance remove "$INSTANCE_ID" $FLAGS
    git worktree remove --force "$WORKTREE"
    echo "==> Removed worktree $WORKTREE and its instance state ($INSTANCE_ID)."

# Use this during smoke runs (see archived
# `roadmap/archive/tugplan-tide-transcript-resume-smoke.md`) so
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
# `rm -rf` instead of `tugutil dash join|release` / `instance remove`).
#
# A thin front end over `tugutil host sweep`, which is the one janitor:
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
# stays deliberate): data dirs whose bundle is gone → `tugutil host
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
    TUGUTIL="tugrust/target/debug/tugutil"
    if [ ! -x "$TUGUTIL" ]; then
        echo "==> building tugutil (needed to identify live instances)…"
        (cd tugrust && cargo build -p tugutil) || { echo "error: could not build tugutil" >&2; exit 1; }
    fi
    if [ "{{MODE}}" = "apply" ]; then
        "$TUGUTIL" host sweep --yes
    else
        echo "== reap (diagnose — nothing will change; run 'just reap apply' to release) =="
        "$TUGUTIL" host sweep --dry-run
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
    echo "==> staged for the VM lab: $LAB_SHARE/Tug.dmg"
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

# The one reliable inner loop ([P02]): build an unsigned Tug.dmg, stage it to
# the lab share, wipe any prior run for this OS, clone a fresh factory-fresh
# guest, and boot it with the share mounted — in one command. There is
# deliberately NO install-into-running-VM path: VirtioFS caching + a stale
# /Applications/Tug.app make reinstall-in-place unreliable, so every cycle
# boots a fresh clone. The run for OS <x> is run-<x> (replacing the prior one).
#
#   just lab-cycle sequoia
#
# Inside the booted guest, the dmg appears at:
#   /Volumes/My Shared Files/drop/Tug.dmg
# Build + stage an unsigned dmg, then boot a fresh clone with it mounted (the inner loop).
lab-cycle OS="sequoia":
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
    echo "==> [1/4] Build + stage unsigned Tug.dmg -> $LAB_SHARE"
    just lab-dmg unsigned
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
# repo), resolved via `tugutil host state-dir`.
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
    SENTINEL_FILE="$(tugutil host state-dir 2>/dev/null || tugrust/target/debug/tugutil host state-dir)/code-sign-fingerprint"
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
# Always builds the dedicated app-test identity (`dev.tugtool.app.apptest`
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
    : "${TUG_FORCE_BUNDLE_ID:=dev.tugtool.app.apptest}"
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

    echo "==> [1/5] Rust debug binaries"
    (cd tugrust && cargo build -p tugcast -p tugexec -p tugutil -p tugrelaunch -p tugbank)
    bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode
    bun build --compile tugcode/src/pulse/main-pulse.ts --outfile tugrust/target/debug/tugpulse

    echo "==> [2/5] tugdeck deps + prebuilt dist"
    (cd tugdeck && bun install && bun run build)

    echo "==> [3/5] tests/app-test deps"
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
    bash tugrust/scripts/sign-bundle.sh "$APP_DIR" "$SIGNING_IDENTITY"

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
    SENTINEL_DIR="$(tugutil host state-dir 2>/dev/null || tugrust/target/debug/tugutil host state-dir)"
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
# Builds the dedicated app-test bundle (`dev.tugtool.app.apptest` →
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
# a port gate (`tugutil host gate --name apptest`) — native input and app
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
    # Deliberately NOT `set -e` — we want to keep iterating past per-
    # file failures so the summary captures every file's status.
    set -uo pipefail

    # The corpus runs from the main checkout, never from a dash worktree.
    #
    # Every `tugutil dash` verb resolves the MAIN repo root before it does
    # anything (tugdash-core::ops::main_repo_root, via find_repo_root_from),
    # so a dash created from a linked worktree is created against the base
    # checkout. The app under test has the WORKTREE open as its project, so
    # its dash lane can never list the dash its own fixture just made — the
    # lane tests time out waiting for a row that was written somewhere else.
    # Worse, the run leaves branches, worktrees and dash-log lines behind in
    # the developer's main checkout.
    #
    # TUG_APPTEST_ALLOW_WORKTREE=1 proceeds anyway, for a test whose subject
    # has nothing to do with dashes.
    if [ "${TUG_APPTEST_ALLOW_WORKTREE:-}" != "1" ]; then
        COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
        TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)"
        HEAD_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        if [ -n "$COMMON_DIR" ] && [ "$COMMON_DIR" != "$TOPLEVEL/.git" ]; then
            REFUSAL="this is a linked worktree (git-common-dir is $COMMON_DIR)"
        elif case "$HEAD_BRANCH" in tugdash/*) true;; *) false;; esac; then
            REFUSAL="HEAD is the dash branch $HEAD_BRANCH"
        fi
        if [ -n "${REFUSAL:-}" ]; then
            echo "==> REFUSED: app-test does not run from a dash worktree — $REFUSAL." >&2
            echo "    tugutil's dash verbs resolve the main repo root, so a fixture dash is" >&2
            echo "    created against the base checkout while the app under test has this" >&2
            echo "    worktree open. The lane can never list it, and the run dirties the" >&2
            echo "    main checkout. Run the corpus from the main checkout instead." >&2
            echo "    Set TUG_APPTEST_ALLOW_WORKTREE=1 to proceed anyway." >&2
            exit 1
        fi
    fi

    # App-test always drives the dedicated `dev.tugtool.app.apptest`
    # identity — the same one `build-app` produces and `app-test-grant`
    # granted AX to. This is baked in (no env-var prefix) so the build
    # and the run can never disagree on which bundle to launch.
    : "${TUG_FORCE_BUNDLE_ID:=dev.tugtool.app.apptest}"
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
    # gate is a localhost port bind (tugutil host gate; kernel-released on
    # any death, no lock file): the whole invocation — clean slate,
    # build-if-missing, dist refresh, every file, exit cleanup — runs
    # under it, so one run completes before the next begins. A waiting
    # invocation prints who holds the gate and since when.
    if [ "${TUG_APPTEST_GATED:-}" != "1" ]; then
        if [ ! -x tugrust/target/debug/tugutil ]; then
            echo "==> building tug (needed for the app-test gate)…"
            (cd tugrust && cargo build -p tugutil >/dev/null)
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
            if [ -z "{{FILES}}" ]; then
                ASK_FILES="$(cd tests/app-test && bun scripts/select-tests.ts --core)"
            else
                ASK_FILES="$(printf '%s\n' {{FILES}})"
            fi
            FG_FILES="$(cd tests/app-test && bun scripts/select-tests.ts --foreground $ASK_FILES)"

            if [ -n "$FG_FILES" ]; then
                FG_COUNT="$(printf '%s\n' "$FG_FILES" | grep -c .)"
                ALL_COUNT="$(printf '%s\n' "$ASK_FILES" | grep -c .)"
                BG_COUNT=$((ALL_COUNT - FG_COUNT))
                FG_LIST="$(printf '%s\n' "$FG_FILES" | sed 's/\.test\.ts$//' | paste -sd ',' - | sed 's/,/, /g')"

                # Two choices, because by the time this is answered the
                # background run is already under way — "cancel everything" is
                # no longer a coherent thing to offer. Declining is last, which
                # is what Escape chooses.
                if [ "$BG_COUNT" -gt 0 ]; then
                    RUN_DESC="The other $BG_COUNT are running now either way"
                    SKIP_LABEL="Skip them"
                else
                    RUN_DESC="Nothing else is in this run"
                    SKIP_LABEL="Skip them — run nothing"
                fi

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
                    CHOICE="$(tugrust/target/debug/tugutil host ask \
                        ${TUG_INSTANCE:+--instance "$TUG_INSTANCE"} \
                        --title "$FG_COUNT app-test(s) want to take over the screen" \
                        --description "$FG_LIST" \
                        --timeout-secs "$FG_COUNTDOWN_SECS" \
                        --unattended run-all \
                        --option "run-all:Run them:$RUN_DESC" \
                        --option "background:$SKIP_LABEL:Keeps the screen yours" \
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
        exec tugrust/target/debug/tugutil host gate run --name apptest --label "$WTSLUG" -- just --quiet app-test {{FILES}}
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
            tugrust/target/debug/tugutil host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
        esac
    done < <(tugrust/target/debug/tugutil host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
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
    tugrust/target/debug/tugutil host sweep --yes --quiet || true

    # Release any fixture dash a previous run stranded.
    #
    # A dash fixture's `beforeAll` creates a dash before it does anything
    # else, so a failure anywhere after that — an assertion, a timeout, a
    # kill — leaves the branch and its worktree behind, and `afterAll`
    # never runs. The stranded dash then breaks the NEXT invocation
    # differently from the first, which is how one transient turned into
    # "the dash lane files cannot run together".
    #
    # `at04??-*` is the fixtures' own namespace — every dash-lane test
    # names its dash after itself — so this can never reach a dash a
    # person made.
    #
    # The reset before the discard is load-bearing, not tidiness.
    # `dash discard` hands a worktree's UNCOMMITTED files back to the
    # base checkout, so that tearing down a dash can never destroy work
    # someone typed in it. That is right for a real dash and wrong for a
    # fixture: one stranded between its file write and its round commit
    # would deposit a placeholder body over a real source file here, as
    # an uncommitted modification nobody made. Resetting first leaves the
    # hand-back nothing to copy.
    #
    # Best effort throughout, and it must stay that way: `discard`
    # legitimately refuses when the base checkout has its own edit to a
    # path the dash also touched, and a refused sweep must never fail
    # the run it is cleaning up for. That silence is also why the verb
    # name here has to move in lockstep with the CLI: `>/dev/null 2>&1
    # || true` would swallow an unrecognized-subcommand error just as
    # readily as a refusal, and the sweep would stop sweeping with no
    # signal at all.
    while read -r DASH_BRANCH; do
        [ -n "$DASH_BRANCH" ] || continue
        DASH_NAME="${DASH_BRANCH#tugdash/}"
        DASH_TREE="$(git worktree list --porcelain \
            | awk -v b="refs/heads/$DASH_BRANCH" \
                '/^worktree /{p=substr($0,10)} $0=="branch "b{print p}')"
        if [ -n "$DASH_TREE" ] && [ -d "$DASH_TREE" ]; then
            git -C "$DASH_TREE" reset --hard >/dev/null 2>&1 || true
            git -C "$DASH_TREE" clean -fd >/dev/null 2>&1 || true
        fi
        tugrust/target/debug/tugutil dash discard "$DASH_NAME" --json >/dev/null 2>&1 || true
        echo "swept stranded fixture dash: $DASH_NAME"
    done < <(git branch --list 'tugdash/at04??-*' --format='%(refname:short)')

    TMPOUT="$(mktemp -t app-test.XXXXXX)"
    cleanup() {
        # Targeted teardown — stop only THIS WORKTREE's apptest
        # instances. Another worktree's run and a developer's
        # separately-running app-debug session continue unaffected
        # (and `instance stop` is identity-checked, so a recycled PID
        # is never signalled).
        while read -r ID; do
            case "$ID" in "${TUG_APPTEST_ID_PREFIX}-"*)
                tugrust/target/debug/tugutil host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
            esac
        done < <(tugrust/target/debug/tugutil host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
        # Registry-blind orphan backstop (same rationale as the
        # clean-slate copy above): reap any apptest app that hung
        # before registering, by its worktree-scoped binary path.
        pkill -f "$APP_BIN" 2>/dev/null || true
        # Reap any private tmux servers (and stale socket files) the
        # stopped apptest instances left behind, so a run leaves nothing.
        tugrust/target/debug/tugutil host sweep --yes --quiet || true
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
    cd tests/app-test

    FILES_INPUT="{{FILES}}"
    if [ -z "$FILES_INPUT" ]; then
        # The CORE tier: one test per load-bearing surface, not a sweep. The
        # list itself lives in select-tests.ts, because the pre-gate approval
        # check above has to know which files a bare `just app-test` will run
        # before this point in the recipe is ever reached.
        read -r -a FILES <<< "$(bun scripts/select-tests.ts --core | tr '\n' ' ')"
        SWEEP_LABEL="core"
    else
        read -r -a FILES <<< "$FILES_INPUT"
        SWEEP_LABEL="explicit-files"
    fi

    # Normalize paths so a repo-root-relative path (e.g. the
    # `tests/app-test/at0001-...` form tab-completion produces) works the same as
    # a bare filename. The suite runs from tests/app-test/, so strip that prefix
    # (and any leading `./`) from each entry before bun sees it.
    for i in "${!FILES[@]}"; do
        f="${FILES[$i]}"
        f="${f#./}"
        f="${f#tests/app-test/}"
        FILES[$i]="$f"
    done

    # Background tests never wait on anybody. Screen-taking ones go LAST, and
    # the question about them is answered while the background work is already
    # running — a test that needs no permission must never be held up by one
    # that does.
    #
    # The reordering happens here rather than before the gate re-exec because
    # that exec re-passes `{{FILES}}` — a just template variable, not a shell
    # one — so the pre-gate shell has no way to hand a reordered list forward.
    # It hands the pending question forward instead ($TUG_APPTEST_ASK_OUT), and
    # this is where the answer is collected.
    FG_FILES="$(bun scripts/select-tests.ts --foreground "${FILES[@]}")"
    declare -a FG_QUEUE=()
    if [ -n "$FG_FILES" ]; then
        declare -a BG_QUEUE=()
        for f in "${FILES[@]}"; do
            if printf '%s\n' "$FG_FILES" | grep -qx "$f"; then
                FG_QUEUE+=("$f")
            else
                BG_QUEUE+=("$f")
            fi
        done
        FILES=("${BG_QUEUE[@]}" "${FG_QUEUE[@]}")
        if [ "${#BG_QUEUE[@]}" -gt 0 ]; then
            echo "==> running ${#BG_QUEUE[@]} background test(s) now; the ${#FG_QUEUE[@]} that take the screen come last."
        fi
    fi

    # A ^C (or any other death) must not leave the question standing in the
    # Session card with this run gone. Kill the detached asker — that drops its
    # HTTP request, tugcast clears the pending entry, and the dialog's Escape is
    # all that is left to tidy — and take the handoff files with it. Harmless
    # when the answer already landed: the pid is reaped and the files are gone.
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

    # A quiet core-tier run is two minutes with nothing on screen, which reads
    # as a hang to a person and is exactly right for a captured one. So the
    # per-file progress line is conditional on stdout being a terminal: a human
    # sees motion, and a run piped into a file or a model's context does not.
    PROGRESS=""
    if [ -z "$STREAM" ] && [ -t 1 ]; then PROGRESS=1; fi

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

    START_EPOCH="$(date +%s)"

    for f in "${FILES[@]}"; do
        # The screen-takers are last in the list, so this resolves once, after
        # every background test has already run.
        if [ "${#FG_QUEUE[@]}" -gt 0 ] && printf '%s\n' "${FG_QUEUE[@]}" | grep -qx "$f"; then
            resolve_foreground_decision
            if [ "$FG_DECISION" = "skip" ]; then
                [ -n "$STREAM" ] && echo "---- $f (skipped — takes the screen) ----"
                RESULT_ROWS+=("SKIP:$f:0:0")
                [ -n "$PROGRESS" ] && printf '  %-6s %-56s (skipped — takes the screen)\n' "[SKIP]" "$f"
                continue
            fi
        fi
        if [ -n "$STREAM" ]; then
            echo "---- $f ----"
            # bun's stdout/stderr both stream to the user's terminal AND
            # land in $TMPOUT for parsing. `tee` truncates without `-a`.
            if bun test "$f" 2>&1 | tee "$TMPOUT"; then
                rc=0
            else
                rc="${PIPESTATUS[0]}"
            fi
        else
            if bun test "$f" > "$TMPOUT" 2>&1; then
                rc=0
            else
                rc=$?
            fi
        fi
        # Bun emits "  N pass\n  N fail" near the end of each file.
        # Match the LAST occurrence so per-test mentions earlier in
        # the output do not confuse the count.
        passed="$(grep -E '^[ \t]*[0-9]+ pass$' "$TMPOUT" | tail -n 1 | grep -oE '[0-9]+' | head -n 1)"
        failed="$(grep -E '^[ \t]*[0-9]+ fail$' "$TMPOUT" | tail -n 1 | grep -oE '[0-9]+' | head -n 1)"
        passed="${passed:-0}"
        failed="${failed:-0}"
        total=$((passed + failed))

        # Diagnostics the test asked to be seen, on green runs as well as red.
        while IFS= read -r ln; do
            [ -n "$ln" ] && NOTE_ROWS+=("$f$US${ln#TUG-NOTE: }")
        done < <(grep '^TUG-NOTE: ' "$TMPOUT" || true)

        if [ "$rc" -eq 0 ] && [ "$total" -eq 0 ]; then
            status=SKIP; passed=0; total=0
            RESULT_ROWS+=("SKIP:$f:0:0")
        elif [ "$rc" -eq 0 ]; then
            status=PASS
            RESULT_ROWS+=("PASS:$f:$passed:$total")
        else
            if [ "$total" -gt 0 ]; then
                status=FAIL
                RESULT_ROWS+=("FAIL:$f:$passed:$total")
            else
                status=ERR; passed=0; total=0
                RESULT_ROWS+=("ERR:$f:0:0")
            fi
            before=${#FAIL_DETAILS[@]}
            while IFS= read -r -d "$RS" rec; do
                [ -n "$rec" ] && FAIL_DETAILS+=("$f$US$rec")
            done < <(extract_failures "$TMPOUT" "$f")
            # A file that died before any test reported has no `(fail)` line to
            # hang detail off — carry the tail of its output instead, so an
            # early crash is not silently reduced to `[ERR]`.
            if [ "${#FAIL_DETAILS[@]}" -eq "$before" ]; then
                FAIL_DETAILS+=("$f$US(the file failed before any test reported)$US$(tail -n 12 "$TMPOUT")$US")
            fi
        fi

        # Read from the values just computed, not back out of the array: a
        # negative array index is bash 4.3+, and macOS ships 3.2 as /bin/bash,
        # where `set -u` makes the failure fatal rather than cosmetic.
        if [ -n "$PROGRESS" ]; then
            printf '  %-6s %-56s (%d/%d)\n' "[$status]" "$f" "$passed" "$total"
        fi

        # Between files, stop any of THIS WORKTREE's apptest
        # stragglers. The harness's `app.close()` already targets the
        # current instance; this is defence-in-depth for the rare case
        # where a test panics before reaching `close`.
        while read -r ID; do
            case "$ID" in "${TUG_APPTEST_ID_PREFIX}-"*)
                tugrust/target/debug/tugutil host instance stop "$ID" --timeout 2 >/dev/null 2>&1 || true ;;
            esac
        done < <(tugrust/target/debug/tugutil host instance list 2>/dev/null | tail -n +2 | awk '{print $1}')
        sleep 0.3
    done

    END_EPOCH="$(date +%s)"
    ELAPSED=$((END_EPOCH - START_EPOCH))

    files_run=${#FILES[@]}
    files_passed=0
    files_failed=0
    files_errored=0
    files_skipped=0
    tests_passed_total=0
    tests_total=0
    for row in "${RESULT_ROWS[@]}"; do
        IFS=':' read -r status _file rpassed rtotal <<< "$row"
        case "$status" in
            PASS) files_passed=$((files_passed + 1)) ;;
            FAIL) files_failed=$((files_failed + 1)) ;;
            ERR)  files_errored=$((files_errored + 1)) ;;
            SKIP) files_skipped=$((files_skipped + 1)) ;;
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
    if [ "$ELAPSED" -lt 60 ]; then
        printf '%-14s  %ds\n' 'Wall time:' "$ELAPSED"
    else
        printf '%-14s  %dm %ds\n' 'Wall time:' $((ELAPSED / 60)) $((ELAPSED % 60))
    fi

    echo
    echo "Per-file results:"
    for row in "${RESULT_ROWS[@]}"; do
        IFS=':' read -r status file rpassed rtotal <<< "$row"
        printf '  %-6s %-56s (%d/%d)\n' "[$status]" "$file" "$rpassed" "$rtotal"
    done

    if [ ${#NOTE_ROWS[@]} -gt 0 ]; then
        echo
        echo "Diagnostics:"
        note_file=""
        for row in "${NOTE_ROWS[@]}"; do
            nfile="${row%%$US*}"
            njson="${row#*$US}"
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

    if [ ${#FAIL_DETAILS[@]} -gt 0 ]; then
        echo
        echo "Failures:"
        fail_file=""
        for row in "${FAIL_DETAILS[@]}"; do
            dfile="${row%%$US*}"; rest="${row#*$US}"
            dtitle="${rest%%$US*}"; rest="${rest#*$US}"
            dmsg="${rest%%$US*}"
            dloc="${rest##*$US}"
            if [ "$dfile" != "$fail_file" ]; then
                echo "  $dfile"
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
            if [ "$files_failed" -eq 0 ] && [ "$files_errored" -eq 0 ]; then
                json_verdict=PASS
            else
                json_verdict=FAIL
            fi
            {
                for row in "${RESULT_ROWS[@]}"; do
                    IFS=':' read -r status file rpassed rtotal <<< "$row"
                    fails="$(
                        for d in ${FAIL_DETAILS[@]+"${FAIL_DETAILS[@]}"}; do
                            dfile="${d%%$US*}"; rest="${d#*$US}"
                            [ "$dfile" = "$file" ] || continue
                            dtitle="${rest%%$US*}"; rest="${rest#*$US}"
                            jq -n --arg title "$dtitle" \
                                  --arg message "${rest%%$US*}" \
                                  --arg location "${rest##*$US}" \
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
                            [ "${n%%$US*}" = "$file" ] || continue
                            printf '%s\n' "${n#*$US}"
                        done | jq -R 'fromjson? // empty' | jq -s '.'
                    )"
                    # Belt and braces: `--argjson` on an empty string is a hard
                    # error, and no single file is worth losing the document.
                    [ -n "$notes" ] || notes='[]'
                    [ -n "$fails" ] || fails='[]'
                    jq -n --arg file "$file" --arg status "$status" \
                          --argjson passed "$rpassed" --argjson total "$rtotal" \
                          --argjson failures "$fails" --argjson notes "$notes" \
                          '{file:$file,status:$status,passed:$passed,total:$total,failures:$failures,notes:$notes}'
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
                --argjson testsPassed "$tests_passed_total" \
                --argjson testsTotal "$tests_total" \
                '{sweep:$sweep, wallSeconds:$wall, verdict:$verdict,
                  totals:{filesRun:$filesRun, filesPassed:$filesPassed,
                          filesFailed:$filesFailed, filesErrored:$filesErrored,
                          filesSkipped:$filesSkipped, testsPassed:$testsPassed,
                          testsTotal:$testsTotal},
                  files: .}' > "$TUG_APPTEST_JSON"
        fi
    fi

    echo "$BANNER"
    if [ "$files_failed" -eq 0 ] && [ "$files_errored" -eq 0 ]; then
        printf 'VERDICT: PASS  (%d/%d files green; %d/%d tests passed)\n' \
            "$files_passed" "$files_run" "$tests_passed_total" "$tests_total"
        exit 0
    else
        printf 'VERDICT: FAIL  (%d/%d files green; %d file(s) failed; %d/%d tests passed)\n' \
            "$files_passed" "$files_run" $((files_failed + files_errored)) "$tests_passed_total" "$tests_total"
        exit 1
    fi

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
#   just app-test-changed tugdeck/src/lib/lens-store/index.ts   # from explicit paths
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
    # Exit 3 = the selection blew the budget. The script already explained itself
    # and printed the would-be selection; stop here rather than silently running a
    # sweep's worth of tests (or, worse, reporting "nothing to run").
    if [ "$STATUS" -eq 3 ]; then
        exit 1
    fi
    if [ "$STATUS" -ne 0 ]; then
        echo "==> select-tests failed (status $STATUS)." >&2
        exit "$STATUS"
    fi
    if [ -z "$FILES" ]; then
        echo "==> no app-test covers the changed files — nothing to run."
        exit 0
    fi
    just app-test $FILES

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
    FILES="$(cd tests/app-test && { ls harness-smoke/*.test.ts | sort; ls *.test.ts | sort; })"
    just app-test $FILES

# An unannotated test can never be selected by `app-test-changed`, so it
# silently stops guarding its surface — this is the guard against that
# drift, along with a check that every @covers path still resolves.
#
# Lint the @covers declarations across every app-test file.
app-test-covers-check:
    @cd tests/app-test && bun scripts/select-tests.ts --check

# The PreToolUse gates decide, per command line, what reaches the shell. A gate
# that is wrong in the permissive direction lets a bad habit through; wrong in
# the restrictive direction it denies work that was fine, which costs a round
# trip every time. Both directions are pinned by cases.
hooks-test:
    @bash tugplug/hooks/tests/run-gate-tests.sh

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

# Force a fresh app-test build, then run. Use after changing Swift /
# Rust / harness source — `just app-test` only builds when the bundle is
# ABSENT, so it would otherwise run against a stale bundle. The build
# goes to the app-test variant's own DerivedData and never touches a
# live `app-debug` bundle.
#
#   just app-test-build                       # rebuild + the core tier
#   just app-test-build at0000-smoke.test.ts  # rebuild + one file
#
# Force a fresh app-test build, then run the given files (core tier if none).
app-test-build *FILES:
    #!/usr/bin/env bash
    set -euo pipefail
    export TUG_FORCE_BUNDLE_ID=dev.tugtool.app.apptest
    # build-app runs OUTSIDE the app-test gate, which is fine: it
    # targets this worktree's own per-worktree DerivedData, so it can
    # never clobber a bundle another worktree's gated run is executing.
    # The `just app-test` call below re-execs itself under the gate.
    just build-app
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
# "+"), and toggle it on. The entry is named "Tug (apptest)" so it's
# distinct from the interactive "Tug" debug instance.
# One-time Accessibility grant for the app-test identity.
app-test-grant:
    #!/usr/bin/env bash
    set -euo pipefail
    export TUG_FORCE_BUNDLE_ID="${TUG_FORCE_BUNDLE_ID:-dev.tugtool.app.apptest}"
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
