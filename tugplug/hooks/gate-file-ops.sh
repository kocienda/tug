#!/bin/bash
# Deny the Bash commands whose file operations the attribution grammar cannot
# read, steering each to the `tugutil file` verb that covers it.
#
# Three cases reach a denial. A lifecycle command (`rm`, `mv`, `cp`) whose
# operands are a glob or a shell variable names nothing the relay can resolve,
# so the deletion would land in `unattributed` with only a hint — that is worth
# a round trip, because `tugutil file rm` expands the operands itself and
# reports exactly which files it removed. An in-place editor with the same
# problem is steered at `tugutil file edit`. And an interpreter handed its
# program inline — a heredoc body, a `-c`/`-e` argument — that writes a repo
# file is steered at `tugutil file rev`, because that body is data the grammar
# will never read and the edit would land unattributed however it is spelled.
#
# A literal `rm a.ts` names its file, so the relay records it as proof and this
# hook lets it through untouched; so does a heredoc that only reads, or that
# writes somewhere the ledger has no business.
#
# The decision is computed by `tugutil file gate`, which uses the very grammar
# the relay uses, so the two cannot drift. Anything unexpected — no tugutil on
# PATH, no jq, unreadable output — exits 0 and falls through to the normal
# permission flow: a broken gate must never block work.

INPUT=$(cat)

command -v jq >/dev/null 2>&1 || exit 0
command -v tugutil >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -n "$CMD" ] || exit 0

DECISION_JSON=$(tugutil file gate --command "$CMD" 2>/dev/null) || exit 0
DECISION=$(echo "$DECISION_JSON" | jq -r '.decision // empty' 2>/dev/null) || exit 0
[ "$DECISION" = "deny" ] || exit 0

REASON=$(echo "$DECISION_JSON" | jq -r '.reason // "this command names no file the change ledger can resolve"')

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
