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

A Bash block that runs a test suite draws the run as it goes — a count, a progress bar, a row per unit, the reds as they land — and the block can only do that for a call it can read. Before the call runs, the line is read to find the test runner in it (`cargo nextest run`, `bun test`, `pytest`, `go test`, or one the project declares — see the four rungs below) and arrange for the run to report to its block. A line holding a here-document, a `$(…)` or a backtick cannot be read with certainty, so nothing in it is touched, and the run inside it sits silent for its whole length, however long that is.

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

## The run panel has four rungs

A Bash block that knows how far its command has got draws a run panel: a count, a bar, a row per unit, the reds as they land. Anything that runs long should report, and there are four ways to, from no work at all to a single line. Take the first one that fits.

**1. A known or declared runner needs nothing.** The hook reads the command before it runs and wraps a runner it knows, so its block reports by itself. `tugtool run runners` lists what is known from where you stand. A project declares its own runner in `.tugtool/config.toml`, keyed on the command's leading words:

```toml
[[tugtool.run.runner]]
match = "make check"
kind = "lines"
item = '^(?P<status>PASS|FAIL): (?P<name>\S+)'

[[tugtool.run.runner]]
match = "scripts/run-suites"
unit = "file"
```

A row with a `kind` is wrapped in `tugtool test run` (rung 3 below); a row with only a `unit` names a command that reports for itself (rung 2), and the hook passes it the call's id so its reports reach the right block.

**2. A loop over items reports each one.** A script that walks files, targets or suites says so with `tugtool progress unit`, one line per move, and builds no JSON:

```bash
tugtool progress unit plan checks --unit file --of a.sh b.sh c.sh
for f in a.sh b.sh c.sh; do
  tugtool progress unit start checks "$f"
  if sh "$f"; then tugtool progress unit done checks "$f" pass; else tugtool progress unit done checks "$f" fail; fi
done
tugtool progress unit finish checks
```

`plan` draws every item as pending, `start` and `done` move one, and `finish` closes the run. `done` takes `--passed`/`--total` for the tests inside an item, and `--title`/`--message` for a red item's first failure.

**3. An unknown runner is wrapped.** `tugtool test run --suite <name> --kind tap|junit|lines -- <command>` runs the command, passes its output through unchanged, follows its progress, and records the result so `tugtool test last --failures` can name the reds later. `tap` reads TAP on stdout; `junit` needs `--junit <path>`, the document the command writes, and records it at exit; `lines` reads one item per line with `--item <regex>`, whose `name` and `status` named groups say which item and how it went, `--total <regex>` with a `total` group for the count up front, and `--stream stdout|stderr` for where the lines are:

```bash
tugtool test run --suite checks --kind lines --item '^(?P<status>ok|FAIL) (?P<name>\S+)' -- ./run-checks
```

The status words a `lines` item may carry are listed by `tugtool test run --help`: `pass`, `ok` and `✓` read as a pass, `fail`, `not ok` and `✗` as a fail, `error` as an error, `skip`, `pending` and `todo` as skipped, among others. A line whose status is none of them is not an item.

**4. A command that only knows a count reports the count.** `tugtool progress --label <label> --done <n> --total <t> "<text>"` sets the bar and the line, and `--failures <n>` keeps the reds counted.

Every row the panel draws carries a `status`, one of `pending running pass fail error stalled skipped`, and beside it the item's `name`, its 0-based `index`, and as known its `passed` and `total` tests, its `secs`, a `median` it is expected to take, a `title` and `message` for its first failure, and a `history` line. `stalled` is an item stopped because it ran far past its time, which is a machine state rather than a test result.

**What to adopt next is on record.** `tugtool progress gaps` ranks the command heads that ran 20 seconds or more and reported nothing, by count and by total time. The head at the top is where the next declared runner or the next `progress unit` loop pays for itself.