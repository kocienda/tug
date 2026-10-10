<!-- brief-skeleton v1 -->

# Structural decoding at the deck's websocket boundary

**Purpose:** The session store checks a CODE_OUTPUT frame's `type` against a 40-name allow-list and then casts the whole payload to the event union. A field that drifts upstream reaches the reducer as the wrong shape, throws there, and is logged by the feed store as "failed to decode payload", which is the one thing that did not happen.

---

## Purpose {#purpose}

Item 15 of `briefs/audit-punch-list.md`:

> 15. Structural guards at the deck's websocket boundary in `code-session-store.ts` so a field drift is a logged decode error, not a reducer exception.

Every frame that decodes today keeps decoding; the change is what happens to one that would not have.

---

## Evidence {#evidence}

**[F01] The narrowing is a tag check and a cast** — `tugdeck/src/lib/code-session-store.ts:2112` `frameToEvent` casts `decoded as { type?: string } & Record<string, unknown>`, returns null when `type` is not in `KNOWN_CODE_OUTPUT_TYPES` (:301-435, 40 entries), and ends at :2387 with `return ev as unknown as CodeSessionEvent`. That cast appears 17 times in the function. Only the `task_*` frames go through real narrowing functions (`narrowTaskStartedFrame` and siblings, :2365-2370) that return null on a malformed frame; `add_user_message` and `unknown_event` check a field or two by hand. `routeFrame` (:2056) and `divertProgress` (:2083) cast the same way before the set check. **(verified)**

**[F02] A reducer exception is caught in the wrong place with the wrong message** — `code-session-store.ts` has no `try`; `dispatch` (:2421) calls `reduce` directly. The exception propagates through the store's `onFeedStoreChange` listener into `FeedStore`'s constructor (`feed-store.ts:125-147`), whose single `try` wraps decode, filter, map update, and the listener loop (:141-143), and whose `catch` logs `[FeedStore] failed to decode payload for feed 0x…`. `defaultDecode` (:77-84) is `JSON.parse` to `unknown` with no shape check. **(verified)**

**[F03] No schema library and no guard module** — neither `tugdeck/package.json` nor `tugcode/package.json` has zod, valibot, superstruct, arktype, io-ts, typebox, or ajv. Thirty `function is*(…: unknown)` guards exist in `tugdeck/src/lib`, clustered in `changeset-types.ts` (12) and `layout-imposer.ts` (6), and ten `narrow*` helpers; none is shared. **(verified)**

**[F04] The types to decode against are being moved** — `protocol-parity-and-outbound-frames-brief.md` puts the 36 wire shapes in `tugproto/src/outbound.ts`. A decoder written against `events.ts` today would be rewritten when that lands. **(verified by reading that brief)**

---

## Decisions {#decisions}

**[B01] A dependency-free combinator module, `tugproto/src/decode.ts`: `obj`, `str`, `num`, `bool`, `opt`, `arr`, `lit`, `union`, returning a value or a `DecodeError { tag, path, expected, got }`.** No schema library: the laws prefer a small thing the repo owns over a dependency that brings its own type system, and the shapes are flat enough that eight combinators cover them. It lives in `tugproto` so tugcode can use the same decoders on its inbound side later, and so the decoders sit beside the types they decode.

**[B02] One decoder per wire tag, in `tugproto/src/outbound-decoders.ts`, keyed by tag, each returning the tugproto payload type.** `frameToEvent` becomes: read the tag, look up the decoder, run it, and on `DecodeError` log one line with tag, path, expected, and got, then drop the frame. The 17 casts and the 40-name set go away; the set is the decoder table's keys. The `task_*` narrowers in [F01] are the first four decoders, rewritten in the combinators so the arc has a known-good comparison.

**[B03] `FeedStore`'s `try` is split: decode failures log as decode failures, and a listener's exception logs as a listener exception with the feed id and the listener's name.** [F02]: the current message is wrong in both directions. The reducer gets no `try` of its own; after [B02] a reducer exception means a reducer bug, and the store should not hide one.

**[B04] The verdict is the catalog.** The deck's golden-catalog loader (`lib/code-session-store/testing/golden-catalog.ts`) already reads every captured IPC frame; a test runs every frame in every version directory through the decoder table and asserts zero `DecodeError`. That is the proof that the decoders accept what tugcode actually emits, across 15 versions, and it is the test that fails when a decoder is stricter than the wire.

**[B05] This arc lands after `protocol-parity-and-outbound-frames`.** [F04]. If it must run first, the decoders are written against `events.ts` and the parity arc moves them; the brief records the preferred order so the door can hold it.

---

## Open Questions {#open-questions}

- Whether the 40 reducer-only actions in `events.ts` want decoders too. They are constructed in-process, never from bytes, so the default is no: a decoder for a value TypeScript already typed is ceremony.

---

## Non-goals {#non-goals}

- **A schema library.** [B01].
- **Decoding other feeds' payloads.** SESSION_STATE, SHELL, REFS and the rest have their own stores; the combinators are there for them, but this arc is the CODE_OUTPUT boundary.
- **Changing what any frame means to the reducer.**

---

## Exit {#exit}

An arc. Steps: the combinators with their own unit tests; the four `task_*` decoders replacing the narrowers; the remaining decoders in batches by control family, each batch ending with the catalog test in [B04] green; `frameToEvent` cut over and the casts removed; the `FeedStore` split. `bun test` in `tugdeck/` and `tugproto/` is each step's verdict. The `@covers`-derived app-test selection for `code-session-store.ts` and `feed-store.ts` runs once after the last step.
