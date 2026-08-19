#!/bin/sh
# Tugtool's Tier 0 — "does the joined tree build?" — run from the dash's
# workshop worktree with the candidate checked out.
#
# Declared in .tugtool/config.toml as `[tugtool.dash].verify_tier0`, because
# what verifies a project is the project's business: cargo and bunx exist here
# and in no necessary other repository, so tugdash-core runs what it is told
# rather than knowing this.
#
# Scoped to the surfaces the candidate actually touched. A join that moved only
# prose should not pay for a Rust build, and `TUG_VERIFY_BASE_SHA` /
# `TUG_VERIFY_CANDIDATE_SHA` are handed in by the runner precisely so this does
# not have to guess at the head pair.
set -eu

base="${TUG_VERIFY_BASE_SHA:-}"
candidate="${TUG_VERIFY_CANDIDATE_SHA:-}"

if [ -z "$base" ] || [ -z "$candidate" ]; then
  echo "verify-tier0: no head pair in the environment; verifying everything" >&2
  changed="tugrust/ tugdeck/"
else
  changed=$(git diff --name-only "$base".."$candidate")
fi

touched() {
  printf '%s\n' "$changed" | grep -q "^$1" || printf '%s\n' "$changed" | grep -q "$1"
}

ran=0

if touched "tugrust/"; then
  ran=1
  echo "==> tier0: cargo check (tugrust touched)"
  (cd tugrust && cargo check --workspace --all-targets)
fi

if touched "tugdeck/"; then
  ran=1
  echo "==> tier0: tsc + vite build (tugdeck touched)"
  (cd tugdeck && bunx tsc --noEmit)
  (cd tugdeck && bunx vite build)
fi

if [ "$ran" -eq 0 ]; then
  echo "==> tier0: no built surface touched by this candidate"
fi
