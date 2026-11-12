# Turn Lifecycle

*Turn lifecycle: the Dev session's assistant-turn state machine and the one derived projection every control reads. How `CodeSessionStore`'s phase machine is projected into `submitButtonMode` / `canSubmit`, and why controls that change a turn's settings subscribe to that projection instead of reaching into the running turn.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why a turn-lifecycle projection

A Session card runs a conversation as a sequence of *turns*: the user submits, the assistant streams a reply (possibly pausing for a permission prompt or a tool call), the turn completes, the card returns to idle. That progression is a single state machine — `CodeSessionStore`'s `phase` — but many surfaces need to *react* to where it is. The Z5 submit button poses as a blue arrow or a red stop; the status indicator pulses; the Mode / Model / Effort chips light or dim; the Permission Mode menu enables or greys. If each surface read the raw phase and re-decided "is a turn live?" for itself, the decisions would drift — one surface would think the turn is over while another still holds it, and a setting changed in that gap would race the turn.

The turn lifecycle resolves this the way the card and route lifecycles do: the machine is a **source** that publishes its state as one derived projection, and every surface is a **delegate** that subscribes to that projection and supplies its own response. It is the Dev-session sibling of the deck's `CardLifecycle` ([lifecycle-delegates.md](lifecycle-delegates.md)) and the prompt entry's `RouteLifecycle` ([route-lifecycle.md](route-lifecycle.md)) — same source→delegate shape, different scope: one machine per bound Dev session, projected purely, read everywhere. This is the executable form of [L28].

---

## The source: one phase machine, two published faces

The source is `CodeSessionStore`'s phase machine (`code-session-store.ts` + its reducer). Frames from tugcode drive the phase: a submit moves it to `submitting` → `awaiting_first_token` → `streaming` / `tool_work`, a permission or question prompt parks it in `awaiting_approval`, a `turn_complete` returns it to `idle`; `interruptInFlight`, `replaying`, `errored`, and `waking` are the remaining conditions. No surface reads that raw phase directly. It is projected onto **two published faces**, and those are what surfaces read:

- **`deriveLifecycleSnapshot`** (`code-session-store/lifecycle-state.ts`) — the pure projection of the whole lifecycle matrix into `{ state, overlays, submitButtonMode }`, consumed through the `useLifecycleState` hook (`code-session-store/hooks/use-lifecycle-state.ts`). It is reference-stable ([DT09]): a content-only `assistant_delta` returns the previous snapshot unchanged, so streaming tokens do not re-render every lifecycle consumer. Its `submitButtonMode` is the matrix's Z5 column — `{ kind: "submit" }` (blue arrow), `{ kind: "stop" }` (red, live interrupt), or the inert poses `stopping` / `awaiting_user` / `reconnecting` / `restoring`.
- **`canSubmit`** — a boolean on the `CodeSessionSnapshot`: `(phase === "idle" || phase === "errored") && transportState === "online"`. It is the single "a new turn may start now" gate, and it is exactly the condition under which the submit button is a **live blue arrow** — `canSubmit` is true iff `submitButtonMode.kind === "submit"`. `canInterrupt` is its counterpart for the whole in-flight span (including the `awaiting_approval` permission pause).

The equivalence is the point: because `canSubmit` and `submitButtonMode` are two faces of the *same* projection, a delegate that keys off `canSubmit` can never disagree with the submit button about whether a turn is live.

### Transport loss is a `transportState` condition, never a banner

`transportState` is an axis of its own, orthogonal to `phase`, and it is the **only** thing that represents a lost wire. A transport close must never stamp `lastError`.

The distinction is what each surface is for. The error banner is the one surface allowed to lock the card body (it sets `inert`), and it is reserved for breakage that does not heal itself. A dropped wire heals itself: the connection retries on its own backoff and the deck restores every card. What the user gets instead is non-blocking and already complete without any error stamp —

- `projectNotices` (`transient-notice.ts`) raises the "Reconnecting… / Lost the connection to the agent." bulletin from `transportState === "offline"`,
- `tug-banner-bridge.tsx` shows the app-level "Disconnected — reconnecting in Ns…" strip,
- and `canSubmit` above already clamps the composer, because it conjoins `transportState === "online"`.

So the stamp bought nothing and cost the card: it was also *sticky*, since no recovery edge cleared it — worst in exactly the case where the wire never came back. `handleTransportOpen` and `handleTransportSettled` now clear a `transport_closed` cause if one reaches them from anywhere, and leave every other cause alone: a `session_state_errored` that merely coincided with an outage is real breakage and still banners.

---

## The delegates

Every surface that cares about turn state subscribes to one of the two faces and supplies its own response — none reaches into the machine, none re-derives turn-activeness from `phase` locally:

| Delegate | Reads | Response |
|----------|-------|----------|
| Z5 submit button | `submitButtonMode` | Renders arrow / stop / inert pose (`prompt-entry-submit-button.ts`) |
| Z4B Mode / Model / Effort chips | `canSubmit` | `disabled={!canSubmit}` (`session-card.tsx`) |
| `setMode` / `setModel` / `setEffort` | `canSubmit` | Decline a user change while a turn is live (the seam, below) |
| `/mode` `/model` `/effort`, ⌃⌥⌘P cycle, `SET_PERMISSION_MODE` | `canSubmit` | Refuse with a caution instead of a silent no-op (`guardTurnIdleForSetting`) |
| Native Permission Mode menu | `canChangeSettings` (= `canSubmit`) | Radios + Cycle validate disabled mid-turn (`host-menu-state.ts` → `useMenuStatePublication` → Swift `validateMenuItem`); with every child disabled AppKit auto-disables the parent |

The Mode / Model / Effort settings are the sharp case. Each maps to a live effect on the running `claude` process — mode and model are forwarded as control-requests, and an effort change **respawns** the session process ([R07]). So a change accepted mid-turn does not merely queue; it reaches into (or tears down) the in-flight turn. That is a source→delegate **inversion**, and the race [L28] forbids. The correct shape is the inverse direction: the control declines while `canSubmit` is false and lets the published idle state re-enable it, so the change lands on the *next* submitted turn.

---

## The seam — one choke point, the restore exemption

The four user paths that change a setting — the picker sheets, the ⌃⌥⌘P cycle, the Permission Mode menu, and the `/mode` `/model` `/effort` commands — all funnel through the three shared setters `setMode` / `setModel` / `setEffort` (`use-permission-mode.ts`, `use-model.ts`, `use-effort.ts`). The gate lives there, so one seam closes every path:

```ts
if (!opts?.fromRestore && !codeSessionStore.getSnapshot().canSubmit) return;
```

`canSubmit` is read **live** off the store at call time ([L07]), never from a render closure. The per-surface `disabled` / caution responses in the table above sit *on top* of this seam — they make the refusal legible; the seam makes it correct.

The one exemption is **mount-restore**. A card's persisted / default mode is re-applied on mount by the seed effect, which fires as soon as the session is alive (`session_capabilities` landed) — potentially before the first turn has settled, when `canSubmit` is still false. That path passes `{ fromRestore: true }` to bypass the gate: it *establishes* the session's initial setting rather than *changing* it mid-turn, so it must proceed. Gate the four user-facing entry points; exempt the restore seed. (Guarding the raw setter unconditionally would strand session restore.)

---

## Boundary: the shell route's submit button is not this lifecycle

On the `$` shell route the Z5 submit button is route-aware (`routeAwareSubmitButtonMode`, [route-lifecycle.md](route-lifecycle.md)): it poses `stop` while a shell exchange reaps its process group and `submit` otherwise, driven by `shellSessionStore`, **disjoint from the Claude turn lifecycle** ([D111]). The turn lifecycle in this document governs the `❯` code route. The Z4B Mode / Model / Effort chips do not mount on the shell route at all (Table T01), so their turn-lock is a code-route concern; a control that is inapplicable to a route unmounts rather than disabling.

---

## Authoring rules

**Read turn state through the projection, never the raw phase.** A component that renders against turn state uses `useLifecycleState(...)` (for `submitButtonMode` / matrix state) or the `canSubmit` snapshot field ([L02]). Do not read `phase` / `interruptInFlight` and re-decide "is a turn live?" — that forks the derivation the submit button already owns, and the fork is where drift (and the permission-prompt gap) hides.

**A setting that affects a turn declines while a turn is live; it never reaches in.** If a control changes something the running turn consumes (permission mode, model, effort), gate it on `canSubmit` at the setter seam and let the published idle state re-enable it. Never send the change into the turn and never bolt on a separate lock — restore the source→delegate direction ([L28]).

**Publish, don't poll, across the process boundary.** The native menu learns turn state the same way React does: the frontend publishes `canChangeSettings` (= `canSubmit`) on the `session` menu block; Swift validates against the cached snapshot. Add a field to the block and the parser together; keep the wire contract in sync ([menus.md](menus.md) discipline).

**Read the gate live in handlers.** Action handlers registered once at mount read `canSubmit` through `codeSessionStore.getSnapshot()` at invocation time, not from a render-time closure ([L07]).

---

## Files

Primary canonical authority — the source is the tie-breaker.

- [`tugdeck/src/lib/code-session-store/lifecycle-state.ts`](../tugdeck/src/lib/code-session-store/lifecycle-state.ts) — `deriveLifecycleSnapshot`, the `SessionLifecycleState` / `SessionSubmitButtonMode` vocabulary, and the [DT09] reference-stability check.
- [`tugdeck/src/lib/code-session-store.ts`](../tugdeck/src/lib/code-session-store.ts) — the phase machine and the `canSubmit` / `canInterrupt` snapshot fields.

Secondary implementation source — where the projection is consumed as delegates.

- [`tugdeck/src/lib/use-permission-mode.ts`](../tugdeck/src/lib/use-permission-mode.ts), [`use-model.ts`](../tugdeck/src/lib/use-model.ts), [`use-effort.ts`](../tugdeck/src/lib/use-effort.ts) — the setter seam and its `fromRestore` exemption.
- [`tugdeck/src/components/tugways/cards/session-card.tsx`](../tugdeck/src/components/tugways/cards/session-card.tsx) — the chips' `disabled={!canSubmit}` wiring and `guardTurnIdleForSetting` for the slash / cycle / menu handlers.
- [`tugdeck/src/lib/host-menu-state.ts`](../tugdeck/src/lib/host-menu-state.ts) + [`components/tugways/cards/use-menu-state-publication.ts`](../tugdeck/src/components/tugways/cards/use-menu-state-publication.ts) + [`tugapp/Sources/AppDelegate.swift`](../tugapp/Sources/AppDelegate.swift) — `canChangeSettings` from publish to Swift `validateMenuItem`.

Regression coverage.

- `tests/app-test/at0220-settings-chips-turn-lock.test.ts` — chips lock mid-turn, ⌃⌥⌘P declined, re-enable + cycle-again after completion. `at0172-session-menu-live-state.test.ts` — the Permission Mode radios + Cycle disable mid-turn and re-enable at idle.

---

## Cross-Links

- [lifecycle-delegates.md](lifecycle-delegates.md) — the deck-level `TugCardDelegate` pipe this lifecycle is modeled on. Same source→delegate split; that one is deck-scoped and surfaces six card moments through a `MessageChannel` drain, this one is Dev-session-scoped and surfaces turn state as a pure `useSyncExternalStore` projection.
- [route-lifecycle.md](route-lifecycle.md) — the per-prompt-entry route pipe. Its `routeAwareSubmitButtonMode` governs the `$` shell route's submit button, disjoint from this turn lifecycle; the two share the Z5 button by route.
- [tuglaws.md](tuglaws.md) — [L28] (a control acts on a lifecycle by subscribing to its published state, never by reaching into it — this document is its executable form), [L02] (the projection enters React through `useSyncExternalStore`), [L07] (handlers read `canSubmit` live).
- [design-decisions.md](design-decisions.md) — [D01] (the Z5 submit gate — `canSubmit` as the conjunction of phase and transport health), [D13] (the Z4B chrome chips that gate on it).
