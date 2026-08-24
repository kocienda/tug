# Local-Model Investigations — On-Device Bonsai for Tug

Status: investigation complete, implementation deferred. This document is the durable record + plan; the exploratory work happened on the `tugdash/bonsai-eval` dash (to be released) and the reproduction harness lives outside the repo at `~/bonsai-eval/` (survives the release). Everything essential is folded in here so nothing is lost when the dash is discarded.

## TL;DR — the decision

We evaluated PrismML's Bonsai family (native low-bit LLMs) as on-device engines for jobs currently done by `claude -p` or by heuristics. The clean result:

- **Scribe (commit-message drafting) stays on Sonnet.** It is a long-context *comprehension* task; no local model we tested is both good enough and fast enough. The 27B reaches Sonnet-class quality but takes ~172 s on a large diff; the 8B can't comprehend big diffs at all.
- **Two jobs are an excellent fit for a small local model:** **shell-line classification** (`autoShellOpener`) and a new **Pulse "part one" high-level session summary**. The 1-bit Bonsai-8B did both accurately, instantly (~0.2–1.5 s), in ~1.5–2.2 GB RAM, offline and free.
- **One local model, downloaded post-install (never bundled), for those two jobs. Sonnet for scribe. No 27B, no llama.cpp.**

The governing insight: **fitness follows task *shape*, not model *size*.** A 1-bit 8B is strong at short-context, bounded-output work (classify, extract, headline) and weak at long-context comprehension (read a 40 KB diff, infer intent). Point it at the former and it shines.

## Background — the question

Tug's scribe (`tugrust/crates/tugcast/src/scribe.rs`) shells `claude -p` to draft commit messages. The question: can on-device models take over jobs like this — for privacy, offline use, zero per-call cost — and which models/runtime would it take? Bonsai's pitch (an 8B that packs to ~1.2 GB and runs at 131 tok/s on an M4 Pro) made it the candidate.

## What we tested — the evidence

All runs used **real** inputs: real diffs through the genuine scribe prompt composer, real session transcripts, real typed lines. Runtime was the **PrismML `mlx` fork** (branch `prism`, built from source; MLX 1-bit support is not yet upstream — tracking `ml-explore/mlx#3161`) with `mlx-lm==0.31.2`. Model: `Bonsai-8B-mlx` (native 1-bit), 64 K context, ~1.2 GB on disk, 131 tok/s, peak RAM 1.5–2.25 GB.

### Scribe — why it stays on Sonnet

Six real commits (2.9 KB → 100 KB diffs), scored against the human commit subject.

| Engine | Result | Notes |
|---|---|---|
| 1-bit Bonsai-8B (voice-off + subject-format constraint) | **1 PASS / 2 WEAK / 3 WRONG** | Constraint fixed *format* completely (no changelog-collapse, no prompt-leak) but comprehension failed: misread a rustfmt-only reflow as a code change, hallucinated scope, fixated on stray fragments of big diffs |
| 1-bit Bonsai-8B (unconstrained) | unusable | file-changelog dumps, prompt-rule leakage, diff-echo |
| Ternary-Bonsai-27B (2-bit) | **~5 PASS / 1 WEAK** — Sonnet-competitive | but **89 s @ 58 KB, 172 s @ 100 KB** (past scribe's 120 s timeout) and ~8–10 GB RAM |
| Sonnet (`claude -p`, current) | **6 / 6** | correct scope, accurate bodies, even distinguished the rustfmt-only commit |

Two promptcraft levers were fully spent (a subject-format constraint — the MLX-native equivalent of a GBNF grammar, as a token-level DFA logits processor — and removing the voice section) and the 8B was still 1/6. The remaining gap is **model capability, not prompts**. The 27B closes it but is too slow and heavy for an interactive draft. **Conclusion: keep Sonnet for scribe.**

### Shell-line classification — a strong fit

Tug's `autoShellOpener` / `classifyShellLine` (`tugdeck/src/lib/shell-line-classifier.ts`) decides whether a typed line is a shell command (open the `!shell` chip) or a natural-language prompt to the AI. Today it's a pure heuristic (`isCommandShaped`, `hasStrongSignal`, …). We tested the 1-bit 8B as a classifier on 26 lines including deliberately hard ones:

- **26 / 26 correct, ~198 ms/line, 1.5 GB.**
- Nailed the ambiguous cases: `build the project`→PROMPT, `test the parser`→PROMPT, `make the button bigger`→PROMPT, while `make test`→SHELL, `cargo nextest run`→SHELL.

Same model that scored 1/6 on scribe — because this is short-context bounded classification, its strength zone.

### Pulse "part one" — a strong fit

Finding: **Pulse is not model-driven today.** The strip shows the latest `assistant_text` frame verbatim (`PulseVoice`, pure rules, `tugcode/src/pulse/main-pulse.ts`). The idea: add a *first* line — a stable, high-level "what is this session doing overall" — above the existing up-to-the-moment line. Only the new first line needs a model.

We fed the 1-bit 8B a **compact digest** of six real sessions (the user's goal prompts + the tool-action list) and asked for one high-level headline:

- Accurate and specific across all six; **<1.5 s each, 2.25 GB.**
- It **synthesizes** rather than echoes: one session opened with "why is Tug laggy?" but the model correctly summarized the actual work ("converting TugProgressWave to a spinner") from later prompts + actions.
- Only wart — occasional conversational preamble ("The session is working on…") — fixed cleanly by one line of prompt tightening (demand a headline, forbid preamble).

### The through-line

| Job | Shape | Local fit | Engine |
|---|---|---|---|
| Scribe | long-context comprehension | poor (8B) / too slow (27B) | **Sonnet** |
| Shell classification | short-context classification | **excellent** | **1-bit 8B** |
| Pulse part-one | compact digest → headline | **excellent** | **1-bit 8B** |

## Bringing Bonsai onto main

### 1. Runtime & library support — the central decision

The eval ran the model via Python `mlx-lm`. Production Tug is Rust (`tugcast`) + Swift (`Tug.app`); we do not want to ship a Python environment. Options:

- **(A) `mlx-swift` in `Tug.app` (recommended end state).** Apple's Swift MLX bindings (`mlx-swift` + `MLXLLM`) run MLX models natively in-process, Metal-backed, no Python. `tugdeck`/`tugcast` request inference over the existing host IPC. Cleanest fit for a Mac app.
  - **Caveat / key open decision:** the *1-bit* Bonsai kernels are in the PrismML fork, not upstream MLX, so they are not in `mlx-swift` today. Two ways out: (a) ship the **ternary 2-bit** 8B instead — it runs on **stock** MLX/`mlx-swift` with **no fork dependency**, was **higher quality** than 1-bit in our scribe round, and costs only ~+0.8 GB on disk (which matters little for a *downloaded* model); or (b) wait for / port 1-bit into upstream MLX (`mlx#3161`). **Lean: ship ternary-2bit-8B on stock `mlx-swift`** to dodge the fork entirely, and re-validate it on the two jobs (expected ≥ 1-bit, since ternary beat 1-bit on scribe).
- **(B) Subprocess `mlx_lm.server` supervised by `tugcast`.** Mirrors the demo (OpenAI-compatible HTTP, `tugcast` talks to it — same `ChildSpawner`/`TugpulseSpawner` supervision pattern). Rejected for shipping: bundling a Python venv + a source-built C++/Metal fork is exactly the fragility we hit (Metal Toolchain build). Fine for further local experiments, not for release.
- **(C) A native Rust/embedded runner.** Significant work; only if (A) proves impossible.

**Recommendation:** target **(A) `mlx-swift` in the host**, with **ternary-2bit-8B on stock MLX** as the shipping model unless 1-bit lands upstream and its footprint edge is decisive.

### 2. Model acquisition — post-install TugSetup download (never a bundled blob)

Hard constraint (per product decision): **no >1 GB blob in the install package.** The weights are a **setup-time / post-install optional download.**

- **When:** an "Enable on-device AI" step in TugSetup / first-run onboarding (opt-in), or a later toggle in settings. Declined or incomplete → local features simply stay off.
- **What:** the chosen MLX pack (a directory of safetensors + tokenizer, ~1.2 GB for 1-bit, ~2 GB for ternary-2bit) into `~/Library/Application Support/Tug/models/<model>-<version>/` (Tug's Application Support tree is already a working directory).
- **How:** a **native downloader** (Swift/Rust HTTPS GETs of the model files) — no Python, no `hf` CLI dependency. Bonsai is **Apache-2.0**, so the weights are redistributable: we can **self-host them on a Tug CDN** to avoid HuggingFace availability/rate-limits and pin exact bytes. Checksum-verify each file; version-pin; make it resumable and cancellable with a progress UI.
- **Precedent:** this is the same "external dependency acquired outside the app binary" pattern as `tugrust/scripts/fetch-tmux.sh` (bundled tmux) and the `claude` CLI hard dependency — but *runtime-downloaded* rather than build-bundled.
- **Gating & fallback (load-bearing):** every local feature must degrade gracefully when the model is absent — shell classification falls back to today's heuristic; Pulse part-one is simply hidden (part two is unchanged and needs no model); scribe is unaffected (always Sonnet). Local is a strict enhancement; nothing breaks without it.

### 3. A local-model service

- If runtime (A): inference lives in the Swift host. A small service loads the model **lazily** on first use, keeps it **warm while a session is active**, and **unloads on idle** (reclaim the ~1.5–2.2 GB). Expose a task-shaped request API to `tugdeck`/`tugcast`: `classify(line, labels)` and `summarize(digest)`.
- Routing key is **task shape**, not size: classification/summary → local; comprehension (scribe) → Sonnet.
- Reuse the existing supervision/streaming idioms (`ScribeSpawner`/`TugpulseSpawner`, `kill_on_drop`, the tugbank `dev.tugtool.*` enable flags like `pulse/enabled`).

### 4. Job integration — shell classification

- Keep the **instant heuristic as the fast path** for unambiguous lines (`git status`, `how do I fix this?`). Invoke the model **only when the heuristic is unsure** — the ambiguous middle (`make the button bigger` vs `make test`) where it earned its 26/26.
- The model call is async (~200 ms), so for an ambiguous line the `!shell` chip would settle a beat after typing rather than instantly. Acceptable for the uncertain minority; the clear majority stays instant.
- Anchor points: `classifyShellLine` / `autoShellOpener` in `shell-line-classifier.ts`, consumed by `tug-prompt-entry.tsx` via `card-services-store.ts` / `path-commands-store.ts`.

### 5. Job integration — Pulse part-one

- **New component**, separate from the verbatim part-two voice. It builds a **compact digest** and summarizes it into a headline on a periodic cadence (e.g. every N tool actions or ~every 20–30 s), not per frame.
- **Data-path note (important):** the high-level summary needs the **user's goal prompts**, but the pulse wire tap **mutes user messages** (only assistant-side frames cross the pipe). So this summarizer reads the user prompts from the **session JSONL** — exactly as `scribe::session_prompts_since` already does (`tugcast` has the session path) — plus an action digest built from the `tool_use` frames it *does* see on the wire. This is a different input source than part two; not a blocker, the source exists.
- **Emit:** a new field on the `PULSE` frame (or a distinct pulse scope) so `session-pulse-strip.tsx` / `pulse-store.ts` render two lines: the stable high-level summary on top, the live verbatim line beneath. Part two (`PulseVoice`) is untouched.
- Prompt: demand a terse headline (≤ ~10 words, no preamble) — the one-line tightening that fixed the style wart in testing.

## Risks & open questions

1. **1-bit is fork-only.** The biggest dependency risk. Mitigation baked into the plan: ship **ternary-2bit-8B on stock MLX** (no fork), or track `mlx#3161`. Re-validate the chosen model on both jobs before shipping.
2. **Memory.** ~1.5–2.2 GB resident when loaded. Lazy-load, idle-unload, warm only during active sessions.
3. **Classify latency.** ~200 ms async vs an instant heuristic — keep the heuristic fast path; use the model only for ambiguous lines.
4. **Download reliability.** HF rate-limits/availability — self-host the Apache-2.0 weights on a Tug CDN, resumable + checksummed.
5. **Don't regress scribe.** Scribe stays Sonnet; the local path must never silently take it over.

## Phasing (for when this is picked up)

0. **Decide** runtime (A `mlx-swift`) and model (lean ternary-2bit-8B, no fork). Re-validate that model on the shell-classify + pulse tasks with the harness below.
1. **TugSetup optional download** + model store (`Application Support/Tug/models/…`) + gating/fallback. Nothing else depends on this landing first.
2. **Local-model service** (lazy load, warm-while-active, `classify`/`summarize` API).
3. **Job 1 — shell classification** augmentation (lowest risk, immediate value; heuristic stays the fast path).
4. **Job 2 — Pulse part-one** (new digest→headline component; part two unchanged).

Each behind a `dev.tugtool.*` flag; Sonnet scribe untouched throughout.

## Appendix — reproduction harness

Outside the repo at `~/bonsai-eval/` (survives the dash release):

- `Bonsai-demo/` — PrismML demo; `mlx/` is the built `prism`-branch fork, installed editable into `.venv`; `mlx-lm==0.31.2` (must match the fork core). Models under `Bonsai-demo/models/` (`Bonsai-8B-mlx` 1-bit; `Ternary-Bonsai-8B-mlx-2bit`; `Ternary-Bonsai-27B-mlx-2bit` — the 27B 7.9 GB pack can be deleted).
- `eval_mlx.py` — scribe test + the MLX-native subject-format DFA constraint (`SubjectConstraint`).
- `eval_27b.py` — 27B scribe test.
- `classify_8b.py` — shell-line classifier (26 cases).
- `pulse_8b.py` — Pulse part-one summary over real session transcripts.
- Real scribe prompts come from a dash-only hook in `tugcast/src/main.rs` (`TUG_DUMP_SCRIBE_PROMPT`) driving the genuine composer — that hook lives on the `tugdash/bonsai-eval` branch and will be discarded with the dash; re-add it if reproducing scribe prompts.

Raw eval reports (on the dash branch, discarded on release): `dash/bonsai-local-model-eval/` — `report-mlx-1bit.md`, `report-27b-and-classifier.md`, `report-pulse-8b.md`, and their `results-*.md`.
