## Dash identity, one grammar — the revision round {#dash-ui-revision}

**Purpose:** Ship the corrected dash-identity design from [`dash-ui-report.md`](dash-ui-report.md): one identity format (`custom-name:project/callsign#dash-name`) worn identically by every register, elision only under real width pressure, and the Lens dash facts rendered as an indented line inside the session's own row instead of a separate outdented list row.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:7dcf994cb4ba07fe`. Lint: 0 errors, 1 warning (fixed — this section is the warning).
Oriented on: the plan as authored, read against the shipped round-one code.
Applied: **completeness** — at0408 and at0417 both assert the dash run's `textContent` equals the *bare* dash name, so the `#` sigil breaks them, and neither declares `@covers` on `tug-session-identity.tsx`, so `app-test-changed` would not have selected them either; both are now Step 1 artifacts with the missing `@covers` added, and Risk R04 records the class of defect. **Technical choice** — [P03]/Spec S02 as authored could not produce the squeeze ordering they claimed: three shrinkable runs in one flex line split a deficit proportionally, which is exactly the trap `tug-session-identity.css`'s own chip-tier comment documents ("a sliver is enough to paint an ellipsis on a name that fits"), so the spec now nests a `.tug-session-identity-title` box using the idiom that file already uses for strict priority. **Spec correctness** — Spec S02 had dropped `data-slot="session-identity-dash"`, which four app-tests select on (restored); Spec S01 named a `--tugx-session-row-dash-indent` base that does not exist, corrected to the real `--tugx-session-identity-row-indent` resolved from `data-sub-align`. **Success criteria** — the "no `max-inline-size` anywhere" criterion contradicted the correct implementation, since percentage clamps are the file's own priority idiom; narrowed to fixed-length ceilings. **Pitfalls** — added the `:has()` invalidation prohibition for the dynamically-appearing dash line ([L06] and the WebKit descendant-invalidation trap), the `dashLine` destructure trap, and the no-tape-reserve note.
Deferred: nothing. Every design question was settled by the owner's review notes of 2026-08-16 before authoring; no `[Q##]` was raised.

**Round 2 — 2026-08-16, opus.** Reviewed `plan:03a9ca171ed86dbe`. Lint: 0 errors, 0 warnings.
Oriented on: round 1's own edits, re-read whole after stamping.
Applied: coherence only — two sentences round 1 left standing contradicted the fixups it had just made. The Strategy bullet still described the dash run as "a third sibling of the name and callsign spans", which is the structure [P03] replaced with the title-box nesting; and a Success Criterion still counted "the three dash-UI app-tests" after [R04] had made it five. Both corrected. No decision, spec, step, or checkpoint changed.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Round one of the dash-UI campaign shipped the report's original proposals: a session-keyed `dashForSession` lookup (`tugdeck/src/lib/dash-session-index.ts`), a dash marker run in `TugSessionIdentity` (`git-branch` glyph + name on the line tier, glyph alone on the chip tier), and a `dash-subrow` row kind nested under bound sessions in the Lens Cards section. The owner reviewed the shipped result live and found the treatment wrong in three specific ways, recorded in the report's [verdicts section](dash-ui-report.md#verdicts): the two-register treatment spells the same session two different ways depending on where you meet it; the masthead truncates the dash name even with ample free width (a hard `max-inline-size: 14ch` ceiling in `tug-session-identity.css`, not space pressure); and the Lens sub-row reads as an outdented stray sibling with its own alternating-stripe band rather than as a fact about the session above it.

This plan implements the [corrected design](dash-ui-report.md#corrected-design). It is a revision of shipped code, so most of the work is rewriting existing surfaces and the **five** app-tests that pin the old grammar — at0406 (masthead run), at0423 (atom mark), at0424 (Lens sub-row), and, less obviously, at0408 (dash gesture) and at0417 (join mode), which both assert the dash run's `textContent` equals the *bare* dash name and so break the moment the `#` sigil lands. See [Risk R04](#r04-textcontent-pins).

#### Strategy {#strategy}

- Change the grammar once, at its producer: `TugSessionIdentity` renders the format for both tiers, so no mount site changes for the format itself.
- Fold the dash run *into* the title's run box, beside a new title box holding the name and callsign, so the no-space spelling `…sporty-snail#scroll-preserve-resize` falls out of markup adjacency instead of gap arithmetic, the run inherits the shared baseline, and the squeeze order becomes structural rather than asserted ([P03]).
- Delete the truncation ceiling in the same step — same file, same tests, one commit.
- Move the Lens dash facts from a list-row kind to a presentational fourth-line slot on `TugSessionRow`, filled only by the Lens mount; delete the `dash-subrow` machinery whole.
- Update each pinned app-test in the step that changes what it pins; never leave a step red.

#### Success Criteria (Measurable) {#success-criteria}

- A dash-bound session with a custom name renders `name:project/callsign#dash-name` — colon and hash directly abutting their neighbors, no spaces — identically in the masthead title and in the session atom (verified by at0406 and at0423 reading the rendered text).
- `scroll-preserve-resize` (21 chars) renders unelided in a masthead with free width, and at0406 asserts the full name. No **fixed-length** ceiling (`ch`, `px`, `rem`) remains on any identity run — percentage clamps stay, because `max-inline-size: 100%` against a shrinkable parent is the file's own strict-priority idiom ([P03]) rather than a truncation rule.
- The Lens shows a dash-bound session as one list row whose block contains an indented dash facts line; no row of kind `dash-subrow` exists anywhere (at0424 asserts the line inside the session row and the absence of a separate row; `cards-data-source.test.ts` asserts the row list never contains a dash kind).
- The flat citation string (`sessionCitation`) is byte-identical before and after binding a dash (at0423's existing pin, retained).
- `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build` all green; all five dash-identity app-tests green in one invocation.

#### Scope {#scope}

1. `TugSessionIdentity` (`.tsx`/`.css`) — the format, the sigil, the separator, the elision rules.
2. `TugSessionRow` — a presentational `dashLine` slot.
3. The Lens Cards section — the in-row dash line, and deletion of the `dash-subrow` row kind, cell, and styles.
4. The five app-tests and the unit-test files that pin the old design ([R04](#r04-textcontent-pins)).

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Join sheet hunt ([report §4](dash-ui-report.md#join-sheet)) — a hand-driven exercise in the release instance, not a plan step.
- The Z4A join-mode pass and the doubled squash prefix ([report §5](dash-ui-report.md#z4a)).
- Entry points ([report §6](dash-ui-report.md#entry-points)).
- The Dashes section roster — it keeps its bare dash names and its current shape; only the Cards section changes.
- `dash-session-index.ts` — the selector is correct and untouched.

#### Dependencies / Prerequisites {#dependencies}

- Round one of the dash-UI work is shipped and live on `main` (it is — `dash-session-index.ts`, the marker in `tug-session-identity.tsx`, and `DashSubrowCell` in `cards-section.tsx` all exist).

#### Constraints {#constraints}

- Frontend-only; no Rust, no protocol change, so no `just build-app` is required — but every step ends with `bunx vite build` because the app-test instances serve the prod rollup bundle.
- App-tests run via `just` recipes, selectively, output never piped.
- Tuglaws apply; the cross-check is named per step.

#### Assumptions {#assumptions}

- The `#` character is safe in the rendered grammar (it never enters `sessionCitation`, URLs, or ids — display ink only).
- `SessionIdentityRowProps` extends `Omit<TugSessionRowProps, …>` without omitting new members, so a new `TugSessionRow` prop flows through Lens mounts via `...rest` with no `session-identity-row.tsx` change.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `**Depends on:** #step-N` lines, and rich `**References:**` lines per the devise skeleton. No line numbers in references.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The design was settled by the owner's review notes of 2026-08-16 and recorded in the report's corrected-design section before this plan was authored.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Atom width growth crowds dense mounts | med | med | R01 | a Gazette or telemetry row wraps or clips |
| Squeeze regression in the masthead | med | low | R02 | at0406 red on the elision assertions |
| Hidden consumer of the deleted sub-row | low | low | R03 | grep sweep in Step 2 |
| Tests pinning the run's bare `textContent` | high | certain | R04 | any app-test comparing the run's text to a dash name |
| The tape no longer reads as centered | low | med | R05 | owner's eye on the Lens rail after Step 2 |

**Risk R01: The atom gets wider** {#r01-atom-width}

- **Risk:** The chip tier previously showed a bare glyph for a dash; it now carries `#<dash-name>`, so every dash-bound atom grows by the name's width in dense surfaces (Gazette refs, telemetry panel, commit lines).
- **Mitigation:** The dash run keeps its give-way-first squeeze rule (`flex: 0 1 auto; min-width: 0`), so under pressure the dash name elides before the callsign and long before the user's name; the tooltip still carries the full sentence.
- **Residual risk:** An uncompressed atom in a roomy surface is simply wider. That is the design — one format — accepted by the owner.

**Risk R02: Moving the run inside the title box changes squeeze arithmetic** {#r02-squeeze}

- **Risk:** The dash run currently sits as a flex sibling of the title run inside `.tug-session-identity` (6px gap); moving it inside `.tug-session-identity-run` changes which flex container distributes a deficit.
- **Mitigation:** The run keeps `flex: 0 1 auto; min-width: 0` inside its new parent, which already has `min-width: 0`; the per-tier name/callsign rules are untouched. at0406's squeeze assertions verify the ordering live.
- **Residual risk:** None identified beyond what the app-test covers.

**Risk R03: Something outside the Lens consumed the sub-row** {#r03-subrow-consumer}

- **Risk:** A test or surface not found during planning selects on `dash-subrow` / `lens-cards-dash-subrow` and breaks silently.
- **Mitigation:** Step 2 ends with a repo-wide grep for `dash-subrow`, `lens-cards-dash-subrow`, and `DASH_SUBROW_GLYPH` expecting zero hits outside the plan's own edits.

**Risk R04: Two app-tests pin the run's bare text, and no gate in this plan would have caught them** {#r04-textcontent-pins}

- **Risk:** `at0408-dash-gesture.test.ts` and `at0417-join-mode.test.ts` each define `const CHIP = '[data-slot="session-masthead"] [data-slot="session-identity-dash"]'` and assert `CHIP.textContent.trim() === <bare dash name>` (at0408 twice, at0417 once; at0417 also asserts the selector's absence after a landing, which survives). Adding the `#` sigil *inside* the run makes `textContent` read `#name`, so all three equality assertions go red. Neither file declares `@covers tugdeck/src/components/tugways/tug-session-identity.tsx`, so `just app-test-changed` would not select either one — the breakage would clear Step 1's checkpoint, Step 3's aggregate, and the derived selection alike, and surface later as an unexplained red in an unrelated run.
- **Mitigation:**
  - Step 1 updates both files' assertions and runs them in its own checkpoint.
  - Step 1 adds the missing `@covers` line to both, so the next change to the identity component selects them automatically. This is the durable half of the fix: the assertions were reachable only by reading every file that selects the slot.
  - The sigil stays **inside** the run (rather than being emitted as a sibling) because the run is the elision and review-tint unit; the cost is exactly these text pins, which is a fair trade once they are found.
- **Residual risk:** Another surface may select the slot without covering the component. The Step 1 sweep greps for `session-identity-dash` across `tests/` and `tugdeck/src` and reconciles every hit, which closes the enumeration rather than sampling it.

**Risk R05: The activity tape stops reading as centered on the row** {#r05-tape-centering}

- **Risk:** `tug-session-row.css` derives `--tugx-session-row-spark-rise` to center the tape on the description+activity *pair* (`.tug-session-row:has(.tug-session-row-description)`). A fourth line below the activity leaves that arithmetic correct but puts the tape visibly above the row's new vertical middle.
- **Mitigation:** None applied — the derivation is right (the tape reports on the pair it rides, not on the dash fact beneath), and re-deriving it against a line that comes and goes would make the tape move whenever a dash binds. Recorded so the owner reads it as a consequence rather than a bug.
- **Residual risk:** Cosmetic, and only on dash-bound rows in the Lens rail.

---

### Design Decisions {#design-decisions}

#### [P01] One format, both tiers: `custom-name:project/callsign#dash-name` (DECIDED) {#p01-one-format}

**Decision:** Both identity tiers render the identical string grammar — the user's name, a bare `:`, the `project/callsign` run, and a `#dash-name` run when the session is dash-bound. Absent parts drop with their sigil: no custom name → `project/callsign#dash`; no dash → `name:project/callsign`; neither → bare `project/callsign`.

**Rationale:**
- The owner's verdict on round one: the same session spelling itself two ways (glyph+name on the line tier, glyph-only on the atom) is a bifurcated identity. One format, worn everywhere ([report §3a](dash-ui-report.md#one-format)).
- The spaces around the colon are removed by the same verdict.

**Implications:**
- The `{" : "}` literal in `TugSessionIdentity`'s callsign span becomes `":"`.
- `SessionDashMarker` loses its `withName` prop — the name always renders; the tier asymmetry is deleted.
- The per-tier squeeze rules survive (they govern *which run elides*, not what the runs say).

#### [P02] `#` is the dash sigil, replacing the glyph; the sigil never elides (DECIDED) {#p02-hash-sigil}

**Decision:** The `git-branch` glyph leaves the identity grammar. The dash run renders as a `#` sigil span followed by the name span; the sigil is `flex: none` (like the glyph it replaces), and only the name elides.

**Rationale:**
- The format is text; a glyph inside a text grammar was the round-one design being replaced.
- An ellipsized dash must still say it is a dash — the surviving `#` does that, exactly as the surviving glyph did.

**Implications:**
- The `GitBranch` import leaves `tug-session-identity.tsx` (it remains in the Lens Dashes section roster and elsewhere).
- The `aria-label` (`On dash <name>`) and the `title` tooltip sentence move onto the run unchanged.
- The review tint keeps its mechanism: `data-review` on the run, caution tone in CSS ([L06]).

#### [P03] The dash run lives inside the title's run box, beside a title box that clamps rather than shrinks (DECIDED) {#p03-run-inside-title}

**Decision:** `SessionDashMarker` moves from a flex sibling of `.tug-session-identity-run` (separated by the container's 6px gap) to a child *inside* it. Inside that run, the name and callsign are wrapped in a new `.tug-session-identity-title` box that is `flex: 0 0 auto; max-inline-size: 100%`, with the dash as its sibling at `flex: 0 1 auto; min-inline-size: 0`.

**Rationale:**
- The no-space spelling `…sporty-snail#scroll-preserve-resize` should come from markup adjacency, not from per-child gap overrides fighting the container's 6px `gap`. Inside the run the dash also inherits the baseline the name and callsign already share (`align-items: baseline`).
- **The wrapper is what makes "the dash gives way first" true rather than merely asserted.** Three shrinkable runs on one flex line do not elide in priority order: flex distributes a deficit in proportion to `shrink × basis`, so a squeeze ellipsizes the user's name and the dash name *together*. `tug-session-identity.css` already documents this exact trap in its chip-tier rule — "flex splits a deficit in proportion to `shrink × basis`, so however lopsided the factors, the name always loses a sliver — and a sliver is enough to paint an ellipsis on a name that fits" — and solves it there with a clamp instead of a shrink factor (`.tug-session-identity[data-tier="chip"] .tug-session-identity-name { flex: 0 0 auto; max-width: 100% }`). This decision applies that same idiom one level up, so the file has one mechanism for strict priority rather than two.
- With the clamp, the ordering is exact: every pixel of a deficit lands on the dash until it has none left; only then does the title box clamp to the run and its own per-tier rule decide between the name and the callsign.

**Implications:**
- New element and class: `.tug-session-identity-title`, wrapping the existing name and callsign spans. The per-tier name/callsign rules keep their current selectors and semantics — they simply resolve their percentages against the wrapper, which is itself clamped to the run.
- Every existing test selector survives: at0373 and at0368 reach `.tug-session-identity-name` / `.tug-session-identity-callsign` through `querySelector`, which is a descendant match and does not care about the new parent.
- `.tug-session-identity-dash` drops its `gap: 3px` (the sigil abuts the name) and keeps `flex: 0 1 auto; min-inline-size: 0`.
- The privacy marker stays where it is: a trailing sibling outside the run, `flex: none`.
- The old outer arrangement (dash as a sibling of the run, both shrinkable) is what shipped in round one; deleting it is part of this step, not a leftover.

#### [P04] The citation string stays dash-free (DECIDED) {#p04-citation-dash-free}

**Decision:** `sessionCitation` never carries the dash. Unchanged from round one.

**Rationale:**
- The flat string outlives the binding in pastes and commits; a citation carrying `#dash` would rot when the dash lands. This is a copy-path rule; every *displayed* identity wears the full format.

**Implications:**
- at0423's byte-identical-citation pin survives verbatim; only its atom-face assertions change.

#### [P05] Elision only under real pressure — no fixed ceilings (DECIDED) {#p05-no-ceilings}

**Decision:** Delete `max-inline-size: var(--tugx-session-identity-dash-max, 14ch)` from `.tug-session-identity-dash-name`, and the knob with it (verified: `tug-session-identity.css` is its only consumer in the tree). No identity run may carry a **fixed-length** width ceiling that can truncate while the container has free width. Percentage clamps against a shrinkable parent are unaffected — they are the priority idiom of [P03], not a truncation rule.

**Rationale:**
- The ceiling is the masthead defect: `scroll-preserve-resize` clips to 14ch regardless of available width ([report §2b](dash-ui-report.md#verdicts)).
- `flex: 0 1 auto; min-width: 0` with `overflow: hidden; text-overflow: ellipsis` already elides under genuine squeeze; the ceiling added nothing but the lie.

**Implications:**
- A long dash name now sets natural width in a roomy masthead — accepted; under squeeze it is still the first thing to give way.
- Audit while in the file: the name and callsign runs carry no such ceilings today (`min-width: 0` + overflow only) — confirm and leave them.

#### [P06] The Lens dash facts are a row-internal line, not a row (DECIDED) {#p06-row-internal-line}

**Decision:** Delete the `dash-subrow` row kind end to end. `TugSessionRow` gains a presentational `dashLine?: React.ReactNode` slot rendered as the last line inside `.tug-session-row-lines`; the Lens's `CardsSessionRow` fills it with a leaf component that reads `useDashForSession` and renders the facts (`#name`, stage, `step i/N`, review mark) via the existing `DashFactsRun`.

**Rationale:**
- The owner's verdict: a separate list row takes its own alternating-stripe band and outdents its glyph to the list gutter — it reads as a stray sibling, not a nested fact ([report §2c](dash-ui-report.md#verdicts)).
- Inside the row, the line shares the row's band by construction, travels with its session by construction, and the stripe-parity/row-count bookkeeping a separate kind required is simply gone.
- `TugSessionRow` stays presentational ([L20]): the slot is a node the mount hands in; the masthead and picker pass nothing and render nothing.

**Implications:**
- Deleted: the `dash-subrow` union member, its `kindOfRow`/`idOfRow` branches, and the emission block in `cards-data-source.ts`; `DashSubrowCell`, its renderer registration, and `DASH_SUBROW_GLYPH` in `cards-section.tsx`; `.lens-cards-dash-subrow` and `.lens-cards-dash-glyph` in `cards-section.css`.
- Kept: the dash name in the pane's filter match fields (`dashFor(entry.identity)?.name` in `buildCardsRows`) — a reader who types a dash name still finds the session working it.
- The line indents to the sub-lines' inset plus one nesting step (see Spec S01) and is styled in `tug-session-row.css`, the shape's own stylesheet.
- The Lens line spells the name `#<dash-name>` (the grammar's own spelling, passed as the `name` prop to `DashFactsRun`); the Dashes section roster keeps bare names — its rows *are* dashes, and the `#` marks a dash run inside a *session* context.

#### [P07] The Lens title still suppresses its own dash run (DECIDED) {#p07-title-suppression}

**Decision:** `CardsSessionRow` keeps `dashRun={false}` on the identity.

**Rationale:**
- The facts line directly beneath carries the name plus the stage, steps, and review mark; the title repeating `#name` one line above would be the same fact twice within one row's height — the round-one reasoning, still correct with the new placement.

**Implications:**
- at0424 keeps its suppressed-title-run pin; only the sub-row half of the test is rewritten.

---

### Specification {#specification}

**Spec S01: The Lens dash line** {#s01-lens-dash-line}

Rendering, inside the session's own `TugListRow` (same band, no new row):

```
[dot] scroll-preservation:tugtool/sporty-snail          <slots>
      Preserve scroll position across card width changes…
      6 turns, 1.6 MB. Last updated: Aug 16, 2:46 PM. Ready.
        #scroll-preserve-resize  working  step 6/10  [stale-mark]
```

- The line is emitted by `TugSessionRow` when `dashLine` is non-null, after the `TugPulse` line, inside `.tug-session-row-lines`, as `<span className="tug-session-row-dashline" data-slot="tug-session-row-dashline">{dashLine}</span>`.
- Indent: **one step further in than the sub-lines**, computed from the knob the row already resolves — `padding-inline-start: calc(var(--tugx-session-identity-row-indent, 10px) + var(--tugx-session-row-dash-indent, 12px))`. `--tugx-session-identity-row-indent` is `tug-session-row.css`'s existing sub-line indent, set from the `data-sub-align` attribute (`title` → `--tugx-session-row-title-inset`, `edge` → `--tugx-session-row-edge-indent`, which is what the Lens rail wears); reusing it is what puts the dash line on the description's vertical *plus* its nesting step, instead of on a number that has to be kept in agreement by hand. The new `--tugx-session-row-dash-indent` knob's default rides a `var()` fallback at point of use, never declared on the element.
- **No trailing reserve.** The description and activity lines carry `padding-inline-end: var(--tugx-session-row-spark-reserve, 0px)` because the tape overhangs *upward* from the line it rides; the dash line sits below the activity and nothing is drawn over it, so copying that rule here would spend width for nothing.
- **No `:has()` rule may key on this line.** It appears and disappears as a dash binds and unbinds, and WebKit does not invalidate a `:has()` whose subject changes by a descendant's arrival — a rule like `.tug-session-row:has(> .tug-session-row-dashline)` would paint correctly on first render and then silently stop matching. Anything the line's presence must change is expressed on the line's own element ([L06]).
- Ink: the muted informational register the sub-row used; the review mark keeps `DashReviewMark`'s own tones. `DashFactsRun` and `dash-facts.css` are self-contained (`.lens-dashes-facts` declares its own flex, gap, and baseline and inherits nothing from `.lens-cards-*`), so mounting the run outside the Lens sections needs no style change.
- The Lens leaf (`LensSessionDashLine`, in `cards-session-cell.tsx`) returns `null` when `useDashForSession(sessionId)` answers null — the slot then renders nothing and the row is exactly its three-line self. Mark size: a local constant in `cards-session-cell.tsx` (the sub-row's 14 moves with the code that uses it).
- The line is not a gesture surface of its own: clicks land on the row, which already fronts the session's card. It is not a drag handle and never enters the reorder — properties it now has by construction, being row ink.

**Spec S02: The identity run structure after [P01]–[P03]** {#s02-run-structure}

```html
<span class="tug-session-identity-run">
  <span class="tug-session-identity-title">
    <span class="tug-session-identity-name">scroll-preservation</span>
    <span class="tug-session-identity-callsign">:tugtool/sporty-snail</span>
  </span>
  <span class="tug-session-identity-dash"
        data-slot="session-identity-dash"
        data-review?
        title="Working on dash scroll-preserve-resize"
        aria-label="On dash scroll-preserve-resize">
    <span class="tug-session-identity-dash-sigil" aria-hidden="true">#</span>
    <span class="tug-session-identity-dash-name">scroll-preserve-resize</span>
  </span>
</span>
```

- **`data-slot="session-identity-dash"` is load-bearing and must survive verbatim.** Four app-tests select on it — at0406, at0408, at0417, at0423 — and two of them assert against the element's text (see [R04](#r04-textcontent-pins)).
- The callsign span carries the bare `":"` (its `white-space: pre` becomes unnecessary but harmless; drop it).
- Flex: `.tug-session-identity-title` is `flex: 0 0 auto; max-inline-size: 100%; min-inline-size: 0`; `.tug-session-identity-dash` is `flex: 0 1 auto; min-inline-size: 0`; `.tug-session-identity-dash-sigil` is `flex: none`; `.tug-session-identity-dash-name` is `min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` with **no** `max-inline-size`.
- Squeeze order, both tiers, and now produced by the structure rather than asserted by a comment ([P03]): the dash name absorbs the whole deficit and elides to nothing first; only then does the title box clamp and the tier's own name/callsign rule apply, unchanged.
- Accessibility: the sigil is decorative (`aria-hidden`), and the run carries the sentence — a screen reader says "On dash scroll-preserve-resize", never "hash scroll dash preserve".
- The run renders on both tiers identically; `SessionDashMarker`'s `withName` parameter is deleted.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

No new state. Every read exists today; the mapping is cited for the cross-check:

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| dash binding (per session) | external store, derived | `useDashForSession` over the changeset aggregate | [L02] |
| review tint | appearance | `data-review` attribute + CSS tone | [L06] |
| dash line presence in a Lens row | derived render (null → absent) | leaf component returning null | [L02], [L06] |
| elision | appearance | flex + overflow CSS only | [L06] |

**Law cross-check.** [L02] — no new store and no new subscription: the dash fact enters through `useDashForSession`, which is `useChangesetAll` (a `useSyncExternalStore` face) memoized per snapshot; the Lens line is a leaf subscriber for the same reason `SessionDashMarker` is one, so binding a dash does not wake every session row in the app. [L06] — every appearance change here is CSS or a data attribute: the review tint is `data-review`, the elision is flex plus `overflow`, and the dash line's presence is a rendered node rather than a class toggled from state; the `:has()` prohibition in Spec S01 is this law's practical edge in WebKit. [L13] — nothing here animates; the line appears on a snapshot beat with no transition, so no motion belongs to it. [L19] — `TugSessionRow` keeps its `.tsx`/`.css` pair and its `data-slot`; the new line gets its own `data-slot="tug-session-row-dashline"` so a test can name it. [L20] — token sovereignty is the reason `dashLine` is a *node* the mount hands in rather than a dash lookup inside `TugSessionRow`: the shape stays presentational and the Lens keeps its own data reads, and the one new knob (`--tugx-session-row-dash-indent`) is declared in the row's own namespace and composed with the row's existing `--tugx-session-identity-row-indent` instead of reaching into another component's numbers. [D123] — the identity is still produced in one place; this plan changes what that one place spells, which is the whole reason no mount site needs editing for the format.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure row-model and index logic | `cards-data-source.test.ts` — the row list's shape after the sub-row deletion |
| **Integration (app-test)** | The real app, real CLI binds, real aggregate beats | at0406, at0423, at0424 rewritten to the new grammar; at0408 and at0417 updated where they assert the run's text |
| **Drift Prevention** | The citation's stability | at0423's byte-identical citation assertion, retained |

#### What stays out of tests {#test-non-goals}

- No jsdom/RTL render tests of `TugSessionIdentity` or `TugSessionRow` — banned shape; the app-tests drive the real surfaces.
- No screenshot comparison of the indent — at0424 asserts structure (the line inside the row element, no separate list row); pixel taste is the owner's review.
- No new per-mutator pin tests on `dash-session-index.ts` — untouched, already covered.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | One grammar, no ceilings — the identity revision | done | 4d888adbf |
| #step-2 | The Lens dash line moves inside the session row | done | 4d888adbf |
| #step-3 | Integration checkpoint — every dash-identity surface in one invocation | done | 4d888adbf |

#### Step 1: One grammar, no ceilings — the identity revision {#step-1}

**Commit:** `tugways(session-identity): one dash grammar on both tiers — name:project/callsign#dash, no ceilings`

**References:** [P01] one format, [P02] hash sigil, [P03] run inside title, [P04] citation dash-free, [P05] no ceilings, Spec S02, Risk R04, (#context, #r01-atom-width, #r02-squeeze, #r04-textcontent-pins)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-session-identity.tsx` — the run structure, the title wrapper, the separator, the marker rewrite.
- `tugdeck/src/components/tugways/tug-session-identity.css` — the wrapper and dash rules, the ceiling deletion.
- `tests/app-test/at0406-masthead-dash-run.test.ts`, `tests/app-test/at0423-session-atom-dash-mark.test.ts` — rewritten pins.
- `tests/app-test/at0408-dash-gesture.test.ts`, `tests/app-test/at0417-join-mode.test.ts` — text assertions updated and `@covers` repaired ([R04](#r04-textcontent-pins)).

**Tasks:**
- [ ] In `tug-session-identity.tsx`: change the callsign span's `{" : "}` literal to `":"`.
- [ ] Wrap the name and callsign spans in `<span className="tug-session-identity-title">` per Spec S02, leaving both inner spans and their filter-highlight calls untouched.
- [ ] Rewrite `SessionDashMarker`: delete the `withName` prop and the `GitBranch` glyph; render the sigil span + name span per Spec S02; keep `className`, **`data-slot="session-identity-dash"`**, `data-review`, and the `title` sentence (`dashMarkerTitle`) on the run, move the `aria-label` onto the run, and mark the sigil `aria-hidden`. Drop the now-unused `GitBranch` import (keep `EyeOff`).
- [ ] Move the marker's mount from a sibling of `.tug-session-identity-run` to inside the run, after the title wrapper, for both tiers (the `isMissing || !dashRun` guard moves with it; `withName={!isChip}` disappears).
- [ ] In `tug-session-identity.css`: add the `.tug-session-identity-title` rule (`flex: 0 0 auto; max-inline-size: 100%; min-inline-size: 0`); restructure `.tug-session-identity-dash` per Spec S02 (drop `gap: 3px`, add the sigil rule, delete the svg rule); delete `max-inline-size: var(--tugx-session-identity-dash-max, 14ch)` from `.tug-session-identity-dash-name`; drop the callsign's `white-space: pre`; rewrite the affected comment blocks to describe the sigil grammar and the clamp-not-shrink priority mechanism (state what the CSS does — no bug history, no narration of what it used to be).
- [ ] Confirm the name and callsign runs carry no fixed-length ceilings (today they do not — the chip tier's `max-width: 100%` is a percentage clamp and stays); confirm `session-masthead.css`'s "the bound dash has no rules here" comment stays true.
- [ ] **Enumerate every consumer of the slot before rewriting any test:** `rg -n 'session-identity-dash' tests tugdeck/src` and reconcile all four app-tests it names. at0408 asserts the run's `textContent` equals a bare dash name twice, at0417 once (plus an absence assertion that survives untouched); update each to the `#`-prefixed spelling.
- [ ] Add `@covers tugdeck/src/components/tugways/tug-session-identity.tsx` to at0408 and at0417 so the next identity change selects them; verify with `just app-test-covers-check`.
- [ ] Rewrite at0406's pins: the title reads `<name>:<project>/<callsign>#<dash>` with no spaces around `:` and no svg inside the dash run; a dash name longer than 14 characters renders unelided in a roomy masthead (compare `scrollWidth` against `clientWidth` on `.tug-session-identity-dash-name`, so the assertion fails for the right reason rather than on a substring); the review tint and unbind round-trip pins keep their mechanism.
- [ ] Rewrite at0423's atom-face pins: the chip now carries the `#<name>` run (text, no svg); the citation-byte-identical assertion and the unbind round trip stay as they are.

**Tests:**
- [ ] at0406 — the new grammar on the line tier, the unelided-with-room assertion, review tint, unbind round trip.
- [ ] at0423 — the new grammar on the chip tier, citation unchanged, unbind round trip.
- [ ] at0408, at0417 — their existing dash-run assertions, updated to the new spelling and still passing for their original reasons.
- [ ] Existing unit suites still green (`session-identity.test.ts` pins `sessionTitleParts`/`sessionCitation`, whose APIs do not change).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0406-masthead-dash-run.test.ts tests/app-test/at0423-session-atom-dash-mark.test.ts tests/app-test/at0408-dash-gesture.test.ts tests/app-test/at0417-join-mode.test.ts`

---

#### Step 2: The Lens dash line moves inside the session row {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(lens): the dash facts become an indented line inside the session row; the dash-subrow row kind is deleted`

**References:** [P06] row-internal line, [P07] title suppression, Spec S01, (#r03-subrow-consumer, #state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-session-row.tsx` / `.css` — the `dashLine` slot and its line rule.
- `tugdeck/src/components/lens/sections/cards-session-cell.tsx` — the `LensSessionDashLine` leaf, mounted via the new slot.
- `tugdeck/src/components/lens/sections/cards-data-source.ts`, `cards-section.tsx`, `cards-section.css` — the sub-row machinery, deleted.
- `tugdeck/src/components/lens/sections/__tests__/cards-data-source.test.ts` — the sub-row describe rewritten.
- `tests/app-test/at0424-lens-dash-subrow.test.ts` → renamed `at0424-lens-dash-line.test.ts`, rewritten to pin the in-row line.

**Tasks:**
- [ ] `tug-session-row.tsx`: add `dashLine?: React.ReactNode` to `TugSessionRowProps` (documented as the dash facts line, Lens-only today) and **destructure it in the component's parameter list** — `{...rest}` is spread onto `TugListRow`, so an undestructured prop reaches the DOM as an unknown attribute and React warns at every row. Render it per Spec S01 after the `TugPulse` mount. `tug-session-row.css`: the `.tug-session-row-dashline` rule per Spec S01 — the derived indent, muted ink, no band of its own, no tape reserve, no `:has()`.
- [ ] `cards-session-cell.tsx`: add `LensSessionDashLine({ sessionId })` — `useDashForSession`, null when unbound, else `#${dash.name}` + stage + steps + review through `DashFactsRun` with a local mark-size constant; pass `dashLine={<LensSessionDashLine sessionId={tugSessionId} />}` from `CardsSessionRow` (flows through `SessionIdentityRow`'s `...rest`; keep `dashRun={false}`).
- [ ] `cards-data-source.ts`: delete the `dash-subrow` union member, its `kindOfRow` and `idOfRow` branches, and the emission block after the pane row; keep `dashFor` and the dash-name filter match field; update the module docs.
- [ ] `cards-section.tsx`: delete `DashSubrowCell`, its `CARDS_CELL_RENDERERS` entry, `DASH_SUBROW_GLYPH`, and the `GitBranch` import if now unused. `cards-section.css`: delete `.lens-cards-dash-subrow` and `.lens-cards-dash-glyph`.
- [ ] `cards-data-source.test.ts`: rewrite the `dash sub-rows` describe — the row list never contains a dash row kind for a bound session; the dash-name filter match still surfaces the pane; the debug-print helper drops its dash branch.
- [ ] Rewrite at0424 on the same real fixture flow (`tugutil dash bind` via the `$` shell route): the session's list row contains `[data-slot="tug-session-row-dashline"]` carrying the `#name` spelling and the stage; the line is a descendant of the session's own row element rather than a row of its own (assert containment, which is the structural claim the redesign makes); the title run stays suppressed; unbind removes the line and restores the title's run.
- [ ] Rename the file to `at0424-lens-dash-line.test.ts` — "subrow" names a concept this step deletes, and nothing outside the file references the old name (verified: only this plan does). Add `@covers tugdeck/src/components/tugways/tug-session-row.tsx` alongside its existing four, and keep the `cards-*` covers, which still resolve.
- [ ] Sweep: `rg -n 'dash-subrow|lens-cards-dash-subrow|DASH_SUBROW_GLYPH' tugdeck tests` returns nothing.

**Tests:**
- [ ] at0424 — the in-row line, its facts, the containment pin, the unbind round trip.
- [ ] `cards-data-source.test.ts` — no dash row kind; filter-by-dash-name preserved.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test tests/app-test/at0424-lens-dash-line.test.ts`

---

#### Step 3: Integration checkpoint — every dash-identity surface in one invocation {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [P01] one format, [P06] row-internal line, Risk R04, (#success-criteria)

**Tasks:**
- [ ] All five rewritten app-tests green in one invocation, plus whatever else `just app-test-select` derives from the working diff via `@covers` (with Step 1's repair, that derivation now reaches at0408 and at0417 on its own — confirm it does, since that is the durable half of [R04](#r04-textcontent-pins)).
- [ ] Frontend gates green across the whole tree: `tsc`, the full `bun test`, `vite build`.

**Tests:**
- [ ] The aggregate run below.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0406-masthead-dash-run.test.ts tests/app-test/at0423-session-atom-dash-mark.test.ts tests/app-test/at0424-lens-dash-line.test.ts tests/app-test/at0408-dash-gesture.test.ts tests/app-test/at0417-join-mode.test.ts`
- [ ] `just app-test-select` — confirm at0408 and at0417 appear in the derived selection
- [ ] `just app-test-changed`
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One dash-identity grammar — `custom-name:project/callsign#dash-name` — worn identically by the masthead, the atom, and every identity surface, eliding only under real width pressure; and the Lens showing a session's dash as an indented line inside the session's own row.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Both tiers render the identical format, spaces deleted, sigil `#` (at0406 + at0423).
- [ ] No fixed-length ceiling on any identity run; a 21-char dash name renders whole with room, measured rather than pattern-matched (at0406).
- [ ] The `dash-subrow` row kind does not exist; the dash facts render inside the session row, indented, same band (at0424 + `cards-data-source.test.ts` + the grep sweep).
- [ ] `sessionCitation` byte-identical across bind/unbind (at0423).
- [ ] Every app-test that selects `session-identity-dash` passes, and every one of them declares `@covers` on the identity component (`just app-test-covers-check`, plus the Step 1 sweep).
- [ ] All checkpoints in Step 3 green.

**Acceptance tests:**
- [ ] at0406, at0423, at0424, at0408, at0417 in one invocation, green.
- [ ] `just app-test-changed` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The Join sheet hunt — deliberate lifecycle exercise in the release instance with a live dash ([report §4](dash-ui-report.md#join-sheet)).
- [ ] The Z4A join-mode pass, including the doubled squash-subject prefix.
- [ ] Entry points into dash workflows.

| Checkpoint | Verification |
|------------|--------------|
| One grammar, both tiers | at0406 + at0423 |
| No premature truncation | at0406's roomy-masthead assertion |
| In-row Lens line | at0424 + grep sweep |
| Whole-tree health | Step 3's aggregate commands |
