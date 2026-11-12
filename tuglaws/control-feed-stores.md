# Stores That Observe CONTROL Push Frames

Some external stores aren't backed by tugbank; they're projections of server-side state that the supervisor pushes over the CONTROL feed. `SessionLedgerStore` is the second consumer of this pattern — the first was the live-sessions broadcast handling.

The shape:

1. **Action-dispatch as the wire-side decoder.** `action-dispatch.ts` registers handlers for the response/push frame names (e.g., `session_updated`, `list_sessions_ok`, `forget_session_ok`). Each handler validates the payload shape and forwards a typed event through a small pub/sub bus.
2. **A pub/sub bus per store.** The ledger uses `lib/session-ledger-events.ts` — a process-global module that exports `subscribe*` / `publish*` functions per event kind. The bus is the single decoupling point between the wire decoder and the store consumer.
3. **The store subscribes on construction.** The store calls each `subscribeTo*` once in its constructor, holding the unsubscribe functions in a `disposers: Array<() => void>` so a future `dispose()` can clean up. The store then mutates its in-memory cache and emits a listener tick — exactly like a tugbank-backed store under [L02].
4. **`useSyncExternalStore` is still the React boundary.** The hook that exposes the store to React (`useSessionLedger(projectDir)`) wraps the store with `useSyncExternalStore` so [L02] holds: external state never enters React state, even one tick removed via the bus.
5. **Imperative actions roundtrip through the bus.** A method like `forgetSession(sessionId)` sends a CONTROL frame and returns a promise. The promise's resolver lives in a pending-map on the store; the matching `forget_session_ok` / `_err` ack arrives via the bus and resolves the promise. Tests publish the ack frame directly to drive the store without a real wire.
6. **Reconnect re-fetches.** The store hooks `connectionDidReconnect` (from `connection-lifecycle`) and calls `invalidateAll()` on every reconnect after the first — covering the gap where push frames may have landed during a wire bounce. [L23] compliance: the server-side ledger persists; the client-side cache is the rebuildable projection.

When to use this pattern: the projected state is server-owned, has many keys (per-workspace, per-session), and updates frequently enough that tugbank's `domain-changed` cadence isn't a fit. When the data is small (a single config blob, a recents list with 5 entries), `useTugbankValue` is still the right shape.

See [tuglaws.md](tuglaws.md) for [L02] and [L23], and [component-authoring.md](component-authoring.md) for authoring the components that read such a store.
