## Logout Consolidation — One Login Surface, Logout-Tagged Interrupts {#logout-consolidation}

**Purpose:** Make TugSetup the single login surface for every logged-out state, retire the divergent per-card in-card sign-in flow, and give logout-driven interrupts a first-class "stopped for logout" end-state so a user who logs out with cards open can log back in and continue working.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-01 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug has **two independent auth surfaces that don't share truth.** The app-modal
**TugSetup** wizard (z-99990, blocking) reads `authStore.loggedIn` and opens whenever
it is `false`. The **per-card auth banner** (`dev-card.tsx` → `deriveDevCardBannerSpec`
→ `kind:"auth"`) reads the *card's own* `codeSession.lastError`, which is stamped by
tugcast's per-session spawn gate (`agent_bridge.rs`, re-probed every respawn) when it
finds a logged-out or missing `claude`. That banner has its own "Log In" button firing
its own `claude_sign_in`, and it **never updates `authStore`**. The result is that when
the CLI is logged out but `authStore` still thinks the user is signed in — an external
`claude auth logout`, an expired token, or the window right after our own logout while
old cards respawn — the user is dropped into a second, divergent login flow instead of
the wizard.

We are consolidating on one surface now because the logout feature just shipped
(`613a87cdb`, `27708852b`) and immediately exposed the gap: log out, open or respawn a
card, and you meet the wrong login UI. The fix also lets us design the "logged out with
cards still open" experience properly — interrupt every in-progress turn *before* the
auth machinery runs, tag those interrupts as logout stops, and let TugSetup offer
"Continue working" back to the interrupted cards rather than nudging a redundant new one.

#### Strategy {#strategy}

- **One writer for app auth.** The per-session auth gate becomes an authoritative
  signal into `authStore` (via a `check_auth` re-probe), so any card that hits a
  logged-out CLI opens the app-modal TugSetup over the whole deck ([P01], [Q01]).
- **Retire the redundant surface, keep the recovery.** Once the gate routes to TugSetup,
  delete the per-card `kind:"auth"` banner and its bespoke `claude_sign_in` path ([P01],
  [P05]); the gate-errored card's *recovery* moves to the existing unbind → picker
  re-present path so it isn't left with no next action ([P06]).
- **Interrupt-first logout.** Stop every in-progress turn *before* sending
  `claude_logout`, synchronously and guarded, so no turn is mid-flight when auth is
  pulled ([P02]).
- **Sidecar, not a new reason.** A logout-driven interrupt carries an optional
  `interruptReason: "logout"` marker; `turnEndReason` stays `"interrupted"` so no
  existing lifecycle logic changes ([P03]).
- **Continue working.** TugSetup's final step branches on the deck's card count so a
  post-logout re-login returns the user to their interrupted cards ([P04]).
- **Prove it on real code.** Extend the existing gallery cards (`gallery-tug-setup`,
  `gallery-alert`) as the real-code test surface; unit-test the pure derivations.

#### Success Criteria (Measurable) {#success-criteria}

- With `authStore.loggedIn === true` but the CLI logged out, opening/respawning a Dev
  card opens **TugSetup** (app-modal), shows **no** per-card sign-in banner, and the
  gate-errored card unbinds to its **picker** (no red dead-session lock). After re-login
  the wizard closes and the card resumes from the picker. (Manual: `claude auth logout` in
  a terminal, open a card; verify wizard + picker, not banner, not red lock.)
- `grep -rn 'kind:.*"auth"\|claude_sign_in\|AuthBannerVariant' tugdeck/src` returns only
  TugSetup's own `claude_sign_in` (the wizard) — no per-card sign-in path remains.
- Logging out with ≥1 card open interrupts every in-progress turn *before* the
  `claude_logout` frame is sent, and each interrupted turn's Z1B reads "Stopped — logged
  out" (unit test on the sidecar + gallery repro).
- While logged out with ≥1 card open, TugSetup's third (pending) step reads **"Continue
  working"** ("You'll return to your N open cards"), and re-login auto-closes the wizard
  back to the interrupted cards (gallery-tug-setup drives the `cardCount > 0` state).
- `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
  clean; `bun test` frontend suites pass; `cd tugrust && cargo nextest run -p tugcast`
  passes.

#### Scope {#scope}

1. Route tugcast's per-session auth gate (`auth_required` / `claude_missing`) into
   `authStore` so TugSetup is the single logged-out surface.
2. Retire the per-card auth banner and its `claude_sign_in` path, moving the gate-errored
   card's recovery to the existing unbind → picker re-present path.
3. Add an `interruptReason` sidecar to the interrupt path (store → reducer → `TurnEntry`).
4. Render a logout-flavored variant of the interrupted Z1B end-state (badge + popover).
5. Reorder `tug-logout.tsx` to interrupt-first and tag interrupts as logout stops.
6. Add TugSetup's "Continue working" step for a post-logout deck with cards open.
7. Gallery real-code coverage + integration checkpoint.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing tugcast's auth-gate mechanism itself (it already emits the right cause).
- Auto-resuming interrupted turns after re-login — the user resubmits (see [Q02]).
- Reworking the logout confirm/error alerts (shipped, unchanged).
- A distinct `TurnEndReason` value for logout — deliberately avoided ([P03]).
- Persisting a "was logged out here" marker across a full app reload / JSONL replay
  (see [Q02] — the sidecar is a live-session concern).

#### Dependencies / Prerequisites {#dependencies}

- The shipped logout flow (`authStore.loggingOut` / `logout-store.ts` /
  `tug-logout.tsx`, commits `613a87cdb`, `27708852b`).
- `authStore.applyResult` as the single writer of app login state (`auth-store.ts`).
- tugcast's per-session auth gate already stamping `session_state_errored` with
  `auth_required` / `claude_missing` (`agent_bridge.rs`).

#### Constraints {#constraints}

- Tuglaws: [L02] external state → React only via `useSyncExternalStore`; [L06]
  appearance via CSS/DOM, not React state; [L24] imperative/transition-driven store
  writes, not component effects that mirror state. TugSetup and the re-probe must obey
  these — the re-probe is fired as a transition, not a render effect.
- Warnings-are-errors in Rust; tugdeck verified with **both** `tsc --noEmit` and
  `vite build` (production rollup catches what dev esbuild misses).
- Only the user commits, except `/tugplug:commit` / authorized autonomous steps.

#### Assumptions {#assumptions}

- A `check_auth` re-probe is cheap (a local `claude auth status` shell-out) and safe to
  fire when a card reports the auth-gate cause.
- CASE A interrupts (no answer content) commit no `TurnEntry`, so there is no row to tag
  for those — acceptable ([Q02]).
- The deck's card count (`useDeckManager().getSnapshot().cards.length`) is the right
  signal for "the user has work to return to" post-logout.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite decisions/specs/anchors, never line
numbers. Plan-local decisions use `[P01]`; global decisions are cited as `[D##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Re-probe vs. direct authStore write on the auth gate (DECIDED) {#q01-reprobe-vs-write}

**Question:** When a card reports `auth_required` / `claude_missing`, do we write
`authStore.applyResult(false, …)` directly, or fire a `check_auth` re-probe and let the
`claude_auth_result` frame settle the store?

**Why it matters:** `authStore` documents itself as fed *exclusively* by
`claude_auth_result` frames (one writer). A direct write introduces a second writer and
risks disagreeing with the CLI's real state (e.g. the card's cause is stale but the user
is actually still logged in).

**Options:**
- Re-probe (`check_auth`) — keeps `authStore.applyResult` the single writer; the probe
  returns the true `logged_out` vs `claude_missing` reason.
- Direct write — one fewer round-trip, but a second writer and a guessed reason.

**Plan to resolve:** Grounded in `auth-store.ts` (single-writer invariant) and
`main.tsx` (re-probe is already the reconnect pattern).

**Resolution:** DECIDED (see [P01]) — re-probe. The card's cause is a *trigger*; the
re-probe is the *authority*.

#### [Q02] Tagging CASE A interrupts and surviving reload (DEFERRED) {#q02-casea-and-reload}

**Question:** CASE A interrupts (no answer content yet) commit no `TurnEntry`, so there's
no row to carry `interruptReason`. And the sidecar is live-session state — should it
survive a full app reload / JSONL replay?

**Why it matters:** A user could log out mid-CASE-A turn, or reload the app after a
logout, and the "Stopped — logged out" marker would be absent.

**Options:**
- Accept the gap — CASE A restores the draft to the editor (nothing committed to mark);
  reload re-resumes from JSONL where the wire already recorded the turn as interrupted.
- Persist a per-turn logout marker into the transcript model.

**Plan to resolve:** Read the CASE A path in `code-session-store.ts` (draft restore, no
`TurnEntry`) and the reload invariant ([HMR vs Reload]).

**Resolution:** DEFERRED — accept the gap for this phase. CASE A commits no row by design;
persisting the marker across reload is not worth the transcript-model change now. Revisit
only if users report confusion. The marker is a live-session affordance.

#### [Q03] Keep any card-local `claude_missing` hint? (DECIDED) {#q03-claude-missing-hint}

**Question:** Retiring the per-card auth banner also removes its `claude_missing`
guidance. Do we keep a card-local hint for the missing-CLI case?

**Why it matters:** `claude_missing` is a different remedy (install) than `auth_required`
(log in); dropping the card banner must not lose the install path.

**Resolution:** DECIDED (see [P05]) — route `claude_missing` to TugSetup too. The wizard's
install step covers it better and consistently with "one surface."

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Auth-gate re-probe loops / storms | med | low | Fire the re-probe once per distinct auth-gate error occurrence, guard against repeat for the same `lastError.at` | Re-probe fires >1× for one gate error |
| Interrupt-first reorder strands the logout critical path | high | low | Keep the interrupt loop synchronous + `try`-guarded with no `await` before `claude_logout` | Logout hangs after a card throws |
| Losing the card-local `claude_missing` hint | low | low | TugSetup install step covers it ([P05]) | User can't find install path |

**Risk R01: Auth-gate re-probe storm** {#r01-reprobe-storm}

- **Risk:** Every render while a card holds an `auth_required` `lastError` could fire a
  fresh `check_auth`.
- **Mitigation:** Route the re-probe through the card observer as a transition keyed on
  the error identity (`lastError.at`), not a render-body effect ([L24]); fire once per
  occurrence.
- **Residual risk:** Two cards hitting the gate simultaneously each fire one probe — two
  probes converge on the same `loggedIn=false` result, harmless.

**Risk R02: Interrupt-first strands logout** {#r02-interrupt-first-strand}

- **Risk:** Moving the interrupt loop ahead of `claude_logout` reintroduces the
  ordering the `27708852b` fix guarded against.
- **Mitigation:** The loop is synchronous and `try`-guarded; no `await` sits between the
  loop and the `sendControlFrame("claude_logout")` ([P02]).
- **Residual risk:** None material — a throwing card is swallowed and logout still fires.

---

### Design Decisions {#design-decisions}

#### [P01] The per-session auth gate is authoritative for app auth (DECIDED) {#p01-gate-authoritative}

**Decision:** When a card's session errors with the auth-gate cause
(`session_state_errored` whose message is `auth_required` or `claude_missing`), fire a
`check_auth` re-probe so `authStore` settles to the true logged-out state and the
app-modal TugSetup opens over the deck.

**Rationale:**
- tugcast's gate is the one place that authoritatively knows a card met a logged-out
  CLI; today it tells only that card, never `authStore` — the root of the two-surface split.
- A re-probe keeps `authStore.applyResult` the single writer ([Q01]) and returns the
  real reason (`logged_out` vs `claude_missing`).

**Implications:**
- The card observer gains a transition that fires `check_auth` on the auth-gate cause,
  keyed on the error occurrence to avoid storms ([L24], [R01]).
- Once `authStore.loggedIn` flips `false`, TugSetup blocks the deck — the per-card banner
  becomes redundant and is removed ([P05]).

#### [P02] Interrupt-first logout ordering (DECIDED) {#p02-interrupt-first}

**Decision:** In `tug-logout.tsx`, stop every in-progress turn *before* sending
`claude_logout`; the interrupt loop stays synchronous and `try`-guarded with no `await`
before the logout frame.

**Rationale:**
- Stopping turns cleanly before the auth rug is pulled is the correct lifecycle order
  (the user's intent).
- Keeping the loop synchronous and guarded preserves the property the `27708852b` fix
  protected (a throwing card can't strand logout).

**Implications:**
- The current "fire `claude_logout` first" ordering is reversed; the defensive guard stays.
- Each interrupt is tagged `"logout"` ([P03]).

#### [P03] Logout interrupt is a sidecar, not a new TurnEndReason (DECIDED) {#p03-sidecar}

**Decision:** Thread an optional `interruptReason: "logout"` through `interrupt(reason?)`
→ the `interrupt_action` event → the committed `TurnEntry`. `turnEndReason` stays
`"interrupted"`; Z1B reads the sidecar to relabel the badge.

**Rationale:**
- A new `TurnEndReason` value would ripple through the reducer, telemetry, popovers, the
  badge map, and `end-state.ts` — for what is a *flavor* of an interrupt, not a new
  terminal state.
- The sidecar leaves every existing lifecycle branch untouched; un-tagged interrupts read
  "Interrupted" exactly as today.

**Implications:**
- `CodeSessionStore.interrupt` gains an optional param; `interrupt_action` carries it.
- Because CASE B commits the `TurnEntry` **later** (at `handleTurnComplete`, not in
  `handleInterrupt` — see `#reducer-interrupt-commit-point`), the reason is threaded via a
  new reducer-state field `pendingInterruptReason`, read by `buildTurnEntry` and cleared by
  `handleTurnComplete` (Spec S02).
- `TurnEntry` gains an optional `interruptReason` field.
- `dev-card-z1b.tsx` and the Z1B telemetry popover read the field for logout-flavored copy.
- CASE A interrupts commit no row, so they carry no marker ([Q02]).

**Deep dive — where the interrupted entry is actually committed** {#reducer-interrupt-commit-point}

`handleInterrupt` has two arms. CASE A (no answer content) is locally terminal: it resets
to `idle`, appends no `TurnEntry`, and suppresses the wire echo — nothing to tag. CASE B
(content has begun) does **not** commit either; it sets `interruptInFlight: true` and sends
the `interrupt` frame, then the wire's `turn_complete(result:"error")` lands at
`handleTurnComplete`, which maps `interruptInFlight` → `turnEndReason: "interrupted"` and
calls `buildTurnEntry`. That is the single place the interrupted row is built and therefore
the place `interruptReason` must be stamped — from the stashed `pendingInterruptReason`.

#### [P04] TugSetup "Continue working" is a logged-out third-step preview (DECIDED) {#p04-continue-working}

**Decision:** When `loggedIn === false && cardCount > 0`, TugSetup's third (pending) step
reads **"Continue working"** — "You'll return to your N open cards" — instead of "Start a
Claude Code session." There is **no** active step and **no** Done CTA: on successful
re-login the wizard auto-closes back to the cards. The zero-card case is unchanged
("Start a Claude Code session" → "Open a Dev Card").

**Rationale:**
- After a logout with cards open, nudging a *new* card is wrong — the user has work to
  return to; the third step should tell them what re-login restores.
- **The active "Continue working" + Done CTA framing does not work.** `open = notReady ||
  needsFirstSession || …` with `needsFirstSession = loggedIn && cardCount === 0 && …`. The
  moment re-login lands with cards open (`loggedIn && cardCount > 0`), both `notReady` and
  `needsFirstSession` are false → `open = false`, the wizard is already gone. And `openStep`
  only becomes `active` when logged in. So an active Continue-working step could never
  render — the one moment it would apply is the moment the wizard closes
  (`#tugsetup-open-derivation`). The preview framing lives in the *logged-out* window,
  which is exactly when the wizard is up.

**Implications:**
- Only the third step's **pending** label/detail branch on `cardCount`; the `open`
  derivation is untouched (no post-login hold). D105's copy table gains the preview row.
- Re-login returns the user to their cards via the existing auto-close — no new CTA path.

**Deep dive — TugSetup open derivation** {#tugsetup-open-derivation}

`open = deriveTugSetupOpen(gateOpen, forced || notReady || needsFirstSession || probing)`.
With `notReady = loggedIn === false` and `needsFirstSession = loggedIn && cardCount === 0
&& !openedFirstSession`, the only states where the wizard is open **and** logged in is
`cardCount === 0` (needs first session). A logged-in deck with cards open is closed by
construction — hence the preview must render while still logged out.

#### [P05] `claude_missing` routes to TugSetup too (DECIDED) {#p05-claude-missing-to-setup}

**Decision:** Retire the per-card auth banner for *both* `auth_required` and
`claude_missing`; the re-probe surfaces `claude_missing` as `authStore.reason`, which
TugSetup's install step handles.

**Rationale:**
- One surface for every logged-out/needs-install state; the wizard's install step is a
  better remedy than a card-local hint ([Q03]).

**Implications:**
- `AuthBannerVariant`, the `kind:"auth"` banner branch, `renderDevCardBanner`'s auth arm,
  and `dev-card.tsx`'s local `signingIn` / `handleSignIn` / `claude_sign_in` /
  `DEV_FORCE_AUTH_BANNER` are all removed, along with their tests.
- The removed banner was also the card's *recovery affordance*; [P06] defines its
  replacement so a gate-errored card isn't left with no next action.

#### [P06] A gate-errored card re-presents the picker, not a red lock or a limbo (DECIDED) {#p06-gate-errored-recovery}

**Decision:** When a card's session errors at the auth gate (`session_state_errored` /
`auth_required` | `claude_missing`), the observer — in the same place it fires the
`check_auth` re-probe ([P01]) — also **unbinds the card and stashes a picker notice**,
reusing the existing `resume_failed` machinery (`pickerNoticeStore.set` +
`cardSessionBindingStore.clearBinding` in `useDevCardObserver`). The cleared binding makes
`useDevCardServices` return null → the card re-renders the **picker** with a "Signed out —
reopen this session" notice. After re-login via TugSetup, the user resumes from the picker.

**Rationale:**
- Removing the per-card auth banner ([P05]) removes the only recovery affordance a
  gate-errored card had. Without a replacement, that card is left either as a red
  dead-session lock (wrong tone — a logout is not breakage) or a no-affordance limbo
  (`lastError` set, banner gone, `sessionErrored` carve-out keeping it out of the lock).
- The `resume_failed` path already models exactly this recovery — unbind → picker
  re-presents with a notice — so we reuse it rather than invent a surface.
- This keeps the gate-errored (case C) card distinct from the logout-**interrupted**
  (case B) card: the interrupted card's session stays alive and resumes in place
  ("Continue working", [P04]); only the gate-**errored** card, whose `spawn_state` is
  `Errored`, unbinds and re-presents.

**Implications:**
- `useDevCardObserver` gains a second branch for the auth-gate cause: fire `check_auth`
  ([P01]) **and** `pickerNoticeStore.set(cardId, {category:"signed_out", …})` +
  `clearBinding(cardId)`. A new `signed_out` picker-notice category + its copy.
- The `sessionErrored` dead-session carve-out for auth causes in `dev-card.tsx` becomes
  moot (the card unbinds before it could lock) and is removed with the banner in Step 2.
- No red dead-session lock and no in-card sign-in for a gate-errored card — the app-modal
  TugSetup owns login; the picker owns per-card resume.

---

### Specification {#specification}

**Spec S01: Auth-gate → authStore routing** {#s01-gate-routing}

- The card observer subscribes to its `CodeSessionStore` snapshot. When
  `lastError.cause === "session_state_errored"` and `lastError.message ∈ {auth_required,
  claude_missing}`, and this occurrence (`lastError.at`) has not already been handled, it
  (a) fires `getConnection()?.sendControlFrame("check_auth")`, and (b) unbinds the card
  and stashes a `signed_out` picker notice ([P06]), then records the handled `at`.
- tugcast answers `claude_auth_result`; `applyAuthResultPayload` sets
  `authStore.loggedIn = false` with `reason ∈ {logged_out, claude_missing}`.
- TugSetup's existing `notReady = loggedIn === false` opens the wizard app-modally; the
  unbound card re-renders the picker underneath ([P06]).
- Dedup: the observer's existing `consumedLastErrorAtRef` (today scoped to the
  `resume_failed` early-return) is shared — the auth-gate and `resume_failed` causes are
  mutually exclusive for a given `lastError.at`, so one `at`-keyed guard covers both.

**Spec S02: `interruptReason` sidecar** {#s02-interrupt-reason}

The interrupted `TurnEntry` is **not** built at interrupt time. `handleInterrupt` CASE B
(`#reducer-interrupt-commit-point`) only sets `interruptInFlight: true` and sends the
`interrupt` frame; the entry is committed later in `handleTurnComplete` → `buildTurnEntry`,
where `turnEndReason` is derived from `state.interruptInFlight`. So the reason must be
**stashed in reducer state** at interrupt time and read at commit time — it cannot be
"copied onto the appended entry in the interrupt handler," because no entry is appended there.

- `CodeSessionStore.interrupt(reason?: "logout")` → `dispatch({ type: "interrupt_action",
  reason })`.
- `handleInterrupt` **CASE B** stashes `pendingInterruptReason: reason ?? null` on reducer
  state, alongside the existing `interruptInFlight: true`.
- `buildTurnEntry` reads `state.pendingInterruptReason` and sets `interruptReason` on the
  committed entry **only when** `turnEndReason === "interrupted"`.
- `handleTurnComplete` clears `pendingInterruptReason` (to `null`) alongside the existing
  `interruptInFlight` reset.
- CASE A appends no row and is locally terminal, so it carries no marker — set/leave
  `pendingInterruptReason: null` there for cleanliness ([Q02]).
- `TurnEntry.interruptReason` is optional; absent for every non-logout interrupt. The
  replay path (`turn_complete(result:"interrupted")` with no `interruptInFlight`) never
  sets it — consistent with [Q02] (the marker is a live-session concern; JSONL does not
  carry it).

**Spec S03: Z1B logout end-state copy** {#s03-z1b-copy}

- When `turn.turnEndReason === "interrupted"` and `turn.interruptReason === "logout"`,
  the Z1B badge renders with the existing interrupted tone (`caution`) and glyph
  (`ShieldAlert`) but text **"Stopped — logged out"**.
- The Z1B telemetry popover reads the same field so its row text matches ([D19]
  one-source-of-truth).
- All other interrupts render "Interrupted" unchanged.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Auth-gate re-probe trigger | external-data (transition) | imperative `sendControlFrame("check_auth")` fired from the observer on the gate cause, keyed on `lastError.at`; never a render-body mirror | [L24], [L02] |
| App login state (`loggedIn`/`reason`) | external-data | `authStore` + `useSyncExternalStore` (single writer `applyResult`) | [L02] |
| `pendingInterruptReason` (interrupt→commit bridge) | structure/session-data | `CodeSessionStore` reducer state: set in `handleInterrupt` CASE B, read in `buildTurnEntry`, cleared in `handleTurnComplete` | [L02] |
| `interruptReason` on `TurnEntry` | structure/session-data | `CodeSessionStore` reducer state, read via `useSyncExternalStore` | [L02] |
| Logout-flavored badge text/tone | appearance | pure render + CSS class / `data-*`; no React appearance state | [L06] |
| TugSetup "Continue working" branch | derived | pure read of `authStore` + deck `cardCount` | [L02] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure derivations: `interruptReason` propagation, Z1B copy mapping, TugSetup step branch, banner-spec no longer emits `auth` | Reducer/selector/derivation logic |
| **Integration** | tugcast auth-gate → `claude_auth_result` → `authStore` route | Verify the wizard opens on the gate cause |
| **Gallery (real-code)** | `gallery-tug-setup` drives the `cardCount>0` "Continue working" state; `gallery-alert` app-level logout repro tags interrupts | Manual/visual real-code proof |

#### What stays out of tests {#test-non-goals}

- No jsdom/render tests for TugSetup or the card banner — pure logic is extracted to
  CSS-free modules and unit-tested; visual states are proved on the gallery (real-code),
  per project testing doctrine.
- No mock-store assertions — drive the real `CodeSessionStore`/`authStore`.

---

### Execution Steps {#execution-steps}

> Commit after each step's checkpoints pass. tugdeck steps verify with **both**
> `./node_modules/.bin/tsc --noEmit` and `./node_modules/.bin/vite build`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Route auth gate → authStore | done | df318b492 |
| #step-2 | Retire per-card auth banner | done | 46ce7eae5 |
| #step-3 | `interruptReason` sidecar | done | 42f056bbe |
| #step-4 | Z1B logout end-state copy | done | 7d5eda62f |
| #step-5 | Interrupt-first logout + tag | done | 12af1bfd4 |
| #step-6 | TugSetup "Continue working" | done | 8b98dc970 |
| #step-7 | Gallery coverage + integration | done | 11109332c |

#### Step 1: Route the per-session auth gate into authStore {#step-1}

**Commit:** `feat(tugdeck): route card auth-gate to authStore so TugSetup owns login`

**References:** [P01], [P06], [Q01], Spec S01, Risk R01, (#p01-gate-authoritative, #p06-gate-errored-recovery, #s01-gate-routing, #state-zone-mapping)

**Artifacts:**
- Card observer (`use-dev-card-observer.ts`) gains an auth-gate branch: a one-shot
  `check_auth` re-probe **and** an unbind + `signed_out` picker notice, keyed on
  `lastError.at`.
- New `signed_out` `pickerNoticeStore` category + its copy.

**Tasks:**
- [ ] In the card observer, add a branch for `lastError.cause === "session_state_errored"`
  with message `auth_required`/`claude_missing`, deduped by `lastError.at` (shared with the
  existing `resume_failed` guard — mutually exclusive causes): fire
  `sendControlFrame("check_auth")` (transition, not render mirror — [L24]).
- [ ] In that same branch, unbind the card and stash the notice: `pickerNoticeStore.set(
  cardId, {category:"signed_out", …})` + `cardSessionBindingStore.clearBinding(cardId)`
  ([P06]) — mirroring the existing `resume_failed` handling.
- [ ] Add the `signed_out` category to `pickerNoticeStore` and its picker copy.
- [ ] Confirm `applyAuthResultPayload` maps `claude_missing`/`logged_out` reasons through
  to `authStore` (already implemented — verify, no change expected).

**Tests:**
- [ ] Unit: the observer's guard fires once for one `lastError.at` and not again on
  re-render; the auth-gate branch produces exactly one `check_auth` + one unbind (extract
  the guard/classify predicate to a pure helper if needed).

**Checkpoint:**
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [ ] Manual: `claude auth logout` in a terminal, open a Dev card → TugSetup opens.

---

#### Step 2: Retire the per-card auth banner and its sign-in path {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(tugdeck): remove per-card auth banner; TugSetup is the sole login surface`

**References:** [P01], [P05], [P06], [Q03], (#p05-claude-missing-to-setup, #p06-gate-errored-recovery, #q03-claude-missing-hint)

**Artifacts:**
- `dev-card-banner-spec.ts` no longer emits `kind:"auth"`; `AuthBannerVariant` removed.
- `dev-card.tsx` auth branch in `renderDevCardBanner`, local `signingIn`/`handleSignIn`/
  `claude_sign_in`, `DEV_FORCE_AUTH_BANNER`, and the `sessionErrored` auth carve-out removed.

**Tasks:**
- [ ] Drop the `auth` arm from `deriveDevCardBannerSpec` (keep `error`/`none`); remove
  `AuthBannerVariant` and update the discriminated union + its test.
- [ ] Remove `renderDevCardBanner`'s `spec.kind === "auth"` branch and the `onSignIn`/
  `signingIn` params it needed.
- [ ] Remove `dev-card.tsx`'s `signingIn` state, `handleSignIn`, the `claude_sign_in`
  send, and `DEV_FORCE_AUTH_BANNER`. Remove the `sessionErrored` auth carve-out too: the
  gate-errored card now **unbinds** and re-presents the picker ([P06]) before it could
  lock, so the card never reaches the dead-session branch with an auth cause — the special
  case is dead code.
- [ ] Delete now-dead auth-banner assertions in `dev-card-banner-spec.test.ts`.

**Tests:**
- [ ] Unit: `deriveDevCardBannerSpec` returns `none` for a `session_state_errored`/
  `auth_required` snapshot (the gate now routes to TugSetup + the picker, not the card).

**Checkpoint:**
- [ ] `grep -rn 'kind:.*"auth"\|AuthBannerVariant' tugdeck/src` → no matches.
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [ ] `cd tugdeck && bun test src/components/tugways/cards/__tests__`

---

#### Step 3: Add the `interruptReason` sidecar {#step-3}

**Commit:** `feat(tugdeck): thread interruptReason sidecar through the interrupt path`

**References:** [P03], Spec S02, (#p03-sidecar, #s02-interrupt-reason)

**Artifacts:**
- `CodeSessionStore.interrupt(reason?)`, `interrupt_action` event field, a
  `pendingInterruptReason` reducer-state bridge, and `TurnEntry.interruptReason?` stamped
  at `handleTurnComplete`.

**Tasks:**
- [ ] `interrupt(reason?: "logout"): void` → `dispatch({ type: "interrupt_action", reason })`.
- [ ] Add `reason?: "logout"` to the `interrupt_action` event type (`events.ts`).
- [ ] Add `pendingInterruptReason: "logout" | null` to reducer state (init `null`); set it
  in `handleInterrupt` **CASE B** alongside `interruptInFlight: true`; leave/set `null` in
  CASE A. Do **not** attempt to stamp the entry in `handleInterrupt` — no entry is built
  there (`#reducer-interrupt-commit-point`).
- [ ] In `buildTurnEntry`, set `interruptReason` from `state.pendingInterruptReason` when
  `turnEndReason === "interrupted"`.
- [ ] In `handleTurnComplete`, clear `pendingInterruptReason` to `null` alongside the
  existing `interruptInFlight` reset.
- [ ] Add `interruptReason?: "logout"` to `TurnEntry` (`types.ts`) with a doc comment.

**Tests:**
- [ ] Unit: driving a real `CodeSessionStore` through a content-bearing turn then
  `interrupt("logout")` yields a committed `TurnEntry` with `turnEndReason:"interrupted"`
  and `interruptReason:"logout"`; `interrupt()` (no arg) yields `interruptReason`
  undefined.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__ && ./node_modules/.bin/tsc --noEmit`

---

#### Step 4: Z1B logout-flavored interrupted end-state {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): Z1B shows "Stopped — logged out" for logout interrupts`

**References:** [P03], Spec S03, [D19], (#s03-z1b-copy)

**Artifacts:**
- `dev-card-z1b.tsx` + `end-state.ts` badge mapping read `interruptReason`; the Z1B
  telemetry popover matches.

**Tasks:**
- [ ] Change the shared helper signature to `endStateBadgeFor(reason, interruptReason?)`:
  return text "Stopped — logged out" when `reason === "interrupted"` and
  `interruptReason === "logout"`, keeping tone `caution` and the `ShieldAlert` glyph;
  otherwise unchanged. This is the one helper both consumers call, so both stay in sync
  ([D19]).
- [ ] Update **both** call sites to pass `turn.interruptReason`: `EndStateDisplay` in
  `dev-card-z1b.tsx` and `TurnEndStateBadge` in `dev-card-telemetry-popovers.tsx`.
- [ ] Pass `interruptReason` from the transcript row into `DevZ1B`/`EndStateDisplay`.

**Tests:**
- [ ] Unit: the badge helper returns "Stopped — logged out"/`caution` for a logout
  interrupt and "Interrupted"/`caution` otherwise.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__ src/components/tugways/cards/__tests__`
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`

---

#### Step 5: Interrupt-first logout, tagged as a logout stop {#step-5}

**Depends on:** #step-3

**Commit:** `feat(tugdeck): interrupt turns before logout and tag them as logout stops`

**References:** [P02], Risk R02, (#p02-interrupt-first, #r02-interrupt-first-strand)

**Artifacts:**
- `tug-logout.tsx` reordered: interrupt loop (tagged `"logout"`) runs before
  `sendControlFrame("claude_logout")`.

**Tasks:**
- [ ] Move the `try`-guarded interrupt loop ahead of the `claude_logout` send; call
  `services.codeSessionStore.interrupt("logout")` for each `canInterrupt` card.
- [ ] Keep the loop synchronous with no `await` between it and `setLoggingOut(true)` +
  `sendControlFrame("claude_logout")` ([R02]).

**Tests:**
- [ ] Covered by the gallery repro in #step-7 (real-code interrupt loop + tag); the pure
  tag propagation is unit-tested in #step-3.

**Checkpoint:**
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [ ] Manual: run `/logout` with a card mid-turn → the turn shows "Stopped — logged out".

---

#### Step 6: TugSetup "Continue working" step {#step-6}

**Commit:** `feat(tugdeck): TugSetup offers "Continue working" when cards are open`

**References:** [P04], [D105], (#p04-continue-working)

**Artifacts:**
- `tug-setup.tsx` `openStep` **pending** branch reads `cardCount`; D105 copy table updated.

**Tasks:**
- [ ] Branch only the third step's **pending** (logged-out) copy on `cardCount`:
  `cardCount === 0` → "Start a Claude Code session"; `cardCount > 0` → "Continue working"
  / "You'll return to your N open cards." Leave the logged-in `active` branch ("Open a Dev
  Card") and the `open` derivation untouched — re-login auto-closes the wizard back to the
  cards ([P04], `#tugsetup-open-derivation`).
- [ ] Update the D105 copy table in `tuglaws/design-decisions.md` with the preview row.

**Tests:**
- [ ] Unit: extract the pending third-step label/detail choice to a pure helper (like
  `tug-setup-copy.ts`) and test both `cardCount` branches (0 vs >0).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__`
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`

---

#### Step 7: Gallery real-code coverage + integration checkpoint {#step-7}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6

**Commit:** `test(tugdeck): gallery coverage for consolidated logout + integration checkpoint`

**References:** [P01], [P02], [P03], [P04], (#success-criteria)

**Artifacts:**
- `gallery-tug-setup` drives the `cardCount>0` "Continue working" state; `gallery-alert`
  app-level logout repro reports tagged interrupts.

**Tasks:**
- [ ] Extend `gallery-tug-setup.tsx` to simulate the "Continue working" state from local
  data.
- [ ] Extend the `gallery-alert` app-level logout repro to assert the interrupt loop tags
  `"logout"` and report the outcome.

**Tests:**
- [ ] Full frontend suites:
  `cd tugdeck && bun test src/lib/__tests__ src/__tests__ src/components/tugways/__tests__ src/components/tugways/cards/__tests__`

**Checkpoint:**
- [ ] `cd tugdeck && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] Manual: external `claude auth logout` → open card → TugSetup (no card banner);
  `/logout` with cards → "Stopped — logged out" + re-login shows "Continue working".

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every logged-out state routes to the single app-modal TugSetup surface;
the per-card sign-in flow is gone; logout interrupts are tagged and surfaced as "Stopped —
logged out"; and a post-logout re-login returns the user to their interrupted cards via a
"Continue working" step.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] A logged-out CLI with stale `authStore.loggedIn===true` opens TugSetup on card
  open/respawn, with no per-card sign-in banner; the gate-errored card unbinds to its
  picker (no red lock) and resumes there after re-login. (Manual + `grep` for removed symbols.)
- [ ] Logout interrupts every in-progress turn before `claude_logout`, and those turns
  read "Stopped — logged out" in Z1B and the popover. (Unit + gallery.)
- [ ] Post-logout re-login with cards open shows "Continue working". (Gallery + unit.)
- [ ] `tsc --noEmit` + `vite build` clean; frontend suites + `cargo nextest -p tugcast` pass.

**Acceptance tests:**
- [ ] `interruptReason` propagation unit test (real store).
- [ ] Z1B badge-copy unit test (logout vs plain interrupt).
- [ ] TugSetup step-branch unit test (`cardCount` 0 vs >0).
- [ ] `deriveDevCardBannerSpec` returns `none` for the auth-gate cause.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Persist / re-derive the logout marker across a full app reload / JSONL replay ([Q02]).
- [ ] Surface a logout marker for CASE A (no-content) interrupts, if users report confusion.
- [ ] Optional: auto-resume interrupted turns after re-login.

| Checkpoint | Verification |
|------------|--------------|
| Single login surface | `grep -rn 'kind:.*"auth"\|AuthBannerVariant' tugdeck/src` → none |
| Logout-tagged interrupts | `bun test src/lib/__tests__` (sidecar) + gallery repro |
| Continue working | `bun test src/components/tugways/__tests__` + gallery-tug-setup |
| Build health | `tsc --noEmit` + `vite build` + `cargo nextest run -p tugcast` |
