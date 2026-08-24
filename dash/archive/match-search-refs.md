<!-- devise-skeleton v4 -->

## Match / Search / Refs — File-Reference Commands in the Session Card {#match-search-refs}

**Purpose:** Port the C++ `match` (filename matcher), `search` (content grep), and
`ref` (numbered-reference opener) tools into Tug.app as three **local slash commands**
(`/match`, `/search`, `/ref`) whose results stream into the Session card transcript as a
numbered, clickable file-reference list — clicking a result (or typing `/ref N`) opens
the file in a Text card at the referenced location.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-15 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-15, opus.** Reviewed `plan:8075cbbc340ca938`. Lint: 0 errors, 1 warning (fixed — this section did not exist; the plan predates it).
Oriented on: the whole document, first review. The plan was devised 2026-07-11 and read against the code as it stands today.
Applied: **architecture** — [P08] was rewritten from "two bespoke row renderers" to composition, because the body-kinds layer landed after this plan was written and already ships both shapes: `PathListBlock` (annotator-wired clickable path list on `TugListView`) is `/match`'s renderer and `SearchResultBlock` (grouped-by-file matches with hit spans highlighted from explicit half-open char offsets) is `/search`'s. That deletes `refs-match-row.tsx`, `refs-search-row.tsx`, and the bespoke row chrome from the inventory and reduces the new view layer to one pure derivation module. `SearchResultBlock`'s docstring records click-to-open as a deferred follow-on; the plan now lands it as an **opt-in prop**, defaulted off, so `GrepToolBlock` is untouched and can adopt it later in one line (added to #roadmap).
**Dead symbols** — `ToolFileRef`, on which Spec S05, [P09], [P10], and #dependencies all leaned, no longer exists; clickable file references are now the content annotator's `file-path` kind, whose `primaryClick` dispatches the same `OPEN_FILE` payload and which `path-list-block.tsx` demonstrates with no handler and no responder ([L11]). Rewrote all four sites. Likewise `ROUTE_ITEMS` / `ROUTE_PREFIX_ALIAS` / `RETURN_ACTION_BY_ROUTE`: [P01]'s conclusion survives the composer-route rework but its rationale named symbols that are gone, so it was re-argued against `SELECT_COMPOSER_ROUTE` (`prompt`/`changes`/`join`) and now cites [L30].
**Renames** — every `dev-card*` / `dev-transcript*` path and the `DevTranscriptCellKind` type carried the retired "Dev card" name; swept to `session-card*` / `session-transcript*` / `SessionTranscriptCellKind` throughout, prose included. The C++ reference sources moved to `dash/archive/`.
**Correctness** — added [P14] and [Q05] fixing the wire's offset base: `SearchResultBlock` consumes 0-based half-open char spans, the C++ source carries a 1-based display bias, and importing that bias would misplace the highlight by one character on every hit. Added a required non-ASCII test fixture, since char-vs-byte offsets are the port's likeliest silent defect. Corrected the FeedId note (`0x70` is `GAZETTE`, not `TUG_FEED`; `0x62`/`0x63` re-verified free). Corrected the handler signature to the two-parameter `(args, draft?)`. Replaced the "add `globset` as a direct workspace dep" task — `glob` is already a direct `tugcast` dependency and suffices for basename patterns, so Step 1 needs no `Cargo.toml` edit at all. Named `SessionZ1BParticipant` as a **third** participant union the plan had missed alongside `Participant` and the cell-kind type. Noted that the data source's trailing-ink walk documents itself as mirroring `appendTurnInterleavingShell` exactly, so [P13]'s generalization must move both or they drift.
**Scope** — Step 12 (the transient option cluster) was cut to #roadmap: its mount design depended on the route chrome that no longer exists, and three inputs to one behavior (chips, persisted defaults, typed flags) is a precedence rule users cannot see. [P07] is now "typed flags are the only source of truth," with `refs-flags.ts` still exposing a token emitter so the follow-on adds a surface rather than a second grammar. The final checkpoint renumbered to #step-12. [Q04] was resolved by obsolescence — `find-route.md` is archived unbuilt, so a deferral gated on it landing could never open; `/find` is out of scope with no dangling roadmap item.
**Tests** — added the `@covers` requirement and derived-selection discipline, and a `just app-test` → `just app-test-changed` sweep; added an exit criterion asserting Grep's rows stay non-clickable, since that is the one way the opt-in prop could regress a surface this plan does not own.
Asked and settled with the user: the composition scope (opt-in clicks, not global), the Step 12 cut, and the `/find` disposition. Nothing was deferred to an Open Question.

**Round 2 — 2026-08-15, opus.** Reviewed `plan:5fe31d73426927a2`. Lint: 0 errors, 0 warnings on entry and on exit.
Oriented on: the Review Record — round 1 landed whole in `a0cfdf622` and the plan has been clean since, so there is no diff to read; this round re-read the code the plan touches rather than the document's own history.
Applied: **correctness** — added [P15] after finding the round-1 rewrite to the content annotator left a contradiction it could not have known it created. `PathListBlock` annotates a row **only when its path is absolute** (`const annotated = path.startsWith("/")`), and `FilePathPayload.path` is contractually the absolute canonical path with nothing downstream resolving a relative one — but #wire-frames makes `path` relative to `root` and told `refs-result-view.ts` to relativize. Every `/match` row would have rendered perfectly and done nothing on click, failing Spec S02, Spec S05 and two success criteria with no unit test able to see it. The wire and ledger stay relative (portable, and what the C++ tools reported); the view and `/ref` join `root` from one shared helper. Amended #wire-frames, #dependencies, [P08], [P09], Spec S05, #symbol-inventory, #state-zone-mapping, and Steps 6 and 8, and added the assertion that catches it: the app-test now checks the row carries `data-tug-annotation`.
**Holes** — three parity sites the plan never named, all silent rather than loud. `countClaudeTurns` (`session-load-control-bar-state.ts`) is a **third** ink predicate beside the two [P13] generalizes, excluding `origin === "shell"` only; a refs turn would make the metadata row read "83 of 68", the exact bug that function's own docstring warns about. `rowSegments` in `transcript-search-index.ts` branches `ghost`/`shell`/`user` and lets everything else fall to the assistant path, which returns `[]` for a descriptor with no message range — refs rows would be invisible to transcript Find, which matters because #non-goals points the user at `FIND` as *the* transcript-search surface. And Share is not what the plan assumed: there is no `SHARE_*` action anywhere in the vocabulary. The shell row's add-to-context toggle calls `pendingContextStore.stage(…)`, and two of that store's unions are closed — `ContextSource` is `"shell" | "btw"`, and the `<tug-context source="(shell|btw)">` `OPEN_RE` is a **durable format**, since the sentinel travels inside the sent user message into the session JSONL and is split back out on reload. An unwidened regex means a shared refs block returns as raw text after a reload; the store's binary `n(source)` ternary would meanwhile answer `_btwContext` for `"refs"`. All three are now in [P03]/[P13], #dependencies, #symbols, Steps 5 and 6, and the exit criteria, with a round-trip test on the sentinel — the half a click cannot expose.
**Rust** — [P05] and Step 4 now name the two gates a `shell_ledger.rs` clone must not drop: `tugcore::ledger_db::open` / `apply_pragmas` (a bare `Connection::open` fails the workspace's `no_ad_hoc_ledger_opens` source-scanning test, so this breaks the build, not a convention) and `ledger_integrity::integrity_gate` / `salvage_into`. Re-verified `0x62`/`0x63` still free and `glob`, `regex`, `rayon` still direct `tugcast` deps.
**Corrections** — [P01] claimed registry entry auto-wires `/m`→`/match` inline completion; `/model`, `/mode`, and `/memory` all hold that prefix, so the claim is false as written and now reads as prefix-rule resolution with an explicit "do not special-case it," matching the note Step 8 already carried for `/r`. Re-verified against the tree: no name collides with an existing registry entry; the handler signature, the three participant unions, `upsertShellTurn`/`appendTurnInterleavingShell`, `SearchResultSpan`, both blocks' `embedded` modes and `componentStatePreservationKey`, and `openFileInCard`'s signature are all as round 1 recorded them.
Left alone: Step 6 grew — the Share widening and the search-index projection are real work — but Share is already a success criterion and an exit criterion, so this is the cost of a decision the plan made, not a new one, and it was not re-opened. Nothing was deferred to an Open Question.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The repository carries three well-loved C++ command-line tools in `dash/archive/`:
`match-tool.cpp` (walks a directory tree and lists files whose **filenames** match one
or more needles), `search-tool.cpp` (walks files and greps their **contents**, reporting
`path:line:column` + the matched line), and `ref-tool.cpp` (reads the numbered
`TextRef` list the other two write to `REFS_PATH` and opens ref *N* in an editor). All
three revolve around one shared object — a **`TextRef`**: a numbered `filename` +
optional `line` + optional column-`spread` + the matched line text. `match`/`search`
each *produce* a numbered ref list (the newer run overwrites `REFS_PATH`), and `ref`
*consumes* it by number.

We want great Rust versions of these, surfaced natively in the Session card. The Session
card's prompt entry already has a **local slash-command system** (client-side commands that
run Tug-side work without sending a Claude turn — `/btw`, `/model`, `/diff`, …) and a
transcript that already renders **non-context "ink" rows** (the `$` shell route's `#s`
exchanges, which record what the *user* did and never enter Claude's context). Result
rendering and click-to-open are likewise already solved, twice over: the **body-kinds**
layer ships `PathListBlock` (a `TugListView` list of clickable file paths) and
`SearchResultBlock` (grouped-by-file matches with the hit spans highlighted), and the
**content annotator**'s `file-path` annotation kind supplies the click and the context
menu for any row that stamps it. This plan composes those existing mechanisms — slash
commands (front door), a streaming tugcast feed (the Rust port), the body kinds (rows),
and non-context transcript ink (output) — into the match/search/ref experience. It authors
very little new UI.

**Reference implementation (READ THESE).** The original C++ tools live in
`dash/archive/` and are the **ground truth** for the port's algorithmic details — read
them for the exact behavior this plan describes at the behavioral level:
- `dash/archive/match-tool.cpp` — filename matching: multi-needle accumulation across
  directories, the filename-match flags, the `-a`/`-e`/`-d`/`-s`/`-1` semantics.
- `dash/archive/search-tool.cpp` — content grep: the per-line "all needles matched"
  filter (`matched_needle_indexes.size() == needle_count`), the spread-merge pass, and the
  exact line/column math (column = `match_start_index - line_start_index + 1`, the `+1`
  bias) and line-end-offset computation. Lists L01/L02 and Spec S03 summarize the behavior;
  the source is authoritative for the edge cases. Note the display bias is C++-side
  presentation only — the wire model here is 0-based half-open char offsets ([P14]).
- `dash/archive/ref-tool.cpp` — number-spec parsing and open behavior (Spec S04).

Port the *behavior*, not the C++ structure (single-threaded mmap, `getopt`, `REFS_PATH`);
this plan's mechanisms (streaming feed, ledger, slash commands) replace the scaffolding.

#### Strategy {#strategy}

- **Front door = local slash commands, not composer routes.** `/match`, `/search`, `/ref`
  are pure local commands: one entry each in the `LOCAL_SLASH_COMMANDS` registry plus one
  handler each in the session card's exhaustive `slashCommandSurfaces` map. No composer-route
  changes — a composer route (`prompt` / `changes` / `join`) selects what the *composer
  submits*; these are Tug-side computations invoked from the prompt route. ([P01], [L30])
- **One Rust feed hosts both ops.** A new tugcast feed (`refs`) with a `REFS_INPUT` /
  `REFS_OUTPUT` `SessionScopedFeed` pair runs both `match` and `search` over a shared
  gitignore-aware directory walk lifted from the existing file-watcher. Cloned structurally
  from the `$` shell feed. ([P02])
- **Stream results; make them cancellable.** Result rows are emitted incrementally as
  they are found (the block grows live under a pulsing header) and a run can be cancelled
  mid-flight, exactly like the shell feed's exec/kill. ([P04])
- **Unified `refs` transcript origin, non-context ink.** Both commands mint a new
  `"refs"`-origin transcript turn (addressed `#r{n}`), following the shell `#s` doctrine:
  refs are the user's own investigation, never sent into Claude's context unless the user
  invokes the block's **Share** gesture. ([P03])
- **Ledger-backed, latest-only.** The newest run's refs replace the previous ones in a
  per-session ledger (clobber-on-new), so `/ref N` and a Maker ▸ Reload always resolve
  against the most recent list — mirroring how `REFS_PATH` was a single overwritten file.
  ([P05])
- **Compose the existing body kinds; author no row renderers.** `match` results render
  through `PathListBlock` and `search` results through `SearchResultBlock` — the two
  list-shaped body kinds `GlobToolBlock` / `GrepToolBlock` already compose — under one
  refs block chrome (Share + Copy, like `ShellExchangeBlock`). The only new view code is a
  pure derivation from the numbered ref list into each body kind's data shape. ([P08])
- **Build in vertical slices.** Rust ops (pure, unit-tested) → feed wiring → frontend
  store + origin → block + clickable refs → the slash commands → `/ref` opener → reload
  restore → column-span highlight in the Text card. Each step is a commit with a
  falsifiable checkpoint, most runnable in the live-HMR app.

#### Success Criteria (Measurable) {#success-criteria}

> Falsifiable.

- Typing `/search <needle>` in the Session card streams a numbered `#r` result block into
  the transcript whose rows appear incrementally; each row reads `path:line` with the
  matched line text and the hit span highlighted in place, and clicking one opens that file
  in a Text card scrolled to the line. (Spec S03, Spec S05)
- Typing `/match <needle>` streams a numbered `#r` result block of matching **filenames**
  (no line); clicking a row opens the file. (Spec S02, Spec S05)
- `/ref 3`, `/ref 3-5`, and `/ref 3 7 9` open refs 3 / 3–5 / 3,7,9 from the **most
  recent** match-or-search block, honoring the deck's "open new text files" (`openTarget`)
  preference; an out-of-range number reports a subdued error and opens nothing invalid.
  (Spec S06)
- A `/search` over a large workspace can be cancelled mid-stream (the in-flight block
  settles with the rows found so far); an invalid `-e` regex yields zero results and no
  crash. (Spec S03, Risk R02)
- Running a second `/match` or `/search` replaces the ref list; after a Maker ▸ Reload
  the transcript restores exactly the last block and `/ref N` still resolves against it.
  (Spec S07, [P05])
- `cargo nextest run` passes (Rust ops + walk + ledger), `bunx tsc --noEmit` and
  `bunx vite build` succeed, and the plan's own app-test files pass an end-to-end
  match/search/ref scenario. (#exit-criteria)

#### Scope {#scope}

1. A Rust `refs` feed in `tugcast` with a shared gitignore + secret-aware directory walk,
   a `match` operation (filename matching) and a `search` operation (content grep), a
   `TextRef` wire model, streaming result frames, and cancellation.
2. A `refs_ledger.rs` persisting the latest ref list per `tug_session_id` (clobber-on-new)
   and a `list_refs` CONTROL read for restore.
3. Frontend `REFS_INPUT`/`REFS_OUTPUT` protocol wiring, a per-card `RefsSessionStore`,
   a new `"refs"` `TurnOrigin` with `#r` addressing, a `RefsResultMessage`, the reducer /
   data-source / transcript-cell plumbing to render it, and Share/non-context-ink parity
   with shell.
4. A refs result block (shared chrome) that composes `PathListBlock` for `match` results
   and `SearchResultBlock` for `search` results, plus an **opt-in** click-to-open prop on
   `SearchResultBlock` (its match rows are display-only today) so refs rows open files
   while `GrepToolBlock`'s behavior is unchanged.
5. The `/match`, `/search`, `/ref` local slash commands (registry + exhaustive handlers)
   with typed getopt-style flag parsing per Lists L01/L02.
6. `/ref` number resolution (single / range / list) against the latest refs, opening each
   honoring the `openTarget` pref, capped and warned past a ceiling.
7. Restore of the latest ref block on card reload via the ledger.
8. Column-span highlight for `search` refs — extending the **Text-card** reveal chain to
   accept a column range (line-granular reveal ships earlier; this sharpens it). Distinct
   from the in-block span highlight, which `SearchResultBlock` already renders.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Search-and-replace** (`search -r`) and its **dry-run** (`-n`) — file-mutating; deferred
  entirely (see #roadmap).
- The dropped CLI-only flags that the Tug model subsumes: `-c` color, `-p` pipe,
  `-f` full-path, `-o` open, `-r`/`REFS_PATH` refs-file, `-t` terse (display is Tug's
  concern; opening is a click; refs live in the transcript + ledger).
- **`/find`** — a *transcript* live-search command. Transcript Find is a different engine
  from filesystem grep, and the plan that designed it (`dash/archive/find-route.md`) was
  archived unbuilt. `/find` is therefore out of scope with no follow-on gate: the deck's
  existing `FIND` command action is the transcript-search surface, and if a `/find` slash
  alias is ever wanted it belongs to a Find plan, not to this one ([Q04]).
- A general "searchable file-type allowlist" (the C++ `SEARCHABLES` concept). Tug's skip
  model is gitignore + `SecretFilter`; there is no extension allowlist and this plan does
  not add one ([P11]).
- Fuzzy filename matching for `/match` — `match` is deterministic (substring / exact /
  glob), distinct from the existing fuzzy file-picker ([P11]).
- **The option cluster** (Case / Regex / All-files / Any-needle chips writing flags into
  the draft) — deferred to #roadmap. Typed flags are the source of truth ([P07]) and fully
  drive behavior; the cluster is discoverability sugar whose mount needs re-designing
  against the composer-route model that exists now, and that design does not belong in this
  phase's critical path.

#### Dependencies / Prerequisites {#dependencies}

- **Slash-command surface** (frontend): `LOCAL_SLASH_COMMANDS` in
  `tugdeck/src/lib/slash-commands.ts` (the registry; completion, matching, arg-parsing,
  history, and the not-sent-to-Claude classifier all derive from it), and
  `slashCommandSurfaces` in `tugdeck/src/components/tugways/cards/session-card.tsx` (the
  exhaustive `Record<LocalCommandName, (args: string, draft?: SlashCommandDraft) => void>`
  handler map — note the **two-parameter** signature; a registry entry without a handler is
  a compile error). `/btw` is the worked clone target (registry entry with
  `takesArgs: true`; handler at the `btw:` key; responder at
  `[TUG_ACTIONS.RUN_SLASH_COMMAND]`). The registry also carries a `deprecatedFor` alias
  field and a `runRetiredVerb` path — neither is needed here (these are new names, not
  renames).
- **Shell feed as structural template** (Rust + frontend): `tugcast/src/feeds/shell.rs`
  (dispatcher + per-session actor + serde-tagged `ShellInput`), `tugcast/src/shell_ledger.rs`
  (sqlite ledger + `list_exchanges`), the `main.rs` wiring block (feed at `feeds::session_scoped::SessionScopedFeed::new(FeedId::SHELL_OUTPUT, …)`, `mpsc::channel` input,
  `shell_dispatcher_task` spawn, `feed_router.register_session_feed` + `register_input`),
  `tugdeck/src/lib/shell-session-store.ts` (per-card store: `exec`/`kill`, frame send on
  `FeedId.SHELL_INPUT`, `_fold` into `CodeSessionStore.ingestShellExchange`,
  `applyRestoredShellExchanges` for the ledger read), and the transcript render path
  (`ShellTurnCell` in `tugdeck/src/components/tugways/cards/session-card-transcript.tsx`,
  `ShellExchangeBlock`/`shell-exchange-view.ts`, the `shellRowOrdinal` slot field in
  `tugdeck/src/lib/session-transcript-data-source.ts`). The Rust half is unchanged since
  this plan was written; the frontend files were renamed `dev-*` → `session-*`.
- **Directory-walk infra** (Rust, in `tugcast`): `ignore::WalkBuilder` usage in
  `tugcast/src/feeds/file_watcher.rs` (`walk_with_cap`, `WALK_CAP = 50_000`,
  `.git_ignore(true)`, `.git`-skip), `SecretFilter` in `tugcast/src/feeds/secret_filter.rs`
  (`new(workspace_root)`, `is_secret(relative_path)`, `SECRET_FILE_DENYLIST`,
  `.tugattachignore`), the safe file read in `tugcast/src/fs_read.rs`
  (`MAX_READ_BYTES = 8 MiB` size guard, `std::fs::read`, `String::from_utf8` → non-UTF-8
  treated as binary), `PathResolver` (`tugcast/src/path_resolver.rs`, relativization),
  and `rayon` + `regex` + `glob` — all three **already direct deps of the `tugcast` crate**,
  so no `Cargo.toml` edit is needed. The `FileTreeFeed`
  in `tugcast/src/feeds/filetree.rs` is the closest existing "query (carrying `root`) →
  session-scoped result" analog and shows the `FileTreeQuery { root: Option<PathBuf>, … }`
  shape.
- **Result rows** (frontend) — the two list-shaped **body kinds**, both built on
  `TugListView`, both already composed by the Claude tool blocks:
  - `PathListBlock` (`tugdeck/src/components/tugways/body-kinds/path-list-block.tsx`) —
    a list of clickable file paths with `MiddleEllipsisPath`, a found/name sort toggle, a
    `BlockCopyButton`, standalone **and** `embedded` modes (the header's actions cluster
    portals into the host `BlockChrome`). `GlobToolBlock` composes it; `GrepToolBlock`
    reuses it for files-only mode. This is `/match`'s row renderer. **A row is annotated —
    and therefore clickable — only when its path is absolute** (`path.startsWith("/")`;
    relative paths are left un-annotated by design), which is why refs rows carry absolute
    paths ([P15]).
  - `SearchResultBlock` (`…/body-kinds/search-result-block.tsx`) — matches grouped by file
    under collapsible file-header rows, each match row rendering `line` + text with the hit
    **spans highlighted from explicit char offsets** (`SearchResultSpan = [start, end)`,
    half-open, defensively clamped/merged at render), plus context lines. `GrepToolBlock`
    composes it `embedded`. This is `/search`'s row renderer — its `SearchResultData` /
    `SearchResultFile` / `SearchResultMatch` types are the target of this plan's view
    derivation. **Its match rows are deliberately display-only**; the click-to-open
    affordance is a documented deferred follow-on that this plan lands as an opt-in prop
    ([P08]).
- **Click-to-open** (frontend) — the **content annotator**, not a bespoke component
  (`ToolFileRef` no longer exists). A row stamps `ANNOTATION_CLASS` (`tugx-annotation`) +
  `data-tug-annotation="file-path"` + `data-path` (+ `data-line` / `data-end-line`) +
  `data-tug-focus="refuse"` + `data-no-activate`, and the transcript's delegated layer
  supplies the click and the context menu: `registerAnnotationKind("file-path", …)` in
  `tugdeck/src/lib/annotator/registry.ts` dispatches
  `TUG_ACTIONS.OPEN_FILE` with `{ path, line?, endLine? }` and offers Open in Editor /
  Show in Finder / Copy Path. `path-list-block.tsx` is the worked precedent — it owns no
  handler and no responder, which is why a Glob result opens exactly like a path written
  in assistant prose. Refs rows do the same. `FilePathPayload.path`
  (`tugdeck/src/lib/annotator/payloads.ts`) is documented as the **absolute canonical**
  path and `openTargetFor` forwards it verbatim — nothing downstream resolves a relative
  path ([P15]).
- **Share into Claude's context** (frontend) — the `PendingContextStore`
  (`tugdeck/src/lib/pending-context-store.ts`), not an action in the vocabulary: there is no
  `SHARE_*` action. A shell row's `CommandBlock` carries a `staged` / `onToggleContext` pair
  (wired in `session-card-transcript.tsx`) that calls `pendingContextStore.stage({ source,
  ref, label, body })` with `composeShellShareText(message)`, and the staged items are
  prepended to the next `❯` submission wrapped in a `<tug-context source="…" ref="…">`
  sentinel. Two things there are **closed unions, not open ones**: `ContextSource` is
  `"shell" | "btw"`, and the sentinel is parsed back out of the session JSONL by a literal
  `OPEN_RE = /^<tug-context source="(shell|btw)" ref="…/` — a **durable wire format**, so a
  third source that is not in that alternation round-trips as raw text on reload. The
  store's `n(source)` visibility read is a binary ternary that answers `_btwContext` for
  anything that is not `"shell"`. See [P03].
- **Transcript search** (frontend): `tugdeck/src/lib/transcript-search-index.ts` projects
  each transcript row into search segments — `rowSegments` branches `ghost` / `shell`
  (`shellSegments`) / `user`, and everything else falls through to the assistant path, which
  returns `[]` for a descriptor with no `messageStart`/`messageEnd`. A new cell kind is
  therefore *silently* unsearchable rather than broken. See [P03].
- **Loaded-turn accounting** (frontend):
  `tugdeck/src/components/tugways/cards/session-load-control-bar-state.ts` `countClaudeTurns`
  — the `X of Y` metadata figure, which excludes `origin === "shell"` only. See [P13].
- **File-open / reveal chain** (frontend): `openFileInCard`
  (`tugdeck/src/lib/open-file-in-card.ts` — signature
  `(store, path, line?, endLine?)`; path-keyed reuse, viewable-file fork, then the
  `openTarget` default `"reuse"|"newTab"|"new"`), the `TUG_ACTIONS.OPEN_FILE` handler in
  `tugdeck/src/action-dispatch.ts`, and the Text-card reveal
  (`text-card-open-registry.ts`, `text-card.tsx`, `tug-text-card-editor.tsx`
  `revealLineFn` — currently **line-granular** via a `Decoration.line` flash).
- **Workspace root** (frontend): `binding.projectDir` — already threaded into the shell
  store (`new ShellSessionStore(…)` in `tugdeck/src/lib/card-services-store.ts`) and
  carried as `root` on `FILETREE_QUERY` / `git_diff_request` frames. This is the walk
  root ([P06]). The card-services construction site and
  `tugdeck/src/components/tugways/cards/use-session-card-services.ts` are where
  `RefsSessionStore` joins it.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS.** The Rust workspace enforces `-D warnings`
  (`tugrust/.cargo/config.toml`); `cargo build` and `cargo nextest run` fail on any
  warning. Fix warnings immediately.
- **Verify with `bunx vite build`.** The debug app loads the production rollup bundle; an
  import that works under dev esbuild can still fail the build. `bunx vite build` must
  succeed before any tugdeck change is declared done.
- **Tuglaws** (tugdeck): [L02] external state via `useSyncExternalStore`; [L03]
  registrations in `useLayoutEffect`; [L06] appearance via CSS/DOM, never React state;
  [L22] store-observer for state that drives direct DOM writes; [L11] controls emit
  actions, responders own state — the refs block owns no responder, exactly as
  `PathListBlock` / `SearchResultBlock` do not; [L19] component-authoring conformance for
  any new component file pair; [L20] component-token sovereignty — the refs chrome owns
  `--tugx-refs-*` and cascade-tunes the body kinds' own tokens rather than reaching into
  them; [L30] every user-invocable command is a registry entry through the two funnels
  (`/match`, `/search`, `/ref` are registry entries, and the row click dispatches
  `OPEN_FILE`, an existing entry). See #state-zone-mapping.
- **No `localStorage`/`sessionStorage`/IndexedDB** — persistence via tugbank / the Rust
  ledger.
- **Security:** the `SecretFilter` denylist is **never** bypassed by any flag (including
  `-a`/`-s`) — secrets must never surface in refs ([P11], Risk R03).
- **Real, not fake:** no mock-store or jsdom render tests; end-to-end verification drives
  the real Session card via the app-test harness / the live app.
- **App-tests declare coverage.** Every new `*.test.ts` carries `@covers` lines in its
  header docblock naming the sources it exercises, or `just app-test-covers-check` fails.
  Selection is `just app-test-changed`; never a full-corpus sweep.

#### Assumptions {#assumptions}

- The Session card has a `tug_session_id` and a `projectDir` (workspace root) available at
  the point the slash handler runs — the same values the `ShellSessionStore` is constructed
  with (`tugdeck/src/lib/card-services-store.ts`).
- Result **numbering is emission-order and stable once assigned**: a `#r{n}` number is
  fixed when its row is first emitted and never renumbered, so `/ref N` is well-defined
  even though rows stream in (rayon) rather than fully sorted ([P12]).
- A `refs` origin turn carries exactly one `RefsResultMessage` (the whole ref list for one
  run), mirroring how a `shell` turn carries exactly one `ShellExchangeMessage`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings, kebab-case, no phase numbers in anchors. Plan-local
decisions are `[P01]`…; global tuglaws/design-decisions are cited by their own IDs
(`[L02]`, `[D##]`). Never cite line numbers — cite anchors and symbol names.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Streaming result ordering & numbering (OPEN) {#q01-ordering}

**Question:** `search` scans files in parallel (`rayon`), so results arrive out of the
walk order. How are rows ordered and numbered given they stream in?

**Why it matters:** `/ref N` must resolve to a stable target; renumbering mid-stream would
make `N` ambiguous. The C++ tool sorted all refs then numbered 1..N — impossible to
reproduce faithfully while streaming.

**Options:**
- Emit per-file batches; assign `#r{n}` in emission order; never renumber (streaming-native).
- Buffer everything, sort by `path`/`line`, number at completion (loses streaming).

**Plan to resolve:** Decide up front (streaming is a hard requirement per [P04]).

**Resolution:** DECIDED (see [P12]) — emission-order numbering, stable once assigned. Each
file's own matches are emitted together and sorted by (line, column) within the file; files
stream as their scans complete. A deliberate, documented divergence from the C++ global
sort, justified by streaming.

#### [Q02] `-a` / `-s` skip semantics in the Tug model (OPEN) {#q02-skip-flags}

**Question:** The C++ `search` distinguished `SEARCHABLES` (a file-type allowlist) from
`SKIPPABLES` (skipped dirs), with `-a` = "not just searchables" and `-s` = "include
skippables". Tug has no searchables allowlist — only gitignore + `SecretFilter`. What do
`-a`/`-s` mean here?

**Why it matters:** Wrong mapping either leaks secrets or makes a flag meaningless.

**Options:**
- Collapse both intents into one flag that walks into **gitignored** dirs
  (node_modules/target/…) while `SecretFilter` still applies.
- Keep two flags with contrived distinct meanings.

**Plan to resolve:** Decide during Rust op design.

**Resolution:** DECIDED (see [P11]) — one flag `-a` ("all files": also descend into
gitignored paths); `SecretFilter` is **always** enforced regardless. `-s` is accepted as an
alias of `-a` for muscle memory. No searchables allowlist is introduced.

#### [Q03] Merged-per-line vs one-row-per-match for `search` (OPEN) {#q03-merge}

**Question:** The C++ default merged all matches on a line into one `TextRef` (with a
multi-stretch spread); `-l` split them one-per-line. Which is the Tug default, and how does
merging interact with the clickable row + column highlight?

**Why it matters:** Determines the row model (`columns: Spread` vs a single column) and
how many `#r` numbers a busy line consumes.

**Options:** Default merged (one row per matching line, multi-span highlight), `-l` splits.

**Plan to resolve:** Mirror the C++ default.

**Resolution:** DECIDED — default **merged** (one `#r` row per matching line, carrying a
list of column spans); `-l` emits one row per match. Line-granular reveal ignores the
spans; the column-span highlight step ([P10], #step-11) paints all spans on the line.

#### [Q04] `/find` slash alias (RESOLVED) {#q04-find-alias}

**Question:** The invocation also mentioned `/find`. Should it ship here?

**Why it matters:** Scope. Transcript Find is a separate engine from filesystem grep.

**Resolution:** RESOLVED by obsolescence (2026-08-15 review). The original deferral was
gated on `find-route.md` landing; that plan was archived unbuilt
(`dash/archive/find-route.md`), so the gate can never open and the deferral cannot be
carried forward as written. `/find` is simply out of scope (#non-goals), with no follow-on
item: the deck already exposes transcript search as the `FIND` command action, and a
`/find` slash alias — if ever wanted — is a Find plan's decision, not this plan's debt.

#### [Q05] Column offset base on the wire (RESOLVED) {#q05-offset-base}

**Question:** The C++ tool reported a 1-based display column
(`match_start_index - line_start_index + 1`). `SearchResultBlock` consumes 0-based
half-open `[start, end)` char offsets into the line text. Which does the wire carry?

**Why it matters:** An off-by-one here paints the highlight one character to the right on
every single search hit, and the error is invisible in a unit test that asserts against
its own convention.

**Resolution:** RESOLVED (see [P14]) — the wire carries **0-based, half-open char offsets**,
matching `SearchResultSpan` exactly so the block consumes them with no adaptation. The C++
`+1` is presentation, and Tug has no column display to bias. `line` stays **1-based**,
matching `SearchResultMatch.line`, `revealLine`, and the annotator's `data-line`.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Content grep over a huge workspace stalls the feed | med | med | Streaming + `rayon` + `WALK_CAP` + `MAX_READ_BYTES` size cap + cancellation; see #r01-scan-cost | A `/search` visibly hangs or floods rows |
| Invalid `-e` regex from the user | low | med | `Regex::new` in a guarded path → zero results + a subdued notice, never a panic; #r02-regex | A bad pattern crashes or errors loudly |
| Binary / non-UTF-8 files scanned | low | high | Reuse `fs_read` UTF-8 gate; skip non-text bytes; never emit secret paths (`SecretFilter`); #r03-binary-secrets | Garbage rows or a secret path appears |
| Column-span highlight paints a spurious WebKit wash | low | med | Publish only non-collapsed real `Range`s; assert range/attr state, not pixels; #r04-highlight-wash | A caret-only highlight shows a wash |
| A second run mid-stream races the ledger clobber | med | low | Clobber is keyed to a run id; late frames from a superseded run are dropped; #r05-clobber-race | Stale rows from a prior run linger |

**Risk R01: Scan cost** {#r01-scan-cost}
- **Risk:** A workspace-wide content grep is O(bytes) and can be large.
- **Mitigation:** Stream rows as found (no wait-for-all); scan files in parallel via
  `rayon`; cap the walk at `WALK_CAP`; skip files over `MAX_READ_BYTES`; support cancel
  (a `cancel` input frame reaping the run). `match` (filename-only) never reads file bodies.
- **Residual risk:** A pathological tree still costs CPU; acceptable for a user-initiated,
  cancellable command.

**Risk R02: Regex safety** {#r02-regex}
- **Risk:** `search -e <pattern>` with an invalid or pathological regex.
- **Mitigation:** Construct `Regex` in a guarded path; invalid → the run completes with
  zero results and a subdued notice frame (no panic). The `regex` crate has no catastrophic
  backtracking (linear-time automaton), so ReDoS is not a concern.
- **Residual risk:** A valid but broad pattern returns many rows — bounded by streaming +
  cancel.

**Risk R03: Binary files & secrets** {#r03-binary-secrets}
- **Risk:** Scanning could emit garbage from binary files or, worse, surface a secret path.
- **Mitigation:** Reuse the `fs_read` UTF-8 gate (non-UTF-8 → skip). `SecretFilter` is
  applied to every candidate path and is **never** bypassed by any flag.
- **Residual risk:** None material for text refs.

**Risk R04: Highlight wash** {#r04-highlight-wash}
- **Risk:** A collapsed Range in a CSS Custom Highlight paints a spurious wash in WebKit
  (known gotcha, per project memory).
- **Mitigation:** Only register non-empty column spans; for a bare line (no spans) fall
  back to the existing line flash. Test asserts range/attribute state, not screenshot pixels.
- **Residual risk:** None.

**Risk R05: Clobber race** {#r05-clobber-race}
- **Risk:** Starting a new run while a prior run still streams could interleave rows or
  double-write the ledger.
- **Mitigation:** Each run carries a `run_id`; the store and feed drop frames whose
  `run_id` is not the current one; the ledger records only on a run's completion, keyed by
  `tug_session_id` (latest overwrites).
- **Residual risk:** A superseded run's CPU keeps briefly until it observes cancellation.

---

### Design Decisions {#design-decisions}

#### [P01] Front door is local slash commands, not composer routes (DECIDED) {#p01-slash-not-route}

**Decision:** `/match`, `/search`, `/ref` are local slash commands — a `LOCAL_SLASH_COMMANDS`
registry entry plus a `slashCommandSurfaces` handler each — with **no** composer-route
changes.

**Rationale:**
- A composer route (`SELECT_COMPOSER_ROUTE`, values `"prompt" | "changes" | "join"`) selects
  what the composer *submits* — a Claude prompt, a commit, a dash join. These commands are
  Tug-side computations invoked from the prompt route; they add no submission mode. (The
  older Code/Shell/btw route table and its `ROUTE_ITEMS` / `ROUTE_PREFIX_ALIAS` /
  `RETURN_ACTION_BY_ROUTE` symbols no longer exist — the argument survives the rework
  intact, but its subject changed and the plan's original phrasing named dead symbols.)
- The slash system is the designed surface for "run local Tug work without a Claude turn,"
  and [L30] makes a registry entry the required shape for a user-invocable command.
- Adding to the registry auto-wires completion (popup + inline), the
  `/name args` parser, submit interception (before the Claude-send gates, so it works
  mid-turn), history, and the "don't forward to Claude" classifier — zero extra edits. None
  of the three names collides with an existing entry; all three do share a first letter with
  live commands (`/model` `/mode` `/memory`; `/shell` `/skills`; `/rewind` `/resume`
  `/rename`), so completion resolves them by the registry's ordinary prefix rules and no
  command gets a single-letter shortcut — do not special-case any of them.
- The exhaustive `Record<LocalCommandName, …>` handler map makes a missing handler a
  compile error, not a silent no-op.

**Implications:**
- Edit `tugdeck/src/lib/slash-commands.ts` (registry) and
  `tugdeck/src/components/tugways/cards/session-card.tsx` (handlers + store construction).
- Handlers take `(args: string, draft?: SlashCommandDraft)`; all three ignore `draft` and
  read only `args`.
- All three declare `takesArgs: true` (they take a query / numbers).
- No `deprecatedFor` alias is needed — these are new names, not renames of retired verbs.
- `/ref` needs no Rust — it is pure frontend resolution against the current refs ([P09]).

#### [P02] One `refs` tugcast feed hosts both match and search (DECIDED) {#p02-one-feed}

**Decision:** A single new feed module `tugcast/src/feeds/refs.rs` with a `REFS_INPUT` /
`REFS_OUTPUT` `SessionScopedFeed` pair runs both operations, selected by a serde-tagged
input enum (`{ type: "match" | "search" | "cancel", … }`), over a shared walk helper.

**Rationale:**
- `match` and `search` share the walk, the skip rules, the `TextRef` result shape, the
  session multiplexing, streaming, cancellation, and the ledger. One feed = one `main.rs`
  wiring block, one dispatcher, one store — far less duplication than two feeds.
- The C++ tools already share `REFS_PATH`; one feed preserves that unity.

**Implications:**
- Follows the shell feed's structure: `SessionScopedFeed::new(FeedId::REFS_OUTPUT, …)`,
  an `mpsc` input channel, a `refs_dispatcher_task`, `register_session_feed` +
  `register_input(FeedId::REFS_INPUT, …)` in `main.rs`, and `pub mod refs;` in
  `feeds/mod.rs`.
- Frontend has one `RefsSessionStore` and one `RefsResultMessage`; `match`/`search` differ
  only by a `kind` field + which body kind the refs block composes for them ([P08]).

#### [P03] Unified `refs` transcript origin, non-context ink (DECIDED) {#p03-refs-origin}

**Decision:** Results render as a new `TurnOrigin` value `"refs"` (addressed `#r{n}`),
excluded from Claude's context exactly like `shell` (`#s`) turns; the only path into
Claude's context is the block's **Share** gesture.

**Rationale:**
- A match/search is the user's own file investigation — the same doctrine that makes shell
  exchanges non-context ink applies verbatim.
- A distinct origin gets its own ordinal counter and addressing letter without disturbing
  `#u`/`#a`/`#s`.

**Implications:**
- `TurnOrigin` in `tugdeck/src/lib/code-session-store/types.ts` gains `"refs"`
  (currently `"user" | "assistant" | "shell"`); add a `RefsResultMessage`
  (`kind: "refs_result"`). The reducer mints a `refs` turn via a `buildRefsTurnEntry` and
  the transcript **skips refs messages inside Claude turns** the same way it skips shell
  messages. The `#r` ordinal is a precomputed `refsRowOrdinal` slot field (mirror
  `shellRowOrdinal` in `session-transcript-data-source.ts`), 1..N within the single
  restored block.
- **Three unions, not one.** Adding a participant touches all of: `Participant` +
  `PARTICIPANT_ICONS` in `tug-transcript-entry.tsx` (already open by design — it carries
  `git` / `reporter` / `operator` alongside `user` / `assistant` / `shell`),
  `SessionTranscriptCellKind` in `session-transcript-data-source.ts`
  (`"user" | "assistant" | "ghost" | "shell"`), and `SessionZ1BParticipant` in
  `session-card-z1b.tsx` (`"user" | "assistant" | "shell"`). The third is easy to miss and
  is a compile error, not a silent gap.
- **Share is `PendingContextStore`, and two of its unions are closed.** There is no
  `SHARE_*` action; the shell block's add-to-context toggle calls
  `pendingContextStore.stage({ source: "shell", ref, label, body })`. Refs parity means:
  `ContextSource` += `"refs"`; the `<tug-context source="(shell|btw)">` `OPEN_RE`
  alternation += `refs` — **this one is a durable format**, since the sentinel travels inside
  the sent user message into the session JSONL and the user-row renderer splits it back out
  on reload, so an unwidened regex means a shared refs block comes back as raw text; the
  binary `n(source)` / `setContext(source)` ternaries gain a `refs` branch (today anything
  that is not `"shell"` silently answers `_btwContext`); and a `composeRefsShareText` beside
  `composeShellShareText` composes the fence-safe body, with `ref` addressed `r{n}` to match
  shell's `s{n}`.
- **The transcript search index needs a refs projection.** `rowSegments` in
  `transcript-search-index.ts` handles `ghost` / `shell` / `user` explicitly and lets
  everything else take the assistant path, which returns `[]` when a descriptor has no
  `messageStart`/`messageEnd` — so a `refs` row would be silently invisible to transcript
  Find (⌘F). That matters more here than for most rows, because #non-goals points the user at
  the deck's `FIND` action as *the* transcript-search surface. Add a `refsSegments`
  projection (the command line, then the ref rows' paths + previews) beside `shellSegments`.

#### [P04] Streaming result frames with cancellation (DECIDED) {#p04-streaming}

**Decision:** The feed emits incremental frames — `refs_started` (run_id, kind, command,
root, started_at), one or more `refs_rows` (a batch of `TextRef`s with their assigned
`#r` numbers), and `refs_complete` (run_id, total, settled_at, `cancelled` flag) — and
accepts a `cancel` input frame that reaps the in-flight run.

**Rationale:**
- The user explicitly wants streaming ("streaming results would be great"). A workspace
  grep is long enough that whole-result posting feels dead; incremental rows feel alive.
- Cancellation is the natural partner (a long/mistaken run must be stoppable), and the
  shell feed already proves the exec/kill shape.

**Implications:**
- `RefsSessionStore` appends rows to the in-flight `RefsResultMessage` as `refs_rows`
  arrive (an [L02] store update, not DOM). The block header pulses while in-flight (reuse
  the shell in-flight header treatment) and shows a Stop affordance dispatching `cancel`.
- `match` uses the same frames (it just streams fast).

#### [P05] Ledger-backed, latest-only, clobber-on-new (DECIDED) {#p05-ledger}

**Decision:** A `tugcast/src/refs_ledger.rs` sqlite ledger stores **only the latest** ref
list per `tug_session_id`; a new completed run overwrites the previous. A `list_refs`
CONTROL read returns it for restore.

**Rationale:**
- Mirrors the C++ `REFS_PATH` — a single file each run overwrote. "Save the latest one
  only; new matches or searches clobber it; just like the filesystem does."
- Restores the last block across Maker ▸ Reload so `/ref N` survives a reload, matching the
  shell ledger's restore contract.

**Implications:**
- **Two gates the clone must not drop.** `ShellLedger::open` opens through
  `tugcore::ledger_db::open` (and `open_in_memory` calls `ledger_db::apply_pragmas`) — the
  `no_ad_hoc_ledger_opens` enforcement test reads the workspace's own production sources and
  fails the build on a bare `Connection::open`, so this is a compile-time-ish requirement, not
  a convention. It also runs `ledger_integrity::integrity_gate(path, "shell")` before opening
  and `salvage_into(…)` after, which quarantines a corrupt file and salvages readable rows;
  `refs_ledger` passes `"refs"` and its own table name. `default_path()` derives from
  `SessionLedger::default_path()` so the db is per-instance when `TUG_INSTANCE_ID` is set.
- Model on `shell_ledger.rs` (`default_path()` → a sibling `refs.db`, `open`/`open_in_memory`,
  a `record_run` that deletes the session's prior rows then inserts the new list, a
  `list_refs(tug_session_id)`), wired through the supervisor for the CONTROL read
  (`supervisor.set_refs_ledger`), and consumed on the frontend like
  `list_shell_exchanges` (a CONTROL send in the store constructor, a `list_refs_ok`
  handler in `action-dispatch.ts` → an `applyRestoredRefs`).

#### [P06] Walk root is always the workspace root (DECIDED) {#p06-root}

**Decision:** Both operations always walk from the card's **workspace root**
(`binding.projectDir`), sent as `root` in the `REFS_INPUT` frame; there is no per-card cwd
tracking and no path argument.

**Rationale:**
- The user chose "always workspace root." It is deterministic, needs no shell-cwd coupling,
  and matches how `FILETREE_QUERY` / `git_diff_request` already carry `root: projectDir`.

**Implications:**
- The store is constructed with `projectDir` (like `ShellSessionStore`) and stamps it on
  every frame; the feed builds `WalkBuilder::new(root)` + `SecretFilter::new(root)` from it.
- No `-C`/path-arg parsing in the flag grammar (Lists L01/L02).

#### [P07] Typed flags are the only source of truth (DECIDED) {#p07-flags-truth}

**Decision:** Command behavior is driven **solely** by getopt-style typed flags parsed from
the query (Lists L01/L02). There is no option cluster and no persisted flag default in this
phase; a chip cluster is a #roadmap follow-on.

**Rationale:**
- Faithful to the C++ tools, scriptable, and — decisively — a *single* source of state.
  A cluster plus persisted defaults plus typed flags is three inputs to one behavior, and
  the precedence rule that reconciles them ("a per-invocation flag wins") is exactly the
  kind of invisible rule that produces a search whose results the user cannot explain.
- The cluster's original mount design leaned on a route-chrome model that no longer exists
  ([P01]); re-designing it against the composer-route model is real work with no bearing on
  whether `/match` and `/search` do their jobs. Deferring it costs the phase nothing and
  lets the commands ship on a contract that will not change when the cluster arrives.
- 2026-08-15 review: raised as a scope call and settled — cut to #roadmap.

**Implications:**
- A shared `refs-flags.ts` parses/normalizes flags for both commands and is the single
  place the submit path reads. It is written to be the cluster's future counterpart too
  (parse *and* emit flag tokens), so the follow-on adds a surface rather than a second
  grammar.
- No tugbank defaults domain is registered in this phase.

#### [P08] Compose the existing body kinds; author no row renderers (DECIDED) {#p08-two-renderers}

**Decision:** One `RefsResultBlock` chrome (header with the command, Share + Copy, pulsing
in-flight state) composes an **existing body kind** by result kind: `PathListBlock` for
`match`, `SearchResultBlock` for `search`, both in `embedded` mode so their action clusters
portal into the refs `BlockChrome`. No refs-specific row component is written.
`SearchResultBlock` gains an **opt-in** click-to-open prop, default off, so `GrepToolBlock`
keeps its current display-only behavior.

**Rationale:**
- These are the same two shapes. `PathListBlock` is already a clickable, annotator-wired,
  middle-ellipsis, sortable, copyable path list; `SearchResultBlock` is already
  grouped-by-file matches with `line` + text and the hit spans highlighted from explicit
  half-open char offsets, with context lines and collapse. Writing `refs-match-row.tsx` and
  `refs-search-row.tsx` would reimplement both, worse, and would leave the transcript with
  two visual languages for one concept — a Grep result and a `/search` result are the same
  thing to a reader and must look it.
- `SearchResultBlock`'s docstring records click-to-open as a *deferred follow-on*, not a
  rejected one. Landing it as an opt-in prop pays that deferral down against a real consumer
  while keeping the blast radius at zero for existing ones — and it is the piece that leaves
  the architecture better than we found it, since `GrepToolBlock` can opt in later with a
  one-line change instead of a design.
- 2026-08-15 review: the original decision predates the body-kinds layer entirely. Composing
  was raised as a scope call and confirmed, with opt-in (not global) interactivity.

**Implications:**
- New view code shrinks to **one** pure module, `refs-result-view.ts`: the numbered flat
  `TextRef` list → `PathListData` (for `match`) or `SearchResultData` (for `search`),
  grouping by file, **joining `root` onto each path so the row is absolute and therefore
  clickable** ([P15]), passing spans through unchanged ([P14]). Unit-testable like
  `shell-exchange-view.ts`. `refs-match-row.tsx`,
  `refs-search-row.tsx`, and a bespoke row chrome are **not** written.
- The flat numbered list stays the ledger's and `/ref`'s truth ([P05], [P09]); grouping is a
  *display* derivation only, so a `#r` number never depends on how rows are grouped.
- The opt-in prop on `SearchResultBlock` is additive and defaulted off. It stamps the
  annotator's `file-path` attributes on a match row (mirroring `PathListBlock`) rather than
  installing a handler — so the block still owns no responder ([L11]) and refs rows open by
  the same route as every other path in the transcript.
- `PathListBlock` needs no change: its rows are already annotated and clickable.
- Both blocks persist component state ([A9] axis) — collapse for `SearchResultBlock`, sort
  for `PathListBlock`. Verify that state survives the streaming upsert ([P13]) rather than
  resetting on every `refs_rows` batch; if it does reset, the turn's mount identity is what
  to fix ([L26]), not the block.

#### [P09] `/ref` resolves numbers against the latest refs, honoring `openTarget` (DECIDED) {#p09-ref-open}

**Decision:** `/ref` parses a number spec — single (`3`), range (`3-5`), and
space-separated list (`3 7 9`), combinable — resolves each against the **latest**
`RefsResultMessage`, and opens each via the existing `open-file` path, honoring the
deck-wide `openTarget` ("open new text files") preference. A range/list is capped
(default 10) with a subdued warning past the cap; an out-of-range number reports a subdued
error and is skipped.

**Rationale:**
- Ports `ref-tool.cpp` (which opened every requested ref). The Tug open path
  (`openFileInCard(store, path, line?, endLine?)`) already honors `openTarget`
  (`reuse`/`newTab`/`new`) and path-keyed reuse — `/ref` should not reinvent card placement.
- A cap prevents `/ref 1-500` from spraying the deck.

**Implications:**
- `/ref` is pure frontend: parse spec → look up the current refs (from the store /
  latest `refs` turn) → `dispatchCommand(TUG_ACTIONS.OPEN_FILE, { path, line?, endLine? })`
  per ref — the identical payload the annotator's `file-path` `primaryClick` sends, so a
  typed `/ref 3` and a click on row 3 are the same event by construction. That identity is
  only real if `/ref` joins `root` onto the ref's relative `path` from the same helper
  `refs-result-view.ts` uses ([P15]) — `openFileInCard` resolves nothing. Search refs pass
  `line` (+ column range once [P10] lands); match refs pass only `path`.

#### [P10] Line-granular reveal first; column-span highlight extends the chain (DECIDED) {#p10-column-highlight}

**Decision:** Clickable refs first reveal **line-granular** in the Text card (works today:
`open-file` → `revealLine(line, endLine?)`); a later step extends the reveal chain
end-to-end to accept a **column range** and paint the exact match span(s) on `search` refs.

**Scoping note:** this is about the **Text card** reveal only. The *in-block* span
highlight — the hit painted inside the transcript row — needs no work at all:
`SearchResultBlock` already renders it from the `spans` the wire carries ([P08], [P14]).
The plan's original framing conflated the two.

**Rationale:**
- Line-granular is production-ready and unblocks the whole vertical slice immediately; the
  column highlight is a self-contained sharpening that touches a known, isolated chain.

**Implications:**
- The column step threads a column range through: the `open-file` payload
  (`action-vocabulary.ts` `OPEN_FILE`, documented today as
  `{ path, line?, endLine? }`), `openFileInCard`'s signature, the `revealOnOpen`
  seed shape + `TextCardOpenEntry.revealLine`/`openFile` (`text-card-open-registry.ts`,
  `text-card.tsx`), and `revealLineFn` in `tug-text-card-editor.tsx` (a `Decoration.mark`
  or a registered `CSS.highlights` range instead of the line-only flash). Respect Risk R04
  (no collapsed-range wash).
- The annotator is on this path too: `file-path` payloads carry `line`/`endLine` only, so a
  column range means extending `FilePathPayload` + `openTargetFor` in
  `tugdeck/src/lib/annotator/registry.ts` / `payloads.ts` — or, if that widening is
  unwelcome, having the refs row dispatch `OPEN_FILE` directly for the column case. Decide
  at #step-11 with the annotator's shape in hand; prefer extending the payload, since every
  other file reference in the transcript would gain the same sharpening for free.

#### [P11] Flag set, defaults, and skip model per tool (DECIDED) {#p11-flags}

**Decision:** Port the flags in Lists L01 (`match`) and L02 (`search`) with the C++
defaults preserved (they differ deliberately by tool); drop the CLI-only flags per
#non-goals. The skip model is gitignore + `SecretFilter` (never bypassed); `-a`/`-s`
descend into gitignored paths only ([Q02]). `match` is deterministic (substring / exact /
glob), not fuzzy.

**Rationale:**
- "The differences between the programs serve their different purposes" — `match` defaults
  case-**insensitive** (quick filename lookup), `search` defaults case-**sensitive** (precise
  code grep); preserving that respects muscle memory.

**Implications:** see Lists L01/L02 and #semantics.

#### [P12] Emission-order, stable `#r` numbering (DECIDED) {#p12-numbering}

**Decision:** `#r{n}` numbers are assigned in the order rows are emitted and never
renumbered; within a single file, that file's matches are sorted by (line, column).

**Rationale:**
- Streaming ([P04]) precludes a global pre-sort. Stable emission-order numbering keeps
  `/ref N` well-defined. A documented divergence from the C++ global sort.

**Implications:** the feed assigns numbers as it emits `refs_rows`; the store trusts the
server's numbers; `/ref` indexes the accumulated list by those numbers. Grouping rows by
file for display ([P08]) never renumbers them — the number is on the `TextRef`, not on its
position in the rendered list.

#### [P14] Wire offsets are 0-based half-open; lines are 1-based (DECIDED) {#p14-offsets}

**Decision:** A `TextRef`'s `columns` are **0-based, half-open `[start, end)` char offsets**
into the matched line's text. Its `line` is **1-based**.

**Rationale:**
- `SearchResultBlock`'s `SearchResultSpan` is exactly `readonly [start: number, end: number)`,
  0-based half-open into the match line's `text`, and it clamps / drops zero-width / merges
  overlapping spans defensively at render. Emitting that shape verbatim means the wire feeds
  the renderer with no adaptation layer — and an adaptation layer is precisely where an
  off-by-one hides.
- 1-based `line` is already the convention on every consumer: `SearchResultMatch.line`,
  `revealLine`, `openFileInCard`'s `line`, and the annotator's `data-line`.
- The C++ `+1` column bias is display formatting for a terminal that printed
  `path:line:column`. Tug prints no column, so importing the bias would buy nothing and cost
  a highlight that sits one character right on every hit ([Q05]).

**Implications:**
- Rust computes spans as byte-safe **char** offsets, not byte offsets — a non-ASCII line
  would otherwise highlight the wrong run. The unit tests must include a multi-byte fixture;
  this is the single most likely silent defect in the port.
- The store passes `columns` straight through to `SearchResultData`; `refs-result-view.ts`
  does not transform them.

#### [P13] Generalize the ink-turn insertion machinery for shell + refs (DECIDED) {#p13-ink-insertion}

**Decision:** The transcript-insertion helpers that today special-case shell turns —
`appendTurnInterleavingShell` and `upsertShellTurn` in
`tugdeck/src/lib/code-session-store/reducer.ts` (run via the store wrapper's
`append-transcript` / `ingest-shell-turn` effects, NOT inside the reducer) — are
**generalized to treat `refs` as an "ink" origin alongside `shell`** (i.e. the origin
predicate becomes `origin === "shell" || origin === "refs"`), rather than being
duplicated per origin.

**Rationale:**
- Both helpers do exactly what `refs` needs and both currently hardcode `origin === "shell"`:
  - `upsertShellTurn` replaces the turn with the same `turnKey` in place (mint → settle,
    preserving mount identity / row position) — this is precisely the **streaming
    upsert** a `refs` turn needs as each `refs_rows` batch updates the same in-flight
    turn ([P04]).
  - `appendTurnInterleavingShell` slides a newly appended non-ink (Claude) turn left past
    a run of *trailing ink turns* whose timestamp is greater — the **reload race** where a
    ledger restore (here `list_refs`) lands before the JSONL replay ([P05], Risk R05).
    A live `refs` turn, if treated as a *non-ink* turn, would be wrongly slid left past
    trailing shell turns; treating it as ink fixes both directions.
- Generalizing (not copying) leaves "non-context ink origin" as one reusable category —
  a strictly better foundation for any future ink origin than a second shell-shaped copy.

**Implications:**
- `upsertShellTurn` → an ink-origin upsert (or a shared `upsertInkTurn`) that `ingestRefs`
  routes streaming updates through; `appendTurnInterleavingShell`'s trailing-walk predicate
  includes `refs`. The reducer's existing shell skip (`if (message.kind === "shell_exchange") continue;`)
  gains a sibling `refs_result` skip.
- These are pure helpers on `_transcript` in the store wrapper — the same layer, no reducer
  state changes.
- **A third ink predicate lives outside the reducer:** `countClaudeTurns` in
  `tugdeck/src/components/tugways/cards/session-load-control-bar-state.ts` computes the
  metadata row's `X of Y` as `transcript.reduce((n, t) => t.origin === "shell" ? n : n + 1)`
  — its own docstring says counting ink rows reads a shell-heavy session as "83 of 68".
  A `refs` turn would be counted as a Claude turn and produce exactly that lie. Generalize
  this predicate in lockstep (an exported `isInkOrigin(origin)` the reducer, the data
  source, and this counter all read is the shape that keeps three copies from drifting).

#### [P15] Rows carry absolute paths; the wire stays relative (DECIDED) {#p15-absolute-paths}

**Decision:** The wire and the ledger keep `path` **relative to `root`** (#wire-frames), and
`refs-result-view.ts` joins `root` back on, so every path handed to a body kind — and every
path `/ref` dispatches — is **absolute**.

**Rationale:**
- Clickability depends on it. `PathListBlock` annotates a row **only when the path is
  absolute** (`const annotated = path.startsWith("/")`; a relative path is deliberately left
  un-annotated rather than guessed at), so a relativized `/match` row would render with no
  `data-tug-annotation` at all and silently fail Spec S02, Spec S05 and #success-criteria —
  a defect no unit test on the derivation would catch.
- The annotator's contract agrees: `FilePathPayload.path` is documented as the *absolute
  canonical* path, `openTargetFor` forwards it to `OPEN_FILE` unchanged, and `openFileInCard`
  does no root resolution. There is no layer below the row that could re-absolutize.
- This is also what the transcript already looks like: `GlobToolBlock` feeds `PathListBlock`
  the Glob tool's absolute filenames, and `MiddleEllipsisPath` is what makes them readable.
  A refs row and a Glob row must not differ.
- Keeping the *wire* relative is still right — `root` is the frame's own field, the ledger
  row stays portable, and the C++ tools reported relative paths.

**Implications:**
- `refs-result-view.ts` takes `root` as an argument and emits absolute `PathListData.paths` /
  `SearchResultFile.path`. Its unit test asserts absolutization (not relativization) and that
  a row's `data-path` is absolute.
- `/ref` ([P09]) resolves against the flat `TextRef` list, whose `path` is relative — it joins
  `root` before dispatching `OPEN_FILE`, from the same helper the view uses, so a typed
  `/ref 3` and a click on row 3 cannot diverge.
- The restore path ([P05], #step-9) needs `root` at ingest time; `RefsSessionStore` already
  holds `projectDir` ([P06]), so it stamps it onto the restored message rather than relying on
  the ledger row.

---

### Deep Dives {#deep-dives}

#### End-to-end data flow {#data-flow}

```
/search foo -i         (prompt entry)
  → performSubmit: matchLocalSlashCommand → RUN_SLASH_COMMAND {name:"search", args:"foo -i"}
  → session-card.tsx slashCommandSurfaces.search(args, draft?)
  → RefsSessionStore.run("search", args)         (parse flags via refs-flags.ts)
  → conn.send(FeedId.REFS_INPUT, {type:"search", tug_session_id, run_id, root, needles, flags})
  → [Rust] refs_dispatcher_task → per-session actor
       walk(root)  (ignore::WalkBuilder + SecretFilter)  → rayon scan (regex) 
       → emit refs_started / refs_rows* / refs_complete  on REFS_OUTPUT (session-scoped)
       → on complete: refs_ledger.record_run(tug_session_id, run_id, rows)   (clobber)
  → RefsSessionStore._fold(frame) → CodeSessionStore.ingestRefs(...)
  → reducer buildRefsTurnEntry → a "refs"-origin TurnEntry (one RefsResultMessage)
  → session-card-transcript RefsTurnCell → RefsResultBlock
       → refs-result-view: TextRef[] → PathListData | SearchResultData
       → PathListBlock (match) | SearchResultBlock (search), both `embedded`
  → row carries the annotator's file-path attrs; delegated click →
    dispatchCommand(OPEN_FILE {path,line?,endLine?}) → openFileInCard → Text card
  → `/ref N` dispatches the same OPEN_FILE payload
```

Restore: `RefsSessionStore` constructor sends a `list_refs` CONTROL frame; the
`list_refs_ok` response (handled in `action-dispatch.ts`) → `applyRestoredRefs` re-ingests
the latest run as a `refs` turn.

#### Wire frames (contract) {#wire-frames}

Input (`REFS_INPUT`, serde-tagged, snake_case on the wire):
- `{ "type":"match",  "tug_session_id", "run_id", "root", "needles":[…], "flags":{ any, exact, dirs, case_sensitive, first_only } }`
- `{ "type":"search", "tug_session_id", "run_id", "root", "needles":[…], "replacement":null, "flags":{ any, regex, case_insensitive, all_files, per_line } }`
- `{ "type":"cancel", "tug_session_id", "run_id" }`

Output (`REFS_OUTPUT`, session-scoped; `tug_session_id` spliced in by the feed):
- `{ "type":"refs_started",  "run_id", "kind":"match|search", "command", "root", "started_at" }`
- `{ "type":"refs_rows",     "run_id", "rows":[ TextRef, … ] }`  (streamed batches)
- `{ "type":"refs_complete", "run_id", "total", "cancelled":bool, "settled_at" }`

`TextRef` (wire): `{ "index":u32, "path":string, "line":u32|null, "columns":[[start,end],…], "preview":string|null }` — `match` rows carry `line:null`, empty `columns`, `preview:null`; `search` rows carry `line`, one-or-more `columns` (merged per line unless `-l`), and the matched-line `preview`.

`line` is **1-based**; `columns` are **0-based half-open `[start, end)` char offsets** into
`preview` ([P14]) — the exact shape `SearchResultBlock`'s `SearchResultSpan` consumes.
`path` is relative to `root` **on the wire and in the ledger only** — `refs-result-view.ts`
joins `root` back on before a path reaches a body kind or `OPEN_FILE`, because a relative
path is not clickable ([P15]). `preview` is the full matched line, untruncated: the block
renders and ellipsizes, and a pre-truncated line would make the offsets lie.

CONTROL: `list_refs` request `{ action:"list_refs", tug_session_id }` → `list_refs_ok`
`{ run_id, kind, command, rows:[TextRef,…] }` (the latest run only).

---

### Specification {#specification}

**Spec S01: Terminology** {#s01-terminology}

- **TextRef** — a numbered file reference: `index` (`#r{n}`), `path` (relative to `root`),
  optional 1-based `line`, zero-or-more 0-based half-open column spans, optional
  matched-line `preview` ([P14]).
- **Ref list** — the ordered TextRefs of one run; the *latest* run's list is "the current
  refs" that `/ref` resolves against and the ledger stores.
- **run_id** — a per-run identifier (assigned by the store) used to fence streaming frames
  and the ledger clobber ([P12], Risk R05).

**Spec S02: `/match` behavior** {#s02-match}

- `/match <needle>…` walks the workspace root, gitignore + `SecretFilter` applied, and
  emits a TextRef (`line:null`) for each **file** whose filename matches. Default: all
  needles must match (AND), case-insensitive substring, files only. Flags per List L01.
- Fast enough to stream to completion near-instantly; rows are clickable and open the file.

**Spec S03: `/search` behavior** {#s03-search}

- `/search <needle>…` walks the workspace root, reads each candidate text file (UTF-8
  gate, size cap), and emits a TextRef per matching **line** (merged spans; `-l` splits),
  carrying `line`, column spans, and the line `preview`. Default: all needles on a line
  (AND), case-sensitive, string search; `-e` = regex. Flags per List L02. Streams
  incrementally; cancellable; invalid regex → zero results + notice.

**Spec S04: `/ref` behavior** {#s04-ref}

- `/ref <spec>` where `<spec>` is any mix of `N`, `A-B`, and space-separated numbers.
  Resolves against the latest ref list; opens each ref via `open-file` honoring
  `openTarget`; caps at 10 with a subdued warning; out-of-range → subdued error, skipped.
  `search` refs open at `line` (+ column span once [P10] lands); `match` refs open at the
  file top.

**Spec S05: Clickable rows** {#s05-rows}

- Every result row is a clickable file reference **via the content annotator**, not a
  bespoke component: the row stamps `ANNOTATION_CLASS` (`tugx-annotation`) +
  `data-tug-annotation="file-path"` + `data-path` (+ `data-line` for `search`) +
  `data-tug-focus="refuse"` + `data-no-activate`, and the transcript's delegated layer
  supplies the click (`OPEN_FILE` with `{ path, line?, endLine? }`) and the context menu
  (Open in Editor / Show in Finder / Copy Path). The row owns no handler and no responder
  ([L11]), which is why a refs row opens exactly the way a path written in assistant prose
  does. `PathListBlock` already does this; `SearchResultBlock` gains it behind the opt-in
  prop ([P08]). `data-path` is **absolute** — `PathListBlock` annotates only absolute paths
  and the annotator payload is contractually absolute ([P15]).

**Spec S06: Non-context ink + Share** {#s06-ink}

- `refs` turns are `#r`-addressed and excluded from Claude context (skipped inside Claude
  turns, like `shell`). The block's **Share** affordance is the only path that surfaces a
  result into Claude's context: an add-to-context toggle staging a `<tug-context
  source="refs" ref="r{n}">`-wrapped body on the `PendingContextStore`, which rides the next
  `❯` submission and is split back out of the JSONL on reload ([P03]).

**Spec S07: Latest-only persistence** {#s07-persistence}

- Only the latest run persists (per `tug_session_id`); a new completed run clobbers it. A
  card reload restores exactly that run as a `refs` turn.

**List L01: `/match` flags & defaults** {#l01-match-flags}

- Default: case-insensitive, **substring**, **AND** (all needles), files only.
- `-a` — any needle (OR) instead of all.
- `-e` — exact filename match (whole basename).
- `-d` — include directories as candidates.
- `-s` — case-sensitive.
- `-1` — stop at the first match.
- Glob patterns in a needle are honored via the **`glob` crate**, which is already a direct
  dependency of `tugcast` (`glob = { workspace = true }`) — `glob::Pattern::matches` over
  the basename. No `Cargo.toml` edit is needed. (The plan originally called for adding
  `globset` as a new direct workspace dep; that was written before checking, and `glob` is
  both present and sufficient for basename patterns. Reach for `globset` only if a needle
  must match a multi-segment path pattern, which List L01 does not ask for.)
- **Dropped:** `-c -f -o -p -r` (subsumed by the Tug model, #non-goals).

**List L02: `/search` flags & defaults** {#l02-search-flags}

- Default: case-**sensitive**, **string** search, **AND** (all needles on a line), merged
  spans per line, gitignore + `SecretFilter` skip.
- `-i` — case-insensitive.
- `-e` — needles are regexes (`regex` crate).
- `-y` — any needle (OR) instead of all.
- `-a` (alias `-s`) — descend into gitignored paths too; `SecretFilter` still applies
  ([Q02]).
- `-l` — one row per match (no per-line merge).
- **Dropped:** `-c -t -r -n` (color/terse subsumed; replace/dry-run deferred, #non-goals).

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `RefsSessionStore` snapshot (in-flight run, live, run_id) | structure/local-data | store `subscribe`/`getSnapshot` + `useSyncExternalStore` | [L02] |
| Refs result rows (the `refs` `TurnEntry` + streamed appends) | local-data | `CodeSessionStore` reducer + `useSyncExternalStore` | [L02] |
| `#r` ordinal | local-data | precomputed `refsRowOrdinal` slot field in `session-transcript-data-source.ts` (single-pass, mirror `shellRowOrdinal`) | [L02] |
| Row click → `open-file` | structure | annotator `file-path` `primaryClick` → `dispatchCommand(OPEN_FILE)`; the row owns no handler; the row's `data-path` is absolute ([P15]) | [L11], [L30] |
| Staged-for-Claude share items | local-data | `PendingContextStore` `subscribe`/`getSnapshot` (existing) + a `refs` `ContextSource` | [L02] |
| In-flight pulsing header / Stop affordance | appearance | CSS/DOM `data-state`, no React state | [L06] |
| In-block match-span highlight | appearance | `SearchResultBlock`'s existing CSS runs from `spans` — nothing new | [L06] |
| Text-card line flash / column-span highlight | appearance | CM6 decoration / `CSS.highlights` imperative | [L06] |
| `SearchResultBlock` file collapse, `PathListBlock` sort | local-data | the blocks' own React state, persisted on the [A9] component-state axis | [L06], [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/refs.rs` | The `refs` feed: `RefsInput` enum, `refs_dispatcher_task`, per-session actor, streaming emit, cancel; hosts `match` + `search` ops. ([P02], [P04]) |
| `tugrust/crates/tugcast/src/feeds/walk.rs` | Shared gitignore + `SecretFilter`-aware walk helper lifted from `file_watcher.rs`; skip predicates. ([P06], [Q02]) |
| `tugrust/crates/tugcast/src/feeds/text_ref.rs` | `TextRef` data model + (de)serialization; column-span type. |
| `tugrust/crates/tugcast/src/refs_ledger.rs` | Latest-only sqlite ledger (`refs.db`); `record_run` (clobber) + `list_refs`. ([P05]) |
| `tugdeck/src/lib/refs-session-store.ts` | Per-card store driving `REFS_INPUT`; `run(kind,args)`, `cancel()`, `_fold` → `ingestRefs`; restore via `list_refs`. |
| `tugdeck/src/lib/refs-flags.ts` | Shared getopt-style flag parser/normalizer for `/match` + `/search` (Lists L01/L02); consumed by the store. Written to emit tokens as well as parse them, for the deferred cluster ([P07]). |
| `tugdeck/src/components/tugways/cards/refs-result-block.tsx` (+ `.css`) | Refs block chrome (header, Share, Copy, in-flight pulse) composing `PathListBlock` / `SearchResultBlock` `embedded`. [L19]/[L20] conformant. ([P08]) |
| `tugdeck/src/components/tugways/cards/refs-result-view.ts` | Pure derivation: `TextRef[]` → `PathListData` \| `SearchResultData` (group by file, join `root` so paths are absolute and clickable, pass spans through) + the `root`-join helper `/ref` shares — unit-tested. ([P08], [P14], [P15]) |

**Deliberately not created** (the plan's original four-file view layer): `refs-match-row.tsx`,
`refs-search-row.tsx`, and `refs-option-cluster.tsx`. The first two are `PathListBlock` /
`SearchResultBlock` ([P08]); the third is deferred to #roadmap ([P07]).

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `pub mod refs; pub mod walk; pub mod text_ref;` | mod decls | `tugcast/src/feeds/mod.rs` | register new modules |
| `mod refs_ledger;` + wiring | mod + wiring | `tugcast/src/main.rs` | clone the shell block: feed, `mpsc`, dispatcher spawn, `register_session_feed`/`register_input`, `set_refs_ledger` |
| `REFS_OUTPUT` / `REFS_INPUT` FeedIds | const | `tugdeck/src/protocol.ts` **and** `tugcast_core::protocol` | `0x62`/`0x63` — re-verified free 2026-08-15 (`SHELL_*` = `0x60`/`0x61`, next allocated is `GAZETTE` `0x70`). `protocol.rs` carries a byte-value assertion test; extend it. |
| `CONTROL_ACTION_LIST_REFS = "list_refs"` | const | `tugdeck/src/protocol.ts` + tugcast supervisor | restore read |
| `set_refs_ledger` / `list_refs` handling | fn | tugcast supervisor (`agent_supervisor.rs`) | mirror `set_shell_ledger` + `list_shell_exchanges` |
| `TurnOrigin` += `"refs"` | type | `tugdeck/src/lib/code-session-store/types.ts` | new origin |
| `RefsResultMessage` (`kind:"refs_result"`) | interface | `tugdeck/src/lib/code-session-store/types.ts` | one per `refs` turn; carries `runId, opKind, command, refs[], inFlight, cancelled` |
| `ingestRefs(...)` | method | `tugdeck/src/lib/code-session-store.ts` | mirror `ingestShellExchange`; started/rows/complete actions |
| `buildRefsTurnEntry` + reducer actions + Claude-turn skip | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | mirror `buildShellTurnEntry` + the shell skip |
| `refsRowOrdinal` | slot field | `tugdeck/src/lib/session-transcript-data-source.ts` | precomputed single-pass (mirror `shellRowOrdinal`), 1..N within the restored block |
| `upsertShellTurn` → ink upsert, `appendTurnInterleavingShell` predicate | fn | `tugdeck/src/lib/code-session-store/reducer.ts` | generalize to `shell`+`refs` ink origins ([P13]); streaming upsert + reload interleave. Both still exist under these names, applied by the store wrapper in `code-session-store.ts`. |
| `countClaudeTurns` predicate | fn | `tugdeck/src/components/tugways/cards/session-load-control-bar-state.ts` | the third ink predicate ([P13]) — excludes `origin === "shell"` only; a `refs` turn would inflate the `X of Y` metadata figure. Generalize with the other two (a shared `isInkOrigin`) |
| `refsSegments` + `rowSegments` branch | fn | `tugdeck/src/lib/transcript-search-index.ts` | project refs rows for transcript Find; without it a `refs` descriptor falls to the assistant path and yields `[]` — **silently** unsearchable ([P03]) |
| `ContextSource` += `"refs"`, `OPEN_RE` alternation, `n`/`setContext` branches | type + fn | `tugdeck/src/lib/pending-context-store.ts` | the Share path ([P03]). `OPEN_RE` is a **durable format** — the sentinel lands in the session JSONL and is re-split on reload |
| `composeRefsShareText` + block staged/toggle wiring | fn + props | beside `composeShellShareText`; `session-card-transcript.tsx` | fence-safe share body + the add-to-context toggle, `ref` addressed `r{n}` ([P03]) |
| `Participant` union + `PARTICIPANT_ICONS` | type + registry | `tug-transcript-entry.tsx` | add `"refs"` + a gutter glyph — the union is open by design and already carries `git`/`reporter`/`operator` |
| `SessionTranscriptCellKind` | type | `tugdeck/src/lib/session-transcript-data-source.ts` | add `"refs"` to `"user"\|"assistant"\|"ghost"\|"shell"` |
| `SessionZ1BParticipant` | type | `tugdeck/src/components/tugways/cards/session-card-z1b.tsx` | add `"refs"` — a **third** participant union, easy to miss |
| `RefsTurnCell` | component | `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` | mirror `ShellTurnCell`; participant `"refs"`, identifier, `#r` badge |
| `interactive` / `onOpenMatch` opt-in prop | prop | `tugdeck/src/components/tugways/body-kinds/search-result-block.tsx` (+ `.css`) | default **off**; when on, match rows stamp the annotator's `file-path` attrs. `GrepToolBlock` unchanged. Update the docstring's "does NOT do" clause, which currently records this as deferred. ([P08]) |
| `LOCAL_SLASH_COMMANDS` += match/search/ref | const | `tugdeck/src/lib/slash-commands.ts` | `{ name, description, takesArgs:true }` ×3 |
| `slashCommandSurfaces` += match/search/ref | handlers | `tugdeck/src/components/tugways/cards/session-card.tsx` | signature `(args: string, draft?: SlashCommandDraft) => void`; call `refsSessionStore.run(...)` / `.resolveRefs(...)` |
| `RefsSessionStore` construction | wiring | `tugdeck/src/lib/card-services-store.ts` / `use-session-card-services.ts` | build with `tugSessionId` + `projectDir` (beside `new ShellSessionStore(…)`) |
| `OPEN_FILE` payload + `openFileInCard` + reveal chain | types/fns | `action-vocabulary.ts`, `open-file-in-card.ts`, `text-card-open-registry.ts`, `text-card.tsx`, `tug-text-card-editor.tsx` | column-range extension (#step-11) |
| `FilePathPayload` + `openTargetFor` | type + fn | `tugdeck/src/lib/annotator/payloads.ts`, `…/annotator/registry.ts` | column-range extension (#step-11) — carries `line`/`endLine` only today |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Unit (Rust)** | `match` op (substring/exact/glob, AND/OR, case, dirs), `search` op (string/regex, case, multi-needle, merge/`-l`, spans **including a multi-byte/non-ASCII line**, [P14]), `walk` skip (gitignore + secret + `-a`), `refs_ledger` (clobber + `list_refs`) | Core logic + edge/error paths |
| **Unit (TS)** | `refs-flags.ts` parsing (Lists L01/L02, defaults, unknown flags), `refs-result-view.ts` derivation (grouping, relativization, spans passed through untouched), `/ref` spec parsing (single/range/list, cap, out-of-range) | Pure logic on real strings |
| **App-test** | Drive the real Session card: `/match`, `/search` (streaming rows), row-click opens a Text card at line, `/ref 3-5`, cancel, reload-restore | End-to-end behavior |
| **Build** | `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build` | Before "done" |

**App-test conventions.** Every new `*.test.ts` declares `@covers` lines in its header
docblock naming the sources it exercises — `just app-test-covers-check` fails on a missing
or unresolvable declaration. Run the derived selection (`just app-test-changed`) or name
files explicitly; never sweep the corpus. Read the recipe's printed report bare — never pipe
it.

#### What stays out of tests {#test-non-goals}

- No mock-store or jsdom render tests (banned) — search/flag logic is tested on real
  strings; UI via the derived app-test selection.
- No screenshot pixel-diff of the reveal flash / column highlight — assert range/attribute
  state (WebKit collapsed-range wash gotcha, Risk R04).
- Search-and-replace paths — not built (#non-goals), nothing to test.
- No re-testing of `PathListBlock` / `SearchResultBlock` internals (sort, collapse,
  middle-ellipsis, span-run splitting) — they carry their own suites. This plan tests the
  **derivation into** their data shapes and the **opt-in click** it adds, nothing else.
- The option cluster — not built (#non-goals, [P07]).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Commit on `main` (repo policy — the user commits).
> Each step is a slice; most are runnable in the live-HMR app (Rust steps run via nextest).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Shared walk helper + `TextRef` model + `match` op (pure Rust) | done | `b6bdda667` |
| #step-2 | `search` op — content grep (pure Rust) | done | `fbcfb2e80` |
| #step-3 | `refs` feed — wiring, streaming, cancel | done | `1187f1f65` |
| #step-4 | `refs_ledger` — latest-only + `list_refs` | done | `879a828ec` |
| #step-5 | Frontend protocol + `RefsSessionStore` + `refs` origin | done | `2d277928b` |
| #step-6 | Refs block chrome composing the body kinds + clickable refs | done | `4b6f3093e` |
| #step-7 | `/match` + `/search` slash commands + typed flags | done | `e188528dd` |
| #step-8 | `/ref` resolution + multi-open honoring `openTarget` | done | `17ec1a49c` |
| #step-9 | Reload restore via the ledger | done | `5aac13023` |
| #step-10 | Integration checkpoint (core vertical slice) | done | `3d5866bfd` |
| #step-11 | Column-span highlight for `search` refs (Text card) | done | `7404c0a43` |
| #step-12 | Final integration checkpoint | done | `7404c0a43` |

#### Step 1: Shared walk helper + `TextRef` model + `match` op (pure Rust) {#step-1}

**Commit:** `refs(rust): shared gitignore walk + TextRef model + match filename op`

**References:** [P02] One-feed, [P06] Workspace root, [P11] Flags/skip, [P12] Numbering,
Spec S02, List L01, ([Q02] skip model, #wire-frames)

**Artifacts:**
- `tugcast/src/feeds/walk.rs` — a reusable `walk_files(root, opts) -> impl Iterator`
  built on `ignore::WalkBuilder` (`.git_ignore(true)`, `.hidden(false)`, `require_git(false)`,
  `.git`-skip), applying `SecretFilter::new(root)`; an `include_gitignored` option for
  `-a`/`-s`; optional `include_dirs`. Factor from `file_watcher.rs`'s `walk_with_cap`.
- `tugcast/src/feeds/text_ref.rs` — `TextRef { index, path, line: Option<u32>, columns: Vec<(u32,u32)>, preview: Option<String> }` + serde.
- `match` op in `tugcast/src/feeds/refs.rs` (op fn, feed wiring comes in #step-3):
  `run_match(root, needles, MatchFlags) -> Vec<TextRef>` — substring/exact/glob filename
  match, AND/OR, case per flags, dirs per `-d`, `-1` stop-at-first.
- `pub mod walk; pub mod text_ref; pub mod refs;` in `feeds/mod.rs`.

**Tasks:**
- [ ] Glob needles use the `glob` crate (`glob::Pattern`), already a direct `tugcast`
      dependency — **no `Cargo.toml` edit** (List L01).
- [ ] Lift the `WalkBuilder` setup into `walk.rs`; keep `WALK_CAP`; apply `SecretFilter`
      always; add `include_gitignored`.
- [ ] Implement `run_match` with List L01 semantics; default case-insensitive substring, AND.
- [ ] Relativize emitted paths against `root` via `PathResolver` conventions.

**Tests:**
- [ ] Unit: substring vs exact vs glob; AND vs `-a`; case default vs `-s`; `-d` includes a
      dir; `-1` stops; a gitignored file is skipped without `-a` and included with it; a
      `SecretFilter` denylisted path (`.env`) is **never** emitted even with `-a`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` passes; `cargo build` clean (no warnings).

---

#### Step 2: `search` op — content grep (pure Rust) {#step-2}

**Depends on:** #step-1

**Commit:** `refs(rust): search content-grep op (string/regex, rayon, merged spans)`

**References:** [P04] Streaming (op returns per-file batches), [P11] Flags, [P12] Numbering,
[P14] Offsets, Spec S03, List L02, Risk R01, Risk R02, Risk R03, ([Q03] merge, [Q05] offsets)

**Artifacts:**
- `search` op in `refs.rs`: `scan_file(path, needles, SearchFlags) -> Vec<TextRef>` reading
  via the `fs_read` UTF-8/size-gated pattern; string search (default) or `regex` (`-e`);
  case per `-i`; AND (default) / `-y` any across needles on a line; merge spans per line
  unless `-l`; compute `line`, column `spans`, and the line `preview`.
- A `run_search(root, needles, flags) -> impl ParallelIterator`/callback that walks via
  `walk.rs` and scans files with `rayon`, yielding per-file `Vec<TextRef>` batches (feed
  consumes them in #step-3).

**Tasks:**
- [ ] Implement per-file scan with List L02 semantics; guard `Regex::new` (invalid → empty,
      no panic); skip non-UTF-8 and oversized files.
- [ ] Merge multiple matches on a line into one `TextRef` with multiple spans; `-l` splits.
- [ ] Parallelize file scans with `rayon`; keep each file's matches sorted by (line, col).
- [ ] Emit spans as **0-based half-open char offsets** into the untruncated matched line, and
      `line` **1-based** ([P14]). Compute in char indices, not byte indices.

**Tests:**
- [ ] Unit: string vs `-e` regex; `-i` case; AND vs `-y`; merged spans vs `-l`; multi-needle
      on one line; invalid regex → zero + no panic; binary file skipped; correct
      `line`/`columns`/`preview` on a known fixture.
- [ ] Unit: a **non-ASCII line** (multi-byte chars before the hit) yields char offsets that
      index the right run of the line — the port's likeliest silent defect ([P14]).

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` passes; `cargo build` clean.

---

#### Step 3: `refs` feed — wiring, streaming, cancel {#step-3}

**Depends on:** #step-2

**Commit:** `refs(rust): REFS feed — dispatcher, streaming frames, cancellation`

**References:** [P02] One-feed, [P04] Streaming, [P12] Numbering, Risk R01, Risk R05,
(#wire-frames, #data-flow)

**Artifacts:**
- `RefsInput` serde-tagged enum (`match`/`search`/`cancel`) + `refs_dispatcher_task` +
  per-session actor in `refs.rs`, cloned from `shell.rs`'s dispatcher/actor shape.
- Streaming emit of `refs_started` / `refs_rows` (batched) / `refs_complete`; assign
  `#r` indices in emission order ([P12]); a `run_id` fence; `cancel` reaps the run.
- **Actor run policy:** a new `match`/`search` for a session **cancels-and-replaces** any
  in-flight run for that same session (rather than queuing) — the ledger is latest-only
  ([P05]), so a superseded run's results would be clobbered anyway; the prior run's
  `run_id` is fenced off and its `refs_complete` is dropped (Risk R05).
- `main.rs` wiring: `SessionScopedFeed::new(FeedId::REFS_OUTPUT, …)`, `mpsc` input channel,
  `refs_dispatcher_task` spawn, `register_session_feed(&refs_output_feed)`,
  `register_input(FeedId::REFS_INPUT, refs_input_tx)`.
- `REFS_OUTPUT`/`REFS_INPUT` FeedId constants in `tugcast_core::protocol` and
  `tugdeck/src/protocol.ts`. **Re-verified free 2026-08-15:** `0x60`/`0x61` are
  `SHELL_OUTPUT`/`SHELL_INPUT` and the next allocated value is `0x70` (`GAZETTE`), so
  `0x62`/`0x63` are open. (`protocol.rs` also carries `JOTS = 0xA0`, allocated since this
  plan was written — no bearing on `0x62`/`0x63`.)

**Tasks:**
- [ ] Add the FeedIds `REFS_OUTPUT = 0x62` / `REFS_INPUT = 0x63` in `tugcast_core::protocol`
      and mirror in `protocol.ts`; extend the existing byte-value assertion test in
      `protocol.rs` to cover both.
- [ ] Implement the dispatcher/actor; stream `match` (fast) and `search` (rayon) through the
      same frames; fence late frames by `run_id`; handle `cancel`; a new run for a live
      session cancels-and-replaces the prior in-flight run.

**Tests:**
- [ ] Rust integration (feed-level): a `search` request over a temp tree emits
      `refs_started` → `refs_rows` (monotonic `#r`) → `refs_complete`; a `cancel` mid-run
      yields `refs_complete{cancelled:true}`.

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` passes; `cargo build` clean.

---

#### Step 4: `refs_ledger` — latest-only + `list_refs` {#step-4}

**Depends on:** #step-3

**Commit:** `refs(rust): latest-only refs ledger + list_refs control read`

**References:** [P05] Ledger, Spec S07, (#wire-frames)

**Artifacts:**
- `tugcast/src/refs_ledger.rs` cloned from `shell_ledger.rs`: `default_path()` → sibling
  `refs.db`, `open`/`open_in_memory`, schema (one run per session: `tug_session_id`
  primary-ish key, `run_id`, `op_kind`, `command`, serialized `rows`), `record_run`
  (delete prior rows for the session, insert the new list), `list_refs(tug_session_id)`.
- `main.rs`: build the ledger (like `shell_ledger`), pass to the dispatcher (record on
  `refs_complete`, skip if cancelled) and `supervisor.set_refs_ledger`.
- Supervisor `list_refs` CONTROL handler returning `list_refs_ok`.

**Tasks:**
- [ ] Open through `tugcore::ledger_db::open` (+ `apply_pragmas` for the in-memory ctor) and
      run `ledger_integrity::integrity_gate(path, "refs")` / `salvage_into` around it, exactly
      as `ShellLedger::open` does — a bare `Connection::open` fails the workspace's
      `no_ad_hoc_ledger_opens` enforcement test ([P05]).
- [ ] Implement clobber-on-complete; do not persist cancelled runs.
- [ ] Wire the CONTROL read through the supervisor.

**Tests:**
- [ ] Unit: `record_run` twice for one session leaves only the latest; `list_refs` returns
      it; a different session is unaffected.

**Checkpoint:**
- [ ] `cargo nextest run -p tugcast` passes; `cargo build` clean.

---

#### Step 5: Frontend protocol + `RefsSessionStore` + `refs` origin {#step-5}

**Depends on:** #step-3

**Commit:** `refs(deck): REFS protocol, RefsSessionStore, refs turn origin + ingest`

**References:** [P02] One-feed, [P03] Refs-origin, [P04] Streaming, [P13] Ink-insertion,
Spec S06, [L02], (#data-flow, #p13-ink-insertion), Dependencies (#dependencies)

**Artifacts:**
- `tugdeck/src/protocol.ts`: `REFS_OUTPUT`/`REFS_INPUT` FeedIds (match Rust) +
  `CONTROL_ACTION_LIST_REFS`.
- `tugdeck/src/lib/refs-session-store.ts`: an [L02] store built with `tugSessionId` +
  `projectDir`; `run(kind, parsedFlags)` sends `REFS_INPUT`, `cancel()` sends `cancel`,
  `_fold(frame)` mirrors started/rows/complete into `CodeSessionStore.ingestRefs`;
  constructor sends `list_refs` for restore.
- `types.ts`: `TurnOrigin` += `"refs"` (today `"user" | "assistant" | "shell"`);
  `RefsResultMessage`.
- `code-session-store.ts` `ingestRefs`; `reducer.ts` `buildRefsTurnEntry` + started/rows/
  complete actions + a `refs_result` skip inside Claude turns (sibling of the existing
  `shell_exchange` skip).
- **Generalize the ink-turn insertion helpers** ([P13]): `upsertShellTurn` →
  ink-origin upsert (used by streaming `ingestRefs` to replace the in-flight turn by
  `turnKey` as `refs_rows` arrive) and `appendTurnInterleavingShell`'s trailing-walk
  predicate to include `refs` — both in `reducer.ts`, invoked via the store wrapper's
  `ingest-shell-turn` / `append-transcript` effects.
- `session-transcript-data-source.ts`: a `refsRowOrdinal` **precomputed slot field** in
  the single-pass row build (mirror `shellRowOrdinal`, NOT a live per-row method). Because
  the ledger restores only one block ([P05]), the ref ordinal is simply `1..N` within that
  block — no session-wide counter. Note the data source's trailing-ink walk is documented as
  mirroring `appendTurnInterleavingShell` **exactly**; generalizing that predicate ([P13])
  means generalizing this walk in lockstep or the two drift.
- Construct `RefsSessionStore` in `card-services-store.ts` / `use-session-card-services.ts`
  (subscribe `REFS_OUTPUT` via `subscribeSessionFeed`, like shell); thread it to the
  `slashCommandSurfaces` handlers in `session-card.tsx` (parity with `shellSessionStore`).

**Tasks:**
- [ ] Add FeedIds; confirm the code-session feed filter does NOT consume `REFS_OUTPUT`
      (refs reach only `RefsSessionStore`, mirroring the shell filter exclusion).
- [ ] Generalize `upsertShellTurn` + `appendTurnInterleavingShell` to ink origins
      (`shell` + `refs`) per [P13]; route streaming `refs_rows` updates through the
      ink upsert so the in-flight turn settles in place (not a duplicate row).
- [ ] Generalize the **third** ink predicate in lockstep: `countClaudeTurns` in
      `session-load-control-bar-state.ts` ([P13]). Left alone, a session with refs turns
      reports "83 of 68" in the metadata row — the exact bug its docstring warns about.
- [ ] Implement the store + ingest + reducer; append `refs_rows` to the in-flight message
      as [L02] store updates (not DOM).

**Tests:**
- [ ] Unit (real reducer/store, mirror `code-session-store.shell-exchange.test.ts`):
      started+rows+complete builds one `refs` turn; successive `refs_rows` upsert in place
      (row count stays 1, refs accumulate); a cancelled complete marks the message; a
      `refs` turn interleaves correctly when a restore lands after a trailing shell turn
      ([P13]).
- [ ] Unit: `countClaudeTurns` over a transcript carrying both a shell and a `refs` turn
      returns the Claude-turn count, not the row count ([P13]).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean; `bunx vite build` succeeds.
- [ ] Live (temporary log): sending a `run` frame yields `refs_*` frames the store folds
      (assert via `tugDevLogStore`).

---

#### Step 6: Refs block chrome composing the body kinds + clickable refs {#step-6}

**Depends on:** #step-5

**Commit:** `refs(deck): RefsResultBlock over PathList/SearchResult body kinds, clickable refs`

**References:** [P08] Compose-body-kinds, [P03] Refs-origin, [P14] Offsets, Spec S05,
Spec S06, Spec S02, Spec S03, [L02], [L06], [L11], [L19], [L20], (#state-zone-mapping)

**Artifacts:**
- `RefsTurnCell` in `session-card-transcript.tsx` (mirror `ShellTurnCell`: participant
  `"refs"`, `#r` badge from the precomputed `refsRowOrdinal` slot field, timestamp).
  Extend **all three** participant unions: `Participant` + `PARTICIPANT_ICONS` in
  `tug-transcript-entry.tsx`, `SessionTranscriptCellKind` in
  `session-transcript-data-source.ts`, and `SessionZ1BParticipant` in
  `session-card-z1b.tsx`.
- `refs-result-block.tsx` (+ `.css`): chrome only — command header, Share + Copy, in-flight
  pulse via `data-state` [L06] — rendering `PathListBlock` (`opKind === "match"`) or
  `SearchResultBlock` (`opKind === "search"`) in `embedded` mode, so each body kind's
  actions cluster portals into this block's `BlockChrome`. [L19] file pair + `data-slot`
  + docstring; [L20] owns `--tugx-refs-*`, cascade-tunes the body kinds' tokens rather than
  reaching into them.
- `refs-result-view.ts`: pure `TextRef[]` → `PathListData` \| `SearchResultData` (group by
  file, relativize against `root`, pass `spans` through unchanged, [P14]).
- Opt-in click-to-open on `SearchResultBlock`: match rows stamp the annotator's `file-path`
  attributes (`ANNOTATION_CLASS`, `data-tug-annotation`, `data-path`, `data-line`,
  `data-tug-focus="refuse"`, `data-no-activate`) exactly as `PathListBlock`'s rows do —
  no handler, no responder ([L11]). Default off; `GrepToolBlock` unchanged. Update the
  block's docstring, which currently records this as a deferred follow-on.

**Tasks:**
- [ ] Render a streaming refs turn; rows grow as the message updates; in-flight header
      pulses; completed shows total.
- [ ] Derive rows with **absolute** paths (join `root`) — a relative path renders
      un-annotated and the row silently does not open ([P15]).
- [ ] Wire Share and Copy. Share is `pendingContextStore.stage(…)` behind a
      `staged`/`onToggleContext` pair like the shell row's `CommandBlock` — which means
      widening `ContextSource`, the `<tug-context source="…">` `OPEN_RE` alternation (a
      durable JSONL format), and the store's binary `n`/`setContext` ternaries, plus a
      `composeRefsShareText` ([P03]).
- [ ] Add the `refsSegments` projection to `transcript-search-index.ts` so refs rows are
      reachable by transcript Find ([P03]).
- [ ] Confirm `SearchResultBlock` collapse state and `PathListBlock` sort survive the
      streaming upsert ([P13]) rather than resetting on every `refs_rows` batch — the turn's
      mount identity is what to fix if they do ([L26], [P08]).

**Tests:**
- [ ] Unit: `refs-result-view` groups a flat numbered list into `SearchResultData` without
      renumbering, emits **absolute** paths joined from `root` ([P15]), and passes spans
      through byte-identical.
- [ ] Unit: a shared refs item round-trips the `<tug-context source="refs">` sentinel —
      staged, prepended, and split back out by the user-row renderer ([P03]). This is the
      durable-format half of Share and the one that a reload, not a click, would expose.
- [ ] App-test (`@covers` the block, the view, and `search-result-block.tsx`): a real refs
      turn renders both kinds; clicking a search row opens a Text card scrolled to the line;
      clicking a match row opens the file; a Grep tool block's rows remain non-clickable.
      Assert a match row actually carries `data-tug-annotation="file-path"` — the failure
      mode of a relative path is a row that renders perfectly and does nothing ([P15]).

**Checkpoint:**
- [ ] `bunx vite build` succeeds; live: a refs turn renders and rows open Text cards.

---

#### Step 7: `/match` + `/search` slash commands + typed flags {#step-7}

**Depends on:** #step-6

**Commit:** `refs(deck): /match and /search local slash commands + flag parsing`

**References:** [P01] Slash-not-route, [P07] Flags-truth, [P11] Flags, List L01, List L02,
(#dependencies)

**Artifacts:**
- `slash-commands.ts`: `LOCAL_SLASH_COMMANDS` += `{name:"match", takesArgs:true}`,
  `{name:"search", takesArgs:true}`.
- `refs-flags.ts`: parse `/match`/`/search` args into needles + normalized flags (Lists
  L01/L02); unknown flag → subdued notice, ignored. Also expose the inverse (flags → token
  string) so the deferred cluster ([P07], #roadmap) adds a surface, not a second grammar.
- `session-card.tsx` `slashCommandSurfaces`: `match`/`search` handlers
  (`(args, draft?) => void`; `draft` unused) → `refsSessionStore.run`.
- Stop/cancel affordance in the in-flight block dispatches `refsSessionStore.cancel()`.

**Tasks:**
- [ ] Register the commands (completion/`/m`-inline/history auto-derive).
- [ ] Parse flags; run the op; stream rows; wire cancel.

**Tests:**
- [ ] Unit: `refs-flags` parses representative `/match`/`/search` lines (defaults, each flag,
      combined, unknown).
- [ ] App-test: `/search foo` streams a `#r` block; `/match foo` lists filenames; a long
      `/search` is cancellable.

**Checkpoint:**
- [ ] `bunx vite build` succeeds; live: both commands produce clickable `#r` blocks.

---

#### Step 8: `/ref` resolution + multi-open honoring `openTarget` {#step-8}

**Depends on:** #step-7

**Commit:** `refs(deck): /ref number resolution + multi-open via openTarget`

**References:** [P09] Ref-open, Spec S04, (#dependencies)

**Artifacts:**
- `slash-commands.ts`: `{name:"ref", takesArgs:true}`. Note `/rewind`, `/resume`, and
  `/rename` already share the `/r` prefix, so inline completion resolves by the registry's
  existing rules — do not special-case it.
- `session-card.tsx` handler `ref`: parse the spec (single/range/list), resolve against the
  latest refs (from `RefsSessionStore` / the latest `refs` turn),
  `dispatchCommand(TUG_ACTIONS.OPEN_FILE, …)` per ref honoring `openTarget` — the same
  payload the annotator's row click sends — cap at 10 with a subdued warning, out-of-range →
  subdued error.

**Tasks:**
- [ ] Implement spec parsing + resolution + capped multi-open.
- [ ] Join `root` onto the ref's relative `path` via the shared helper before dispatching
      `OPEN_FILE`, so `/ref 3` and a click on row 3 send the identical payload ([P15]).

**Tests:**
- [ ] Unit: spec parser (`3`, `3-5`, `3 7 9`, mixed, cap, out-of-range).
- [ ] App-test: after a `/search`, `/ref 3-5` opens refs 3–5 per the `openTarget` pref.

**Checkpoint:**
- [ ] `bunx vite build` succeeds; live: `/ref` opens the right files.

---

#### Step 9: Reload restore via the ledger {#step-9}

**Depends on:** #step-4, #step-8

**Commit:** `refs(deck): restore latest refs block on card reload`

**References:** [P05] Ledger, Spec S07, (#data-flow)

**Artifacts:**
- `action-dispatch.ts`: `list_refs_ok` handler → `applyRestoredRefs` re-ingesting the latest
  run as a `refs` turn (mirror `applyRestoredShellExchanges`).
- `RefsSessionStore` constructor already sends `list_refs` (#step-5); wire the response.

**Tasks:**
- [ ] Restore the latest run on mount; `/ref N` resolves against the restored list.

**Tests:**
- [ ] App-test: run `/search`, Maker ▸ Reload, the last `#r` block reappears and `/ref N`
      still resolves.

**Checkpoint:**
- [ ] `bunx vite build` succeeds; live: reload restores the last refs block.

---

#### Step 10: Integration checkpoint (core vertical slice) {#step-10}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, Spec S02, Spec S03, Spec S04, Spec S07)

**Tasks:**
- [ ] Verify end-to-end: `/match`, `/search` (streaming + cancel), row-click opens at line,
      `/ref` single/range/list, clobber on a new run, reload restore.

**Tests:**
- [ ] App-test: the aggregate match/search/ref scenario on a real workspace.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx vite build` + `just app-test-changed` pass.

---

#### Step 11: Column-span highlight for `search` refs (Text card) {#step-11}

**Depends on:** #step-10

**Commit:** `refs(deck): column-span highlight when opening a search ref`

**References:** [P10] Column-highlight, [P14] Offsets, Risk R04, Spec S03, (#symbols)

**Scope:** the **Text card** reveal only. The in-block span highlight already ships —
`SearchResultBlock` paints it from the `spans` the wire carries (#step-6).

**Artifacts:**
- Extend the reveal chain to carry a column range: `OPEN_FILE` payload
  (`action-vocabulary.ts`, documented today as `{ path, line?, endLine? }`),
  `openFileInCard` signature (`(store, path, line?, endLine?)` today), `revealOnOpen` seed +
  `TextCardOpenEntry.revealLine`/`openFile` (`text-card-open-registry.ts`, `text-card.tsx`),
  and `revealLineFn` (`tug-text-card-editor.tsx`) painting a `Decoration.mark` or a
  registered `CSS.highlights` range for the span(s) instead of the line-only flash.
- The annotator carries the payload: extend `FilePathPayload` + `openTargetFor`
  (`annotator/payloads.ts`, `annotator/registry.ts`) so a `data-*` column range reaches
  `OPEN_FILE` — preferred, since every file reference in the transcript gains the same
  sharpening. If that widening proves unwelcome, the refs row dispatches `OPEN_FILE`
  directly for the column case instead; decide with the payload shape in hand.
- `/ref` passes the first span's columns for search refs.

**Tasks:**
- [ ] Thread columns end-to-end; paint only non-empty spans (bare line → existing flash,
      Risk R04). Convert the wire's 0-based half-open char offsets to CM6 document positions
      at the editor boundary, once ([P14]).

**Tests:**
- [ ] App-test: clicking a search ref highlights the exact match span (assert range/attr
      state, not pixels).

**Checkpoint:**
- [ ] `bunx vite build` succeeds; live: the matched span highlights on open.

---

#### Step 12: Final integration checkpoint {#step-12}

**Depends on:** #step-10, #step-11

**Commit:** `N/A (verification only)`

**References:** (#exit-criteria, #success-criteria)

**Tasks:**
- [ ] Full pass: streaming + cancel, clickable refs with column highlight, `/ref`
      multi-open, clobber + reload restore, non-context-ink + Share.

**Tests:**
- [ ] App-test: the aggregate scenario including the column highlight.

**Checkpoint:**
- [ ] `cargo nextest run` + `bunx tsc --noEmit` + `bunx vite build` +
      `just app-test-changed` pass.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Three local slash commands — `/match`, `/search`, `/ref` — where
`/match`/`/search` run Rust filename/content search from the workspace root and stream a
numbered, clickable, cancellable, non-context `#r` file-reference block into the Session
card transcript (latest-only, ledger-restored, rendered through the existing
`PathListBlock` / `SearchResultBlock` body kinds), and `/ref` opens refs by number into Text
cards honoring the deck's open preference.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `/search` streams a numbered `#r` block; rows appear incrementally; a click opens the
      file at its line (with the match span highlighted after #step-11). (Spec S03, S05, P10)
- [ ] `/match` lists matching filenames; a click opens the file. (Spec S02, S05)
- [ ] `/ref 3` / `3-5` / `3 7 9` open the right refs from the latest block honoring
      `openTarget`, capped and warned. (Spec S04, P09)
- [ ] A run is cancellable; an invalid `-e` regex yields zero results, no crash. (P04, R02)
- [ ] A new run clobbers the ledger; a reload restores the last block; `/ref N` still
      resolves. (Spec S07, P05)
- [ ] Refs never enter Claude context except via Share, and a shared refs block survives a
      reload as an attributed context chip (not raw sentinel text). `SecretFilter` paths
      never appear. (Spec S06, R03, P03)
- [ ] A session carrying refs turns still reports the right `X of Y` in the metadata row,
      and a refs row is findable by transcript Find. ([P13], [P03])
- [ ] A Grep tool block's match rows are still non-clickable — the `SearchResultBlock`
      interactivity prop is opt-in and defaulted off. ([P08])
- [ ] `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`, and the plan's app-test
      selection (`just app-test-changed`) all pass.

**Acceptance tests:**
- [ ] Rust unit + feed + ledger suites (Steps 1–4), including the non-ASCII span fixture.
- [ ] TS unit suites (`refs-flags`, `refs-result-view`, `/ref` parser).
- [ ] App-test aggregate match/search/ref scenario (Steps 10, 12), each file carrying
      `@covers`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The **option cluster** — Case / Regex / All-files / Any-needle chips writing typed flag
      tokens into the draft, with tugbank-persisted defaults ([P07]). Needs a mount design
      against the composer-route model that exists now; `refs-flags.ts` already exposes the
      token emitter it would call.
- [ ] Global click-to-open for `SearchResultBlock` — flip `GrepToolBlock` onto the opt-in
      prop this plan lands, so Claude's Grep results open the same way ([P08]).
- [ ] Search-and-replace (`search -r`) with a dry-run preview and an undo-safe apply.
- [ ] A `searchable`/`skippable` config surface (extension allowlist) if the gitignore +
      `SecretFilter` model proves too coarse.
- [ ] Sorted (not emission-order) numbering as an option, if users want the C++ global sort.

| Checkpoint | Verification |
|------------|--------------|
| Rust ops correct | `cargo nextest run -p tugcast` (match/search/walk/ledger) |
| Streaming + cancel | app-test: rows arrive incrementally; cancel settles the block |
| Clickable refs | app-test: row click opens a Text card at line (+span after #step-11) |
| Grep unchanged | app-test: Grep tool block match rows remain non-clickable ([P08]) |
| `/ref` multi-open | app-test: `/ref 3-5` opens per `openTarget` |
| Latest-only + restore | app-test: new run clobbers; reload restores; `/ref` resolves |
| Non-context ink | refs excluded from Claude context; Share is the only bridge |
| Build + tests | `cargo nextest run` + `bunx vite build` + `just app-test-changed` |
