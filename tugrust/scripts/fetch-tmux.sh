#!/bin/bash
set -euo pipefail

# fetch-tmux.sh — build a relocatable, statically-linked arm64 tmux from
# source for bundling inside Tug.app.
#
# Why from source: Homebrew's tmux dynamically links libevent/ncurses from
# /opt/homebrew, so it can't be relocated into an app bundle. We build
# libevent and ncurses as static archives (.a only) and link tmux against
# them, leaving only macOS system libraries (libSystem) dynamically linked —
# the supported shape for a self-contained macOS binary (Apple does not
# support fully-static binaries).
#
# Output (cached, keyed by version): a tmux binary, a trimmed terminfo
# database (tmux-256color and friends), and the third-party license texts.
#
# Usage:
#   ./fetch-tmux.sh [--force]
#   Prints the output dir on the last line (consumed by build-app.sh).

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# stdout carries the product — the single output path — and nothing else.
# Everything else this script emits is progress. `configure` and `make` write
# their chatter to stdout, and build-app.sh captures this script through a
# command substitution, so without this the whole build log ends up spliced
# into the path. A cache hit runs none of those commands, which is why that
# only ever surfaced on a cold build.
#
# fd 3 keeps a handle on the real stdout; the body's stdout goes to stderr.
exec 3>&1 1>&2

# Pinned upstream versions.
TMUX_VER="3.5a"
LIBEVENT_VER="2.1.12-stable"
NCURSES_VER="6.5"
UTF8PROC_VER="2.9.0"

# Pinned SHA-256 sums. Set to PIN_ME to skip verification and print the
# computed sum (so the real value can be baked in on first build).
TMUX_SHA256="16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951"
LIBEVENT_SHA256="92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb"
NCURSES_SHA256="136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6"
UTF8PROC_SHA256="18c1626e9fc5a2e192311e36b3010bfc698078f692888940f1fa150547abb0c1"

TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VER}/tmux-${TMUX_VER}.tar.gz"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VER}/libevent-${LIBEVENT_VER}.tar.gz"
NCURSES_URL="https://ftp.gnu.org/gnu/ncurses/ncurses-${NCURSES_VER}.tar.gz"
UTF8PROC_URL="https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v${UTF8PROC_VER}.tar.gz"

ARCH="arm64"
export MACOSX_DEPLOYMENT_TARGET="13.0"
COMMON_FLAGS="-arch ${ARCH} -mmacosx-version-min=${MACOSX_DEPLOYMENT_TARGET} -O2"

# Force Apple's Xcode toolchain. A Homebrew LLVM clang on PATH would link the
# binary against /opt/homebrew libc++/libunwind, defeating relocatability.
CC="$(xcrun -find clang)"; export CC
CXX="$(xcrun -find clang++)"; export CXX
SDKROOT="$(xcrun --show-sdk-path)"; export SDKROOT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

VERKEY="tmux${TMUX_VER}-libevent${LIBEVENT_VER}-ncurses${NCURSES_VER}-${ARCH}"
CACHE_ROOT="$REPO_ROOT/.tmux-build"
WORK="$CACHE_ROOT/work"
DEPS="$CACHE_ROOT/deps"          # static libevent + ncurses install prefix
OUT="$CACHE_ROOT/out/$VERKEY"    # final cached artifacts

log() { echo "[fetch-tmux] $*" >&2; }

# A relocatable tmux may link ONLY these always-present macOS system dylibs.
# Anything else (Homebrew libs, the ancient system libncurses, a stray
# libevent) means the binary isn't self-contained.
ALLOWED_DYLIBS='/usr/lib/libSystem|/usr/lib/libresolv|/usr/lib/libc\+\+|/usr/lib/libobjc'
unexpected_dylibs() {  # tmux-path -> prints any disallowed dylib lines
    otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -vE "$ALLOWED_DYLIBS" || true
}

# ---- cache check -----------------------------------------------------------
if [ "$FORCE" = 0 ] && [ -x "$OUT/bin/tmux" ] && [ -d "$OUT/terminfo" ]; then
    if [ -z "$(unexpected_dylibs "$OUT/bin/tmux")" ]; then
        log "cache hit: $OUT"
        echo "$OUT" >&3
        exit 0
    fi
    log "cached binary references non-system dylibs; rebuilding"
fi

rm -rf "$WORK" "$DEPS" "$OUT"
mkdir -p "$WORK" "$DEPS" "$OUT/bin" "$OUT/terminfo" "$OUT/licenses"

# ---- helpers ---------------------------------------------------------------
fetch() {  # url sha256 -> echoes local tarball path
    local url="$1" sha="$2" file; file="$WORK/$(basename "$url")"
    log "downloading $(basename "$url")"
    curl -fsSL "$url" -o "$file"
    local got; got="$(shasum -a 256 "$file" | awk '{print $1}')"
    if [ "$sha" = "PIN_ME" ]; then
        log "  (unpinned) sha256=$got  <-- bake this into the script"
    elif [ "$sha" != "$got" ]; then
        log "  CHECKSUM MISMATCH for $(basename "$url")"
        log "  expected $sha"
        log "  got      $got"
        exit 1
    else
        log "  sha256 ok"
    fi
    echo "$file"
}

extract() { tar -xzf "$1" -C "$WORK"; }

# ---- 1. ncurses (static, wide) --------------------------------------------
NC_TGZ="$(fetch "$NCURSES_URL" "$NCURSES_SHA256")"
extract "$NC_TGZ"
log "building ncurses ${NCURSES_VER} (static)"
(
    cd "$WORK/ncurses-${NCURSES_VER}"
    CFLAGS="$COMMON_FLAGS" CPPFLAGS="-P" ./configure \
        --prefix="$DEPS" \
        --without-shared --without-debug --without-tests --without-manpages \
        --enable-widec --enable-pc-files \
        --with-pkg-config-libdir="$DEPS/lib/pkgconfig" \
        --disable-stripping \
        --with-terminfo-dirs="/usr/share/terminfo" \
        --enable-termcap
    make -j"$(sysctl -n hw.ncpu)"
    make install
)
# tmux links `-lncurses`; we built the wide variant (libncursesw.a). Without
# these aliases the linker finds no static libncurses and silently falls back
# to the ancient system /usr/lib/libncurses.5.4.dylib. Point -lncurses and the
# `ncurses` pkg-config name at OUR static wide build instead.
ln -sf libncursesw.a "$DEPS/lib/libncurses.a"
[ -f "$DEPS/lib/pkgconfig/ncursesw.pc" ] && ln -sf ncursesw.pc "$DEPS/lib/pkgconfig/ncurses.pc"

# ---- 2. libevent (static, no openssl) -------------------------------------
LE_TGZ="$(fetch "$LIBEVENT_URL" "$LIBEVENT_SHA256")"
extract "$LE_TGZ"
log "building libevent ${LIBEVENT_VER} (static)"
(
    cd "$WORK/libevent-${LIBEVENT_VER}"
    CFLAGS="$COMMON_FLAGS" ./configure \
        --prefix="$DEPS" \
        --disable-shared --enable-static \
        --disable-openssl --disable-samples --disable-debug-mode --disable-libevent-regress
    make -j"$(sysctl -n hw.ncpu)"
    make install
)

# ---- 2b. utf8proc (static; correct Unicode/emoji width in tmux) -----------
U8_TGZ="$(fetch "$UTF8PROC_URL" "$UTF8PROC_SHA256")"
extract "$U8_TGZ"
log "building utf8proc ${UTF8PROC_VER} (static)"
(
    cd "$WORK/utf8proc-${UTF8PROC_VER}"
    make -j"$(sysctl -n hw.ncpu)" CC="$CC" CFLAGS="$COMMON_FLAGS" libutf8proc.a
    make install prefix="$DEPS"
    # Drop the shared lib so tmux is forced to link the static archive.
    rm -f "$DEPS"/lib/libutf8proc*.dylib
)

# ---- 3. tmux (links the static deps; libSystem stays dynamic) -------------
TM_TGZ="$(fetch "$TMUX_URL" "$TMUX_SHA256")"
extract "$TM_TGZ"
log "building tmux ${TMUX_VER}"
(
    cd "$WORK/tmux-${TMUX_VER}"
    # Only static .a archives exist in $DEPS/lib, so the linker is forced to
    # link libevent/ncursesw statically. Point configure at our wide ncurses.
    # configure looks each library up through pkg-config unless its
    # <NAME>_CFLAGS and <NAME>_LIBS are given, and a fresh Mac has no
    # pkg-config. The names are configure's own: LIBEVENT and LIBUTF8PROC.
    PKG_CONFIG_PATH="$DEPS/lib/pkgconfig" \
    CFLAGS="$COMMON_FLAGS" \
    CPPFLAGS="-I$DEPS/include -I$DEPS/include/ncursesw" \
    LDFLAGS="-L$DEPS/lib" \
    LIBEVENT_CFLAGS="-I$DEPS/include" \
    LIBEVENT_LIBS="$DEPS/lib/libevent.a" \
    LIBUTF8PROC_CFLAGS="-I$DEPS/include" \
    LIBUTF8PROC_LIBS="$DEPS/lib/libutf8proc.a" \
    ./configure --prefix="$OUT" --enable-sixel --enable-utf8proc
    make -j"$(sysctl -n hw.ncpu)"
    cp tmux "$OUT/bin/tmux"
)

# ---- 4. trimmed terminfo ---------------------------------------------------
# tmux sets TERM=tmux-256color inside; the outer pane is typically
# xterm-256color. Copy the entries we actually rely on from the ncurses db.
log "assembling terminfo"
NC_TIDB="$DEPS/share/terminfo"
for entry in tmux tmux-256color screen screen-256color xterm xterm-256color ansi vt100; do
    found="$(find "$NC_TIDB" -name "$entry" -type f 2>/dev/null | head -1 || true)"
    if [ -n "$found" ]; then
        sub="$(basename "$(dirname "$found")")"
        mkdir -p "$OUT/terminfo/$sub"
        cp "$found" "$OUT/terminfo/$sub/"
    else
        log "  WARNING: terminfo entry '$entry' not found in $NC_TIDB"
    fi
done

# ---- 5. licenses -----------------------------------------------------------
cp "$WORK/tmux-${TMUX_VER}/COPYING" "$OUT/licenses/tmux-LICENSE.txt" 2>/dev/null || true
cp "$WORK/libevent-${LIBEVENT_VER}/LICENSE" "$OUT/licenses/libevent-LICENSE.txt" 2>/dev/null || true
cp "$WORK/ncurses-${NCURSES_VER}/COPYING" "$OUT/licenses/ncurses-LICENSE.txt" 2>/dev/null || true
cp "$WORK/utf8proc-${UTF8PROC_VER}/LICENSE.md" "$OUT/licenses/utf8proc-LICENSE.txt" 2>/dev/null || true

# ---- 6. verify self-contained ---------------------------------------------
log "linkage of built tmux:"
otool -L "$OUT/bin/tmux" >&2
BAD="$(unexpected_dylibs "$OUT/bin/tmux")"
if [ -n "$BAD" ]; then
    log "ERROR: tmux links non-system dylibs — not relocatable:"
    echo "$BAD" >&2
    exit 1
fi
log "tmux version: $("$OUT/bin/tmux" -V 2>&1 || true)"
log "build complete: $OUT"

echo "$OUT" >&3
