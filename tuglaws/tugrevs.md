# tugrevs — the edit language

*A small, interpreted language for editing text files from inside a session, executed by `tugutil` so every edit it makes is attributed with proof. Why it exists, the grammar, the transaction semantics, the receipt, and how the gate steers to it. Read this before implementing the interpreter, before adding a verb, or before deciding that a `python3` heredoc is "fine just this once."*

*Cross-references: `[L##]` → [tuglaws.md](tuglaws.md). Attribution vocabulary (proof rows, hints, buckets, the receipt sentinel) is defined in [tracking-changes.md](tracking-changes.md); this page assumes it.*

---

## The problem this solves

The attribution grammar in `tugchanges-core::shell_ops` reads a shell command and proves which files it mutates. It reads `sed -i`, `perl -i`, `tee`, redirections — anything whose operands are in the command text. It cannot read a heredoc body: a body is data, not commands, and is stripped before parsing. So `python3 - <<'PY' … PY`, `python3 -c '…'`, `perl -e`, and `awk` scripts that write repo files land in the Changes card's **UNATTRIBUTED** bucket with at best a `likely` hint, and somebody presses `CLAIM ALL` to repair the ledger by hand.

The model reaches for those interpreters for a reason, and the reason is not that an attributable verb is missing. `tugutil file edit` exists; it covers one literal substitution per invocation, or a unified diff. The moment an edit is multi-line, touches three files, needs quoting the shell fights, or is *computed* — rename every `foo_` prefix, insert after the third match, replace lines 5873–5882 — the cheapest thing in the model's hands is a heredoc into a general-purpose interpreter. The heredoc is the natural shape for a multi-line program. The failure is only that the program's reader is python instead of Tug.

**tugrevs makes the heredoc the happy path.** A `.rev` program is written into a heredoc exactly as a python script would be, but its reader is `tugutil`, which applies it and emits the `TUG-FILE-RECEIPT` the relay already understands. The habit stays; the attribution becomes proof.

```bash
tugrevs <<'REV'
file tugrust/crates/tugdash-core/src/ops.rs
  replace 'entry.stage, "working"' with 'entry.stage, "the git stage"'
  after /^fn redo_replay\b/ insert <<
    let _guard = replay_guard();
  >>
REV
```

---

## Design stance

**Boring on purpose.** tugrevs is a superset of the verbs the model already knows from `ed`, `sed`, and `patch`: `replace`, `sub`, `insert`, `delete`, addresses that are literals, regexes, or line ranges. A bespoke syntax would be generated less reliably, and a malformed program is exactly the moment the model gives up and reaches for python. Every construct here is one the model can write from memory on the first try. Human readability is not a goal, but it falls out of this stance for free and the Changes card is glad of it.

**A program is a transaction.** Every address in the program is resolved against the *original* bytes of every file before a single byte is written. If any op fails to resolve, nothing is written and the run exits non-zero. There is no half-applied multi-file edit, ever. This is the same discipline `tugutil file edit` already holds for the single-substitution case (a no-match exits non-zero with no receipt), extended to a whole program.

**Addresses mean what the model just read.** The model discovers line numbers with `grep -n` and `sed -n 'a,bp'` and then edits. Because resolution happens against original bytes, `lines 5873..5882` in a program refers to the lines the model saw, even if an earlier op in the same program inserted forty lines above them. Ops within a file are applied in address order, bottom-up, so no op shifts another.

**Silence is the enemy.** A no-match is an error. A regex that matches more times than declared is an error. A file that the program names but leaves byte-identical is not in the receipt. Mirrors [tracking-changes.md](tracking-changes.md#verb-receipts): a silently-successful no-op edit is how a stale substitution hides.

---

## The language

A program is a sequence of **file blocks**. A file block opens with `file <path>` and holds one or more **ops**, indented by convention (indentation is not significant). Blank lines and `#` comments are ignored outside string and body literals.

```
program   := (file-block)+
file-block := 'file' path NEWLINE (op NEWLINE)+
op        := replace | sub | insert | delete | lines | create
```

Paths are relative to the working directory (the checkout or dash worktree the session runs in), or absolute. A path is a literal — no globs, no variables. The same file may open more than one block; the blocks concatenate.

### Ops

| Op | Form | Meaning |
|----|------|---------|
| `replace` | `replace STR with STR [expect N \| all]` | Literal substring substitution. Default `expect 1`. |
| `sub` | `sub REGEX REPL [expect N \| all]` | Regex substitution with `$1`-style captures in `REPL`. Default `expect 1`. |
| `insert` | `before ADDR insert BODY` / `after ADDR insert BODY` | Insert whole lines adjacent to an addressed line. |
| `delete` | `delete ADDR` / `delete ADDR .. ADDR` | Delete the addressed line, or the inclusive range. |
| `lines` | `lines ADDR .. ADDR replace BODY` | Replace an inclusive line range with `BODY` (which may be empty: `<< >>`). |
| `create` | `create BODY` | The file must not exist; it is created with `BODY`. The only op allowed in its block. |

`replace` and `sub` match anywhere in the file, across line boundaries — a `STR` may contain `\n`. The line-addressed ops (`insert`, `delete`, `lines`) work on whole lines.

### Addresses

An `ADDR` is one of:

| Form | Resolves to |
|------|-------------|
| `N` | Line N, 1-based, as `grep -n` prints it. |
| `/REGEX/` | The single line matching the regex. Multiple matches is an error unless qualified with `[K]` — `/REGEX/[3]` is the third match, `/REGEX/[-1]` the last. |
| `'STR'` | The single line containing the literal. Same `[K]` qualifier. |
| `$` | The last line of the file. |

A range `A .. B` is inclusive at both ends and must be non-empty and ordered. Ranges resolve both ends independently against the original file; a range whose end precedes its start is an error.

### Literals

| Form | Notes |
|------|-------|
| `'…'` | Single-quoted string. The only escapes are `\'`, `\\`, `\n`, `\t`. Everything else is literal — no shell interpolation is possible because the program arrives in a quoted heredoc. |
| `"…"` | Double-quoted string, identical escapes. Offered so a literal containing `'` need no escaping. |
| `/…/` | Regex, Rust `regex` crate syntax. `\/` escapes a slash. Flags after the closing slash: `i`, `m`, `s`. |
| `<<` … `>>` | A **body**: the lines between the `<<` line and the `>>` line, verbatim. The body's own indentation is normalized by stripping the common leading whitespace of its non-blank lines, so a program can indent its bodies for readability without that indentation landing in the file. |

The body normalization is the one piece of cleverness in the language, and it exists because the model will indent bodies under their ops, and the alternative — `<<-` / `<<` pairs as in the shell — is a distinction the model gets wrong.

### Regex replacement

`sub`'s `REPL` uses `$1`, `${name}`, and `$$` for a literal dollar, per the `regex` crate's `Regex::replace` expansion. `REPL` is a quoted string literal; `sub /foo_(\w+)/ 'bar_$1' all` renames every `foo_` prefix.

### Count guards

`expect N` declares that a `replace` or `sub` must match exactly N times; `all` declares one-or-more. The default is `expect 1`. This is the guard that makes computed edits safe: the model has just read the file and knows how many hits it expects, and the interpreter refuses to proceed if the file disagrees. A regex the model believed was specific and was not is caught here, not in the diff review.

---

## Execution semantics

The interpreter runs in four phases, and the phase boundary is the contract.

1. **Parse.** The whole program is parsed before any file is opened. A syntax error names its line and column and aborts the run with nothing read.
2. **Read.** Every file named by a block is read once. A missing file is an error (except under `create`, where an *existing* file is the error). Non-UTF-8 content is an error; tugrevs does not edit binaries.
3. **Resolve.** Every address, literal, and regex in every op is resolved against the original bytes of its file. Every failure across the whole program is collected — not just the first — and reported together with the op's source line, so one run tells the model everything that was stale. Any failure aborts with nothing written.
4. **Apply and write.** Ops within a file are applied bottom-up by resolved position, so no op shifts another. Each file is written atomically (write-temp-and-rename in the file's directory, preserving mode). A file whose result is byte-identical to its original is not written and not receipted.

Line endings are detected per file (`\n`, `\r\n`) and preserved; bodies are joined with the file's own ending. A file with no trailing newline stays that way unless an op appends past its last line, in which case one is added — the same rule `patch` follows.

**Overlap is an error.** Two ops whose resolved spans intersect in the same file are refused at resolve time. Adjacency is fine; overlap means the model's mental model of the file has diverged from its bytes.

---

## Preview and the receipt

`tugrevs --preview` runs phases 1–3, then prints the unified diff the program *would* produce and exits 0 without writing. This is the model's dry run and it should be the reflex before any program with `all`, a regex, or more than a couple of files. Preview emits no receipt and touches no mtime — the same guarantee [`file probe`](tracking-changes.md#verb-receipts) holds, for the same reason: nothing changed, so the ledger must not say otherwise.

A successful apply prints the unified diff of what it did, then a single `TUG-FILE-RECEIPT` line naming every file whose bytes moved (`modified`, or `created` for a `create` block), in the same format `tugutil file edit` emits so the relay's existing scan mints the same proof-class `cmd` rows and hunk ids. There is nothing new for the relay to learn. Forgery remains a non-risk for the reason given in tracking-changes: rows are relay-local, so a session can only attribute files to itself.

Exit status: `0` applied (or previewed); `2` parse error; `3` resolve failure (nothing written); `4` I/O failure during write, in which case the output names exactly which files were written before the failure, because at that point the transaction guarantee is the write-per-file atomicity, not the program.

---

## Surface

| Spelling | Role |
|----------|------|
| `tugrevs [--preview] [FILE.rev]` | The shim binary. Reads the program from the named file or stdin. Ships in the app bundle beside `tugutil` and is symlinked into `~/.local/bin` like the rest. |
| `tugutil file rev [--preview] [FILE.rev]` | The same interpreter as a `tugutil` verb, for scripts that already speak `tugutil`. |
| `tugrevs-core` | The crate under `tugrust/crates/`: lexer, parser, resolver, applier, diff rendering. No I/O policy — it takes a `FileSource` trait so tests drive it against in-memory content and the CLI drives it against the tree. |

`.rev` is the language's file extension and the language's name in prose ("write a rev"). `tugrevs` is the tool.

---

## Habit shaping — the half that actually fixes the leak

A verb the model doesn't reach for attributes nothing. Three levers, all cheap, all part of shipping this:

1. **The gate steers the heredoc interpreters.** Today `gate-file-ops.sh` never denies a `python3` heredoc, because the grammar cannot judge one and most are read-only analysis. That stays true for a bare `python3 script.py`. But a heredoc-fed or `-c`-fed interpreter (`python3 -`, `python3 -c`, `perl -e`, `ruby -e`, `awk` with a program text) whose command text **or stripped body** names a path under the checkout with a write-shaped call (`open(…, "w")`, `write_text`, `Path(…).write`, `print >`, awk `>` redirection) is denied with a one-line steer: *"write this as a rev — `tugrevs <<'REV' … REV`"* — and a two-op example in the denial message, because the model copies the shape it is shown. This adds a third `Suggestion` variant (`Rev`) beside `Lifecycle` and `Edit`. The gate still fails open, and a heredoc that names no repo path still passes: this is a steer, not a wall.
2. **`CLAUDE.md` shows the shape.** The editing section leads with a rev example — a multi-file, multi-op one, since that is the case where python wins today — and names `tugrevs` before `file edit`. `file edit` remains the right tool for the one-liner.
3. **The heredoc reader is fast to be right.** Resolve-phase errors report *every* stale address in one run with the op's source line, so the round trip to a correct program is one step, not a python retry.

Whether the levers worked is measurable: the size of the UNATTRIBUTED bucket over sessions, which the Changes card already shows. That number is the feature's acceptance test.

---

## Invariants (the short list)

- A program either applies entirely or writes nothing. The only exception is an I/O failure mid-write, which is reported file-by-file.
- Every address resolves against original bytes; ops never observe each other.
- `expect 1` is the default; a match count the program did not declare is an error.
- Overlapping spans in one file are refused.
- A byte-identical result is neither written nor receipted.
- `--preview` writes nothing, touches no mtime, emits no receipt.
- The receipt format is `tugutil file edit`'s; the relay learns nothing new.
- The grammar grows by verbs the model already knows. A construct that needs explaining in this page before the model can write it does not belong in the language.
