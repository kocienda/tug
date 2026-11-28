# Where a mid-turn message lands: claude's raw stdout

Each file is every line a real claude (2.1.325, model haiku) wrote to stdout, in order, recorded on 2026-11-27 with tugcode's stream flags (`--input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages`). The only edit is the auto-memory path in `system/init`, where the home directory reads `/Users/user/`.

Two messages went in, with fixed uuids so a test can submit them under the same submission ids:

- `aaaaaaaa-0000-4000-8000-00000000000a` — the turn's opening message;
- `bbbbbbbb-0000-4000-8000-00000000000b` — "Also run: echo pushed", written while the first turn ran.

The three files differ only in when the second message was written, and claude's `command_lifecycle` for it says where it landed:

| File | Second message written | `started` for it | Results |
|---|---|---|---|
| `merged.jsonl` | while the turn's `sleep 4` ran | inside the turn, after the tool's result | one |
| `follow-on.jsonl` | on the turn's only `tool_result` | after the first `result`, ahead of the follow-on turn's own `system/init` | two |
| `wake.jsonl` | during the foreground `sleep 4` of a turn a background job's notification started | inside the wake turn | two (the first turn's and the wake's) |

In `follow-on.jsonl` the order is `result`, `completed` for the first message, `started` for the second, then a fresh `system/init`. A drain that opens the follow-on's turn on `started` sees that init inside an open turn; one that waits for later events would read the init between turns as a wake.
