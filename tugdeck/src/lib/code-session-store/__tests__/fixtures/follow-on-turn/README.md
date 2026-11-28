# Follow-on turn: tugcode's frames for a message claude ran as a turn of its own

`tugcode-frames.jsonl` is every frame the real tugcode wrote to the deck, in order, over a real claude (2.1.325, model haiku), recorded on 2026-11-27. The account email in `session_capabilities` is replaced with `user@example.com`; nothing else is edited.

The driver wrote two `user_message` frames to tugcode:

1. On `session_init`: "Run exactly one Bash command: echo committed. Then reply with one short sentence saying it is done. Do nothing else."
2. On the **first `tool_result`** (line 18), the moment the deck's tool-result pickup forwards a mid-turn message today: "Also run: echo pushed", with submission id `2bd7ccb3-1ea1-4cad-9329-4a60719d3f04`.

claude had already started its next model request when the second message arrived, so it did not merge the message: it ran it as a turn of its own after the first turn's result. What tugcode emitted for it:

- line 30, `turn_complete` closes the first turn;
- line 35, `prompt_anchor` carrying the second message's submission id as `promptUuid`;
- lines 36–52, the follow-on turn's `content_block_start`, `tool_use`, `tool_result` and `assistant_text` ("The command ran and printed `pushed`.");
- line 53, a second `turn_complete`.

No frame announces the follow-on turn's opening message: there is no `add_user_message` or anything like it. A deck that treats every frame after line 30 as belonging to no turn draws the first turn alone, which is the defect this fixture exists to pin.

The recording predates tugcode forwarding claude's `command_lifecycle` frames, so it carries none. In claude's own stream the second message's `command_lifecycle started` arrives after the first turn's `result`, which is what marks a follow-on rather than a merge. `code-session-store.follow-on.test.ts` splices the two frames tugcode now writes at that point (`command_lifecycle started` and `follow_on_started`) in after line 32, ahead of the follow-on's `system_metadata` at line 33; the recording itself is left as it was captured.
