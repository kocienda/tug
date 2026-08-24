# Local-Model Infrastructure — Brief

**Status:** brief, pre-devise. Written 2026-07-27. Supersedes two archived plans that remain the raw material: `dash/archive/local-model-bringup.md` (the Apple Foundation Models revision, committed at `caff4a860`, archived at `5e93add3f`) and its superseded Bonsai/mlx-swift revision (recoverable via `git show ca4a504d8:dash/local-model-bringup.md`). The model evaluation record is `dash/archive/local-model-investigations.md`; the reproduction harness survives outside the repo at `~/bonsai-eval/`.

## The reframe

The two prior plans treated local models as a delivery vehicle for two features — shell disambiguation and a Pulse overview line — and each died on that framing: the Bonsai plan because ~80% of it was acquisition infrastructure carrying marginal features, the Foundation Models plan because it tied the features to an OS the owner won't run. The decision that reopens this work inverts the framing: **the ability to run local models is core infrastructure; the features are tenants.** Local models are a significant future direction for AI apps, and Tug cannot be structurally unable to participate. The deliverable is therefore the *capability* — catalog, acquisition, runtime, and a stable API — with the two known features as its first proof tenants, not its justification.

## The four forces, and the positions taken

1. **Minimum OS stays Sequoia.** `FoundationModels` requires macOS 26 (Tahoe), which the owner skipped and will not run; the floor does not move. Swift gains its first `@available(macOS 26.0, *)` / `#if canImport(FoundationModels)` guards for the FM backend specifically. Rust and TypeScript have no `@available` mechanism — and they don't need one: they never branch on OS. They speak the unified API and receive availability answers and refusals from the Swift host, which is the only process that knows what the OS can do. OS-awareness is confined to one Swift seam; everything else is guarded *by the API*, not by version checks.
2. **Model choices are constrained to two backend classes.** Apple's `FoundationModels` (zero acquisition, macOS 26+), and vendor models that run **without change** under stock `mlx-swift` — meaning a plain MLX pack (safetensors + config + tokenizer) loadable by MLXLLM's model factory, no forks, no custom kernels, no conversion step. Everything downloadable lives in one well-known location: `~/Library/Application Support/Tug/models/`. Acquisition must be complete and robust: download, resume, verify, list, delete, load — the full lifecycle.
3. **One consistent, configurable API.** A single task-shaped request surface (`classify`, `summarize`, and a general `generate`) that abstracts the OS, the runtime, and the vendor. Consumers name a task, optionally a model preference; configuration maps tasks to models; the catalog maps models to backends. No consumer ever knows whether Foundation Models or MLX answered.
4. **TugSetup grows real model management.** Offering model options, tracking multi-gigabyte downloads with determinate progress, and surviving every interruption without frustrating the user into abandoning setup.

## The strategic unlock

The Foundation Models plan was parked because its only backend needs Golden Gate hardware, and Apple Intelligence cannot run in the Tart VM lab. Adding the MLX backend dissolves that blocker: **MLX runs on Apple Silicon under Sequoia today.** The infrastructure — catalog, downloader, store, runtime host, API, TugSetup — can be built, exercised, and shipped *now*, with the MLX backend live from day one on the owner's own machine. The FM backend then becomes a thin, zero-install second backend that lights up automatically on Golden Gate, behind guards that are already in place. What was "the whole plan waits for hardware" becomes "one backend arrives later, for free."

## What we already hold

The archived plans are not wreckage; most of their verified design survives intact and devise should lift it rather than re-derive it.

**From the Bonsai revision (`ca4a504d8`) — the acquisition subsystem, designed and vetted:**
- The tugcast-side downloader: control actions (`local_model_download` / `_cancel` / `_probe` on the `install_claude` pattern in `actions.rs::dispatch_action`), CONTROL progress frames throttled ≤ 4 Hz, HTTP Range resume against `.part` staging, per-file sha256 before atomic finalize, ×3 retry with backoff, startup auto-resume, and — added by the vet pass — a pid-stamped `O_EXCL` cross-process staging lock with stale-lock recovery and post-acquire re-check (concurrent debug + release instances over the shared models dir are the *normal* dev condition).
- The store layout: `models/<slug>/` + a `tug-manifest.json` stamp written only after full verification, stamp-existence as the presence probe, `.staging/` for partials. Generalizes from one hardcoded manifest to a catalog of entries.
- The TugSetup step design: `Step.secondaryCta` extension for Download/Skip, determinate `TugProgressIndicator` bar in the step row, error/retry as first-class states, and the two deliberate behaviors — the optional step never gates session-opening, and the wizard closing mid-download is fine because tugcast owns the operation.
- mlx-swift dependency notes: tugapp is a plain Xcode project with zero SPM references today; adding `ml-explore/mlx-swift` + `mlx-swift-examples` (MLXLLM/MLXLMCommon) is its first package dependency — dash-first, with signing verification (`scripts/sign-bundle.sh`) and clean-checkout resolution checks.
- The service lifecycle for disk-loaded models: lazy load, warm-while-active, idle unload (~5 min) to reclaim multi-GB residency — needed for MLX, irrelevant for FM (the OS manages residency), which is exactly the kind of difference the API hides.

**From the Foundation Models revision (`dash/archive/local-model-bringup.md`) — the brokered-API pattern and the tenants:**
- Availability flows from Swift: the deck queries over the WKWebView bridge (`localModel` handler, `(w.__tugBridge ??= {})` reply sink — the `native-path-picker.ts` pattern); tugcast never tracks availability, it requests and gets refused, with back-off (60 s doubling to 10 min). This *is* the Rust/TS guard story from force 1.
- The control-socket extension: tugcast→app `local_model_request` over the existing drain channel (`main.rs` creates `mpsc::channel::<String>(4)` over `writer.into_inner()`; a requester clones the sender), answered by a new `ControlMessage::LocalModelResult` serde variant routed to a oneshot pending map in `run_recv_loop`, 10 s timeout.
- The FM integration notes: `SystemLanguageModel.default.availability`, `LanguageModelSession` with task-specific instructions, guided generation via `@Generable` enums (constrained decoding makes malformed classify output impossible), `prewarm()`, ~4 K context budget, guardrail-refusal handling.
- Both tenants, fully specified: the three-band shell classifier (`bandShellLine` refactor of `classifyShellLine`, heuristic-certain routes instantly, model decides only the unsure middle, 300 ms typing-debounce pre-consult, 250 ms submit budget, no-verdict ⇒ Code) and the Pulse overview emitter (`feeds/session_overview.rs`, cadence 8-frames/30 s with 15 s floor, digest = JSONL goal prompts + `tool_use` action lines, `kind:"overview"` PulseLine frames, supervisor-sourced session identity — the tug→claude mapping lives in `AgentSupervisor`'s in-memory map and must be handed in at wiring time, with `SessionRow.project_dir` from the SQLite ledger).
- The degradation doctrine: every consumer degrades to exactly today's behavior in every unavailable state, pinned by a typing-level app-test that never submits a turn.

**From the evaluation (`dash/archive/local-model-investigations.md`):** fitness follows task *shape*, not size — small local models are strong at short-context bounded work (classify: 26/26; digest→headline: accurate, <1.5 s) and weak at long-context comprehension. Scribe stays Sonnet, permanently. The 26-line classify corpus and six pulse-digest fixtures in `~/bonsai-eval/` are the reusable quality bars for any candidate model on any backend.

## Findings

Verified on `main` during the planning sessions that produced the archived plans.

### F1 — The toolchain is already ahead of the OS

The build machine runs Xcode 26.3 on Sequoia 15.6: the macOS 26 SDK and `FoundationModels` headers compile today. `MACOSX_DEPLOYMENT_TARGET = 13.0` in `tugapp/Tug.xcodeproj/project.pbxproj` and stays there. FM code is written now, inert below 26, and needs no toolchain work later.

### F2 — tugapp has never had a package dependency

Zero `XCRemoteSwiftPackageReference` entries in the pbxproj; only system frameworks plus copy-phase Rust binaries. mlx-swift is the first SPM dependency, full stop — resolution, signing, and clean-build behavior all need first-time verification on a dash.

### F3 — Both IPC channels exist and have room

The WKWebView script-message bridge (`MainWindow.swift`, ~14 handlers, `evaluateJavaScript` replies) serves deck-originated requests; the UDS control socket (`ControlSocket.swift` ↔ `control.rs`, newline JSON, tagged `ControlMessage` enum, cloneable app-bound drain sender) serves tugcast-originated ones. Neither needs structural change — only new message vocabulary.

### F4 — The runtime host must be Tug.app

Both backends are Swift (`FoundationModels` is a system framework; mlx-swift is a Swift package). Inference therefore lives in the app process, and the API is *brokered*: deck over the bridge, tugcast over the socket. There is no viable tugcast-side inference path within the chosen backend classes, which is what makes force 3's abstraction both necessary and clean — one Swift service, two thin transports.

### F5 — Backend availability is a matrix, not a boolean

FM: Apple Silicon + macOS 26+ + Apple Intelligence enabled + model assets ready. MLX: Apple Silicon + mlx-swift's own platform floor (believed macOS 14+; **pin during the spike**) + a downloaded model on disk. Intel Macs: no local models at all. VMs: no Apple Intelligence, so FM is dead there while MLX works (the Tart lab can exercise the MLX path but not FM). The API's availability answer must be per-task and account for all of it; no consumer should ever reconstruct this matrix.

### F6 — The tenants' integration points are stable and waiting

`AUTO_SHELL_DETECTION_ENABLED = false` still parks the shell classifier "until a model classifier can judge intent" (`tugdeck/src/lib/shell-line-classifier.ts`); the pulse strip renders one line with a store/protocol design (`pulse-store.ts`, `parsePulseFrame`) that takes the optional `kind:"overview"` field backward-compatibly. Nothing on main has moved under either tenant.

### F7 — Configuration precedent is settled

The tugbank kill-switch pattern (`dev.tugtool.pulse`/`enabled`: parallel Rust/TS consts, absent ⇒ default, live DEFAULTS-frame subscription) extends directly to a `dev.tugtool.local-model` domain — per-feature enables plus, new here, task→model assignment keys. No new persistence machinery.

## Shape under consideration

Seven pieces, named so devise can phase them.

1. **Catalog.** A compiled-in registry of offerable models: id, display name, backend (`foundation-models` | `mlx`), and for MLX entries the pinned HF repo/revision, file list with sha256s and sizes, context window, and capability notes. FM appears as the zero-acquisition entry. Curated and small — two or three vetted MLX models, not a browser.
2. **Acquisition.** The Bonsai downloader, generalized catalog-wide: download/resume/cancel/verify/list/delete against `~/Library/Application Support/Tug/models/`, tugcast-owned, control-frame driven, cross-process safe, auto-resuming. Listing reports installed / downloading (with progress) / available.
3. **Runtime host.** `LocalModelService` in Tug.app with a backend protocol and two implementations: FM (guarded, session-per-request, guided generation) and MLX (ModelContainer from a models-dir URL, lazy load / idle unload, single-flight queue). The service owns the availability matrix (F5).
4. **Unified API.** Task-shaped requests over both transports (bridge for deck, socket for tugcast): `classify(text, labels)`, `summarize(prompt)`, `generate(request)`, plus `availability(task)` and `models()` (list + status). Consumers name tasks; configuration resolves tasks to models; the catalog resolves models to backends. Versioned vocabulary so future tenants don't fork it.
5. **Configuration.** `dev.tugtool.local-model` tugbank domain: per-feature enables, task→model assignment (`auto` = first available by preference order), live-flippable.
6. **Surfaces.** TugSetup: an optional on-device-AI step offering the catalog's choices with determinate download progress and first-class skip/error/retry. Post-setup management (change models, delete, re-download) needs *a* surface — open question below.
7. **Tenants.** Shell disambiguation and the Pulse overview, lifted nearly verbatim from the FM plan, now consuming the unified API — and serving as its proof that two different call sites (deck-interactive, tugcast-background) work through one vocabulary.

## Phasing sketch (for devise to firm up)

- **M1 — Runtime + API core, MLX backend, spike.** SPM dependency on a dash; backend protocol; MLX backend loading a manually-placed model from the well-known dir; bridge + socket API endpoints; the spike re-runs the classify corpus and pulse fixtures against 2–3 candidate stock-MLX models on Sequoia hardware, picks the catalog, and freezes prompts. This phase proves the whole idea on the owner's machine and gates the rest.
- **M2 — Acquisition.** Catalog + downloader + store lifecycle + list/delete. Independent of M1's inference internals; depends only on the catalog shape.
- **M3 — Surfaces + configuration.** TugSetup step with model options and download tracking; tugbank config domain; degradation app-test pin.
- **M4 — FM backend.** The `@available`-guarded second backend behind the existing API. Small by construction; its live verification waits for Golden Gate hardware, and *only* this phase does.
- **M5 — Tenants.** Shell disambiguation and Pulse overview as API consumers.

## Constraints

- Sequoia stays the minimum OS; deployment target stays 13.0; FM code behind `#if canImport` + `@available` with an always-unavailable stub below 26.
- Scribe stays Sonnet; no code path may route it locally.
- Models only from the two backend classes; "runs without change under mlx-swift" is a hard catalog admission rule.
- One well-known models location: `~/Library/Application Support/Tug/models/` (instance-shared; hence the cross-process lock).
- WARNINGS ARE ERRORS (Rust); tuglaws for all deck work ([L02]/[L24] stores, [L06]/[L07] non-render caches); no localStorage; app-tests selective with `@covers`; bun never npm; `bunx vite build` before declaring tugdeck work done.
- The Session card never blocks on inference; every consumer degrades to today's behavior in every unavailable state.

## Open questions for devise

1. **Which MLX models seed the catalog?** Candidates: current-generation small instruct models with community MLX 4-bit packs (Qwen, Llama, Gemma class), plus Ternary-Bonsai-8B-2bit (already proven to load on stock MLX). The M1 spike decides on measured classify/summarize quality, latency, and disk/RAM cost — not on reputation.
2. **mlx-swift's true platform floor and pinned versions** (F5) — resolve in M1.
3. **Post-setup model management surface.** TugSetup covers first-run; changing/deleting models later needs a home (Lens section? a card? defer with the CLI as the interim writer?). The prior plans deferred all settings UI; with real model *choice* this gets harder to defer — devise should decide the v1 scope explicitly.
4. **API transport for future card-visible inference** (e.g., a future scratchpad tenant): is the bridge's request/reply enough, or does streaming output need designing into the API vocabulary now? Lean: design the vocabulary to *permit* streaming (request ids already exist), implement non-streaming v1.
5. **Memory policy for MLX residency** — one model resident at a time (assignment changes unload the old) vs. per-task residency. Lean: one.
6. **Default-ON vs opt-in for the tenants** once infrastructure exists (the [Q05] question from the FM plan, unchanged).

## How we would know it worked

- On this Sequoia machine: a catalog model downloads with resumable determinate progress, survives a mid-download kill, verifies, loads, and answers a classify and a summarize through both transports — deck console and a tugcast round-trip — with the FM backend reporting unavailable and nothing caring.
- The classify corpus scores ≥ 25/26 and the six digests produce clean headlines on the chosen catalog model, warm-latency within the tenants' budgets (≤ 400 ms classify, ≤ 3 s summarize).
- Flipping task→model assignment in tugbank changes which model answers without relaunch; deleting the model degrades both tenants to today's behavior; the degradation app-test pins that state permanently.
- On Golden Gate hardware, later: the FM backend passes the same corpus through the same API with zero consumer changes.

## Out of scope

- Scribe, and any long-context comprehension task — the eval settled this.
- Intel Macs (no local models; degradation covers them).
- A model *browser* or arbitrary-model support; the catalog is curated.
- Server-tier / Private Cloud Compute anything.
- The larger Pulse/Lens redesign (the overview line is its foundation, not its delivery).
- Tug CDN weight hosting (HF pinned-revision remains the v1 source; CDN is follow-on infra).
