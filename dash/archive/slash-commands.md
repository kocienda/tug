<!-- devise-skeleton v4 -->

## Slash Commands — Reliable Invocation + Unified Command Chip {#slash-commands}

**Purpose:** Make typed slash commands (built-in skills, plugin skills, claude's own
commands) submit reliably from the Dev card — expanded by claude as **user
invocations** so a skill's `disable-model-invocation` guard never blocks them — and
give them one **distinct command chip** style shared by the prompt editor and the
transcript, ending their visual conflation with file/image attachments.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-18 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Typing `/tugplug:commit` in the Dev card fails with `Skill tugplug:commit cannot be
used with Skill tool due to disable-model-invocation`. The chain: accepting a `/`
completion inserts a **command atom** (`completion-extension.ts` replaces the typed
`/` + query with a `U+FFFC` placeholder; the atom's `value` is the bare command name,
no slash — `local-commands.ts`, `session-metadata-store.ts`). At submit a pass-through
command falls through to `code-session-store.send`, which calls `buildWirePayload`.
That builder ran every non-image atom through `wrapAtomMention` — turning the command
into `` `@tugplug:commit` `` on the wire. Claude only expands a slash command into a
**user invocation** (the path that bypasses `disable-model-invocation`) when the
message text is a *clean* leading-slash string; the wrapped form reaches the model
instead, which calls the Skill tool and is refused.

A stop-gap edit to `buildWirePayload` (uncommitted in the tree) made command atoms emit
their bare `value` — but `value` has **no leading slash** (`tugplug:commit`), so claude
still does not expand it; the model now *improvises* a commit (reads `SKILL.md`, enters
plan mode, asks approval). Verified against the real `claude` binary: a clean
`/tugplug:probe-noop` text block expands as a user invocation with no Skill tool and no
error, and claude records the turn as
`<command-message>NAME</command-message>\n<command-name>/NAME</command-name>` (plus an
optional `<command-args>` line). Nothing in tugdeck renders that echo intentionally —
the markdown pass strips the tags, leaving the bare plain-text name the user sees.

Two problems, one plan: (1) command atoms must reach claude as a clean `/name args`
string; (2) commands must read as **commands** — a single distinct chip in both the
editor and the transcript — not as file attachments (today all atom types share one
color-token set; only the icon path differs, and the replay synthesizer re-mints every
mention as `type: "file"`).

#### Strategy {#strategy}

- Fix the wire contract first: command atoms serialize to a clean `/name` (+ trailing
  arg text), never the `@`-mention marker. This alone removes the blocking error and
  the improvisation path for every command kind.
- Keep the **bare command name** as the single source of truth; add the leading slash
  as a presentation concern (chip label) and a wire concern (serializer) via small
  shared helpers, so the typed-bare path and the atom path can never drift again.
- Make command styling a **single type-keyed style descriptor** (color tokens *and*
  geometry — radius/padding/icon treatment), consumed by **both** chip renderers (editor
  data-URI baker and the React `TugAtomChip`), so the look is distinctive, edited in one
  place, and the editor/transcript chips stay pixel-identical. Ensure style edits
  propagate to the baked editor chips during iteration (re-bake signal), so tuning the
  design is friction-free.
- Teach the transcript to recognize claude's `<command-name>` expansion echo and render
  the same command chip — unifying the drafting surface and the committed view.
- Sequence so each step is independently shippable and HMR-testable against the
  `/tmp/commit-test-ground` scratch repo, with the `probe-noop` skill as the
  `disable-model-invocation` fixture.

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- Typing `/tugplug:commit` (or `/tugplug:probe-noop`) and submitting produces a real
  **user-invoked** skill run — no `disable-model-invocation` error, no model
  improvisation. (Verify in Tug.app against the scratch repo; the probe skill returns
  `PROBE_OK_USER_INVOCATION` with no Skill tool block in the transcript.)
- `buildWirePayload` emits exactly `/tugplug:commit` for a lone command atom and
  `/cmd one two` for a command atom followed by ` one two` text. (Unit test.)
- A command atom embedded mid-prose, or two command atoms in one message, serialize as
  plain `/name` text and never trigger a Skill-tool call or a blocking error. (Unit
  test + Tug.app spot check.)
- The command chip is distinct from file/image/link/doc chips in **both color and
  shape**, governed by one `chipStyleForType` descriptor, and renders identically in the
  editor and the transcript. (Visual check in both themes; descriptor unit test asserting
  command differs and non-command types are unchanged.)
- Editing a command token value in `brio.css` updates the editor chip and the transcript
  chip together — no stale baked editor chip. (Tug.app HMR check.) 
- A committed command turn renders as a command chip showing `/tugplug:commit` in the
  transcript — leading slash preserved, no raw `<command-name>` XML, no file chip.
  (Replay test from a real JSONL echo fixture + Tug.app check.)

#### Scope {#scope}

1. Command-atom wire serialization: clean `/name` (+ args), embedded/multi-command
   handling, shared slash helpers.
2. Distinct command chip: a single `chipStyleForType` descriptor (color tokens in brio +
   harmony *and* geometry) consumed by both chip renderers; leading slash in the command
   chip label; editor re-bake on style edits so the design is easy to tune.
3. Transcript recognition of claude's `<command-name>` expansion echo → unified command
   chip; live optimistic-echo ↔ replay-echo parity.
4. Synthesizer correctness: commands no longer ride the `@`-mention marker, so nothing
   re-mints them as `type: "file"`.
5. Submission ergonomics audit for built-in skills (accept → submit, argument-hint
   continuity).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Local (client-handled) command behavior — `RUN_SLASH_COMMAND` dispatch, the
  hidden/unknown `[D14]` allowlist, and the client-side notice path are unchanged. Only
  their chip *styling* unifies.
- Reworking the `@`-completion popup engine, file/image atom behavior, or the
  bytes-store / image-attach path.
- Changing tugcode's forwarding of `add_user_message` / `--replay-user-messages`.
- Auto-submitting a command on accept (tracked as [Q02], deferred).

#### Dependencies / Prerequisites {#dependencies}

- `tugplug/skills/probe-noop` — a temporary `disable-model-invocation: true` fixture
  (a `SKILL.md` that replies with a fixed token). Created at the start of #step-1 for
  checkpoint testing; removed at phase close (#step-6).
- `/tmp/commit-test-ground` — scratch git repo for live commit-skill testing.
- Tug.app running in debug mode (HMR live) for in-app verification.

#### Constraints {#constraints}

- Tuglaws: [L02] external state via store only, [L06] appearance through CSS/DOM not
  React state, [L19] file-pair/docstring discipline. Chip color must stay token-driven
  ([L06]) — no React-state-driven appearance.
- Theme tokens in `tugdeck/styles/themes/brio.css` and `harmony.css` are **hand-authored**
  (no generator — per CLAUDE.md); both files must gain the command tokens.
- Warnings are errors (`-D warnings`); `bun test` and `cargo`-side gates must stay green.
- The editor chip (`<img src="data:…">`) is isolated from the host CSS cascade, so its
  colors are baked as resolved hex via `getTokenValue`; the React chip uses live
  `var(--tug7-…)` refs. Both must select the *same* per-type tokens.

#### Assumptions {#assumptions}

- Claude's expansion echo format is stable as
  `<command-message>…</command-message>\n<command-name>/…</command-name>` with an
  optional `<command-args>…</command-args>` line (verified for a plugin skill; widened
  by [Q01]).
- Claude reports command names without a leading slash in its catalog
  (`system.init.slash_commands`), and matches user input case-sensitively on that name.
- A command typed as bare text (no accepted atom) already expands correctly today
  (verified) and needs no wire change — only the atom path is broken.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings and rich `References:` lines. Plan-local
decisions are `[P01]`; `[D##]` is reserved for the global design-decisions set.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Echo format across command kinds (OPEN) {#q01-echo-format}

**Question:** Do claude's *built-in* commands (`/context`, `/init`) and *agent*
commands emit the same `<command-name>` echo as skills, or a different shape?

**Why it matters:** The transcript detector (#step-3) keys off this. If a kind emits a
different envelope, its turn renders as raw text instead of a command chip (cosmetic,
non-fatal) — but we want the detector tolerant enough to cover all kinds.

**Options (if known):**
- Tolerant parser: match `<command-name>/X</command-name>` anywhere in the block, treat
  `<command-message>` / `<command-args>` as optional. (Lowest risk.)
- Strict three-line match. (Brittle.)

**Plan to resolve:** Spike during #step-3 with the existing probe harness against a
built-in (read-only: `/context`) and capture a real JSONL echo as the golden fixture.
Default to the tolerant parser regardless.

**Resolution:** OPEN — resolve in #step-3; fallback (plain text) is non-fatal.

#### [Q02] Auto-submit a no-arg command on accept (OPEN) {#q02-auto-submit}

**Question:** When the accepted completion is a no-arg command alone in the editor,
should accepting it also submit (one keystroke to run a skill)?

**Why it matters:** It's the biggest ergonomics lever for "make it *easy*", but it
changes a long-standing accept-then-submit contract and risks mis-firing for
argument-taking commands.

**Plan to resolve:** Audit in #step-5; if pursued, gate strictly on "lone atom, no
argument hint". Otherwise keep explicit submit.

**Resolution:** DECIDED (no auto-submit) — keep explicit accept-then-submit. The gating
signal doesn't exist: `resolveArgumentHint` (`lib/slash-argument-hint.ts`) classifies
**every** skill and agent as arg-taking (the generic `type arguments…` hint), so "lone
atom, no argument hint" can never identify a no-arg skill. Auto-submitting on accept
would therefore either never fire for the skills the user cares about, or — if fired for
all skills — regress argument-taking ones like `/tugplug:devise <idea>` by submitting
before the user types the argument. With the Step 1 expansion fix removing the blocking
error, the popup → accept → submit flow is already clean; the friction that motivated
this question is gone. Revisit only if the catalog gains a reliable per-command
"takes args" signal.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Echo format varies by command kind | low | med | Tolerant parser + golden fixture; plain-text fallback | A kind renders raw XML in transcript |
| Command tokens missing in one theme | med | low | Add to brio + harmony together; visual check both | Chip invisible / low contrast |
| Optimistic echo ↔ replay echo flicker | med | med | Synthesize the same command substrate on both paths | Chip changes shape when turn lands |
| Embedded command mis-expanded | med | low | Only a *lone* command serializes for expansion; else plain `/name` text | Skill error on a multi-atom message |

**Risk R01: Echo format drift** {#r01-echo-drift}

- **Risk:** Claude changes or varies the `<command-name>` envelope; the detector misses.
- **Mitigation:** Tolerant regex over `<command-name>`; optional `<command-message>` /
  `<command-args>`; a real-JSONL golden test; fallback renders the raw text (no crash).
- **Residual risk:** A novel envelope renders as plain text until the parser is widened.

**Risk R02: Theme token gap** {#r02-theme-token-gap}

- **Risk:** Command tokens added to one theme only → unreadable chip in the other.
- **Mitigation:** Same token set in both `brio.css` and `harmony.css`; checkpoint
  verifies presence in both and a visual pass in each theme.
- **Residual risk:** Future themes must add the tokens (same as every other atom token).

---

### Design Decisions {#design-decisions}

#### [P01] Command atoms serialize to a clean leading-slash wire string (DECIDED) {#p01-clean-wire}

**Decision:** In `buildWirePayload`, a `command` atom emits `"/" + value` (plus any
trailing argument text in the same text block), never the `@`-mention marker and never
the bare slashless value.

**Rationale:**
- Claude expands a slash command as a **user invocation** — bypassing
  `disable-model-invocation` — only when the message text is a clean leading-slash
  string. Verified against the real CLI.
- The `@`-marker defeats expansion (model calls Skill → refused); the slashless bare
  value defeats it differently (model improvises). Clean `/name` is the only correct
  shape.

**Implications:**
- `buildWirePayload` gains a `command`-type branch ahead of the `wrapAtomMention` path.
- Commands no longer round-trip through the `@`-marker; the transcript reconstructs the
  chip from claude's echo instead (#p04).

#### [P02] Bare name is the source of truth; slash is presentation + wire (DECIDED) {#p02-bare-name}

**Decision:** The atom's `value` stays the bare command name (matching claude's
catalog). The leading slash is added by two shared helpers — `commandWireText(value, args?)`
for serialization and a chip-label rule for display — never stored in `value`.

**Rationale:**
- Claude's catalog, the completion match, and the `[D14]` allowlist all key off the
  slashless name; storing a slash in `value` would force slash-stripping at every
  comparison site.
- One helper per concern (wire, display) gives a single definition of "how the slash
  appears", so the bare-typed path and the atom path cannot drift.

**Implications:**
- New `lib/command-atom.ts` helpers; `build-wire-payload.ts` and the chip renderers call
  them. `local-commands.ts` / `session-metadata-store.ts` are unchanged (still emit bare
  `value`).

#### [P03] Distinct command chip via a single type-keyed style descriptor (DECIDED) {#p03-command-chip}

**Decision:** Command styling is governed by **one** type-keyed style descriptor —
`chipStyleForType(type)` in `command-atom.ts` — that returns *both* the four color-token
names *and* the geometry knobs (border radius, horizontal padding, icon gap, and whether
to render a leading-slash glyph). **Both** chip renderers (the editor data-URI baker
`buildAtomSVGDataUri` and the React `TugAtomChip`) consume that one descriptor; today's
hardcoded `rx`, `PADDING`, `GAP`, and the four inline token references in each renderer
are refactored to read from it. Commands get their own color tokens
(`--tug7-surface-atom-command-…` / `--tug7-element-atom-command-{border,icon,text}-…`,
exact names finalized in the theme grammar) and a distinct geometry, and the chip label
shows the leading slash (`/tugplug:commit`). Non-command types resolve to today's exact
values through the same descriptor, so they are byte-for-byte unchanged.

**Rationale:**
- The goal is styling that is **separate, distinctive, and easy to iterate on to the
  owner's satisfaction** — not merely recolored. Today every atom type shares one token
  set *and* one hardcoded geometry; the border radius (`rx`) is a literal duplicated in
  `buildAtomSVGDataUri`'s SVG string and again in `TugAtomChip`, and padding/gap/height
  are shared constants in `computeAtomChipGeometry` (which forks only `iconPath` by
  type). Color-only tokens leave shape — the dimension most likely to be tuned — locked
  and duplicated across two files.
- A single descriptor is the surface the owner edits to change the look: change colors in
  the theme files, change shape in the descriptor, and both renderers follow. It also
  removes the two-places-hardcoded-`rx` duplication and is the natural home for future
  doc/link variants.
- The seam is already anticipated: `buildAtomSVGDataUri` carries a reserved `value` param
  whose docstring notes "future theme variants can fork on it", and the theme grammar
  already supports atom variants (`brio.css` has an `atom-…-route-…` set beside
  `atom-primary`). [P03] widens that seam to `type`.

**Implications:**
- New `chipStyleForType(type)` (in `command-atom.ts`) returns `{ tokens, geometry }`;
  the token names are usable both as `var(--tug7-…)` (React path) and
  `getTokenValue("--tug7-…")` (baked editor path).
- `computeAtomChipGeometry`, `buildAtomSVGDataUri`, and `TugAtomChip` all source radius /
  padding / gap / token names from the descriptor instead of literals. Non-command types
  pass through identical values (regression-guarded by test).
- `brio.css` + `harmony.css` gain the command tokens (hand-authored, both themes).
- Editor chips are baked data-URIs that only re-bake on a theme switch, so token/style
  edits within a theme don't live-update them during iteration — see [P06] for the
  decision on that workflow.

#### [P04] Transcript reconstructs the command chip from claude's echo (DECIDED) {#p04-transcript-echo}

**Decision:** A pure detector recognizes claude's expansion echo
(`<command-name>/NAME</command-name>`, optional `<command-message>` / `<command-args>`)
in a user message's content and synthesizes a `command`-atom substrate
(`U+FFFC` + `{type:"command", value:"NAME"}`, args as trailing text), rendered by the
existing `TugAtomTextBody` walker as the same command chip the editor shows.

**Rationale:**
- Claude rewrites the user turn to the XML envelope; the atom `type` is not on the wire,
  so the transcript can't recover it from the marker path. Detecting the envelope is the
  JSONL-honest way to restore the chip.
- Reusing `TugAtomTextBody` + the #p03 tokens gives one unified style for free.

**Implications:**
- New detector in `lib/command-atom.ts`; `synthesize-user-message.ts` (or the transcript
  cell that builds the user substrate) calls it before the generic marker walk.
- Live optimistic echo and the replay echo must both yield the command substrate so the
  chip doesn't change shape when the turn lands (#p05).

#### [P05] Embedded / multi-command messages send plain text, never a skill run (DECIDED) {#p05-embedded}

**Decision:** Only a command atom that is the *sole* content of the message serializes
for expansion (clean `/name args`). A command chip embedded in prose, or a second
command chip, serializes as plain `/name` text — claude won't expand it, and that is
acceptable (no error, no skill run, no improvised "I think you meant the skill").

**Rationale:**
- Claude's expansion only fires on a whole-message command; a mid-prose `/name` is just
  text. Emitting clean `/name` (not the marker, not a Skill call) is the safe, blocking-
  error-free behavior.
- Avoids surprising the user with a skill run they didn't intend by embedding a chip.

**Implications:**
- `buildWirePayload` emits `/name` for command atoms unconditionally (clean text either
  way); "lone vs embedded" matters only for whether claude *chooses* to expand — no
  special-casing needed in the builder, but the behavior is asserted by test and noted
  for the transcript detector (only a lone command turn becomes a chip).

#### [P06] Editor chips re-bake on token/style edits during iteration (DECIDED) {#p06-editor-rebake}

**Decision:** A style-change signal (HMR token edit or an explicit dev affordance) must
dispatch `regenerateAtomsEffect` so the editor's baked chips re-bake, keeping the editor
and the live-cascading React/transcript chips in sync while the owner tunes the design.

**Rationale:**
- Editor atom chips bake their colors via `getTokenValue` at widget construction and only
  re-bake on `regenerateAtomsEffect`, which today fires solely from
  `subscribeThemeChange` (a theme *switch*). Editing a token value in `brio.css` (same
  theme) live-updates the React chip via CSS cascade but leaves the editor chip stale —
  the two surfaces diverge mid-iteration, directly against the "easy to modify to my
  satisfaction" goal.

**Implications:**
- Implement the minimal viable signal: in dev/HMR, fire `regenerateAtomsEffect` when the
  theme stylesheet is hot-replaced (or expose a dev trigger). Scope: developer iteration
  ergonomics only — no production behavior change, no new persisted state ([L06]/[L22]
  stay clean; the dispatch is direct DOM observation, not React state).
- If the HMR hook proves fiddly, the fallback is a documented manual re-render
  (theme-toggle) — recorded here so the decision is conscious, not accidental.

---

### Specification {#specification}

#### Terminology {#terminology}

- **Command atom** — an `AtomSegment` with `type: "command"`, `value` = bare command
  name (no slash), inserted by accepting a `/` completion.
- **Expansion echo** — the user-turn content claude records when it expands a slash
  command: `<command-message>NAME</command-message>\n<command-name>/NAME</command-name>`
  (+ optional `<command-args>ARGS</command-args>`).
- **Pass-through command** — a command that is neither a local Tug surface nor a `[D14]`
  hidden/unknown name; it is sent to claude. (Unchanged classification.)

#### Wire format (contract) {#wire-format}

**Spec S01: Command-atom serialization** {#s01-command-serialization}

- A `command` atom at position *i* in the substrate emits, into the current text block:
  `"/" + value`. Trailing editor text (e.g. ` one two`) stays in the same text block,
  yielding `/cmd one two`.
- No `U+FFFC` and no `` `@…` `` marker is emitted for a command atom.
- A lone command atom (whole message) therefore produces a single text block
  `"/" + value` — the clean string claude expands.

**Spec S02: Expansion-echo detection** {#s02-echo-detection}

- Input: a user message's `ContentBlock[]`. If the message is exactly one text block
  whose content matches `<command-name>/(?<name>[^<]+)</command-name>` (with optional
  `<command-message>` and `<command-args>(?<args>[^<]*)</command-args>` siblings, in any
  order, tolerant of surrounding whitespace), produce a command substrate:
  `text = U+FFFC (+ " " + args if present)`, `atoms = [{type:"command", value:name}]`.
- **Slash normalization (parity-critical):** the detector strips the leading `/` from
  the captured `<command-name>` so the synthesized atom's `value` (`name`, bare) equals
  the editor atom's `value`. This is what guarantees the live optimistic echo and the
  replayed echo render the *same* command chip — same `type`, same `value`, same label —
  so the chip never flickers or relabels when the turn lands ([P05], [P04]).
- Otherwise: fall through to the existing generic synthesis unchanged.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Command chip colors + geometry (editor + transcript) | appearance | Single `chipStyleForType` descriptor; React chip via `var(--tug7-…)` + descriptor geometry, editor chip via baked `getTokenValue` + descriptor geometry | [L06] |
| Command wire string (`/name args`) | n/a (derived) | Pure fn `buildWirePayload` / `commandWireText` — no state | — |
| Transcript command substrate from echo | local-data (derived) | Pure detector → `(text, atoms)` computed at synth time; no new store, no `useState` | [L02] (read-only), [L06] |
| Editor chip re-bake on style edit | appearance (event) | Dev/HMR dispatch of `regenerateAtomsEffect` — direct DOM observation, no React state | [L06], [L22] |

No new React state, store, or `useSyncExternalStore` surface is introduced.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/command-atom.ts` | `commandWireText(value, args?)`, `commandChipLabel(value)`, `detectCommandEcho(blocks)` (Spec S02), `chipStyleForType(type)` → `{ tokens, geometry }` ([P03]) |
| `tugdeck/src/lib/__tests__/command-atom.test.ts` | Unit + golden tests for the helpers and the echo detector |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `buildWirePayload` | fn | `tugdeck/src/lib/build-wire-payload.ts` | Add `command`-type branch → `commandWireText` ([P01], Spec S01) |
| `computeAtomChipGeometry` | fn | `tugdeck/src/lib/tug-atom-img.ts` | Source radius/padding/gap from `chipStyleForType(type).geometry` instead of literals; non-command types unchanged ([P03]) |
| `buildAtomSVGDataUri` | fn | `tugdeck/src/lib/tug-atom-img.ts` | Resolve the 4 colors + `rx` via `chipStyleForType(type)`; drop the literal `rx="3"` and hardcoded token names ([P03]) |
| `TugAtomChip` | component | `tugdeck/src/lib/tug-atom-chip.tsx` | Source token refs + `rx` from `chipStyleForType(type)`; drop the inline `var(--tug7-…)` literals and `rx={3}` ([P03]) |
| chip label rule | logic | `tug-atom-img.ts` / `tug-atom-chip.tsx` | `command` chips display `commandChipLabel(value)` (leading slash) ([P02]) |
| user-substrate synth | fn | `tugdeck/src/lib/synthesize-user-message.ts` | Call `detectCommandEcho` first; else existing walk ([P04], Spec S02) |
| editor re-bake on style edit | wiring | `tugdeck/src/components/tugways/tug-text-editor.tsx` | Dispatch `regenerateAtomsEffect` on dev/HMR theme-stylesheet replace ([P06]) |
| command tokens | css | `tugdeck/styles/themes/brio.css`, `harmony.css` | `--tug7-…-atom-command-…` set, both themes ([P03]) |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| **Unit** | `buildWirePayload` command branch; `commandWireText`; `detectCommandEcho`; `chipStyleForType` | Core logic / edge cases |
| **Golden / Contract** | Real JSONL expansion-echo fixture → command substrate | Echo detection stability |
| **Integration (in-app)** | Tug.app: submit `/tugplug:probe-noop` and `/tugplug:commit` against the scratch repo | End-to-end, real claude |

#### What stays out of tests {#test-non-goals}

- No jsdom render-tree assertions for chip pixels — chip color is token-driven ([L06]);
  verify the *descriptor* (`chipStyleForType`, pure) and do a human visual pass per the memory guidance
  (real, not fake).
- No mock-claude transport test for expansion — expansion is a real-CLI behavior;
  cover it with the probe harness / in-app check, not a synthetic stub.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Commits land on `main` (user-invoked), per repo
> policy — the plan author does not commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Command-atom wire serialization + helpers | done | 45a3e02b |
| #step-2 | Distinct command chip — style descriptor, both renderers | done | 3e5305a7 |
| #step-3 | Transcript echo detection → unified chip | done | 842c48c3 |
| #step-4 | Synthesizer correctness + marker guard | done | 1aefe5f9 |
| #step-5 | Submission ergonomics audit | done | verification only |
| #step-6 | Integration checkpoint + remove probe skill | done | probe-noop removed; global tugplug + double-slash fixes folded in |

#### Step 1: Command-atom wire serialization + helpers {#step-1}

**Commit:** `fix(tugdeck): serialize command atoms as clean /name so claude expands them`

**References:** [P01] Clean wire, [P02] Bare name, [P05] Embedded, Spec S01, (#wire-format, #context)

**Artifacts:**
- `tugdeck/src/lib/command-atom.ts` — `commandWireText(value, args?)`, `commandChipLabel(value)`.
- `build-wire-payload.ts` — `command`-type branch emitting `commandWireText`.
- Updated `build-wire-payload.test.ts` (replace the now-stale `@`-marker expectation,
  add lone + trailing-args + embedded cases).
- `tugplug/skills/probe-noop/SKILL.md` — the `disable-model-invocation: true` checkpoint
  fixture (see #dependencies).

**Tasks:**
- [ ] Create `tugplug/skills/probe-noop/SKILL.md` (`disable-model-invocation: true`,
      replies with a fixed token) for the checkpoint.
- [ ] Add `command-atom.ts` with `commandWireText` (prepends `/`, appends ` args` when
      present) and `commandChipLabel` (prepends `/`).
- [ ] In `buildWirePayload`, branch on `atom.type === "command"` → push
      `commandWireText(atom.value)` into the current text buffer; keep `wrapAtomMention`
      for all other non-image atoms.
- [ ] Confirm a command atom followed by literal text coalesces into one `/cmd args`
      text block.

**Tests:**
- [ ] Lone command atom → `[{type:"text", text:"/tugplug:commit"}]`.
- [ ] Command atom + ` one two` text → `[{type:"text", text:"/cmd one two"}]`.
- [ ] Command atom embedded mid-prose → plain `/name` substituted, no marker, no error.
- [ ] File/link/doc atoms still emit the `@`-marker (no regression).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/build-wire-payload.test.ts src/lib/__tests__/command-atom.test.ts`
- [ ] In Tug.app (HMR) against `/tmp/commit-test-ground`: `/tugplug:probe-noop` submits
      and returns `PROBE_OK_USER_INVOCATION` with **no** Skill-tool block.

#### Step 2: Distinct command chip — single style descriptor, both renderers {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): distinct command chip via type-keyed style descriptor`

**References:** [P02] Bare name, [P03] Command chip, [P06] Editor re-bake, (#state-zone-mapping), [L06], [L22], [L19]

**Artifacts:**
- `command-atom.ts` — `chipStyleForType(type)` → `{ tokens, geometry }` (color-token
  names + radius/padding/gap/slash-glyph), the single source of truth for chip styling.
- `tug-atom-img.ts` (`computeAtomChipGeometry`, `buildAtomSVGDataUri`) + `tug-atom-chip.tsx` —
  both consume the descriptor; the duplicated literal `rx` and inline token references in
  each are removed. `command` chips display `commandChipLabel(value)`.
- `brio.css` + `harmony.css` — command token set (hand-authored, both themes).
- `tug-text-editor.tsx` — dev/HMR dispatch of `regenerateAtomsEffect` so editor chips
  re-bake on a theme-stylesheet edit ([P06]).

**Tasks:**
- [ ] Add `--tug7-…-atom-command-…` tokens to both theme files (mirror the existing
      `atom-…-route-…` variant grammar already present in `brio.css`).
- [ ] Implement `chipStyleForType`: `command` → command tokens + distinct geometry; all
      other types → today's exact tokens + geometry (zero visual change).
- [ ] Refactor `computeAtomChipGeometry` to read radius/padding/gap from the descriptor;
      remove the literal `rx="3"` from `buildAtomSVGDataUri`'s SVG string and `rx={3}`
      from `TugAtomChip`, sourcing both from the descriptor.
- [ ] Route `buildAtomSVGDataUri` (baked `getTokenValue`) and `TugAtomChip`
      (`var(--tug7-…)` refs) through the descriptor's token names — no inline token
      literals remain in either renderer.
- [ ] Render the command chip label with a leading slash in both renderers
      (`commandChipLabel`).
- [ ] Wire the [P06] dev/HMR re-bake signal (fire `regenerateAtomsEffect` on theme
      stylesheet hot-replace); if the HMR hook is impractical, record the documented
      manual-re-render fallback per [P06].

**Tests:**
- [ ] `chipStyleForType("command")` differs from `chipStyleForType("file")` in *both*
      tokens and geometry.
- [ ] **Regression guard:** for every non-command type (`file`, `image`, `doc`, `link`),
      `chipStyleForType` returns today's exact token names and geometry values (radius =
      3, current padding/gap) — non-command chips are byte-for-byte unchanged.
- [ ] `commandChipLabel("tugplug:commit") === "/tugplug:commit"`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/command-atom.test.ts && bunx tsc --noEmit`
- [ ] In Tug.app: the command chip is visibly distinct from a file chip in shape *and*
      color, in **both** brio and harmony, and shows the leading slash.
- [ ] In Tug.app (HMR): editing a command token value in `brio.css` updates the editor
      chip *and* the transcript chip together — no stale baked editor chip.

#### Step 3: Transcript echo detection → unified chip {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): render claude command-expansion echo as a command chip`

**References:** [P04] Transcript echo, [P05] Embedded, [Q01] Echo format, Spec S02, (#wire-format)

**Artifacts:**
- `command-atom.ts` — `detectCommandEcho(blocks)` (Spec S02), tolerant per [Q01].
- `synthesize-user-message.ts` — call `detectCommandEcho` before the generic marker walk.
- Golden fixture captured from a real expansion echo (skill + the [Q01] built-in spike).

**Tasks:**
- [ ] Spike [Q01]: capture real echoes (probe skill + a read-only built-in) via the probe
      harness; record the golden fixture(s).
- [ ] Implement `detectCommandEcho` (tolerant regex; optional `command-message` /
      `command-args`; whole-message only).
- [ ] Wire it into the user-substrate synthesis so a command turn yields a `command`
      atom; non-command turns are untouched.

**Tests:**
- [ ] Golden: real echo string → `{name:"tugplug:probe-noop", args:undefined}` →
      substrate `(U+FFFC, [{type:"command", value:"tugplug:probe-noop"}])`.
- [ ] Echo with `<command-args>` → args rendered as trailing text after the chip.
- [ ] Non-command user text (incl. text that merely mentions `<command-name>` in prose
      but isn't the whole message) → unchanged generic synthesis.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/command-atom.test.ts src/lib/__tests__/synthesize-user-message.test.ts`
- [ ] In Tug.app: a committed `/tugplug:commit` turn shows a command chip reading
      `/tugplug:commit` (no raw XML, no file chip), identical to the editor chip.

#### Step 4: Synthesizer correctness + marker guard {#step-4}

**Depends on:** #step-3

**Commit:** `fix(tugdeck): keep commands off the file-mention marker path`

**References:** [P01] Clean wire, [P04] Transcript echo, (#terminology), [L19]

**Artifacts:**
- `synthesize-user-message.ts` — confirm/guard that `@`-marker spans never mint a
  `command` (commands arrive only via `detectCommandEcho` now).
- Regression test pinning the live optimistic-echo ↔ replay-echo parity for a command
  turn ([P05] — only a lone command turn becomes a chip).

**Tasks:**
- [ ] Verify commands no longer reach `parseAtomMentionSegments` (they're bare `/name`
      text or detected echoes); add an assertion/test so a future change can't re-route
      a command through the file-typed marker mint.
- [ ] Confirm the live submit path's optimistic substrate and the replayed
      `add_user_message` substrate render the same command chip (no shape flicker).

**Tests:**
- [ ] A `/name` text block (no `@`-marker) does **not** synthesize a `file` atom.
- [ ] Optimistic vs replay substrate for the same command turn are visually equivalent
      (same atom `type`/`value`, same label).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/synthesize-user-message.test.ts`
- [ ] In Tug.app: submitting a command shows no chip flicker/relabel when the turn lands.

#### Step 5: Submission ergonomics audit {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugdeck): smooth slash-command submission for built-in skills`

**References:** [Q02] Auto-submit, (#strategy, #success-criteria)

**Artifacts:**
- Findings + any small ergonomics change (e.g. argument-hint continuity for `/cmd <args>`;
  optional gated accept-to-submit per [Q02]).

**Tasks:**
- [ ] Audit accept → submit for a no-arg built-in skill: count keystrokes, confirm the
      popup surfaces the full built-in skill set, confirm argument-hint commands still
      compose `/cmd args` cleanly after #step-1.
- [ ] Resolve [Q02]: implement the gated lone-no-arg auto-submit only if it doesn't
      regress argument-taking commands; otherwise record the decision to keep explicit
      submit.

**Tests:**
- [ ] `/cmd <args>` argument-hint path still yields one `/cmd args` wire string.
- [ ] (If [Q02] pursued) accepting a lone no-arg command submits; an argument-hint
      command does not.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib`
- [ ] In Tug.app: submitting a built-in skill (e.g. `/context`) and a plugin skill feels
      direct — no improvisation, no error, recognizable command chip.

#### Step 6: Integration checkpoint + remove probe skill {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** `chore(tugplug): remove probe-noop fixture`

**References:** [P01]–[P05], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Full pass against the scratch repo: `/tugplug:commit`, `/tugplug:probe-noop`, a
      built-in skill, an argument-taking command, and an embedded-command message.
- [ ] Remove `tugplug/skills/probe-noop`.

**Tests:**
- [ ] `cd tugdeck && bun test src/lib` (all green).

**Checkpoint:**
- [ ] All #success-criteria verified in Tug.app.
- [ ] `tugplug/skills/probe-noop` is gone; no other references to it remain.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Slash commands submit as reliable claude **user invocations** from the
Dev card (no `disable-model-invocation` error, no model improvisation), wearing one
distinct command chip shared by the prompt editor and the transcript.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `/tugplug:commit` and `/tugplug:probe-noop` run as user-invoked skills in Tug.app
      against `/tmp/commit-test-ground` — no Skill-tool block, no improvised commit.
- [ ] `buildWirePayload` emits clean `/name` (+ args) for command atoms; covered by unit
      tests; embedded/multi-command cases send plain `/name` text.
- [ ] Command chip is distinct from file/image/link/doc chips in **color and shape** in
      both brio and harmony, shows the leading slash, is identical in editor and
      transcript, and is governed by one `chipStyleForType` descriptor.
- [ ] A command token edit in `brio.css` live-updates editor and transcript chips
      together (no stale baked editor chip).
- [ ] A committed command turn renders as a command chip (no raw `<command-name>` XML,
      no file chip), with optimistic/replay parity.
- [ ] `probe-noop` fixture removed; `bun test src/lib` green.

#### Roadmap / Follow-ons (Not required for phase close) {#roadmap}

- [ ] Sweep stale "Tide" references where command/transcript docs touch them (separate
      effort per existing memory).
- [ ] Revisit [Q02] auto-submit ergonomics if the catalog gains a per-command "takes
      args" signal.
- [ ] **Bare-typed namespaced shortcut** (#step-5 audit finding): a bare `/commit` typed
      *without* accepting the popup resolves via `resolveRemoteCommand` for the
      unknown-check, but is sent verbatim — claude's catalog only has `tugplug:commit`, so
      bare `/commit` may not expand. The popup-accept path carries the canonical
      namespaced name and works; consider rewriting a bare typed `/leaf` to its unique
      canonical `/ns:leaf` at submit so the shortcut also expands cleanly.

| Checkpoint | Verification |
|------------|--------------|
| Wire format | `bun test build-wire-payload.test.ts command-atom.test.ts` |
| Chip styling | Visual pass in brio + harmony; `chipStyleForType` unit test (command differs, non-command unchanged) |
| Transcript echo | Golden fixture test + Tug.app committed-turn check |
| End-to-end | `/tugplug:commit` user-invoked run in Tug.app, scratch repo |
