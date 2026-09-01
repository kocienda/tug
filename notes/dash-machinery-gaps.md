# What one dash run hit in an afternoon

**Observed 2026-08-31, release-main, project `tug`, dash `lens-breakout`, walking step 3 of a six-step task list under an arc.** One step got walked and committed. Getting there surfaced nine separate defects and gaps, most of them independent of each other, several of them silent.

The two session-identity defects have their own write-up — [wheel-rotation-strands-the-arc.md](wheel-rotation-strands-the-arc.md) — because they are one story and they are the worst of it. This note is everything else, plus the connective tissue: **what a run actually runs into**, in the order it meets it.

---

## 1. The Step Status Ledger is a one-way ratchet

`tugtool dash step` offers `start`, `done`, `withdraw`. There is no verb that returns a row to `pending`.

The transitions that exist:

| from | to | verb |
|---|---|---|
| `pending` | `in progress` | `start` |
| `in progress` | `done` | `done` |
| `in progress` | `withdrawn` | `withdraw` |
| `withdrawn` | `in progress` | `start` |

The transitions that do not: `in progress → pending`, `done → anything`. `pending → done` is refused by design (correctly — it keeps the fraction honest), and `start` on a `done` row is refused too. So the only reverse edge in the whole machine is `withdrawn → start`.

**Why that bites.** A step opened and then abandoned — the run is interrupted, the plan turns out to need re-cutting, the session gets stranded — has nowhere to go. `withdraw` is the wrong tool and quietly so: it means *"a step the run decided not to walk"*, it **counts toward the run's completion exactly as a `done` does** (withdrawing the final declared step arms the join), and a later resume **skips** withdrawn rows because "resuming at one would re-open a decision the run already made." Using it to park an unstarted step tells the next session that step 4 is settled when it is not, and can arm a join over unwritten work.

So the only way to park an opened step is to hand-edit the markdown table — which is precisely what the skill tells you never to do, because the ledger row and the dash-log line are supposed to move together.

**What is wanted:** `tugtool dash step <name> reset <n>` — row back to `pending`, commit cell cleared, and a paired log line so the log does not diverge. Worth deciding at the same time whether `done` should be resettable (an audit that rejects a step's work has the same problem one row over).

## 2. A hand-edited row silently desyncs the dash-log

Because there is no `reset`, the row gets edited by hand, and the dash-log keeps a `step start 4` line with no matching close. `dash status` reads the markdown table and reports correctly; anything deriving `implementing (i/N)` from the **log** reads one step ahead. The two surfaces disagree and nothing says so.

The verbs' own docstring names this as the reason they exist ("the ledger row and the log line move together, which is what lets `dash status` and the Changes card report `implementing (i/N)` without re-parsing markdown"). The gap is that the verb set does not span the states a real run passes through, so the discipline has to be broken to make progress — and breaking it is unlogged.

## 3. `tugtool dash bind` reports success in two different failure modes

Detailed in the sibling note; recorded here because the *shape* is the finding and it is not unique to `bind`.

- Called with a stale `$TUG_SESSION_ID` (the ordinary state of a rotated session), it writes the binding onto a closed, demoted row and exits `ok`.
- Called with the **correct** live segment, it writes the right row and exits `ok`, and the card still shows nothing, because the spawn ack is the binding store's only writer.

A verb whose entire job is "make this session bound to this dash" returns success in both the case where it addressed the wrong session and the case where nothing can read what it wrote. **A bind that lands on a `closed`/`demoted` row should be an error.** A bind that cannot reach the seated card should say so.

## 4. `dash bind` has no `--session`, and its error message misleads

`run_bind` resolves the session only from the environment. Recovering from a rotation therefore requires `TUG_SESSION_ID=<live id> tugtool dash bind <name>` — prefixing the variable the tool reads, which is not an affordance so much as a workaround that happens to work.

`calling_session_id`'s refusal reads:

> no session — dash binding names the calling session, so run this from a Session card or set TUG_SESSION_ID

Both branches are wrong for the case that actually happens. Running it from a Session card is exactly where the stale value comes from, and "set TUG_SESSION_ID" does not hint that the one already set may name a corpse. A `--session` flag plus a refusal that names the resolved id and its `state` would have collapsed an hour of digging.

## 5. A step committed green while leaving an app-test red

`tests/app-test/at0401-sidebar-split.test.ts` was green at `abf230c42` (main, pre-dash) and red from `7a6b7083c` (step 2 of this dash). Step 1's commit message lists at0401 among the app-tests it ran; step 2's does not — it changed sidebar and pane code, and the test that exercises a shared rail was not in its selection.

This is the failure the `@covers` selector exists to prevent, so the question is which link gave: whether at0401 lacks a `@covers` line for what step 2 touched, whether `app-test-changed` was run at all for that step, or whether the selection was correct and the run was skipped. Worth settling, because the step's own commit message reads as a thorough verification list — it is convincing, and it was wrong.

The step-3 run found it only because a `data-lens` → `data-rail-side` rename forced at0401 to be run at all.

## 6. The app-test history line is ambiguous about its own baseline

The `Failures:` section annotates each red file with history. What it printed:

```
history: red in the last recorded run, back to 7a6b7083c (2026-08-31); last green abf230c42 (2026-08-31)
```

"back to `7a6b7083c`" is readable two ways: *this file has been red since that commit*, or *the red runs on record go back as far as that checkout state* — which, on a dirty worktree, includes runs made minutes ago from the same session that is reading the line. Both readings were live during this run and they support opposite conclusions ("step 2 left it red" vs "you just broke it"). Settling it took a `tugtool file probe` with a reverse patch to run the test against the pre-change tree.

The record has the facts; the sentence does not distinguish committed-state runs from dirty-tree runs. Naming the dirty runs as dirty, or reporting the last **clean** green separately, would make the line answer the question a reader brings to it.

## 7. `at0401` is flaky at the ⌘-unpin assertion

Same file, separate issue. `at0401-sidebar-split.test.ts:856` — *"⌘ at the release unpins it to free pixels"* — failed once and passed on an immediate re-run with no change in between. The gesture is `nativeDragElementWithoutRelease` + `nativeMouseUp` inside `withModifiersHeld(["cmd"])`, so a modifier-state or drag-timing race is the obvious suspect.

It matters more than an ordinary flake because it sits **after** the assertion that a rename had just broken, so its first failure read as a second regression rather than as noise.

## 8. Pre-existing red on `main`, unrelated to any dash

`tugcode/src/__tests__/plugin-commands.test.ts` fails on `main` at `8dba15f59`:

```
Expected to contain: "Dash directly"
Received: "Dash — sharpen an idea into a brief and a task list, then hand it to the wheel, …"
```

The test asserts the `/dash` skill's frontmatter description contains "Dash directly"; commit `4cd1c9a45` rewrote that frontmatter. The test's own comment explains the intent — *"the leading phrase names the door (the direct dash) rather than any one wording of what it does"* — so the assertion was meant to survive rewording and did not.

## 9. The declared build launches the app

`tugtool dash config` reports `build: just app-debug`. That recipe builds **and launches** a debug instance (`Tug-debug-tugdash-<name>.app`), after quitting any prior one. Running it as a step checkpoint — step 3's checkpoint names "a build of the Swift host" — spawns a window the user did not ask for, which during an already-confusing session read as further evidence that something had gone wrong with their card.

Either the declared `build` should be build-only with launching left to the skill's explicit "offer a build" step, or `dash config` should say that the declared build launches.

---

## The pattern worth naming

Six of the nine are the same shape: **an operation reports success while achieving nothing** (`bind` twice over, the hand-edit's unlogged divergence), or **a record is convincing and wrong** (step 2's verification list, the history line's baseline, the flake reading as a regression).

Nothing here was caught by a guard. Every one was found by a person looking at a screen and saying *that is not what I expect*. For a facility whose whole premise is that a run proceeds unattended across rotating sessions, that is the finding underneath the other nine.

## Smaller edges, recorded without argument

- `tugtool file edit` refuses a program where a whole-file `sub … all` op overlaps a `patch` op on the same file ("ops never observe each other"). Correct, and it means a rename-plus-restructure of one file takes two invocations. Worth a line in [tugedit.md](../tuglaws/tugedit.md) so the split is expected rather than discovered.
- A `patch` hunk with no `-` or `+` line is refused as changing nothing. Right, but the natural way to write "rename this token inside this comment" is a one-line hunk, and the refusal does not point at `replace` as the op that wants doing.
- `just db-inspect sessions` resolves a different database than `$TUG_SESSIONS_DB` on an instance-scoped install; the per-instance ledger has to be inspected by path. The two schemas differ, so the mistake surfaces as `no such column` rather than as an empty result — which is lucky.
