<!-- brief-skeleton v1 -->

# Outbound frame types in `tugproto`, and a typed CONTROL vocabulary with parity tests

**Purpose:** The frames tugcode emits are declared in tugcode and re-declared by hand in tugdeck, with no test that the two agree; the CONTROL actions tugdeck sends are matched as string literals in three Rust dispatch points with no test that every sender has a receiver. One deck action already falls through to a catch-all today.

---

## Purpose {#purpose}

Item 14 of `briefs/audit-punch-list.md`:

> 14. Move the outbound frame types into `tugproto`, import them from tugcode and tugdeck, and add a tag-set parity test. Then typed CONTROL request and reply enums in `tugcast-core` with a drift test against the TS union, the way `stream_json_catalog_drift.rs` already does for Claude frames.

The wire does not change: no frame gains or loses a field, no action is renamed. What changes is that each side's declaration is checked against the other's.

---

## Evidence {#evidence}

**[F01] `tugproto` is inbound-only and source-only** — `tugproto/src/inbound.ts` (466 lines) exports 19 inbound payload interfaces, the `InboundMessage` union (:396), `INBOUND_VERBS` (:424), and `isInboundMessage` (:462), which checks only that `type` is a known string. `claude-home.ts` is the other file. There is no package.json; both tugdeck and tugcode reach it through a `@tugproto/*` tsconfig path (`tugdeck/tsconfig.json:19`, `tugcode/tsconfig.json:15`, `vite.config.ts:890`). **(verified)**

**[F02] tugcode's outbound union has 55 members; the deck's event file has 82 shapes, 36 of which are those frames** — `tugcode/src/types.ts` `OutboundMessage` (:1708) is a union of 55 tagged payloads, each carrying `ipc_version: number`. `tugdeck/src/lib/code-session-store/events.ts` (1,765 lines) declares 82 event shapes under `CodeSessionEvent` (:1683): 36 match tugcode tags, 40 are reducer-only actions (`send`, `tick_*`, `consume_*`, `transport_*`), 2 are deck renames of tugcode frames (`session_stage` from `session_segment`/`replay_stage`, `session_relocation` from `replay_relocation`), and 4 are frames tugcast emits, not tugcode (`session_unknown`, `session_not_owned`, `tug_notice`, `arc_note`). The punch list's 57 and its "21 tugcode tags with no deck counterpart" were miscounts. **(verified)**

**[F03] 19 tugcode tags have no `events.ts` shape, and 8 of those are never named in tugdeck at all** — `activity_delta`, `background_tasks_changed`, `control_request_cancel`, `protocol_ack`, `session_rewound`, `session_title`, `tool_approval_request`, `tool_input_progress` have no non-test literal anywhere in `tugdeck/src`. Five are handled in other stores (`hooks_inventory`, `skills_inventory`, `side_question_answer`, `rate_limit_event`, `session_capabilities`), and the rest are unwrapped or translated inside `code-session-store.ts` (`replay_batch` :2059, `tool_progress` :2086, the three renames at :2318-2340). **(verified)**

**[F04] `ipc_version: 2` is written as a bare literal 95 times in tugcode** — `event-mapping.ts` 36, `session.ts` 35, `replay-runner.ts` 9, `rewind.ts` 4, and seven others; two file-local `IPC_VERSION` constants exist (`replay.ts:79`, `subagent-tail.ts:58`). The deck never checks the value; Rust passes it through (`session_metadata_merge.rs:36`, `agent_bridge.rs:2356`). **(verified)**

**[F05] CONTROL actions: 61 in Rust, 59 in TypeScript, and the asymmetry is four** — Rust dispatches at `agent_supervisor/mod.rs:1937` (44 literals across six family modules), `actions.rs:245` (15 literals, legacy, with an `other =>` arm that re-broadcasts unknown payloads on CONTROL), and `router.rs:1358-1366` (`feed_stats`, `subscribe_feeds`). TypeScript builds them through `protocol.ts:582 controlFrame`, 15 `CONTROL_ACTION_*` constants, the `ACTION_FOR` map in `arc-verb-row.tsx:78`, and three object literals. Rust-only: `feed_stats`, `shared_agent_classify`, and `relaunch` (sent by app-tests only). TypeScript-only: `changeset_join_review` (`changeset-join-store.ts:741`), which no Rust arm matches and so falls into the `actions.rs` catch-all. The punch list's 114 versus 65 was wrong. **(verified)**

**[F06] `session_metadata_merge.rs` hand-mirrors tugcode's keys** — a `mod keys` block (:32-55) and `SCALAR_FIELDS`/`ARRAY_FIELDS` (:58-74) list the `system_metadata` fields, and the module doc cites `session.ts:498,508` and `replay.ts:995,1004`, which are stale since the session split (the emitters are now `event-mapping.ts:540`, `session.ts:2287`, `replay.ts:3068`). **(verified)**

**[F07] `tugcast-core` exists and holds no CONTROL vocabulary** — `protocol.rs` (1,229 lines) and `types.rs` (2,314 lines) carry `FeedId`, `Frame`, the handshake constants, and snapshot types. The drift test the item cites, `tests/stream_json_catalog_drift.rs`, is a real-claude-gated shape differ over the IPC catalog, with 33 unit tests of the differ that need no claude. **(verified)**

---

## Decisions {#decisions}

**[B01] `tugproto/src/outbound.ts` becomes the one declaration of the 55 outbound payloads, `OutboundMessage`, `OUTBOUND_TAGS`, and `IPC_VERSION`.** tugcode's `types.ts` re-exports from it so no tugcode importer changes; the 95 literals become `IPC_VERSION`. The deck's `events.ts` keeps its 40 reducer actions and the 4 tugcast frames as its own, and for the 36 wire shapes it imports the tugproto type instead of restating it. The two renames in [F02] stay as deck-side derived shapes, typed as `Omit<…> & { type: "session_stage" }` over the tugproto source so a field added upstream appears in them.

**[B02] The parity test is a `bun test` in `tugproto` asserting `OUTBOUND_TAGS` equals the set of `type` literals in tugcode's union, and a second asserting every tag is either in the deck's wire-shape set, in a named "handled elsewhere" list (the five stores in [F03]), or in a named "dropped on purpose" list (the eight in [F03]).** The lists are the point: today the eight dropped tags are a fact nobody wrote down. Any new tugcode tag fails the test until it is placed, which is the drift this item exists to catch.

**[B03] A `ControlAction` enum in `tugcast-core` with `as_str`, `FromStr`, and `ALL`, and the three Rust dispatch points match on it.** The 61 strings become one enum; `actions.rs`'s `other =>` arm keeps broadcasting but logs the unmatched string, since the catch-all is how the deck reaches feeds that do not go through the supervisor. The deck's `CONTROL_ACTION_*` constants and the `controlFrame` first argument become a `ControlAction` string-literal union in `tugproto/src/control.ts`.

**[B04] The CONTROL drift test is a tugcast-core unit test that reads `tugproto/src/control.ts` as text and compares its literal set to `ControlAction::ALL`, with the same two allow-lists as [B02].** It is a drift test in the shape of `stream_json_catalog_drift.rs`'s differ, not of its real-claude capture: it needs no process, runs in `cargo nextest`, and fails on the day either side adds an action the other does not know. `changeset_join_review` is resolved by this arc as part of landing the test: either a Rust arm exists for it or the deck stops sending it, and the arc's log says which after reading `changeset-join-store.ts:741`.

**[B05] `session_metadata_merge.rs`'s key lists are generated from the tugproto `SystemMetadata` type by the same text-reading test, which fails when the Rust list and the TypeScript interface disagree.** [F06] is the one place Rust mirrors a tugcode payload field by field; the stale doc citation shows what hand-mirroring costs. A failing test with both lists in its message is cheaper than codegen.

**[B06] Order: [B01] and [B02] first, then [B03] and [B04], then [B05].** The outbound move is pure relocation and its test proves the deck's lists; the enum is a behaviour-preserving rewrite of three match statements that the drift test then guards; the metadata keys are the smallest and last.

---

## Open Questions {#open-questions}

- Whether `relaunch` (sent only by app-tests) and `feed_stats`, `shared_agent_classify` (sent by nothing) should be deleted or placed on the Rust-only allow-list. The default is the allow-list with a reason each, since deleting a control arm is a product question this arc does not need to answer.

---

## Non-goals {#non-goals}

- **Runtime decoding at the deck's boundary.** `deck-boundary-decode-guards-brief.md`; this arc gives it the types to decode against, so it should land first.
- **Typing Claude's own stream-json.** `stream-json-wire-types-brief.md`.
- **Changing any frame field, action name, or the `actions.rs` catch-all's broadcast.**
- **Giving `tugproto` a package.json.** The path alias works for both consumers and a package would need a build.

---

## Exit {#exit}

An arc. Steps as ordered in [B06]: `outbound.ts` with the tugcode re-export and the `IPC_VERSION` sweep; the two parity tests with their lists; the `ControlAction` enum across the three dispatch points; `control.ts` and the drift test, with `changeset_join_review` resolved; the metadata-keys test. `bun run check` in `tugcode/` and `tugdeck/`, `bun test` in `tugproto/`, and `cargo nextest run -p tugcast-core -p tugcast` are each step's verdicts. The `@covers`-derived app-test selection for `code-session-store.ts` and `protocol.ts` runs once after the last step.
