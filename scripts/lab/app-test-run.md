# App-tests in a lab guest

`just lab-app-test <os> [--keep] [files…]` runs app-tests inside a fresh Tart
guest instead of on your Mac. It exists for tests that must change something
the whole login session shares, such as the keyboard's input source. On the
host that would change the keyboard of every app you are running, and a crashed
run would leave it changed. In a throwaway guest nobody else is using it, and
the guest is deleted afterwards.

```sh
just app-test-build                       # if Swift / Rust / harness source changed
just lab-app-test golden-gate harness-smoke/smoke-native-cmd-a.test.ts
```

The output is the ordinary app-test report from inside the guest, ending in its
`VERDICT:` line, and the recipe exits with the guest run's status.

`--fetch <path>` copies a file the run wrote, named relative to the checkout,
out of the guest to the same path here before the guest is deleted; it may be
given more than once. A reading uses it to bring its recording home (see
`tests/app-test/readings/lab-layout-recording.test.ts`). A per-file budget set
in `TUG_APPTEST_FILE_BUDGET_SECS` on the host crosses into the guest.

## What it needs

- The lab disk and Tart, as for every lab recipe (`base-prep.md`).
- This checkout's app-test bundle. It is built first if it is absent, exactly as
  `just app-test` does. After changing Swift, Rust or harness source, run
  `just app-test-build` yourself, because a present bundle is never rebuilt.
- A Debug bundle. The harness bridge is compiled only into Debug builds
  (`#if DEBUG` in `AppDelegate.swift`), so a release or DMG build cannot host a
  test.
- Nothing installed in the guest. Everything the run uses crosses from the host.

## What it does

On the host, `scripts/lab/lab-app-test`:

1. Archives the working tree into one tar: tracked files plus untracked files
   that are not ignored (so uncommitted work rides along), the three
   `node_modules` directories, and the helper binaries in
   `tugrust/target/debug`. It also archives the bundle.
2. Stages those archives in a temporary folder, with the host's `bun` and
   `just`, the self-contained `tmux` and its terminfo from
   `tugrust/scripts/fetch-tmux.sh` (built from source on the first run, then
   cached per checkout), the guest script, and one-line files naming the
   branch, product, DerivedData leaf and bundle id.
3. Clones a fresh `run-apptest-<os>` from `base-<os>`, boots it headless with
   that folder shared read-only, waits for the guest agent, and runs
   `scripts/lab/guest-app-test` over `tart exec`.
4. Stops the guest and deletes the clone when the run ends, even if it fails.
   With `--keep` it leaves the clone stopped instead.

In the guest, `scripts/lab/guest-app-test`:

1. Unpacks the bundle into the same DerivedData path a host build uses.
2. Unpacks the tree at the bundle's `BuildSourceTree` path, which is the host's
   own checkout path. It then makes the tree a one-commit git repository on the
   host's branch name, so `app-test.sh` derives the same bundle path.
3. Installs `bun` and `just` per user, and `tmux` in `/usr/local/bin` with its
   terminfo in `~/.terminfo`.
4. Grants the bundle Accessibility and event posting by writing the system TCC
   database, keyed on the bundle's designated requirement. The bases boot with
   SIP disabled, so the database is writable, and the guest is thrown away.
5. Sets `TUG_LAB=1`, `TUG_APPTEST_ASSUME=all`, and a 60 s per-file budget
   (unless `TUG_APPTEST_FILE_BUDGET_SECS` is already set), then runs
   `just app-test` with your files.

## Why it is shaped this way

The first runs failed in three ways, and each shaped a step above.

- **Nothing runs from the share.** Reading `node_modules` file by file over
  virtiofs ran the guest out of file handles ("Too many open files in
  system"). The tree crosses as one archive and is unpacked onto the guest's
  own disk.
- **The tree sits at the host's path.** A Debug bundle records the checkout it
  was built from as `BuildSourceTree`. A fresh instance hands that path to
  tugcast as its bootstrap workspace, and tugcast panics when the path does not
  exist ("bootstrap workspace must be a valid directory"). The deck then never
  loads, and the test fails waiting for `window.__tug`. Putting the copy at that
  path needs no change to the app.
- **tmux comes from the host's static build.** Only a release bundle carries its
  own tmux. A Debug bundle takes it from the login shell's `PATH`, and a
  factory-fresh guest has none.

The app's stderr goes to `tests/app-test/logs/<test>.log` inside the guest.
When a run fails before the deck loads, rerun with `--keep`, boot the clone
(`TART_HOME=/Volumes/Lab-A/tart tart run run-apptest-<os> --no-graphics`), and
read that log with `tart exec`. tugcast's panics are there, and nowhere else.

## The lab flag

`TUG_LAB=1` marks a run as a lab run. The harness forwards every `TUG*`
variable to the app, so the app sees it too. Harness verbs that would change
session-global state, such as selecting a keyboard input source, refuse unless
it is set. This script is the only thing that sets it, and a host run never
does. Do not export it on your Mac.

A test that needs a lab guest says so with `@lab` in its header docblock. On the host, `app-test-changed`, `app-test-select`, the core tier and `app-test-all` never pick such a file, whatever its `@covers` match; with `TUG_LAB=1` set, the same selection keeps it. The file itself also skips when the flag is absent, so naming it by hand on the host runs nothing.

## Measured

On 2026-11-14, Golden Gate 27.0 guest on a macOS 27.0.1 host: the guest agent
answered about 5 s after boot. `harness-smoke/smoke-native-cmd-a.test.ts`, a
native ⌘A posted through the harness's pid mode, ran green in 4 s.
