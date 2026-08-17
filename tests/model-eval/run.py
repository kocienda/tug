"""Score the SharedAgent's session descriptions against a live Tug instance.

Drives the real thing end to end: the frozen digest goes over the control
socket to the running app, the SharedAgent's own `SYNOPSIS_INSTRUCTIONS` job
prompt and its Haiku worker answer, and tugcast normalizes the answer through
the synopsis register before logging it. What this scores is therefore the
string a session row would actually wear — prompt, model, and normalizer
together — not a re-implementation of any of them.

    just model-eval                 # against debug-main
    just model-eval release-main

Needs a running instance with the `synopsis` tenant left on. Every description
is reported whether or not it passes; the summary is a rate, not a gate,
because a description can satisfy every mechanical rule and still describe the
session badly. Read the lines.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import ask, log_path  # noqa: E402
from score import CHECKS, flags, score  # noqa: E402

CORPUS = Path(__file__).parent / "corpus"
PROMPTS = Path(__file__).parents[2] / "tugrust/crates/tugcast/src/shared_agent.rs"

# Punctuation to ignore when matching an example's words against a digest, so
# `tug-pulse.css` and `tug-pulse.css)` are the same word. Hyphens and slashes
# SPLIT rather than being trimmed: an example reading `command-line calculator`
# has to match a digest asking for a `command line calculator`, and the first
# version of this check missed exactly that pair.
TRIM = ".,:;!?\"'`()[]<>"
SPLIT = str.maketrans("-/_", "   ")


def stem(word: str) -> str:
    """A crude stem, enough that `restart` matches `restarts` and `resumed`.

    Deliberately blunt. A false match here costs one reworded example; a missed
    one costs a corpus that scores copying, which is the whole point. The first
    version compared surface forms and let `Fix download resume restart` through
    against a digest reading `the download restarts from zero when resumed`.
    """
    for suffix in ("ing", "ed", "es", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            word = word[: -len(suffix)]
            break
    return word.rstrip("e")


def words(text: str) -> set[str]:
    """The text's comparable words, dotted tokens contributing their parts too.

    `nocturne.css` yields `nocturne`, `css`, and itself, matching
    `content_words` in `session_synopsis.rs`: a digest writes filenames and a
    72-character description has room to name one, so a check that only saw the
    dotted whole would call an example decontaminated because it wrote
    `nocturne` where the digest wrote `nocturne.css`.
    """
    out = set()
    for raw in text.translate(SPLIT).split():
        bare = raw.strip(TRIM).lower()
        out.add(stem(bare))
        if "." in bare:
            out.update(stem(part) for part in bare.split("."))
    return out - {""}


def _rust_prompt(name: str) -> str | None:
    """The text of one `const <name>: &str` prompt in `shared_agent.rs`,
    string-literal content only.

    Read out of the Rust source rather than duplicated here — a copy would be
    the thing that goes stale while reporting all is well, which is the failure
    this whole guard exists to catch. The cost is that a rename silently returns
    nothing, so callers must treat `None` as a failure, never as a clean bill.
    """
    if not PROMPTS.exists():
        return None
    text = PROMPTS.read_text()
    anchor = f"const {name}: &str"
    if anchor not in text:
        return None
    region = _through_closing_paren(text, anchor)
    literals = re.findall(r'"((?:[^"\\]|\\.)*)"', region, re.S)
    joined = "".join(literals)
    # Rust escapes, in the order that keeps `\\n` from becoming a newline:
    # backslash-newline continuation (eats leading whitespace), then \n, \",
    # and finally the literal backslash.
    joined = re.sub(r"\\\n\s*", "", joined)
    return (
        joined.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    )


def _through_closing_paren(text: str, anchor: str) -> str:
    """The source region from `anchor` through the next `)`/`}` at column 0 —
    how far a prompt `concat!(…)` or a plain literal runs."""
    start = text.index(anchor)
    end = min(
        (i for i in (text.find(f"\n{close}", start) for close in (")", "}")) if i != -1),
        default=len(text),
    )
    return text[start:end]


def synopsis_prompt() -> str | None:
    """The description lane's job prompt, for the drift report and the
    contamination guard. `None` means the extractor went blind."""
    return _rust_prompt("SYNOPSIS_INSTRUCTIONS")


def example_lines() -> list[str]:
    """The bare description examples in that prompt — the line after each
    `DESCRIPTION:` marker.

    Anchored on the marker rather than on the shape of the line, because the
    prompt's paired format puts one there and nothing else does. The version
    before this recognized an example by being 2-6 words long and opening on a
    known verb, which was a headline budget in disguise: at 72 characters an
    example can run ten or eleven words, and every one of those would have
    vanished from `lifted` and from `contamination` — the two checks this
    function feeds — while both kept reporting all clear.

    Widening the length bound was not the fix. That bound was doing a second
    job: keeping the instruction prose out, and some of that prose is itself
    short and verb-initial (`Not "Fixing", not "Working on" — Rework, Repair.`).
    The marker is exact where any length heuristic is a guess, and it needs no
    verb list at all.

    The Haiku prompt currently carries no `DESCRIPTION:` examples at all — the
    few-shot scaffolding propped up the weak local model and was dropped in the
    SharedAgent port — so an example found here is a later addition, and the
    guards below apply to it the day it appears.
    """
    source = synopsis_prompt()
    if source is None:
        return []
    out = []
    lines = source.splitlines()
    for i, line in enumerate(lines[:-1]):
        if line.strip() == "DESCRIPTION:":
            example = lines[i + 1].strip()
            if example:
                out.append(example)
    return out


def lifted(line: str) -> str | None:
    """The prompt example this description copied, if it copied one.

    Only meaningful because the examples are disjoint from the corpus (see
    `contamination`): with an answer key in the instructions a match would be
    indistinguishable from a correct answer, and with the key gone a match can
    only be a lift. That is the whole payoff of decontamination — the leak that
    was visible in production as `Fix download resume restart` against sessions
    about anything else becomes a thing this harness can name.

    Matched on the word set rather than the exact string, so a copy that drops a
    preposition or reorders is still caught.
    """
    have = words(line)
    for example in example_lines():
        if have == words(example):
            return example
    return None


def contamination(digests: list[Path]) -> list[tuple[str, str]]:
    """Examples whose subject is a corpus digest — i.e. answer keys.

    An example is contaminated when every word of it except its opening verb
    appears somewhere in one digest. That digest's expected answer is then
    sitting in the instructions, and a model can score it by copying rather
    than by reading, which is how this harness once reported 13/13 over a
    prompt that was leaking into production. Scoring a contaminated corpus is
    worse than not scoring, so `run.py` refuses rather than warns.
    """
    hits: list[tuple[str, str]] = []
    examples = example_lines()
    for digest in digests:
        have = words(digest.read_text())
        name = digest.name.removesuffix(".digest.txt")
        for example in examples:
            subject = words(example) - words(example.split()[0])
            if subject and subject <= have and (example, name) not in hits:
                hits.append((example, name))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("instance", nargs="?", default="debug-main")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--json", type=Path, help="write the full result set here")
    args = ap.parse_args()

    path = log_path(args.instance)
    if path is None:
        print(f"no tugcast log for instance {args.instance!r}", file=sys.stderr)
        return 2
    digests = sorted(CORPUS.glob("*.digest.txt"))
    if not digests:
        print("no corpus; run `cargo nextest run corpus_digests` first", file=sys.stderr)
        return 2

    # An extraction that finds nothing looks exactly like a clean bill, so the
    # guard checks itself first. A Rust rename is the way this goes silent.
    # Zero examples inside a successfully extracted prompt is the current,
    # legitimate state (the Haiku prompt is example-free); no prompt at all is
    # the extractor gone blind.
    if synopsis_prompt() is None:
        print(
            "prompt extraction from shared_agent.rs came up short — the\n"
            "`SYNOPSIS_INSTRUCTIONS` const moved or was renamed. The\n"
            "contamination guard is blind until this is fixed; it is not\n"
            "reporting that all is well.",
            file=sys.stderr,
        )
        return 2

    leaks = contamination(digests)
    if leaks:
        print("CONTAMINATED — these prompt examples are answer keys:", file=sys.stderr)
        for example, name in leaks:
            print(f"  {example!r} is {name}'s subject", file=sys.stderr)
        print(
            "\nRewrite the example in SYNOPSIS_INSTRUCTIONS (shared_agent.rs)\n"
            "onto work no digest describes. A score over this pair measures\n"
            "copying.",
            file=sys.stderr,
        )
        return 2

    rows, latencies = [], []
    for digest_file in digests:
        name = digest_file.name.removesuffix(".digest.txt")
        answer = ask(digest_file.read_text(), args.instance, path, args.timeout)
        if answer is None:
            print(f"{name:24s} -- NO ANSWER")
            continue
        raw, line, ms = answer
        row = score(line)
        row["name"], row["raw"], row["ms"] = name, raw, ms
        row["lifted"] = lifted(line)
        rows.append(row)
        latencies.append(ms)
        drift = "  (raw: %s)" % raw if raw != line else ""
        copied = "  <- COPIED FROM THE PROMPT" if row["lifted"] else ""
        print(f'{name:24s} {row["chars"]:2d}c [{flags(row)}] {line}{drift}{copied}')

    if not rows:
        print("\nnothing scored — is the instance running with a model installed?")
        return 1

    n = len(rows)
    print("\n" + "=" * 66)
    for check in CHECKS:
        passed = sum(r[check] for r in rows)
        print(f"  {check:16s} {passed:2d}/{n}")
    print(f'  {"all rules":16s} {sum(r["passes"] for r in rows):2d}/{n}')
    print(f'  {"mean chars":16s} {sum(r["chars"] for r in rows) / n:.1f}')
    latencies.sort()
    print(f'  {"median ms":16s} {latencies[n // 2]}')
    copies = [r for r in rows if r["lifted"]]
    print(f'  {"copied examples":16s} {len(copies):2d}/{n}')
    if copies:
        print(f"\n  {len(copies)} description(s) were copied out of the prompt's example")
        print("  block, not written from the digest — the examples are disjoint")
        print("  from the corpus, so a match here cannot be a correct answer:")
        for r in copies:
            print(f'    {r["name"]}: {r["line"]!r}')

    drifted = [r for r in rows if r["raw"] != r["line"]]
    if drifted:
        print(f'\n  {len(drifted)} description(s) needed the normalizer — the prompt is')
        print("  drifting from the register it asks for:")
        for r in drifted:
            print(f'    {r["name"]}: {r["raw"]!r} -> {r["line"]!r}')

    if args.json:
        args.json.write_text(json.dumps(rows, indent=1))
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
