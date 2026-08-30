"""Plumbing for driving a live Tug instance's SharedAgent from a script.

Register scoring (`run.py`), liveness (`liveness.py`), and turnaround analysis
(`analyze.py`) are three different questions, but they all reach the model the
same way: send a digest over the control socket with `tugtool host tell`, then
read the answer back out of the instance's tugcast log. That plumbing lives here
so the three entry points can differ in what they ask rather than in how.
"""

import re
import subprocess
import sys
import time
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# tugcast logs the normalized description beside the raw answer; the two
# differing means the normalizer is covering for a prompt that has drifted. The
# line runs to the normalizer's report fields when they are present and to end
# of line when they are not, so the capture stops at whichever comes first
# rather than swallowing `normalized=…` into the description.
ANSWER = re.compile(r"raw=(?P<raw>.*?) line=(?P<line>.*?)(?= normalized=|\s*$)")

# The classify verdict, logged with the line it judged. The text may contain
# anything including `verdict=`, so the verdict is anchored to end of line and
# the text takes whatever precedes it.
# `grammar=` records which classify prompt ran and was added after this regex
# was first written. Anchoring `verdict=` to end-of-line made every answered
# line invisible the moment a field landed behind it, and the harness read that
# as the model never answering — so the tail is optional and the whole match no
# longer depends on `verdict` being last.
VERDICT = re.compile(
    r"text=(?P<text>.*?) verdict=(?P<verdict>\w+)(?: grammar=(?P<grammar>\w+))?\s*$"
)

INSTANCES = Path.home() / "Library/Application Support/Tug/instances"


def log_path(instance: str) -> Path | None:
    """The instance's newest tugcast log.

    Picked by mtime rather than by today's date: tugcast names the file for the
    UTC day, so an evening run west of Greenwich computes yesterday's name and
    reads a log nothing is being written to.
    """
    logs = INSTANCES / instance / "Logs"
    candidates = sorted(logs.glob("tugcast.log.*"), key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None


def answers(path: Path) -> list[tuple[str, str]]:
    """Every `(raw, normalized)` description the socket verb has drawn, oldest
    first.

    Reads only the verb's own log message. The feed writes its answers under
    `session synopsis: written`, a different line entirely, so a description the
    app composed on its own cadence while this was waiting can never be handed
    back as the answer to a digest nobody asked it about.
    """
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="ignore").splitlines():
        line = ANSI.sub("", line)
        if "shared agent synopsis answered" not in line:
            continue
        m = ANSWER.search(line)
        if m:
            out.append((m.group("raw").strip(), m.group("line").strip()))
    return out


def ask(
    digest: str,
    instance: str,
    path: Path,
    timeout: float,
) -> tuple[str, str, int] | None:
    """Put one digest to the model and read its answer back out of the log."""
    before = len(answers(path))
    started = time.monotonic()
    proc = subprocess.run(
        ["tugtool", "host", "tell", "shared_agent_synopsis",
         "--instance", instance, "-p", f"prompt={digest}"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"  tell failed: {proc.stderr.strip() or proc.stdout.strip()}", file=sys.stderr)
        return None
    while time.monotonic() - started < timeout:
        time.sleep(0.2)
        got = answers(path)
        if len(got) > before:
            raw, line = got[-1]
            return raw, line, round((time.monotonic() - started) * 1000)
    return None


def verdicts(path: Path) -> list[tuple[str, str, bool]]:
    """Every `(line, verdict, read_the_documentation)` classified, oldest first.

    The third element says which classify prompt answered. The two variants ask
    different questions, so a score that could not tell them apart would be
    averaging two measurements.
    """
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="ignore").splitlines():
        line = ANSI.sub("", line)
        if "shared agent classify answered" not in line:
            continue
        m = VERDICT.search(line)
        if m:
            out.append((
                m.group("text").strip(),
                m.group("verdict").strip(),
                m.group("grammar") == "true",
            ))
    return out


def ask_classify(
    text: str, instance: str, path: Path, timeout: float, grammar: str | None = None
) -> tuple[str, int, bool] | None:
    """Put one line to the classifier and read the verdict back out of the log.

    Same shape as `ask`, and for the same reason: the answer is taken from the
    log rather than from the tell's response, because the tell is fire-and-
    forget — it returns as soon as tugcast accepts the action, long before the
    model has decided anything.

    A single-line draft is the only thing the deck ever classifies, so a text
    carrying a newline would not be a case the feature can see; nothing here
    guards against one, because the corpus is the only caller.

    `grammar` is the program's own documentation, sent for a Maybe-band line so
    the app composes its documentation-bearing classify prompt. A grammar is
    multi-line and full of `=`, which `-p` survives because the param parser
    splits on the FIRST `=` only.
    """
    before = len(verdicts(path))
    started = time.monotonic()
    params = ["-p", f"text={text}"]
    if grammar:
        params += ["-p", f"grammar={grammar}"]
    proc = subprocess.run(
        ["tugtool", "host", "tell", "shared_agent_classify",
         "--instance", instance, *params],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"  tell failed: {proc.stderr.strip() or proc.stdout.strip()}", file=sys.stderr)
        return None
    while time.monotonic() - started < timeout:
        time.sleep(0.2)
        got = verdicts(path)
        if len(got) > before:
            _, verdict, read_docs = got[-1]
            return verdict, round((time.monotonic() - started) * 1000), read_docs
    return None


def instance_is_running(instance: str) -> bool:
    """Whether `instance` is live, asked through the registry's own library.

    `tugtool host instance list` is the only correct probe. The raw registry
    file (`$TMPDIR/tug-instances.json`) is deliberately not parsed: dead entries
    are pruned at *read* time through the library — "live" means
    `kill(pid, 0) == 0`, see `tugcore/src/registry.rs` — so a crashed instance
    leaves a stale entry behind that only the library-mediated read filters out.
    Reading the file directly would see that entry, conclude the instance is up,
    and turn a should-skip into a spurious failure.
    """
    proc = subprocess.run(
        ["tugtool", "host", "instance", "list"], capture_output=True, text=True
    )
    if proc.returncode != 0:
        return False
    return any(
        line.split() and line.split()[0] == instance
        for line in proc.stdout.splitlines()
    )
