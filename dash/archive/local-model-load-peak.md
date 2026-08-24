# The 8.7 GB load peak — a 2.1 GB model that costs four times its size to load {#local-model-load-peak}

A working brief for one unexplained number, split out of [host-surface-accounting.md](host-surface-accounting.md) once that investigation resolved. It is stated, measured, and **not diagnosed** — the mechanism is open.

## The observation {#observation}

Every launch of Tug that prewarms the local model sets `phys_footprint_peak` to **~8.7 GB** within the first seconds, then settles to a ~2.5 GB steady state and never approaches the peak again.

Measured on the `Tug-release-tugdash-host-surfaces` probe build, launch traced at 2-second cadence:

| t | footprint | peak | graphics | regions |
|---|---|---|---|---|
| 0.0 s | 9.7 MB | 9.7 MB | — | — |
| 2.0 s | 2.5 GB | **6.6 GB** | 2.4 GB | 793 |
| 19 s | 2.5 GB | 6.6 GB | 2.4 GB | 793 |

The peak is reached inside the same ~2-second window as the load itself. Independent instances agree on the settled value and land between **6.6 GB and 8.7 GB** at peak; the user's live release instance and a freshly restarted one both reported 8.7 GB.

## Why it is worth a brief {#why}

The model on disk is **2.1 GB**: `~/Library/Application Support/Tug/models/qwen3-4b-instruct-2507-4bit/model.safetensors`, a 4-bit quantised 4B-parameter pack. The steady-state resident cost of ~2.1–2.4 GB is expected and inherent — MLX runs inference out of unified memory and every token touches every weight.

**The peak is not expected.** A load path that mapped the file and uploaded it should cost roughly the file's size plus a working margin, not **four times** it. On the developer's 128 GB machine the transient is invisible. On a 16 GB machine an 8.7 GB spike is larger than half the machine, arrives seconds after launch, and would evict a large share of everything else the user has open — a worse citizenship failure than the steady state it settles into, and one that repeats on every launch.

## What is already known, so it is not re-derived {#known}

- **The memory is real.** Quitting a probe instance returned ~3.8 GB to the system, additive with the family's self-reported footprints — see [host-surface-accounting.md](host-surface-accounting.md#the-memory-is-real).
- **It is the model, not the deck.** The pool is content-independent, immune to every WebKit knob, and absent entirely under `TUGAPP_APP_TEST=1` (which skips the model). Full attribution in [host-surface-accounting.md](host-surface-accounting.md#status).
- **It lands in `IOAccelerator (graphics)`** in `vmmap`, because MLX weights are Metal buffers in unified memory. This row is *not* evidence of a graphics or compositing problem — mistaking it for one cost that investigation most of its length.
- **MLX's freed-buffer cache is already bounded** to 256 MB (`MLXLocalModelBackend.gpuCacheLimitBytes`), and the default would otherwise be the whole device limit. The cache is therefore unlikely to be the whole story, but it has not been ruled out during the load itself.
- **Model swaps already unload first** (`load()` calls `unload()` when a container exists), so the peak is not two packs resident at once. A launch prewarm has no outgoing pack anyway.

## Hypotheses, none tested {#hypotheses}

1. **Eager materialisation during load.** If `loadModelContainer` reads tensors into host arrays before quantised upload, a 4-bit pack could transiently exist dequantised or duplicated. Four times 2.1 GB is suspiciously close to what 4-bit → 16-bit widening would cost.
2. **File cache double-counting.** Reading a 2.1 GB safetensors file can leave 2.1 GB of unified buffer cache charged to the process on top of the Metal buffers, briefly holding two copies plus page cache.
3. **MLX allocator high-water behaviour.** MLX may allocate staging buffers per tensor and return them to its cache rather than to the OS; the 256 MB cache bound applies after the fact, not necessarily during a burst of allocations.
4. **`phys_footprint_peak` over-reporting shared pages.** The peak counter charges shared-owned pages; some of the 8.7 GB may be pages also counted elsewhere. This would make the peak partly an accounting artifact — it must be excluded before any fix is attempted.

Hypothesis 4 is the cheapest and should be settled first, because if the peak is not real memory pressure there is nothing to fix.

## How to measure it {#how-to-measure}

The rig already exists and is the only safe one — **never** launch a second release-identity `Tug.app`, which terminates the user's live instance:

- Build a probe on a dash worktree (`just app-release` from `.tug/worktrees/<name>`), which yields `Tug-release-<slug>.app` with its own bundle id, DerivedData and instance id.
- Trace the launch at 1–2 s cadence with `vmmap --summary <pid>`, reading `Physical footprint`, `Physical footprint (peak)`, and the whole `IOAccelerator (graphics)` row (`VIRTUAL RESIDENT DIRTY SWAPPED VOLATILE NONVOL EMPTY COUNT` — reading `DIRTY` alone has already produced one wrong conclusion in this program).
- `TUGAPP_APP_TEST=1` is the clean negative control: it skips the model entirely and the same build reads 3 regions / 24 MB.
- For system-level truth rather than self-report, sample `vm_stat` free pages across the load; the `free` channel is stable where `wired` fluctuates by ±3 GB on a busy machine.
- The app-test lab is **useless** for this — it is a Debug build and never loads the model.

To settle hypothesis 1, instrument `MLXLocalModelBackend.load` around `loadModelContainer` with the existing `logGpu` helper (it already reports MLX active / cache / peak), and compare MLX's own peak against the process footprint peak. A divergence points at the file cache rather than MLX.

## What is out of scope {#out-of-scope}

- **The steady-state 2.1 GB residency.** That is the cost of a resident local model and is accepted: the model serves shell-routing classification and PULSE summaries, so it is warm whenever the app is in use.
- **Whether to load the model at all on small-memory machines.** That is a product decision the user is taking separately.
- **The idle-unload defect** — the launch prewarm armed no idle timer, so weights were held for the life of the process. Fixed by scheduling the idle unload after a successful `load()`, not only in `generate()`'s `defer`.

## Status {#status}

- **2026-08-03** — opened. Peak measured repeatedly at 6.6–8.7 GB against a 2.1 GB pack; mechanism undiagnosed; hypotheses listed and untested. Next action is hypothesis 4 (is the peak real memory), then hypothesis 1 (eager materialisation).
