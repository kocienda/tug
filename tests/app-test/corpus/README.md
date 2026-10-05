# Real-session corpus

The resume-performance test legs measure against REAL session JSONLs
harvested from this machine — synthetic fixtures validated machinery,
not workload, and are banned for performance claims.

## What lives here

| Path | Committed? | What |
|------|------------|------|
| `harvest.ts` | yes | the harvester CLI (survey + classify + snapshot) |
| `classify.ts` | yes | pure-logic statistics/classification (streaming) |
| `classify.test.ts` | yes | pure-logic tests (`bun test corpus/classify.test.ts`) |
| `manifest.json` | **no** (gitignored) | full population survey + selected set |
| `snapshots/` | **no** (gitignored) | materialized session snapshots |

Session content never reaches git. The manifest carries paths and
numbers (sizes, turn counts, block histograms), not prompt text.

## Refresh the corpus

```bash
bun run tests/app-test/corpus/harvest.ts
```

- Surveys every `~/.claude/projects/*/*.jsonl`, streaming — the
  whale-class files are never held in memory.
- Skips sessions a terminal currently holds (`~/.claude/sessions/`
  registry) and tolerates torn final lines (live appends).
- Classifies by size (`typical` <1MB ≤ `heavy` <20MB ≤ `whale`) and
  shape (`tool-heavy` / `thinking-heavy` / `image-bearing` / `prose`).
- Selects the newest representative per class × shape plus pinned ids
  (always `763cd1d8…`), then materializes: typical/heavy are copied;
  whale snapshots are hardlinked (or left as in-place references), with
  `{strategy, sourcePath, size, mtime}` recorded so a runner can detect
  a drifted reference.

`--dry-run` writes the manifest without materializing snapshots.
Other flags: `--projects-root`, `--sessions-dir`, `--out`, `--pin
<id-prefix>` (repeatable), `--quiet`.

Corpus-driven app-test legs `skipIf` cleanly when `manifest.json` is
absent — a machine without a harvested corpus still gates on the
real-shape generator legs.

## The settle legs' whale arm

The settle tests (`at0555`, `at0566`, `at0605`, `at0621`, `at0622`, `at0643`, `at0684` and `at0690`) run each leg twice through `transcriptArms()` in `real-transcript-fixture.ts`: once on the committed `session-transcript-basic` slice, and once with the corpus's selected whale (`whaleSnapshot()`: the pinned whale when the manifest selected it, otherwise its first `whale`-class entry) bound on the cards the gesture resizes or moves. Every other card on the deck takes the slice, because a deck of eight whales is a deck no user has. Each card gets its own copy, seeded under a fresh session id.

The whale arm is skipped, not failed, on a machine with no `manifest.json` or no whale in it, so a fresh checkout runs the slice arm alone. Run the harvester above to arm it. The arm never falls back to the slice: a whale reading taken on a slice would read as a whale reading.
