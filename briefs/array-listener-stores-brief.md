<!-- brief-skeleton v1 -->

# Move the array-list stores onto `Subscribable`, and fix the notify loop that skips a listener

**Purpose:** Nineteen tugdeck files still hand-roll a listener list as `Array<() => void>`, outside the sweep that `dc4c333b46` landed. Nine of them iterate the live array in `notify`, so a listener that unsubscribes during a notification shifts the array under the loop and the next listener is never called.

---

## Purpose {#purpose}

The store-base arc (`dc4c333b46`) counted its sweep by the literal `new Set<() => void>` and moved every one of those onto `lib/subscribable.ts`. Its brief recorded what the gauge did not reach — "about 35 files hold an `Array<() => void>` listener list … and about 10 hold a `Set` typed through an alias" — and left them for a later arc with "the array stores' duplicate-subscription semantics to settle first". This is that arc.

The audit of that arc re-read the leftovers on `main` and found the duplicate-subscription question is not the one that matters. The one that matters is in `notify`.

---

## Evidence {#evidence}

**[F01] The array stores are 17 genuine listener lists, not 35** — a census of `(listeners|subscribers|_listeners|_subscribers|callbacks): Array<() => void>` over `tugdeck/src` outside `__tests__` names 19 files. Two are not listener lists: `components/tugways/selection-guard.ts:382` (`appLifecycleUnsubscribers`) and `components/tugways/cards/gallery-tug-inline-dialog.tsx` hold arrays of *unsubscribes*, the same shape [B01] of the store-base brief excluded. The 17 that are listener lists: `lib/auth-store.ts`, `lib/update-store.ts`, `lib/claude-version-store.ts`, `lib/arc-press-store.ts`, `lib/page-zoom-store.ts`, `lib/arc-replay-outcome-store.ts`, `lib/card-session-binding-store.ts`, `lib/session-restore.ts`, `lib/code-session-store.ts`, `lib/asset-projection.ts`, `lib/pending-ask-store.ts`, `lib/feed-store.ts`, `lib/host-tools-store.ts`, `lib/atom-bytes-store.ts`, `lib/network-path-store.ts`, `lib/arc-bind-error-store.ts`, and the test double `lib/code-session-store/testing/mock-feed-store.ts`. **(verified)**

**[F02] Eight of them iterate the live array in `notify`** — `for (const listener of this._listeners) listener();` with no copy, in `auth-store.ts:469`, `card-session-binding-store.ts` (six sites: :107, :131, :151, :176, :184, :200), `claude-version-store.ts`, `host-tools-store.ts`, `network-path-store.ts`, `page-zoom-store.ts`, `session-restore.ts` (two sites), and `update-store.ts`. (`restore-gate-store.ts` has the same loop shape over a `Set`, where deleting during iteration is safe; it is in [F05].) Every one of these unsubscribes by `indexOf` + `splice`. When listener *i* unsubscribes itself during the loop, the splice shifts listener *i+1* into slot *i*, the iterator advances to *i+1*, and the listener that was there is skipped for this notification. A React subtree that unmounts in response to one of these stores changing — a card whose binding store says it is now unbound, a bar that hides when auth settles — is exactly a listener unsubscribing mid-notify, and the sibling subscribed after it misses the same change. **(verified by reading; not yet reproduced in a test — [B03] writes the reproduction.)**

**[F03] Eight copy before iterating** — `feed-store.ts:154` (`this._listeners.slice()`, with a comment saying why), `code-session-store.ts`, `pending-ask-store.ts`, `arc-press-store.ts`, `arc-replay-outcome-store.ts`, `arc-bind-error-store.ts`, `gallery-tug-inline-dialog.tsx`, and `mock-feed-store.ts`. These already have `Subscribable.notify`'s semantics; moving them deletes code and changes no behaviour. **(verified)**

**[F04] No caller subscribes the same function twice** — every production subscriber of these stores is `useSyncExternalStore` or a one-shot `store.subscribe(fn)` held in a field, and neither adds a listener it already holds. The array shape would call a twice-subscribed listener twice; a `Set` calls it once. Nothing depends on the difference. **(verified by reading the subscribers; `tsc` cannot prove it, and [B02] records the choice so it is not re-derived.)**

**[F05] The alias-typed sets split by signature** — ten files hold `new Set<SomeAlias>()`. Three alias `() => void` and are the base's shape exactly: `lib/canvas-overlay-registry.ts:47`, `lib/restore-gate-store.ts:51`, `lib/open-menu-registry.ts:40`. Seven carry a payload — `tooltip-dismiss.ts` `(ev: Event | null) => void`, `imposer-gauges.ts` `(values: ReadonlyMap<string, string> | null) => void`, `overview-store.ts` and `digest-store.ts` `(payload: …Ok) => void`, `motion-guard/registry.ts` `(holds: number) => void`, `session-state-changes-local-events.ts` `(event: LocalSessionStateChange) => void`, `motion-guard/render-cost-probe.ts` `(sample: RenderCostSample) => void`. Those are event emitters, not change notifiers. **(verified)**

**[F06] `Subscribable` already has the vocabulary the 17 need** — `subscribe` (arrow property, returns the unsubscribe), `notify` over a copy, `notifyCatching`, `listenerCount`, `clearListeners`. `code-session-store.ts` is the only array store of any size (it disposes with a listener clear and notifies through a trailing-flush path); the rest are under 30 lines of listener code each. **(verified)**

---

## Decisions {#decisions}

**[B01] The 17 array listener lists move onto `Subscribable`, by the same rule the first sweep used.** A class whose only listener set is read through a member named `subscribe` extends `Subscribable`; one that already extends something, holds more than one set, or names its subscribe differently holds a `createSubscribable()` field. The three `() => void` alias sets in [F05] move the same way. `mock-feed-store.ts` moves too — a test double that keeps the old loop would keep testing the old semantics. Behaviour is held fixed for the eight stores in [F03]; for the eight in [F02] it changes in exactly one way, which is the fix.

**[B02] Duplicate subscription becomes "called once", and that is a decision rather than a side effect.** [F04] found no caller that depends on "called twice", and a `Set` is what the hundred stores already on the base do. The brief records it so the next reader does not re-derive it from the diff; a store that genuinely needs a listener registered twice is a store that needs a different shape, and none was found.

**[B03] The verdict is a test that reproduces [F02] before the move, at the store layer.** One `bun test` per store is noise; one test over the real `Subscribable`, and one over a representative array store on `main` (`auth-store` or `card-session-binding-store`), is the assertion: subscribe A then B, have A unsubscribe itself inside its own callback, notify, assert B was called. The store test is red on `main` and green after the move; the base test pins the semantics the move inherits. `tsc` and `bun test` in `tugdeck/` are the per-edit verdict; the `@covers`-derived app-test selection runs once after the last edit, since these stores reach the auth bar, the binding chrome, and the update popover.

**[B04] The seven payload emitters stay as they are.** `Subscribable` owns "a listener set and nothing else" ([B01] of the store-base brief), and a listener that takes an argument is a different contract. Making the base generic over a payload turns it into a small event bus, which is the framework that brief refused. They are named here so the gauge — `Array<() => void>` and `Set<() => void>`-shaped aliases — reads zero without them being mistaken for leftovers.

---

## Non-goals {#non-goals}

- **A generic `Subscribable<T>`.** [B04]. The seven emitters in [F05] are not this shape.
- **The arrays of unsubscribes** in `selection-guard.ts` and `gallery-tug-inline-dialog.tsx`. Not listener sets; the first sweep's [B01] already excluded this shape.
- **Any change to what a store notifies about, or when.** This is the same three-method replacement as the first sweep. A store whose `notify` is wrapped (the session store's trailing flush, `feed-store`'s replay-on-subscribe) keeps its wrapper and calls the base inside it.
- **The keyed `Map<string, Set<Listener>>` registries.** Still the typed registries the first brief's [F01] named.

---

## Exit {#exit}

An arc. The shape: the `Subscribable` test and the red reproduction on an array store first ([B03]); then the eight live-iteration stores ([F02]), which is where the fix lands; then the eight copying stores and the three alias sets ([F03], [F05]), which are deletions; then the one app-test selection. `code-session-store.ts` goes last among the stores, since it is the only one with a non-trivial notify path.
