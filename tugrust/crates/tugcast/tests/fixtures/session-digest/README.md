# The session digester's drift guard

Two files, one test. `frames.jsonl` is a stream of spliced wire payloads;
`lines.golden` is exactly what the digester in
`tugrust/crates/tugcast/src/feeds/session_digest.rs` produces from it. The test
is `feeds::session_digest::golden` in that same file.

## What this guards

The digester replaced a bun-compiled TypeScript daemon whose `OutboundMessage`
types were themselves a guard: rename a field on the wire and the daemon stopped
compiling. Rust reads these frames as `serde_json::Value`, so that guard is
gone, and this is what stands in its place.

It is the stronger of the two. A compile error only ever caught a *rename*; a
pinned line set catches a **semantic** change as well — a verb that stops
reading as a verb, a path that starts clipping from the wrong end, a beat that
quietly stops being emitted ahead of the throttle. What the golden pins, per
frame in wire order, is the session, the line's kind, its emission class, its
text and its retained intent; and then, per session, the digest the whole stream
leaves behind.

## What this is — and what it is not

**The frames are authored, not captured.** That is a deliberate choice and the
reason is worth writing down, because the obvious sources both fail:

- `../stream-json-catalog/v2.1.258/` and its siblings are real captures **in the
  right vocabulary** — `assistant_text`, `tool_use`, `tool_input_progress`, the
  lot — but every value in them is redacted to a placeholder (`{{uuid}}`,
  `{{text:len=5}}`, `{{cwd}}`). They are a *schema* corpus, which is what
  `stream_json_catalog_drift.rs` needs and the exact opposite of what a golden
  over produced **text** needs.
- The pulse spike's capture (retired with this consolidation) held real prose,
  but as raw SDK stream-json — `system` / `assistant` / `result` envelopes.
  Those are what tugcode *reads*; the digester reads what tugcode *writes*.
  Converting one to the other inside a test would mean re-implementing tugcode's
  reframer, and then the fixture would pin that re-implementation rather than
  the digester.

So the frames here are written by hand with their **shapes taken field for field
from the `v2.1.258` captures**, which are the authority on what tugcode actually
puts on the wire, and realistic text filled in. Nine of the fourteen line kinds
appear in no capture at any version anyway — a compaction, a cancelled turn, a
retry, a refusal fallback, a truncation, a permission cancel — so a fixture that
covered only what had been recorded would have holes exactly where the rare
kinds are, which is where drift hides.

If a capture with real text in the reframed vocabulary ever lands, reseeding this
file from it is an improvement and the golden rebuild is one command.

## Reading `frames.jsonl`

One spliced payload per line. Blank lines and lines starting with `#` are
comments, and they carry the argument for why each frame is there — read them
rather than the JSON.

The **wire** a line arrived on is recovered from its own `type`: `user_message`
is `CODE_INPUT`, `exchange_started` / `exchange_complete` are `SHELL_OUTPUT`, and
everything else is `CODE_OUTPUT`. The live bridge knows this from which
broadcast it is subscribed to; a JSONL line has no envelope, so the fixture reads
it back off the payload. Shell frames carry `tug_session_id` here for the same
reason — live, the scope arrives on the broadcast rather than in the payload.

The stream runs four sessions, because several of the properties under test are
about sessions *not* interfering:

| Session | What it is for |
|---|---|
| `s-alpha` | An ordinary turn end to end: the ask, the monologue, a read and its result, a streaming write, a path past the target budget, both shell outcomes, the marker. |
| `s-bravo` | A replay flood inside `replay_started` / `replay_complete` brackets — none of which may be narrated — with `s-alpha`'s live work interleaved so the mute cannot be global. Then agents, task lifecycle, a skill, and the notice beats. |
| `s-charlie` | The narrated permission wait and **both** of its endings (a withdrawal, and the named call's own `tool_result` — the allow path, which nothing outbound announces), plus a question's wait that names no call, plus both compaction triggers. |
| `s-delta` | The sentence rules at their edges: math-atomic extraction with a borrowed label, a dangling heading label, an enumerator's dot. |

Two frames near the end are defensive: a malformed line, which must never panic,
and an allowlisted-but-unspliced one. Both are pinned as producing nothing.

An `error` frame is in the allowlist and produces **no line**, which the golden
records. The retired daemon narrated it no more than this does, and the first
landing of this consolidation must change nothing the reader sees; giving it a
beat is a change to make deliberately, not as a side effect of a port.

## Rebuilding the golden

```bash
cd tugrust && TUG_DIGEST_GOLDEN_UPDATE=1 cargo nextest run -p tugcast session_digest
```

`just golden` runs it alongside the project's other goldens. The env var writes
`lines.golden` and asserts nothing, so **read the diff before committing it** —
a golden rebuilt without reading the diff guards nothing at all. The recipe is
what makes this a derived file rather than a hand-maintained one.
