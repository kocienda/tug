# Golden base prep (macOS VM lab)

How to build and prep the factory-fresh golden base VMs the lab clones for
install/onboarding testing. One base per supported macOS line, named
`base-<key>` (the keys in [`matrix.json`](matrix.json)): `base-sequoia`,
`base-tahoe`, `base-golden-gate`.

A golden base is prepped **once** and then never used to run Tug directly —
every test boots a throwaway clone (`just lab-cycle <key>`, see the lab recipes
in the `Justfile`). Keep the bases pristine.

## Prerequisites

- [Tart](https://tart.run) (`brew install cirruslabs/cli/tart`).
- The lab disk mounted at `/Volumes/Lab-A` (override with `LAB_ROOT`).
- `TART_HOME=/Volumes/Lab-A/tart` — set inline on raw `tart` commands; the
  `scripts/lab/*` wrappers default it from `LAB_ROOT`.
- For Golden Gate: the IPSW at
  `/Volumes/Lab-A/ipsw/UniversalMac_27.0_26A5368g_Restore.ipsw`.

## 1. Acquire the base image

### Sequoia / Tahoe — Cirrus prebuilt (preferred)

Cirrus publishes prebuilt bases that are already past Setup Assistant with an
`admin`/`admin` account — ideal for repeatable onboarding tests.

```sh
export TART_HOME=/Volumes/Lab-A/tart
# Sequoia:
tart pull ghcr.io/cirruslabs/macos-sequoia-base:latest
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest base-sequoia
# Tahoe:
tart pull ghcr.io/cirruslabs/macos-tahoe-base:latest
tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest base-tahoe
```

### Golden Gate (macOS 27 beta) — from the local IPSW ([P04])

No Cirrus prebuilt exists for the 27 beta, so build from the downloaded IPSW:

```sh
export TART_HOME=/Volumes/Lab-A/tart
tart create --from-ipsw /Volumes/Lab-A/ipsw/UniversalMac_27.0_26A5368g_Restore.ipsw base-golden-gate
```

This restores a **fresh** OS, so the first boot lands in Setup Assistant —
complete it manually (create the `admin`/`admin` account; skip Apple ID,
Screen Time, analytics, Siri).

> **[R01] — BLOCKED on this host; waiting on the host upgrade, not on Apple (reviewed 2026-07-27).** `tart create --from-ipsw` on the 27 IPSW fails at 0% with *"An error occurred during installation."* The cause was a late incompatibility between the `VZMacOSInstaller` API and the macOS 27 IPSW — not Tart-specific, every Virtualization.framework tool (UTM, Parallels, Anka) hit it.
>
> **Apple has since fixed it.** Apple DTS confirms the OS-level fix ships in macOS 26.6 beta 3 / 25G5052e (r. 179068335), verified by third parties. The fix is *host-side* and lands in the 26.x line, so it does not reach this host: we are on Sequoia 15.6, and 15.x will never receive it.
>
> The gate is therefore the host OS version. This machine restores a 27 IPSW once it *is* on 27 — a same-major restore is the ordinary supported case, not the cross-version case Apple had to patch. Golden Gate is expected to ship around mid-to-late September 2026 (developer betas are on a clean two-week cadence; beta 4 / 26A5388g landed 2026-07-20). **Re-attempt `tart create --from-ipsw base-golden-gate` after this host is upgraded to Golden Gate.** Everything else is already wired: `matrix.json` carries the `golden-gate` entry, and `just lab-cycle golden-gate` needs no changes once the base exists.
>
> Until then Golden Gate is **deferred** — its `matrix.json` `golden_status` stays `untested`, because there was no golden run to fail; the base simply can't be built here yet. Sequoia + Tahoe stay golden, and they keep cycling normally after the host upgrade (older guests on a newer host is the well-trodden direction).
>
> Rejected alternatives, for the record: upgrading this host to macOS 26.x is a standing non-option (the plan is to leapfrog Tahoe entirely); and building a Tahoe base then OTA-upgrading the guest to 27 is too manual to maintain — a VZ guest has no Apple-ID sign-in, so beta access needs a hand-installed enrollment profile.
>
> No Cirrus prebuilt exists as an escape hatch: `cirruslabs/macos-image-templates` publishes only `macos-{tahoe,sequoia,sonoma}-*`, with no macOS 27 image or work in flight (checked 2026-07-27). Worth re-checking around release — a prebuilt base would make this trivial regardless of host.
>
> Refs: [Apple Developer Forums 830118](https://developer.apple.com/forums/thread/830118), [OS X Daily](https://osxdaily.com/2026/06/12/macos-golden-gate-27-beta-wont-install-in-a-virtual-machine-its-a-known-issue/), [motionbug](https://motionbug.com/virtualising-macos-27/).

## 2. Factory-fresh prep (apply to every base, once)

Boot the base **directly** to prep it — this edits the base in place, so clones
inherit everything:

```sh
TART_HOME=/Volumes/Lab-A/tart tart run base-<key>
```

Inside the guest:

1. **Account:** confirm/create `admin` / `admin` (Cirrus prebuilts already have
   it; the IPSW build sets it in Setup Assistant).
2. **Gatekeeper off** (so the unsigned `lab-dmg` runs without a right-click →
   Open dance):
   ```sh
   sudo spctl --master-disable
   ```
   Verify System Settings → Privacy & Security shows "Anywhere". The signed
   golden pass ([#step-12]) is what certifies the real Gatekeeper path; the
   bases stay open for fast unsigned iteration.
3. **Display resolution — 2048×1660:** System Settings → Displays → select
   **2048 × 1660** (flip on "Show all resolutions" if needed). Clones inherit
   this because `lab-new` does not randomize the VM serial, so the per-display
   preference propagates.
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
