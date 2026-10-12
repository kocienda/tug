<!-- brief-skeleton v1 -->

# Arc doctrine ships in the plugin

**Purpose:** An arc run on a project other than Tug announces that it cannot find `tuglaws/` and falls back to five inline rules. Tug is an IDE for any project on the machine, so an arc must run at full fidelity with no resource from the Tug checkout.

---

## Purpose {#purpose}

The user ran a planned arc on a different project (the website that describes Tug) and saw this in the seated stage's thinking:

> No `tuglaws/` directory exists, so I'll rely on the inline rules instead: single working root, verify before each commit, never commit red, use `tugtool arc commit` for rounds, and stop before the join.

In the user's words: this contravenes one of the key tenets of Tug, that it is an IDE for developing projects anywhere on the system and must not have a direct dependency on resources located in a Tug development checkout. The arc methodology is transgressing. The ask: resolve it so that arcs run with full fidelity in any project.

---

## Evidence {#evidence}

**[F01] The degradation is sanctioned by the standalone contract itself** — `tugplug/CLAUDE.md`, under "The standalone contract", carries the bullet *Skills cite `tuglaws/` only with an absence clause. A doctrine document is a pointer into a project that has one; every skill that reads one says what survives when it is absent, and carries those rules inline.* That bullet is the rule the thinking line obeyed. **(verified)**

**[F02] The same file states the rule the bullet breaks** — under "The prompt files": *anything the model must know to drive Tug correctly ships in the bundle, and reaches the session through the system prompt or a skill.* The arc doctrine is knowledge the model must have to drive an arc correctly, and `tuglaws/work-grammar.md` ("Where knowledge lives") records the same rule as doctrine. The absence-clause bullet is the loophole through which three documents escaped the bundle. **(verified)**

**[F03] Three documents escaped, and five skills reach out of the plugin for them** — `tuglaws/arc-work-doctrine.md` (274 lines), `tuglaws/devise-skeleton.md` (571 lines), and `tuglaws/plan-review-rubric.md` (83 lines). Every arc skill links them by a relative path that climbs out of the plugin, `../../../tuglaws/...`, and each carries a "when the project has no `tuglaws/`" paragraph: `arc` (line 27, 78), `arc-devise` (44, 58, 62, 64, 113), `arc-review` (39, 59, 61, 77), `arc-implement` (16, 18, 253, 258), `arc-audit` (20, 163). The reduced inline ruleset is five sentences; the doctrine it stands in for has sixteen sections. **(verified)**

**[F04] The three documents are mostly portable, with Tug residue mixed in** — read line by line, the Tug-specific content of `arc-work-doctrine.md` is: `bun test <scope>` and `cargo nextest run` as the fast layer (lines 67 to 68), the app-test paragraph naming `Tug.app`, `app-test-build`, `at0622` and `tugtool apptest history` (73), the `tests/app-test/` and `just app-test` shapes and the fake-DOM ban (83 to 86), the "Law discipline" paragraph naming `tugdeck/src/components/tugways/`, `tuglaws.md`, `pane-model.md`, `component-authoring.md` and `[L02]`/`[L22]` (92), the `just app-debug` example (144), and `[D###]` citations throughout. In `plan-review-rubric.md` it is the "tuglaws cross-check" section (55 to 61), which names `tuglaws.md`, `design-decisions.md`, `component-authoring.md`, `pane-model.md`, the State Zone Mapping, and tugdeck/tugways work. In `devise-skeleton.md` it is the State Zone Mapping section (307 to 315) with its zone names and `[L##]` labels, and the header's pointer at `tuglaws/plan-review-rubric.md` (7). Everything else is about arcs as such. **(verified)**

**[F05] The plugin already has the right shape, used once** — the `brief` skill ships `brief-skeleton.md` beside its `SKILL.md` and reads it with `Read` at `${CLAUDE_PLUGIN_ROOT}/skills/brief/brief-skeleton.md`. The skill prompt I ran under in this session resolved that variable to the bundle path under `Tug.app/Contents/Resources/tugplug/`, so the mechanism works from a built bundle on a project that is not Tug. The arc skills never adopted it. **(verified)**

**[F06] Project knowledge already reaches a stage through a verb** — `[tugtool.arc]` in `.tugtool/config.toml` declares `build`, `post_create`, the stage models, and the `[[tugtool.arc.surface]]` table that `tugtool arc verify` runs. The standalone contract's third bullet says skills read `tugtool arc config` and relay it, never naming this repository's build or tests. The schema is `ArcConfig` in `tugrust/crates/tugtool-core/src/config.rs`. There is no key for doctrine or laws. **(verified)**

**[F07] The guards cannot see this defect** — `scripts/tugplug-lint.ts` refuses `just`, the `tugdeck/`/`tugrust/`/`tugcode/`/`tugapp/`/`tests/app-test/` prefixes, `/Users/`, `kocienda`, `~/.local/bin`, "in this repository", "in Tug", "exemplar", and `jq`. It has no rule for `tuglaws/`. `tugplug/__tests__/standalone.test.ts` asserts the appended system prompt lacks `tuglaws/` (line 223), but the skills are not in the system prompt, so the assertion never sees them. **(verified)**

**[F08] Two tests are bound to the `tuglaws/` paths** — `the_skeleton_satisfies_its_own_rules` in `tugrust/crates/tugtool-core/src/plan.rs` (line 2250) lints `../../../tuglaws/devise-skeleton.md` against the plan linter and skips silently when the file is absent. `tests/app-test/scripts/doc-link-resolution.test.ts` resolves every link in `tuglaws/*.md`, and `tests/app-test/scripts/tuglaws-index-coverage.test.ts` requires every law to be reachable from `tuglaws/INDEX.md`. Moving the documents moves what these tests watch. **(verified)**

**[F09] The lint would refuse the residue on arrival** — every Tug-specific line in [F04] matches at least one rule in [F07] (`just`, a repository path prefix, or "in this repository"). Moving the three documents verbatim into `tugplug/` fails `just tugplug-lint`. This is inference from reading the rules against the lines, not a run. **What would confirm it:** moving one file and running the lint.

---

## Decisions {#decisions}

**[B01] The portable arc doctrine ships in the plugin, read through `${CLAUDE_PLUGIN_ROOT}`, and the `tuglaws/` copies go away.** The three documents in [F03] move into `tugplug/`, on the `brief-skeleton.md` precedent of [F05]: one shared `arc-work-doctrine.md` for the five arc skills, `devise-skeleton.md` beside `arc-devise`, `plan-review-rubric.md` beside `arc-review`. Each skill reads its documents with `Read` at a `${CLAUDE_PLUGIN_ROOT}` path, the way `brief` does. The plugin copy is the only copy: one home, no second copy to drift, as the standalone contract already says of the prompt files. `tuglaws/INDEX.md` points at the plugin paths as the source. This is what makes a project with no `tuglaws/` the full-fidelity case rather than the degraded one. It would be revisited only if `${CLAUDE_PLUGIN_ROOT}` proved unavailable to a seated stage, and [F05] shows it is available.

**[B02] The Tug residue becomes a project declaration in `[tugtool.arc]`, reported by `tugtool arc config`, and a skill reads only what is reported.** This is the user's call, made in conversation. The residue in [F04] leaves the doctrine and lands in this checkout, declared by two new keys: a `doctrine` path naming a supplement document the implement, audit and review stages read after the plugin's doctrine, and a `laws` list naming the law documents the review's cross-check and the audit's fit check name specific laws from. The verb already carries project knowledge to the stages ([F06]), so no skill ever names `tuglaws/` or any other path of this repository. A project that declares nothing gets the whole portable doctrine and no supplement, which is full fidelity and not a degraded mode. The alternative, folding the residue into this checkout's `CLAUDE.md`, was rejected because the review and audit stages would then have no declared list of laws to cross-check against, and because the worktree's `CLAUDE.md` is read by every session rather than by the stages that need it.

**[B03] The two Tug-shaped sections generalize rather than vanish.** The rubric's "tuglaws cross-check" becomes "the project's declared laws": name the specific laws from the documents the `laws` key declares, and when none are declared, skip the axis and say so in the Review Record. The skeleton's State Zone Mapping becomes an optional project-law mapping section the skeleton permits when the project declares laws, with the zone names and `[L##]` labels moving to the Tug supplement as the worked example. The doctrine's test-layer guidance stays as the portable principle (iterate on the fast layer, run the slow layer once as a verdict, know the cost before launching), with the concrete commands coming from the surfaces the project declares and the supplement.

**[B04] Every absence clause is deleted.** The paragraphs in [F03] that begin "when the project has no `tuglaws/`" go, along with the relative links that climb out of the plugin. The standalone contract bullet in [F01] is rewritten to say that skills never name `tuglaws/` at all: doctrine ships in the plugin, and project knowledge arrives through `tugtool arc config`. The inline five-rule summary in each skill is removed too, since it existed only as the fallback.

**[B05] The guards close so this cannot recur.** `scripts/tugplug-lint.ts` gains a rule refusing `tuglaws/` anywhere under `tugplug/`, `tugplug/CLAUDE.md` keeping its existing exemption. The Rust skeleton test in [F08] repoints at the plugin path and stops skipping when the file is absent, since the file is now in the same repository under a known path. The standalone test reads the arc skills and their doctrine files and asserts the same absence it already asserts of the system prompt. The doc-link resolution test resolves the new plugin-relative links, and the `tuglaws/` index-coverage test stops seeing the moved files.

**[B06] The lint refusing the residue is the forcing function, not an obstacle.** Per [F09], moving the documents verbatim fails `just tugplug-lint`. Each refused line is a line that belongs in the supplement under [B02]. The split is therefore made by moving the files and answering the lint, not by judgment beforehand.

---

## Open Questions {#open-questions}

- Whether `doctrine` should be a single path or a list. A single path is enough for Tug today and keeps the config read trivial. A list costs little and spares a later migration. The devise stage can settle this from how `ArcConfig` already handles `post_create` and `surfaces`.

---

## Non-goals {#non-goals}

- **Moving the rest of `tuglaws/` into the plugin.** `tuglaws.md`, `design-decisions.md`, `pane-model.md`, `component-authoring.md` and the other laws are about this product, not about arcs. They stay in the checkout and are reached through the `laws` declaration of [B02].
- **Injecting the arc doctrine into every session's system prompt.** The eight prompt files ride every session. The arc doctrine is read only by a seated stage, and a skill reading a file beside it is the narrower channel.
- **Keeping a `tuglaws/` copy of any moved document.** Rejected by the standalone contract's own one-home rule.
- **Changing what the five inline rules say.** They were a fallback, and the fallback is what is being removed.

---

## Exit {#exit}

An arc. The first steps follow the order the lint imposes: add the two config keys and report them through `tugtool arc config`; move the three documents into `tugplug/` and repoint the skills at `${CLAUDE_PLUGIN_ROOT}`; answer the lint by moving each refused line into this checkout's supplement document and `laws` declaration; generalize the rubric's cross-check and the skeleton's mapping section; delete the absence clauses and rewrite the standalone contract bullet; then close the guards and repoint the tests. The `tuglaws/INDEX.md` and `CLAUDE.md` pointers land last, once the paths are final.
