# Golden base prep (macOS VM lab)

How to build and prep the factory-fresh golden base VMs the lab clones for
install/onboarding testing. One base per supported macOS line, named
`base-<key>` (the keys in [`matrix.json`](matrix.json)): `base-sequoia`,
`base-tahoe`, `base-golden-gate`.

A golden base is prepped **once** and then never used to run Tug directly —
every test boots a throwaway clone (`just lab-cycle <key>`, see the lab recipes
in the `Justfile`). Keep the bases pristine.

## Prerequisites

- [Tart](https://tart.run) 2.33+ (`brew install openai/tools/tart`). The project
  moved from Cirrus to OpenAI and relicensed under FSL-1.1-ALv2; the old
  `cirruslabs/cli` tap is frozen at 2.32.1, which predates ASIF and cannot read
  the Golden Gate images at all.
- The lab disk mounted at `/Volumes/Lab-A` (override with `LAB_ROOT`).
- `TART_HOME=/Volumes/Lab-A/tart` — set inline on raw `tart` commands; the
  `scripts/lab/*` wrappers default it from `LAB_ROOT`.

## 1. Acquire the base image

Every base comes from a Cirrus prebuilt. They are already past Setup Assistant
with an `admin`/`admin` account — ideal for repeatable onboarding tests.

```sh
export TART_HOME=/Volumes/Lab-A/tart
# Sequoia:
tart pull ghcr.io/cirruslabs/macos-sequoia-base:latest
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest base-sequoia
# Tahoe:
tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest
tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest base-tahoe
# Golden Gate (note the hyphens — the image is macos-golden-gate-base):
tart pull ghcr.io/cirruslabs/macos-golden-gate-base:latest
tart clone ghcr.io/cirruslabs/macos-golden-gate-base:latest base-golden-gate
```

**The Golden Gate line requires a host on macOS 26 or newer.** Cirrus publishes
every 27 image — `base`, `vanilla` and `xcode`, all tags — in ASIF (Apple
Sparse Image Format), where the Sequoia and Tahoe images are raw. ASIF is a
host capability, not a guest one: macOS 15 has no concept of it, so
`diskutil image create --format ASIF` is rejected there and `tart` gates the
format on `#available(macOS 26, *)`. The failure mode is confusing enough to be
worth naming: `pull` and `clone` both *succeed*, because they only move bytes,
and only `run` fails. There is no raw 27 variant to fall back on.

**Re-pull the bases when they go stale.** Cirrus rebuilds these images
regularly, and a base more than a few months old drifts away from the tooling
in a way that is easy to misread as a broken VM. The concrete trap: Cirrus
switched to installing the Tart Guest Agent **from the OpenAI tap on
2026-08-15**, tracking tart's own move, so an image built before that date
carries an agent the current `tart` cannot talk to — `tart exec <vm> sw_vers`
returns nothing at all while the guest boots and networks perfectly. That is a
stale image, not a broken one. Re-pulling is the fix; note it discards the
in-place prep below, so budget a prep pass with it.

> **[R01] — RESOLVED 2026-09-22, by deletion rather than by fix.** This section
> used to build Golden Gate from a local IPSW, because no prebuilt existed; that
> path hit a `VZMacOSInstaller` incompatibility between the 26.x hosts and the
> 27 IPSW, and was blocked for two months. Cirrus published
> `macos-golden-gate-base` on 2026-09-21, one week after macOS 27 shipped, and
> the prebuilt path never touches the installer — so the bug stopped applying
> rather than getting fixed. The IPSW under `/Volumes/Lab-A/ipsw/` is no longer
> referenced by anything here and can be deleted.
>
> Worth keeping from that episode: a prebuilt is *not* automatically a
> host-independent escape hatch. The old note claimed one "would make this
> trivial regardless of host," and that was wrong — the 27 prebuilt carries its
> own macOS 26 floor through ASIF. The host version gated this work either way.

## 2. Factory-fresh prep (apply to every base, once)

Boot the base **directly** to prep it — this edits the base in place, so clones
inherit everything:

```sh
TART_HOME=/Volumes/Lab-A/tart tart run base-<key>
```

**`base-<key>`, not `run-<key>`.** The VM name is in the window's title bar —
check it before you touch anything. Prep done in a `run-` clone looks identical
while you are doing it and is silently destroyed by the next
`just lab-cycle <key>`, which wipes the run and re-clones from the base.

Inside the guest:

1. **Account:** confirm/create `admin` / `admin` (Cirrus prebuilts already have
   it).
2. **Gatekeeper off** (so a `lab-cycle <key> local` unsigned build runs without
   a right-click → Open dance):
   ```sh
   sudo spctl --master-disable
   ```
   **The command alone does nothing.** Since macOS 13 it only *unlocks* the
   option; an "Anywhere" row then appears under System Settings → Privacy &
   Security → "Allow applications from", and you have to select it and
   authenticate. Confirm with `spctl --status`, which must say
   `assessments disabled`. The row vanishes again if you switch away from it,
   and needs another `--master-disable` to come back. The signed
   golden pass ([#step-12]) is what certifies the real Gatekeeper path; the
   bases stay open for fast unsigned iteration.

   **Know what this costs you.** `lab-cycle` now defaults to `release`, which
   stages the signed, notarized dmg — but a base with Gatekeeper disabled does
   not exercise the first-launch gate a real customer meets, so a green default
   cycle says the app *works*, not that it *installs cleanly*. Re-enable it
   (`sudo spctl --master-enable`) in the clone when that is the thing under
   test, or keep relying on the signed golden pass for the certifying run.
3. **Display resolution — 2048×1660:** System Settings → Displays → select
   **2048 × 1660**. Clones inherit this because `lab-new` does not randomize
   the VM serial, so the per-display preference propagates.
   - **Where the resolution list is depends on the macOS line.** On Sequoia it
     is right there, behind "Show all resolutions". On **Tahoe and Golden
     Gate** the pane opens on a scaling strip (Larger Text … More Space) with
     no list at all: click **Advanced…**, turn on **"Show resolutions as
     list"**, and the list comes back. Option-clicking a scaling thumbnail is
     the older fallback. Verified on all three lines 2026-09-23.
   - **Do NOT use `tart set --display`.** Giving a clone a different virtual
     panel than the base breaks the saved-preference match, and macOS reverts
     to its default scaled mode at login (the "starts big, then pops back to
     small" symptom). Bake the resolution into the base instead.
4. **Share path — leave the default.** The host share mounts at
   `/Volumes/My Shared Files/drop/` (the guest sees the dmg at
   `/Volumes/My Shared Files/drop/Tug.dmg`). A `/Volumes/Shared` rename was
   attempted (a custom `tag=shared` virtiofs mount + a guest LaunchDaemon) and
   **abandoned** — `/Volumes/My Shared Files` is macOS's virtiofs *automount*
   path and isn't host-renamable. Don't re-attempt unless asked.
5. **Shut down cleanly** (Apple menu → Shut Down) so clones boot from a
   quiesced, factory-fresh state.

## 3. Verify the base boots as a clone

```sh
just lab-new <key> probe && just lab-run probe   # boots run-probe in a window
just lab-wipe probe                              # clean up
```

Or run the full inner loop, which also stages the dmg:

```sh
just lab-cycle <key>
```

`TART_HOME=/Volumes/Lab-A/tart tart list` should show `base-sequoia`,
`base-tahoe`, and `base-golden-gate`.

## 4. Record results in matrix.json

After building each base, set its real `macos_version` (e.g. the exact Tahoe
point release). `min_version` and `golden_status` are seeded here and finalized
by the golden runs ([#step-11], [#step-12], resolving [Q01]); a passing signed
golden run flips `golden_status` to `pass`.
