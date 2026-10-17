<!-- brief-skeleton v1 -->

# The app-test bodies migration: the cut corpus runs on bodies

**Purpose:** Every card kind is a body, and the user has ruled that bodies become the only mode, but 492 of the corpus's 539 files still launch with bodies off and test a card host the product is leaving behind. This brief records where the cut corpus stands, decides how the rest of it comes onto bodies batch by batch, and cuts Tug over to bodies only: no shipping switch, no in-document card host, no harness option.

---

## Purpose {#purpose}

This is step 7 of the corpus cut (`briefs/app-test-corpus-cut-brief.md`), whose order the user set on 2026-10-16:

1. Move the readings out of the corpus.
2. Delete the transcript-seeding motion files, after one settle-verb reading of the same gestures on the real app.
3. Take the product reds, rows 5 and 6 first.
4. Split, speed up or delete every other file over 20 seconds.
5. Cut the redundant, obsolete and browser-control files, each list approved by the user first.
6. Change the runner so progress stays visible.
7. Migrate what remains onto bodies.

Steps 1–6 are done. Step 6 landed as the `run-panel-adoption` arc (joined `5a0057361`). The cut brief's [B09] already decided step 7's shape: "What remains after [B01]–[B06] moves onto bodies in batches of ten to fifteen files grouped by card kind, each batch opting in with the launch's `bodies` option and run alone as its verdict, fixes landing in the same commit. The harness default flips to bodies in one line once no file is left un-opted. The quarry branch and patches are mined, never merged."

The first attempt flipped the whole corpus at once and stalled the every-card-a-body arc for hours. The user's standing complaints about the corpus apply to this step too: no file over 20 s, no lingering reds, "I want to retain the findings which point to actual bugs."

---

## Evidence {#evidence}

**[F01] The corpus after the cut: 539 files, 47 already on bodies.** That is 440 top-level files and 99 in `body-grounding/` and `harness-smoke/`. Every file that opts in does so with `bodies: true` on `launchTugApp`. Eight top-level files do: the six `at0738-body-*`, `at0741-every-kind-a-body` and `at0742-reconnect-gap`. The other 39 are grounding rows and smoke files. So 432 top-level files and 60 grounding and smoke files launch bodies off. **(verified: counted on `002150a45`)**

**[F02] 217 files reach a card's DOM through the shell's page.** `scripts/card-dom-census.ts` lists every page-evaluating call whose text holds a card selector on a receiver that isn't a body. `scripts/card-dom-allow.json` holds the 242 `{file, kind}` pairs not yet migrated, across 217 files. One of those files is in `body-grounding/`. By kind:

| Kind | Pairs |
|---|---|
| `session` | 77 |
| `layout` | 29 |
| `cards` | 29 |
| `text` | 25 |
| `dashes` | 20 |
| `overview` | 19 |
| `unknown` (the census could not name a kind) | 17 |
| `jots` | 11 |
| `settings` | 6 |
| `gallery-prompt-entry` | 3 |
| `gallery-accordion` | 2 |
| `fixture-markdown-1kb`, `diff`, `keyboard`, `commit` | 1 each |

`just app-test-body-scope-check` runs `--check` and fails on an entry the list doesn't allow. The census's own doctrine is that a file's pair "leaves the list in that kind's change, and the list is empty once every kind is a body." **(verified, run)**

**[F03] The other 225 top-level files reach no card DOM by the census's reading.** Against the quarry triage's bins:

| | Reach card DOM | Reach none |
|---|---|---|
| *kept* | 138 | 81 |
| *shell* | 29 | 97 |
| not in the triage (split pieces and newer files) | 48 | 47 |

The census scans call text only. A file that reaches no card DOM can still go red on bodies through a harness verb that asks the shell about a card ([F06]). **(verified, counted; the cross-tab is against the triage's bins, which [F05] says are a starting point)**

**[F04] Bodies are off by default in both the product and the harness.** `BodyGeometry.bodyViewsEnabled` (`tugapp/Sources/BodyGeometry.swift`) reads the tugbank setting `dev.tugapp.deck`/`bodies`, which is false unless set. Under the harness, a launch also opts in with `TUG_BODY_VIEWS=1`, which the `bodies` option on `launchTugApp` sets (`_harness/types.ts`: "Off by default, which is today's launch"). The user ruled on 2026-10-16 that bodies-off is going away. On that ruling, step 5 deleted the files whose premise was the in-document card host (the cut brief's [B06]). **(verified, read)**

**[F05] The first attempt, and what it left on the quarry branch.** The every-card-a-body arc's steps 10 and 11 flipped every file onto bodies under a 10 s budget, and 324 of 486 went red together. That work was retracted to `quarry/every-card-a-body-corpus`, five commits past the step-9 join:
- `fd91d6d04` launches every app-test on bodies.
- `a266d4fe7` writes the triage (`briefs/app-test-corpus-triage.md`: one subject per file, and a bin of `covered`, `obsolete`, `shell` or `kept`).
- `4cba6d19f` moves card reaches onto bodies by machine, with `scripts/card-dom-codemod.ts`, which is on main.
- `5f14749cd` answers the session verbs in the body: `tugdeck/src/test-surface.ts`, 263 lines.
- `7864c3910` brings the first 98 red files over in seven fixer passes. It adds drag and mouse-up verbs to `BodyApp` and gives the body page its own `UsageStore` and `ingestUsage` (`tugdeck/src/body/body-main.ts`, `body-root.tsx`, `action-dispatch.ts`).

`7864c3910`'s message names five product gaps:
- a Session-card body never receives a seeded bag through bind;
- tugcast asks reach only the shell;
- the Jots body never gets a `NEW_JOT` edit;
- a second rail on one edge is never placed;
- body activation promotes an anonymous responder.

The uncommitted remainder was saved as patches in `.tug/arcs/every-card-a-body/`. That directory is gone now; `.tug/arcs/` is empty. **(verified: the commits and stats read from git; whether each named gap still holds on main is not verified, and nor is whether main already carries any of the quarry's harness or product changes)**

**[F06] On the quarry, six core-tier files went red the same way, through the shell asking about a card that now lives in a body.** The triage's own words: "`window.__tug.assertHostRootRegistered("A")` timing out, the shell's card verb asked about a card that now mounts in a body." That is a harness verb (`_harness/client.ts`, `assertHostRootRegistered`) answered by the shell's test surface. The census doesn't count it, because the call text holds no card selector. **(verified, read from the triage; which other shell-side card verbs share the shape is not enumerated)**

**[F07] Helpers that answer on either path already exist.** `App.body(cardId)` returns a `BodyApp` scoped to the card's page (`_harness/index.ts`). `_harness/card-reach.ts`'s `cardPage(app, cardId)` returns the body when the host holds a bound one and the shell otherwise, "so a file that uses them keeps passing on either path." `body-grounding/_kinds.ts` holds each kind's marks, and `_kind-bodies.ts` stands a kind up. **(verified, read)**

**[F08] The core tier is 13 files after the cut**, three of them `harness-smoke` and one `body-grounding/row-07-focus`. Only `row-07-focus` launches with bodies on. **(verified: `bun scripts/select-tests.ts --core`)**

**[F09] The product branches on bodies in a known set of places.**
- **Host.** `BodyGeometry.bodyViewsEnabled` decides once, at window creation (`MainWindow.swift`), and `BodyViewController.swift` guards on it. `HostCapabilitiesScript` tells the shell `bodyViews` before its first script.
- **Shell.** `hostCapabilitiesStore.get().bodyViews` is read by `lib/body-handoff.ts`, whose `isBodyKind` is the capability AND the registration's `body === true`. It is also read by `body-placement.ts`, `body-shell.ts`, `pointer-claim.ts`, `settle-engine.ts` and `session-card-registration.tsx`.
- **The setting.** The Layout card's Bodies row (`layout-card.tsx`, `BODY_VIEWS_DOMAIN`/`BODY_VIEWS_KEY`) writes `dev.tugapp.deck`/`bodies`.
- **The other half.** Where `isBodyKind` answers false, the card mounts in the shell's document through `card-host.tsx`. That is the in-document card host, the path bodies-off keeps alive.

**(verified: `git grep` for `bodyViews`/`bodyViewsEnabled`; which code is reachable only from the false branch is not enumerated)**

---

## Decisions {#decisions}

**[B01] The migration goes in batches by card kind, each batch run alone as its verdict, with its fixes in the same commit.** This carries the cut brief's [B09].
- **Size and grouping.** A batch is ten to fifteen files. They share the kind whose card they reach, which is the kind their allow pairs name.
- **Opting in.** Each file opts in with `bodies: true`.
- **The verdict.** A batch's verdict is its own files run once, after its last edit. It is never a derived union, and never the corpus.
- **Why.** The all-at-once flip made 324 reds that no one could tell apart. A kind's batch shares one body page and one set of reaches, so its reds share causes.
- **What would reopen it.** A kind whose files cannot pass without a product change that spans kinds; that change then lands first, as its own batch.

**[B02] A file moves to bodies by moving its reaches, never by deleting what it asserts.**
- **The move.** Each card-DOM reach goes through `App.body(cardId)` or `card-reach.ts`'s helpers ([F07]).
- **The allow list.** The file's `card-dom-allow.json` pair leaves the list in the same commit, so the census stays the ledger of what's left. When the list is empty, the census's job is done.
- **Never re-pointed.** An assertion is never changed to match what bodies happen to do. A test that has to move must still assert the same guarantee in its new place.
- **A gone premise.** If a file's premise is gone under bodies — it reads one document for something that now spans two — the file goes on a removal list. The user approves that list before anything is removed, as in the cut brief's [B06]. It is never deleted inside a batch on the batch's own say.

**[B03] A red that points at the product is fixed in the product, in the batch that found it.** This is the cut brief's [B05], applied to bodies. On the user's daily deck bodies are on, so a body defect a migrated file finds is a defect users see. It is fixed, with the migrated file as its guard. Nothing ships as "known red": a batch ends green or does not land.

**[B04] Harness verbs that ask the shell about a card answer for bodies before the first kind batch.**
- **Why first.** `assertHostRootRegistered` and any verb of its shape ([F06]) go red on every file that calls them, whatever its kind. Fixing them inside a kind batch would spread one cause across every batch.
- **How.** They are found by reading `_harness/client.ts` and the test surface, and made to answer from the card's body when it has one.
- **The check.** This is a harness change, so the core tier runs once on it (`just app-test`), per `CLAUDE.md`'s CORE TIER ADVISED rule.

**[B05] The quarry is mined, never merged, and each of its findings is checked against main first.**
- **The quarry's changes.** Its harness and product changes ([F05]) are taken over one by one, where a batch needs them. They are not cherry-picked as commits: main has moved since, and `7864c3910` also carries file splits that the cut has since done differently or deleted.
- **The named gaps.** Each of the five product gaps is reproduced on main before it is fixed or dropped, and the brief records which way each went.

**[B06] Files that reach no card DOM come over in batches too, grouped by the kind they seat.** The 225 files of [F03] still launch an app whose cards will be bodies. Whether one passes unchanged is a run result, not a reading. Each is batched with the kind its deck seeds, or with a "shell" batch when it seeds none, and opts in like any other.

**[B07] No file goes over 20 s on bodies.** This is the cut brief's [B02]. A body costs more to stand up than a shell subtree, so a migrated file that crosses the line is split along its own `test(` blocks into an `@family`, made cheaper, or put on a removal list for the user. It is never carried over budget.

**[B08] The harness flips last among the test changes, in one change, when no file is left un-opted and the allow list is empty.**
- **The flip.** Every launch has bodies. The `bodies` option on `launchTugApp` and `TUG_BODY_VIEWS` are deleted, not defaulted: under [B09] there is no other mode to ask for.
- **The opt-ins.** The flip commit removes every `bodies: true` line.
- **The final run.** The flip touches the harness, so the core tier runs on it once.

**[B09] Tug cuts over to bodies only, in this arc (the user, 2026-10-16: "We really need to cut over to bodies only. Let's do so here. The only way is forward!").** Bodies stop being a mode:
- **No switch.** The tugbank `dev.tugapp.deck`/`bodies` setting, the Layout card's Bodies row, `BodyGeometry.bodyViewsEnabled` and `HostCapabilitiesScript`'s `bodyViews` are removed. A value left in a user's tugbank is ignored; with no installs in the wild there is no migration to write.
- **No in-document card host.** Every branch on `bodyViews` ([F09]) takes its bodies arm unconditionally. Code reachable only from the other arm — the in-document mount through `card-host.tsx`, and whatever serves only it — is deleted, along with the unit tests that exercise only that arm.
- **The order.** The cut-over lands after [B08]. Until every file is on bodies, an un-migrated file is the guard for the path still under it, and removing the path first would turn the whole remainder red at once, the shape [F05] retracted.
- **A shell-only kind.** If a kind turns out not to be a body after all, it is made one in this arc rather than kept on the in-document host, since the host is what this decision deletes.
- **The check.** The cut-over touches the host and `tugdeck/src/main.tsx`'s startup, so the core tier runs on it once.

---

## Open Questions {#open-questions}

- **Do the five gaps `7864c3910` named still hold on main?** Answered by [B05]'s reproduction. Any that hold are product work this arc owns under [B03].

---

## Non-goals {#non-goals}

- **Flipping every file at once.** This was tried in every-card-a-body steps 10–11 and retracted ([F05]).
- **Merging or cherry-picking the quarry.** Main has moved past it, and its file-level work predates the cut ([B05]).
- **Rewriting a file's subject while moving it.** A migration changes where a file reaches, not what it asserts ([B02]). A subject worth changing is its own decision.
- **Cutting more of the corpus in passing.** Removals go through a list the user approves ([B02], [B07]), not a batch's judgement.
- **A whole-corpus run between batches.** Each batch's verdict is its own files ([B01]). The core tier runs only where a harness change asks for it ([B04], [B08]).

---

## Exit {#exit}

**An arc**, walking the batches on its own worktree. The first steps:

1. **Read the quarry against main ([B05]).** Find which of `5f14749cd`'s and `7864c3910`'s harness and product changes main lacks, and reproduce the five named gaps.
2. **Make the shell's card verbs answer for bodies ([B04]),** then run the core tier on bodies once.
3. **The kind batches ([B01], [B02], [B03]).** A small kind first (`settings`, `jots`) proves the batch's shape. After that, the order is the arc's call. `session`, at 77 pairs, is several batches on its own, and `unknown`'s 17 pairs need a kind named before they can be batched.
4. **The no-reach files ([B06]),** batched with the kind they seat.
5. **The harness flip ([B08]),** deleting the `bodies` option.
6. **The cut-over ([B09]):** the switch and the in-document card host removed from host and shell, and the core tier run once.
