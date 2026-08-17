"""What accumulated logs say about the SharedAgent: how fast, how often it fails.

Reads every `tugapp.log.*` and `tugcast.log.*` in one instance's `Logs/`
directory and reports the questions nobody can answer by reading a log
directly — per-task outcome counts, duration percentiles, how often the register
normalizer had to step in, and how often the grounding gate refused a
description.

    just model-stats
    just model-stats release-main
    python3 tests/model-eval/analyze.py debug-main --since 2026-07-01

There are no counters in the running system and no rollup lines. Per-request
lines accumulate, and this reads them whenever there is enough to read — which
is what makes the aggregation rewritable without redeploying anything.

There is one perspective now, and it is the honest one: the caller-side
`shared agent call` line, which knows what the caller waited for and whether it
gave up. When inference ran on-device there was a second, service-side line
saying what inference itself cost, and the gap between the two was the transport
cost. A remote worker has no such line to offer — a turn that times out finishes
somewhere else and never reports back — so the caller's wait is the whole
measurable fact.

    python3 tests/model-eval/analyze.py --self-test
"""

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import ANSI, INSTANCES  # noqa: E402

# Both files use tuglog's default `fmt::layer()` shape, which is the whole point
# of the app writing its own file in that format rather than to Console:
#
#   <ISO8601-UTC>  <LEVEL> <target>: <message> <field>=<value> …
LINE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\S+?Z)\s+(?P<level>\w+)\s+(?P<target>[\w:]+): (?P<rest>.*)$"
)

# Values are space-free for every field this reads. Older lines quote their
# string values (tracing's debug formatting, before the caller-side line moved
# to display formatting), so the quotes come off here and accumulated logs
# spanning that change still parse.
FIELD = re.compile(r'(\w+)=("[^"]*"|\S+)')

# Kept in step with the job table's constants —
# `CLASSIFY_SLOW`/`CLASSIFY_TIMEOUT`/`SENTENCE_SLOW`/`SENTENCE_TIMEOUT` in
# `tugrust/crates/tugcast/src/shared_agent.rs`. All provisional — moving them
# from this report's own output is the reason it exists. The classify slow-mark
# is 1500ms because a warm remote turn measured just under a second, and a 1s
# mark would fire on roughly half of all calls.
#
# `summarize` is history: the job was renamed, and an accumulated log spans the
# rename, so its bounds stay here to keep the older half of a series readable.
BOUNDS = {
    "classify": (1_500, 2_000),
    "synopsis": (3_000, 6_000),
    "expand_query": (3_000, 6_000),
    "summarize": (3_000, 6_000),
}

# The deck's own give-up, from `CLASSIFY_REQUEST_TIMEOUT_MS` in
# `tugdeck/src/lib/shell-classify-store.ts` — the third member of the timeout
# triad, and the same 2s the classify JobSpec holds.
CLASSIFY_DEADLINE_MS = 2_000


def parse(line: str) -> tuple[str, str, dict[str, str]] | None:
    """One log line as (target, message-with-fields, fields), or None."""
    m = LINE.match(ANSI.sub("", line).rstrip())
    if not m:
        return None
    rest = m.group("rest")
    fields = {k: v.strip('"') for k, v in FIELD.findall(rest)}
    fields["_ts"] = m.group("ts")
    return m.group("target"), rest, fields


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(int(len(ordered) * fraction), len(ordered) - 1)]


def read(logs: Path, since: str | None) -> tuple[list[tuple[str, str, dict]], dict[str, int]]:
    """Every parsed line from both log families, and a per-file parsed count.

    The counts are reported so a format drift shows up as a zero rather than as
    silence — one regex reads both files, and a mismatch would otherwise drop
    half the data quietly.
    """
    parsed, counts = [], {}
    for path in sorted(logs.glob("tugapp.log.*")) + sorted(logs.glob("tugcast.log.*")):
        n = 0
        for line in path.read_text(errors="ignore").splitlines():
            got = parse(line)
            if got is None:
                continue
            if since and got[2]["_ts"][:10] < since:
                continue
            parsed.append(got)
            n += 1
        counts[path.name] = n
    return parsed, counts


def report_turnaround(title: str, rows: list[dict]) -> None:
    print(f"\n{title}")
    if not rows:
        print("  (none)")
        return
    by_task = defaultdict(list)
    for row in rows:
        by_task[row.get("task", "?")].append(row)
    for task in sorted(by_task):
        entries = by_task[task]
        times = [int(e["elapsed_ms"]) for e in entries if e.get("elapsed_ms", "").isdigit()]
        outcomes = Counter(e.get("outcome", "?") for e in entries)
        slow_at, ceiling = BOUNDS.get(task, (None, None))
        print(f"  {task}  attempts={len(entries)}")
        print("    outcomes: " + ", ".join(f"{k}={v}" for k, v in sorted(outcomes.items())))
        if times:
            print(
                f"    elapsed_ms: p50={percentile(times, 0.5)}"
                f" p90={percentile(times, 0.9)} max={max(times)}"
            )
        if slow_at is not None:
            over_slow = sum(1 for t in times if t > slow_at)
            over_ceiling = sum(1 for t in times if t > ceiling)
            print(
                f"    over slow ({slow_at}ms): {over_slow}"
                f"   over ceiling ({ceiling}ms): {over_ceiling}"
            )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("instance", nargs="?", default="debug-main")
    ap.add_argument("--since", metavar="YYYY-MM-DD", help="ignore lines before this UTC date")
    ap.add_argument("--self-test", action="store_true", help="check the parser and exit")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    logs = INSTANCES / args.instance / "Logs"
    if not logs.is_dir():
        print(f"no Logs directory for instance {args.instance!r} at {logs}", file=sys.stderr)
        return 2

    parsed, counts = read(logs, args.since)

    print(f"instance: {args.instance}")
    if args.since:
        print(f"since:    {args.since}")
    print("\nparsed lines per file")
    for name, n in counts.items():
        print(f"  {name:28s} {n}")

    caller = [f for t, _, f in parsed if t == "tugcast::shared_agent" and "outcome" in f]

    report_turnaround("caller side (what the caller waited for)", caller)

    # The normalizer's work rate: how often the register had to be imposed
    # rather than written. A clip means the model wrote past the budget the
    # instruction asks for.
    written = [f for _, rest, f in parsed if "session synopsis: written" in rest]
    print("\nnormalizer work rate over written descriptions")
    if not written:
        print("  (no descriptions written in this window)")
    else:
        n = len(written)
        for flag in ("normalized", "clipped"):
            hits = sum(1 for f in written if f.get(flag) == "true")
            print(f"  {flag:11s} {hits}/{n}  ({100 * hits / n:.0f}%)")

    # How often the grounding gate refused a description the digest did not
    # support, and by which rule. A gate that never fires is not protecting
    # anything; one that fires constantly is refusing the model's ordinary work,
    # and the answer to that is the threshold, not more refusals.
    #
    # The denominator is every answer the model returned — written plus refused.
    # An ask that never reached the model (`ask failed`) is counted apart: a
    # refusal rate that fell because the worker was down is a different failure
    # from one that fell because the gate went quiet.
    refused = [f for _, rest, f in parsed if "session synopsis: refused" in rest]
    failed = sum(1 for _, rest, _ in parsed if "session synopsis: ask failed" in rest)
    answered = len(written) + len(refused)
    print("\ngrounding refusal rate over answers")
    if not answered:
        print("  (no answers in this window)")
    else:
        n = len(refused)
        print(f"  refused     {n}/{answered}  ({100 * n / answered:.0f}%)")
        rules: dict[str, int] = {}
        for f in refused:
            rules[f.get("rule", "?")] = rules.get(f.get("rule", "?"), 0) + 1
        for rule, hits in sorted(rules.items(), key=lambda kv: -kv[1]):
            print(f"    {rule:22s} {hits}")
    if failed:
        print(f"  never asked  {failed}   — the ask itself failed or timed out")

    return 0


# One of each shape the report depends on — including a line with `slow=true`
# present and one with it absent, and the older quoted-value form the caller side
# used before it moved to display formatting.
#
# The caller-side lines are captured from real log files. The refusal line's
# field shape is additionally pinned on the Rust side by
# `the_refusal_line_carries_analyzer_readable_fields`, which is the stronger
# pin: it re-derives the bytes on every run, so a `rule` that stopped being
# countable fails there rather than turning into a zero here.
SAMPLES = [
    ("2026-07-29T02:55:53.336913Z  INFO tugapp::local_model: local model request "
     "task=classify transport=socket outcome=ok elapsed_ms=2291 input_chars=2 "
     "output_chars=5 model=ternary-bonsai-8b-2bit slow=true",
     "tugapp::local_model",
     {"task": "classify", "transport": "socket", "outcome": "ok",
      "elapsed_ms": "2291", "slow": "true", "model": "ternary-bonsai-8b-2bit"}),
    ("2026-07-29T02:54:53.713325Z  INFO tugapp::local_model: local model request "
     "task=prewarm transport=local outcome=ok elapsed_ms=1728 input_chars=0 "
     "output_chars=0 model=ternary-bonsai-8b-2bit",
     "tugapp::local_model",
     {"task": "prewarm", "transport": "local", "outcome": "ok", "elapsed_ms": "1728"}),
    ("2026-07-29T03:01:20.433928Z  INFO tugcast::local_model: local model call "
     "task=classify outcome=ok elapsed_ms=547",
     "tugcast::local_model",
     {"task": "classify", "outcome": "ok", "elapsed_ms": "547"}),
    ("2026-07-29T03:00:35.441476Z  INFO tugcast::local_model: local model call "
     'task="classify" outcome="ok" elapsed_ms=1003 slow=true',
     "tugcast::local_model",
     {"task": "classify", "outcome": "ok", "elapsed_ms": "1003", "slow": "true"}),
    # The current caller-side shape. The three above it are accumulated
    # history from when inference ran on-device: the parser still has to read
    # them, so a log spanning the swap reports as one series.
    ("2026-08-06T09:14:02.118004Z  INFO tugcast::shared_agent: shared agent call "
     "task=classify outcome=ok elapsed_ms=903",
     "tugcast::shared_agent",
     {"task": "classify", "outcome": "ok", "elapsed_ms": "903"}),
    ("2026-08-06T09:14:31.552918Z  INFO tugcast::shared_agent: shared agent call "
     "task=summarize outcome=failed elapsed_ms=6001 slow=true",
     "tugcast::shared_agent",
     {"task": "summarize", "outcome": "failed", "elapsed_ms": "6001", "slow": "true"}),
    ("2026-08-17T09:20:02.118004Z  INFO tugcast::shared_agent: shared agent call "
     "task=synopsis outcome=ok elapsed_ms=1842",
     "tugcast::shared_agent",
     {"task": "synopsis", "outcome": "ok", "elapsed_ms": "1842"}),
    # The socket verb's own answer, which `run.py` reads back.
    ("2026-08-17T09:20:02.118210Z  INFO tugcast::shared_agent: shared agent synopsis "
     'answered task="synopsis" raw=Repair the download resume offset. '
     "line=Repair the download resume offset normalized=true clipped=false",
     "tugcast::shared_agent",
     {"task": "synopsis", "normalized": "true", "clipped": "false"}),
    # The feed's own write. `raw` and `synopsis` are both unquoted, so a field
    # split recovers only their first word — which is why the flags this report
    # counts sit behind them rather than in front.
    ("2026-08-17T09:22:09.957764Z  INFO tugcast::feeds::session_synopsis: session "
     "synopsis: written session=s1 row=claude-1 elapsed_ms=2720 raw=Repair the "
     "download resume offset. synopsis=Repair the download resume offset "
     "normalized=true clipped=false",
     "tugcast::feeds::session_synopsis",
     {"session": "s1", "row": "claude-1", "elapsed_ms": "2720",
      "normalized": "true", "clipped": "false"}),
    # The grounding gate's refusal — `rule` space-free so it can be counted.
    ("2026-08-17T09:24:11.100200Z  INFO tugcast::feeds::session_synopsis: session "
     "synopsis: refused session=s1 rule=ungrounded "
     'synopsis="Harvest the mango orchard" detail="harvest mango orchard"',
     "tugcast::feeds::session_synopsis",
     {"session": "s1", "rule": "ungrounded",
      "synopsis": "Harvest the mango orchard",
      "detail": "harvest mango orchard"}),
    ("2026-08-17T09:26:41.220000Z  WARN tugcast::feeds::session_synopsis: session "
     "synopsis: ask failed error=agent unavailable session=s2 elapsed_ms=6001",
     "tugcast::feeds::session_synopsis",
     {"session": "s2", "elapsed_ms": "6001"}),
]


def self_test() -> int:
    failures = 0
    for line, want_target, want_fields in SAMPLES:
        got = parse(line)
        if got is None:
            print(f"FAIL: did not parse: {line[:70]}…")
            failures += 1
            continue
        target, _, fields = got
        if target != want_target:
            print(f"FAIL: target {target!r} != {want_target!r}")
            failures += 1
        for key, want in want_fields.items():
            if fields.get(key) != want:
                print(f"FAIL: {key}={fields.get(key)!r} != {want!r} in {line[:60]}…")
                failures += 1

    # A line that is not one of ours must not parse as one of ours.
    assert parse("this is not a log line") is None

    print(f"{len(SAMPLES)} sample lines, {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
