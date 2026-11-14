# capabilities/

Bundled Claude Code capability snapshots consumed by Tug.app + tugdeck at
build time. Each `<version>/` directory holds the normalized `system_metadata`
frame captured from a specific `claude` release — the authoritative source
for what slash commands, skills, agents, and plugins are available to the
graphical UI.

**Canonical version format:** `X.Y.Z` (e.g. `2.1.105`). No `v` prefix in the
directory name, the `LATEST` pointer, or the payload's `version` field.

## Layout

```
capabilities/
  LATEST                       # text file — single version string, e.g. "2.1.105\n"
  FLOOR                        # text file — the oldest Claude Code Tug runs against, e.g. "2.1.285\n"
  2.1.105/
    system-metadata.jsonl      # one-line JSONL; the captured system_metadata event
  2.1.106/                     # future snapshots land here (retained; never deleted)
    system-metadata.jsonl
```

## Consumers

- **Tug.app (Swift).** The `Copy Rust binaries, tugdeck dist, and capabilities`
  build phase resolves `LATEST`, copies `capabilities/<version>/system-metadata.jsonl`
  into `Tug.app/Contents/Resources/capabilities/system-metadata.jsonl`, and
  the Swift host loads it on startup.
- **tugdeck (Vite).** The `capabilities-virtual-module` plugin in
  `tugdeck/vite.config.ts` resolves `LATEST` and inlines the payload into the
  tugdeck bundle behind `virtual:capabilities/system-metadata`, so the
  slash-command popup is populated synchronously.
- **`tugdeck/src/__tests__/system-metadata-fixture.test.ts`.** Reads the shipped
  snapshot off disk and pins its command / skill / agent counts. A capture that
  changes what claude offers changes those numbers — update them alongside the
  snapshot.

- **The Claude Code versions the deck is built with.** `LATEST` is also the
  "validated against" version the session badge shows and version drift is
  judged from, and `FLOOR` is the version below which ConfigureTug holds the
  app until Claude Code is updated. `claudeCodeVersionDefines` in
  `tugdeck/vite.config.ts` inlines both into the bundle, and
  `tugdeck/src/lib/claude-code-versions.ts` is the one module that reads them.

## The floor

`FLOOR` is the one file here a person writes. A capture never moves it. Raise
it only when Tug starts depending on something a newer Claude Code introduced,
because every raise is a forced Claude Code update for somebody; it must never
be above `LATEST`, which would be a floor nobody captured against.

## How snapshots get here

The capture binary writes the snapshot and rolls `LATEST` as the final step of
the stream-json catalog's version-bump runbook (see
`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md#version-bump-runbook`).
Run it via:

```sh
just capture-capabilities
```

The payload is the `system_metadata` event from probe-28
(`test-28-system-metadata-deep-dive`), normalized the same way the catalog
fixtures are.

## Manual rotation

Only needed when re-deriving a snapshot from a catalog version already on disk.

```sh
# 1. Pick the desired stream-json catalog version.
VER=2.1.222

# 2. Extract the system_metadata event from probe-28.
mkdir -p capabilities/$VER
grep '"type":"system_metadata"' \
  tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v$VER/test-28-system-metadata-deep-dive.jsonl \
  > capabilities/$VER/system-metadata.jsonl

# 3. Update the pointer.
echo "$VER" > capabilities/LATEST
```

## Retention

Never delete an old version directory — each snapshot is a few hundred bytes
and keeps historical UI behavior reproducible. Matches the retention policy
of the stream-json catalog.
