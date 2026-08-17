"""Is the live SharedAgent path answering, and inside its ceiling?

One digest through the real thing — control socket, running app, a warm Haiku
worker, normalizer, log — and three questions about the answer: did it arrive,
does it say anything, and did it take longer than `synopsis` is allowed.

    just model-liveness              # against debug-main
    just model-liveness release-main

This is on-demand, not CI: it spends subscription tokens and needs a running
instance. Without one it **skips with exit 0** and names the remedy, because a
check that fails wherever the precondition is missing is one people learn to
ignore.

It asserts nothing about *what* the description says. There is no ground truth
for "what is this session about", and inventing one is what the fixed-corpus
quality eval was retired for. Register is `run.py`'s question; this one is
liveness.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import ask, instance_is_running, log_path  # noqa: E402

CORPUS = Path(__file__).parent / "corpus"

# Kept in step with the `synopsis` JobSpec ceiling in
# `tugrust/crates/tugcast/src/shared_agent.rs`. Provisional, like every number
# in that table — the batch analyzer is what eventually sets it.
SYNOPSIS_CEILING_MS = 6_000

SKIP, PASS, FAIL = 0, 0, 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("instance", nargs="?", default="debug-main")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()

    if not instance_is_running(args.instance):
        print(f"skip: no running instance {args.instance!r}.")
        print("      Launch one with `just app-debug` and run this again.")
        return SKIP

    path = log_path(args.instance)
    if path is None:
        print(f"skip: instance {args.instance!r} has never written a log.")
        print("      Launch it with `just app-debug` and run this again.")
        return SKIP

    digest = (CORPUS / "one-line-goal.digest.txt").read_text()
    print(f"asking {args.instance} to describe one digest ({len(digest)} chars)")

    answer = ask(digest, args.instance, path, args.timeout)
    if answer is None:
        print(f"FAIL: no answer within {args.timeout:.0f}s.")
        return FAIL

    raw, line, ms = answer
    print(f"answered in {ms}ms: {line!r}")

    if not line:
        print("FAIL: the answer normalized to an empty description.")
        return FAIL

    if ms > SYNOPSIS_CEILING_MS:
        print(f"FAIL: {ms}ms is over the {SYNOPSIS_CEILING_MS}ms synopsis ceiling.")
        return FAIL

    # Reported, never failed on: the normalizer having had to step in says the
    # prompt is drifting out of register, which is worth seeing and is not a
    # liveness fact.
    if raw != line:
        print(f"note: the normalizer changed the answer — raw was {raw!r}")

    print("PASS")
    return PASS


if __name__ == "__main__":
    raise SystemExit(main())
