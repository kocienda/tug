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

## Recording

Per List L02 step 7, write the verdict back:

```
scripts/lab/golden-record <os> <pass|fail> <host-version>
```
