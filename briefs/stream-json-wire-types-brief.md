<!-- brief-skeleton v1 -->

# Type Claude's stream-json wire once in tugcode, and capture it so the types can be checked

**Purpose:** tugcode reads Claude Code's stream-json with 149 `as` casts across twelve files, 129 of them in the event mapper and the session manager, against a 177-line `protocol-types.ts` that covers four message kinds and none of the streaming ones. The catalog the audit expected to type from does not contain the raw wire.

---

## Purpose {#purpose}

Item 16 of `briefs/audit-punch-list.md`:

> 16. Type the Claude stream-json wire once from the captured catalog, retiring the 126 casts in `session.ts`.

As written, the item cannot be done: the catalog is the wrong side of tugcode. The work is the same, with one extra step to make it checkable.

---

## Evidence {#evidence}

**[F01] The casts, after the session split** — `as string` 68, `as Record<string, unknown>` 51, `as number` 15, `as unknown` 15: 149 in `tugcode/src` outside tests. By file: `event-mapping.ts` 80, `session.ts` 49, `rewind.ts` 7, `active-turn.ts` 3, and eight files with one or two. Inline `as {` casts add 18 (journal.ts 8, replay.ts 4) and `event-mapping.ts` has 13 array casts on top. **(verified)**

**[F02] What is typed today** — `tugcode/src/protocol-types.ts` (177 lines) declares `SystemInitMessage`, `SystemTaskNotificationMessage`, `ResultMessage`, `ControlRequestMessage`, `ModelUsageEntry`, `PermissionSuggestion`, `AskUserQuestionInput`, and three tool-result shapes. There is no type for `assistant`, `user`, or `stream_event`, which are the messages the mapper spends its casts on. Its one non-test importer is `web-components.ts:5`. `replay.ts:157-295` `JsonlEntry` has 13 top-level fields, all optional, with `type` a bare `string`. **(verified)**

**[F03] The catalog is tugcode's output, not Claude's** — `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/` (11 MB, 659 files, 15 full version directories from v2.1.104 to v2.1.285 and three spikes) is captured by `capture_stream_json_catalog.rs` from a `TestTugcast`, recording CODE_OUTPUT and SESSION_SIDEBAND frames after tugcode has mapped them. The v2.1.285 `schema.json` lists 24 event types, all tugcode IPC tags with `ipc_version` and `tug_session_id`; no file contains `stream_event` or `"type":"assistant"`. The `just capture-capabilities` recipe (`justfile:154`) runs it under `TUG_REAL_CLAUDE=1` and refuses on a dirty `tugplug/`. No codegen from it exists anywhere. **(verified)**

**[F04] The capture already runs the real binary through tugcode** — which means the raw bytes exist on tugcode's stdin reader during every capture; nothing records them. **(verified by reading the capture test's spawn path)**

---

## Decisions {#decisions}

**[B01] The capture grows a raw-wire tap: tugcode, under `TUGCODE_WIRE_TAP=<path>`, appends every line Claude writes to its stdout before parsing, and `capture_stream_json_catalog.rs` sets it so each `v<version>/` gains a `wire/` directory beside the IPC files.** This is the one new mechanism in the arc and it is what makes the rest checkable. The tap is a dev-only env var read once at spawn, off in production, and the catalog README gains a paragraph. Fifteen historical versions have no raw capture and will not; the drift guard starts at the next `capture-capabilities` run.

**[B02] `tugcode/src/claude-wire.ts` is the one declaration: a discriminated union over `type` (`system` by `subtype`, `assistant`, `user`, `result`, `stream_event` by `event.type`, `control_request`, `control_response`, and the unknowns), hand-written, with `protocol-types.ts` folded into it.** Hand-written rather than generated, since [F03] shows no codegen exists and a generator would need a dependency and a build step for a union of about twenty shapes. Every member keeps an index signature for fields Tug does not read, so a new upstream field is not a type error.

**[B03] The mapper, the session manager, and `rewind.ts` take `ClaudeWireMessage` and narrow by discriminant; the casts come out file by file.** `event-mapping.ts` first (80), then `session.ts` (49), then the long tail. The gauge is the count in [F01], and it reaches zero for `as string`, `as number`, and `as Record<string, unknown>` in those three files; the journal and replay casts over `JsonlEntry` are the next decision.

**[B04] `JsonlEntry` becomes a union over `type` with the same shape discipline, and the journal reader narrows once at the line.** [F02]: every field optional is the same thing as `unknown` with worse ergonomics. The transcript JSONL and the stream-json share their message bodies, so the `assistant` and `user` members of [B02] are reused rather than duplicated.

**[B05] The drift test is a `bun test` in tugcode that reads every `wire/*.jsonl` the catalog holds and asserts every line narrows to a known member, with unknown members counted and listed rather than failed.** It is the counterpart of `stream_json_catalog_drift.rs`: that test says "tugcode's output moved", this one says "Claude's output moved". Unknown members are a warning, not a failure, because Claude adding a message kind is not a Tug bug until Tug relies on it.

---

## Open Questions {#open-questions}

- Whether the `@anthropic-ai/claude-agent-sdk` package's published message types can be the source of [B02] instead of a hand-written file. It is not a dependency today and the arc should look at its types before writing its own; if they match the wire tugcode sees, importing them is less to maintain, and the drift test in [B05] still applies. The brief does not settle it because the package has not been read.

---

## Non-goals {#non-goals}

- **Typing from the existing catalog.** [F03]; it is the wrong side.
- **Codegen.** [B02].
- **Changing what the mapper emits.** The IPC frames are held fixed; `stream_json_catalog_drift.rs` is the proof.
- **Moving the outbound frames into `tugproto`.** `protocol-parity-and-outbound-frames-brief.md`.

---

## Exit {#exit}

An arc. Steps: the tap and one capture run to seed `wire/` for the current version (the one slow step, about three minutes under `just capture-capabilities`); `claude-wire.ts` with `protocol-types.ts` folded in; the three cast sweeps; the `JsonlEntry` union; the drift test. `bun test` and `bun run check` in `tugcode/` are each step's verdict; the `@covers`-derived app-test selection for `tugcode/` runs once after the last step. Run it after `tugcode-session-split` has joined, which it has, and not concurrently with `protocol-parity-and-outbound-frames`, which edits `types.ts`.
