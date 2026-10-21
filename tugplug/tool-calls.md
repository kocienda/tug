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

A Bash block that runs a test suite draws the run as it goes — a count, a progress bar, a row per unit, the reds as they land — and the block can only do that for a call it can read. Before the call runs, the line is read to find the test runner in it (a known or declared runner, which `tugtool report runners` lists — see the four rungs below) and arrange for the run to report to its block. A line holding a here-document, a `$(…)` or a backtick cannot be read with certainty, so nothing in it is touched, and a run inside it would sit silent for its whole length, however long that is — so a known or declared runner on such a line is refused outright, with the split that fixes it, and a line of that shape with no runner in it is left as typed.

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

## Tail the screen, never the record

**A build or a test run runs in the foreground.** Never send one to the background to read its result later: a backgrounded run reports to no block, its verdict arrives as a notification with nothing to attach to, and the record it should have written is the one thing left to go looking for. The time a long run needs is given as the call's `timeout`, not bought by backgrounding it — and a known or declared runner needs none supplied, because the hook reads the suite's recorded median and sets the timeout itself, only ever raising what the call asked for. A known or declared runner written with `run_in_background` is refused, and the refusal names the foreground `timeout` to pass instead. The one exception is a process that is **meant** to outlive the call — a dev server, a file watcher, a sampler that reads a running program — which has no verdict to wait for and belongs in the background by its nature.

**A wrapped run ends with its verdict line, and that is the contract a tail relies on.** Every run the hook wraps ends on a `[test]` line carrying its verdict — the count when green, the reds and a pointer at the record when red — and a build wrapped the same way ends on the same shape. So `2>&1 | tail -3` is always enough to read a run's answer, for a build as for a test suite, and anything the tail hid is in the record: `tugtool test last --failures` names the reds of each suite's latest run, and `tugtool test last --call <id> --failures` names every red recorded under one call when several runs went under it, as a verify's do. Tail the screen, never the record.

**A runner is never piped into `grep` or `head`.** A filter in front of a run's output guesses in advance which lines will matter, and a build or a suite is the one kind of command whose interesting lines cannot be guessed: a `grep` for `error` misses the panic, a `head` stops before the verdict, and either one takes the pipeline's exit status with it. The hook refuses a known or declared runner piped into `grep`, `egrep`, `fgrep` or `head` and shows the `tail -3` form; a `tail` is fine, and a `grep` after a `tail` is fine, because the verdict has already been kept.

**The sentence the rest rests on: never need to recover data after a long call.** Every rung of the ladder below, the foreground rule above, and the record behind `tugtool test last` exist so that a long call is written, before it runs, to put its result where a cheap read finds it — on the block as it runs, in its last three lines when it ends, and in the record when the tail was not enough. A call that leaves you searching its output for what happened was written wrong, and the fix is in how the next one is written, never in a second run to read what the first one lost.

## Every long call reports

Before a Bash call, apply one test: **could this run twenty seconds?** If it could, decide which rung below it is on before writing it. Twenty seconds is the line past which a silent call is recorded as a gap, so the rule and the record agree.

A Bash block that knows how far its command has got draws a report panel: a count, a bar, a row per unit, the reds as they land. There are four ways for a command to report, from no work at all to a single line — the report ladder. Take the first one that fits.

**1. A known or declared runner needs nothing.** The hook reads the command before it runs and wraps a known or declared runner, so its block reports by itself; `tugtool report runners` lists what is known from where you stand. A project declares its own runner in `.tugtool/config.toml`, keyed on the command's leading words:

```toml
[[tugtool.report.runner]]
match = "make check"
kind = "lines"
item = '^(?P<status>PASS|FAIL): (?P<name>\S+)'

[[tugtool.report.runner]]
match = "scripts/run-suites"
unit = "file"
```

A row with a `kind` is wrapped in `tugtool test run` (rung 3 below); a row with only a `unit` names a command that reports for itself (rung 2), and the hook passes it the call's id so its reports reach the right block.

**2. A loop over items reports each one.** A script that walks files, targets or suites says so with `tugtool report unit`, one line per move, and builds no JSON:

```bash
tugtool report unit plan checks --unit file --of a.sh b.sh c.sh
for f in a.sh b.sh c.sh; do
  tugtool report unit start checks "$f"
  if sh "$f"; then tugtool report unit done checks "$f" pass; else tugtool report unit done checks "$f" fail; fi
done
tugtool report unit finish checks
```

`plan` draws every item as pending, `start` and `done` move one, and `finish` closes the run. `done` takes `--passed`/`--total` for the tests inside an item, and `--title`/`--message` for a red item's first failure.

**3. An unknown runner is wrapped.** `tugtool test run --suite <name> --kind tap|junit|lines -- <command>` runs the command, passes its output through unchanged, follows its progress, and records the result so `tugtool test last --failures` can name the reds later. `tap` reads TAP on stdout; `junit` needs `--junit <path>`, the document the command writes, and records it at exit; `lines` reads one item per line with `--item <regex>`, whose `name` and `status` named groups say which item and how it went, `--total <regex>` with a `total` group for the count up front, and `--stream stdout|stderr` for where the lines are:

```bash
tugtool test run --suite checks --kind lines --item '^(?P<status>ok|FAIL) (?P<name>\S+)' -- ./run-checks
```

The status words a `lines` item may carry are listed by `tugtool test run --help`: `pass`, `ok` and `✓` read as a pass, `fail`, `not ok` and `✗` as a fail, `error` as an error, `skip`, `pending` and `todo` as skipped, among others. A line whose status is none of them is not an item.

**4. A command that only knows a count reports the count.** `tugtool report count --label <label> --done <n> --total <t> "<text>"` sets the bar and the line, and `--failures <n>` keeps the reds counted. A wait has no count at all: `tugtool report wait --label <label> --until '<probe>' [--every <secs>] [--for <secs>]` runs the probe until it exits 0, shows how long it has waited and the probe's last line, and exits 1 at the deadline.

Every row the panel draws carries a `status`, one of `pending running pass fail error stalled skipped`, and beside it the item's `name`, its 0-based `index`, and as known its `passed` and `total` tests, its `secs`, a `median` it is expected to take, a `title` and `message` for its first failure, and a `history` line. `stalled` is an item stopped because it ran far past its time, which is a machine state rather than a test result.

**What to adopt next is on record.** `tugtool report gaps` ranks the command heads that ran twenty seconds or more and reported nothing, by count and by total time. The head at the top is where the next declared runner or the next `report unit` loop pays for itself. A quick command that once hung is listed apart, under stalled calls, since it wants a look rather than a report; and a head marked *declared, still silent* is a runner the hook knows that ran dark all the same — behind a heredoc, or by a row that does not report.