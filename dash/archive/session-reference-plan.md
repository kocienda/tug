<!-- devise-skeleton v4 -->

## Session Reference — one identity, one resolver, one component family {#session-reference}

**Purpose:** Make Tug refer to a session the same way everywhere: one structured identity record produced by one resolver, rendered by one component family (`TugSessionIdentity`) at declared density tiers, with a text-only citation form, a fork-lineage grammar, a rolling generated description (the synopsis), and the nine data-layer repairs the surfaces depend on.

This plan implements `dash/session-reference-brief.md` (design complete; every question there is decided). The visual reference is running code: the gallery spike card `tugdeck/src/components/tugways/cards/gallery-session-identity.tsx` / `.css` (Component Gallery ▸ Feedback ▸ "Session Identity"). Read both before implementing. Nothing in the spike's CSS is inherited by the app — it is scaffolding to be replaced by tokens, never copied.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | vetted |
| Target branch | main |
| Last updated | 2026-08-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug names sessions in at least seven forms across at least fifteen surfaces, with five near-parallel precedence rules and no shared component. The audit is in the brief; the load-bearing facts, verified against the code as of this writing:

- **Five parallel precedence rules, no two identical:** `sessionChipDisplay` (orphaned since the Z4B diet), `sessionRowTitle`, `sessionEntryTitle` (a hash-equality sniff) — all in `tugdeck/src/lib/session-name.ts`; Rust `session_row_title` (no tag arm) and `session_display_name` in `tugrust/crates/tugcast/src/feeds/changeset.rs` (~line 724 / 755).
- **The title-string composer** is `sessionCardTitleOverride` in `tugdeck/src/lib/session-card-title.ts` — it appends a `(branch)` suffix off-`main` and is consumed by the Session card and the Lens (`cards-data-source.ts` `sessionLabel`).
- **The 8-char short id is computed independently in three places** (`session-name.ts` `SESSION_ID_TRUNCATE`, and twice in `changeset.rs`), never stored.
- **The tab strip shows the literal registry title "Session"** for a stacked Session card: `tug-tab-bar.tsx` gates its `cardTitleStore` consult on `tab.componentId === "text"` (~line 445).
- **The Gazette ref chip prints the full 36-char UUID**: `RefChip` in `tugdeck/src/components/gazette/gazette-card.tsx` labels via `target.split("/").pop()`, a no-op on a UUID.
- **Commit trailers are raw body ink**: `Tug-Session: <display> (<full-uuid>)` is written by `session_trailer()` (`tugrust/crates/tugdash-core/src/ops.rs` ~line 812) and by the changeset commit path fed from `changes-route-controller.ts` (~line 269), and the History card renders it unparsed. Only `Tug-Dash:` has a typed field (`GitLogCommit.tug_dash`, `tugrust/crates/tugcast-core/src/types.rs` ~line 193, parsed in `tugrust/crates/tugcast/src/feeds/git.rs` via `%(trailers:key=Tug-Dash,...)`).
- **External sessions fake a tag**: `deriveStableTag` (`session-tag.ts`) synthesizes a non-unique display tag, used by `session-picker-data-source.ts` and `session-picker-cells.tsx`.
- **Fork silently mints an unrelated fresh id**: the rewind-fork path in `tugcode/src/session.ts` (~line 7337) mints `crypto.randomUUID()` and the ledger row/tag stay behind on the old id.
- **Tag mint machinery**: client mint in `session-tag.ts` (`mintTag`, 512×1024 lexicon in `session-tag-lexicon.ts`), server claim-or-suffix in `tugrust/crates/tugcast/src/session_ledger.rs` (`record_spawn` ~line 2353, `tag_base` ~line 4909, `TAG_SUFFIX_CAP`); suffix exhaustion silently lands a NULL tag (~line 2412).

Root cause: [D123] ("a pane's name is one string produced in one place", `lib/pane-title.ts`) was never extended to session identity. This work is [D123] applied to the session.

#### Strategy {#strategy}

- **Data layer first.** The Rust repairs (tag arm, mint hardening, external backfill, live ai-title, fork lineage, trailers) unblock the client work and are independently landable.
- **Resolver before components — and the hook with the resolver.** `resolveSessionIdentity` consolidates the five rules and deletes them; every later step consumes it, so it lands before any pixel moves. `useSessionIdentity` ships in the same commit, because a resolver that reads stores imperatively is a stale-render bug waiting for its first consumer ([L02], Spec S01).
- **Component before surfaces.** `TugSessionIdentity` (chip/line tiers, then row, then masthead) ships with its tokens and the session color; surfaces then adopt tier by tier.
- **The masthead and the strip removal are one arc**: the masthead lands carrying the PULSE, then the Z2 strip comes out with every one of its owned behaviors re-homed in the same step range — never a window where the voice speaks in two places or in none.
- **Run the steps in numeric order** — there is no separate landing order to remember. One ordering constraint inside that is load-bearing and easy to undo by accident: the masthead (#step-11) and the strip removal that must follow it (#step-12) come **before** the clipboard (#step-13) and row (#step-14) work. #step-9 replaces `sessionCardTitleOverride` (today name → tag, with **name winning**, so a renamed session's title bar reads `project/<name>`) with `sessionIdentityLine` (`project/<tag>`, [P04]/[P08]), and nothing shows that session's name again until the masthead's description line arrives. Neither #step-13 nor #step-14 is on anyone's critical path, so they wait; ordered the other way, `main` carries four commits in which a `/rename` has no visible effect anywhere in the app.
- **The synopsis is last among features** — it rides existing `SharedAgent` infrastructure and only changes what the description *line* says; every surface renders correctly before it exists (honest empty line).
- **Doctrine closes the phase**: the D-number entry, the pane-model masthead amendment, and the lineage grammar are written once the shipped shapes are final.

#### Success Criteria (Measurable) {#success-criteria}

- `git grep -n "sessionChipDisplay\|sessionRowTitle\|sessionEntryTitle\|deriveStableTag"` in `tugdeck/src` returns no production call sites (tests of the resolver excepted). (Verify by grep.)
- Every surface in **Table T02** renders identity through `resolveSessionIdentity` + `TugSessionIdentity` (or `paneTitleBarTextFor` for pane chrome); no surface composes `project/tag` strings ad hoc. (Verify by grep for `"/" +`-style composition at the named sites and by the app-tests in each adoption step.)
- The tab strip shows `project/callsign` for a stacked Session card. (App-test.)
- The Gazette ref chip never shows a UUID. (App-test.)
- A commit made from the Changes card carries both `Tug-Session: <tag> (<shortid>)` and `Tug-Session-Id: <uuid>` trailers, the History card renders the citation chip beside the SHA, and neither trailer line appears in the rendered body. (Rust unit test + app-test.)
- A fork's tag is `<root>-<Letter><Number>`, recorded in the ledger, and the original session keeps its tag. (Rust unit test + tugcode test.)
- No mint path can land a NULL tag; the ledger's bare-`-N` suffix path is gone. (Rust unit tests.)
- A trashed session's tag is **never** re-minted for a different session. (Rust unit test over the trash and cascade-delete paths — Spec S08.)
- A `/rename` repaints every live surface showing that session with no reload. (App-test — the [L02] hook contract, Spec S01.)
- No component calls `resolveSessionIdentity` directly. (Verify by grep over `tugdeck/src/components`.)
- The `atom` slot's `session` tone is authored in all six themes **and registered in `ELEMENT_SURFACE_PAIRING_MAP`**, so `bun run audit:theme-contrast` actually resolves and gates it. (Verify by inverting one value and confirming the audit fails — #step-8.)
- `cd tugrust && cargo nextest run` green; `bunx vite build` green; `just app-test-changed` green at each step.

#### Scope {#scope}

1. `resolveSessionIdentity` resolver + the `useSessionIdentity` subscription hook; deletion of the five parallel rules.
2. `TugSessionIdentity` component family (chip / line / row / masthead tiers), the `SessionMasthead` the pane mounts, and their tokens.
3. The `session` tone on the `atom` slot, authored in the six theme files and registered in the contrast pairing map.
4. `TugSessionRow` growth to the four-line identity stack; picker and Lens adoption.
5. The masthead tier in `TugPane`; `--tug-masthead-height`; the telemetry placard.
6. Removal of the Z2 `SessionPulseStrip` with every owned behavior re-homed.
7. The synopsis job on `SharedAgent`'s Summarize lane, with persistence and `/rename` precedence.
8. The citation flat-text form; commit-trailer write and read paths; History card rendering.
9. The session atom as a real Tug atom: clipboard flavors + wire marker.
10. Fork lineage grammar carried through spawn and ledger; the `minted_tags` all-time arbiter and mint hardening; external-session tag backfill; live `ai-title` capture; tag arm in the Rust feed.
11. `tag → session_id` resolution and `/resume <tag>`.
12. Adoption at every surface in Table T02.
13. The doctrine entry and companion tuglaws updates.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Phase 2 annotator pattern-matching** for citations in free prose. Deferred; prerequisites recorded in the brief (the commit-SHA detector hex collision — `detect-commit-sha.ts` matches 7–40 hex with a digit, so the session detector must claim the whole `<tag> (<hex>)` run first — and the History card sitting outside any `AnnotationScope`).
- **Mastheads for non-session cards.** The mechanism generalizes (structured `cardTitleStore` payload), but nothing else adopts it here.
- **The Z2 status row** (STATE / TIME / TOKENS / CONTEXT / WORK): content, layout, position, and tokens all stay exactly as they are. Removing the PULSE row beneath it is the only change in that region; any resulting seating difference against the prompt entry is corrected with spacing alone.
- **`/retag`** — the tag is immutable.
- Per-session tint — **retired, do not re-propose** (see [P05]).

#### Dependencies / Prerequisites {#dependencies}

- The gallery spike card (`gallery-session-identity.tsx` / `.css`, registered in `gallery-registrations.tsx`) — the visual reference; it stays alive through the work as the fixture bench.
- Existing components composed, never re-rolled: `CardTitleBar` / `TugPane` (`components/chrome/tug-pane.tsx`), `TugPulse` (`tug-pulse.tsx`, `layout="inline"`, `trailing` accessory, published knobs `--tugx-pulse-bar-height` / `--tugx-pulse-baseline`), `TugSessionRow` (`tug-session-row.tsx`, `inset` fit), `TugProgressIndicator` (`variant="pulsing-dot"` with `sessionSessionPhaseVisual`), `TugPlacard`, `TugLabel` (middle truncation), `TugCopyBadge`.
- `SharedAgent` (`tugrust/crates/tugcast/src/shared_agent.rs`): `JobClass::{Classify, Summarize}`, the headline register macro `headline_rules!` (~line 1288), `SUMMARIZE_INSTRUCTIONS`.
- Clipboard/atom machinery: `lib/tug-native-clipboard.ts` (`writeClipboardViaNative(text, atoms)`, `dev.tug.prompt-atoms` sidecar), `lib/atom-mention-marker.ts` (`wrapAtomMention`, `parseAtomMentionSegments`).
- Trailer machinery: `tugchanges_core::append_trailers` (`tugrust/crates/tugchanges-core/src/trailer.rs`).

#### Constraints {#constraints}

- Rust workspace: **warnings are errors** (`-D warnings`).
- `changes.db` schema changes require bumping `CHANGES_SCHEMA_VERSION` with a registered migration. `sessions.db` (per-instance) uses the self-healing `ALTER TABLE` pattern (`migrate_sessions_add_name_user_set`, `session_ledger.rs` ~line 2046) — follow it for new columns; new *tables* go in the CREATE batch (`CREATE TABLE IF NOT EXISTS`, the pattern `external_scan_cache` uses). Every writable ledger open goes through `tugcore::ledger_db` (`no_ad_hoc_ledger_opens` test).
- **`minted_tags` is append-only** (Spec S08). No trash, cascade-delete, or eviction path may delete from it; that is what makes [P12]'s "never recycle" true rather than aspirational.
- Tugdeck laws: [L02] external state via `useSyncExternalStore` only; [L06] appearance via CSS/DOM; [L19] `.tsx`/`.css` pairs with `data-slot`; [L20] token sovereignty — compose `TugPulse` through its published knobs, never reach inside. Read `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/component-authoring.md` before tugdeck steps and name the laws in commits.
- Theme tokens are hand-authored in `tugdeck/styles/themes/{brio,nocturne,bravura,harmony,aria,vivace}.css`; validate with `bun run audit:theme-contrast` (no theme may exceed the `brio` budget).
- Verify tugdeck changes with `bunx vite build`; app-tests via `just app-test-changed` (`@covers` headers mandatory on new tests); Rust tests via `cd tugrust && cargo nextest run`.
- Never hand-roll UI that exists as a `Tug*` component; borrowing its CSS is still hand-rolling.
- tugcode is a compiled binary — rebuild it after `tugcode/src` changes; Rust changes need `just build-app` before app-tests exercise them.

#### Assumptions {#assumptions}

- The spike card's measured geometry (Table T01) is final; it was measured in the running app, not estimated.
- `--tug-masthead-height: 72px` is **RATIFIED** — fixed, never content-driven.
- The tag lexicon (`session-tag-lexicon.ts`) is large enough (512 × 1024); growth is opportunistic and out of scope.
- Legacy commits carrying the old one-line `Tug-Session: <display> (<full-uuid>)` trailer exist in history forever and must parse gracefully (Spec S03).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton conventions (`tuglaws/devise-skeleton.md`): explicit `{#anchor}` headings everywhere a later citation lands (kebab-case, no phase numbers); stable two-digit labels — plan-local decisions `[P01]`, open questions `[Q01]`, specs `Spec S01`, tables `Table T01`, lists `List L01`, risks `Risk R01` — never reused (deletions leave gaps); `**Depends on:**` lines citing step anchors (`#step-N`); and `**References:**` lines on every execution step citing plan artifacts by label and anchor, never by line number. `[D##]` citations refer to the global `tuglaws/design-decisions.md`. File line numbers quoted in prose (e.g. "~line 2353") are investigation aids current as of the Last-updated date — locate by the named symbol, not the number.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Synopsis re-run trigger (DEFERRED to implementation tuning) {#q01-synopsis-trigger}

**Question:** What re-runs the synopsis — turn count, elapsed time, or a topic-shift signal?

**Why it matters:** Too eager burns Haiku calls and strobes the line; too lazy leaves a stale description, which is the exact failure the incipit was retired for.

**Options:** piggyback on the session-overview emit cadence (the PULSE headline's existing trigger, `EMIT_FLOOR` 8s floor in `feeds/session_overview.rs`) at a lower rate, e.g. every N completed turns; or a debounced turn-boundary trigger.

**Plan to resolve:** The brief deliberately leaves this to be tuned against real output. Step 15 starts from "on turn completion, debounced, no more than once per 60s" and tunes in-app. **Resolution: DEFERRED** into #step-15's checkpoint; the shipped constant gets a doc comment stating the tuning rationale.

#### [Q02] Where the synopsis persists (DECIDED here) {#q02-synopsis-persistence}

**Question:** Where does the synopsis survive reload without a re-run?

**Resolution: DECIDED** — a `synopsis TEXT` column on the `sessions` table in `sessions.db`, added by a self-healing `ALTER TABLE` migration (the `name_user_set` pattern). It rides `SessionRow` on the wire beside `name`/`tag`. Rationale: the description is per-session ledger state exactly like `name`; the client must never invent it; tugbank defaults are the wrong shape (they are per-user knobs, not per-session data). Recorded as [P07].

#### [Q03] Where the strip's focus stop lands (DECIDED here) {#q03-focus-stop}

**Question:** The Z2 strip's PULSE label registers a `useFocusable` leaf (`SESSION_CYCLE_ORDER_PULSE`) in the card's cycle. Chrome is the Pane's ([L09]), so a stop moving into the masthead crosses an ownership boundary.

**Resolution: DECIDED** — the stop is **retired**, not moved. The masthead's PULSE line is chrome and takes no card-cycle focus stop; the telemetry placard widget is the masthead's one interactive affordance and participates as pane-chrome control like the close button, not in the card's cycle. `SESSION_CYCLE_ORDER_PULSE` and its `CycleScope` registration are deleted with the strip — no dangling order entry. Recorded in [P09]. If review during #step-12 finds a real keyboard path lost, reopen there with the keyboard-focus-nav subsystem's owner (that subsystem is tabled; propose no new chords).

#### [Q04] Where an external session's backfilled tag lives (DECIDED here) {#q04-external-tag-storage}

**Question:** [P12] mints a real tag for an external session at scan time. External rows have **no `sessions` row** — they are synthesized from `external_scan_cache` with `state: "closed"` / `card_id: null` and only adopt into the ledger on first resume, which is exactly what `SessionRow.provenance` (`"tug"` vs `"external"`) reports. `external_scan_cache` has no `tag` column, and `sessions_tag` indexes only `sessions`. So there is nowhere to put the tag and nothing to make it unique.

**Why it matters:** the obvious shortcut — create a `sessions` row at scan time — silently flips every discovered session from `external` to `tug` provenance, changing what the picker shows and when adoption happens. That is a behavior change smuggled in under a naming fix.

**Resolution: DECIDED** — add `tag TEXT` to `external_scan_cache` and let **`minted_tags` ([P12], Spec S08)** carry uniqueness, which it can because it is keyed by tag and indifferent to which table holds the session. Provenance is untouched: the row stays external until first resume, and adoption carries the already-minted tag onto the `sessions` row rather than minting a second one (`record_spawn` receives it as the candidate; `minted_tags` already holds it for that `session_id`, so the re-insert is a no-op rather than a collision — the mint's retry path must distinguish "this tag is mine" from "this tag is taken"). Recorded in Spec S08 and implemented in #step-3.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Identity resolves but never re-renders | high | high (it is the default failure of an imperative resolver) | `useSessionIdentity` is the only React entry point (Spec S01); grep gate + a rename app-test | any surface showing a stale name |
| A trashed session's tag is re-minted | high | low per event, certain over time | append-only `minted_tags` as the all-time arbiter (Spec S08) | a citation resolving to the wrong session |
| Masthead height breaks geometry math | high | med | one fixed token + mirrored JS constant + pane-scoped `--tugx-pane-chrome-height` re-pointing the four Risk R01 sites (tab bar and the sheet's standalone fallback excluded) | any layout that measures chrome |
| Strip removal drops a pacing behavior | med | med | explicit re-home inventory (List L01) walked in #step-12 | a PULSE line that strobes or a dead compaction stretch |
| TS/Rust lexicon drift | med | low | generated Rust lexicon + drift test reading the TS source (Spec S05) | lexicon edits |
| Legacy trailer breaks History parse | med | high (legacy commits are everywhere) | Spec S03 legacy grammar; unit tests over both forms | any unparsed `Tug-Session` ink in History |
| Synopsis quality (labels, staleness) | med | med | reuse the PULSE headline register rules verbatim; `/rename` freeze | tuning in #step-15 |
| Identity hook over-subscribes and wakes every surface | med | med (it is the easy way to write it) | by-id getters only, and no phase in the record ([P15], Spec S01) | any identity surface re-rendering on transcript traffic |
| Chrome swap remounts the content region | high | **precluded** — cards portal into an empty `.tug-pane-content`; there is no card subtree for a chrome branch to re-key (Risk R04) | keep the sibling discipline and the one scroll-survival assertion, which pins the invariant rather than guarding a live hazard | anyone moving the pane off portaled content |
| A post-fork commit cites the parent session | high (a wrong-but-resolvable citation) | med — every commit from a forked card, once forks are used | **not mitigated in this phase**: recorded as Risk R05 and a Phase-C follow-on; the trailer grammar is right, its subject is stale env | a citation chip naming a session the user did not commit from |

**Risk R01: Masthead height regressions** {#r01-masthead-height}

- **Risk:** Surfaces that assume 36px chrome mis-measure a 72px masthead. The JS side is small — exactly two consumers of `CARD_TITLE_BAR_HEIGHT` (`tug-pane.tsx` ~line 87 and `TITLE_BAR_VISIBLE_MIN_Y` ~line 825). The real fan-out is the CSS token `--tug-chrome-height`, and the inventory is **eight sites in four files**, not three — **four re-pointed, four left alone**. Each is classified — this table is the #step-11 worklist:

| Site | What it is | Disposition |
|---|---|---|
| `tug-pane.css` ~257–258 | `.tug-pane-title-bar` `height` / `min-height` | **re-point** — this is the bar that *becomes* the masthead; every other row here is downstream of it |
| `tug-pane.css` ~610 | pane scrim `top` | **re-point** — at 36 it dims the masthead's bottom half, telemetry placard included, whenever a sheet is up |
| `tug-sheet.css` ~63 | sheet panel `top` | **re-point** — the Changes sheet lives on the Session card |
| `tug-sheet.css` ~133 | sheet `max-height: calc(100vh - var(--tug-chrome-height) - 32px)` | **leave** — its own comment says it: "Fallback cap for the **standalone (no-pane)** case; in a pane the JS clamp overrides this with an inline `max-height`". That clamp (`tug-sheet.tsx` ~995) computes `bottomLimit - SHEET_CANVAS_GAP - clip.getBoundingClientRect().top - marginTop` — a **measured** clip top, which already moves once the clip's `top` (~63) is re-pointed. Re-pointing this line would be worse than a no-op: the standalone case has no pane, so a pane-scoped `--tugx-pane-chrome-height` is undefined there and the whole `calc` drops |
| `tug-pane-banner.css` ~59 | banner `top` (`var(--tug-chrome-height, 36px)`) | **re-point** — the Session card mounts `TugPaneBanner` via `session-card-banner-spec.ts`; carry the fallback across as `36px` |
| `tug-tab-bar.css` ~86 | tab bar row `height` | **leave** — a tab is 36px whatever the title bar does |
| `tug-tab-bar.css` ~286 | a square control's `width` | **leave** — the token is being used as a square-button metric, not a chrome offset |
| `tug-tab-bar.css` ~367, ~402 | drag ghost height, drop-target `min-height` | **leave** — both must match the tab row, not the masthead |

  **The masthead and the tab bar stack; they do not merge.** A multi-tab Session pane's chrome is **72 + 36 = 108px**: masthead on top, tab row beneath it, unchanged. Anything re-pointed above measures *the title-bar tier only*, which is why the four `tug-tab-bar.css` sites stay on `--tug-chrome-height` — re-pointing them would give a masthead pane 72px-tall tabs.
- **Mitigation:** `--tug-masthead-height` declared identically in all six themes (and `tugdeck/src/generated/tug-token-names.ts` regenerated — see #step-8); a `MASTHEAD_HEIGHT = 72` JS constant beside `CARD_TITLE_BAR_HEIGHT = 36` (`tug-pane.tsx` ~line 87); a pane-scoped `--tugx-pane-chrome-height` published on the `.tug-pane` element — `var(--tug-masthead-height)` when the masthead is up, `var(--tug-chrome-height)` otherwise — with the four **re-point** rows above pointed at it in #step-11; the masthead never reflows (overflow truncates via `TugLabel`). Note the sheet needs only its **clip top** re-pointed — the panel's in-pane height falls out of the measured clip rect for free, which is why the `max-height` fallback stays put.
- **Residual risk:** app-tests with hard-coded chrome offsets on the Session card; fix as they surface via `just app-test-changed`.

**Risk R02: The strip owns more than a line of text** {#r02-strip-behaviors}

- **Risk:** The dwell queue, compaction pin, `pulse/enabled` behavior, sparkline pairing, and focus stop silently die with the strip.
- **Mitigation:** List L01 is the re-home inventory; #step-12's checkpoint walks it item by item; the dwell queue moves as code, not a rewrite.
- **Residual risk:** `TUG_SESSION_ROW_SPARK_WIDTH`/`_HEIGHT` docstrings reference the strip's constants — they must be re-pointed, not orphaned.

**Risk R03: History filter/regression on stripped bodies** {#r03-history-body}

- **Risk:** Stripping trailer lines from the displayed body changes what the History filter matches.
- **Mitigation:** strip only `Tug-Session:` / `Tug-Session-Id:` (and keep `Tug-Dash:` stripping consistent with them); the typed fields remain filterable server-side later; unit-test the stripper on bodies with interleaved trailers.
- **Residual risk:** none meaningful — the trailer text was never useful filter ink.

**Risk R05: `TUG_SESSION_ID` is not fork-aware, so a post-fork commit cites the parent** {#r05-fork-env-identity}

- **Risk:** The shell route exports `TUG_SESSION_ID = tug_session_id` once, at shell-spawn time (`feeds/shell.rs`), and `session_citation()` (`tugdash-core/src/ops.rs`) resolves the committing session from it. Ledger rows are keyed by **claude's** session id. The two coincide for a plain fresh spawn — tugcode claims the tug id via `--session-id` — and diverge after a rewind fork or a claude id rotation, because the fork respawns inside the same relay and the same shell keeps the env it was born with. A dash-lane commit made from a forked card therefore writes the **parent's** citation and the parent's `Tug-Session-Id`.
- **Why it matters more now than it did before:** the same mismatch used to cost a slightly wrong display name in a trailer nobody parsed. After #step-6 / #step-7 the trailer is typed, joined against the ledger, and rendered as a citation chip — so the failure mode is no longer a stale label but a **confidently wrong reference**, resolving cleanly to a real session that did not make the commit. [P12] names that outcome as strictly worse than [P13]'s unresolvable atom, which is the argument for treating this as real rather than cosmetic.
- **Scope, honestly:** pre-existing, out of Phase A's scope, and it needs no citation-grammar change — the citation is right, its *subject* is wrong. It is also the same root cause as the #step-4 auto-title keying bug (a ledger write keyed on the tug id), which was fixed there by reading `entry.claude_session_id`; the env cannot be fixed the same way because it is captured once per shell rather than read per write.
- **Disposition: a Phase-C item, recorded not fixed** (#roadmap). Two shapes to weigh when it is picked up: re-export the env on the shell when a fork rebinds the card→session binding (narrow, but the shell may be mid-command), or give the ledger a `tug_session_id → current claude id` alias every resolver goes through (wider, and it also repairs `tugutil changes`, `tugutil draft`, and `host ask`, all of which resolve sessions the same way). The second is probably right precisely because the list of callers is longer than this plan.
- **Trigger to revisit:** any citation chip naming a session the user did not commit from; any `Tug-Session-Id` that joins to a row whose `tag` disagrees with the same commit's `Tug-Session`.

**Risk R04: The 36↔72 swap costs the content region its mount identity — precluded by the pane's existing structure** {#r04-mount-identity}

- **The hazard in the abstract:** [P14] makes chrome height a function of the active tab, so `TugPane` renders a masthead slot on one tab and a one-line bar on the other. A conditional subtree *around* the content region — or a key folding in the chrome mode — would remount both cards on every tab switch: transcript scroll, CM6 editor state, and every registration reset. [L26] is explicit that logically-continuous mounts must not be torn down, and this is exactly a logical continuity (the card did not change; the chrome above it did).
- **Why it cannot happen here:** the pane is **already** the shape the mitigation would ask for, and cards are not in the branch at all. `tug-pane.tsx`'s render puts `CardTitleBar` and `.tug-pane-body` as **siblings** under `.tug-pane-chrome`, and `.tug-pane-content` is an **empty `ref`'d div** — cards portal into it rather than mounting as React children of the pane. A chrome-mode branch therefore has no card subtree to reparent or re-key; producing this failure would require re-architecting the pane away from portaled content first. Keep the discipline anyway (the chrome slot is a sibling; nothing in the content region's key derives from chrome mode; height travels as `--tugx-pane-chrome-height`, a CSS custom property, [L06]) — it costs nothing and states the invariant the structure is relying on.
- **Disposition:** **not a risk to mitigate — an invariant to pin.** The scroll-survival app-test in #step-11 stays: it is one cheap assertion, and it converts "the pane portals its content" from an implementation detail somebody could refactor into a stated contract with a failing test behind it.

---

### Design Decisions {#design-decisions}

> These transcribe the brief's decision register into plan-local decisions so steps can cite them. Nothing here is open; the brief is the authority, and rejected alternatives marked *do not re-propose* there stay rejected.

#### [P01] Two registers, one identity (DECIDED) {#p01-two-registers}

**Decision:** Presence — a surface that *is* the session (masthead, picker row) renders the callsign as typography: chatbox icon (`MessageSquare`), bold sans, no enclosure. Citation — a surface that *refers* to a session from foreign context wraps the same identity in the session atom (a rounded pill). The title bar is never a citation.

**Rationale:** An enclosed chip reads as a link to the thing elsewhere; on a surface that is the thing, that reading is a lie.

**Implications:** `TugSessionIdentity` takes a register/tier, never a format; the phase dot is row furniture and never rides a citation.

#### [P02] One resolver, one structured record (DECIDED) {#p02-one-resolver}

**Decision:** `resolveSessionIdentity(sessionId) → { project, branch, tag, lineage, title, state, id, shortId }` grows from `session-card-title.ts`, absorbing and deleting `sessionChipDisplay`, `sessionRowTitle`, `sessionEntryTitle`, and the hash sniff. The Rust changeset feed grows a tag arm so the client never re-derives. No surface composes identity strings itself.

**Rationale:** [D123]'s `composePaneTitleBarText` proved consolidation before change; five parallel rules is the disease being cured.

**Implications:** `session-name.ts` shrinks to nothing or dies; consumers (picker cells, Lens cell/data source, Session card, Z4B remnants) re-point in one step.

#### [P03] Density tiers, not formats (DECIDED) {#p03-density-tiers}

**Decision:** Four tiers — **Chip** (atom; hover → full identity via `TugPlacard`; click → raise/open), **Line** (`project/callsign` + optional truncated title), **Row** (four-line identity stack), **Masthead** (top three lines in card chrome). Surfaces choose a tier.

**Implications:** Consumers per Table T02.

#### [P04] Callsign typography: one bold run (DECIDED) {#p04-callsign-run}

**Decision:** Always `<project>/<callsign>` as a single bold sans run — one face, one weight, one color, **one text node**. Never monospace in session chrome. The mark is the chatbox icon; the icon gap is one token (`--tugx-session-identity-icon-gap`), identical in both registers and at every tier.

**Rationale:** Two spans opened a gap after the slash and truncated independently (`tugto… syrupy-beam`); mono belongs to flat text only.

#### [P05] One theme-authored session color (DECIDED) {#p05-session-color}

**Decision:** A **`session` tone on the existing `atom` slot** of the seven-slot token system — four authored values per theme, hue-seeded from the `agent` family's violet:

```
--tug7-surface-atom-primary-normal-session-rest   /* ground */
--tug7-element-atom-border-normal-session-rest    /* border */
--tug7-element-atom-text-normal-session-rest      /* ink    */
--tug7-element-atom-icon-normal-session-rest      /* icon   */
```

authored as `--tug-color(violet, l: …, c: …[, a: …])` recipes like every peer entry. Per-session hashed tint is **retired — do not re-propose** (color is a semantic channel; a hashed hue reads as meaning while meaning nothing).

**Rationale:** the slot already exists, already carries a non-default tone, and already carries this exact quartet. Read the two precedents precisely, because they are not the same shape: the **`default`** tone is the one authoring all four roles — ground, border, ink, **and icon** (`--tug7-element-atom-icon-normal-default-rest`) — so the quartet is a shape the slot already supports; the **`route`** tone (indigo-violet, beside `default` / `selected` / `highlighted`) is the precedent for a *non-default tone living here at all*, and it authors a **triplet** — ground, border, ink, no icon — because a route atom paints no icon. The session atom does paint one (`MessageSquare`, [P01]), so it takes `default`'s four roles at `route`'s precedent. And [P06] says the session atom **is** a real Tug atom, so this is the slot it belongs in. The rejected alternative was a bespoke `--tug-session-color` role token declared beside `--tug-chrome-height` with the component deriving three of the four values by `color-mix`. That fails three ways: it is not a `--tug7-*` target, so `--tugx-session-identity-*` cannot resolve in one hop ([L17]); it moves per-theme tunability out of the theme file and into component CSS, which is what [L20]'s "B's appearance remains independently tunable per theme" exists to prevent; and `audit-theme-contrast.ts` resolves `var()` chains to a terminal `--tug-color(...)` recipe and **cannot see through `color-mix`**, so the contrast gate would silently audit nothing. The spike's `--gsi-session-color: var(--tug7-element-badge-text-tinted-agent-rest)` has the right instinct (one hop to a real token) but borrows the **badge** slot, which [L20] forbids for a non-badge component — it is scaffolding, per the header note, not the shipping shape.

**Implications:** six theme edits (four values each) + new `ELEMENT_SURFACE_PAIRING_MAP` entries so `bun run audit:theme-contrast` actually gates the pair — the `atom` slot has **no entries in that map today**, so without them the contrast criterion passes vacuously. `--tugx-session-identity-*` aliases the four in one hop. The atom is a rounded pill, deliberately not the squared `TugBadge`, but it may take `TugBadge`'s `color-mix(currentColor …, transparent)` idiom for *state* variation on top of the authored rest values.

#### [P06] The session atom is a real Tug atom (DECIDED) {#p06-real-atom}

**Decision:** Copying a session atom writes every clipboard flavor per Spec S06; pasting into a Tug surface re-materializes the atom; the `text/plain` flavor **is** the citation; the wire marker rides `atom-mention-marker.ts` unchanged in mechanism.

#### [P07] The description is a rolling synopsis (DECIDED) {#p07-synopsis}

**Decision:** The incipit is retired as the description source. A third job on `SharedAgent`'s Summarize lane composes a synopsis from recent turns and re-runs as work moves. Precedence: `/rename` wins and freezes the line; else synopsis; else honestly empty. Persistence per [Q02]: a `synopsis` column on `sessions`.

**Rationale:** A first prompt describes where a session *started*; the description must be current. The infrastructure (pooled Haiku worker, two latency lanes, recycle caps) already exists.

**Implications:** wording register reuses `headline_rules!` (`shared_agent.rs` ~line 1288); `ai-title` capture stays (the field is still consumed) but stops mattering for display.

#### [P08] The masthead is a fixed 72px second chrome tier (DECIDED) {#p08-masthead}

**Decision:** The Session card's chrome becomes a three-line masthead — `project/callsign` + pane controls; description; PULSE (inline) — with a trailing pulse/info widget opening the telemetry surface (state, turns, created/compacted stamps, branch, citation + copy). **Shipped as a `TugPopover` + `TugPopupListFrame`, not the `TugPlacard` named here:** a hover-dismissed surface puts its own copy button out of the pointer's reach, and `TugPlacard` renders in place, which the clipping 72px chrome tier cannot host. `--tug-masthead-height: 72px`, **ratified**, declared in all six themes, mirrored as a JS constant; overflow truncates; the masthead never reflows. Chrome remains the Pane's ([L09]/[L25]); `cardTitleStore`'s override keeps its string and gains a masthead sidecar (Spec S02); `TugPane` renders masthead density when the pane's **active** card publishes one, one-line bar otherwise — in a multi-tab pane the chrome follows the frontmost tab, swapping 36↔72 on tab switch ([P14]). The pane owns the slot and its geometry; the three lines and every store behind them live in a tugways `SessionMasthead` the pane mounts by `sessionId` (Spec S02) — chrome stays the Pane's without session-domain machinery moving into it.

**Implications:** branch leaves identity — the `(branch)` title suffix retires; branch lives only in the placard. The load-control bar's "Session created …" line is an absorption candidate (placard).

#### [P09] The Z2 PULSE strip is removed, not duplicated (DECIDED) {#p09-strip-removal}

**Decision:** Once the masthead carries the PULSE, `SessionPulseStrip` (`session-pulse-strip.tsx` / `.css`, mounted at `session-card.tsx` ~line 4423) comes out. Everything it owns is re-homed or deliberately retired per List L01. The Z2 **status row is unchanged** — content, layout, position, tokens; spacing alone corrects its seat against the prompt entry. The focus stop is retired per [Q03].

#### [P10] The citation is the only flat-text form; commits carry two trailers (DECIDED) {#p10-citation}

**Decision:** `<tag> (<shortid8>)` (with project context when the context doesn't supply it) is the only sanctioned flat-text session reference and the only place monospace appears. Commits carry `Tug-Session:` (the citation, human) **and** `Tug-Session-Id:` (full tug session UUID, machine, never displayed). tugcast parses both server-side into typed `GitLogCommit` fields, following `tug_dash` exactly, and strips the trailer lines from the displayed body. Transcript export filenames become `tug-session-<tag>-<shortid>`. Annotator pattern-matching is deferred (Non-goals).

#### [P11] Fork lineage grammar (DECIDED) {#p11-lineage}

**Decision:** A fork's tag is `<root-tag>-<Letter><Number>`: letter = branch point (first rewind point forked from is `A`), number = sequence from that point; fork-of-fork extends (`stocky-pixie-A1-B2`). Storage: the fork records its root tag + lineage segments; display derives via the resolver. The ledger's bare-`-N` collision suffix **retires** — on tag-unique violation the server rerolls a fresh tag against the whole ledger; `-<Letter><Number>` becomes the only sanctioned suffix. The fork spawn threads the lineage tag; no more silent fresh mint.

#### [P12] Tag space and immutability (DECIDED) {#p12-tag-space}

**Decision:** Two words, keep the lexicon; grow opportunistically, never structurally. **Never recycle a tag** — uniqueness holds against every tag ever minted, including one whose session was trashed. No `/retag`. External sessions get real minted tags backfilled at scan time; `deriveStableTag` retires from production. The deferred `tag → session_id` resolver and `/resume <tag>` land as part of this work.

**The `sessions_tag` index cannot carry "never recycle."** `sessions` rows are hard-`DELETE`d — explicit trash (`session_ledger.rs` ~line 2600), the cascade paths (~2644 / ~2752 / ~2797), and the cap/age eviction the module header documents. A unique index over a table that loses rows frees the tag when the row dies. That was tolerable when a tag was a friendly face; it is not tolerable once [P10] writes tags into commit trailers, because a recycled tag makes a two-year-old commit's citation resolve to a *different* session — a confidently wrong answer, strictly worse than the [P13] slashed atom.

**Mechanism (Spec S08): one `minted_tags` table is the all-time arbiter.** Every mint — spawn, fork, external backfill — inserts `(tag, session_id, minted_at)` into `minted_tags` inside the same transaction as the row it names, and **nothing ever deletes from it**. Its `PRIMARY KEY` is the collision signal the mint retries against, so it is also the race-breaker; the `sessions_tag` index stays as the live-row invariant but is no longer the thing uniqueness rests on. This is also what gives an external-session tag ([Q04]) somewhere to be unique *before* a `sessions` row exists.

#### [P13] The unresolvable citation (DECIDED) {#p13-unresolvable}

**Decision:** The atom keeps its shape, slashes its icon (`MessageSquareOff`), drops the session color for muted ink, takes a dashed border, and is fully inert (no navigation, no hover placard). Tooltip: *Session not found*. Liveness is never a property of a reference — sessions are never dead.

#### [P14] The masthead follows the frontmost tab (DECIDED) {#p14-masthead-active-tab}

**Decision:** In a multi-tab pane, the pane wears the masthead exactly when its **active** card publishes the sidecar — the chrome swaps 36↔72 on tab switch and the content region reflows with it. A stacked Session card behind another tab contributes nothing to the chrome; its identity still reads on the tab strip (Line tier) and in the slot-stack picker.

**Rationale:** The masthead is the identity of the card you are looking at, not of the pane; a pinned 72px chrome over a Text tab would caption one card with another card's identity.

**Implications:** the height swap is a real geometry event — `--tugx-pane-chrome-height` (Risk R01) changes with the active tab; the #step-11 app-test covers the switch both ways.

#### [P15] Liveness is not part of identity (DECIDED) {#p15-liveness-separate}

**Decision:** `SessionIdentity` carries no phase / liveness field. The phase dot is a `cardId`-keyed leaf subscription (`cardServicesStore` → that card's `codeSessionStore`) composed **into** the row and masthead tiers as a child; `useSessionIdentity` never touches it.

**Rationale:** two reasons, either sufficient. **It cannot be reached:** there is no session-keyed phase store — phase lives on a per-card `codeSessionStore` whose `getSnapshot()` is the whole `CodeSessionSnapshot` (no by-id getter, no version token), and `cardSessionBindingStore` maps `cardId → session` with no reverse index. **It must not be reached:** `cards-session-cell.tsx`'s `RowPhaseDot` isolates that subscription in a leaf so a reducer wake repaints the dot alone; a `useSessionIdentity` that subscribed to the snapshot would wake the chip, line, row, and masthead on every transcript event — the exact churn the typing-lag work is unwinding.

**Implications:** identity and liveness are two subscriptions with two keys that meet in the component, not in the record. A surface with no card (a closed or external session in the picker) shows identity with no dot, which is the honest rendering rather than a null field.

---

### Deep Dives {#deep-dives}

#### The strip re-home inventory {#strip-inventory}

**List L01: What `SessionPulseStrip` owns and where each piece lands** {#l01-strip-inventory}

Verified against `tugdeck/src/components/tugways/cards/session-pulse-strip.tsx`:

1. **Dwell queue** (`MIN_DWELL_MS = 1_800`, `lastSwapAtRef` coalescing; user submit clears immediately) → moves as code into the masthead's PULSE feeding logic. This pacing makes the voice readable; it must not be reimplemented.
2. **Compaction pin** (`Compacting context…` held for a `/compact` from this card, fed by `compactionProgressStore`, an app-wide singleton) → moves with the PULSE line.
3. **`pulse/enabled` tugbank default** — strip hides entirely when off. In the masthead, hidden must not collapse chrome: the masthead keeps its 72px and the PULSE line is simply absent.
4. **Activity sparkline** (`TugSparkline` on the trailing edge) → rides `TugPulse`'s `trailing` accessory in the masthead. `TUG_SESSION_ROW_SPARK_WIDTH` / `_HEIGHT` in `tug-session-row.tsx` are documented as deliberately matching the strip's numbers; when the strip's constants move or die, that pairing and its docstring are updated, never silently orphaned.
5. **Focus stop** (`useFocusable` leaf, `SESSION_CYCLE_ORDER_PULSE` inside the card's `CycleScope`) → **retired** per [Q03]; the cycle order entry is deleted, leaving no dangling order.

#### Trailer read path today, and the change {#trailer-read-path}

`feeds/git.rs` builds `git log` with `--format=%H%x1f…%x1f%(trailers:key=Tug-Dash,valueonly,separator=%x1e)%x1f%b` and splits on `%x1f` via `chunk.splitn(9, LOG_FIELD_SEP)` (record parse ~line 438; `tug_dash` at index 7, body at index 8). The change appends two more `%(trailers:key=…)` fields — **and widens the `splitn` cap to 11 in the same edit, or the new trailer values silently glue themselves to the front of every body** — for `Tug-Session` and `Tug-Session-Id` (each `%x1e`-joined when repeated; keep the first), populates `GitLogCommit.tug_session` / `tug_session_id`, and strips all `Tug-Session:` / `Tug-Session-Id:` lines from the `%b` body before it ships. Note `%b` retains trailer lines — git does not remove them — which is exactly why the History card shows raw trailer ink today.

#### Trailer write paths today, and the change {#trailer-write-path}

Two writers, one grammar:

- **Dash lane:** `session_trailer()` in `tugdash-core/src/ops.rs` reads `sessions.db` read-only via `TUG_SESSION_ID` and currently emits `<display> (<full-uuid>)`. It changes to `SELECT tag FROM sessions …`, emits the citation `<tag> (<shortid8>)` (the name never appears in the trailer — the tag is the callsign; a legacy tagless row degrades to the bare `<shortid8>` per Spec S03), and the caller `with_dash_trailers` pushes both `("Tug-Session", citation)` and `("Tug-Session-Id", full_id)` through `tugchanges_core::append_trailers`.
- **Main lane:** `changes-route-controller.ts` (~line 269) carries `{ name, id }` from the CHANGESET entry into `getChangesetVerbStore().commit(...)`; the Rust changeset-commit handler appends the trailer. The payload changes to carry the tag (available after the feed's tag arm, #step-1), and the Rust side emits the same two trailers.

#### The masthead in the pane {#masthead-in-pane}

`TugPane` consults `cardTitleStore` for the active card's override (`tug-pane.tsx` ~line 1371) and composes via `lib/pane-title.ts` (`composePaneTitleBarText` / `paneTitleBarTextFor`, [D123]/[D125]). The evolution: the string stays and the masthead rides beside it as a sidecar (Spec S02). Note what the string channel is and is not after this work — it is **reader compatibility** (`get(): string | null` is what four call sites and the tab bar's `overrideKey` join already consume), not a notification path. `<project>/<tag>` is constant for the life of a binding once [P04] drops the name, [P08] drops the branch, and [P12] freezes the tag, so `set` no-ops after the first call and identity changes travel through `useSessionIdentity` instead (Spec S01). `paneTitleBarTextFor` keeps returning the one-line string for every list surface (tab strip, Window menu, slot-stack picker — the **Line** tier is exactly this string) with no change at all, while `TugPane` opens a masthead-height chrome slot when the active card carries the sidecar ([P14]: the chrome follows the frontmost tab) and mounts `SessionMasthead` into it. The pane owns the slot and its geometry; the session family owns what is inside it, which is what keeps the PULSE feeder, dwell queue, and placard out of chrome code. The JS audit is the two `CARD_TITLE_BAR_HEIGHT` consumers (`TITLE_BAR_VISIBLE_MIN_Y` ~line 825 plus grep); the CSS audit is `--tug-chrome-height`'s **eight** consumers across four files, four re-pointed and four left alone, enumerated site by site in Risk R01.

#### Tag mint hardening {#tag-mint-hardening}

`record_spawn`'s claim-or-suffix (~line 2353): on `sessions_tag` unique violation it suffixes `-2`, `-3`… up to `TAG_SUFFIX_CAP`, then lands NULL silently (~line 2412). The change is two-part.

**The arbiter moves.** `sessions_tag` indexes a table that loses rows — trash (~line 2600), the cascade deletes (~2644 / ~2752 / ~2797), cap/age eviction — so it can enforce "unique among live sessions" but not [P12]'s "never recycle", which commit trailers now depend on. The append-only `minted_tags` table (Spec S08) becomes the thing a mint claims against; its `PRIMARY KEY` violation is the collision signal, and it distinguishes "already mine" (re-spawn, resume, external adoption) from "taken by another session" (a real collision). `sessions_tag` stays as the live-row invariant.

**The collision response changes.** On a genuine collision, reroll a complete fresh `adjective-noun` from a Rust copy of the lexicon (Spec S05) and re-claim (bounded attempts, then error — never NULL, never a bare `-N`). `tag_base` (~line 4909) and `is_tag_unique_violation` survive only as far as the reroll loop needs them; the `-N`-stripping semantics retire. Lineage suffixes (`-A1`) must pass the mint untouched, and a colliding lineage candidate **errors instead of rerolling** — a reroll would write an unrelated `adjective-noun` into `tag` while `root_tag`/`tag_lineage` still name the lineage, a contradiction the resolver would render straight to the user. That a lineage tag is unique by construction (root tag unique + point/sequence allocated from the ledger's own lineage rows) is why the guard should never fire; it is not a reason to omit it.

---

### Specification {#specification}

**Spec S01: `resolveSessionIdentity`** {#s01-resolver}

New module `tugdeck/src/lib/session-identity.ts` (grown from `session-card-title.ts`, which it absorbs):

```ts
export interface SessionIdentity {
  /** Project leaf name (basename of projectDir). */
  project: string;
  /** Workspace branch, or null — telemetry only, never rendered in identity. */
  branch: string | null;
  /** The callsign, including any lineage suffix; null only for a legacy tagless row. */
  tag: string | null;
  /** Parsed lineage segments, e.g. ["A1","B2"] (from `tag_lineage`); empty for a root session. */
  lineage: readonly string[];
  /** The description: /rename name if user-set, else synopsis, else null. */
  title: string | null;
  /** Ledger state: "live" | "closed" | "failed". */
  state: SessionRow["state"] | null;
  /** Full tug session id (plumbing: tooltips, copy affordance). */
  id: string;
  /** First 8 chars of id — THE short id; computed here and nowhere else. */
  shortId: string;
}
/** Imperative read — a SNAPSHOT with no subscription. Non-React callers only. */
export function resolveSessionIdentity(sessionId: string): SessionIdentity;
/** The React entry point — subscribes, then resolves. Every component uses THIS. */
export function useSessionIdentity(sessionId: string | null): SessionIdentity | null;
/** The Line-tier / pane-title string: `<project>/<tag>` (no branch suffix — [P08]). */
export function sessionIdentityLine(identity: SessionIdentity): string;
/** The citation: `<tag> (<shortId>)`, optionally project-prefixed. */
export function sessionCitation(identity: SessionIdentity, opts?: { project?: boolean }): string;
```

Reads **three** stores — `sessionNameStore`, `sessionTagStore`, `sessionSynopsisStore` — plus the card-binding project dir. Pure formatting helpers are exported separately for unit tests. Fallback rule everywhere: tag; a legacy tagless session degrades to `shortId` — never the full UUID.

**Phase is deliberately NOT in this record ([P15]).** An earlier draft carried a `liveness` field sourced from "the session phase store". There is no such store. Phase is per-**card**: `cardServicesStore.getServices(cardId)` hands back a `codeSessionStore` whose `getSnapshot()` is the whole `CodeSessionSnapshot` — no by-id getter, no version token — and `cardSessionBindingStore` maps `cardId → session` with no reverse index, so a `sessionId`-keyed resolver cannot reach it at all. Folding it in would also be a real regression: `cards-session-cell.tsx`'s `RowPhaseDot` isolates the phase subscription in a leaf precisely so a reducer wake repaints the dot and nothing else, and a `useSessionIdentity` that subscribed to that snapshot would wake the chip, line, row, and masthead on every transcript event. The dot stays a `cardId`-keyed leaf subscription composed *into* the row and masthead tiers as a child — identity and liveness are two subscriptions with two keys, and the component is where they meet.

**The reactivity contract ([L02]) is part of this spec, not an implementation detail.** `resolveSessionIdentity` reads three stores imperatively; called bare from a render it hands back a snapshot with **no subscription**, and a rename or synopsis write would update the stores while the surface repaints never. That failure is invisible in a unit test and lands hardest on the masthead, where Spec S02 deliberately keeps the sidecar a key rather than a snapshot precisely so the pane re-resolves at render.

So `useSessionIdentity(sessionId)` is the sanctioned entry point for every React consumer — masthead, row, chip, line — and it composes `useSyncExternalStore` over each backing store **by id** before delegating to the pure `resolveSessionIdentity`. `sessionNameStore` and `sessionTagStore` already publish exactly the pair this needs — a by-id getter (`getName` / `getTag`) and a monotonic `getVersion` — and their headers say so; `sessionSynopsisStore` is a clone of them and inherits the shape by construction. Prefer the **by-id** getters inside the hook (`useSyncExternalStore(store.subscribe, () => store.getName(id))`, the shape `cards-session-cell.tsx`'s `useSessionLabel` already uses): the version tokens are whole-store and exist for consumers that derive across many sessions at once (the Lens filter), and reading them here would wake every identity surface in the app on any session's rename. The bare function stays exported for non-React callers (clipboard writes, export filenames, command routes) and for the unit tests. **No component may call `resolveSessionIdentity` directly** — that is a grep gate in #step-19.

**Spec S02: `TugSessionIdentity` and the masthead payload** {#s02-component}

New pair `tugdeck/src/components/tugways/tug-session-identity.tsx` / `.css` ([L19], `data-slot`):

- `tier: "chip" | "line" | "row" | "masthead"`; `register` is implied (chip = citation; the rest = presence). **Shipped as two tiers:** `tier: "chip" | "line"` on the component; the row and masthead densities are *compositions* of those tiers (`TugSessionRow`, `SessionMasthead`), not tier values — the family covers all four densities, the prop covers two. [D132] records the same shape.
- Chip: the session atom — rounded pill, session color, `MessageSquare` icon, `<project>/<tag>` one bold run; `missing` prop per [P13]; hover placard (full identity + citation + copy via `TugCopyBadge`); click raises/opens via the caller's intent. Sizes `sm` / `2xs`. **Shipped deltas:** the icon is `MessageSquareText` (the ruled chatbox reads as talk at chip sizes); the hover is a `TugTooltip` carrying line + description + lineage + citation — `TugTooltip` is non-interactive and evaporates on deliberate action, so a copy button cannot live in it. Copy is the chip's right-click context menu (a real atom copy: citation text + `dev.tug.prompt-atoms` sidecar); the `TugCopyBadge` citation lives in the masthead's telemetry popover instead. The click ships on `TugSessionCitation` itself and dispatches the registry's `focus-session-card` — the same funnel the Lens rows use.
- Line: icon + one bold run, no enclosure.
- Row/Masthead: the identity stack (callsign; description; `TugPulse layout="inline"`; row adds metadata line) with geometry per Table T01. Composes `TugSessionRow`, `TugProgressIndicator`, `TugPulse` through published knobs only ([L20]). **The phase dot arrives as a child, not as a field** — the caller supplies a `cardId`-keyed dot leaf ([P15]); these tiers render identity and lay out a slot for liveness, they do not resolve it.
- Owned tokens (`--tugx-session-identity-*`): `icon-gap`, `lead-gap: 5px`, `line-gap: 1px`, `row-dot-size: 16px`, `row-indent: 10px`, `row-pad: 12px`; CSS knob defaults live as `var(--x, default)` fallbacks at point of use.
- `cardTitleStore` evolution: the card **keeps publishing the resolved Line string**, and the masthead rides beside it as a **sidecar**: `set(cardId, title: string, masthead?: CardMastheadPayload)` with `CardMastheadPayload = { kind: "session-masthead"; sessionId: string }` (shipped under the card-generic name — mastheads for other cards are a stated follow-on; the `kind` literal stays the session's); `get()` stays `string | null` (no reader changes anywhere at `deck-canvas.tsx` ~315, `host-menu-state.ts` ~1016, `tug-pane.tsx` ~1378, `tug-tab-bar.tsx` ~198/~442/~803) and a new `getMasthead(cardId)` serves the pane. The sidecar is a **key, not a snapshot** — the pane resolves display data through `useSessionIdentity` at render.

  **Why the string channel survives: reader compatibility, not notification.** It is tempting to say the card's re-`set` on every identity change is what keeps list consumers fresh — that was true when the override carried the name and the `(branch)` suffix. It is **not** true after this work: [P04] makes the Line string `<project>/<tag>`, [P08] retires the branch suffix, and [P12] makes the tag immutable, so the string is **constant for the life of a session binding**. A `/rename` no longer changes it, and `set` no-ops. Identity changes reach every surface through the identity stores via `useSessionIdentity` (Spec S01) — that is the notification path, and it is the only one. The string stays because `get(): string | null` is what four call sites and the tab bar's `overrideKey` join already consume, and changing that shape buys nothing.

  **The equality guard must widen.** `CardTitleStore.set` currently early-returns on `this._overrides.get(cardId) === title`. With a sidecar, an unchanged title carrying a *changed* masthead payload would return early: the sidecar would never be stored and no listener would fire. The guard compares the string **and** the payload (by `sessionId`); a change in either notifies.

- **Who owns the masthead's moving parts.** The pane composes chrome ([L09]) but must not grow session-domain machinery: the PULSE headline feed, the dwell queue, `compactionProgressStore`, the sparkline series, and the `pulse/enabled` tugbank default all live inside a card-owned component today (`session-pulse-strip.tsx`). **Decision:** `TugPane` mounts a tugways component — `SessionMasthead` (`components/tugways/session-masthead.tsx` / `.css`), keyed by the sidecar's `sessionId` — into a chrome slot it owns and sizes. The pane owns the slot's geometry and the 36↔72 swap; `SessionMasthead` owns the three lines, the placard widget, and every store subscription behind them. The precedent is the Session card rendering `TugPaneBanner`: pane-class chrome furniture, session-class content inside it. This is what #step-12's "move the dwell queue as code" moves *into* — a real destination, not the pane's render body.

**Spec S03: Citation and trailer grammar** {#s03-citation-grammar}

- Citation: `<tag> (<shortid8>)`; project-prefixed `<project>/<tag> (<shortid8>)` when context doesn't supply the project. `shortid8` = first 8 chars of the tug session UUID.
- Tagless fallback (legacy rows only): the citation degrades to `<shortid8>` alone — no parentheses (a doubled hash is noise).
- Trailers written on every Tug commit (both lanes):

```
Tug-Session: stocky-pixie (f6e43925)
Tug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f
```

- `GitLogCommit` gains `tug_session: Option<String>` (raw citation value) and `tug_session_id: Option<String>`; both `#[serde(default, skip_serializing_if…)]` like `tug_dash`. Body ships with all `Tug-Session*` trailer lines stripped.
- Resolution precedence for display: `tug_session_id` (full UUID, exact ledger join) → parse `tug_session`'s parenthesized token (36-char = legacy full UUID; 8-hex = short id, matched by prefix against the ledger) → unresolvable ([P13]). Legacy one-line trailers (`<display> (<full-uuid>)`) therefore resolve exactly.
- Transcript export filename: `tug-session-<tag>-<shortid>`.

**Spec S04: The session color and masthead tokens (six themes)** {#s04-tokens}

Each of `brio,nocturne,bravura,harmony,aria,vivace`.css gains:

- The **`session` tone on the `atom` slot** ([P05]) — four values authored beside the slot's existing `default` / `selected` / `route` / `highlighted` tones (`brio` ~lines 966–978), as `--tug-color(violet, l: …, c: …[, a: …])` recipes hue-seeded from that theme's `agent` family:

  | Token | Role | `brio` seed |
  |---|---|---|
  | `--tug7-surface-atom-primary-normal-session-rest` | ground | the `agent` violet at the `route` tone's ground lightness, alpha'd like `default` |
  | `--tug7-element-atom-border-normal-session-rest` | border | one step up in L, alpha'd |
  | `--tug7-element-atom-text-normal-session-rest` | ink | the `agent` text lightness |
  | `--tug7-element-atom-icon-normal-session-rest` | icon | the `agent` icon lightness |

  `TugSessionIdentity` aliases each in **one hop** to a `--tugx-session-identity-*` ([L17]); no `color-mix` derivation of a rest value in component CSS ([L20]).

  **Four tokens, all `-rest`, and no `-hover` pair — this is complete, not partial.** The slot's `default` tone authors `-hover` variants for its ground and border (`--tug7-surface-atom-primary-normal-default-hover`, `--tug7-element-atom-border-normal-default-hover`); the `route` tone authors none. The session tone follows `route`: **rest-only**. State variation on top of the authored rest values — hover, the [P13] missing state — is the component's job via `TugBadge`'s `color-mix(currentColor …, transparent)` idiom (Spec S02), which is legitimate precisely because it varies *state* rather than deriving a *rest* value ([L20], [P05]). An implementer who counts six tokens against `default` and stops has miscounted the precedent; the count is four.
- `--tug-masthead-height: 72px` beside `--tug-chrome-height: 36px` (~line 38).

Contrast: the four tokens need **`ELEMENT_SURFACE_PAIRING_MAP` entries** (`components/tugways/theme-pairings.ts`) — ink and icon on the ground at role `control` (a chip label is an interactive element label), border on the ground at `decorative`. The `atom` slot has no entries in that map today, so `bun run audit:theme-contrast` gates nothing until they are added; adding them is what makes the Success Criterion falsifiable rather than free.

**Spec S05: Lineage storage and the Rust lexicon** {#s05-lineage-storage}

- `sessions` table gains (self-healing ALTERs): `root_tag TEXT` (the lineage root's tag; NULL for a root session) and `tag_lineage TEXT` (dash-joined segments, e.g. `A1-B2`; NULL for a root). The display tag column keeps the full composed tag (`stocky-pixie-A1-B2`) so existing tag-unique indexing and lookups are unchanged; `root_tag`+`tag_lineage` are the structured record the resolver and future tooling read. **Not** `lineage`: `external_scan_cache.lineage_ancestors` already owns that word for JSONL message ancestry, an unrelated concept, and two `lineage` columns one table apart meaning different things is a trap for the next reader.
- Fork allocation: the branch-point letter is allocated per (root session, rewind point) — first point forked from is `A`, next distinct point `B`; the number sequences forks from that point. The ledger owns allocation so two racing forks cannot collide.
- **Allocation is a table, not a query — `tag_lineage_points` (as shipped, #step-5).** The plan originally said "a query over the root's existing fork rows". That was implemented instead as its own table, and the shipped shape is the better one:

  ```sql
  CREATE TABLE IF NOT EXISTS tag_lineage_points (
    root_tag   TEXT NOT NULL,
    fork_point TEXT NOT NULL,
    letter     TEXT NOT NULL,
    allocated  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (root_tag, fork_point)
  );
  ```

  One row per rewind point ever forked from within one root's lineage. `letter` is assigned once per point (`COUNT(*)` of the root's existing points → `A`…`Z`, erroring past 26 rather than wrapping, since a wrapped letter would name two points alike); `allocated` counts the numbers issued under it, so two forks from one point read `A1` and `A2`. The `fork_point` key is the **rewound-to prompt uuid**, which is why a point means the same thing everywhere in one lineage: a fork inherits its ancestors' record uuids, so forking a fork at an inherited point resolves to that point's existing letter.

  **This table is append-only for the same reason `minted_tags` is (Spec S08), and the guarantee is the same shape:** a recycled letter or a reissued number would make two unrelated forks share a callsign, which is the [P12] failure wearing a different hat. Nothing deletes from it — not trash, not the cascade paths, not eviction. `a_lineage_tag_is_permanent_like_any_other_callsign` is the test that keeps this true: trash `…-A1` and the next fork from that point is `A2`, never `A1` again.

  Why a table beats the query: the query form has to derive a letter by re-reading sibling `tag`/`tag_lineage` strings, which means the letters live only in parsed display names and a trashed fork's row takes its number with it. The table makes both facts first-class and lets two racing forks serialize on a row inside the same transaction that claims the composed tag.
- Rust lexicon: `tugrust/crates/tugcast/src/session_tag_lexicon.rs` generated from `tugdeck/src/lib/session-tag-lexicon.ts` by a `just` recipe (checked in, regenerated on lexicon edits); a Rust unit test reads the TS file from the repo at test time and asserts the two lists match — drift fails the build.

**Spec S06: Clipboard flavors** {#s06-clipboard}

| Flavor | Payload |
|---|---|
| `dev.tug.prompt-atoms` | `{"kind":"session","tag":"tugtool/syrupy-beam","id":"f6e43925"}` |
| `text/plain` | `tugtool/syrupy-beam (f6e43925)` — the citation |
| `text/html` | `<span data-tug-session="f6e43925">tugtool/syrupy-beam</span>` |
| wire marker | `` `@tugtool/syrupy-beam` `` via `wrapAtomMention` |

Written through `writeClipboardViaNative(text, atoms)`; paste re-materialization and replay re-mint ride `parseAtomMentionSegments` — the session atom **joins** the existing system, no parallel one.

**Shipped deltas, decided rather than drifted:** (a) **there is no `text/html` flavor** — `writeClipboardViaNative(text, atoms)` carries exactly two flavors, and the html leg promised a flavor the bridge it names cannot carry; struck rather than extended. (b) The sidecar is the **generic atom segment** — `{ kind: "atom", type: "session", label, value }` with label = value = `project/tag` — not the bespoke shape in the table, and **no session id rides the sidecar or the wire marker**: a re-materialized atom is identified by its tag alone, resting on tag immutability ([P12]) plus ledger resolution. That genericity is *why* `parseAtomMentionSegments` and the paste side needed no session case at all. Whether the segment should also carry the short id is an open question for the gallery revisit — settle it there, not by another silent omission.

**Spec S07: The synopsis job** {#s07-synopsis-job}

- A third job on `JobClass::Summarize` in `shared_agent.rs`, prompt built like `SUMMARIZE_INSTRUCTIONS` but for a standing description rather than a moving headline; register rules from `headline_rules!` apply verbatim (*"a headline with no verb is a label, and a label is a failure"* — the synopsis wants the same discipline in a descriptive register).
- Input: the session's recent turns (the session-overview digest machinery in `feeds/session_overview.rs` is the precedent for composing it).
- Output: written to `sessions.synopsis`, broadcast on the existing `session_updated` push so `SessionRow.synopsis` reaches the client.
- Precedence enforced at write: a row with `name_user_set = 1` never runs the job (frozen); the client resolver prefers `name` when `name_user_set`, else `synopsis`, else empty.
- Trigger: [Q01] — start "on turn completion, debounced ≥60s", tune in #step-15.

**Spec S08: `minted_tags` — the all-time tag arbiter** {#s08-minted-tags}

```sql
CREATE TABLE IF NOT EXISTS minted_tags (
  tag        TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  minted_at  INTEGER NOT NULL
);
```

- Created in `session_ledger.rs`'s CREATE batch (`sessions.db`, per-instance); rows are **never deleted** — not by trash, not by the cascade paths, not by cap/age eviction. A tag outlives its session by design ([P12]).
- Every mint path inserts here **in the same transaction** as the row it names: `record_spawn` (#step-2), the fork allocation (#step-5), the external backfill (#step-3).
- The `PRIMARY KEY` violation is the collision signal the mint retries against — it replaces `sessions_tag` as the arbiter. `sessions_tag` stays as the live-row invariant (a second row must never *display* a tag another live row displays), but it is no longer what "unique" rests on.
- **"Mine" is not "taken":** an insert whose `(tag, session_id)` already matches is idempotent (`INSERT … ON CONFLICT(tag) DO NOTHING`, then confirm the stored `session_id` equals ours). Only a conflict naming a *different* `session_id` is a real collision and triggers the reroll. Without this, re-spawn/resume of an already-tagged session and the external-adoption carry-over ([Q04]) would both read as collisions and reroll a perfectly good tag.
- Trash/delete paths need no change beyond *not* touching this table — call that out in their doc comments, since "delete every row for this session" is the obvious wrong instinct.
- **The arbiter answers "what is this session's callsign?", not only "is this tag taken?" — every mint path must ask it before rolling.** Two tables can lose the tag while `minted_tags` still holds it: `prune_scan_cache_except` deletes an `external_scan_cache` row when its JSONL vanishes, and a session with no `sessions` row has no adopted tag to read. That state is reachable, not theoretical — trashing a session is *recoverable by design* (the JSONL goes to `.tug-trash/` and the user can move it back), so "cache row gone, never adopted" describes any restored session. A mint path that consults only those two tables re-mints, and one session ends up wearing its second callsign while every commit citing the first one names a tag it no longer wears. Immutability broken by a restore is still broken. So `backfill_external_tag` asks three sources in order — cache row, `sessions` row, then `SELECT tag FROM minted_tags WHERE session_id = ?1 ORDER BY minted_at ASC LIMIT 1` — and only a session no table has ever named gets a fresh roll. **Earliest claim wins:** that is the one already written into trailers. Pinned by `a_restored_session_keeps_the_callsign_it_was_minted`, which fails by re-minting when the third consult is removed.
- **A claim is not a display.** `record_spawn` claims its candidate before the write, and the write may then keep a different tag (`COALESCE` preserves a stored one) or reroll off the `sessions_tag` invariant — so `minted_tags` holds tags no session ever wore. Harmless against 524k combinations and deliberately not "fixed" (the alternative is reading the row before claiming, which buys a race for a hygiene win), but it means the table reads as *every tag ever spent*, never *every tag ever shown*. Anything that wants the latter must join `sessions`.
- **Scope the guarantee honestly: this is per-ledger, not global.** `sessions.db` is per-instance, so "never recycled" holds against every tag this ledger ever minted — not against every tag ever minted anywhere. Two consequences worth one sentence in the module doc rather than a surprise later: a trailer written on one machine and read against another machine's ledger resolves to [P13]'s slashed atom, which is a *miss* and therefore safe; and a wiped or reinstalled ledger re-opens recycling on that machine. [P12]'s prose ("uniqueness holds against every tag ever minted") should be read with that scope attached. Making the guarantee global would mean a shared registry, which buys nothing [P13] does not already cover.

**Table T01: Stack geometry (measured on the spike, ships as tokens)** {#t01-geometry}

| | value | note |
|---|---|---|
| lead gap (callsign → description) | 5px | `--tugx-session-identity-lead-gap` |
| line gap (lower three lines) | 1px | `--tugx-session-identity-line-gap` |
| line-height, all stack lines | `--tug-line-height-tight` | **explicit, never inherited** — inherited ~1.45 body leading puts a 13px run in a 19px box; margin cannot take that back |
| `--tugx-pulse-bar-height` in the stack | 18px (default 34px) | move `--tugx-pulse-baseline` to 13px with it — baseline is stated from the bar's top; shrinking one without the other clips descenders ([L20]: published knobs only) |
| row dot | 16px ring box | overhangs left by its own inset so the **dot** lands on the row margin (dot paints at 60% of box); overhangs block-wise into padding so it doesn't set line height — `TugSessionRow`'s `inset` fit, smaller |
| row sub-line indent | 10px | |
| row block padding | 12px | block padding and leading are opposite jobs — tight leading makes four lines one entry; padding stands the block off the rules |
| row height, four lines | 93px | 69px content in 24px padding |
| `--tug-masthead-height` | **72px, RATIFIED** | fixed; JS mirrors as a constant |

**Table T02: Surface adoption map** {#t02-surfaces}

| Surface | Today | Becomes | Tier |
|---|---|---|---|
| Session card title bar | `sessionCardTitleOverride` string incl. `(branch)` | masthead payload | Masthead |
| Tab strip (`tug-tab-bar.tsx` `TabView`) | literal "Session" (override gated `componentId === "text"`) | `paneTitleBarTextFor` for every card | Line |
| Slot-stack picker / Window menu | [D123] pane title (already correct once the override drops `(branch)`) | unchanged path, new string | Line |
| Picker rows (`session-picker-cells.tsx`) | incipit-first `TugListRow`, tag buried, `deriveStableTag` | four-line stack on grown `TugSessionRow` | Row |
| Lens Sessions group (`cards-session-cell.tsx`, `cards-data-source.ts`) | `sessionLabel` string; filter projection passes `branch: null` while the row passes real branch | resolver + row/line rendering; the branch inconsistency dies with branch-in-identity | Row |
| Gazette refs (`gazette-card.tsx` `RefChip`) | full 36-char UUID | session case → chip | Chip |
| Changes card orphan hint (+ bucket headers where useful) | `prior_owner_name` feed string, no identifier | chip | Chip |
| History card commit line (`tug-history-list.tsx`) | trailer as raw body ink (truncated incipit + full UUID) | citation chip beside SHA + dash badge; trailers stripped from body | Chip |
| Telemetry placard | — (new) | branch, stamps, citation + copy | — |

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| synopsis text | external (ledger) | rides `SessionRow` → small `sessionSynopsisStore` (clone of `session-name-store.ts`), `useSyncExternalStore` | [L02] |
| **resolved identity (read path)** | external (derived) | `useSessionIdentity` composes `useSyncExternalStore` over the name / tag / synopsis stores **by id**, then derives; the bare resolver is a snapshot and is never called from a render (Spec S01) | [L02] |
| **session phase (liveness)** | external (per-card) | a separate `cardId`-keyed subscription — `cardServicesStore` → that card's `codeSessionStore` — living in the dot leaf, never in `useSessionIdentity` ([P15], Spec S01) | [L02] |
| masthead payload | structure (pane/card channel) | `cardTitleStore` string + masthead sidecar, keyed by `sessionId`; a key, not a snapshot — identity changes travel the store path above, not this one | [L02], [L24] |
| atom hover placard open | appearance | `TugPlacard`'s own mechanism (existing component) | [L06] |
| phase dot pulse | appearance | CSS animation via `TugProgressIndicator` (existing) | [L06], [L13] |
| PULSE dwell queue | local-data (timers) | refs + timers inside `SessionMasthead` (moved as code from the strip, Spec S02) — not in the pane's render body | [L22] |
| tag → id reverse map | external | grows on `sessionTagStore` (documented follow-on in its header) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/session-identity.ts` | Spec S01 resolver + citation/line helpers (absorbs `session-card-title.ts`) |
| `tugdeck/src/lib/__tests__/session-identity.test.ts` | resolver unit tests |
| `tugdeck/src/lib/session-synopsis-store.ts` | [L02] store for `SessionRow.synopsis` |
| `tugdeck/src/components/tugways/tug-session-identity.tsx` / `.css` | Spec S02 component family |
| `tugdeck/src/components/tugways/session-masthead.tsx` / `.css` | the three-line masthead the pane mounts by `sessionId` (Spec S02) — owns the PULSE feeder, dwell queue, compaction pin, sparkline, placard |
| `tugrust/crates/tugcast/src/session_tag_lexicon.rs` | generated Rust lexicon (Spec S05) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `resolveSessionIdentity`, `sessionIdentityLine`, `sessionCitation` | fn | `session-identity.ts` | Spec S01 |
| `useSessionIdentity` | hook | `session-identity.ts` | Spec S01 — **the** React entry point; `useSyncExternalStore` **by id** over the three backing stores; no phase ([P15]) [L02] |
| `TugSessionIdentity` | component | `tug-session-identity.tsx` | Spec S02 |
| `SessionMasthead` | component | `session-masthead.tsx` | Spec S02 — mounted by the pane into its chrome slot |
| `SessionMastheadPayload` | type | `card-title-store.ts` | Spec S02 — sidecar beside the string; `getMasthead(cardId)`; equality guard widens to cover it |
| `cardTitleTextFor` | fn | `lib/pane-title.ts` | per-tab label for the tab strip (#step-16) |
| `MASTHEAD_HEIGHT` | const | `tug-pane.tsx` | mirrors `--tug-masthead-height` |
| `--tugx-pane-chrome-height` | CSS property | `tug-pane.css` (+ scrim/sheet/banner re-points) | Risk R01, [P14] |
| `SessionRow.synopsis`, `.root_tag`, `.tag_lineage` | fields | `tugdeck/src/protocol.ts` + Rust `SessionRow` | lockstep comments like `tag`; all default null for older tugcast |
| `GitLogCommit.tug_session`, `.tug_session_id` | fields | `tugcast-core/src/types.rs` | Spec S03 |
| `session_row_title` | fn | `feeds/changeset.rs` | gains tag arm (#step-1) |
| `record_spawn` reroll | fn | `session_ledger.rs` | Spec S05 / [P11] |
| `minted_tags` table + `claim_tag` | table / fn | `session_ledger.rs` | Spec S08 — all-time arbiter; never deleted from |
| `sessions.root_tag`, `sessions.tag_lineage`, `sessions.synopsis` | columns | `session_ledger.rs` | self-healing ALTERs (**not** `lineage` — [Q04]/Spec S05) |
| `external_scan_cache.tag` | column | `session_ledger.rs` | [Q04] — the backfilled external tag; uniqueness lives in `minted_tags` |
| `session_trailer` | fn | `tugdash-core/src/ops.rs` | citation + id pair |
| deleted: `sessionChipDisplay`, `sessionRowTitle`, `sessionEntryTitle`, `deriveStableTag` (production), `sessionCardTitleOverride`, `SessionPulseStrip`, `SESSION_CYCLE_ORDER_PULSE` | — | various | [P02], [P09], [P12] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun test)** | pure resolver/citation/lineage string logic | `session-identity.test.ts`, marker/clipboard parsing |
| **Unit (cargo nextest)** | mint reroll, tag permanence across delete, lineage allocation, trailer write/parse/strip, synopsis precedence, lexicon drift | all Rust steps |
| **App-test (selective)** | real surfaces on the real app: masthead, picker rows, tab strip, Gazette chip, History line, strip removal | every tugdeck step; `just app-test-changed` via `@covers` |
| **Contract** | TS↔Rust lockstep: `SessionRow` fields, lexicon drift test | #step-2, #step-15 |

#### What stays out of tests {#test-non-goals}

- Synopsis wording quality — tuned by eye against real output ([Q01]); the register rules are enforced by the existing grounding code, not new tests.
- The `useSessionIdentity` hook in isolation — a render test would be the banned pattern. Its contract ("a `/rename` repaints every live surface") is an app-test on the real app, in #step-9.
- jsdom render tests / mock stores — banned pattern; surfaces are covered by app-tests on the real app.
- Sparkline pixel output — covered by existing at0205 pinning; only the constant-pairing docstring moves.
- Full app-test sweeps — selection is derived (`@covers`); core tier only if a change lands in pre-assertion harness files.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every step. Rust steps: `cd tugrust && cargo nextest run` and a `just build-app` before any dependent app-test. Tugdeck steps: `bunx vite build` before declaring done.

#### Step Status Ledger {#step-status-ledger}

**Steps land in numeric order.** The one ordering fact worth knowing before you start: #step-11 and #step-12 sit where they do — ahead of the clipboard and row work — because #step-9 opens a "a rename shows nowhere" window that only the masthead closes (see #strategy).

**The nineteen steps land as three phases** — #step-1…7, #step-8…14, #step-15…19 — each vetted, implemented, and closed on its own. Numeric order is unchanged; the phases are contiguous cuts through it. See #phasing for the seams and why they fall there.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Tag arm in the Rust changeset feed | done | `df35bbfd3` |
| #step-2 | Mint hardening: reroll, no NULL, no bare `-N` | done | `0add2f636` |
| #step-3 | External-session tag backfill at scan time | done | `639f3bc6c` |
| #step-4 | Live `ai-title` capture | done | `21dc1261a` |
| #step-5 | Fork carries lineage | done | `db8fc452d` |
| #step-6 | Trailer writers: citation + machine id | done | `972f2805a` |
| #step-7 | Trailer read: typed fields, stripped body | done | `87a47bdb9` |
| #step-8 | Session atom tone + masthead height tokens (six themes) | done | `ce245c1ad` |
| #step-9 | `resolveSessionIdentity` and the great deletion | done | `90caaa41d` |
| #step-10 | `TugSessionIdentity`: chip + line tiers | done | `b1b5ecd10` |
| #step-11 | The masthead | done | `ff7ce5e77` |
| #step-12 | Z2 strip removal and re-homing | done | `c410e1466` |
| #step-13 | The atom on the clipboard | done | `7d8ed2c2b` |
| #step-14 | Row tier: `TugSessionRow` grows; picker + Lens adopt | done | `045cab247` |
| #step-15 | The synopsis | done | `f04ef942d` |
| #step-16 | Citation surfaces: tab strip, Gazette, Changes, History | done | `bf4fb4096` |
| #step-17 | `tag → session_id` and `/resume <tag>` | done | `1c21eefa9` |
| #step-18 | Doctrine | done | `2af33d726` |
| #step-19 | Integration checkpoint | done | `ad2187bfc` (verification only) |

#### Step 1: Tag arm in the Rust changeset feed {#step-1}

**Commit:** `tugcast(session-identity): carry the tag through the changeset feed's naming`

**References:** [P02] One resolver, (#context, #trailer-write-path), Table T02

**Artifacts:** `session_row_title` and `session_display_name` in `tugrust/crates/tugcast/src/feeds/changeset.rs` gain the tag arm; `prior_owner_name` and `display_name` speak tag before short id.

**Two visible behavior changes ride this one line — both intended, neither incidental.** (a) The tag outranks the `last_user_prompt` snippet, so a tagged session's Changes-card rows and bucket headers stop showing prompt-derived text and start showing the callsign. Expect app-test expectation churn proportional to that, and read it as the change landing, not a regression. (b) `session_row_title` today accepts *any* `name`, including an auto `aiTitle`; gating on `name_user_set` means an auto title stops fronting — at the same moment #step-4 makes auto-title capture live. That pairing is deliberate: the field becomes accurate and stops being load-bearing for display in the same phase, which is what lets [P07] retire it as the description source without losing it.

**Tasks:**
- [ ] `session_row_title(row)` precedence becomes: user-set `name` → `tag` → last-prompt snippet → 8-char id. (Note today's rule takes *any* `name` including auto ai-title; per the brief the callsign leads — only a user-set name outranks the tag. Check `name_user_set` on `SessionRow`.)
- [ ] `session_display_name(pfe)` gains the tag between user-set name and the id hash; plumb `owner_tag` onto `ProjectFileEvent` from the ledger join (the pattern of `owner_name` / `owner_name_user_set`, `session_ledger.rs` ~line 651).
- [ ] Extend the changeset feed's wire shape (`display_name` consumers) release notes in doc comments; the client hash sniff (`sessionEntryTitle`) is deleted later in #step-9 — do not break its equality detection in the interim (the fallback hash for a tagless row must remain exactly `id[..8]`). Verified benign: with the tag arm, a tagged row's `display_name` no longer equals the hash, so the sniff returns the real name/tag either way; a legacy tagless row still hits the hash path exactly — the interim needs no client change.

**Tests:**
- [ ] Rust unit tests: tagged row → tag; user-named row → name; tagless legacy row → today's exact fallbacks.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 2: Mint hardening — reroll, no NULL, no bare `-N` {#step-2}

**Commit:** `tugcast(session-identity): retire the -N suffix backstop for a full mint reroll`

**References:** [P11] Fork lineage, [P12] Tag space, Spec S05, Spec S08, (#tag-mint-hardening)

**Artifacts:** the `minted_tags` table (Spec S08); generated `session_tag_lexicon.rs` + `just` recipe + drift test; `record_spawn`'s collision path rerolls; NULL-tag landing removed.

**Tasks:**
- [ ] `minted_tags` per Spec S08 in the CREATE batch, plus a `claim_tag(tx, tag, session_id) -> Claimed | TakenByOther` helper implementing the "mine is not taken" rule. Every mint path in this plan goes through it; nothing deletes from the table, and the trash / cascade / eviction paths get a doc-comment line saying so explicitly (the obvious instinct there is to delete every row naming the session, which would silently restore recycling).
- [ ] Add the `just` recipe generating `tugrust/crates/tugcast/src/session_tag_lexicon.rs` from `tugdeck/src/lib/session-tag-lexicon.ts`; check in the output.
- [ ] Drift test: read the TS lexicon from the repo at test time; assert list equality.
- [ ] Rework the claim-or-suffix loop (`session_ledger.rs` ~line 2353): claim through `claim_tag`; on `TakenByOther`, reroll a fresh `adjective-noun` (seeded RNG acceptable — `minted_tags` is the arbiter, so the roller needs no exclusion set) and retry; bound attempts generously (e.g. 64) and on exhaustion return an error rather than landing NULL — with 524k combinations this is unreachable in practice.
- [ ] Retire `tag_base` `-N` semantics and the `TAG_SUFFIX_CAP` NULL fallback; update the `[P03]/Spec S02` doc comments that describe them. `sessions_tag` stays as the live-row invariant but stops being the thing the retry reads.
- [ ] Lineage-suffixed tags (`-A1`, `-A1-B2`) pass through the mint untouched (they arrive pre-composed from the fork path, #step-5).
- [ ] A candidate carrying lineage segments **never rerolls** — a reroll would write an unrelated `adjective-noun` into `tag` while `root_tag`/`tag_lineage` still name the lineage, a silent contradiction the resolver would render. On a `TakenByOther` for a lineage-suffixed candidate, return an error (the fork path re-allocates the segment instead, #step-5); "unreachable by construction" is an argument, not a guard.
- [ ] **The reroll is user-visible; say what the user sees.** The old `-N` path kept the minted word pair; a reroll replaces the callsign outright, and the client has already shown its optimistic tag "from the drop". The client adopts the server's tag on the `session_updated` / spawn-ack path it already rides (`session-tag-store.ts` calls this out as its authoritative source), so the callsign may change once, seconds after spawn, and is then immutable forever ([P12]). Confirm no surface caches the optimistic tag past that ack; document the behavior in `session-tag.ts`'s header rather than leaving it to be discovered.

**Tests:**
- [ ] Reroll on collision lands a different valid tag (deterministic RNG injection).
- [ ] Existing suffix tests (`record_spawn_suffixes_a_taken_tag`, `record_spawn_suffixes_a_backfill_that_collides`, ~line 5256/5329) rewritten to the reroll contract.
- [ ] No path lands `tag = NULL` for a fresh spawn.
- [ ] Negative: a colliding lineage-suffixed candidate errors rather than rerolling.
- [ ] **Permanence:** mint a tag, trash the session (and separately, run the cascade-delete path), then attempt to mint the same tag for a new session → collision + reroll. This is the test that keeps [P12] true; without it the property is a comment.
- [ ] Idempotence: re-claiming a tag for the **same** `session_id` (re-spawn / resume) succeeds without rerolling.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 3: External-session tag backfill at scan time {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(session-identity): mint real tags for external sessions at scan time`

**References:** [P12] Tag space, [Q04] External tag storage, Spec S08, (#context)

**Artifacts:** `external_scan_cache.tag`; `scan_external_sessions` (`external_sessions.rs` ~line 1123) mints and persists a real tag for each discovered session lacking one, **without** creating a `sessions` row.

**Tasks:**
- [ ] Self-healing ALTER adding `tag TEXT` to `external_scan_cache`. Per [Q04] this is where an external session's tag lives until adoption; `minted_tags` (Spec S08) carries uniqueness, which it can precisely because it is keyed by tag and indifferent to which table holds the session.
- [ ] At scan, for an external row with no tag: mint via the Rust lexicon, claim through `claim_tag` (rerolling on `TakenByOther`), and persist to `external_scan_cache.tag` in the same transaction. **Do not create a `sessions` row** — external rows synthesize `state: "closed"` / `card_id: null` and adopt on first resume, and `SessionRow.provenance` reports exactly that boundary. Minting rows at scan time would flip every discovered session from `external` to `tug` — a behavior change with nothing to do with naming.
- [ ] Adoption carry-over: when an external session is first resumed, `record_spawn` receives the already-minted tag as its candidate. `claim_tag` sees `(tag, same session_id)` and returns `Claimed` idempotently rather than rerolling a perfectly good tag — the "mine is not taken" rule in Spec S08 exists for this path.
- [ ] The external row's projection onto `SessionRow` reads `external_scan_cache.tag` so the picker sees a real tag before adoption.
- [ ] Remove the `deriveStableTag` fallbacks in `session-picker-data-source.ts` (~line 95) and `session-picker-cells.tsx` (~line 210); rows now always carry a real tag after first scan. `deriveStableTag` itself (and its remaining test usage) dies in #step-9's deletion pass.

**Tests:**
- [ ] Rust: a scan over a fixture JSONL dir lands unique persisted tags; a rescan does not re-mint.
- [ ] Rust: scanning does **not** create `sessions` rows — provenance stays `external` until first resume.
- [ ] Rust: adopt a scanned external session → the `sessions` row carries the tag minted at scan time, unchanged.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just build-app`, then `just app-test-changed` (picker rows show minted tags for external sessions)

---

#### Step 4: Live `ai-title` capture {#step-4}

**Depends on:** #step-1

**Commit:** `tugcode(session-identity): forward ai-title records into the ledger live`

**References:** [P07] Synopsis (the field is still consumed), (#context)

**Artifacts:** the bridge forwards `ai-title` stream records to tugcast as they arrive; the ledger updates `sessions.name` (with `name_user_set = 0`) without waiting for an external scan.

**Tasks:**
- [ ] In tugcode's stream-json handling (`tugcode/src/session.ts`), recognize the `ai-title` record (`aiTitle` field — the shape the external scan already parses at `external_sessions.rs` ~line 927) and forward it over the existing tugcode→tugcast session-metadata path (locate the path `/rename` uses; reuse it with `user_set: false`).
- [ ] tugcast ledger write: update `name` only when `name_user_set = 0` (never clobber a `/rename`); broadcast `session_updated`.
- [ ] **Key the write on `entry.claude_session_id`, never on `tug_session_id`.** Ledger rows are recorded under *claude's* own session id (the `record_id` choice at `session_init`, `agent_bridge.rs`), and the relay's `tug_session_id` is a different string the moment claude rotates its id or a rewind fork respawns inside the same relay — the fork path this phase adds ([P11]) makes that an ordinary occurrence rather than an edge case. Keyed by the tug id, a fork's auto title is written onto the **parent's** row, and `name_user_set = 0` there means nothing refuses it. Follow the `system_metadata` intercept next door, which snapshots `claude_session_id` for the ledger and passes `tug_session_id` for logging only; keep the tug id as the fallback the `record_id` path also falls back on.
- [ ] Rebuild the tugcode binary.

**Tests:**
- [ ] Rust: ledger update respects `name_user_set`.
- [ ] Rust (relay-level): a `session_title` arriving after a `session_init` that names a **different** claude id lands on that id's row and leaves the tug-id row untitled. A test where the two ids coincide proves nothing — it passes against the bug.
- [ ] tugcode test (existing harness style): an `ai-title` record in the stream produces the forward.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` and tugcode's test suite

---

#### Step 5: Fork carries lineage {#step-5}

**Depends on:** #step-2

**Commit:** `tugcode+tugcast(session-identity): fork threads a lineage-suffixed tag through the spawn`

**References:** [P11] Fork lineage, Spec S05, (#context)

**Artifacts:** the rewind-fork path threads `<root>-<Letter><Number>`; ledger records `root_tag` + `tag_lineage`; the original session keeps its row and tag.

**Tasks:**
- [ ] Self-healing ALTERs for `sessions.root_tag` / `sessions.tag_lineage` (`migrate_sessions_add_name_user_set` pattern). The column is `tag_lineage`, **not** `lineage` — `external_scan_cache.lineage_ancestors` already owns that word for JSONL message ancestry (Spec S05).
- [ ] Ledger allocation API: given the root session id and the rewind point (identify a point by the truncation position/message id the fork used), return the next `<Letter><Number>` — letter per distinct point, number sequencing within it — from the root's existing fork rows. The composed tag claims through `claim_tag` (Spec S08) like any other mint, so a fork's tag is permanent on the same terms.
- [ ] tugcode rewind-fork (`session.ts` ~line 7337): after minting `newId`, request the lineage tag from tugcast (or send the fork metadata with the rebind it already performs — "tell tugcast so the card→session binding is rebound + persisted") so `record_spawn` for the fork carries the composed tag + lineage fields instead of minting fresh.
- [ ] Resolver-side lineage parsing lands in #step-9 (display derives from `tag`; `root_tag` / `tag_lineage` ride `SessionRow` — add the fields to `tugdeck/src/protocol.ts` in lockstep now, defaulted null).

**Tests:**
- [ ] Rust: two forks from one point → `A1`, `A2`; a fork from a second point → `B1`; fork-of-fork → `A1-B2`; racing allocations cannot collide (ledger-serialized).
- [ ] A forced lineage-tag collision re-allocates the segment; `tag` never contradicts `root_tag`+`tag_lineage` (#step-2's guard).
- [ ] tugcode: fork rebind carries the lineage tag; original row untouched.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` and tugcode tests

---

#### Step 6: Trailer writers — citation + machine id {#step-6}

**Depends on:** #step-1

**Commit:** `tugdash-core+tugcast(session-identity): commits carry the citation and the machine id trailer`

**References:** [P10] Citation, Spec S03, (#trailer-write-path)

**Artifacts:** both commit lanes emit `Tug-Session: <tag> (<shortid8>)` + `Tug-Session-Id: <uuid>`.

**Tasks:**
- [ ] `session_trailer()` (`tugdash-core/src/ops.rs` ~line 812): select `tag` (and `name` only for the tagless fallback); return the citation per Spec S03; add a sibling returning the full id; `with_dash_trailers` (~line 844) pushes both.
- [ ] Main lane: the trailer is appended in `feeds/agent_supervisor.rs` (~line 1592, `append_trailers` over `("Tug-Session", "<name> (<id>)")`; the wire fields land at ~line 1428) — **not** in a changeset-commit handler. It emits the same pair.

  **As shipped, the tag is resolved server-side from the ledger rather than carried on the client payload — take the shipped shape, not this task's original wording.** The task said the payload should carry `tag` alongside `{ name, id }`. `do_changeset_commit` instead reads `ledger.get(session_id)?.tag` and hands it to `changeset_commit_message(request, tag)`. That is the correct authority: a callsign is the ledger's word, and the deck may still be holding the optimistic tag it minted at spawn — which, since a collision now rerolls rather than suffixes ([P12]), can differ from the real one for the first seconds of a session. A commit trailer is permanent; it must never record the tag that lost. The payload's `session_name` field goes unread by the trailer path as a result and is a deletion candidate at #step-16.
- [ ] `tugchanges_core::append_trailers` idempotency: confirm a re-draft doesn't duplicate either line (existing behavior; add the second key to its tests).
- [ ] Scribe interaction: `scribe.rs`'s `starts_structure` (~line 520) already treats any `Key: value` line as structure, so a second trailer needs no grammar change there — but scribe-authored messages get trailers appended *after* generation, so verify the wrap/reflow logic over a two-line trailer block (the existing `scribe.rs` ~line 875 fixture is the place to extend).

**Tests:**
- [ ] Rust: trailer pair content on both lanes; tagless legacy fallback; no-session-env omits both (existing `no session env` test extended).
- [ ] The old-grammar fixtures in `feeds/agent_supervisor.rs` (~line 6683) and `feeds/changeset.rs` (~line 1975) move to the new pair.
- [ ] App-test: a commit made from the **Shell route** carries both trailers. `session_trailer()` resolves through `TUG_SESSION_ID`, and env parity on that route is exactly what `dc9263805` had to repair — it is the lane most likely to silently omit the pair, and a Rust unit test cannot see it.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`

---

#### Step 7: Trailer read — typed fields, stripped body {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(session-identity): parse Tug-Session trailers into typed GitLogCommit fields`

**References:** [P10] Citation, Spec S03, (#trailer-read-path)

**Artifacts:** `GitLogCommit.tug_session` / `.tug_session_id`; body stripped of both trailer lines.

**Tasks:**
- [ ] Extend the `--format` string in `feeds/git.rs` (~line 407) with `%(trailers:key=Tug-Session,valueonly,separator=%x1e)` and the id key; extend the record parse (~line 438) and keep only the first `%x1e` value, as `tug_dash` does.
- [ ] **Widen `splitn` with the format string — this is the one way to break `parse_git_log` silently.** The load-bearing constant is `chunk.splitn(9, LOG_FIELD_SEP)` (`git.rs` ~471). Left at 9, the two new trailer values and the body all land in `fields[8]`, and every History body ships with `Tug-Session: … Tug-Session-Id: …` glued to its front — the exact ink this step exists to remove, arriving under a green suite. It becomes `splitn(11)`. Update the docstring's field map in the same edit (the trailers are fields 7–9, the body is field 10).
- [ ] **Leave the two guards alone, deliberately.** The record-vs-path discriminator is the *presence* of `%x1f` (`if !chunk.contains(LOG_FIELD_SEP)`, ~464), not a count, so extra fields cannot by themselves misfile paths — and the docstring's "told apart by separator count" phrasing is imprecise; correct it while you are in there. The `fields.len() < 7` skip exists because `subject` is `fields[6]`, an index the new trailing fields do not move; raising it to 9 would newly reject records the parser handles today and drop their paths onto `collecting = false` — i.e. it would *introduce* the misfiling the old draft of this task warned about.
- [ ] Strip `Tug-Session:` / `Tug-Session-Id:` lines from the `%b` body before shipping (and align `Tug-Dash:` stripping so History bodies carry no Tug trailer ink at all).
- [ ] Mirror the fields in `tugproto` / the TS `GitLogCommit` shape.

**Tests:**
- [ ] Rust: new-form pair parses; legacy one-line form lands in `tug_session` with `tug_session_id` None; body stripping preserves non-trailer lines and interleaved trailers.
- [ ] Rust: a commit **with files** parses with the widened record — the path chunks land on their own commit, and a subject-less record still skips its paths rather than donating them to its predecessor.
- [ ] Rust: the **regression the `splitn` cap would cause** — a commit carrying both trailers parses with a body that contains neither trailer key. This fails loudly against `splitn(9)` and is the assertion that pins the widening.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 8: Session atom tone + masthead height tokens (six themes) {#step-8}

**Commit:** `tugdeck(session-identity): theme-authored session color and masthead height`

**References:** [P05] Session color, [P08] Masthead, Spec S04

**Tasks:**
- [ ] Author the **`session` tone on the `atom` slot** in all six theme files — the four tokens in Spec S04's table, as `--tug-color(violet, …)` recipes hue-seeded from each theme's `agent` family, placed beside the slot's existing `default` / `selected` / `route` / `highlighted` tones (`brio` ~966–978). **Not** a bespoke `--tug-session-color` role token, and no `color-mix` derivation of a rest value in component CSS ([P05], [L17], [L20]).
- [ ] Add `--tug-masthead-height: 72px` beside `--tug-chrome-height` in all six (they declare it at ~line 38 today).
- [ ] **Register the pairings** in `components/tugways/theme-pairings.ts`: `--tug7-element-atom-text-normal-session-rest` and `…-icon-…` on `--tug7-surface-atom-primary-normal-session-rest` at role `control`, the border at `decorative`. Without these the audit resolves nothing for the new tone and the checkpoint below passes vacuously — `audit-theme-contrast.ts` iterates `ELEMENT_SURFACE_PAIRING_MAP`, and the `atom` slot is absent from it today. Verify by inverting one authored value to something unreadable and confirming the audit **fails**; restore it. A gate that cannot fail is not a gate.
- [ ] Regenerate the token inventory: `bun run extract:tug-token-names` rewrites `tugdeck/src/generated/tug-token-names.ts` from `styles/themes/*.css`, and `src/__tests__/extract-tug-token-names.test.ts` covers the extraction. New theme tokens that skip this land the file stale.
- [ ] Audition on the spike card against live fixtures (repoint `--gsi-session-color` at the real tokens — the spike's badge-slot borrow is scaffolding, [P05]).

**Tests:**
- [ ] `bun run audit:theme-contrast` — no theme exceeds the `brio` budget, **with the new pairings resolving** (proven by the inversion check above, not by a green run alone).

**Checkpoint:**
- [ ] `bun run audit:theme-contrast` && `bunx vite build` && `bun test tugdeck/src/__tests__/extract-tug-token-names.test.ts`

---

#### Step 9: `resolveSessionIdentity` and the great deletion {#step-9}

**Depends on:** #step-1, #step-5

**Commit:** `tugdeck(session-identity): one resolver; delete the five parallel naming rules [L02]`

**References:** [P02] One resolver, [P04] Callsign run, [P08] branch retires from identity, [P15] Liveness separate, Spec S01, Table T02

**Artifacts:** `lib/session-identity.ts` + tests; `session-card-title.ts` absorbed; `session-name.ts` deleted; `deriveStableTag` production-dead.

**Tasks:**
- [ ] Implement Spec S01 (including lineage parse from `tag` / `root_tag` / `tag_lineage` and the synopsis-aware title precedence — synopsis store wired but empty until #step-15).
- [ ] Implement `useSessionIdentity` in the same module and the same commit — `useSyncExternalStore` over the name / tag / synopsis stores **by id** (`getName` / `getTag` / `getSynopsis`, not the whole-store version tokens), delegating to the pure resolver ([L02], Spec S01). It is not a follow-on: every consumer re-pointed below is re-pointed **onto the hook**, and shipping the bare resolver first would seed exactly the stale-render bug the hook exists to prevent.
- [ ] `session-synopsis-store.ts` lands here (empty until #step-15) so the hook has its third store from the start rather than growing a subscription later. Clone `session-name-store.ts` exactly — the by-id getter plus the monotonic version is the shape the hook and the Lens respectively need.
- [ ] **No phase / liveness in the record or the hook** ([P15]). There is no session-keyed phase store to read: phase lives on a per-card `codeSessionStore` reached through `cardServicesStore`, with no reverse `session → card` index and no by-id getter. The dot stays where `cards-session-cell.tsx`'s `RowPhaseDot` already puts it — a `cardId`-keyed leaf — and #step-14 / #step-11 compose it into the row and masthead as a child.
- [ ] Re-point consumers **through the hook**: `cards-data-source.ts` `sessionLabel` (drop the `(branch)` composition — `sessionIdentityLine` has no branch), `session-picker-cells.tsx` (`sessionRowTitle` call ~line 200), the Lens session cell, the Session card's title publication, any `sessionChipDisplay` remnants. Non-React callers (clipboard, export filename, command routes) take the bare resolver.
- [ ] Delete `session-name.ts` and **both** its test files (`lib/session-name.test.ts` and `lib/__tests__/session-name.test.ts`), `sessionCardTitleOverride`, the picker's `deriveStableTag` import, and the `deriveStableTag` usage in `lib/__tests__/session-picker-data-source.test.ts` (~line 102); keep `mintTag` (client optimistic mint stays).
- [ ] Fix the Lens filter-projection `branch: null` inconsistency by removing branch from the label entirely (it was only ever in the string via the suffix).
- [ ] **This step opens a regression window; #step-11 closes it.** Today's title bar reads `project/<name>` for a renamed session (`sessionCardTitleOverride` is name → tag, name winning); after this step it reads `project/<tag>` and the name shows nowhere until the masthead's description line lands. That is why the masthead sits at #step-11 rather than after the clipboard and row work — keep the order (#strategy). Do not "fix" this by keeping a name arm on the Line string — the whole of Spec S02's "the string is constant for the life of a binding" rests on it being tag-only, and re-introducing the name would put the notification path back where [L02] says it must not be.

**Tests:**
- [ ] `session-identity.test.ts`: precedence (user name → tag → shortId), lineage parse, citation forms incl. tagless fallback, line form has no branch. (Pure derivation only — the hook is covered by the app-test below, not by a render test.)
- [ ] App-test: `/rename` a session with the picker and the Lens both visible → **both repaint without a reload**. This is the [L02] assertion; a resolver called bare would pass every unit test above and fail this one.

**Checkpoint:**
- [ ] `bun test tugdeck/src/lib/__tests__/session-identity.test.ts` && `bunx vite build`
- [ ] `just app-test-changed` (title bar reads `project/tag` with no `(branch)`; picker/Lens agree)
- [ ] `git grep -n "sessionChipDisplay\|sessionRowTitle\|sessionEntryTitle" tugdeck/src` → nothing
- [ ] `git grep -n "resolveSessionIdentity" tugdeck/src/components` → nothing (components use `useSessionIdentity`; the bare resolver is for `lib/` and non-React callers)

---

#### Step 10: `TugSessionIdentity` — chip + line tiers {#step-10}

**Depends on:** #step-8, #step-9

**Commit:** `tugdeck(session-identity): TugSessionIdentity chip and line tiers [L19][L20]`

**References:** [P01] Registers, [P03] Tiers, [P04] Run, [P05] Color, [P13] Unresolvable, Spec S02, Table T01

**Artifacts:** `tug-session-identity.tsx` / `.css`; gallery spike re-mounted on the real component (prototype `SessionAtom` / `CallsignText` retired from the spike).

**Tasks:**
- [ ] Build chip (atom: pill, session color, sizes `sm`/`2xs`, `missing` state per [P13], hover `TugPlacard`, middle-truncation for deep lineage chains with full lineage on the tooltip) and line (icon + one bold run) tiers with the owned tokens (icon gap first).
- [ ] Register in the gallery: the spike card swaps its prototypes for the real component — the spike remains the fixture bench and its CSS shrinks to scaffolding only.

**Tests:**
- [ ] App-test (`@covers` the new component + spike card): atom renders one text node for the run; missing state inert (no click intent), dashed border attribute; both sizes.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 11: The masthead {#step-11}

**Depends on:** #step-10

**Commit:** `tugdeck(session-identity): the Session card grows a masthead [L09]`

**References:** [P08] Masthead, [P14] Frontmost tab, [P15] Liveness separate, [Q03] focus stop, Spec S02, Table T01, Risk R01, Risk R04, (#masthead-in-pane)

**Artifacts:** `cardTitleStore` sidecar; `SessionMasthead` (tugways) mounted by `TugPane` into a chrome slot; `MASTHEAD_HEIGHT` constant; telemetry placard widget.

**Tasks:**
- [ ] `card-title-store.ts`: the sidecar per Spec S02 — `set(cardId, title, masthead?)` + `getMasthead(cardId)`; `get()` stays `string | null`, so the read sites need no change (verify the inventory: `tug-tab-bar.tsx` ~198/~442/~803, `deck-canvas.tsx` ~315, `host-menu-state.ts` ~1016, `tug-pane.tsx` ~1378). **Widen the equality guard** — `set` early-returns today on `this._overrides.get(cardId) === title`, which would drop a changed sidecar under an unchanged title and notify nobody; compare string *and* payload. `paneTitleBarTextFor` keeps returning the line string for list surfaces unchanged.
- [ ] `session-masthead.tsx` / `.css` ([L19]): the three lines and everything behind them — lead line (`TugSessionIdentity` line tier), description line, PULSE line (`TugPulse layout="inline"`, knobs per Table T01), trailing wave widget → `TugPlacard` with state, turns, created/compacted stamps, **branch**, and the citation + `TugCopyBadge`. It takes a `sessionId` and subscribes to everything itself via `useSessionIdentity` and the PULSE stores. **Session-domain state stays in the session family; only the slot is the pane's** (Spec S02).
- [ ] `tug-pane.tsx`: when the **active** card carries the sidecar ([P14]: the chrome follows the frontmost tab, 36↔72 on tab switch), the pane renders its chrome slot at masthead height, keeps its own pane controls in the lead line, and mounts `SessionMasthead` by `sessionId`. The pane does not read a session store.
- [ ] `MASTHEAD_HEIGHT = 72` beside `CARD_TITLE_BAR_HEIGHT`; audit both `CARD_TITLE_BAR_HEIGHT` consumers (`tug-pane.tsx` ~87, `TITLE_BAR_VISIBLE_MIN_Y` ~825, plus grep) for masthead-height awareness.
- [ ] Publish `--tugx-pane-chrome-height` on the `.tug-pane` element (`var(--tug-masthead-height)` when the masthead is up, else `var(--tug-chrome-height)`) and re-point **the four sites Risk R01 marks re-point**: `.tug-pane-title-bar` height/min-height (`tug-pane.css` ~257–258), the scrim top (~610), the sheet **clip** top (`tug-sheet.css` ~63), and the banner top (`tug-pane-banner.css` ~59, carrying its `36px` fallback across). The sheet's `max-height` (~133) **stays** — it is the standalone/no-pane fallback, and in a pane the JS clamp derives from the measured clip rect that line 63 already moves (Risk R01). The four `tug-tab-bar.css` sites (~86, ~286, ~367, ~402) **stay on `--tug-chrome-height`** — a tab row is 36px whatever the title bar does, and a masthead pane's chrome is 72 + 36 stacked, not 72 merged.
- [ ] Both re-pointed portal targets inherit the pane-scoped variable, but **confirm it rather than assume it**: `TugSheet` portals its clip into `.tug-pane` (`tug-sheet.tsx` ~1589) and `TugPaneBanner` into the card element (`tug-pane-banner.tsx` ~647). A portal target outside the `.tug-pane` subtree would see an undefined custom property and drop the whole `calc`.
- [ ] Session card publishes the sidecar beside the Line string. Note the string is now **constant for the binding's life** ([P04] drops the name, [P08] drops the branch, [P12] freezes the tag), so `set` is effectively once per binding and identity changes reach surfaces through `useSessionIdentity` instead (Spec S02) — do not build anything on a re-`set` that will not fire. Absorb the load-control bar's "Session created …" line into the placard.
- [ ] If the 36↔72 swap animates, it is `TugAnimator` ([L13]) — and background app-test windows run **no rAF**, so no assertion below may hang off the animation; assert the settled geometry.
- [ ] Overflow: middle-truncation via `TugLabel`; the masthead never reflows. `pulse/enabled` off → PULSE line absent, height unchanged.
- [ ] During this step the Z2 strip still exists — the PULSE speaks twice for the life of one step; #step-12 lands immediately after. Do not slip another commit onto `main` between the two without noting the duplication.

**Tests:**
- [ ] App-test: masthead height exactly 72; three lines with Table T01 leading; placard opens with citation + branch; one-line bar unchanged on non-session cards.
- [ ] App-test: sheet clip, scrim, and banner all seat below the 72px masthead — three measured `top` reads, one per re-pointed site. (The sheet's *bottom* is deliberately **not** asserted: the in-pane clamp measures the clip rect, so it follows the clip top for free and an assertion there would pass whether or not the work was done.)
- [ ] App-test: a `/rename` while the masthead is up repaints **the masthead's description line** (the `useSessionIdentity` contract). The tab strip / Window menu / slot-stack picker are *not* asserted to change — the Line string no longer carries the name, so they correctly show `project/tag` before and after. Asserting a repaint there would be asserting a bug.
- [ ] App-test ([P14]): a multi-tab pane stacking [Session, Text] swaps chrome 36↔72 with the active tab, both directions — **and the tab row stays 36px across the swap** (the four `tug-tab-bar.css` sites left alone; total chrome 108 on the Session tab, 72 on the Text tab).
- [ ] App-test ([L26], Risk R04): the swap must not cost the content region its React identity. Scroll the Text tab's content, switch to the Session tab and back, and assert the scroll position survived. This one is **pinning an invariant, not guarding a live hazard** — `.tug-pane-content` is an empty `ref`'d div that cards portal into, so a chrome branch has no card subtree to re-key and the failure is structurally out of reach today (Risk R04). Write it anyway: it costs one assertion and it turns "the pane portals its content" into a contract with a failing test behind it.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 12: Z2 strip removal and re-homing {#step-12}

**Depends on:** #step-11

**Commit:** `tugdeck(session-identity): remove SessionPulseStrip; re-home its behaviors into the masthead`

**References:** [P09] Strip removal, [Q03] focus stop, List L01, Risk R02

**Tasks:**
- [ ] Move the dwell queue (`MIN_DWELL_MS`, `lastSwapAtRef` coalescing, submit-clears-immediately) and the compaction pin **as code** into `SessionMasthead` (#step-11's component, Spec S02) — not into the pane's render body. Same stores, same pacing constants, same file-local shape; this is a move, not a rewrite.
- [ ] Delete `session-pulse-strip.tsx` / `.css` and the mount at `session-card.tsx` ~line 4423; delete `SESSION_CYCLE_ORDER_PULSE` (`session-card.tsx` ~line 333) and **both** its use sites (~2834 in the cycle-order composition, ~4427 on the strip's `focusOrder`) so no dangling order entry survives.
- [ ] Sparkline rides the masthead PULSE's `trailing` accessory; update the `TUG_SESSION_ROW_SPARK_WIDTH`/`_HEIGHT` pairing docstrings in `tug-session-row.tsx` to point at the new home.
- [ ] `pulse/enabled` off: the tugbank read moves with the rest; the PULSE line is absent and the masthead keeps its 72px (List L01 item 3).
- [ ] Status row: content/layout/tokens untouched; correct its seat against the prompt entry with spacing alone.

**Tests:**
- [ ] App-test: no strip in the DOM; rapid PULSE lines still dwell ≥ `MIN_DWELL_MS` in the masthead; compaction pin holds through `/compact`; `pulse/enabled` off leaves a 72px masthead with no PULSE line; status row geometry unchanged.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 13: The atom on the clipboard {#step-13}

**Depends on:** #step-10

**Commit:** `tugdeck(session-identity): the session atom joins the clipboard and wire-marker system`

**References:** [P06] Real atom, Spec S06, (#s03-citation-grammar)

**Tasks:**
- [ ] Copy path: chip copy affordance writes all flavors via `writeClipboardViaNative` (`text/plain` = the citation; sidecar `{"kind":"session",…}`; html span).
- [ ] Paste path: the composer's atom-paste handling accepts `kind: "session"` and re-materializes the chip; submitted prompts carry `` `@project/tag` `` via `wrapAtomMention`; replay re-mints via `parseAtomMentionSegments` — extend the existing kinds, no parallel mechanism.

**Tests:**
- [ ] Unit: marker wrap/parse round-trip for a session mention.
- [ ] App-test: copy from the gallery atom → paste into the Session card composer → chip re-materializes. **The harness reach is already settled** — `at0352-shell-row-copy.test.ts` treats the real system pasteboard as ground truth via local `setPasteboard` / `readPasteboard` helpers with a sentinel-then-poll pattern; borrow it rather than inventing one. Two consequences: the `text/plain` citation flavor **is** assertable today (seed a sentinel, copy, read back the citation), and the round-trip above is assertable without any new affordance because the paste half never leaves the app.
- [ ] The `dev.tug.prompt-atoms` sidecar flavor is **not** directly readable from the harness (`pbpaste` reads plain text), so do not write an assertion over it. Cover the sidecar's *composition* as a unit test on the payload builder, and let the paste round-trip stand as the end-to-end evidence that the flavor was written correctly — if the sidecar were wrong, the chip would come back as plain text.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 14: Row tier — `TugSessionRow` grows; picker + Lens adopt {#step-14}

**Depends on:** #step-10

**Commit:** `tugdeck(session-identity): four-line identity stack; picker and Lens adopt the row tier`

**References:** [P03] Tiers, [P15] Liveness separate, Table T01, Table T02, (#t01-geometry)

**Artifacts:** `TugSessionRow` gains description + metadata lines (the four-line stack) at the 16px dot size; picker leaves `TugListRow`; Lens Sessions group renders the same stack.

**Tasks:**
- [ ] Grow `TugSessionRow` per Table T01 — explicit tight line-height on every stack line; `TugPulse` knobs set to 18px bar / 13px baseline from outside ([L20]); dot ring-box overhang per the `inset` fit at 16px; 5px lead gap / 1px line gaps; 12px block padding. The Lens keeps its 28px indicator where it stands today — the size is a caller choice, not a component change.
- [ ] Picker adoption (`session-picker-cells.tsx`): four lines — callsign (dot leads, no icon), description, PULSE, metadata (`time · turns` from `SessionRow`'s `last_used_at` / `turn_count`); id leaves ink for tooltip/trash-label as today. **There is no size field on `SessionRow`** in either the TS or the Rust shape — if a size belongs on the metadata line, name its real source (the picker's own row projection, which reads the JSONL file size at scan) before writing the line; otherwise it is two facts, not three.
- [ ] Lens Sessions group adoption via the hook. **Keep `RowPhaseDot` exactly as it is** (`cards-session-cell.tsx` ~123) — a `cardId`-keyed leaf that subscribes to that card's `codeSessionStore` alone. It is passed into the row tier as the dot child ([P15]); do not fold it into the identity subscription, or every row in the Lens repaints its whole stack on any session's transcript traffic. The picker supplies the same leaf, or renders no dot for a session with no card.

**Tests:**
- [ ] App-test: row height 93px at four lines; dot on the row margin; callsign-first ordering; renamed/unnamed/external fixtures.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 15: The synopsis {#step-15}

**Depends on:** #step-4, #step-9

**Commit:** `tugcast+tugdeck(session-identity): the rolling synopsis rides the Summarize lane`

**References:** [P07] Synopsis, [Q01] trigger, [Q02] persistence, Spec S07

**Tasks:**
- [ ] `sessions.synopsis` column (self-healing ALTER); `SessionRow.synopsis` in Rust + TS lockstep; `session_updated` broadcast on write.
- [ ] The job in `shared_agent.rs` / a feed module beside `session_overview.rs`: digest composition from recent turns, prompt per Spec S07 (register rules from `headline_rules!`), Summarize lane, trigger per [Q01]'s starting point.
- [ ] Freeze rule: `name_user_set = 1` suppresses the job and the write.
- [ ] Client: `session-synopsis-store.ts`; the resolver's `title` precedence goes live (name→synopsis→null); masthead/row description lines fill in.
- [ ] Tune trigger + register against real output in-app; record the shipped constant's rationale in a doc comment ([Q01] resolution).

**Tests:**
- [ ] Rust: persistence, freeze rule, broadcast; the job never runs for `name_user_set` rows.
- [ ] App-test: a renamed session shows the name; an un-renamed one shows the synopsis after a turn; a fresh session shows an empty description line.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` && `just build-app` && `just app-test-changed`

---

#### Step 16: Citation surfaces — tab strip, Gazette, Changes, History {#step-16}

**Depends on:** #step-7, #step-10

**Commit:** `tugdeck(session-identity): every citation surface adopts the chip; the tab strip reads the pane title`

**References:** [P01] Registers, [P10] Citation, [P13] Unresolvable, Table T02, Spec S03

**Tasks:**
- [ ] Tab strip: `paneTitleBarTextFor` is the wrong shape here — it resolves the pane's **active** card, and a tab label is per-tab. `TabView` (~line 445) and the overflow menu (~line 803) in `tug-tab-bar.tsx` drop the `componentId === "text"` gate and compose per tab: `composePaneTitleBarText({ metaTitle: tab.title, titleOverride: cardTitleStore.get(tab.id) })`, hoisted as `cardTitleTextFor(cardId, registryTitle)` in `lib/pane-title.ts` beside the existing pair so the rule stays in one place.
- [ ] **Verify — do not rewrite — the overflow measurement key.** `overrideKey` (`tug-tab-bar.tsx` ~198) snapshots only the overrides, but the key actually consumed is `titleKey` (~201) = `cards.map((c) => c.title).join("|") + "|" + overrideKey`, which **already folds in the registry titles**. So the "two override-less tabs of different types collide" hazard is already covered, and `titleKey` stays a faithful superset of `cardTitleTextFor`'s inputs after this step. Confirm that and move on; widening `overrideKey` on top of it would be redundant churn.
- [ ] Gazette: `RefChip` gains a session case (the `gazette-ref-action.ts` `case "session"` intent already exists) rendering the chip via the resolver; the raw-UUID label dies.
- [ ] Changes card: the orphan hint (and bucket headers where useful) renders the chip instead of the `prior_owner_name` feed string.
- [ ] History: `tug-history-list.tsx` renders the citation chip beside the SHA + dash badge from the typed fields, resolution per Spec S03 (unresolved → [P13] slashed inert atom); trailer ink is gone from bodies (server-stripped in #step-7).
- [ ] Transcript export filename becomes `tug-session-<tag>-<shortid>` (locate the export path by grep for the current bare-hash filename).
- [ ] `gallery-commit-surfaces.tsx` fixtures (~lines 60–158) move to the two-trailer grammar — except **one** retained legacy one-line trailer, kept deliberately as the Spec S03 legacy-form specimen.

**Tests:**
- [ ] App-tests per surface: stacked Session card tab shows `project/tag`; a Gazette session ref shows the chip; History commit row shows the chip and a legacy-trailer commit resolves; an alien citation renders the slashed atom, inert.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 17: `tag → session_id` and `/resume <tag>` {#step-17}

**Depends on:** #step-9

**Commit:** `tugdeck(session-identity): the tag becomes addressable — /resume <tag>`

**References:** [P12] Tag space (addressability), Spec S01

**Tasks:**
- [ ] Reverse map on `sessionTagStore` (its header names this exact follow-on) fed from the same three sources; exact-match `resolveTag(tag) → sessionId | null`.
- [ ] `/resume <tag>` as a composer slash route (the `/` layer — the `!` namespace is retired): resolves the tag and drives the existing resume path the picker uses (`onOpen(projectDir, "resume", sessionId, display)` shape at `session-card.tsx` ~line 1790).
- [ ] Unresolvable tag → composer error affordance, not a silent no-op.

**Tests:**
- [ ] Unit: reverse-map correctness incl. lineage tags.
- [ ] App-test: `/resume <tag>` of a closed ledger session opens it.

**Checkpoint:**
- [ ] `bunx vite build` && `just app-test-changed`

---

#### Step 18: Doctrine {#step-18}

**Depends on:** #step-16

**Commit:** `tuglaws(session-identity): the session-identity decision and the masthead amendment`

**References:** [P01]–[P13], (#success-criteria)

**Tasks:**
- [ ] New `[D##]` (D130 is taken — the card-width chords; **D131** is the next free number as of this writing; re-check at landing) in `tuglaws/design-decisions.md`: session identity is one structured record produced by one resolver; every surface renders it through `TugSessionIdentity` at a declared density tier; the tag is the immutable callsign and always leads; the UUID never leads; the citation is the only sanctioned flat-text form; **liveness is not identity** ([P15]). Name the retired alternatives (per-session tint, mono callsign, incipit leading, `(branch)` suffix, bare-`-N` suffix, a bespoke session role token derived by `color-mix` outside the seven-slot system) with *do not re-propose*.
- [ ] Masthead amendment to the pane-chrome sections of `tuglaws/pane-model.md`.
- [ ] Lineage/suffix grammar recorded beside the tag machinery (module docs in `session_ledger.rs` / `session-tag.ts`).

**Checkpoint:**
- [ ] Doc review against the shipped code; links resolve.

---

#### Step 19: Integration checkpoint {#step-19}

**Depends on:** #step-3, #step-13, #step-14, #step-12, #step-15, #step-16, #step-17, #step-18

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Table T02

**Tasks:**
- [ ] Walk every Success Criteria item; walk Table T02 surface by surface in the running app.
- [ ] Grep gates: no `sessionChipDisplay|sessionRowTitle|sessionEntryTitle|deriveStableTag|sessionCardTitleOverride` production references; no `SessionPulseStrip`; no `resolveSessionIdentity` under `tugdeck/src/components` ([L02], Spec S01); no `codeSessionStore` or `cardServicesStore` reference inside `session-identity.ts` ([P15] — the hook must not have grown a phase subscription); no `DELETE FROM minted_tags` anywhere (Spec S08).
- [ ] Token gate: the `session` tone resolves in the contrast audit rather than being skipped — re-run the #step-8 inversion check (break one authored value, confirm `audit:theme-contrast` fails, restore).

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (full workspace)
- [ ] `bunx vite build` && `bun run audit:theme-contrast`
- [ ] `just app-test-changed` over the phase's accumulated diff; core tier (`just app-test`) if any pre-assertion harness file moved.

**Checkpoint:**
- [ ] All of the above green in one pass.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Tug refers to a session one way everywhere — one resolver, one component family at four tiers, one citation grammar, lineage-bearing tags, a rolling synopsis, and commit trailers that resolve — with the five parallel naming rules deleted and the doctrine recorded.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Every Success Criteria item verified (#success-criteria).
- [x] Step Status Ledger fully `done` with commits recorded.
- [x] `[D132]` doctrine entry landed; pane-model masthead amendment landed. (**D132**, not the D131 this plan guessed — that number went to Bullseye between vetting and landing, which is why the step said to re-check.)

**Acceptance tests:**
- [x] The #step-19 integration pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Phase 2: content-annotator pattern-matching for citations in free prose (prerequisites: whole-citation detector claiming the run before the commit-SHA scanner; an `AnnotationScope` on the History card).
- [ ] **Fork-aware session identity in the environment (Risk R05).** `TUG_SESSION_ID` is captured once per shell and names the tug session id, so after a rewind fork a commit's trailers cite the parent — a wrong-but-resolvable citation, the outcome [P12] calls worse than an unresolvable one. Prefer the ledger-alias shape (`tug_session_id → current claude id`) over re-exporting the env, because the same resolution is done by `tugutil changes`, `tugutil draft`, and `host ask`. **The synopsis writer's instance of this root cause is closed** (a post-audit fixup): `take_synopsis_job` now skips a session the resolver cannot key rather than falling back to the tug id, which is the same "guessing names the parent's row" hazard one write earlier. The alias, when it lands, is what lets it stop skipping.
- [ ] Mastheads for other cards with real content identity (file card path + dirty state).
- [ ] Opportunistic lexicon growth (more 4–5-letter nouns).

| Checkpoint | Verification |
|------------|--------------|
| Data layer | `cd tugrust && cargo nextest run` |
| Client build | `bunx vite build` |
| Themes | `bun run audit:theme-contrast` |
| Surfaces | `just app-test-changed` per step; #step-19 sweep |

---

### Phasing — three landing units, one numeric order {#phasing}

> This section governs how the plan is **consumed**: vetted, implemented, and closed. It changes no step, no decision, and no ordering. The nineteen steps still land in numeric order; the phases are contiguous cuts through that order, and each cut is a place where `main` is coherent and the work can stop.

#### Why the plan is cut at all {#why-phased}

The plan is right and it is large — nineteen steps across five subsystems (Rust ledger, tugcode, git trailers, theme tokens, tugdeck chrome), with fifteen decisions and eight specs behind them. Size is not a defect, but it does have one consequence worth naming: **a document this size cannot be vetted as a unit.** Each review pass samples a different slice of an enormous falsifiable surface and finds something, and the finding gets folded in as prose, and the document grows, and the next pass samples differently. That loop terminates on scope, not on quality — the yield across passes has already fallen from "this step is wrong" to "this sentence miscounts a token quartet," which is the signature of a plan that has converged on facts while its reviewing unit has not converged on size.

So the unit changes. **Each phase is vetted once, implemented, and closed** — three normal-sized plans' worth of review instead of one indefinite one.

#### The three phases {#the-three-phases}

| Phase | Steps | What it is | Standalone value on `main` |
|---|---|---|---|
| **A — Data layer** | #step-1 … #step-7 | Rust + tugcode only. Tag arm in the feed, mint hardening + `minted_tags`, external backfill, live `ai-title`, fork lineage, trailer write + read. | Real and shippable alone: the Changes card speaks callsigns, external sessions get true tags, forks stop orphaning their ledger row, and commits carry citations that resolve. **No pixel moves.** |
| **B — Consolidation and chrome** | #step-8 … #step-14 | The [D123]-shaped heart. Tokens, `resolveSessionIdentity` + the hook + the great deletion, `TugSessionIdentity`, the masthead, the strip removal, the clipboard atom, the row tier. | The five parallel naming rules are gone and every dense surface renders one identity. This is where the phase's thesis becomes visible. |
| **C — Completion** | #step-15 … #step-19 | The synopsis, the citation surfaces (tab strip / Gazette / Changes / History), `/resume <tag>`, doctrine, the integration checkpoint. | Closes the Success Criteria and records the doctrine. |

#### Where the seams fall, and why there {#phase-seams}

- **A|B is the cleanest cut in the plan.** Phase A touches no `tugdeck/src` file and Phase B's client work consumes A's wire shape (`tag` on the feed, `root_tag` / `tag_lineage` / later `synopsis` on `SessionRow`). Nothing in A depends on anything in B. If the phase were abandoned after A, `main` keeps every repair and loses nothing half-built.
- **B|C falls after the strip removal, which is the last irreversible-feeling gesture.** By the end of #step-14 the masthead carries the voice, the Z2 strip is gone with its behaviors re-homed, and both dense tiers (row, chip) exist. Everything in C is additive onto surfaces that already render correctly.
- **#step-9 → #step-11 → #step-12 is one arc and must not be cut.** #step-9 retires `sessionCardTitleOverride`'s name arm, so a `/rename` shows nowhere until the masthead's description line lands at #step-11; #step-12 must follow #step-11 immediately or the PULSE speaks twice. That arc is why Phase B cannot be subdivided further, and it is the load-bearing reason the phase boundary sits at #step-14 rather than anywhere inside 9–12 (see #strategy).

#### The two severable steps {#severable-steps}

Two steps carry no dependents and can slip a phase without blocking anything — worth knowing before the schedule pressure arrives, not after:

- **#step-13 (the clipboard atom)** depends only on #step-10 and nothing depends on it. It sits in Phase B because it is small and the component is fresh in hand, not because B needs it.
- **#step-15 (the synopsis)** is the plan's own stated last-among-features: every surface renders correctly without it (an honest empty description line), and it is the only step carrying an unresolved tuning question ([Q01]). It opens Phase C so that its in-app tuning has the whole of C to happen alongside.

Nothing else in the plan is optional. In particular #step-16 is **not** garnish despite sitting late — it is where Phase A's trailer work becomes visible (the Gazette UUID dies, the History card gets its citation chip, the tab strip stops saying "Session").

#### What closes a phase {#phase-exit}

Each phase closes on the same three things, scoped to its own steps:

- [ ] every step in the range `done` in the Step Status Ledger with its commit recorded;
- [ ] the range's checkpoints green in one pass — `cd tugrust && cargo nextest run` for A; `bunx vite build` && `just app-test-changed` (and `bun run audit:theme-contrast` where tokens moved) for B and C;
- [ ] the Success Criteria items the range is responsible for, verified — A owns the trailer, mint, fork, and permanence criteria; B owns the grep gates, the `/rename` repaint, and the contrast-pairing gate; C owns the surface criteria and the doctrine.

The full #step-19 integration pass belongs to Phase C and remains the phase-exit gate for the work as a whole. A and B do not re-run it; they run their own ranges' checkpoints and stop.
