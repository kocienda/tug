## Error Management & Reporting: Transient Notices as Bulletins {#error-handling}

**Purpose:** Stop treating self-healing model interruptions as card-locking breakage — move every transient interruption (API retries, transport blips, replay-timeout dwell, unknown events, model-refusal fallback, output truncation) onto a non-blocking, live-updating, top-right pane bulletin, and reserve the locking `TugPaneBanner` exclusively for genuine `error` breakage.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-21 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Resuming a large session (≈600k tokens) submits the entire history as the first API request — the single largest, most failure-prone upload a session ever makes. When that request hits a transient failure (connection reset, socket open failure, timeout, 503/520/529), Claude's SDK retries it automatically and announces each attempt as a `system / api_retry` stream event. Today the Dev card mirrors that announcement into a `TugPaneBanner` with `variant="status"`. That banner — *regardless of variant* — applies `inert=""` to `.tug-pane-body`, which contains the transcript **and the prompt entry**. So during a benign, self-healing retry, the card is locked: the user cannot type. Worse, the banner's attempt count and countdown freeze at "API error · attempt 1/10 · now" for the whole quiet window while the giant request is genuinely in flight, reading as a stuck error when nothing is wrong.

An audit of 1,226 on-disk JSONL sessions (2.3 GB) confirmed the real interruption population and surfaced two non-fatal classes with **no UI at all today**: `model_refusal_fallback` (a model refused and the system silently retried on a fallback model — `claude-fable-5 → claude-opus-4-8`) and `stop_reason: max_tokens` truncation (115 turns hit the output cap). The audit also showed ~15% of API failures are network-level with **no HTTP status** (ECONNRESET / FailedToOpenSocket / connection error), which fall straight through the classifier's default to a bare, scary "API error" label — exactly the `bffef84c` case the user reported. Banners are for breakage; retries are notifications. This plan corrects that category error.

#### Strategy {#strategy}

- **Separate breakage from transience at the derivation seam.** `deriveDevCardBannerSpec` keeps only `error`; every transient kind moves to a new store-driven bulletin controller.
- **Make the pane bulletin capable of liveness first.** Extend `TugPaneBulletinProvider` to anchor top-right and extend the imperative API with a stable-id `post`/`update` + `dismiss(id)` — the minimum needed to update an attempt count in place and clear on recovery.
- **Drive bulletins off store state, not events — by direct subscription.** A controller observes the store via a direct `store.subscribe()` (registered in `useLayoutEffect` [L03]) and posts/updates/dismisses one bulletin per transient condition on each snapshot transition. It fires `toast` imperatively and **never enters React render or state** — a bulletin is a direct DOM update, so per [L22] it must not round-trip through `useSyncExternalStore`/render. This matches the imperative, ref-driven pattern `/compact` already uses.
- **Harden classification before surfacing it.** Replace the bare-"API error" default with a defensive normalization seam that collapses the four observed `api_error` message shapes and gives the no-status network family a real label.
- **Add the two missing classes at the bridge, then surface them.** Forward `model_refusal_fallback` as a typed event and classify `max_tokens` as a terminal reason; the same controller renders both as bulletins.
- **Reserve the banner's `inert` lockout for `error` only.** The surviving banner path keeps its documented `didHide` lifecycle contract untouched.

#### Success Criteria (Measurable) {#success-criteria}

- During an `api_retry`, the prompt entry remains focusable and typeable — `.tug-pane-body` carries no `inert` attribute (DOM assertion in an app-test driving a simulated retry). (verify: app-test)
- The retry bulletin's attempt count updates in place `1/10 → 2/10 → …` as fresh `api_retry` events arrive, and the bulletin is dismissed when the next live stream event or terminal failure clears `apiRetry` (pure-function unit test on `reconcileNotices`). (verify: bun unit test)
- A `likely-fatal` retry (e.g. 401 auth) that exhausts all attempts hands off cleanly: the retry bulletin is dismissed and the terminal `error` raises the locking `error` banner — no fatal failure left stuck as a dismissed bulletin with no banner. (verify: app-test)
- A no-HTTP-status network failure (ECONNRESET) classifies to a named label (not bare "API error") — asserted against a real fixture lifted from the JSONL audit. (verify: `classifyApiRetry`/normalizer unit test)
- `model_refusal_fallback` produces exactly one bulletin naming the fallback model; `stop_reason: max_tokens` produces exactly one informational bulletin — both asserted via tugcode bridge unit tests + a reducer/controller unit test. (verify: bun unit tests)
- `deriveDevCardBannerSpec` returns only `error` or `none` (the `api-retry` / `transport` / `replay-timeout` / `unknown-event` branches are gone) — asserted in `dev-card-banner-spec.test.ts`. (verify: bun unit test)

#### Scope {#scope}

1. Extend `TugPaneBulletinProvider` to support corner placement (`top-right`) and extend `TugPaneBulletinApi` with stable-id post/update + `dismiss(id)`.
2. Replace the bare-"API error" default in `classifyApiRetry` with a defensive normalization seam over the observed `api_error` message shapes (status / `cause.code` / nested `error.error.type` / embedded-in-`message` string), naming the no-status network family.
3. Add a transient-notice controller (store-driven) in the Dev card that posts/updates/dismisses top-right pane bulletins for `api-retry`, `transport`, `replay-timeout`, and `unknown-event`.
4. Remove `api-retry`, `transport`, `replay-timeout`, and `unknown-event` from `deriveDevCardBannerSpec` so the banner is reserved for `error`.
5. Forward `model_refusal_fallback` from tugcode as a typed event; fold it into the snapshot; surface it as a bulletin.
6. Classify `stop_reason: max_tokens` as a terminal truncation reason at the bridge; surface it as a one-shot informational bulletin.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the SDK's retry policy, backoff, or attempt ceiling (we mirror, never decide — unchanged).
- Reworking the `error` (breakage) banner's appearance or its `inert`/`didHide` lifecycle contract.
- Persisting transient notices to the JSONL or to tugbank; bulletins are ephemeral UI projections of live store state.
- A live second-by-second countdown timer in the bulletin (the frozen countdown is the anti-pattern we are removing; attempt count is the live signal).
- Deck-global `bulletin()` (Sonner top-right of the whole deck) — wrong scope; all notices here are per-card.

#### Dependencies / Prerequisites {#dependencies}

- Existing pane-bulletin infra (`TugPaneBulletinProvider`, `PaneBulletinAnchor`, `useTugPaneBulletin`) already mounted in the Dev card.
- Existing store fields `apiRetry`, `transportState`, `replayTimeoutDwellActive`, `unknownEvent` on `CodeSessionSnapshot`.
- tugcode `system` subtype dispatch and terminal-classification (`TurnEndReason`) paths.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings`) across the Rust workspace; bun/tsc must stay clean.
- Tuglaws: external state enters React via `useSyncExternalStore` only [L02]; **state that drives direct DOM updates is observed directly, not round-tripped through render [L22]**; registrations events depend on use `useLayoutEffect` [L03]; appearance changes go through CSS/DOM, never React state [L06]; the bulletin component follows the component authoring guide [L19]. Cross-check `tuglaws.md`, `pane-model.md`, `component-authoring.md` before tugways edits and name the laws touched in each commit.
- A new client→tugcode inbound message would need the 3-edit allowlist; these are **outbound** tugcode→client messages, so the allowlist does not apply — but each new outbound message still needs its `types.ts` union entry + guard + reducer handler + events type.
- App-tests via `just app-test`; never force `TUG_FORCE_BUNDLE_ID`; keep tests fast and exiting. Real-claude tests are on-demand only — simulate retry/refusal/truncation via injected fixtures, not a live model.

#### Assumptions {#assumptions}

- The live `api_retry` stream event and the persisted `api_error` JSONL line describe the same underlying failure families, so `api_error` lines are valid fixtures for the normalizer's unit tests (`api_retry` itself is not journaled).
- `model_refusal_fallback` currently reaches tugcode as a `system` subtype and is silently dropped (no `else` branch in the subtype switch), so surfacing it requires a new bridge branch + typed event.
- `stop_reason: max_tokens` is observable on the assistant snapshot / result at the bridge's terminal-classification site.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite plan-local decisions `[P01]`, specs `S01`, tables `T01`, risks `R01`, and `#anchor` deep links — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Top-right host: extend the existing provider, or add a second one? (OPEN) {#q01-host-wiring}

**Question:** The Dev card mounts one `TugPaneBulletinProvider` at `placement="bottom"` for `/copy`-style confirmations. The transient notices want `top-right`. Do we (a) add a second sibling provider/anchor dedicated to top-right transient notices, or (b) give the existing provider per-bulletin placement override?

**Why it matters:** Two `TugPaneBulletinProvider`s nested would shadow `PaneToasterIdContext` (inner wins), breaking `/copy`'s `paneBulletinRef`. Siblings avoid shadowing but mean two Sonner toasters in one pane.

**Options (if known):**
- Sibling top-right provider + a dedicated `TransientNoticeAnchor` exposing its API by ref (mirrors `PaneBulletinAnchor`); `/copy`'s bottom provider untouched. Keeps concerns and anchors cleanly separated.
- Single provider, per-toast `position` override on the transient posts.

**Plan to resolve:** Spike both during #step-1; pick the sibling-provider option unless Sonner per-toast position proves clean. Recorded as [P02].

**Resolution:** DECIDED — see [P02] (sibling top-right provider + ref-exposed anchor).

#### [Q02] `transport: "restoring"` — bulletin or suppressed? (OPEN) {#q02-restoring}

**Question:** `deriveDevCardBannerSpec` notes the cold-restore window is already routed to the `DevRestoring` placeholder, so the `transport` branch's `restoring` state is "a no-op in production." Does the transient controller need to handle `restoring` at all, or only `offline`?

**Why it matters:** Posting a "Reconnecting…" bulletin during a window already owned by the `DevRestoring` placeholder would double-signal.

**Options (if known):**
- Controller handles `offline` only; ignores `restoring` (placeholder owns it).
- Controller handles both, and the placeholder suppresses the bulletin.

**Plan to resolve:** Confirm against the restore-reveal coordination during #step-3.

**Resolution:** DECIDED — see [P05] (handle `offline` only; `restoring` stays with the placeholder).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Two Sonner toasters in one pane interfere | med | low | Sibling providers with distinct `useId` toasterIds; app-test asserts both fire | `/copy` confirmation regressions |
| Bulletin dismissed while big request still in flight | high | med | Condition-bound notices are sticky (no auto-timeout); dismissed only on state-clear or terminal | A retry bulletin vanishing mid-prefill in app-test |
| Removing kinds from the banner disturbs the `inert`/`didHide` contract | high | low | `error` path untouched; app-test asserts no `inert` on transient, `inert` present on `error` | Focus-restoration failures |
| New bridge events mis-shaped vs. SDK wire | med | med | Defensive parsing tolerant of snake/camel + missing fields; fixtures from real JSONL | New SDK field shape observed |

**Risk R01: Sticky bulletin outlives its condition** {#r01-sticky-leak}

- **Risk:** A condition-bound bulletin (retry/transport) is posted sticky and the clearing transition is missed, leaving a stale notice pinned.
- **Mitigation:** The controller owns exactly one active id per condition in a `useRef`; every store-emission runs `reconcileNotices` idempotently → posts/updates/dismisses, so a missed edge self-heals on the next snapshot. No render is involved [L22].
- **Residual risk:** If the store never emits a clearing transition (e.g. silent transport recovery without a stream event), the notice could persist; mitigated by also dismissing on `canSubmit`/turn-boundary resets.

**Risk R02: No-status network errors keep leaking the generic label** {#r02-classify-gap}

- **Risk:** A network failure shape not seen in the audit falls through the normalizer to the generic default again.
- **Mitigation:** The default still renders a calm, non-scary label; the normalizer is the single seam and is unit-tested against every audited shape.
- **Residual risk:** Genuinely novel shapes render the calm generic until a fixture is added — acceptable.

---

### Design Decisions {#design-decisions}

#### [P01] Banner is for breakage; transient interruptions are bulletins (DECIDED) {#p01-banner-vs-bulletin}

**Decision:** `TugPaneBanner` (which locks the card via `inert`) is reserved for `error` breakage; `api-retry`, `transport` (offline), `replay-timeout`, `unknown-event`, `model_refusal_fallback`, and `max_tokens` truncation render as non-blocking pane bulletins.

**Rationale:**
- The `status` variant still applies `inert=""` to `.tug-pane-body`, locking the prompt during a self-healing retry — a category error confirmed in code.
- Bulletins are the established pattern for transient, non-blocking per-card notices (`/copy`, `/compact`).

**Implications:**
- `deriveDevCardBannerSpec` loses four kinds; its tests shrink to `error`/`none`.
- A new store-driven controller owns the transient surface.

#### [P02] Sibling top-right provider drives transient notices (DECIDED) {#p02-sibling-provider}

**Decision:** Mount a second `TugPaneBulletinProvider` at `placement="top-right"` as a sibling of the existing bottom provider; expose its API by ref via a `TransientNoticeAnchor` (mirroring `PaneBulletinAnchor`). The bottom provider keeps serving `/copy`.

**Rationale:**
- Avoids `PaneToasterIdContext` shadowing that nesting would cause.
- Separates command-confirmation notices (bottom) from interruption notices (top-right) by anchor and concern.

**Implications:**
- `TugPaneBulletinProvider` gains corner placements; `useId` keeps the two toasters distinct.

#### [P03] Stable-id post + dismiss is the liveness primitive (DECIDED) {#p03-stable-id-api}

**Decision:** Extend `TugPaneBulletinApi` so a caller can post/update a bulletin under a caller-chosen stable id and `dismiss(id)` it. Sonner's `toast(msg, { id })` (replace-in-place) + `toast.dismiss(id)` back it.

**Rationale:**
- A live attempt count (`1/10 → 2/10`) requires update-in-place, not a new stacked toast per attempt.
- Recovery requires explicit dismissal the instant a stream event flows, not a timer.

**Implications:**
- The transient controller keys each condition's bulletin by a stable id (e.g. `"api-retry"`, `"transport"`).

#### [P04] Defensive normalization seam replaces the bare default (DECIDED) {#p04-normalizer}

**Decision:** `classifyApiRetry` (or a normalizer it delegates to) collapses the four observed `api_error`/`api_retry` shapes into `{ family, label, severity, status|null }`, and the no-HTTP-status network family (`ECONNRESET`/`FailedToOpenSocket`/`connection error`/`timeout`-without-status) gets a real label instead of bare "API error".

**Rationale:**
- ~15% of audited failures carry no status and currently render the scary generic.
- Message shapes are inconsistent (`.status` vs `.cause.code` vs nested `.error.error.type` vs embedded string) and must be parsed defensively.

**Implications:**
- One pure, unit-tested seam; fixtures lifted from the JSONL audit.

#### [P05] Condition-bound notices are sticky and dismissed on state-clear (DECIDED) {#p05-sticky-lifecycle}

**Decision:** Three lifecycle classes:
- **Condition-bound** (retry / transport-offline / replay-timeout): posted sticky (no auto-timeout), dismissed only when the store condition clears (stream resumes, wire back online, dwell ends) or the turn reaches a terminal/`canSubmit` boundary.
- **Acknowledge-bound** (`unknown-event`): posted sticky with an explicit `OK` dismiss (`sticky: true`, `okLabel: "OK"`), preserving today's "FYI you must acknowledge" semantics — it must not auto-vanish before the user sees it.
- **One-shot informational** (`max_tokens` truncation, `model_refusal_fallback`): auto-dismiss.

The controller handles `transport: "offline"` only — `restoring` stays with the `DevRestoring` placeholder (resolves [Q02]).

**Rationale:**
- A timer-dismissed retry notice could vanish mid-prefill while the large request is still legitimately working.
- `unknown-event` is an acknowledgement today (it carries a Dismiss button); auto-dismiss would regress that.
- Avoids double-signalling the cold-restore window.

**Implications:**
- The controller reconciles store→bulletin idempotently on each snapshot emission (self-healing per R01).

#### [P06] Two missing classes are surfaced via new bridge events (DECIDED) {#p06-bridge-classes}

**Decision:** tugcode gains a `model_refusal_fallback` `system`-subtype branch emitting a typed outbound event (carrying `originalModel`/`fallbackModel`/`trigger`), and classifies `stop_reason: max_tokens` as a new terminal truncation reason. Both flow through the reducer to snapshot fields the controller reads.

**Rationale:**
- Both are silently dropped/normalized-away today (no subtype branch; truncation reads as clean `complete`).
- Surfacing them is the user-requested completion of the interruption taxonomy.

**Implications:**
- New `types.ts` union entries + guards, `events.ts` event types, reducer handlers, and snapshot fields.

---

### Deep Dives (Optional) {#deep-dives}

#### Interruption taxonomy from the JSONL audit {#interruption-taxonomy}

**Table T01: Observed interruption classes (1,226 sessions)** {#t01-taxonomy}

| Class | Source | Count | Status | Severity | Today | Target |
|------|--------|-------|--------|----------|-------|--------|
| `overloaded_error` | `api_error` | 93 | 529 | transient | banner "Servers overloaded" | bulletin |
| upstream/proxy | `api_error` | 6 | 503 | transient | banner "Server error" | bulletin |
| ECONNRESET | `api_error` | 6 | none | transient | banner **bare "API error"** | bulletin (named) |
| Request timed out | `api_error` | 5 | none | transient | banner (label only if tagged) | bulletin (named) |
| FailedToOpenSocket | `api_error` | 4 | none | transient | banner **bare "API error"** | bulletin (named) |
| authentication | `api_error` | 2 | 401 | **fatal** | banner (fatal) | **stays banner (error)** |
| Cloudflare origin | `api_error` | 1 | 520 | transient | banner bare "API error" | bulletin |
| connection error | `api_error` | 1 | none | transient | banner bare "API error" | bulletin (named) |
| model refusal → fallback | `model_refusal_fallback` | 1 | — | non-fatal | **no UI (dropped)** | bulletin |
| output truncation | `stop_reason: max_tokens` | 115 | — | non-fatal | **no UI (reads complete)** | bulletin |

Note: `api_retry` (the live stream event the banner mirrors) is **not** journaled; `api_error` is its persisted sibling and the source of test fixtures.

#### Message-shape normalization {#message-shapes}

**List L01: The four `api_error`/`api_retry` message shapes the normalizer must tolerate** {#l01-shapes}

- `message.status` (numeric) — HTTP-status carrying (503/520/529/401).
- `message.cause.code` (string) — node socket error (`ECONNRESET`, `FailedToOpenSocket`).
- `message.error.error.type` (string) — nested Anthropic error (`overloaded_error`).
- `message.message` (string) — formatted string with status embedded (`"529 …Overloaded…"`), and `"Request timed out."` / `"Connection error."`.

The normalizer extracts `status` (from `.status` / parsed from the string), `family` (from `.cause.code` / `.error.error.type` / keyword match on the string), and maps to `{ label, severity }`, defaulting the no-status network family to a named, calm label.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Transient-notice projection (`apiRetry`/`transportState`/`replayTimeoutDwellActive`/`unknownEvent`/refusal/truncation) | external store, drives direct DOM (a toast) | **direct `store.subscribe()`** — observe directly, fire `toast` imperatively, never enter render/state | [L22] |
| Active bulletin id + last-observed snapshot per condition (for diff/update/dismiss) | local-data | `useRef` in the controller | — |
| Bulletin DOM + enter/exit animation | appearance | Sonner DOM + CSS, no React state | [L06] |
| Controller subscription / lifecycle registration | structure | `store.subscribe()` registered in `useLayoutEffect` | [L03] |
| Top-right placement | appearance/structure | CSS in `tug-pane-bulletin.css` | [L06] |
| New snapshot fields (`refusalFallback`, terminal `max_tokens` reason) | local-data | reducer + store | [L02] |

#### Public API surface (tugways) {#public-api}

**Spec S01: `TugPaneBulletinApi` additions** {#s01-bulletin-api}

- `post(message: string, options?: PaneBulletinOptions & { id: string })` / accept an `id` on existing call forms so a repeat call with the same `id` updates in place.
- `dismiss(id: string): void` — dismiss a specific bulletin.
- `TugPaneBulletinProviderProps.placement` accepts `"top" | "bottom" | "top-right" | "top-left" | "bottom-right" | "bottom-left"`.

**Spec S02: New bridge events** {#s02-bridge-events}

- `model_refusal_fallback` → outbound `{ type: "model_refusal_fallback", originalModel, fallbackModel, trigger, direction }` (camelCased), reducer folds to `snapshot.refusalFallback`.
- `max_tokens` truncation → terminal reason `"max_tokens"` added to `TurnEndReason`, reducer exposes it on the active/last turn for the controller.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Normalizer classification; controller transition logic; reducer folds | Core logic, every audited shape, edge cases |
| **Contract** | Bridge event shapes vs. real JSONL fixtures | `model_refusal_fallback`, `api_error`, `max_tokens` |
| **App-test** | Real card: no `inert` during retry, prompt typeable, bulletin fires/updates/dismisses | End-to-end behavior |

#### What stays out of tests {#test-non-goals}

- No live-model retry/refusal — simulate via injected fixtures (real-claude is on-demand only).
- No mock-store assertion tests or fake-DOM render tests — drive the real store and real card per project doctrine.
- No second-by-second countdown assertions — the countdown is removed; attempt-count transitions are the tested signal.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Cross-check tuglaws and name touched laws in each tugways/tugdeck commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Pane bulletin: corner placement + stable-id post/dismiss | done | 635c7f81d |
| #step-2 | Error-classification normalization seam | done | 358ba32bf |
| #step-3 | Transient-notice controller + banner reservation | done | 627ae513b |
| #step-4 | Bridge + surface: model_refusal_fallback | done | d3a73556a |
| #step-5 | Bridge + surface: max_tokens truncation | done | 72c7b8fa6 |
| #step-6 | Integration checkpoint (app-test) | done | cbbbbc085 |

#### Step 1: Pane bulletin — corner placement + stable-id post/dismiss {#step-1}

**Commit:** `feat(tugways): pane bulletin corner placement + stable-id post/dismiss`

**References:** [P02] Sibling provider, [P03] Stable-id API, Spec S01, [Q01] (#p02-sibling-provider, #s01-bulletin-api)

**Artifacts:**
- `TugPaneBulletinProvider.placement` extended to corners; `tug-pane-bulletin.css` corner anchors.
- `TugPaneBulletinApi` gains `id`-keyed post/update + `dismiss(id)`.

**Tasks:**
- [ ] Add corner placements to `placement` and map them to Sonner positions; add CSS for `top-right`.
- [ ] Thread an optional `id` through `mapOptions`/the call forms; add `dismiss(id)` backed by `toast.dismiss`.
- [ ] Resolve [Q01] in favor of [P02] by confirming two sibling providers keep distinct `useId` toasterIds.

**Tests:**
- [ ] Unit: repeat post with same `id` updates in place (one toast, not two); `dismiss(id)` clears it.
- [ ] Gallery/visual: a top-right pane bulletin anchors correctly.

**Checkpoint:**
- [ ] `cd tugdeck && bun test tug-pane-bulletin`
- [ ] `bun run typecheck` clean

---

#### Step 2: Error-classification normalization seam {#step-2}

**Commit:** `feat(tugdeck): defensive api-retry normalization with named network family`

**References:** [P04] Normalizer, List L01, Table T01, (#message-shapes, #l01-shapes)

**Artifacts:**
- `classifyApiRetry` (+ a normalizer helper) returning `{ family, label, severity, status|null }`; named label for the no-status network family.
- Fixtures lifted from the JSONL audit (ECONNRESET, FailedToOpenSocket, timeout, 503, 520, 529, 401).

**Tasks:**
- [ ] Add the normalizer tolerant of all four shapes in List L01.
- [ ] Replace the bare "API error" default with a calm, named label for no-status network failures.
- [ ] Keep 401/auth → fatal severity (stays banner-eligible via the `error` path upstream).

**Tests:**
- [ ] Unit: each audited fixture maps to its expected `{ label, severity, status }`.
- [ ] Unit: an unknown shape still yields the calm generic, never throws.

**Checkpoint:**
- [ ] `cd tugdeck && bun test api-retry`

---

#### Step 3: Transient-notice controller + banner reservation {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `feat(tugdeck): route transient interruptions to top-right bulletins, reserve banner for breakage`

**References:** [P01] Banner vs bulletin, [P05] Sticky lifecycle, [Q02], Spec S01, [L22], (#p01-banner-vs-bulletin, #p05-sticky-lifecycle, #state-zone-mapping)

**Artifacts:**
- A pure `reconcileNotices(prev, next): NoticeAction[]` function (post/update/dismiss actions) and a thin controller that observes the store via a **direct `store.subscribe()`** (registered in `useLayoutEffect` [L03]), diffs snapshots through `reconcileNotices`, and applies the actions imperatively to the top-right bulletin API — covering `api-retry`, `transport` (offline), `replay-timeout`, `unknown-event`. No `useSyncExternalStore`, no render round-trip [L22].
- `deriveDevCardBannerSpec` reduced to `error` / `none`, with all stranded code removed.
- A `TransientNoticeAnchor` + sibling top-right provider in the Dev card.

**Tasks:**
- [ ] Extract `reconcileNotices(prev, next)` as a pure function: one stable id per condition; idempotent post/update/dismiss; sticky-while-condition-holds; ack-sticky for `unknown-event`; dismiss on clear/terminal ([P05]).
- [ ] Build the controller shell: `store.subscribe()` in `useLayoutEffect`, hold last-observed snapshot in a `useRef`, apply `reconcileNotices` output via the bulletin API — never via React state/render [L22].
- [ ] Live attempt count: on each `apiRetry` change, update the same bulletin id in place (`1/10 → 2/10 …`); drop the countdown.
- [ ] Remove the `api-retry`/`transport`/`replay-timeout`/`unknown-event` spec union members **and** their `renderDevCardBanner` branches; delete the now-dead `DevCardBannerCtx.unknownDismissedAt` field and the `setUnknownDismissedAt` setter (warnings-are-errors — no dead code may remain).
- [ ] Handle `transport: "offline"` only; leave `restoring` to the placeholder ([Q02]→[P05]).

**Tests:**
- [ ] Unit (pure): `reconcileNotices` transition cases — post on first attempt, update on increment, dismiss on stream-resume/terminal, sticky across the quiet window, ack-sticky for `unknown-event`. Pure-function in/out only — **no mock store**.
- [ ] Unit: `dev-card-banner-spec.test.ts` now only returns `error`/`none`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test dev-card-banner-spec transient-notice`
- [ ] `bun run typecheck` clean

---

#### Step 4: Bridge + surface — model_refusal_fallback {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugcode): forward model_refusal_fallback; surface as bulletin`

**References:** [P06] Bridge classes, Spec S02, Table T01, (#p06-bridge-classes, #s02-bridge-events)

**Artifacts:**
- tugcode `system`-subtype branch for `model_refusal_fallback`; outbound event in `types.ts` (union + guard) and `events.ts`.
- Reducer handler folding to `snapshot.refusalFallback`; controller posts a bulletin naming the fallback model.

**Tasks:**
- [ ] Add the subtype branch (defensive snake/camel + missing-field tolerance) emitting `{ type, originalModel, fallbackModel, trigger, direction }`.
- [ ] Add the reducer handler + snapshot field; controller renders a one-shot bulletin ("Retrying on <fallbackModel>…").

**Tests:**
- [ ] Contract: a `model_refusal_fallback` fixture (from the audit) produces one outbound event of the expected shape.
- [ ] Unit: real reducer folds the event to `snapshot.refusalFallback` (event-in → state-out, no mock store); `reconcileNotices` emits exactly one post for that field.

**Checkpoint:**
- [ ] `cd tugcode && bun test session` (refusal-fallback cases)
- [ ] `cd tugdeck && bun test transient-notice`

---

#### Step 5: Bridge + surface — max_tokens truncation {#step-5}

**Depends on:** #step-3

**Commit:** `feat(tugcode): classify max_tokens truncation; surface as informational bulletin`

**References:** [P06] Bridge classes, Spec S02, Table T01, (#p06-bridge-classes, #s02-bridge-events)

**Artifacts:**
- `"max_tokens"` added to `TurnEndReason`; bridge terminal-classification sets it on `stop_reason: max_tokens`.
- Reducer exposes it; controller posts a one-shot informational bulletin ("Response truncated at the output limit").

**Tasks:**
- [ ] Extend terminal classification to detect `stop_reason: max_tokens` (live + replay) without regressing `complete`/`interrupted`.
- [ ] Surface via the controller as an auto-dismiss informational bulletin.

**Tests:**
- [ ] Contract: a `max_tokens` assistant/result fixture classifies to `"max_tokens"`, not `"complete"`.
- [ ] Unit: `reconcileNotices` emits exactly one auto-dismiss informational post for the truncation reason.

**Checkpoint:**
- [ ] `cd tugcode && bun test session` (truncation cases)
- [ ] `cd tugdeck && bun test transient-notice`

---

#### Step 6: Integration checkpoint (app-test) {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P01] Banner vs bulletin, [P05] Sticky lifecycle, (#success-criteria)

**Tasks:**
- [ ] Drive the real Dev card with injected fixtures for retry, transport-offline, refusal-fallback, truncation.

**Tests:**
- [ ] App-test: during a simulated retry, `.tug-pane-body` has no `inert`; the prompt entry is focusable and accepts input; a top-right bulletin shows and its attempt count updates; it dismisses on the next stream event.
- [ ] App-test: a `likely-fatal` retry that exhausts its attempts dismisses the bulletin and raises the locking `error` banner (the fatal-retry → breakage handoff).
- [ ] App-test: a genuine `error` still raises the locking banner (regression guard for the surviving path).

**Checkpoint:**
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Transient model interruptions render as live, non-blocking, top-right pane bulletins; the card stays interactive throughout; the locking banner fires only for genuine breakage; and the two previously-invisible classes (model-refusal fallback, output truncation) are surfaced.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `inert` on `.tug-pane-body` during any transient notice (app-test).
- [ ] Retry bulletin updates its attempt count in place and dismisses on recovery (unit + app-test).
- [ ] No-status network failure renders a named, calm label (unit).
- [ ] `model_refusal_fallback` and `max_tokens` each surface exactly one bulletin (contract + unit).
- [ ] `deriveDevCardBannerSpec` returns only `error`/`none` (unit).
- [ ] `cargo nextest run`, `bun test`, `bun run typecheck`, and `just app-test` all clean.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A notice history / log surface (e.g. in `TugDevPanel`) for interruptions that auto-dismissed.
- [ ] Sweep stale "Tide" references if any error copy carries them.

| Checkpoint | Verification |
|------------|--------------|
| Prompt stays live during retry | `just app-test` (no-`inert` assertion) |
| Attempt count is live | unit transition test + app-test |
| Two new classes surfaced | tugcode contract tests + tugdeck controller unit |
| Banner reserved for breakage | `dev-card-banner-spec.test.ts` returns `error`/`none` |
