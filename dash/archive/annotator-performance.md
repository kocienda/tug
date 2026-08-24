# Content annotator — performance audit

Status: audit complete, **all four fixes implemented** (uncommitted on `main`). The original feature landed as `b1604ca3f`; the regression it caused is repaired and pinned by a standing regression test (`at0309`).

Naming note: the feature is the **content annotator** — the name it was given. The public op is `annotateContent` (`lib/annotator/annotate-content.ts`); the third-party link-detection library (`linkify-element`) is confined to one wrapped call site and its vocabulary appears nowhere else.

## The standard this has to meet

The annotator's cost should be **difficult to measure**. It is a little one-time text parsing over transcript content on a very fast machine. Anything a user can perceive is a defect, not a tuning problem.

It does not currently meet that standard, and the reason is not the parsing.

## What was measured

Instrumentation added in `tugdeck/src/lib/annotator/annotate-counters.ts`, surfaced through `window.__tug.getSessionPerf(cardId).annotate`. Counters: `passes` (calls into `annotateElement`), `contentPasses` (calls into the full pass, which additionally re-runs link detection; named `linkifyPasses` at audit time, renamed with the content-annotator vocabulary), `textNodes` (text nodes visited across all passes), `totalMs` (cumulative wall time inside the passes).

Measured by `tests/app-test/at0309-annotator-cost.test.ts` against the real app.

### Case 1 — every reference resolves

A transcript of N assistant blocks, each citing one real absolute path in a code span.

| blocks | passes | linkify passes | per block |
|---|---|---|---|
| 20 | 160 | 160 | 8× |
| 40 | 320 | 320 | 8× |

Linear in this case, but the constant is 8: every block is fully re-walked eight times to produce one mark.

### Case 2 — references that cannot resolve

Same transcript, bare filenames the file index cannot answer. Nothing is streaming, nothing is on screen changing, no input.

```
t=6s    passes=240
t=21s   passes=560     marked=0
```

**320 full-transcript re-annotation passes in 15 idle seconds, producing zero annotations.** Roughly one complete re-walk of the whole transcript every two seconds, indefinitely.

### The decisive number

`totalMs = 3.0` across **560 passes** and **1680 text-node visits**.

That is ~5µs per whole-block pass and ~1.8µs per text node. **The text parsing is already free.** The cost is entirely in how many times it is provoked and what else each provocation drags along.

## Root causes

All four are in the code landed by the annotator dash.

### 1. A permanent spin loop — `file-name-resolution.ts`, `commit-resolution.ts`

An unanswered query (4s for the file index, 8s for commits) *deletes* its cache entry so a later pass can ask again. Deleting notifies → the annotation context gets a new identity → every block re-annotates → re-annotation calls `lookup()` → which re-queues the same name → which re-sends the query → which times out again.

It never converges and never stops. Any transcript containing one reference the index cannot answer pins the app in this loop for the life of the card. This is the dominant cost.

### 2. One answer invalidates the whole transcript — `transcript-host-helpers.ts`

`useAnnotationContext` folds `pathVersion`, `nameVersion` and `commitVersion` into the memo deps, so any verdict produces a new context object. That object is the invalidation signal for `TugMarkdownBlock`'s re-run effect **and** the value of `AnnotationScope`'s React context.

So one answer about one path in one block re-annotates *and re-renders* every markdown block in every mounted cell. The resolvers deliver answers serially — one notify each — so cost is O(references × blocks).

### 3. Link detection re-runs on every pass — `annotate-transcript.ts`

`annotateTranscript` calls `linkifyElement` unconditionally, including on re-annotation passes over DOM that was already linkified and has not changed. 560 of them in the idle run above.

### 4. `container.normalize()` on every pass — `annotate-transcript.ts`

Added to fix a real bug (link detection splits a text node at a filename whose extension is a TLD, so `notes.md` fragments the path around it). It is a full subtree walk plus DOM mutation, and it runs on every pass rather than only when content changed.

## Why this shipped

Ten checkpoints proved the feature *worked*. Not one measured what it *cost*. The counters that made this diagnosable took twenty minutes to write and should have existed before any of it landed.

The design error underneath: **re-annotation was treated as free.** "A verdict arrives, re-run the pass" is right in intent and ruinous as written, because *the pass* is the whole transcript and *a verdict* happens once per reference.

## TypeScript or Rust?

**Everything on the client side is TypeScript.** The grammars (`detect-path-reference.ts`, `detect-commit-sha.ts`), the DOM walk (`annotate-transcript.ts`), the text-node splitting (`wrap-matches.ts`), and the resolver orchestration.

The *answers* already come from Rust: `POST /api/fs/stat` is `tugcast/src/fs_stat.rs`, the file index is tugcast's FILETREE feed, and commit verification is tugcast's `GIT_COMMIT_FILES`. The only thing tugdeck does locally is scan strings and mutate DOM.

**Moving the scanning to Rust would not help, and the measurement says so.** The scanning is 3ms across 560 redundant passes — already below perception. The four defects above are an infinite retry loop, an over-broad invalidation signal, a redundant DOM rewrite, and a redundant DOM walk. None of them are made faster by a faster language; a Rust implementation would execute the same wrong number of passes and the app would feel identical.

There is also a hard constraint: **the annotator's real work is DOM mutation** — splitting text nodes, wrapping runs, stamping datasets — which happens inside WebKit and cannot move to Rust. A WASM or IPC boundary would only add a round trip per block to the part that is already free.

The honest read: the language is not the lever here. If, after the fixes, scanning ever becomes a measurable share of the cost, that is the moment to revisit — and the shape to revisit would be batching whole-transcript text to one tugcast call, not a per-block WASM hop.

## The fixes (implemented)

1. **The retry loop is dead.** An unanswered query no longer deletes its verdict (the deletion is what re-asked it forever). The stores retry a bounded number of times silently — verdict still `pending`, re-queued internally, no notification — and then record a terminal `unknown`. Timeouts, transport failures, and `no_repo` answers are all silent now: `pending` and `unknown` paint identically, so there is nothing to re-mark. (`file-name-resolution.ts`, `commit-resolution.ts`, `path-resolution.ts`)
2. **Invalidation is per container.** The annotation context is identity-stable across verdicts; identity changes only when a real input changes (catalog, cwd, project binding — the everything-must-re-mark cases). A pass that meets a `pending` verdict stamps its container `data-tugx-awaiting`; verdict batches re-mark only flagged containers. One answer about one path no longer re-annotates — or re-renders — anything else. (`transcript-host-helpers.ts`, `annotate-content.ts`, `tug-markdown-block.tsx`, `annotation-scope.tsx`)
3. **Verdicts are batched.** `VerdictBatcher` (`verdict-batching.ts`) coalesces the three resolver stores' notifications into one emission per 100ms window, attaching to the stores lazily. Cost is O(batches × waiting containers), not O(answers × all containers).
4. **Link detection and `normalize()` run only where HTML was written.** `annotateContent` (the full pass) runs at block build/update in `render-incremental.ts`; every verdict-driven re-mark goes through `annotateElement`, which does neither. The normalize moved to immediately after link detection — the only thing that splits text nodes.
5. **The measurement stands guard.** `at0309` is now a regression test: real paths must all mark, passes are bounded linear in blocks, content passes are bounded by rendered blocks, and a settled transcript must show **zero** pass growth across a 15-second idle window.

## Measured after the fixes

```
messages=40  passes=200  contentPasses=80  textNodes=840  totalMs=7.0  idleGrowth=0
```

5 element passes per block (build, mount safety net, one verdict-batch re-mark), exactly one content pass per rendered markdown block, and idle cost identically zero — with half the references deliberately unresolvable. Compare the pre-fix idle run: 320 passes in 15 seconds, indefinitely.

## Working state (uncommitted on `main`)

- `tugdeck/src/lib/annotator/annotate-content.ts` — renamed from `annotate-transcript.ts`; `annotateContent` / `annotateElement` split; awaiting-flag machinery.
- `tugdeck/src/lib/annotator/verdict-batching.ts` — new, the batcher.
- `tugdeck/src/lib/annotator/annotate-counters.ts` — new, the counters (`passes`, `contentPasses`, `totalMs`, `textNodes`).
- `tugdeck/src/lib/annotator/{path,file-name,commit}-resolution.ts` — terminal verdicts, bounded silent retries.
- `tugdeck/src/components/tugways/cards/transcript-host-helpers.ts` — stable context identity, batched subscription.
- `tugdeck/src/components/tugways/tug-markdown-block.tsx`, `annotation-scope.tsx` — gated re-mark subscriptions.
- `tugdeck/src/test-surface.ts` — `getSessionPerf().annotate` exposes the snapshot.
- `tests/app-test/at0309-annotator-cost.test.ts` — the standing regression test.
