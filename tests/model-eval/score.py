"""Score one description against the register a session row is written in.

The rubric is mechanical on purpose. There is no ground truth for "what is this
session about" — two correct descriptions can share no words — so nothing here
scores whether a description is *right*. It scores whether it is a description
at all, which is the part that kept going wrong.

Every check traces to a rule of the register `SYNOPSIS_INSTRUCTIONS` asks for:

  verb_first    A description needs a verb; a noun phrase without one is a
                *label*, which is the failure this rubric exists to catch.
                Sessions have no subject to name (the session is the implied
                subject), so the verb leads, in the plain command form.
  within_budget `MAX_SYNOPSIS_CHARS`, the room every surface gives the line.
                The instruction asks for less on purpose; this is the hard edge
                past which the normalizer clips mid-thought.
  sentence_case Only the first word and proper names are capitalized.

Articles and conjunctions are deliberately NOT scored: this is the one line in
the product that gets to read as English, and the instruction says so. Scoring
them was the headline's rule, and it would fail every correct description.

What the normalizer repairs is not scored either — a leading article, a filler
opener, a trailing period, wrapping quotes. Those come back already fixed, so a
check on them would pass unconditionally; `run.py`'s drift report is where they
show up, by comparing the raw answer against the normalized one.

`verbs.txt` is a closed list, so a description opening with a word not on it
scores as a miss and gets read by a human — a model inventing a plausible verb
should cost a look, not pass silently. Add genuinely good verbs to the list;
that is the intended way for it to grow.
"""

import re
from pathlib import Path


def _verbs() -> set[str]:
    out: set[str] = set()
    for line in (Path(__file__).parent / "verbs.txt").read_text().splitlines():
        if not line.lstrip().startswith("#"):
            out.update(word.lower() for word in line.split())
    return out


VERBS = _verbs()

# Mirrors `MAX_SYNOPSIS_CHARS` in `session_synopsis.rs`.
MAX_CHARS = 72

# A capitalized word mid-line is only a violation if it is ordinary prose.
# Identifiers and proper names legitimately keep their capitals, so anything
# that looks like one is exempt: an interior capital (`TugSetup`), all caps
# (`README`), or a dotted path (`session_synopsis.rs`).
IDENTIFIER = re.compile(r"[a-z][A-Z]|\.")
PROPER = {
    "Lens", "Tug", "Rust", "Swift", "Claude", "Sparkle", "Bonsai", "MLX",
    "Maxwell", "Maxwell's", "Makefile", "README", "PATH", "CPU", "Xcode",
    # This project's own surfaces, which a description about it names constantly.
    "Tugdeck", "Tugcast", "Tugcode", "Tugbank", "Tugways", "Tugutil",
    "ConfigureTug", "TugSetup", "Session", "Jots", "Changeset", "DMG",
    "WAL", "JSONL",
}


def score(line: str) -> dict:
    """Score one description."""
    words = line.split()
    if not words:
        return {
            "line": line, "words": 0, "chars": 0, "verb_first": False,
            "within_budget": True, "sentence_case": True, "passes": False,
        }

    first = re.sub(r"[^A-Za-z-]", "", words[0]).lower()

    def is_proper(word: str) -> bool:
        core = word.strip(",.;:!?")
        return core in PROPER or core.isupper() or bool(IDENTIFIER.search(core))

    stray_capitals = [w for w in words[1:] if w[:1].isupper() and not is_proper(w)]

    result = {
        "line": line,
        "words": len(words),
        "chars": len(line),
        "verb_first": first in VERBS,
        "within_budget": len(line) <= MAX_CHARS,
        "sentence_case": not stray_capitals,
    }
    result["passes"] = all(result[k] for k in CHECKS)
    return result


CHECKS = ("verb_first", "within_budget", "sentence_case")


def flags(result: dict) -> str:
    """A three-slot summary, one letter per failed check."""
    return "".join(
        "." if result[k] else letter
        for k, letter in zip(CHECKS, "VBC")
    )
