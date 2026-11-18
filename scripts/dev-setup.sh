#!/usr/bin/env bash
#
# dev-setup.sh — check that this Mac can build Tug, and install what it lacks.
#
#   scripts/dev-setup.sh                  set up: check, install what is missing, report
#   scripts/dev-setup.sh --check          the doctor: check and report, change nothing
#   scripts/dev-setup.sh --check --tier run --quiet
#                                         the preflight `just app-debug` runs: silent
#                                         when the run tier is green, the reds otherwise
#   scripts/dev-setup.sh --yes            set up without asking before rustup or Homebrew
#
# `just dev-setup` and `just dev-doctor` are this script under shorter names.
# The script is the front door, not the recipes, because `just` is one of the
# things a fresh Mac lacks: it has to run with nothing but macOS's own bash
# 3.2, so it uses no associative arrays, no `mapfile`, no `${var,,}`.
#
# ## One table, two modes
#
# CHECKS below is the list of everything DEVELOPING.md section 1 and 2 ask
# for. Each entry is a tier and an id; `check_<id>` reads the machine and
# sets a verdict, and `fix_<id>`, where one exists, installs the thing. The
# doctor runs the checks. Setup runs the same checks, runs the fix for each
# red one, and checks again — so the two cannot disagree about what a
# correct machine is, and a check added here is repaired by setup the moment
# it has a fix.
#
# ## Tiers
#
#   run   what `just app-debug` needs to build and launch
#   test  what `just test`, `just lint` and `just ci` add
#   ship  what `just dmg` and `just notarize` add
#   info  facts worth knowing that are never a failure
#
# ## What setup will not do
#
# It never installs Xcode and never runs `sudo`: those steps are printed for
# you to run. It asks once before each of the two installers that fetch and
# run a script and edit your shell profile — rustup and Homebrew — unless
# `--yes` was given.
#
# ## Never run a shim
#
# On a Mac with no active developer directory, `/usr/bin/cc`, `/usr/bin/git`
# and `/usr/bin/python3` are Apple's shims, and running one pops a system
# dialog. So `xcode-select -p` is asked first, and every check that would
# run one of those is skipped until it answers.
#
# ## Test seams
#
# TUG_DEV_SETUP_ROOT replaces the checkout root and TUG_DEV_SETUP_BREW_PREFIX
# the Homebrew prefix, so a test can point the script at a scratch tree and a
# directory of stub tools.

# Every check and fix is called by name, as `check_<id>` and `fix_<id>` from
# the CHECKS table, which shellcheck cannot follow.
# shellcheck disable=SC2329

set -u

ROOT="${TUG_DEV_SETUP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BREW_PREFIX="${TUG_DEV_SETUP_BREW_PREFIX:-/opt/homebrew}"
CARGO_BIN="${CARGO_HOME:-$HOME/.cargo}/bin"

XCODE_MIN="26.3"
NODE_MIN="20.19"
PYTHON_MIN="3.10"
MACOS_MIN="15"

# The pins are read from where they already live, so this script never
# carries a second copy that could drift.
BUN_PIN="$(tr -d '[:space:]' < "$ROOT/.bun-version" 2>/dev/null || true)"
WASM_PACK_PIN="$(sed -n 's/.*tool: wasm-pack@\([0-9.]*\).*/\1/p' "$ROOT/.github/workflows/wasm.yml" 2>/dev/null | head -1)"
RUST_PIN="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$ROOT/tugrust/rust-toolchain.toml" 2>/dev/null | head -1)"

CHECKS="run host
run xcode
run cc
run cargo
run wasm_pack
run bun
run node
run just
run tmux
run deps_tugcode
run deps_tugdeck
test nextest
test shellcheck
test deps_apptest
test wasm_pkg
ship python
info signing"

# ── Arguments ────────────────────────────────────────────────────────────────

MODE=setup
ONLY_TIER=""
QUIET=0
ASSUME_YES=0

usage() {
    sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --check) MODE=check ;;
        --tier)
            shift
            ONLY_TIER="${1:-}"
            case "$ONLY_TIER" in
                run | test | ship) ;;
                *)
                    echo "dev-setup: --tier takes run, test or ship" >&2
                    exit 2
                    ;;
            esac
            ;;
        --quiet) QUIET=1 ;;
        --yes | -y) ASSUME_YES=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "dev-setup: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

# ── PATH: the user's, and the script's ───────────────────────────────────────
#
# A tool this script has just installed lands in ~/.cargo/bin or Homebrew's
# bin, which the terminal that launched the script may not have on its PATH.
# The script works with both directories in front, so one fix can use the
# tool the last one installed; `locate` remembers the PATH it was started
# with, so a tool that is installed and unreachable from the user's own
# shell is reported as exactly that.

ORIG_PATH="$PATH"
PATH="$CARGO_BIN:$BREW_PREFIX/bin:$PATH"
export PATH

# locate <tool> — set TOOL to its path and OFFPATH to 1 when only the
# script's widened PATH finds it. Returns 1 when it is nowhere.
locate() {
    TOOL="$(
        PATH="$ORIG_PATH"
        type -P "$1" 2>/dev/null
    )"
    OFFPATH=0
    if [ -z "$TOOL" ]; then
        TOOL="$(type -P "$1" 2>/dev/null)"
        [ -n "$TOOL" ] && OFFPATH=1
    fi
    [ -n "$TOOL" ]
}

# first_version — the first dotted number on stdin.
first_version() {
    grep -Eo '[0-9]+(\.[0-9]+)+' | head -1
}

# ver_ge <a> <b> — true when dotted version a is at least b.
ver_ge() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        n = split(a, x, "."); m = split(b, y, ".")
        for (i = 1; i <= (n > m ? n : m); i++) {
            p = x[i] + 0; q = y[i] + 0
            if (p > q) exit 0
            if (p < q) exit 1
        }
        exit 0
    }'
}

# ── Verdicts ─────────────────────────────────────────────────────────────────
#
# A check ends by calling exactly one of these. STATE is what the driver
# tallies; MSG is the line; HINT is what to do about it, one command or
# sentence per line.

STATE="" MSG="" HINT="" NOFIX=0

ok() { STATE=ok MSG="$1" HINT=""; }
bad() { STATE=bad MSG="$1" HINT="${2:-}"; }
warn() { STATE=warn MSG="$1" HINT="${2:-}"; }
note() { STATE=note MSG="$1" HINT="${2:-}"; }
skip() { STATE=skip MSG="$1" HINT=""; }

# Installed, and not reachable from the shell that started the script.
unreachable() {
    STATE=path
    MSG="$1 is installed at $TOOL, which is not on this terminal's PATH"
    HINT="open a new terminal"
}

# ── Checks ───────────────────────────────────────────────────────────────────

DEVDIR_OK=0

check_host() {
    local arch os
    arch="$(uname -m)"
    os="$(sw_vers -productVersion 2>/dev/null)"
    if [ "$arch" != "arm64" ]; then
        bad "this Mac is $arch — Tug builds on Apple silicon only"
        NOFIX=1
    elif ! ver_ge "${os:-0}" "$MACOS_MIN"; then
        bad "macOS ${os:-unknown} — Tug needs macOS $MACOS_MIN or later"
        NOFIX=1
    else
        ok "macOS $os, $arch"
    fi
}

check_xcode() {
    local dev out ver
    NOFIX=1
    if ! dev="$(xcode-select -p 2>/dev/null)"; then
        bad "no active developer directory — Xcode is not installed or not selected" \
            "install Xcode $XCODE_MIN or later, then:
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch"
        return
    fi
    DEVDIR_OK=1
    case "$dev" in
        *CommandLineTools*)
            bad "only the Command Line Tools are selected — Tug needs the full Xcode" \
                "install Xcode $XCODE_MIN or later, then:
sudo xcode-select -s /Applications/Xcode.app"
            return
            ;;
    esac
    if ! out="$(xcodebuild -version 2>&1)"; then
        bad "xcodebuild fails: $(printf '%s\n' "$out" | head -1)" \
            "sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch"
        return
    fi
    ver="$(printf '%s\n' "$out" | first_version)"
    if ! ver_ge "${ver:-0}" "$XCODE_MIN"; then
        bad "Xcode ${ver:-unknown} — Tug needs $XCODE_MIN or later" \
            "install a newer Xcode, then: sudo xcode-select -s /Applications/Xcode.app"
        return
    fi
    if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
        bad "Xcode $ver has not finished its first launch" \
            "sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch"
        return
    fi
    ok "Xcode $ver"
}

check_cc() {
    local out
    NOFIX=1
    if [ "$DEVDIR_OK" != 1 ]; then
        skip "C compiler not checked until Xcode is selected"
        return
    fi
    if out="$(printf '#include <stddef.h>\nint main(void) { return 0; }\n' | cc -x c -c - -o /dev/null 2>&1)"; then
        ok "C compiler works"
    else
        bad "the C compiler fails: $(printf '%s\n' "$out" | head -1)" \
            "see DEVELOPING.md, section 1, Xcode — a failure here is usually a damaged Xcode"
    fi
}

check_cargo() {
    local cargo
    if ! locate cargo; then
        bad "cargo not found" \
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
        return
    fi
    if [ "$OFFPATH" = 1 ]; then
        unreachable cargo
        HINT="open a new terminal, or run: . \"\$HOME/.cargo/env\""
        return
    fi
    cargo="$TOOL"
    if ! locate rustup; then
        bad "cargo at $cargo is not rustup's, so the pinned Rust ${RUST_PIN:-toolchain} is not used" \
            "install Rust with rustup, and put ~/.cargo/bin ahead of $(dirname "$cargo") on PATH"
        NOFIX=1
        return
    fi
    if [ -z "$RUST_PIN" ]; then
        ok "cargo, through rustup"
    elif rustup toolchain list 2>/dev/null | grep -q "^$RUST_PIN-"; then
        ok "cargo, through rustup; Rust $RUST_PIN is installed"
    else
        ok "cargo, through rustup; the first build downloads Rust $RUST_PIN"
    fi
}

check_wasm_pack() {
    local ver theirs
    if [ -z "$WASM_PACK_PIN" ]; then
        skip "wasm-pack pin not found in .github/workflows/wasm.yml"
        return
    fi
    if ! locate wasm-pack; then
        bad "wasm-pack not found" "$(wasm_pack_install_line)"
        return
    fi
    if [ "$OFFPATH" = 1 ]; then
        unreachable wasm-pack
        return
    fi
    ver="$("$TOOL" --version 2>/dev/null | first_version)"
    if [ "$ver" = "$WASM_PACK_PIN" ]; then
        ok "wasm-pack $ver"
        return
    fi
    theirs="$TOOL"
    if [ "$theirs" != "$CARGO_BIN/wasm-pack" ] && [ -x "$CARGO_BIN/wasm-pack" ] \
        && [ "$("$CARGO_BIN/wasm-pack" --version 2>/dev/null | first_version)" = "$WASM_PACK_PIN" ]; then
        bad "wasm-pack ${ver:-unknown} at $theirs shadows the $WASM_PACK_PIN in $CARGO_BIN" \
            "remove $theirs, or put $CARGO_BIN ahead of it on PATH"
        NOFIX=1
        return
    fi
    bad "wasm-pack ${ver:-unknown} at $theirs — need exactly $WASM_PACK_PIN, or every build rewrites the checked-in .wasm files" \
        "$(wasm_pack_install_line)"
}

wasm_pack_install_line() {
    local name="wasm-pack-v$WASM_PACK_PIN-aarch64-apple-darwin"
    echo "curl -LsSf https://github.com/wasm-bindgen/wasm-pack/releases/download/v$WASM_PACK_PIN/$name.tar.gz | tar zxf - --strip-components 1 -C \"$CARGO_BIN\" $name/wasm-pack"
}

# check_brew_tool <tool> <formula> <what it is for>
check_brew_tool() {
    if ! locate "$1"; then
        bad "$1 not found — $3" "brew install $2"
    elif [ "$OFFPATH" = 1 ]; then
        unreachable "$1"
    else
        ok "$1 $("$TOOL" "${4:---version}" 2>/dev/null | first_version)"
    fi
}

check_bun() {
    local ver want
    if ! locate bun; then
        bad "bun not found" "brew install oven-sh/bun/bun@$BUN_PIN"
        return
    fi
    if [ "$OFFPATH" = 1 ]; then
        unreachable bun
        return
    fi
    ver="$("$TOOL" --version 2>/dev/null | first_version)"
    want="${BUN_PIN%.*}"
    if [ -n "$want" ] && [ "${ver%.*}" != "$want" ]; then
        bad "bun ${ver:-unknown} at $TOOL — Tug builds with bun $want" \
            "brew install oven-sh/bun/bun@$BUN_PIN"
        return
    fi
    ok "bun $ver"
}

check_node() {
    local ver
    if ! locate node; then
        bad "node not found — it runs the Vite server the debug app loads its frontend from" \
            "brew install node"
        return
    fi
    if [ "$OFFPATH" = 1 ]; then
        unreachable node
        return
    fi
    ver="$("$TOOL" --version 2>/dev/null | first_version)"
    if ! ver_ge "${ver:-0}" "$NODE_MIN"; then
        bad "node ${ver:-unknown} at $TOOL — Vite needs $NODE_MIN or later" "brew install node"
        return
    fi
    ok "node $ver"
}

check_just() { check_brew_tool just just "it runs every recipe"; }
check_tmux() { check_brew_tool tmux tmux "the app refuses to start without it" -V; }
check_shellcheck() { check_brew_tool shellcheck shellcheck "just lint runs it over the build scripts"; }

# check_deps <dir> — the directory's packages are installed, and were
# installed since its `bun.lock` last changed. Bun keeps no copy of the
# lockfile under `node_modules`, but every `bun install` relinks
# `node_modules/.bin`, a run that changes nothing included, so that
# directory's mtime is when the packages were last brought level. A pull or
# a branch switch that moves the lockfile leaves it newer, and the one
# `bun install` line in the hint is the whole repair. A directory whose
# packages ship no executables has no `.bin` and is checked for presence only.
check_deps() {
    if [ ! -d "$ROOT/$1/node_modules" ]; then
        bad "$1 packages are not installed" "bun install --cwd $1 --frozen-lockfile"
    elif [ -d "$ROOT/$1/node_modules/.bin" ] && [ "$ROOT/$1/bun.lock" -nt "$ROOT/$1/node_modules/.bin" ]; then
        bad "$1 packages are older than $1/bun.lock" "bun install --cwd $1 --frozen-lockfile"
    else
        ok "$1 packages are installed"
    fi
}
check_deps_tugcode() { check_deps tugcode; }
check_deps_tugdeck() { check_deps tugdeck; }
check_deps_apptest() { check_deps tests/app-test; }

check_nextest() {
    if ! locate cargo-nextest; then
        bad "cargo-nextest not found — it runs the Rust tests" \
            "curl -LsSf https://get.nexte.st/latest/mac | tar zxf - -C \"$CARGO_BIN\""
    elif [ "$OFFPATH" = 1 ]; then
        unreachable cargo-nextest
    else
        ok "cargo-nextest $("$TOOL" nextest --version 2>/dev/null | first_version)"
    fi
}

check_wasm_pkg() {
    local n
    NOFIX=1
    if ! locate git || { [ "$TOOL" = /usr/bin/git ] && [ "$DEVDIR_OK" != 1 ]; }; then
        skip "checked-in WebAssembly packages not compared until git is available"
        return
    fi
    if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        skip "checked-in WebAssembly packages not compared outside a git checkout"
        return
    fi
    n="$(git -C "$ROOT" status --porcelain -- 'tugdeck/crates/*/pkg' 2>/dev/null | grep -c '\.wasm$')"
    if [ "${n:-0}" -gt 0 ]; then
        warn "$n modified .wasm file(s) under tugdeck/crates/*/pkg" \
            "if you did not change those crates, a wasm-pack other than ${WASM_PACK_PIN:-the pinned one} built them: just wasm"
    else
        ok "checked-in WebAssembly packages are unmodified"
    fi
}

check_python() {
    local ver brewed
    if ! locate python3; then
        bad "python3 not found — just dmg needs $PYTHON_MIN or later" "brew install python"
        return
    fi
    if [ "$OFFPATH" = 1 ]; then
        unreachable python3
        return
    fi
    if [ "$TOOL" = /usr/bin/python3 ] && [ "$DEVDIR_OK" != 1 ]; then
        skip "python3 not checked until Xcode is selected"
        return
    fi
    ver="$("$TOOL" --version 2>&1 | first_version)"
    if ver_ge "${ver:-0}" "$PYTHON_MIN"; then
        ok "python3 $ver"
        return
    fi
    brewed="$BREW_PREFIX/bin/python3"
    if [ -x "$brewed" ] && ver_ge "$("$brewed" --version 2>&1 | first_version)" "$PYTHON_MIN"; then
        STATE=path
        MSG="python3 $ver at $TOOL comes ahead of Homebrew's on this terminal's PATH"
        HINT="open a new terminal"
        return
    fi
    bad "python3 ${ver:-unknown} at $TOOL — just dmg needs $PYTHON_MIN or later" "brew install python"
}

check_signing() {
    if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application:"; then
        note "Developer ID certificate found; bundles are signed with it"
    else
        note "no Developer ID certificate; bundles are signed ad-hoc, which runs fine" \
            "the app-tests and notarized builds need one — DEVELOPING.md, section 4, Signing"
    fi
}

# ── Fixes ────────────────────────────────────────────────────────────────────

# confirm <question> — true on yes. `--yes` answers for the user; with no
# terminal to ask on, the answer is no and the line says how to say yes.
confirm() {
    local answer
    if [ "$ASSUME_YES" = 1 ]; then
        return 0
    fi
    if [ ! -t 0 ]; then
        echo "      skipped: $1 (no terminal to ask on; pass --yes to allow it)"
        return 1
    fi
    printf '      %s [y/N] ' "$1"
    read -r answer
    case "$answer" in
        y | Y | yes | YES) return 0 ;;
        *) return 1 ;;
    esac
}

BREW_DECLINED=0

# ensure_brew — Homebrew is present, installing it once if the user agrees.
ensure_brew() {
    if type -P brew >/dev/null 2>&1; then
        return 0
    fi
    if [ "$BREW_DECLINED" = 1 ]; then
        return 1
    fi
    if ! confirm "Homebrew is not installed. Install it? It runs Homebrew's installer, which asks for your password"; then
        BREW_DECLINED=1
        return 1
    fi
    if [ "$ASSUME_YES" = 1 ]; then
        NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    else
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    if ! type -P brew >/dev/null 2>&1; then
        BREW_DECLINED=1
        return 1
    fi
    # Homebrew's installer prints the line that puts it on PATH and leaves
    # adding it to you. Add it for zsh, the macOS default, when it is absent.
    case "${SHELL:-}" in
        */zsh)
            if ! grep -qs 'brew shellenv' "$HOME/.zprofile"; then
                echo "eval \"\$($BREW_PREFIX/bin/brew shellenv)\"" >> "$HOME/.zprofile"
                echo "      added Homebrew to ~/.zprofile"
            fi
            ;;
        *)
            echo "      add Homebrew to your shell profile: eval \"\$($BREW_PREFIX/bin/brew shellenv)\""
            ;;
    esac
    return 0
}

brew_install() {
    ensure_brew && brew install "$@"
}

fix_cargo() {
    confirm "Install Rust with rustup? It runs rustup's installer, which adds ~/.cargo/bin to your shell profile" \
        || return 1
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
}

fix_wasm_pack() {
    local name="wasm-pack-v$WASM_PACK_PIN-aarch64-apple-darwin"
    mkdir -p "$CARGO_BIN"
    curl -LsSf "https://github.com/wasm-bindgen/wasm-pack/releases/download/v$WASM_PACK_PIN/$name.tar.gz" \
        | tar zxf - --strip-components 1 -C "$CARGO_BIN" "$name/wasm-pack"
}

fix_nextest() {
    mkdir -p "$CARGO_BIN"
    curl -LsSf https://get.nexte.st/latest/mac | tar zxf - -C "$CARGO_BIN"
}

fix_bun() { brew_install "oven-sh/bun/bun@$BUN_PIN"; }
fix_node() { brew_install node; }
fix_just() { brew_install just; }
fix_tmux() { brew_install tmux; }
fix_shellcheck() { brew_install shellcheck; }
fix_python() { brew_install python; }

fix_deps() {
    if ! type -P bun >/dev/null 2>&1; then
        echo "      bun is needed to install these packages"
        return 1
    fi
    bun install --cwd "$ROOT/$1" --frozen-lockfile
}
fix_deps_tugcode() { fix_deps tugcode; }
fix_deps_tugdeck() { fix_deps tugdeck; }
fix_deps_apptest() { fix_deps tests/app-test; }

# ── The driver ───────────────────────────────────────────────────────────────

BAD_RUN=0 BAD_TEST=0 BAD_SHIP=0 UNREACHABLE=0
REDS=""
LAST_TIER=""

glyph() {
    case "$1" in
        ok) echo "✓" ;;
        bad) echo "✗" ;;
        # In setup, a tool this run installed lands where the terminal that
        # started it cannot see it yet: done, with one thing left to do.
        # To the doctor, the same state is a failure.
        path) if [ "$MODE" = setup ]; then echo "✓"; else echo "✗"; fi ;;
        warn) echo "!" ;;
        *) echo "–" ;;
    esac
}

# The check's line and its hint, indented under the tier.
render() {
    printf '  %s %s\n' "$(glyph "$STATE")" "$MSG"
    if [ -n "$HINT" ]; then
        printf '%s\n' "$HINT" | sed 's/^/      /'
    fi
}

tier_title() {
    case "$1" in
        run) echo "run — what just app-debug needs" ;;
        test) echo "test — what just test and just lint add" ;;
        ship) echo "ship — what just dmg adds" ;;
        *) echo "info" ;;
    esac
}

tally() {
    local tier="$1"
    if [ "$STATE" = path ] && [ "$MODE" = setup ]; then
        UNREACHABLE=$((UNREACHABLE + 1))
        return
    fi
    case "$STATE" in
        bad | path) ;;
        *) return ;;
    esac
    case "$tier" in
        run) BAD_RUN=$((BAD_RUN + 1)) ;;
        test) BAD_TEST=$((BAD_TEST + 1)) ;;
        ship) BAD_SHIP=$((BAD_SHIP + 1)) ;;
    esac
    REDS="$REDS$(render)
"
}

run_entry() {
    local tier="$1" id="$2"
    if [ -n "$ONLY_TIER" ] && [ "$tier" != "$ONLY_TIER" ]; then
        return
    fi
    if [ "$QUIET" != 1 ] && [ "$tier" != "$LAST_TIER" ]; then
        [ -n "$LAST_TIER" ] && echo
        tier_title "$tier"
        LAST_TIER="$tier"
    fi
    NOFIX=0
    "check_$id"
    if [ "$MODE" = setup ] && [ "$STATE" = bad ] && [ "$NOFIX" != 1 ] \
        && [ "$(type -t "fix_$id")" = function ]; then
        printf '  … %s\n' "$MSG"
        "fix_$id" || true
        NOFIX=0
        "check_$id"
    fi
    [ "$QUIET" != 1 ] && render
    tally "$tier"
}

while read -r tier id; do
    # Checks and fixes read the terminal; the list is on another descriptor.
    run_entry "$tier" "$id" <&3
done 3<&0 <<EOF
$CHECKS
EOF

# ── The verdict ──────────────────────────────────────────────────────────────

if locate just && [ "$OFFPATH" != 1 ]; then
    SETUP_CMD="just dev-setup"
    DOCTOR_CMD="just dev-doctor"
else
    SETUP_CMD="scripts/dev-setup.sh"
    DOCTOR_CMD="scripts/dev-setup.sh --check"
fi

problems() {
    if [ "$1" = 1 ]; then echo "1 problem"; else echo "$1 problems"; fi
}

# blocks <n> — "1 problem blocks", "2 problems block".
blocks() {
    if [ "$1" = 1 ]; then echo "1 problem blocks"; else echo "$1 problems block"; fi
}

if [ "$QUIET" = 1 ]; then
    if [ "$BAD_RUN" -eq 0 ] && [ "$BAD_TEST" -eq 0 ] && [ "$BAD_SHIP" -eq 0 ]; then
        exit 0
    fi
    if [ "$ONLY_TIER" = run ]; then
        echo "dev-doctor: $(blocks "$BAD_RUN") \`just app-debug\`:" >&2
    else
        echo "dev-doctor: $(problems $((BAD_RUN + BAD_TEST + BAD_SHIP))) on this machine:" >&2
    fi
    printf '%s' "$REDS" >&2
    echo "Run \`$SETUP_CMD\` to fix what can be fixed, or \`$DOCTOR_CMD\` for the full report." >&2
    exit 1
fi

echo
REST=$((BAD_TEST + BAD_SHIP))
if [ "$BAD_RUN" -gt 0 ]; then
    if [ "$MODE" = setup ]; then
        echo "$(blocks "$BAD_RUN") \`just app-debug\` still. Each ✗ above says what to do."
        if [ "$UNREACHABLE" -gt 0 ]; then
            echo "Then open a new terminal, so it sees what this run installed, and run \`$SETUP_CMD\` again."
        else
            echo "Then run \`$SETUP_CMD\` again."
        fi
    else
        echo "$(blocks "$BAD_RUN") \`just app-debug\`. Run \`$SETUP_CMD\` to fix what can be fixed."
    fi
    exit 1
fi
if [ "$UNREACHABLE" -gt 0 ]; then
    echo "Everything is installed, but this terminal's PATH is older than the install."
    echo "Open a new terminal, then: just app-debug"
    exit 0
fi
if [ "$REST" -gt 0 ]; then
    if [ -n "$ONLY_TIER" ]; then
        echo "$(problems "$REST") in the $ONLY_TIER tier. Run \`$SETUP_CMD\` to fix what can be fixed."
    else
        echo "Ready for \`just app-debug\`. $(problems "$REST") remain for the test and ship tiers; run \`$SETUP_CMD\` to fix what can be fixed."
    fi
    exit 1
fi
if [ -n "$ONLY_TIER" ]; then
    echo "The $ONLY_TIER tier is ready."
else
    echo "This machine is ready. Next: just app-debug"
fi
exit 0
