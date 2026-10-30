## Reading the render stage

The stage keeps **one document per message** and re-parses it on every tick. That sounds wasteful — it isn't, because a tick is bounded by the display period and the parse is linear in the text.

Three things decide what a tick emits:

1. The *accumulated* text, which grows by partial deltas.
2. The previous emission's block hashes, so unchanged blocks ship without HTML.
3. Whether a motion hold is open, in which case the batch waits.

```rust
fn tick(&mut self) -> Vec<RenderedBlock> {
    let blocks = render_blocks(&self.text, Highlight::On);
    blocks.into_iter().filter(|b| self.seen.insert(b.hash)).collect()
}
```

| Input | Effect | Cost |
|:------|:------:|-----:|
| partial delta | append | O(n) |
| final text | replace | O(n) |
| motion open | hold | 0 |

> A hold is a promise, not a pause: the stage still parses, it only stops publishing.
> Releasing the hold publishes the merged batch as one bundle.

- [x] hashes match the page's
- [ ] highlighting lands later
- nested:
  - the first block keeps its hash
  - the growing tail block changes every tick

Inline math like $a^2 + b^2$ stays in the paragraph, while a fence promotes:

```math
\sum_{i=1}^{n} t_i \le P
```

```tugchart
{"tugchart": 1, "form": "sparkline", "values": [3, 5, 4, 8, 6]}
```

Multi-byte text streams too: 漢字 and 😀 split across deltas never land mid-character, because a delta boundary is snapped to the next character.

A footnote[^pace] closes the reference chain, and a [reference link][feed] resolves across blocks.

[^pace]: The pace is the display period the page reports.

[feed]: https://example.invalid/feeds/rendered "RENDERED"

---

### Edge cases worth streaming

An unclosed **bold run keeps going until the next tick closes it, and an unclosed fence swallows everything after it:

```ts
const open = "fence";
// the rest of the message arrives here

Then the fence closes, and the trailing paragraph returns to normal flow. Lists that start mid-tick, like

- this one
- and this

should never flicker between a paragraph and a list once the marker has arrived. Tables are the hardest case: a header row alone is a paragraph until the delimiter row arrives.

| Late | Table |
|------|-------|
| a | b |

That's the whole tour. The end.
