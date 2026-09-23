# Golden-run operator guide

Companion to the golden-run checklist (**List L02** in
the onboarding-and-install design record) and the results recorder
(`scripts/lab/golden-record`). The happy path and how to record verdicts live
there; this file is the **unhappy-path induction** recipes — how to drive each
designed ConfigureTug state ([D105] in `tuglaws/design-decisions.md`) on a real
guest, and an honest note on what a VM run can and can't reach.

## Coverage split

`DEV_FORCE_*` flags are folded out of release builds, so in a golden run every
state must come from a **real trigger**. We don't try to hit every [D105] node
in the VM — that's the `gallery-configure-tug` spike's job (it simulates all of them
deterministically, no VM / account / network tricks). The VM validates the
**real code paths**: the happy path plus the unhappy paths that genuinely depend
on the environment.

- **Spike** — exhaustive visual/UX coverage of every node.
- **Unit tests** — the pure pieces: `compareMacosVersion` / gate derivation
  (`macos-support.test.ts`), `subscriptionLabel` per tier
  (`configure-tug-copy.test.ts`), the banner spec (`dev-card-banner-spec.test.ts`).
- **VM golden run** — happy path (List L02) + the induction recipes below.

## Happy-path nodes (natural — no setup)

A factory-fresh base has no `claude`, so the happy path walks these on its own:
install active → busy → done, sign-in active → busy → done (the test account's
tier only), open active → done. The first-launch "Checking your setup…" probe
state is automatic but transient.

## Unhappy-path induction recipes

Run each in the guest, on the dmg staged by `just lab-cycle <os>` — by default
the signed, notarized dmg from the newest stable release, which is what a
customer's first install actually is. `just lab-cycle <os> local` stages this
working tree's unsigned build instead; Gatekeeper blocks that one on a fresh
guest, so it needs a right-click → **Open**.

| State | Induce it | Expected |
|-------|-----------|----------|
| **Install failed** + Retry | Disable the guest's network (turn off the adapter / pull the share-less NIC), then click **Install** so the installer can't fetch. | Install step → error row, `Install failed: …`, **Retry**. Re-enable network, Retry → succeeds. |
| **Sign-in failed** + Try Again | Click **Sign In**, then in a guest terminal `pkill -f "claude auth login"` so the CLI exits non-zero and tugcast re-probes logged-out. | Sign-in step → error row, "Sign-in didn't finish…", **Try Again**. (The 10-minute timeout reaches the same state; don't wait it out.) |
| **Transport down** "Reconnecting…" | While the setup wizard is open, `pkill -f tugcast` in a guest terminal. | Wizard body → single "Reconnecting…" row until the wire is back (the app relaunches tugcast; may be brief). Setup resumes; auth re-probes on reconnect. |
| **Logged-out mid-session** (per-card banner) | Complete setup, open a Dev card, run one turn, then `claude auth logout` in a guest terminal, then submit another turn. | The card shows the calm caution **auth banner** ("Sign in to Claude"), not the red session-dead overlay. Sign In recovers. |
| **Version too old** (gate) | The bases are ≥ floor and there's no release force. Either clone a below-floor base (e.g. Sequoia 15.0–15.5) **or** build-time floor-spoof: raise the line's minimum in `tugdeck/src/lib/macos-support.ts` (`SUPPORTED_MACOS`) above the base's version, `just lab-dmg unsigned`, install. Revert after. | App shows the Tug "update macOS" gate (app-modal); ConfigureTug stays suppressed behind it. |

## Nodes a standard release run can't reach

- **Version gate on a real host** — needs a below-floor base or the floor-spoof
  build above. The comparator + derivation are unit-tested; this is the live
  render only. Treat as a once-per-matrix-close check, not every run.
- **Subscription-label variants** (Pro / Team / Enterprise / Free) — only the
  test account's actual tier renders live; the rest are pinned in
  `configure-tug-copy.test.ts`.

## The Gatekeeper gap, and why `spctl` can't close it

A golden run on a base prepped per `base-prep.md` has **Gatekeeper disabled**
(`spctl --master-disable`, step 2). So a pass certifies that Tug *works* on that
macOS line — not that it *installs* past the first-launch gate a customer meets.
That gap is by design (the bases stay open for fast unsigned iteration), but do
not let a green run be read as install-path coverage.

**Do not try to close it with `spctl --assess`.** On macOS 26 and 27 that tool
reports `rejected / source=Notarized Developer ID` for *every* Developer ID
app, and the verdict is not about the app under test. Measured 2026-09-23 on
this lab, same notarized `Tug.dmg` throughout:

| Guest | `spctl --assess` | `syspolicy_check` |
|-------|------------------|-------------------|
| Sequoia 15.7.7 | accepted (exit 0) | passed, ready for distribution |
| Tahoe 26.6.2 | rejected (exit 3) | Fatal "Internal Xprotect Error" |
| Golden Gate 27.0 | rejected (exit 3) | Fatal "Internal Xprotect Error" |

The controls are what settle it. `codesign --verify --deep --strict` passes on
all three and `stapler validate` confirms the ticket is stapled, so the build is
sound. Sparkle's nested `Updater.app` is rejected the same way, and so is
**`tart.app`, signed by Cirrus Labs** — an unrelated vendor whose app is
obviously fine. Apple-signed `Safari.app` is accepted. XProtect is healthy and
current in the guest (5360), and its version does not correlate: the newest
scanner rejects and the oldest rejects while the middle one accepts.

Everything Developer ID fails and only Apple System passes, which is a statement
about the instrument, not the software. Apple has been deprecating `spctl`'s
assessment semantics; on 26+ it is not a usable oracle.

**Confirmed by hand, 2026-09-23.** Golden Gate 27.0, Gatekeeper re-enabled, the
release dmg downloaded in Safari inside the guest so it carried a real
`com.apple.quarantine` bit: Tug **opens**. So `spctl`'s `rejected` on 27 does
not describe what Gatekeeper actually does — the install path is clean on the
newest line, on the same build the tool refused. Tahoe was not re-checked by
hand; it is the same signature and the same notarized dmg, and the 27 result is
what the `spctl` verdict there is worth.

**What actually closes the gap:** boot a clone, re-enable Gatekeeper with
`sudo spctl --master-enable`, get the dmg onto the guest *through a browser* so
it carries a real `com.apple.quarantine` bit (a file copied off the virtiofs
share has none, and without it the gate never engages), then double-click and
watch. It is a human check, and a few minutes.

## Recording

Per List L02 step 7, write the verdict back:

```
scripts/lab/golden-record <os> <pass|fail> <host-version>
```
