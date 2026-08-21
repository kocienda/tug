#!/bin/sh
# Tugtool's fit check — "does the tree that will actually land still build?"
#
# Run at the end of a dash run, from the dash worktree, after
# `tugutil dash replay <name>` has moved the branch onto the live base. That is
# the whole point of the timing: the run's per-step checkpoints verified the
# sandbox, and this verifies the deliverable — base plus dash, as it will land
# — while the worktree is warm and the model is still present to fix what it
# finds. A replay that reports `Current` re-runs nothing, because the last
# step's checkpoint already covered those exact bytes.
#
# Usage: sh scripts/verify-fit.sh <base-sha> <candidate-sha>
#
# Scoped to the surfaces the replay actually moved. A run that touched only
# prose should not pay for a Rust build.
set -eu

base="${1:-}"
candidate="${2:-}"

if [ -z "$base" ] || [ -z "$candidate" ]; then
  echo "verify-fit: no head pair given; verifying everything" >&2
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
  echo "==> fit: cargo check (tugrust touched)"
  (cd tugrust && cargo check --workspace --all-targets)
fi

if touched "tugdeck/"; then
  ran=1
  echo "==> fit: tsc + vite build (tugdeck touched)"
  (cd tugdeck && bunx tsc --noEmit)
  (cd tugdeck && bunx vite build)
fi

if [ "$ran" -eq 0 ]; then
  echo "==> fit: no built surface moved by this replay"
fi
