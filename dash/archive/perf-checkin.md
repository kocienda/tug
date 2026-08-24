**Ledger** (`dash/jul29-perf-tuneup.md` on the dash):

| Step | Result | Commit |
|---|---|---|
| 1 — Census truth + zombie rule | at0288 is a zero-violations gate; easing rule proven by a planted multi-stop `linear()` failing by name; [Q07] settled; animation-tuneup step 15 closed | `18e6cf53c` |
| 2 — Restored-transcript deck | new `at0289`; breadth defect proven red (Expected 0 / Received 64) | `c67bd0ae9` |
| 3 — Mount suppression + atom pulse | first-paint write suppressed; pending pulse opacity-only; 38/38 derived tests green | `091356536` |
| 4 — End-state swap | static/live modes + the [P06] swap-when-settled demotion | `333980af9` |
| 5 — Sticky headers + ResizeObserver | **both absolved** with numbers; [Q01] closed | `3ca1d2c1c` |
| 6 — Re-profile, brief, cleanup | before/after table in the brief; `zz-` probes deleted | `0410ec12e` |

Three findings from the run worth knowing (all recorded in the plan and brief):

- **The zombie army's real trigger** isn't the first-paint write — a plain cold restore retains *zero* at fixture scale. Retention comes from transform writes through the live transition *after* first style resolution (the 30MB card's batched-replay crossings). I isolated it live: one such write retains exactly one finished `CSSTransition`, and — the useful surprise — **`transition: none` drops an already-retained one**. So static mode both prevents and clears zombies, and `at0289` proves settled dots are immune with a permanent induced-crossing phase.
- **Swap when settled is machine-checked, not just implemented.** `at0276` gained three sections: no `data-static` while a shed ring is flying (and nothing running under the root at the moment it appears), rapid running→completed→running flips abandon the demotion with the glyph left breathing, and motion-off lands static promptly. Its per-frame sampler now reads a mode-agnostic visual scale, so the existing no-pop rate bound convicts a hop at the swap seam itself — it passes.
- **The suspects are buried with numbers.** Forcing all 438 headers `position: static` moved typing busy 65.9% → 65.8%; disconnecting all 506 ResizeObservers moved it to 62.9% with idle at 1.8% — noise, both.

**Your build is up:** instance `debug-tugdash-jul29-perf-tuneup` (pid 84552) is running from the worktree — `just launch-debug` / `just logs-debug` / `just stop-debug` as needed. The one thing this run can't self-certify is your eyes on the gallery: settled dots at 28px and 14px should be pixel-indistinguishable from before (width-sized circle vs transform-scaled circle can differ by a rasterization hair), and the pending-atom pulse now reads through opacity alone.

Two loose ends for you: the **release after-number** needs your landing — the live release renderer still runs pre-fix code (re-sampled at 24.2% busy mid-session); after `/join jul29-perf-tuneup` and a release rebuild I'll take the same sample for the brief's open cell. And `tests/app-test/zz-probe.test.ts` predates this plan — yours to keep or delete. The join draft is written; **`/join jul29-perf-tuneup`** is the landing gesture when you're satisfied.