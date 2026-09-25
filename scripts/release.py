#!/usr/bin/env python3
"""Cut a Tug release, one confirmed command at a time.

The release used to be a chain of seven commands typed in an order one person
remembered. This is that chain, with the order written down: the script probes
where the release already stands, works out which step is next, and then walks
bump -> draft the notes -> show them -> commit -> push -> bless -> dispatch ->
watch. Before every command that changes state it prints the exact command and
asks y/N, defaulting to N. Read-only probes run without asking, because asking
about a read teaches the habit of answering y without reading.

Nothing here is new machinery. `just version-bump`, `just bless` and
`scripts/watch-release-run.sh` already exist and already know their jobs; this
script is the order they go in, plus one `claude -p` call that drafts the notes.

Every step is idempotent and the run is resumable: declining a row, or a step
that fails, ends the run, and running the same command again picks up from the
probe. Standard library only -- the machine has Homebrew Python and nothing
else is promised.

Usage: release.py [major|minor|patch] [--force] [--dry-run] [emphasis words...]
"""

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# The model that drafts the release notes, named once. Sonnet is the choice:
# turning a commit range into ten lines of reader-facing prose is a summarising
# task, so the largest model is not what it wants -- but the notes are rendered
# in the update popover in front of a real user, which is further than a small
# model's prose usually carries. Tune the voice in release-notes-prompt.md
# first; change this only when the prompt has stopped being the problem.
RELEASE_NOTES_MODEL = "claude-sonnet-5"

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSION_SH = "tugrust/scripts/version.sh"
NOTES_PROMPT = REPO_ROOT / "scripts" / "release-notes-prompt.md"

# Exactly what version.sh rewrites on a bump. Named here because two things
# need the list: preflight, which tolerates dirt in these files and nowhere
# else, and the commit row, which stages by path so that other work in the tree
# is never swept into a release commit.
BUMPED_FILES = [
    "tugrust/Cargo.toml",
    "tugrust/Cargo.lock",
    "tugcode/package.json",
    "tugdeck/package.json",
    "tugapp/Info.plist",
]

# version.sh's seeded stub, tested for by its known text the way `just bless`
# tests for it. Never a length heuristic: a word count gets this wrong in both
# directions.
SEED_MARKERS = (
    "Delete this comment",
    "What changed, for someone who has been using",
)

# How long to wait for a dispatched run to be listed. `gh workflow run` returns
# before its run appears, and a minute is what the recipe this replaces waited.
RUN_APPEAR_TRIES = 30
RUN_APPEAR_INTERVAL = 2

# Set once in main() so a declined row can say what resumes the run.
INVOCATION = "just release"

DRY_RUN = False


# ---------------------------------------------------------------- output ----


def say(text=""):
    print(text, flush=True)


def refuse(text):
    """One line, and out. Preflight's whole vocabulary."""
    print(f"release: {text}", file=sys.stderr, flush=True)
    sys.exit(1)


def stop(text):
    """End the run part-way through, and say what resumes it."""
    say()
    say(text)
    say(f"Nothing further was run. Resume with: {INVOCATION}")
    sys.exit(0)


def rel(path):
    """A repo-relative path to show a person, or the absolute one if it is not
    under the repository at all -- display is never worth an exception."""
    try:
        return str(Path(path).relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def shell_word(word):
    """One argument, quoted the way a shell wants it.

    Not repr(): a commit body is a real argument with real newlines in it, and
    repr turns those into backslash-n on one enormous line -- which is no
    longer the command being run, and is unreadable besides. Single quotes
    keep the newlines where they are.
    """
    if word and re.fullmatch(r"[A-Za-z0-9_./=:@-]+", word):
        return word
    return "'" + word.replace("'", "'\\''") + "'"


def quote(argv):
    """The command as a person would type it."""
    return " ".join(shell_word(word) for word in argv)


# ----------------------------------------------------------------- shell ----


def read(argv, check=True):
    """Run a read-only command and return its stdout, stripped.

    Reads run in a dry run too: the probe is how the script knows where the
    release stands, and a dry run that skipped it would be printing a plan for
    a tree it never looked at.
    """
    proc = subprocess.run(
        argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    if check and proc.returncode != 0:
        return None
    return proc.stdout.strip()


def read_rc(argv):
    """Run a read-only command for its exit code alone."""
    return subprocess.run(
        argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False
    ).returncode


def show_row(argv, why=None):
    """Print the exact command a row is about, and why it is about to run."""
    say()
    if why:
        say(why)
    say(f"    {quote(argv)}")


def confirm(question="  Run it?", choices="[y/N] "):
    """Ask, defaulting to N. Returns the reply lowercased; "" for a bare Enter.

    A dry run answers nothing and returns "": it shows rows and takes none.
    """
    if DRY_RUN:
        say("  [dry run] not asked, not run")
        return ""
    try:
        return input(f"{question} {choices}").strip().lower()
    except EOFError:
        return ""


def row_many(argvs, why=None):
    """Several commands behind one y/N, run in order.

    One gesture, one question: staging and committing are not two decisions,
    and asking twice would teach the habit of answering y without reading. The
    first non-zero exit ends the run, the same way an N does.
    """
    say()
    if why:
        say(why)
    for argv in argvs:
        say(f"    {quote(argv)}")

    if DRY_RUN:
        say("  [dry run] not asked, not run")
        return
    if confirm() not in ("y", "yes"):
        stop("Declined.")

    say()
    for argv in argvs:
        proc = subprocess.run(argv, cwd=REPO_ROOT, check=False)
        if proc.returncode != 0:
            stop(f"`{quote(argv)}` exited {proc.returncode}.")


def row(argv, why=None):
    """Show a state-changing command, ask y/N (default N), run it on y.

    This is the interface the whole script is: the user sees the exact command
    before it runs, and N is never a dead end because the run is resumable.
    """
    row_many([argv], why)


# ------------------------------------------------------------- preflight ----


def preflight():
    """Refuse early, in one line, naming what is wrong.

    Four things make a release run pointless before it starts, and each of
    them is cheaper to find here than three rows in.
    """
    branch = read(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if branch != "main":
        refuse(f"HEAD is on '{branch}', not main — a release is cut from main")

    if shutil.which("gh") is None:
        refuse("gh not found — the release is dispatched through GitHub Actions")
    if read_rc(["gh", "auth", "status"]) != 0:
        refuse("gh is not authenticated — run 'gh auth login'")

    if shutil.which("claude") is None:
        refuse("claude not found on PATH — it is what drafts the release notes")

    if not NOTES_PROMPT.is_file():
        refuse(f"{rel(NOTES_PROMPT)} is missing — it is the notes prompt")

    dirt = [p for p in porcelain_paths() if p not in BUMPED_FILES and not p.startswith("release-notes/")]
    if dirt:
        shown = ", ".join(dirt[:4]) + (f" and {len(dirt) - 4} more" if len(dirt) > 4 else "")
        refuse(f"the tree has changes that are not the bump's: {shown}")


def porcelain_paths():
    """Every path git reports as changed, including both sides of a rename.

    Read raw rather than through read(): porcelain's status field is two
    columns, and an unstaged change leaves the first one blank, so stripping
    the output eats the leading space off the first line and takes the first
    character of that path with it. Every tree version.sh has just bumped and
    nobody has staged looks exactly like that.
    """
    proc = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    out = proc.stdout if proc.returncode == 0 else ""
    paths = []
    for line in out.splitlines():
        if not line.strip():
            continue
        rest = line[3:]
        # A rename reports "old -> new"; both sides count as dirt.
        for part in rest.split(" -> "):
            part = part.strip().strip('"')
            if part:
                paths.append(part)
    return paths


# ----------------------------------------------------------------- probe ----


class State:
    """Where the release stands, from four reads and nothing else.

    This is the old skill's best idea: ask before writing. An abandoned bump,
    a notes file already written, a release already in flight -- each leaves a
    mark these reads can see, so a rerun does the step that is missing rather
    than the step that is first.
    """

    def __init__(self):
        self.version = None
        self.tag = None  # True published, False absent, None unknown
        self.notes_path = None
        self.notes_exists = False
        self.notes_is_seed = False
        self.tree_clean = False
        self.head_pushed = False
        self.head_sha = None
        self.remote_sha = None


def probe():
    st = State()

    # 1. The version, from the one file that is the source of truth.
    st.version = read([VERSION_SH, "show"])
    if not st.version:
        refuse("cannot read a version from tugrust/Cargo.toml")

    # 2. Does origin already have the tag for it? Three outcomes, never two:
    #    exit 0 is published, an HTTP 404 is absent, and anything else is a
    #    network this script should not guess about.
    proc = subprocess.run(
        ["gh", "api", f"repos/{{owner}}/{{repo}}/git/ref/tags/v{st.version}"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if proc.returncode == 0:
        st.tag = True
    elif "HTTP 404" in proc.stderr:
        st.tag = False
    else:
        st.tag = None

    # 3. The notes file: absent, still the seed, or written.
    st.notes_path = REPO_ROOT / "release-notes" / f"{st.version}.md"
    st.notes_exists = st.notes_path.is_file()
    if st.notes_exists:
        body = st.notes_path.read_text()
        st.notes_is_seed = any(marker in body for marker in SEED_MARKERS)

    # 4. Is the commit CI would build the one being looked at?
    st.tree_clean = not porcelain_paths()
    st.head_sha = read(["git", "rev-parse", "HEAD"])
    st.remote_sha = read(
        ["gh", "api", "repos/{owner}/{repo}/branches/main", "--jq", ".commit.sha"]
    )
    st.head_pushed = bool(st.head_sha) and st.head_sha == st.remote_sha

    return st


def report(st):
    say(f"release {st.version}")
    say()
    tag = {True: "published on origin", False: "not on origin", None: "UNKNOWN (cannot reach origin)"}[st.tag]
    say(f"  {('tag v' + st.version):<16} {tag}")
    if not st.notes_exists:
        notes = "absent (a bump seeds it)"
    elif st.notes_is_seed:
        notes = "still version.sh's seed"
    else:
        notes = "written"
    say(f"  {'release notes':<16} {notes}")
    say(f"  {'working tree':<16} {'clean' if st.tree_clean else 'dirty'}")
    if st.head_sha is None or st.remote_sha is None:
        pushed = "UNKNOWN (cannot reach origin)"
    elif st.head_pushed:
        pushed = f"pushed ({st.head_sha[:9]} == origin/main)"
    else:
        pushed = f"{st.head_sha[:9]} is not origin/main {st.remote_sha[:9]}"
    say(f"  {'HEAD':<16} {pushed}")


# ------------------------------------------------------------------ plan ----
#
# The walking order is bump -> draft -> show -> commit -> push -> bless -> dispatch.
# Every one of them is idempotent, so a rerun skips the ones already done, and
# the probe is what says which is next.
#
# bless sits between push and dispatch and is never what the probe *starts* at:
# it is read-only, it gates dispatch by exit code, and a resume that came in at
# dispatch still has to pass through it.
ORDER = ["bump", "draft", "show", "commit", "push", "bless", "dispatch"]


def decide_next(st, component):
    """Which step the probe says is next, or None when there is nothing to do.

    `component` is set when the command line named one, which forces a bump
    even from a state that would otherwise resume mid-release.
    """
    if st.tag is None:
        stop("Cannot reach origin to tell whether this version is already released.")

    if component or st.tag:
        return "bump"
    if not st.notes_exists or st.notes_is_seed:
        return "draft"
    if not st.tree_clean:
        return "commit"
    if not st.head_pushed:
        return "push"
    return "bless"


# --------------------------------------------------------------- walking ----


def step_bump(st, component):
    """Bump the version everywhere, then look again.

    version.sh does the work -- five files and a seeded notes file -- and
    `just version-bump` is the spelling that also names the notes as the thing
    to write next. After it runs the version has changed, so every read the
    probe made is stale and the probe is taken again.
    """
    row(
        ["just", "version-bump", component],
        why=f"Bump the {component} component up from {st.version}:",
    )
    if DRY_RUN:
        say()
        say(f"  [dry run] the bump did not run, so the rows below are still about {st.version}")
        return st
    return probe()


def previous_release():
    """The newest v<M.m.p> tag on origin, as (name, commit sha).

    The sha matters more than the name. Nothing in this repository fetches
    tags, so a checkout usually has none of them, and `git log v0.8.11..HEAD`
    there fails with "unknown revision" -- which reads, to anything testing
    for an empty range, exactly like a release with no commits in it. The sha
    ls-remote hands back alongside the ref is in the checkout whenever main is,
    so that is what the range is taken against.

    `ls-remote` asks rather than fetches: it writes no ref under .git/ and
    moves none, the same reason bless reaches for `gh api`. An annotated tag
    lists twice, and the `^{}` line is the commit the release was cut from
    where the plain line is the tag object, so the `^{}` sha wins.
    """
    out = read(["git", "ls-remote", "--tags", "origin", "refs/tags/v*"])
    if out is None:
        return None, None
    commits = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        sha, ref = parts[0].strip(), parts[1].strip()
        name = ref.rsplit("refs/tags/", 1)[-1]
        deref = name.endswith("^{}")
        if deref:
            name = name[:-3]
        if not re.fullmatch(r"v\d+\.\d+\.\d+", name):
            continue
        if deref or name not in commits:
            commits[name] = sha
    if not commits:
        return None, None
    newest = max(commits, key=lambda n: tuple(int(g) for g in n[1:].split(".")))
    return newest, commits[newest]


def compose_prompt(version, emphasis, tag, log):
    """The prompt file, then the three things only this run knows."""
    parts = [NOTES_PROMPT.read_text().rstrip(), "", "---", ""]
    parts.append(f"The version is {version}.")
    if emphasis:
        parts += ["", f"Emphasis asked for on the command line: {' '.join(emphasis)}"]
    parts += ["", f"The commits in {tag}..HEAD:", "", log]
    return "\n".join(parts) + "\n"


def step_draft(st, emphasis):
    """Draft the notes with one tool-less `claude -p`; the script writes the file.

    The model never touches the tree: it is handed a prompt on stdin and its
    stdout is written under the heading version.sh seeded. It runs only while
    the file is still that seed, so notes somebody has already written are
    never drafted over. An empty range or an empty reply ends the run instead
    of seeding plausible prose -- that is the one failure that would ship in
    front of a user rather than merely wasting a minute.
    """
    if not st.notes_path.is_file():
        stop(f"{rel(st.notes_path)} is missing — a bump is what seeds it.\n"
             f"Bump with `{INVOCATION} patch`, or write the notes by hand.")
    if not st.notes_is_seed:
        say()
        say(f"  {rel(st.notes_path)} is already written — not drafting over it")
        return st

    tag, sha = previous_release()
    if tag is None:
        stop("No v<version> tag on origin, so there is no range to read. Write the notes by hand.")
    if read_rc(["git", "cat-file", "-e", f"{sha}^{{commit}}"]) != 0:
        stop(f"{tag} is {sha[:9]} on origin and this checkout does not have that commit.\n"
             f"Fetch main and run again.")
    log = read(["git", "log", "--format=%s%n%b", f"{sha}..HEAD"])
    if log is None:
        stop(f"Could not read the log for {tag}..HEAD ({sha[:9]}..HEAD).")
    if not log.strip():
        stop(f"Nothing in {tag}..HEAD — there is no release to describe.")
    subjects = read(["git", "log", "--format=%s", f"{sha}..HEAD"]) or ""
    count = len([s for s in subjects.splitlines() if s.strip()])

    argv = [
        "claude", "-p",
        "--output-format", "text",
        "--tools", "",
        "--model", RELEASE_NOTES_MODEL,
    ]
    show_row(
        argv,
        why=f"Draft the notes for {st.version} — {count} commits in {tag}..HEAD ({sha[:9]}..HEAD),\n"
            f"with scripts/release-notes-prompt.md on stdin, and no tools:",
    )
    if DRY_RUN:
        say("  [dry run] not asked, not run")
        return st
    if confirm() not in ("y", "yes"):
        stop("Declined.")

    say()
    say(f"  Asking {RELEASE_NOTES_MODEL}…")
    proc = subprocess.run(
        argv, cwd=REPO_ROOT, input=compose_prompt(st.version, emphasis, tag, log),
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        stop(f"claude exited {proc.returncode}: {proc.stderr.strip()[:400]}")
    draft = proc.stdout.strip()
    if not draft:
        stop("The model returned nothing — the notes are still the seed and nothing was written.")

    st.notes_path.write_text(f"# Tug {st.version}\n\n{draft}\n")
    st.notes_is_seed = False
    say(f"  Wrote {rel(st.notes_path)}")
    return st


def step_show(st):
    """Print the notes, and offer EDIT_OPENER once before going on.

    One question, because the notes are rarely worth editing by hand: y goes
    on, e opens them and asks again, anything else ends the run. Opening does
    not block -- the file is read again at the commit row, so a tune made
    after the opener returns is still the one that ships.
    """
    say()
    say(f"  {rel(st.notes_path)}")
    say()
    for line in st.notes_path.read_text().rstrip().splitlines():
        say(f"  | {line}")

    opener = os.environ.get("EDIT_OPENER", "").strip()
    while True:
        say()
        if not opener:
            say("  EDIT_OPENER is not set, so these are printed only.")
            answer = confirm("  Go on with these notes?")
        else:
            answer = confirm(f"  Go on with these notes, or open them in {opener} first?", "[y/e/N] ")
        if answer in ("y", "yes"):
            return
        if opener and answer == "e":
            subprocess.Popen([opener, str(st.notes_path)], cwd=REPO_ROOT)
            say(f"  Opened in {opener}. The file is read again at the commit row,")
            say("  so tune it and then answer y.")
            continue
        if DRY_RUN:
            return
        stop("Declined.")


def notes_prose(text):
    """The notes with the heading and any HTML comment taken out."""
    body = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    lines = body.splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("# Tug")):
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def commit_message(version, notes_text):
    """The release commit's subject and body, in this repository's shape.

    The subject is the version and the notes' opening *sentence* -- not the
    whole first line, which is a paragraph. That is what
    `tugarc(0.8.11): A release about motion and legibility` was, and it is why
    the notes are worth opening with a sentence that can carry a subject line.

    The body is the notes' prose, read from the file at the moment the row is
    composed, so a tune made through EDIT_OPENER after the draft was printed is
    the one that ships.
    """
    prose = notes_prose(notes_text)
    lead = next(
        (l.strip() for l in prose.splitlines()
         if l.strip() and not l.lstrip().startswith("#")),
        "",
    )
    sentence = lead.split(". ")[0].rstrip(".").lstrip("-* ").strip()
    subject = f"tugarc({version}): {sentence}" if sentence else f"tugarc({version}): Release {version}"
    return subject, prose


def step_commit(st):
    """Stage the bump's files and the notes by path, then commit them.

    By path, never `git add -A`: a release commit that swept in whatever else
    happened to be in the tree is the failure this list exists to prevent, and
    it is the same list preflight tolerates dirt in. The message is printed in
    full before the row, because it is the durable prose the base keeps and the
    one thing here worth reading twice.
    """
    if not st.notes_path.is_file():
        stop(f"{rel(st.notes_path)} is missing — there is nothing to commit.")
    subject, body = commit_message(st.version, st.notes_path.read_text())

    say()
    say("  The commit message:")
    say()
    say(f"  | {subject}")
    say("  |")
    for line in body.splitlines():
        say(f"  | {line}")

    paths = BUMPED_FILES + [rel(st.notes_path)]
    row_many(
        [["git", "add"] + paths, ["git", "commit", "-m", subject, "-m", body]],
        why=f"Commit the {st.version} bump and its notes — these paths and no others:",
    )


def step_push(st):
    """Push, as its own row. CI builds the pushed ref, not this one."""
    row(
        ["git", "push", "origin", "main"],
        why=f"Push {st.version} to origin/main — CI builds the pushed ref, not yours:",
    )


def step_bless(force):
    """Run bless unasked, and let its exit code gate the dispatch.

    Unasked because it is read-only: it writes no file and moves no ref, and
    asking about a read teaches the habit of answering y without reading. A
    gate that warns is a gate that is read past, so a non-zero exit ends the
    run. --force is the only way past it and says so out loud -- a checklist
    this young will be wrong about something, and the answer to a wrong check
    is to ship and then fix the check rather than to delete the gate.
    """
    argv = ["just", "bless"]
    say()
    say("Blessing. Read-only, so this one is not asked:")
    say(f"    {quote(argv)}")
    if DRY_RUN:
        say("  [dry run] not run")
        return
    say()
    if subprocess.run(argv, cwd=REPO_ROOT, check=False).returncode == 0:
        return
    if not force:
        stop("NOT blessed. Fix what bless named above — or, if the check itself is\n"
             "wrong, run again with --force and then fix the check.")
    say()
    say("==> --force: going on over a failed blessing.")


def newest_run_id():
    """The newest release.yml run id, or "" when there is none to read."""
    return read([
        "gh", "run", "list", "--workflow", "release.yml",
        "--limit", "1", "--json", "databaseId", "--jq", ".[].databaseId",
    ]) or ""


def step_dispatch(st):
    """Dispatch the release workflow, find its run, and hand the terminal over.

    The run id is found by comparing against the newest run recorded *before*
    the dispatch, because `gh workflow run` returns before its run is listed,
    and watching whatever happens to be newest would follow the previous
    release for a few minutes and then report it finished.

    The watch itself is scripts/watch-release-run.sh, which already exists and
    already prints durations -- `gh run watch` prints a checklist and no
    durations, so a run that is working and a run that is wedged look exactly
    alike for the six minutes the DMG step takes. It is composed here, never
    reimplemented, and it is handed the process rather than run as a child, so
    ^C reaches it and its exit status is this script's.
    """
    watcher = REPO_ROOT / "scripts" / "watch-release-run.sh"
    if not watcher.is_file():
        stop(f"{rel(watcher)} is missing — it is what watches the run.")

    prior = newest_run_id()
    row(
        ["gh", "workflow", "run", "release.yml", "--ref", "main"],
        why=f"Dispatch Stable Release for {st.version} on main. This is the row that\n"
            f"ships {st.version} to everyone running Tug:",
    )

    if DRY_RUN:
        show_row(
            ["bash", rel(watcher), "<the new run id>"],
            why="Then wait for the run to be listed and hand the terminal to the watcher:",
        )
        say("  [dry run] not asked, not run")
        return

    say()
    say("==> Waiting for the run to appear")
    run_id = ""
    for _ in range(RUN_APPEAR_TRIES):
        time.sleep(RUN_APPEAR_INTERVAL)
        candidate = newest_run_id()
        if candidate and candidate != prior:
            run_id = candidate
            break

    if not run_id:
        say()
        say("Dispatched, but no new run was listed within a minute, so the run id")
        say("is unknown. The dispatch itself went through. Follow it by hand with:")
        say("    gh run list --workflow release.yml")
        return

    argv = ["bash", str(watcher), run_id]
    say()
    say(f"==> Watching run {run_id}")
    say(f"    {quote(['bash', rel(watcher), run_id])}")
    say()
    os.execvp(argv[0], argv)


# ------------------------------------------------------------------ main ----


def parse_args(argv):
    component = None
    force = False
    dry_run = False
    emphasis = []

    for arg in argv:
        if arg in ("major", "minor", "patch") and component is None and not emphasis:
            component = arg
        elif arg == "--force":
            force = True
        elif arg == "--dry-run":
            dry_run = True
        elif arg in ("-h", "--help"):
            say(__doc__.strip())
            sys.exit(0)
        elif arg.startswith("-"):
            refuse(f"unknown option '{arg}' (see --help)")
        else:
            emphasis.append(arg)

    return component, force, dry_run, emphasis


def main(argv):
    global DRY_RUN, INVOCATION

    component, force, dry_run, emphasis = parse_args(argv)
    DRY_RUN = dry_run
    INVOCATION = " ".join(["just", "release"] + argv)

    if DRY_RUN:
        say("[dry run] every row is printed; nothing is asked and nothing is run")
        say()

    preflight()
    st = probe()
    report(st)

    nxt = decide_next(st, component)
    say()
    say(f"Next: {nxt}")

    # The walk starts wherever the probe said and runs to the end. Each step is
    # idempotent, so resuming into the middle of the order is the ordinary case
    # rather than the exception.
    for name in ORDER[ORDER.index(nxt):]:
        if name == "bump":
            st = step_bump(st, component or "patch")
        elif name == "draft":
            st = step_draft(st, emphasis)
        elif name == "show":
            step_show(st)
        elif name == "commit":
            step_commit(st)
        elif name == "push":
            step_push(st)
        elif name == "bless":
            step_bless(force)
        elif name == "dispatch":
            step_dispatch(st)
        else:
            refuse(f"internal: no step named '{name}'")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
