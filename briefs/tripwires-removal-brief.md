# Remove the Tripwires feature

**Purpose:** Tripwires has been designed three times, has fired in anger once, and has never been observed working end to end. It is being deleted whole — every file, every wiring point, every law and decision that describes it — rather than reduced or rewritten a fourth time.

---

## Purpose {#purpose}

In the user's words, after the `tripwires-one-session` arc landed and its own app-tests left three orphaned arcs standing in the checkout:

> This work did not start off on the right foot. You left *three* turd/orphaned arcs.

> Clean this sh*t up. Then we need to pull back *again* and take stock on what this feature is and whether we should just can the whole thing.

And then, decisively:

> Delete every single bit of the Tripwires feature. The idea as it stands now is a failure. I want a completely clean sweep that removes all traces of this feature.

This brief is the inventory and the set of calls that sweep needs. It is not an argument for the deletion — that decision is made. It exists so the removal is complete rather than approximately complete, and so the handful of choices the sweep cannot make mechanically are made once, here, with their reasons.

---

## Evidence {#evidence}

**[F01] Three design generations, one real firing, and that firing is what condemned the design.** `[D189]` (nine statuses, claim/queue/supersede, post-commit inspector) was retired before any real use. `[D196]` (fact-time trigger, disposable worktree, six statuses) was used in anger exactly once, and that single trip produced the findings that retired it — the brief was beaten by an appended exit menu, a ten-minute unbounded session committed nothing and never resolved, and the one sentence the brief asked for was written to a transcript and thrown away. `[D197]` (one bounded session with hands on the tripwire's own arc, four statuses) landed on `main` as `d6eb4f50f` and **has never been run**: the arc's own step 7 commit declares the acceptance recipe a DEPARTURE. Read out of `tuglaws/design-decisions.md` and the arc's commits. **(verified)**

**[F02] Four defects stand on `main` right now, in a design that has never executed.**
- The only tripwire on the machine is unusable. `failing-commands` has an empty `repo_root` and is paused; `run_pending` fails any trip whose home checkout is empty *before* the probe runs, and `grep` over `tugrust/crates/tugtool/src/cli.rs` finds no `repo_root` flag on `lay` or `edit`, so there is no repair path short of `rm` and re-`lay`.
- A trip's session lifetime depends on unrelated UI state. `TripCardController` is mounted inside the Tripwires card's `contentFactory` (`tugdeck/src/components/tripwires/tripwires-card-registration.tsx`), so with the card open a running trip's session is carded, the resume re-points `LedgerEntry::card_id`, and `close_headless_session`'s adoption guard then refuses to close it — sessions accumulate against `max_concurrent_sessions: 64`. With the card closed they close normally. Same trip, two outcomes.
- `tugtool tripwire lay` has write side effects on the repository at *definition* time: it resolves a home checkout from `--scope` or else from its own cwd and calls `tugarc_core::ops::create_in` there. That is what cut `tugarc/tripwire-alpha`, `tripwire-alpha-probed` and `tripwire-beta` in the developer's checkout — `tests/app-test/at0492-tripwires-card.test.ts` and `at0572-tripwires-live-without-poll.test.ts` run the real CLI with `cwd: CHECKOUT`, and `TUG_TRIPWIRES_DB` isolates the ledger while nothing isolates the repository. The three arcs were discarded on 2026-09-15; the hole in the tests is still open.
- The feature has never been observed working end to end. **(verified)**

**[F03] The feature is ~18,470 lines in files that exist only for it**, before any unhooking: 13,692 lines of Rust across `tugcast` (`feeds/tripwire.rs`, `tripwire_session.rs`, `tripwire_prompt.rs`, `tripwires.rs`, `tripwires_api.rs`), `tugtool-core` (`tripwire_ledger.rs`, `tripwire_roster.rs`, `tripwire_predicate.rs`), `tugtool` (`src/tripwire.rs`, `tests/tripwire_cli.rs`) and `tugarc-core/src/tripwire_remove.rs`; 3,087 lines of deck under `tugdeck/src/components/tripwires/` plus `lib/tripwires-store.ts`, `lib/tripwires-card-id.ts` and their tests; 1,691 lines of docs and app-tests (`tuglaws/tripwires.md`, `tugplug/skills/tripwire/`, `at0492`, `at0572`, `at0576-trip-session-card.test.ts`). Counted with `wc -l`. **(verified)**

**[F04] The deck's layout fixtures use `"tripwires"` as a specimen sidebar card, and the shipped default rail names it.** `tugdeck/src/__tests__/layout-tree.test.ts` mentions it 107 times, `lib/__tests__/drop-zones.test.ts` 22, and the rail tests (`at0537`, `at0538`, `at0539`, `at0541`, `at0549`, `at0506`), `sheet-reservation.test.ts`, `deck-store-selectors.test.ts` and the cards-card tests each a handful — almost all of it as a convenient sidebar-card id rather than as the feature. `[D128]` records that the shipped default stands Cards, Arcs, Layout and Tripwires on the right rail, so removing the card also changes the deck a new user meets. This is the largest non-obvious cost of the sweep and the one place it touches code that has nothing to do with tripwires. **(verified)**

**[F05] Of the machinery this arc added *outside* the feature, exactly one piece has a caller that survives.** `facts_library::shell_call_ran` — the `<tool_use_error>` discriminator between a gate-denied Bash call and one that ran and failed — is called from `agent_bridge.rs:1017` in the general shell-fact recorder, independent of tripwires. The rest have no surviving reader: `tugarc_core::ops::arc_base_in` has one caller in the whole workspace (`feeds/tripwire.rs:881`); `LedgerEntry::tool_calls` is incremented at two sites in `agent_bridge.rs` and read only by the tripwire cap; `DeckManager.addCard`'s `activate` option and `RESUME_SESSION`'s `activate` payload field have one caller, `trip-card-controller.tsx:83`. **(verified)**

**[F06] `/tripwire` is not a local slash command, so no spelling alias is owed.** `grep` finds no tripwire entry in `tugdeck/src/lib/slash-supported.ts` or `LOCAL_SLASH_COMMANDS`; the door is the plugin skill `tugplug:tripwire`, reached by bare-name fall-through as `tuglaws/slash-commands.md` describes for `/arc`. With the skill deleted the leaf resolves to nothing, `isUnknownRemoteCommand` says yes, and the user gets the unknown-command alert — which is the correct visible outcome, not a regression. The retirement doctrine's "the spelling stays" clause applies to *renames* within the local registry and does not bite here. **(verified)**

**[F07] The live ledger is already at v12 with one paused, unusable row.** `just db-inspect tripwires` reports `PRAGMA user_version` = 12 and a single tripwire, `failing-commands`, with an empty `repo_root` and `paused` = 1. An earlier reading had it at v8; it has since migrated. Nothing on the machine holds tripwire data worth preserving. **(verified)**

---

## Decisions {#decisions}

**[B01] The design goes whole; nothing is kept in reduced form.** A probe-only tripwire — fact matches, guards run, probe runs, red probe posts to the Overview — was considered and is recorded as rejected under Non-goals. The reason for deleting rather than reducing is that a reduced version still costs a ledger, a schema, a card, a feed, a CLI verb surface and a projection, and the evidence that anyone would reach for it is the same evidence that has not arrived in three generations. Revisit only from a concrete want, not from the salvage value of code already written.

**[B02] Delete the whole dedicated surface, in every language, including its tests and its laws.** Every file named in `[F03]`; the registration and wiring points that reference them — `tugcast/src/feeds/mod.rs`, `main.rs`, `server.rs`, `actions.rs` (`tripwire_trip`), `tugcast-core/src/protocol.rs` and `types.rs`, `tugarc-core/src/lib.rs`, `tugtool-core/src/lib.rs`, `tugtool/src/cli.rs` (`TripwireCommands`) and `src/main.rs`, `tugtool/Cargo.toml`, `tugcore/src/instance.rs` (`tripwires_db_path`, `tripwire_trees_dir`, `ENV_TRIPWIRES_DB` and their tests), `tugdeck/src/main.tsx`, `action-dispatch.ts`, `deck-manager.ts`, `protocol.ts`, `test-surface.ts`, `sidebar-toggle.ts`, `components/tugways/action-vocabulary.ts` and `command-registry.ts`, and `tugapp/Sources/AppDelegate.swift` (the Tripwires menu row and the `toggle-tripwires` control); and the documentation — `tuglaws/tripwires.md`, its `tuglaws/INDEX.md` line, the tripwire clauses in `tuglaws/design-decisions.md`, `focus-language.md`, `menus.md`, `pane-model.md`, `chord-tiers.md`, `entity-presentation.md` and `state-preservation.md`, the skill entry in `tugplug/.claude-plugin/plugin.json` and `tugplug/CLAUDE.md`, the `tripwire` name in this repo's `CLAUDE.md` skill list, and the tripwire cases in `tugplug/__tests__/standalone.test.ts`. "All traces" means a case-insensitive `tripwire` search over the tree returns only the archived working papers of `[B06]`.

**[B03] `[D189]`–`[D193]`, `[D196]` and `[D197]` are deleted outright, not marked superseded.** The retirement doctrine is that a retired *design* goes whole and only a retired *spelling* is kept as an alias; `[F06]` establishes no spelling is owed here. A decision marked "superseded by nothing" is a tombstone that every future reader of `design-decisions.md` has to pay to skip, and the argument these decisions carry is preserved in the working papers `[B06]` keeps. Renumbering is not attempted — the numbers are gaps, as they are elsewhere in the file.

**[B04] The rule for the machinery added outside the feature is "delete what loses its last caller," not a taste judgment.** By `[F05]`: `facts_library::shell_call_ran` and its tests **stay**, because `agent_bridge.rs` calls it for every shell fact and it answers a question that has nothing to do with tripwires. `tugarc_core::ops::arc_base_in`, `LedgerEntry::tool_calls` and its two increment sites, `DeckManager.addCard`'s `activate` option, `RESUME_SESSION`'s `activate` payload field, and `tugdeck/src/__tests__/add-card-activate.test.ts` **go**, because nothing else reads them. `tool_calls` in particular cannot simply be left: a `pub` field written and never read is a `dead_code` warning, and the workspace builds under `-D warnings`. A capability with no caller is not an asset — the shape is recoverable from git if a second caller ever appears.

**[B05] The deck fixtures re-anchor on a surviving sidebar card rather than keeping `"tripwires"` as a phantom id.** Per `[F04]` most of those 150-odd mentions are a specimen, and the mechanical fix is a rename. Leaving the string would leave a card id that resolves to no registration, which is exactly the kind of trace this sweep exists to remove, and it would quietly weaken `component-id-rename.test.ts` and the registry drift guards. The shipped default right rail drops to Cards, Arcs and Layout, and `[D128]`'s sentence naming Tripwires is corrected in the same change.

**[B06] The working papers under `briefs/` are kept, unedited.** Thirteen files carry `tripwire` in their names and a dozen more mention it. `briefs/` is the archive of how decisions were reached, not part of the running system, and deleting it would destroy the record of three design cycles at the moment that record becomes most useful — it is the evidence any future proposal has to answer. "All traces of this feature" means the product, the tests, and the laws that govern them. `[B02]`'s search-returns-nothing test is stated against the tree excluding `briefs/` for that reason.

**[B07] The live `tripwires.db` is deleted along with the path functions, with no migration and no export.** By `[F07]` it holds one paused row that cannot run. Deleting the schema, the migration list and `tripwires_db_path` leaves an orphaned file under `~/Library/Application Support/Tug/`; the sweep removes it. The `no-installs-in-the-wild` premise — install base zero as of 2026-09-03 — means no other machine holds one and no compatibility bridge is owed.

**[B08] `at0492`, `at0572` and `at0576` are deleted rather than fixed.** The open test-isolation hole recorded in `apptest-tripwire-lay-cuts-real-arcs` becomes moot when the tests and the `lay` verb both go. `at0568-background-session-resume.test.ts` is *not* deleted — it was renamed out of the tripwire naming by the last arc and covers background session resume generally; its tripwire references are scrubbed.

---

## Open Questions {#open-questions}

- **Does any of the trigger half earn a second life under another name?** The fact ledger itself (`tugcore/src/facts.rs`) is general and stays regardless. But `tripwire_predicate.rs` — the `--where` matcher over fact payloads — is a small, tested, self-contained piece of language that nothing else currently uses. This brief deletes it with everything else under `[B02]`; if there is a known want for a predicate over facts elsewhere, say so before the arc walks, because keeping it costs one file and re-deriving it later costs a design. Nothing in the code answers this; it needs the user's read on what is coming.

---

## Non-goals {#non-goals}

- **A reduced, probe-only tripwire.** Considered seriously: fact matches → guards → probe runs → a red probe posts to the Overview, with no session, arc, caps, card, report or permission mode. It is deterministic, free when green, cannot run away and cannot touch the repository, and it preserves the one part the live vetting showed holding correctly. It is rejected because it still requires a ledger with migrations, a card, a pushed feed, a CLI surface and a projection with three callers — most of the maintenance and none of the evidence — and because a want for it, if real, will state itself concretely later. Recorded here so it does not have to be re-argued.
- **A fourth rebuild with a week of real evidence first.** Also considered: build from `main`, run the acceptance recipe, arm one tripwire, decide from data. The honest case for it is that we have never once run the thing being judged. It is rejected because three cycles have already been paid for on the same reasoning and the asymmetry now favours cutting.
- **Any deprecation period, feature flag, or compatibility shim.** `[B07]`'s premise.
- **Fixing the app-test isolation hole.** `[B08]` makes it moot.
- **Renumbering `tuglaws/design-decisions.md`.** `[B03]`.
- **Touching `briefs/`.** `[B06]`.

---

## Exit {#exit}

**An arc.** The work is large but almost entirely mechanical, and it has one hard ordering constraint: the tree must build at every commit under `-D warnings`, which means a deletion and the unhooking of its last caller land together or not at all.

The shape the first steps want:

1. **Deck first, leaves inward** — delete `components/tripwires/`, `lib/tripwires-store.ts`, `lib/tripwires-card-id.ts` and their tests, unhook `main.tsx`, `deck-manager.ts`, `action-dispatch.ts`, `protocol.ts`, `test-surface.ts`, `sidebar-toggle.ts`, `action-vocabulary.ts`, `command-registry.ts`, and drop `addCard`'s `activate` per `[B04]` in the same step, since its only caller dies here.
2. **The deck fixture re-anchor** (`[B05]`) as its own step — it touches a dozen test files that have nothing to do with the feature, and mixing it into step 1 makes both unreviewable.
3. **The Rust surface**, `tugcast` → `tugtool` → `tugtool-core` → `tugarc-core` → `tugcore`, deleting each crate's files with its registrations, and `arc_base_in` and `tool_calls` with their last readers.
4. **`Tug.app`** — the menu row and the control message.
5. **Docs and plugin** — `tuglaws/tripwires.md`, the `INDEX.md` line, the decision block per `[B03]`, the scattered clauses in the other laws, the skill, `plugin.json`, both `CLAUDE.md` files, and `standalone.test.ts`.
6. **The ledger file** (`[B07]`) and a closing `grep -ri tripwire` over the tree excluding `briefs/`, which must come back empty. That grep is the acceptance test and there is no other.

`just app-test-changed` will read as CORE TIER ADVISED once `main.tsx` is touched; the answer is `just app-test`, not the full corpus.
