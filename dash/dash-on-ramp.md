## Dash On-Ramp — the bare `/dash` orchestrator {#dash-on-ramp}

**Purpose:** One conversational entry point for all dash work. A user types `/dash` with an idea — or nothing — and the model carries them through sizing, briefing, planning, review, and implementation, delegating to the existing expert skills and owning the connective narration. Starting a dash stops requiring knowledge of five commands and their order.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via dash worktree) |
| Last updated | 2026-08-24 |

---

### Review Record {#review-record}

<!-- Appended by /tugplug:plan-review; absent until the first round. -->

---

### Phase Overview {#phase-overview}

#### Context {#context}

Starting dash work today requires knowing five commands and their choreography: author a brief by hand, `/tugplug:spike-card` for a design exploration, `/tugplug:plan-devise` for the plan, `/tugplug:plan-review` for the review, `/tugplug:dash-implement` for the build — plus `/tugplug:dash-on` for work too small to plan. Each skill is well-specified in isolation; the *sequence* lives in nobody's head but the practiced user's. The on-ramp varies job to job, and the person who has not memorized the roster cannot start.

The fix is a single orchestrator skill invoked as bare `/dash`: it takes a free-text idea, converses to sharpen it, sizes it with the user, and routes to whichever path fits — a spike, a quick plan-less dash, or the brief → plan → review → implement arc — delegating each stage to the existing skill's contract. Every existing skill remains independently invocable as the expert path.

The bare name has history. `dash` was once the name of today's `dash-on` skill, renamed away because "the bare name belongs to the lane, not to one skill in it" (`tugplug/CLAUDE.md`). The orchestrator *is* the lane's front door, so the bare name is finally right. But the name is currently occupied on the client side: `LOCAL_SLASH_COMMANDS` in `tugdeck/src/lib/slash-commands.ts` registers `dash` as a retired spelling `deprecatedFor: "dash-bind"`, which means a typed `/dash` is intercepted locally and opens the dash picker — it never reaches claude at all. Reclaiming the name is half of this plan.

This is phase 3 of the dash-visibility arc: phase 1 (dash-docs-home) made the paperwork directory a project declaration read through `tugutil dash docs-dir`; phase 2 (paperwork-formats) gave the brief a written format (`tuglaws/brief-skeleton.md`) and reconciled the plan skeleton with its linter (`tuglaws/devise-skeleton.md` v6). Phase 4 (dash-cockpit) will build the Lens cockpit whose "Start a dash…" affordance submits a prompt invoking this skill — so this skill is the contract that phase builds against.

#### Strategy {#strategy}

- Ship the skill first, then surrender the name: create `tugplug/skills/dash/SKILL.md` before removing the local `dash` registry entry, so there is no commit at which a typed `/dash` resolves to nothing.
- The orchestrator delegates, never restates: at each stage it reads the sibling skill's `SKILL.md` and carries out that contract in-thread. The expert skills stay the single source of truth for their own mechanics; `/dash` owns only the routing conversation and the connective narration.
- The review gate is inherited, not reimplemented: `/dash` reaches the gate by delegating to `plan-devise`, whose §5 already forks on the running model — review inline on Opus, hand over a `/tugplug:plan-review` chip otherwise. `/dash` adds nothing to that fork.
- Reclamation is deletion plus doctrine: remove the local alias, remove its surface wiring, delete the app-test that pins the old behavior, pin the new resolution at the unit layer, and record the local-to-pass-through migration path in `tuglaws/slash-commands.md` so the registry comment and the doctrine stop claiming aliases can never be deleted.

#### Success Criteria (Measurable) {#success-criteria}

- `tugplug/skills/dash/SKILL.md` exists with `name: dash` frontmatter, and `enumeratePluginCommands("tugplug")` run against the repo's plugin dir includes `tugplug:dash` (pinned by a bun test).
- `matchLocalSlashCommand("/dash fix the thing")` returns `null`, and `LOCAL_SLASH_COMMANDS` carries no `dash` entry (pinned by a bun test).
- `resolveRemoteCommand("dash", catalog)` returns `"tugplug:dash"` and `canonicalizeBareCommandLine("/dash fix the thing", catalog)` returns `"/tugplug:dash fix the thing"` for a catalog containing the plugin's real enumerated names — proving the suffix match is unique (pinned by a bun test).
- The at0421 test "the retired /dash spelling reaches the same picker" is deleted; `at0408` and the rest of the dash-gesture suite still pass (`/dash-bind` untouched).
- `bunx tsc --noEmit` and `bunx vite build` exit 0 — the `LocalCommandName` union shrink is absorbed everywhere the exhaustive `slashCommandSurfaces` record keys on it.
- `tuglaws/slash-commands.md` documents the reclamation path (a local alias retired in favor of a catalogued pass-through), and the `deprecatedFor` doc comment in `slash-commands.ts` no longer claims deletion is impossible without stating the carve-out.

#### Scope {#scope}

1. The new skill: `tugplug/skills/dash/SKILL.md` (full orchestrator text), plus `plugin.json` and `tugplug/CLAUDE.md` roster/flow updates.
2. Name reclamation in tugdeck: registry entry, surfaces map entry, doc comment, unit pins, app-test deletion.
3. Doctrine: the local-to-pass-through migration path in `tuglaws/slash-commands.md`; the on-ramp named in `tugplug/CLAUDE.md`'s flow paragraph.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Lens Dashes cockpit and the Z2 DASH masthead cell — phase 4 (dash-cockpit), which builds on this skill's contract.
- Any change to the expert skills' own contracts (`plan-devise`, `plan-review`, `dash-implement`, `dash-on`, `spike-card`, brief authoring). `/dash` reads them; it does not edit them.
- Retiring `/dash-bind` or `/dash-join`. Both are live local verbs for different operations (bind a card, land a dash) and keep their names. The `join` retired-spelling alias also stays.
- A new app-test that submits `/dash` end-to-end — that would spawn real claude and burn a real turn; real-claude tests are on-demand only. The resolution path is fully pinned at the unit layer.
- Any tugcode change. `enumeratePluginCommands` already walks `skills/*/SKILL.md` generically; a new skill directory is picked up with zero code.

#### Dependencies / Prerequisites {#dependencies}

- Phase 1 (dash-docs-home) landed: `tugutil dash docs-dir` exists and the skills resolve paperwork through it.
- Phase 2 (paperwork-formats) landed: `tuglaws/brief-skeleton.md` exists; `tuglaws/devise-skeleton.md` is at v6 and lint-clean.

#### Constraints {#constraints}

- The skill is a bundled app resource: `resolvePluginDir()` in `tugcode/src/session.ts` always resolves `Contents/Resources/tugplug` beside the tugcode binary — never the project tree. Repo edits to `tugplug/` do nothing for a live session until an app rebuild; `TUG_PLUGIN_DIR` overrides for the dev harness. Verification of live behavior therefore rides the dash's debug build, not the user's release instance.
- `AskUserQuestion` is capped upstream at 1–4 questions per call, 2–4 options per question. The routing gate must fit (it does: four routes, one question).
- No sub-agents anywhere in the skill — the plugin is agentless by charter.

#### Assumptions {#assumptions}

- No other catalog entry has the leaf name `dash`. The plugin's skills are `dash-audit`, `dash-implement`, `dash-join`, `dash-on`, `draft`, `history`, `plan-devise`, `plan-review`, `spike-card` — all different leaves — and claude ships no built-in named `dash`. The unit pin in Step 2 makes this falsifiable against the real enumerated list.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What does bare /dash front? (DECIDED — see [P02]) {#q01-dash-scope}

**Question:** The invocation names brief authoring, spike-card, plan-devise, plan-review, and dash-implement as today's five commands — but `dash-on`, the quick plan-less path, is also part of the lane. Does `/dash` route small ideas there too?

**Why it matters:** It decides whether "one name" is literally true. A `/dash` that always produces a plan forces ceremony onto small work and leaves `dash-on` as a sixth command to know.

**Resolution:** DECIDED. The user chose the full lane: `/dash` sizes the idea with the user and routes to whichever path fits — spike, quick plan-less dash, or the brief/plan arc. Recorded as [P02].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Muscle-memory `/dash <name>` users expect the picker | low | med | The bulletin already taught `/dash-bind` for a while; `/dash <name>` now starts a conversation about a dash rather than failing | User reports confusion |
| Orchestrator drift from delegated contracts | med | med | [P01]: `/dash` never restates a sibling's mechanics — it reads the sibling's `SKILL.md` at delegation time, so an edited expert skill is picked up automatically | An expert skill gains a step `/dash` narration contradicts |
| A second `dash`-leaf catalog entry appears later, breaking suffix resolution | med | low | The Step 2 unit pin resolves against the real enumerated plugin list, so the collision fails a test rather than silently alerting "Unknown command" | The pin fails |

**Risk R01: The reclaimed name goes dark between commits** {#r01-dark-window}

- **Risk:** If the local alias were removed before the skill exists, a typed `/dash` would classify as pass-through, resolve to nothing in the catalog, and raise the "Unknown command" alert.
- **Mitigation:** Step ordering — Step 1 creates the skill, Step 2 removes the alias. Within the dash both land before the join, so the base never sees the window at all; the ordering is for bisectability.
- **Residual risk:** None once both steps are on one branch.

---

### Design Decisions {#design-decisions}

#### [P01] The orchestrator delegates by reading sibling contracts, never by restating them (DECIDED) {#p01-delegate-by-reading}

**Decision:** At each stage, `/dash` reads the relevant sibling skill's `SKILL.md` (relative to its own base directory: `../plan-devise/SKILL.md`, `../dash-implement/SKILL.md`, `../dash-on/SKILL.md`, `../spike-card/SKILL.md`) and carries out that contract in-thread. The skill's own text contains the routing conversation, the stage map, and the narration voice — no duplicated mechanics.

**Rationale:**
- The expert skills stay independently invocable and remain the single source of truth for their own flows; an edit to `plan-devise` is picked up by `/dash` with no second file to sync.
- This is the established pattern: `dash-implement` and `dash-on` already delegate their working discipline to `tuglaws/dash-work-doctrine.md` by reading it rather than repeating it.

**Implications:**
- The skill's `allowed-tools` must cover the union of what the delegated contracts need: `Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, TaskCreate, TaskUpdate`; `disallowed-tools: Task`.
- While a delegated contract runs, its guardrails govern — including `dash-implement`'s sanctioned `tugutil dash create` / `tugutil dash commit` and `dash-on`'s equivalents. `/dash` adds no worktree mechanics of its own.

#### [P02] /dash fronts the full lane (DECIDED) {#p02-full-lane}

**Decision:** The routing gate offers every path the lane has: a design spike (`spike-card`), a quick plan-less dash (`dash-on`), the plan arc (`plan-devise` → review gate → `dash-implement`), and the plan arc with a brief first (`tuglaws/brief-skeleton.md`, then the plan arc).

**Rationale:**
- The user decided this ([Q01]): one name should truly cover starting any dash work, and leaving `dash-on` outside would preserve a sixth command to memorize.
- The routing question fits `AskUserQuestion`'s upstream cap exactly: one question, four options.

**Implications:**
- The skill recommends a route (first option, "(Recommended)" suffix) based on the sharpened idea — small and concrete leans quick-dash, visual/exploratory leans spike, decision-heavy leans brief-first — but the user chooses.
- The user can pre-empt the gate: an invocation that already names the shape ("spike this", "quick fix:", "plan this out") skips the question.

#### [P03] Reclamation is deletion, and the never-delete rule gains its carve-out (DECIDED) {#p03-reclamation-carve-out}

**Decision:** The `dash` entry is removed from `LOCAL_SLASH_COMMANDS` and its `dash:` handler from `slashCommandSurfaces`. The `deprecatedFor` doc comment in `slash-commands.ts` — which currently states retired spellings "cannot simply be deleted: a `/verb` that stops matching the registry is submitted to Claude as a prompt, which is the one outcome worse than a rename" — is amended with the carve-out: deletion is exactly right when the bare name is being reclaimed by a catalogued pass-through, because falling through to claude *is* the intended outcome.

**Rationale:**
- The three-tier classifier makes this safe by construction: with no local entry and no hidden entry, `/dash` is pass-through; `resolveRemoteCommand` finds `tugplug:dash` by unique suffix; `canonicalizeBareCommandLine` rewrites the wire form; claude expands the skill. No unknown-command alert fires because the name resolves.
- A comment that states an absolute the code has just violated is a resting lie; the carve-out keeps the rule honest for the next alias.

**Implications:**
- `LocalCommandName` shrinks; the exhaustive `Record<LocalCommandName, …>` in `session-card.tsx` forces the handler removal at compile time — that is the registry's own drift protection doing its job.
- The `join` → `dash-join` alias is untouched: nothing named `join` exists in the catalog to reclaim it.

#### [P04] The review gate stays a turn boundary (DECIDED) {#p04-review-gate}

**Decision:** `/dash` stops hard when the plan is written and unreviewed (unless the running model is Opus, where `plan-devise` §5 reviews inline in the same turn). It prints the `/tugplug:plan-review <path>` chip and says the review runs on whatever model is selected when it is clicked. It never schedules a turn, never switches models, and never reviews on a non-Opus model.

**Rationale:**
- This is `plan-devise`'s existing fork, inherited by delegation ([P01]); the review is where judgment lands and the model choice is the user's.

**Implications:**
- The arc necessarily spans turns. Continuation after the review is two doors, both already built: `plan-review` prints the `/tugplug:dash-implement <path>` chip, and re-invoking `/dash` orients and offers to carry the reviewed plan into implementation ([P05]).

#### [P05] Bare re-entry orients before asking (DECIDED) {#p05-re-entry}

**Decision:** `/dash` invoked with no idea (or invoked mid-arc) orients first: it resolves the docs directory via `tugutil dash docs-dir --json`, checks the session's bound dash state via `tugutil dash status`, and looks for a reviewed-but-unadopted plan in the docs directory (glob `<docs>/*.md`, `tugutil plan status <path> --json` on candidates, reading `data.review`). Finding one, it names it and offers to continue — carrying it into `dash-implement`'s contract on a yes. Finding nothing in flight, it asks what to work on.

**Rationale:**
- "Carries the reviewed plan into dash-implement" requires re-entry to know where the arc stands; deriving it from the durable artifacts (plan review state, dash stage) is strictly better than remembering it, because a fresh session can do it too.
- Phase 4's cockpit will submit `/dash`-invoking prompts from buttons; a skill that orients from disk state is a skill a button can drive.

**Implications:**
- Orientation is cheap and bounded: one `docs-dir` call, one `status` call, and `plan status` over the handful of markdown files in the docs directory.

#### [P06] Liveness rides the bundle, and the plan says so (DECIDED) {#p06-bundle-liveness}

**Decision:** The plan's verification of live behavior uses the dash's debug build (`just app-debug`), whose bundle carries the worktree's `tugplug/`. No attempt is made to hot-load the skill into the user's release instance.

**Rationale:**
- `resolvePluginDir()` is unconditional: the bundled copy beside the binary, never the project tree. That is settled architecture ([D-level: the plugin is an app-level resource, universal across projects]), not a gap to work around.

**Implications:**
- Unit tests (`bun test`, enumeration against the repo dir) are the fast loop; the debug instance is the eyes-on check.

---

### Deep Dives {#deep-dives}

#### The classifier walk, before and after {#classifier-walk}

Submit-time dispatch order lives in `performSubmit` in `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (doctrine: `tuglaws/slash-commands.md` §three-tiers):

1. `matchLocalSlashCommand()` — local registry hit → dispatch `RUN_SLASH_COMMAND`, never sent to claude.
2. `isHiddenSlashCommand()` — hidden → notice, swallowed.
3. `isUnknownRemoteCommand()` — pass-through that resolves to nothing in a non-empty catalog → "Unknown command" alert.
4. Otherwise send, after `canonicalizeBareCommandLine()` rewrites a uniquely-resolving bare name to its qualified form.

**Today:** `/dash <anything>` hits tier 1 — the registry entry `{ name: "dash", deprecatedFor: "dash-bind", takesArgs: true }` matches, `slashCommandSurfaces.dash` (session-card.tsx, the `runRetiredVerb("dash", "dash-bind", …)` line) raises a one-time "/dash is now /dash-bind" bulletin and opens the dash picker. Claude never sees the text.

**After:** `/dash <idea>` misses tier 1 (entry deleted) and tier 2 (`HIDDEN_SLASH_COMMANDS` has no `dash`; verified — `slash-supported.ts` contains no dash entry). At tier 3, `resolveRemoteCommand("dash", catalog)` suffix-matches exactly one entry, `tugplug:dash`, so the name is not unknown. At tier 4, `canonicalizeBareCommandLine` rewrites the line to `/tugplug:dash <idea>` and it goes to claude, which expands the skill. The transcript and wire carry the qualified form; the user typed four characters.

#### Catalog plumbing — how the name gets into the catalog turn-free {#catalog-plumbing}

Claude's `initialize` handshake answers before `--plugin-dir` plugins load, so `buildSessionCapabilities` alone would omit every plugin skill on a fresh card. `enumeratePluginCommands(pluginDir)` in `tugcode/src/capabilities.ts` walks `skills/*/SKILL.md`, reads `name` / `description` / `argument-hint` from frontmatter, and emits `tugplug:<name>` entries; `mergePluginCommands` folds them into the turn-free catalog, dropping any bare-leaf twin claude reported. A new `skills/dash/` directory is therefore picked up with zero tugcode changes — the `/` popup offers `tugplug:dash` from the drop, and the unknown-command check passes for the bare form. The popup side needs nothing either: `filterCommandProvider` passes catalogued commands through, and the local provider no longer competes for the name.

#### What the reclamation touches in tugdeck {#reclamation-touches}

- `tugdeck/src/lib/slash-commands.ts` — delete the `dash` entry (the `join` alias entry stays); amend the `deprecatedFor` doc comment per [P03]. The comment block above the dash-family entries (the [P08] spelling-rule note) keeps `/dash-bind` ⇒ `tugutil dash bind` but should note the bare name now belongs to the `tugplug:dash` skill.
- `tugdeck/src/components/tugways/cards/session-card.tsx` — delete the `dash:` line from `slashCommandSurfaces` (currently `dash: (args, draft) => runRetiredVerb("dash", "dash-bind", args, draft)`). `runRetiredVerb` itself stays; `join:` still uses it.
- `tests/app-test/at0421-dash-picker.test.ts` — delete the test "the retired /dash spelling reaches the same picker" (it launches the app, types `/dash`, and asserts the picker opens — behavior this plan removes). The file's other tests (`/dash-bind` picker behavior) stay.
- `tugdeck/src/lib/__tests__/slash-supported.test.ts` — add the resolution pins (Success Criteria list them). The catalog used in the pins is the real enumerated leaf set, written as a literal list of the plugin's qualified names, with a comment naming `tugplug/skills/` as its source.

---

### Specification {#specification}

**Spec S01: The `/dash` skill contract** {#s01-skill-contract}

Frontmatter:

```yaml
name: dash
description: Start or continue dash work from one conversational entry point — size the idea, route to a spike, a quick dash, or the brief/plan arc, and carry the arc through review to implementation
argument-hint: "[idea…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion, TaskCreate, TaskUpdate
disallowed-tools: Task
```

Body, by stage:

1. **Orient.** Resolve the docs directory (`tugutil dash docs-dir --json`; the undeclared case asks once and records with `--set`, exactly as `plan-devise` specifies). If invoked bare or the arc may be mid-flight, check `tugutil dash status` and scan the docs directory for a reviewed-but-unadopted plan ([P05]). Offer to continue anything found; otherwise ask what to work on.
2. **Sharpen.** Converse about the idea. A few design questions at most, bounded by the doctrine's never-ask list; an already-specific idea passes straight through.
3. **Route.** One `AskUserQuestion` with the four paths ([P02]), the recommended one first: quick dash (no plan) / plan arc / brief first, then plan / design spike. Skip the question when the invocation already names the shape.
4. **Delegate.** Read the chosen sibling's `SKILL.md` and carry out its contract in-thread ([P01]): `../dash-on/SKILL.md` for quick, `../spike-card/SKILL.md` for a spike, `../plan-devise/SKILL.md` for the plan (brief-first routes write the brief against `tuglaws/brief-skeleton.md` into the docs directory, then continue into plan-devise, with the plan citing the brief's `[B##]` decisions).
5. **Stop at the review gate.** Inherited from plan-devise §5 ([P04]): Opus reviews inline; anything else prints the `` `/tugplug:plan-review <path>` `` chip and stops.
6. **Continue.** On re-entry with a reviewed plan (or when the same turn reviewed on Opus and the user asks to proceed), read `../dash-implement/SKILL.md` and carry the plan through it. The connective narration names where the arc stands at each hand-off — that narration is the one thing `/dash` owns that no sibling does.

Throughout: the delegated contract's guardrails govern while it runs; `/dash` itself never creates a worktree, never commits, and never joins. The stop-before-join obligation and the user-owned landing gesture are the doctrine's and unchanged.

**Spec S02: The registry diff** {#s02-registry-diff}

| Surface | Before | After |
|---|---|---|
| `LOCAL_SLASH_COMMANDS` | `{ name: "dash", deprecatedFor: "dash-bind", takesArgs: true }` | entry deleted |
| `slashCommandSurfaces` (session-card.tsx) | `dash: (args, draft) => runRetiredVerb("dash", "dash-bind", args, draft)` | line deleted |
| Typed `/dash <idea>` | picker sheet + one-time bulletin | canonicalized to `/tugplug:dash <idea>`, sent to claude |
| `/` popup | no `dash` (aliases are excluded from the popup already) | `tugplug:dash` offered from the catalog |
| `/dash-bind`, `/dash-join`, `/join` alias | unchanged | unchanged |

No new client state anywhere in this plan — the tugdeck change is a registry shrink, so there is no State Zone Mapping to fill.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun, tugdeck)** | Pin the classifier resolution of the bare name | `slash-supported.test.ts` additions |
| **Unit (bun, tugcode)** | Pin that the real plugin dir enumerates `tugplug:dash` | `plugin-commands.test.ts` addition against the repo's `tugplug/` |
| **App-test** | The dash-gesture surfaces that remain (`/dash-bind`) | existing at0408 / at0421 coverage, minus the deleted alias test |

#### What stays out of tests {#test-non-goals}

- An end-to-end app-test that submits `/dash` and watches the skill run — it would spawn real claude and burn a real turn; real-claude tests are on-demand only. The full resolution path (local miss → catalog hit → canonicalization) is pinned at the unit layer, and the send path itself is at0340's existing territory.
- The skill's conversational quality — routing recommendations and narration are judgment, exercised by use, not assertable by a test worth its brittleness.
- No `happy-dom`, no `jsdom`, no `@testing-library/react`, no mock-store shapes anywhere.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The `/dash` skill joins the plugin | pending | — |
| #step-2 | The bare name reaches the skill | pending | — |
| #step-3 | The doctrine records the door | pending | — |
| #step-4 | Integration checkpoint | pending | — |

#### Step 1: The `/dash` skill joins the plugin {#step-1}

**Commit:** `tugplug: add the /dash orchestrator skill`

**References:** [P01] delegate by reading, [P02] full lane, [P04] review gate, [P05] re-entry, Spec S01, (#context, #catalog-plumbing)

**Artifacts:**
- `tugplug/skills/dash/SKILL.md` — the orchestrator, written to Spec S01.
- `tugplug/.claude-plugin/plugin.json` — `description` and `keywords` gain `dash`.
- `tugplug/CLAUDE.md` — the skill roster gains the `dash` entry at the top of the plan-lifecycle group, noting the bare name now belongs to the lane's front door (updating the historical note on `dash-on` that says the bare name belongs to the lane, not to one skill in it — the front door is the lane's own name made typeable); the flow paragraph is rewritten to start at `/dash` with the expert commands as the expert path.
- `tugcode/src/__tests__/plugin-commands.test.ts` — a test enumerating the repository's real `tugplug/` directory and asserting the result includes `tugplug:dash` (with its description and argument-hint from frontmatter).

**Tasks:**
- [ ] Write `SKILL.md` to Spec S01: frontmatter exactly as specified; body stages orient → sharpen → route → delegate → review gate → continue; delegation by reading sibling `SKILL.md` paths relative to the skill's base directory; the no-`tuglaws/` degradation stated the same way the sibling skills state theirs (the summary carried inline is the contract, say which fidelity applies).
- [ ] Update `plugin.json` and `tugplug/CLAUDE.md`.
- [ ] Add the enumeration pin to `plugin-commands.test.ts`, resolving the plugin dir from the test file's location (`../../../tugplug`), skipping (not failing) if the directory is absent so the test is checkout-relative, matching how `the_skeleton_satisfies_its_own_rules` guards in `plan.rs`.

**Tests:**
- [ ] `bun test tugcode/src/__tests__/plugin-commands.test.ts` — the new pin plus the existing fixture tests.

**Checkpoint:**
- [ ] `bun test tugcode/src/__tests__/plugin-commands.test.ts` exits 0.
- [ ] `head -8 tugplug/skills/dash/SKILL.md` shows `name: dash` and `disable-model-invocation: true`.

---

#### Step 2: The bare name reaches the skill {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: reclaim bare /dash for the orchestrator skill`

**References:** [P03] reclamation carve-out, Spec S02, Risk R01, (#classifier-walk, #reclamation-touches)

**Artifacts:**
- `tugdeck/src/lib/slash-commands.ts` — `dash` entry deleted; `deprecatedFor` doc comment amended with the reclamation carve-out; the dash-family comment block notes the bare name's new owner.
- `tugdeck/src/components/tugways/cards/session-card.tsx` — `dash:` surfaces entry deleted.
- `tests/app-test/at0421-dash-picker.test.ts` — the retired-spelling test deleted.
- `tugdeck/src/lib/__tests__/slash-supported.test.ts` — resolution pins added.

**Tasks:**
- [ ] Delete the registry entry and the surfaces entry; let `tsc` confirm the exhaustive record absorbed the union shrink.
- [ ] Amend the two comments per [P03] — the carve-out states *when* deletion is right (a catalogued pass-through reclaims the name, so falling through to claude is the intent), not just that it happened here.
- [ ] Delete the at0421 alias test; leave the rest of the file untouched.
- [ ] Add the unit pins: `matchLocalSlashCommand("/dash fix the thing")` is `null`; no registry entry named `dash`; `resolveRemoteCommand("dash", REAL_PLUGIN_CATALOG)` is `"tugplug:dash"`; `canonicalizeBareCommandLine("/dash fix the thing", REAL_PLUGIN_CATALOG)` is `"/tugplug:dash fix the thing"`; `isUnknownRemoteCommand("dash", REAL_PLUGIN_CATALOG)` is `false` — where `REAL_PLUGIN_CATALOG` is the literal list of the plugin's nine-plus-one qualified skill names with a comment naming `tugplug/skills/` as its source.

**Tests:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/slash-supported.test.ts`

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` exits 0.
- [ ] `cd tugdeck && bunx vite build` exits 0.
- [ ] `cd tugdeck && bun test` exits 0.
- [ ] `just app-test-changed` (selection derives at0421 and at0408 via `@covers` on `session-card.tsx`) is green.

---

#### Step 3: The doctrine records the door {#step-3}

**Depends on:** #step-2

**Commit:** `tuglaws: record the local-to-pass-through reclamation path`

**References:** [P03] reclamation carve-out, [P04] review gate, (#classifier-walk)

**Artifacts:**
- `tuglaws/slash-commands.md` — the decision procedure gains the reclamation move as a worked example: a locally-registered name (here, a retired-spelling alias) retired in favor of a catalogued pass-through, with the two deletion sites and the safety argument (unique suffix resolution is what keeps the fall-through from alerting).
- `tuglaws/dash-work-doctrine.md` — one sentence in the opening naming `/dash` as the lane's conversational entry point, with the expert skills as the direct path.

**Tasks:**
- [ ] Write the worked example where the existing worked examples live (the `/insights` / `/model` / `/vim` trio), in the same register.
- [ ] Add the doctrine sentence; do not restate the skill's stages there — the skill text is the contract.

**Tests:**
- [ ] None — documentation.

**Checkpoint:**
- [ ] `grep -c "tugplug:dash" tuglaws/slash-commands.md` ≥ 1.
- [ ] `grep -c "/dash" tuglaws/dash-work-doctrine.md` ≥ 1.

---

#### Step 4: Integration checkpoint {#step-4}

**Depends on:** #step-3

**Commit:** `dash-on-ramp: integration checkpoint`

**References:** [P06] bundle liveness, (#success-criteria)

**Artifacts:**
- The verified fit of the dash against its base.

**Tasks:**
- [ ] `tugutil dash replay <name>`; on `Replayed`/`Recorded`, run the declared verify command (`sh scripts/verify-fit.sh {base} {head}`) from the worktree root; on `Current`, run nothing and say so; on `Conflicted`, resolve as ordinary work and verify.
- [ ] Walk the Success Criteria and confirm each holds.
- [ ] Offer the debug build (`just app-debug`) for eyes-on verification of the live resolution: the debug instance's bundle carries this worktree's `tugplug/`, so a typed `/dash` in a fresh card should canonicalize to `tugplug:dash` and start the skill ([P06]).

**Tests:**
- [ ] None beyond the replay-verify procedure — a checkpoint that passed is spent.

**Checkpoint:**
- [ ] The replay outcome is handled per the procedure and reported.
- [ ] Every Success Criteria item verified.

---

### Deliverables {#deliverables}

- `tugplug/skills/dash/SKILL.md` — the `/dash` orchestrator (new).
- `tugplug/.claude-plugin/plugin.json`, `tugplug/CLAUDE.md` — roster and flow updated.
- `tugcode/src/__tests__/plugin-commands.test.ts` — real-plugin enumeration pin.
- `tugdeck/src/lib/slash-commands.ts`, `tugdeck/src/components/tugways/cards/session-card.tsx` — the bare name surrendered.
- `tugdeck/src/lib/__tests__/slash-supported.test.ts` — resolution pins.
- `tests/app-test/at0421-dash-picker.test.ts` — retired-spelling test removed.
- `tuglaws/slash-commands.md`, `tuglaws/dash-work-doctrine.md` — the reclamation path and the on-ramp recorded.
