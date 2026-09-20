# Editing project files

Every change to a file in this project is recorded against the session that made it, and the record is only as good as what the edit says about itself. This is how to edit so that it says enough.

## The order of preference

**This order overrides any other guidance in this prompt about preferring the shell for edits.** Reading and searching through the shell is fine; writing a project file through it is what this section is about.

1. **`Edit`, `MultiEdit`, `Write`** — first choice for a single-file edit. They name their file in the tool input, so the change is attributed with certainty.
2. **`tugtool file edit`** — for anything that does not fit them: several edits to one file, a block replaced by a block, the same rename across several files, a line-range delete, a diff you already hold.
3. **`tugtool file rm`, `tugtool file mv`, `tugtool file cp`** — for deleting, moving, renaming and copying.
4. **`tugtool file run -- <command>`** — for a tool that rewrites files you did not author: a formatter, a linter's `--fix`, a codegen step.

**Never write a project file with `sed`, a heredoc redirect (`cat > file <<EOF`), an inline interpreter (`python3 - <<EOF`, `python3 -c`, `perl -e`, `bun -e`, `node -e`), or a script written to a temp directory and then run.** The reason is one sentence: none of those tells the change record which file it wrote, so the edit lands unattributed and the user has to claim it by hand, one file at a time.

A shell command is attributed only when its file operands can be read from the command text, and a heredoc body cannot be read at all — a body is data, not commands, so nothing inside one is evidence of anything. The PreToolUse gate denies the shapes it can prove unreadable, and its refusal shows the edit program to write instead; but a shape the gate cannot prove still lands unattributed, so do not wait for a refusal to learn this. A heredoc that only reads, or that writes under `/tmp` or a build directory, is untouched.

## The edit program

Write the multi-line edit as an **edit program** — a small program `tugtool` executes itself, which prints the same `TUG-FILE-RECEIPT` an `Edit` would have earned:

```bash
tugtool file edit <<'EDIT'
file src/app.ts
  replace "  // The old comment." with "  // The new comment."
  patch <<
     return (
-      this.container.clientHeight -
-      GAP_PX -
-      GAP_BOTTOM_PX
+      this.container.clientHeight - GAP_PX - gapBottomPx()
     );
>>
  delete 166 .. 178
file docs/notes.md
  after "## Open questions" insert <<

- Does the archive hold the 1921 register?
>>
files src/lib/digest-store.ts src/lib/model-store.ts
  sub /\bdigest_(\w+)/ 'model_$1' all
EDIT
```

Three rules carry nearly every refusal an edit program has ever earned:

- **A body is the file's bytes, verbatim.** Indent every line exactly as the file does, keeping the structure *inside* the block, never squared off under the op line. It is the same thing an `Edit`'s `old_string` is.
- **A block that replaces a block is a `patch` hunk** — one prefix byte per line (` ` context, `-` out, `+` in) and the file's own indentation after it, which is how the indentation stays visible instead of being reconstructed.
- **A literal that contains `'` goes in `"…"`** — never `'"'"'` or `'\''`, which are the shell's idiom. An edit-program literal is not a shell string.

A `<<` body is also an **address**, wherever an address goes — so `after << … >> insert << … >>` anchors past a whole block when no single line in it is worth naming, and beats a line number, which goes stale the moment anything above it moves. `before` takes the block's first line, `after` its last.

Every address resolves against the file's **original** bytes before anything is written. So `delete 166 .. 178` means the lines you just read in `grep -n`, however many lines another op inserts above them; ops go in any order; and a program that cannot resolve writes nothing and reports *every* stale address at once — its last line says so, counting the ops that did resolve, and every one of them is still to do. `replace` and `sub` default to `expect 1`; say `all` for a rename across a file. A no-match exits non-zero rather than succeeding quietly.

Preview with `tugtool file edit --preview`, which touches no bytes and no mtime and emits no receipt. `tugedit` is the same verb under its own name.

## The rest of the verbs

```bash
tugtool file edit --patch changes.diff            # a unified diff you already have; --patch - reads it from stdin
tugtool file probe --patch p.diff -- <command>    # patch, run, restore
tugtool file run -- <your formatter>              # run a rewriter, receipt what it moved
tugtool file rm 'build-notes/*.md'                # globs are expanded by the verb, and every file is named in the receipt
tugtool file mv docs/notes.md docs/research-notes.md
```

- **`edit`** is the whole of file editing from the shell: the program shape above for what an interpreter would otherwise be reached for — several literal pairs on one file, a count guard per pair, a block replaced by a block, a region between two markers, the same rename across several files, a numeric line-range delete, a block appended, a span cut — and `--patch` for a diff you already hold. Either way it prints the same receipt.
- **`probe`** is the patch → run → revert cycle in one command: it restores the bytes afterwards and records nothing. Use it instead of reverting by hand, which leaves a spurious mark on the file it touched, and instead of `git checkout --`, which would also destroy any uncommitted work already on those paths. It restores bytes and **advances the mtime**, so a build system that compares timestamps sees the restored source as newer than anything built during the probe.
- **`run`** is for the tool that writes files you did not author. A formatter run over a whole project names none of its files, so nothing can read it — `file run` watches the command instead, fingerprints the project by content before and after, and receipts exactly what moved. A file the command merely touched is never claimed, and the command's own output and exit status pass straight through. Narrow it with `--scope <path>` when you know where the writes land.
- **`rm`, `mv`, `cp`** expand their own operands, so a glob or a variable still names every file it affected.
- `sed -i`, `perl -i`, and `ruby -i` are readable **only when every file operand is a literal path**. With a glob or a variable they are denied by the gate and steered here. Even when readable they are a worse edit program: no count guard, no preview, and a no-match that succeeds quietly.
- `rustfmt`, `prettier --write`, `eslint --fix`, and `biome` are readable on the same terms. A glob is *not* a literal path: a formatter expands its own, so `'src/**/*.ts'` names a set even though the shell left it alone. Those, a bare directory, and a whole-project formatter are what `file run` is for. A `--check` run writes nothing and is never touched.

## The computed edit

If the edit is genuinely *computed* — a replacement each match decides for itself — run the program **read-only** to print the result, then put that output into a `write` or `replace` op. The read is a heredoc the gate never minds; the write is a receipt.
