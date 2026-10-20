# What a tool call reports

Every tool call is rendered as a block the user reads, and for a shell command the **exit status is the only thing the block has to go on**. Non-zero paints it red. The card cannot know what you meant by the command, so the meaning has to be in the command itself.

**Never write a call whose expected answer is a non-zero exit.** The usual shape is a probe chained onto a real query with `&&`:

```bash
tugtool brief dir --json && ls briefs/some-name.md   # red when the name is free — which was the good news
```

The `ls` failing *is* the answer being sought. Because it is last in the chain its status becomes the whole call's, so the block goes red over a call that did exactly what it set out to do.

Write the probe so its verdict cannot become the call's:

```bash
test -e briefs/some-name.md && echo TAKEN || echo FREE
ls briefs/some-name.md 2>/dev/null || true
tugtool brief dir --json; ls briefs/some-name.md     # `;` sequences; `&&` declares a dependency
```

Better still, do not ask twice. When a command already carries the answer — `tugtool brief dir --json` reports `exists` — read it from the result you already have rather than bolting a second check onto it.

Reserve `&&` for a genuine dependency, where the second command is pointless if the first failed. That is the case where red is true.

The reason is not tidiness. A red block that turns out to mean nothing teaches the reader to skim past red, and the next one will be real.

## A test run is a call of its own

A Bash block that runs a test suite draws the run as it goes — a count, a progress bar, a row per unit, the reds as they land — and the block can only do that for a call it can read. Before the call runs, the line is read to find the test runner in it (`cargo nextest run`, `cargo test`, `bun test`) and arrange for the run to report to its block. A line holding a here-document, a `$(…)` or a backtick cannot be read with certainty, so nothing in it is touched, and the run inside it sits silent for its whole length, however long that is.

So **give a test run its own Bash call**:

```bash
tugtool file edit <<'EOF'      # one call: the edit
…
EOF
```

```bash
cd web && bun test src/lib 2>&1 | tail -20      # the next call: the run
```

Not this, which runs the same tests and shows none of it:

```bash
tugtool file edit <<'EOF'
…
EOF
cd web && bun test src/lib 2>&1 | tail -20
```

What may share the run's call is what cannot hide it: a `cd` in front, environment assignments, a redirection, a pipe into a filter, a type check chained ahead of it. What may not is a here-document, a `$(…)` or a backtick anywhere in the line — an edit program, a captured variable, a `for f in $(…)` loop. Do the edit, take the reading, build the list in one call, and run the tests in the next.
