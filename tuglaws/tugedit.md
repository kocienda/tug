# tugedit — the edit language

*A small, interpreted language for editing text files from inside a session, executed by `tugtool` so every edit it makes is attributed with proof. Why it exists, what the session corpus says the model actually does to files, the grammar, the transaction semantics, the receipt, and how the gate steers to it. Read this before implementing the interpreter, before adding a verb, or before deciding that a `python3` heredoc is "fine just this once."*

*Cross-references: `[L##]` → [tuglaws.md](tuglaws.md). Attribution vocabulary (proof rows, hints, buckets, the receipt sentinel) is defined in [tracking-changes.md](tracking-changes.md); this page assumes it.*

---

## The problem this solves

The attribution grammar in `tugchanges-core::shell_ops` reads a shell command and proves which files it mutates. It reads `sed -i`, `perl -i`, `tee`, redirections — anything whose operands are in the command text. It cannot read a heredoc body: a body is data, not commands, and is stripped before parsing. So `python3 - <<'PY' … PY`, `python3 -c '…'`, `perl -e`, and `awk` scripts that write repo files land in the Changes card's **UNATTRIBUTED** bucket with at best a `likely` hint, and somebody presses `CLAIM ALL` to repair the ledger by hand.

The model reaches for those interpreters for a reason, and the reason is not that an attributable verb is missing. An attributable edit verb existed before the language did; it covered one literal substitution per invocation, or a unified diff. The moment an edit is multi-line, touches three files, needs quoting the shell fights, or is *computed* — rename every `foo_` prefix, insert after the third match, replace lines 5873–5882 — the cheapest thing in the model's hands is a heredoc into a general-purpose interpreter. The heredoc is the natural shape for a multi-line program. The failure is only that the program's reader is python instead of Tug.

**tugedit makes the heredoc the happy path.** An edit program is written into a heredoc exactly as a python script would be, but its reader is `tugtool`, which applies it and emits the `TUG-FILE-RECEIPT` the relay already understands. The habit stays; the attribution becomes proof.

```bash
tugedit <<'EDIT'
file tugrust/crates/tugarc-core/src/ops.rs
  replace 'entry.stage, "working"' with 'entry.stage, "the git stage"'
  after /^fn redo_replay\b/ insert <<
    let _guard = replay_guard();
  >>
EDIT
```

---

## What the corpus says

The language is shaped by evidence, not taste. Every Claude Code session transcript for this checkout and its dash worktrees (613 files, ~140,000 Bash calls as of 2026-08-26) was mined for commands that mutate a repo file from Bash through something other than the attributable edit verb. The tally, and what each family was doing:

| Family | Repo-file edits | Attributed today? | What the edits actually were |
|--------|----------------:|-------------------|------------------------------|
| `python3` heredoc / `-c` that writes a file | **1,317** | **No — the leak.** The body is stripped before parsing; nothing in it is evidence. | 928 carry a triple-quoted multi-line body. 705 apply a **list of literal (old, new) pairs** to one file — the dominant shape by far. 328 guard each pair with `assert s.count(old) == 1` before substituting. 198 locate a region by `s.index(marker)`; 17 of those cut or replace **the span between two markers**. 42 splice a line array; 9 by numeric range; 28 do an insert that copies the anchor line's indentation. 28 use `re.sub`. 56 loop over several files. 20 rewrite JSON structurally. |
| `bun -e` / `node -e` writing | 5 | **No** — same reason. | Multi-line regex deletions with the `gm` flags. |
| `sed -i ''` | 1,080 | Yes, when the operands are literal paths (nearly all of these); a glob or variable is already denied by the gate. | 287 `s///g`. **280 delete a numeric line range** (`'835,849d'`), often several ranges in one chain. 270 name multiple files or chain several `sed -i` calls. 99 stack `-e` expressions — a rename campaign in one call. 29 **scope a substitution to a line range** (`'350,900s/railSplit/placeSplit/g'`). 42 use word boundaries (`\b`, or BSD `[[:<:]]`). |
| `perl -pi -e` | 496 | Yes, same rule. | Almost entirely `s///g` across files: 379 name more than one file. 79 use `-0777` for a substitution that spans lines. |
| `cat >> file <<'EOF'` | 335 | Yes — a redirection target. | Append a block to an existing file — a CSS rule, a test `describe`, a notice section. |
| `cat > file <<'EOF'` | 448 | Yes — a redirection target. | Create a file whole (occasionally overwrite one). |
| `awk 'NR…' file > /tmp/x && mv` | 18 | Yes — the `mv` names the destination. | Delete or reorder lines by number. |
| `head -n $((L-1)) file > /tmp && mv` | 9 | Yes — same. | Truncate a file at a marker line. |

So the attribution problem is one family. The `sed`/`perl`/`cat` rows are in the table because they show what edits the model makes and therefore what the language must express — not because they leak. The 1,322 interpreter-body edits are the only source in the corpus that no grammar change can ever read, because the body is an arbitrary program. That is the gap tugedit exists to close, and closing it is worth a language only because the same language also makes the other 2,400 edits transactional, count-guarded, and previewable instead of hand-ordered `sed -i` chains.

Three conclusions drive the design:

1. **Literal, multi-pair, per-file substitution with a count guard is the centre of mass.** The model already writes `assert s.count(old) == 1` a quarter of the time on its own. `expect 1` as the default, with every failure reported in one run, is that habit made mandatory and cheap.
2. **Line numbers and text markers are both first-class addresses, and both scope other ops.** Numeric-range deletes are the second-largest single shape; range-scoped `s///` and "from `mod tests {` to end of file" edits are real; two-marker spans are how the model deletes a whole function or table. The language needs ranges whose ends are numbers *or* text, and a way to run a substitution *inside* one.
3. **Multi-file and whole-file ops are not edge cases.** Half the `sed`/`perl` calls touch several files with the same expression; append and create together outnumber `perl` entirely. A block that names several files, plus `append`/`create`/`write`, let a program express every shape the attributed families use, so the model never has a reason to fall back.

What the corpus does **not** contain in any volume is computed replacement (a callback deciding each substitution — 1 case) or structural JSON editing (20, almost all `/tmp` fixtures or model manifests). Those stay out of the language; see [Out of scope](#out-of-scope) for how they still get attributed.

---

## Design stance

**Boring on purpose.** tugedit is a superset of the verbs the model already knows from `ed`, `sed`, and `patch`: `replace`, `sub`, `insert`, `delete`, addresses that are literals, regexes, or line ranges. A bespoke syntax would be generated less reliably, and a malformed program is exactly the moment the model gives up and reaches for python. Every construct here is one the model can write from memory on the first try. Human readability is not a goal, but it falls out of this stance for free and the Changes card is glad of it.

**A program is a transaction.** Every address in the program is resolved against the *original* bytes of every file before a single byte is written. If any op fails to resolve, nothing is written and the run exits non-zero. There is no half-applied multi-file edit, ever. This is the same discipline the verb's `--patch` mode already holds (a patch that will not apply changes nothing), extended to a whole program.

**Addresses mean what the model just read.** The model discovers line numbers with `grep -n` and `sed -n 'a,bp'` and then edits. Because resolution happens against original bytes, `835 .. 849` in a program refers to the lines the model saw, even if an earlier op in the same program inserted forty lines above them. Ops within a file are applied bottom-up by resolved position, so no op shifts another. The `sed -i '835,849d' && sed -i '521,522d' && sed -i '166d'` chain — where the model had to order its deletes top-down by hand to keep the numbers honest — becomes three `delete` lines in any order.

**Silence is the enemy.** A no-match is an error. A match count the program did not declare is an error. A file that the program names but leaves byte-identical is not in the receipt. Mirrors [tracking-changes.md](tracking-changes.md#verb-receipts): a silently-successful no-op edit is how a stale substitution hides.

---

## The language

A program is a sequence of **file blocks**. A block opens with `file <path>` — or `files <path> <path> …`, which applies the same ops to each file independently — and holds one or more **ops**. Ops are indented by convention, and the indentation means nothing — a body is verbatim whatever column its op sits at (below). Blank lines and `#` comments are ignored outside string and body literals.

```
program    := (block)+
block      := ('file' path | 'files' path+) NEWLINE (op NEWLINE)+
op         := replace | sub | patch | insert | append | delete | lines | move | create | write
```

Paths are relative to the working directory (the checkout or dash worktree the session runs in), or absolute. A path is a literal — no globs, no variables. The same file may open more than one block; the blocks concatenate. In a `files` block, `expect` counts are checked **per file**: `files a.rs b.rs` + `sub /\bnew_frames\b/ 'new_beats' all` requires at least one hit in each.

### Ops

| Op | Form | Meaning |
|----|------|---------|
| `replace` | `replace STR with STR [COUNT] [SCOPE]` | Literal substring substitution. Default `expect 1`. |
| `sub` | `sub REGEX REPL [COUNT] [SCOPE]` | Regex substitution; `$1`-style captures in `REPL`. Default `expect 1`. |
| `patch` | `patch BODY` | The body is unified-diff hunk lines — ` ` context, `-` removed, `+` added — with no headers and no counts. Each hunk finds its context + `-` lines as whole lines, exactly once, and replaces them with its context + `+` lines. `@@` lines separate hunks and their tails are ignored. The block-replaces-block form. |
| `insert` | `before ADDR insert [indented] BODY` / `after ADDR insert [indented] BODY` | Insert whole lines adjacent to an addressed line. `indented` prefixes each body line with the anchor line's leading whitespace. |
| `append` | `append BODY` | Insert after the last line. `cat >> file <<'EOF'` as an op. |
| `delete` | `delete RANGE` / `delete every ADDR` | Delete the lines in the range, or every line the address matches. |
| `lines` | `lines RANGE replace BODY` | Replace the lines in the range with `BODY` (which may be empty: `<< >>`). |
| `move` | `move RANGE before ADDR` / `move RANGE after ADDR` | Cut the range and reinsert it at the anchor, resolved against the original file. |
| `create` | `create BODY` | The file must not exist; it is created with `BODY`. |
| `write` | `write BODY` | The file's whole content becomes `BODY`, existing or not. `cat > file <<'EOF'` as an op. |

`create` and `write` must be the only op in their block. `replace` and `sub` match anywhere in the file, across line boundaries — a `STR` carries `\n` or arrives as a `<<` body, and a regex may match `\n` — which is what `perl -0777` was being used for. The line-addressed ops (`insert`, `delete`, `lines`, `move`) work on whole lines.

### COUNT — the guard

`expect N` declares that a `replace` or `sub` must match exactly N times in its scope; `all` declares one-or-more. The default is `expect 1`. This is the guard that makes computed edits safe: the model has just read the file and knows how many hits it expects, and the interpreter refuses to proceed if the file disagrees. A regex the model believed was specific and was not is caught here, not in the diff review.

### SCOPE — substitution inside a range

`in RANGE` restricts a `replace` or `sub` to the lines of the range: `sub /\bprojectDir\b/ 'sentDir' all in 270 .. 440`, or `replace 'state.record(' with 'state.record_now(' all in /^mod tests \{/ .. $`. Without `in`, the scope is the whole file. The count guard applies within the scope.

### Addresses and ranges

An `ADDR` is one of:

| Form | Resolves to |
|------|-------------|
| `N` | Line N, 1-based, as `grep -n` prints it. |
| `/REGEX/` | The single line matching the regex. Multiple matches is an error unless qualified: `/REGEX/[3]` is the third match, `/REGEX/[-1]` the last. |
| `'STR'` | The single line containing the literal. Same `[K]` qualifier. |
| `<<` … `>>` | The run of lines equal to the body, verbatim. Same `[K]` qualifier, which binds to the `>>` with no space: `>>[2]`. |
| `$` | The last line of the file. |

**A block is an address because a place is not always one line.** `after << … >> insert << … >>` anchors past a whole function whose closing `}` is not distinctive; `delete << … >>` cuts a block by quoting it rather than by counting its lines. Where the other forms name one line, a block names a run: `before` takes its first line and `after` its last, and at either end of a range it reads the same way — start takes the first, end takes the last. This form was written unprompted in the field before the language had it, which is the strongest case a construct can make for itself.

A `RANGE` is `ADDR .. ADDR` (inclusive at both ends) or `ADDR until ADDR` (inclusive start, **exclusive** end). `until` is the two-marker span the model writes as `s[s.index(A):s.index(B)]`: `delete 'const density = await app.evalJS' until '// ── 1. One baseline per bar'` removes the first block and leaves the second's heading in place. Both ends resolve independently against the original file; an end that precedes its start is an error. A bare `ADDR` where a `RANGE` is expected is the one-line range.

`delete every ADDR` is the `sed '/pattern/d'` shape: it deletes each matching line and is the one place an address may match many times without a qualifier.

### Literals

| Form | Notes |
|------|-------|
| `'…'` | Single-quoted string, and **one line** — a block spanning several goes in a body instead. The only escapes are `\'`, `\\`, `\n`, `\t`, which is the one way a literal is *not* the file's bytes as a body is: a backslash-n that stands in the source is written `\\n`. Everything else is literal — no shell interpolation is possible because the program arrives in a quoted heredoc. **A literal that contains `'` goes in `"…"`.** A doubled `''` and the shell's `'"'"'` and `'\''` are each refused by name, because they are the SQL and shell conventions the model writes from habit, and each refusal points at `"…"`. |
| `"…"` | Double-quoted string, identical rules. The form for any literal containing `'` — which is most prose: a comment, a doc table row, the apostrophe in a CSS comment. |
| `/…/` | Regex, Rust `regex` crate syntax. `\/` escapes a slash. `^` and `$` are **line** anchors (multi-line mode is on, as in `sed` and `perl -p`); `\A` and `\z` anchor the file. `\b` is the word boundary — BSD sed's `[[:<:]]`/`[[:>:]]` have no place here. Flags after the closing slash: `i`, `s` (dot matches newline). |
| `<<` … `>>` | A **body**: the lines between the `<<` line and the `>>` line, **verbatim** — every byte of every line, indentation included, exactly as it stands or will stand in the file. A body is the same thing an `Edit`'s `old_string` is. The `>>` may sit at any indentation. |

**One op may carry two bodies, and that is how a block replaces a block.** `replace << … >> with << … >>` is the form; a `>>` line closes its body when nothing follows it, or when what follows opens with the op's own next word — `with` after the first body, `all` / `expect` / `in` after the second. Any other `>>` line is body content, so a markdown blockquote survives being carried in one.

**`patch` is the recommended form for a block replacing a block.** Two bodies still work and are not going anywhere, but a hunk puts each line's indentation in a prefix column, so the file's own leading whitespace is a byte the writer copies rather than one they reconstruct — which is where nearly every live refusal landed. `@@` lines separate hunks and their tails are ignored, so a real diff's headers can be pasted in and cost nothing; a `\ No newline at end of file` marker is ignored too. An empty line is a blank context line, and any line whose first byte is not ` `, `-`, `+`, `@@`, or `\` is refused by name at the line that carries it. A hunk needs a `-` or a `+` line, or it would change nothing; a hunk with only `+` lines needs a context line, or it has nowhere to go. A hunk matches exactly once, with the same indent-shift and near-miss hints a `replace` earns, and a refusal names which hunk missed — every failing hunk, in one refusal.

**A body cannot contain a bare `>>` line**, so an edit program cannot carry an edit program — editing this page's own examples wants `Edit` or a patch. Inside a `patch` hunk a `+>>` or `->>` line does carry one, since the prefix byte keeps it off the terminator's shape; a *context* line whose own content begins `>>` cannot, because a body's `>>` may sit at any indentation and nothing distinguishes it from the terminator — carry that line as a `-`/`+` pair instead. The language has no labelled terminator (`<<EDIT … EDIT`) that would fix the general case; that is a gap rather than a decision, left open until a second case for it turns up.

That form exists because block-replaces-block is the commonest edit in the evidence: 928 of the 1,317 interpreter edits carry a triple-quoted multi-line body. It was learned in the field rather than designed. On the interpreter's first real outing three of four programs were refused — the model wrote the block as a **multi-line quoted literal**, which the language does not have, and then abandoned the verb. A literal stays one line, because that keeps an unclosed quote refused on the line that opened it instead of swallowing the rest of the program; the refusal names the body form, so the instinct that wrote the literal is answered with the syntax that carries it.

**A body is verbatim because the alternative was tried and failed in the field.** The first version dedented each body by its op line's indentation — write the body under the op, and the constant comes back off — and it was the largest single cause of `found 0` in the language's first week. The model holds two other rules already, YAML's (content is relative to its own first line) and `Edit`'s (the bytes are the bytes), and under either it writes the file's real indentation beneath a two-space op and loses two columns. Verbatim deletes a rule rather than adding one. And a body that finds nothing is never refused bare. Two hints stand behind the count, in order. If the whole body would match at some other column, the refusal says which — `found 1 at line 412 if it were written 2 columns deeper`. Otherwise it reports the **near miss**: how far the body got before it stopped matching, and how the line that broke it differs — `the body's first 7 lines match at line 685, then body line 8 differs only in indentation: the file indents it 6, the body 4`. That second hint is the one the field needed, because the residual mistake is no longer a uniform shift but a *flattened* body: the model writes the block's first line at the file's column and the rest at that same column, losing the structure inside it. A line-by-line divergence names that in one read. Bodies are never trimmed of blank lines, so an appended CSS rule keeps its leading blank line.

### Regex replacement

`sub`'s `REPL` uses `$1`, `${name}`, and `$$` for a literal dollar, per the `regex` crate's `Regex::replace` expansion. `REPL` is a quoted string literal; `sub /foo_(\w+)/ 'bar_$1' all` renames every `foo_` prefix.

### Worked forms from the corpus

```
# the rename campaign (sed -i '' -e … -e … file / perl -pi across files)
files tugrust/crates/tugarc-core/src/ops.rs tugrust/crates/tugarc-core/src/replay.rs
  replace 'ReleaseOutcome' with 'DiscardOutcome' all
  sub /\brelease_in\b/ 'discard_in' all
  sub /\bfn release_/ 'fn discard_' all

# the multi-pair edit with guards (python3 heredoc with s.count(a) == 1)
file tugdeck/src/main.tsx
  replace 'import { attachPulseStore } from "./lib/pulse-store";' with <<
import { attachPulseStore } from "./lib/pulse-store";
import { attachLocalModelStore } from "./lib/local-model-store";
>>
  after 'attachPulseStore(connection);' insert indented <<

attachLocalModelStore(connection);
>>

# the numeric deletes (sed -i '' '835,849d' && '521,522d' && '166d')
file tugdeck/src/components/layout/layout-card.tsx
  delete 835 .. 849
  delete 521 .. 522
  delete 166

# the block swap (python line-array splice), and the truncate-at-marker (head -n | mv)
file roadmap/local-model-bringup.md
  move 431 .. 441 before 415
file roadmap/animation-tuneup.md
  delete /^### Remaining execution steps/ .. $

# block replaces block (the python triple-quoted pair) — one hunk, the file's
# indentation after each prefix
file tugdeck/src/deck-manager.ts
  patch <<
     return (
-      this.container.clientHeight -
-      IMPOSITION_GAP_PX -
-      IMPOSITION_GAP_BOTTOM_PX
+      this.container.clientHeight - IMPOSITION_GAP_PX - impositionGapBottomPx()
     );
>>

# the apostrophe in prose (a doc table, a comment) — the literal goes in "…"
file tuglaws/pane-model.md
  replace "| `FlowStrip` — the deck's arrangement drawn to scale in the bottom band |" with "| `FlowStrip` — the deck's arrangement drawn to scale under the plan |"

# the scoped rename (sed -i '' '350,900s/railSplit/placeSplit/g')
file tugdeck/src/components/chrome/tug-pane.tsx
  replace 'railSplit' with 'placeSplit' all in 350 .. 900

# the append (cat >> file <<'EOF') and the new file (cat > file <<'EOF')
file tugdeck/src/components/tugways/cards/gallery-motion-bench.css
  append <<

.gmb-escaped {
  position: fixed;
}
>>
file tests/model-eval/verbs.txt
  create <<
add audit author
>>
```

A `STR` may be a body on either side, or both: `replace '…' with << … >>` grows a one-line anchor into a block, and `replace << … >> with << … >>` replaces a block with a block.

---

## Execution semantics

The interpreter runs in four phases, and the phase boundary is the contract.

1. **Parse.** The whole program is parsed before any file is opened. A syntax error names its line and column, quotes that line with a caret under the column, and aborts the run with nothing read. The excerpt is not decoration: a program arrives on stdin as a heredoc, so a bare `7:1` addresses a document that exists only in the message that sent it, and in a program with two `patch` ops the position alone does not say which one refused.
2. **Read.** Every file named by a block is read once. A missing file is an error (except under `create`, where an *existing* file is the error, and `write`, which accepts either). Non-UTF-8 content is an error; tugedit does not edit binaries.
3. **Resolve.** Every address, literal, and regex in every op is resolved against the original bytes of its file. Every failure across the whole program is collected — not just the first — and reported together with the op's source line and the actual match count, so one run tells the model everything that was stale. Any failure aborts with nothing written — and the refusal's last line says so in words, counting the ops that did resolve, because a model reading a refusal otherwise carries on as though those had landed and its next program addresses text this one never wrote.
4. **Apply and write.** Ops within a file are applied bottom-up by resolved position, so no op shifts another; a `move` is a delete at its source and an insert at its anchor, both positioned against the original. Each file is written atomically (write-temp-and-rename in the file's directory, preserving mode). A file whose result is byte-identical to its original is not written and not receipted.

Line endings are detected per file (`\n`, `\r\n`) and preserved; bodies are joined with the file's own ending. A file with no trailing newline stays that way unless an op appends past its last line, in which case one is added — the same rule `patch` follows.

**Overlap is an error.** Two ops whose resolved spans intersect in the same file are refused at resolve time — including a `move` whose anchor lies inside its own range. Adjacency is fine; overlap means the model's mental model of the file has diverged from its bytes.

---

## Preview and the receipt

`tugedit --preview` runs phases 1–3, then prints the unified diff the program *would* produce and exits 0 without writing. This is the model's dry run and it should be the reflex before any program with `all`, a regex, a `files` block, or a `move`. Preview emits no receipt and touches no mtime — the same guarantee [`file probe`](tracking-changes.md#verb-receipts) holds, for the same reason: nothing changed, so the ledger must not say otherwise.

A successful apply prints the unified diff of what it did, then a single `TUG-FILE-RECEIPT` line naming every file whose bytes moved (`modified`, or `created` for a `create` or a `write` of a file that did not exist), in the same format the verb's `--patch` mode emits so the relay's existing scan mints the same proof-class `cmd` rows and hunk ids. There is nothing new for the relay to learn. Forgery remains a non-risk for the reason given in tracking-changes: rows are relay-local, so a session can only attribute files to itself.

Exit status: `0` applied (or previewed); `2` parse error; `3` resolve failure (nothing written); `4` I/O failure during write, in which case the output names exactly which files were written before the failure, because at that point the transaction guarantee is the write-per-file atomicity, not the program.

---

## Out of scope

Two shapes the corpus contains are deliberately not in the language, because a language that can express them is python:

- **Computed replacement** — a callback deciding each substitution from what it matched (the corpus has one: counting `linear(` occurrences to emit that many `linear` keywords).
- **Structural JSON editing** — load, mutate a key, dump.

The attributable path for both is *compute, then write the result as an edit program*: run the interpreter read-only, printing the new content or the `(old, new)` pairs it computed, and put that output into a `write`, `lines … replace`, or `replace` op. The read-only run is a heredoc the gate never minds; the write is a receipt. The gate steer below says exactly this when it fires on a heredoc it cannot see through.

---

## Surface

| Spelling | Role |
|----------|------|
| `tugtool file edit [--preview] [FILE.edit]` | The entry point, and the whole of file editing: an edit program from the named file or stdin, or a unified diff via `--patch` (`-` for stdin), both honoring `--preview`. This is the spelling the gate's steer and `CLAUDE.md` use. |
| `tugedit [--preview] [FILE.edit]` | A thin second `[[bin]]` target in the `tugtool` crate that runs the program shape of the same verb. Ships in the app bundle beside `tugtool` and is symlinked into `~/.local/bin` like the rest — and carries the same gotcha: the symlink points at `main`'s build, so a dash-worktree session that changed the interpreter must call it by absolute path. |
| `tugedit-core` | The language crate under `tugrust/crates/`: lexer, parser, resolver, applier, diff rendering. No I/O policy — it takes a `FileSource` trait so tests drive it against in-memory content and the CLI drives it against the tree. |

`.edit` is the language's file extension, and "an edit program" is its name in prose. `tugedit` is the tool. There is exactly one editing verb: the flag-mode single substitution the verb once carried (`--path`/`--replace`/`--with`) is retired, because a one-op program covers it with the same count guard and a better refusal, and two grammars for one act was the review/rev-class ambiguity this naming exists to avoid. (The tool was originally named `tugrev` and the program "a rev"; the name read too easily as *review* and was retired whole.)

---

## Habit shaping — the half that actually fixes the leak

A verb the model doesn't reach for attributes nothing. Three levers, all cheap, all part of shipping this:

1. **The gate steers the heredoc interpreters.** Today `pre-tool-use.sh` never denies a `python3` heredoc, because the grammar cannot judge one and most are read-only analysis. That stays true for a bare `python3 script.py`. But a heredoc-fed or `-c`-fed interpreter (`python3 -`, `python3 -c`, `perl -e`, `ruby -e`, `bun -e`, `node -e`, `awk` with a program text) whose command text **or stripped body** names a path under the checkout with a write-shaped call (`open(…, "w")`, `write_text`, `.write(`, `Bun.write`, `writeFileSync`, awk `>` redirection) is denied with a one-line steer — *"write this as an edit program — `tugtool file edit <<'EDIT' … EDIT`"* — and a two-op example in the denial message, because the model copies the shape it is shown. The same steer covers the two `/tmp` round trips the corpus shows (`awk … > /tmp/x && mv /tmp/x file`, `head -n … > /tmp/x && mv`), which the grammar *can* read but which would otherwise mint only a `mv` row for the destination. This is the `Suggestion::Program` variant beside `Lifecycle` and `Edit`, and it reads the body under decision R1 below: a scan that can only deny, never attribute. The gate still fails open, and a heredoc that names no repo path still passes: this is a steer, not a wall.
2. **`CLAUDE.md` shows the shape.** The editing section leads with an edit-program example — the multi-pair, multi-file one, since that is the case where python wins today.
3. **The heredoc reader is fast to be right.** Resolve-phase errors report *every* stale address in one run with the op's source line and the actual count, so the round trip to a correct program is one step, not a python retry.

Whether the levers worked is measurable two ways: the size of the UNATTRIBUTED bucket over sessions, which the Changes card already shows, and the mining query above re-run against new transcripts — the interpreter-body count (1,322 over the corpus so far) should stop growing, and the `sed`/`perl` counts should fall as edit programs replace them. The first number is the feature's acceptance test; the second is a quality signal.

---

## Decisions

Settled before the dash; a step that wants to reopen one updates this page first.

| # | Decision |
|---|----------|
| R1 | **The steer may read what the grammar may not.** The attribution grammar strips heredoc bodies because a body is data, and that stays true for *proof*: nothing scanned in a body ever mints a row. The gate's steer is a different tier — it only ever produces a denial with a suggestion — so it is allowed to scan a body for a write-shaped call and a repo-shaped path. `tracking-changes.md` gets one paragraph saying so, next to the existing "a `python3` heredoc is never denied" sentence, which it replaces. |
| R2 | **One new crate, no new CLI crate.** `tugedit-core` is the only new crate. `tugtool file edit` is the verb; `tugedit` is a `[[bin]]` in `tugtool`. |
| R3 | **`expect 1` is the default for `sub` as well as `replace`.** A rename campaign spells `all` on every line. The cost is a word; the benefit is that a regex the model believed specific is caught at resolve time. |
| R4 | **In a `files` block the count guard holds per file.** A listed file with zero hits fails the program. The model lists what `grep -l` returned, not what it guessed. |
| R5 | **The gate steer ships with the interpreter.** It is the delivery mechanism, not polish: the corpus shows the verb the model was steered to (`file probe`, 321 uses) stuck, and the one it was merely told about did not close the leak. Landing the language without the steer is not landing the feature. |
| R6 | **`Edit`/`Write` remain the first choice for a single-file edit.** They attribute with certainty. The edit program is for the Bash residue — multi-pair, multi-file, line-range, append — where the model would otherwise reach for an interpreter. `CLAUDE.md` says both. |
| R7 | **`patch` is the recommended block-replaces-block form, and two-body `replace` stays undeprecated.** The prefix column makes each line's indentation visible instead of reconstructed, which is the property the flattened-body refusals were losing. 266 corpus programs use two bodies; nothing about them changes. |
| R8 | **One name, one verb.** The tool is `tugedit`, the subcommand `tugtool file edit`, and the language the edit program; `tugrev`, `file rev`, and the flag-mode substitution are retired whole, with no aliases, because a CLI the model drives from `CLAUDE.md` needs no compatibility spelling. |

---

## Tests

- **Language, in memory.** `tugedit-core` unit tests against an in-memory `FileSource`: every op, every address form including a block at an insert anchor and at a range end, the near-miss hint, `until` vs `..`, `[K]` qualifiers, `in` scope, per-file guards in a `files` block, bodies verbatim under an indented op, the indent hint on a `found 0`, the shell-idiom and doubled-quote refusals, CRLF and no-trailing-newline preservation, overlap refusal, `move` with an anchor inside its own range, all-failures-reported-at-once, byte-identical result not written.
- **Verb, on disk.** CLI tests in `tugtool/tests/file_edit_cli.rs`: receipt names only files whose bytes moved; `--preview` leaves bytes *and* mtime untouched and prints no receipt; exit codes 2/3/4; atomic write preserves mode; `tugedit` and `tugtool file edit` produce identical output.
- **Fidelity to the corpus.** `tugtool/tests/edit_corpus.rs`: a fixture set of real commands lifted from the mined transcripts — spanning the python multi-pair, `sed` numeric deletes, range-scoped `s///`, `perl -pi` multi-file, `cat >>`, and a two-marker cut — each paired with its edit program and the file at the commit the session was on. The test runs both and asserts byte-identical output. This is the test that says the language expresses what the model was actually doing, and it is the one that must not be faked with synthetic content.
- **Gate.** `shell_ops` tests for the steer: a python heredoc writing a repo path → `Program`; the same heredoc reading only → passes; `python3 script.py` → passes; `awk … > /tmp/x && mv /tmp/x repo/file` → `Program`.

### Acceptance

The mining query, re-run against transcripts written after the language shipped: the interpreter-body count stops growing. The Changes card's UNATTRIBUTED bucket is the same fact seen live.

---


## Invariants (the short list)

- A program either applies entirely or writes nothing. The only exception is an I/O failure mid-write, which is reported file-by-file.
- A refusal ends by saying nothing was written and how many ops did resolve.
- A parse refusal quotes the program line it names, with a caret under the column.
- Every address resolves against original bytes; ops never observe each other.
- `expect 1` is the default; a match count the program did not declare is an error. In a `files` block the guard holds per file.
- Overlapping spans in one file are refused.
- A quoted literal is one line; a block spanning several is a `<<` body, and the refusal for a multi-line literal names that form.
- A `>>` closes its body when nothing follows it, or when the op's own next word does. Any other `>>` line is content.
- Bodies are verbatim; a `>>` may sit at any indentation. A body that finds nothing names the column at which it would have, or else the first line at which it diverged.
- A `patch` hunk resolves its context + `-` lines as whole lines, exactly once; `@@` counts are never required or read.
- A `<<` body is an address anywhere an address goes: `before` takes its first line, `after` its last, and a range end its last.
- A literal containing `'` goes in `"…"`; `''`, `'"'"'`, and `'\''` are refused by name.
- `^`/`$` in a regex are line anchors.
- A byte-identical result is neither written nor receipted.
- `--preview` writes nothing, touches no mtime, emits no receipt.
- The receipt format is one grammar across the verb's modes; the relay learns nothing new.
- The grammar grows by verbs the model already knows, justified by the corpus. A construct that needs explaining in this page before the model can write it does not belong in the language.
