## Tracking Changes Improvements — proof for shell deletes, moves, and writes {#tracking-changes-improvements}

**Purpose:** Convert the thick head of shell-driven file mutations — `rm`, `mv`, `git rm`, `git mv`, redirection targets, `sed -i` — from correlation-only bracket hints into proof-class attribution, and make renames carry their attribution across the move, so far fewer dirty files land in the `unattributed` bucket.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (all steps done on the `tracking-changes` dash; awaiting the user's `/join`) |
| Target branch | main (built on a `tugutil dash` worktree via `/tugplug:implement`) |
| Last updated | 2026-07-25 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The attribution doctrine ([tuglaws/tracking-changes.md](../tuglaws/tracking-changes.md), [D112]) splits evidence into **proof** (`exact`/`replay`/`claim` — the tool input names the file) and **correlation** (`bash`/`turn` — a whole-tree fingerprint delta that can only hint). Today every shell deletion, move, and rename is structurally condemned to correlation: the exact-origin allowlist (`tugcast/src/feeds/attribution.rs::exact_op_for_tool`) covers only `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, none of which delete or move. The ledger confirms the cost: 47 distinct project paths in `changes.db` no longer exist on disk, but only 22 `deleted` and 2 `renamed` rows were ever written — all bracket-class, so at best hints. Renames are doubly broken: the bracket writes its `renamed` row on the new path only (there is no old-path record), and the read side's `StatusReport::v1_status_map` (`tugchanges-core/src/git.rs`) drops `orig_path`, so proof rows earned under a file's old name never carry to its new name — a `git mv` severs the file's entire attribution history.

An empirical mining pass over the full Claude Code transcript corpus (29,115 Bash commands across 2,096 session files) shows the problem is concentrated, not long-tailed: only 5.2% of Bash commands mutate files at all; the top five categories (redirection/heredoc writes 30%, inline scripted edits 28%, `rm` 21%, `sed -i` 7%, `git stash` 6%) cover 86.6% of mutations; renames go through `git mv` over plain `mv` 5:1; and the feared exotica (`xargs rm`, `rsync`, `find -exec rm`, `trash`) are statistically absent (0–1 occurrences each). Critically, **~80% of rm/mv-class invocations have fully literal operands** — statically parseable — and the hard 20% is shell variables and globs, not control flow. See **Table T01** (#t01-corpus-distribution).

This plan implements the agreed four-layer design: (1) parse Bash commands in tugcast and mint a new proof-class origin `cmd` for literal-operand mutations, gated by intersection with the existing bracket delta; (2) rename lineage — paired rows plus an `orig_path` join on the read side; (3) fix the untracked-delete misclassification; (4) a `tugutil file` verb family whose JSON receipt turns even glob/variable operations into proof, steered by a tugplug PreToolUse hook that denies only what the parser cannot read. **No MCP anywhere** — the tool surface is a CLI verb delivered through Bash, per the project's explicit MCP-free policy.

#### Strategy {#strategy}

- **Doctrine first**: amend `tuglaws/tracking-changes.md` before code, so the proof-class argument for `cmd` rows is on the record and each step can cite it.
- **Capture-side wins before behavior-change wins**: the parser (Layer 1) requires no model compliance, covers every session, and heals replay — it lands before the verb family and hook.
- **Elevate, don't duplicate**: on the live path, the parse does not invent rows — it upgrades the origin of bracket-delta rows whose paths the command literally named (`bash` → `cmd`). One row per path per call, same PK discipline.
- **Never guess**: the grammar refuses anything with variables, substitution, or globs. The failure direction is always "stays a bracket hint," never a wrong proof row.
- **One grammar, two consumers**: the tugplug hook decides deny/allow by shelling to `tugutil file gate`, which uses the same parser crate module tugcast uses — no shell reimplementation to drift.
- **No `file_events` schema change** ([P03]): the machine-global DB has mixed-version concurrent writers and a DROP-and-recreate drift guard; rename lineage is encoded in paired rows and a read-side git join instead of a new column.

#### Success Criteria (Measurable) {#success-criteria}

- A literal `rm <tracked-file>` run through the session's Bash tool yields a `file_events` row with `origin='cmd'`, `op='deleted'`, and the deleted path classifies as **attributed** in `tugutil preflight` (verify: integration test + manual session).
- A literal `git mv A B` yields two rows sharing one `tool_use_id` (old and new path), and the renamed path classifies as **attributed** even when the only prior proof rows were written under the old name (verify: integration test over a real repo).
- `rm` of an untracked file records `op='deleted'`, not `modified` (verify: unit test on `classify_op`).
- On resume, replayed Bash frames with parseable commands backfill `origin='cmd'` rows at historical timestamps (verify: replay-path test in `agent_bridge.rs`).
- `tugutil file rm 'glob*'` deletes, prints a receipt, and the relay mints proof rows for every path the receipt names (verify: integration test).
- The tugplug hook denies a glob `rm` with a steering message and allows a literal `rm` untouched (verify: scripted hook I/O test).
- `cargo nextest run` green under `-D warnings`; no regression in the existing attribution/replay/relay test suites.

#### Scope {#scope}

1. Layer 1 — conservative Bash-command parser (`shell_ops`) + `cmd` proof origin, live (parse∩delta) and replay (parse+success) minting.
2. Layer 2 — rename lineage: paired capture rows; read-side `orig_path` join in `compute_changes`.
3. Layer 3 — untracked-delete op fix in `classify_op`.
4. Layer 4 — `tugutil file mv|rm|cp|gate` verbs with a JSON receipt; tugcast receipt minting; tugplug PreToolUse gate hook.
5. The `tuglaws/tracking-changes.md` amendment covering all of the above.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **MCP** — no MCP server, no MCP config, no MCP tool names. The tool surface is a CLI verb.
- Inline scripted edits (`python3 - <<EOF` read-replace-write, `Bun.write`, `perl -i`) — genuinely opaque; they remain bracket-hinted, which the two-layer doctrine already renders safe.
- Build side-effects (cargo/vite/tsc churn) — deliberately uncaptured beyond brackets.
- The shell route (`$` commands) — G4 stands; deliberately uncaptured ([D111]).
- Chained-rename lineage deeper than one hop (see [Q02]).
- UI changes in tugdeck — the Changes card already renders op/origin; `cmd` rows flow through the existing attributed rendering.

#### Dependencies / Prerequisites {#dependencies}

- The 2026-07-25 capture-hardening changes (G7/G8/G9: `replay_batch` unwrap, exception-proof replay bracket close, stdout-drain throw barrier) must be landed on `main` — this plan's replay minting extends the `replay_batch` arm those changes introduced in `agent_bridge.rs`.
- `tugcast` already depends on `tugchanges-core` and `tugutil` already depends on `tugchanges-core` (both confirmed in their `Cargo.toml`s), so the shared parser module needs no new crate wiring.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- The machine-global `changes.db` is written concurrently by multiple tugcast processes, potentially at different binary versions (release app + debug CLI harness). Any schema change must survive that ([P03]).
- Only the user commits on `main`; the implement skill commits per-step on its dash worktree.
- `origin_is_proof` exists in two hand-mirrored copies (`tugcast/src/feeds/attribution.rs` and `tugchanges-core/src/ledger.rs`) — both must change together; the contract test in `tugchanges-core/src/changes.rs` guards the schema shape, and each copy's unit tests pin the origin set.

#### Assumptions {#assumptions}

- The `tool_result` IPC frame carries the command output: `ToolResult { output: string, ... }` in `tugcode/src/types.ts` — verified; receipt reading needs no tugcode change.
- Bash tool commands execute with the session's project dir as the working directory unless the command itself `cd`s — the parser resolves relative operands against the bracket's `repo_root` after applying any leading `cd`.
- Claude Code PreToolUse hook semantics: multiple hooks on one matcher all run; an explicit `deny` decision wins over an `allow`. The existing `auto-approve-tug.sh` allows `tugutil *`, which composes correctly with the new gate (verbs are auto-approved; unparseable raw commands are denied).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the tool_result wire frame carry command output? (DECIDED) {#q01-tool-result-output}

**Question:** Receipt minting requires the relay to read the Bash command's stdout from the `tool_result` frame — is it on the wire?

**Resolution:** DECIDED — yes. `tugcode/src/types.ts` defines `ToolResult { type: "tool_result"; tool_use_id: string; output: string; is_error: boolean; timestamp?: number; ipc_version: number }`. `InspectedToolResult` in `tugcast/src/feeds/attribution.rs` gains a `#[serde(default)] pub output: String` field (partial-shape parse tolerates absence on legacy frames). See [P04].

#### [Q02] Chained renames (A→B→C across multiple commands) (DEFERRED) {#q02-chained-renames}

**Question:** Should the read-side lineage join follow more than one hop (proof rows under A attributing a file now at C)?

**Why it matters:** A multi-step refactor could still orphan attribution after two moves within one commit window.

**Resolution:** DEFERRED — one hop only. git status reports a single `orig_path` per uncommitted rename, so the dirty-window join is inherently one-hop; a commit spends the rows anyway (row liveness), so multi-hop lineage would only matter within a single uncommitted window containing two successive renames of the same file — rare enough to accept as a bracket-hint residue. Revisit if the unattributed bucket shows it in practice.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| False-positive parse mints a wrong proof row | high | low | Live rows require parse∩delta (named AND observed); grammar refuses non-literal operands; tokenizer (not regex) immune to in-string mentions | Any `cmd` row for a path the session never touched |
| Schema drift guard nukes `file_events` under mixed-version writers | high | — | [P03]: no column change at all | Any future plan adding a `file_events` column |
| Hook friction: denied Bash wastes a round trip | low | med | Deny only what the parser cannot read (globs/vars in rm/mv-class); literal commands pass untouched | User reports of nuisance denials |
| Grammar drift between hook and relay | med | low | Single parser module in `tugchanges-core`, consumed by both tugcast and `tugutil file gate` | — |
| Forged receipt (a command echoes the sentinel) | low | low | A session echoing `TUG-FILE-RECEIPT` self-attributes only — same trust class as calling the verb; foreign attribution is impossible (rows are relay-local, Who axiom) | — |

**Risk R01: Parse∩delta misses a real mutation** {#r01-parse-delta-miss}

- **Risk:** A parsed operation whose path never shows in the bracket delta (G2 pre-snapshot race; off-repo target) mints nothing.
- **Mitigation:** By design — the delta gate exists to confirm outcome. The path degrades to exactly today's behavior (turn-bracket hint or unattributed), never a wrong claim.
- **Residual risk:** Fast literal commands under the G2 race stay hint-only on the live path; the replay backfill ([P02]) usually heals them on the next resume.

---

### Design Decisions {#design-decisions}

#### [P01] `cmd` is a fourth proof-class origin (DECIDED) {#p01-cmd-proof-origin}

**Decision:** Add origin `cmd` to the proof set (`origin_is_proof` returns true for `exact | replay | claim | cmd`), minted only when a Bash command's **literally named** operand paths are confirmed mutated.

**Rationale:**
- The What axiom defines proof as "the tool input names the file." A parsed literal `rm a.ts` names its file in the tool input — the same epistemic status as `Write`'s `file_path`, with none of the bracket's contamination (it cannot sweep up another session's save or the user's hand-save; it is this session's own declared operation).
- The intent-vs-outcome gap (a command can fail partway) is closed by the delta gate on the live path ([P02]) and by the success-only rule on replay.
- Precedent: `claim` was already admitted as a third proof origin; the read side's proof machinery is origin-set-driven in exactly two functions.

**Implications:**
- Both `origin_is_proof` copies change together (tugcast `feeds/attribution.rs`, tugchanges-core `ledger.rs`) plus the SQL `origin IN ('exact','replay')` predicate in `ledger.rs::sessions_for_path` (which must become `('exact','replay','claim','cmd')` — note it currently omits `claim` too; fixing that is in-scope for the step that touches it, per the fix-pre-existing-issues policy).
- `tool_name` on `cmd` rows stays `"Bash"`; `op` comes from the delta's status transition live, from the declared op on replay/receipt.

#### [P02] Live rows are parse∩delta; replay rows are parse+success (DECIDED) {#p02-parse-delta-gate}

**Decision:** On the live path, the parse never creates rows — it upgrades the origin of bracket-delta rows whose repo-relative path matches a parsed operand (`bash` → `cmd`). On the replay path (where no fingerprint exists), parsed operations from a Bash `tool_use` frame mint `cmd` rows directly when the paired `tool_result` is successful, at the frames' historical timestamps.

**Rationale:**
- Intersection is stronger than either signal: the parse gives per-file naming (proof-grade specificity), the delta gives observed outcome. Elevating existing delta rows also means zero new row-emission machinery on the live path — `OpenBracket::into_delta_rows` gains one parameter.
- Replay heals G1's thick head: the command text replays even though the fingerprint is gone. This is the first time shell mutations become recoverable history.

**Implications:**
- `into_delta_rows` signature gains `proof_paths: &HashSet<PathBuf>` (absolute, pre-joined against `repo_root`); matching rows get `origin: "cmd"`, everything else stays `"bash"`/`"turn"` (the turn bracket always passes an empty set).
- **Declared paths are canonicalized before the join.** `OpenBracket.repo_root` is canonical (built via `ensure_repo_root` from the canonical project dir), so delta keys are canonical-absolute — a declared operand spelled through an alt path (`rm /u/src/tugtool/x.ts` vs the bracket's `/Users/kocienda/Mounts/…` keys) must pass through `CanonicalPath::from_raw` before intersecting, or the join silently misses exactly the spelling-drift class the gateway exists for.
- **The intersection is equal-or-under, not equal-only.** `rm -rf dir/` declares one path (the directory) while the delta keys are the files beneath it (`-uall` deliberately expands directories, G5) — so a declared path matches every delta path equal to it **or prefixed by it**. This is what makes recursive `rm -r`/`git rm -r`/`cp -r` (75 of the corpus's 317 `rm`s are recursive) elevate the actual per-file rows.
- The relay needs the command text at bracket close: a relay-local `pending_cmds: HashMap<String, Vec<DeclaredOp>>` keyed by `tool_use_id`, populated at Bash `tool_use` time (live and replay arms), consumed at `tool_result` time. Size-capped like `PendingCalls`.
- Replay op mapping (advisory precision — git status decides rendering at read time): `Remove → deleted`, `Move → renamed` (two rows, [P05]), `Copy → created` (dest), `WriteTarget`/`EditInPlace`/`Touch → modified`.

#### [P03] No `file_events` schema change — lineage without a column (DECIDED) {#p03-no-schema-change}

**Decision:** Rename lineage is encoded as **two rows under one `tool_use_id`** (old path and new path, both `op='renamed'`, PK `(session, tool_use_id, file_path)` already permits it) plus a **read-side join through git's own `orig_path`** — no new column, no ALTER, no migration.

**Rationale:**
- `SessionLedger::bootstrap_schema` guards `changes.file_events` with `rebuild_table_if_schema_drifted` against `FILE_EVENTS_SCHEMA` — drift is resolved by **DROP-and-recreate**, not migration. The DB is machine-global with concurrent writers at potentially different binary versions (release Tug.app + debug CLIs): adding a column would make each version see the other's shape as drifted and repeatedly destroy the table.
- The read side doesn't need ledger lineage for the case that matters: an *uncommitted* rename's `orig_path` comes straight from `git status --porcelain=v2` (already parsed into `StatusEntry::orig_path`, currently dropped by `v1_status_map`). Once the rename commits, liveness spends the rows regardless.

**Implications:**
- `FILE_EVENTS_SCHEMA` in `tugcast/src/session_ledger.rs` is untouched.
- Capture writes the old-path row at live close (the old path typically leaves the dirty set, so the delta alone would at best log a `modified` disappearance; the parse supplies the old name) and at replay minting.
- `compute_changes` (`tugchanges-core/src/changes.rs`) gains an orig-path merge: for a dirty entry whose `StatusEntry.renamed` is true, self events and foreign claims are also looked up under `orig_path`, each set filtered by its **own** path's liveness cut (`min_live_at_ms(repo_root, orig_path)` for old-name rows).

#### [P04] Verb receipts are proof; the relay reads them from `tool_result.output` (DECIDED) {#p04-verb-receipts}

**Decision:** `tugutil file` verbs print exactly one stdout line `TUG-FILE-RECEIPT: {"ops":[{"op":"deleted","path":"…"},{"op":"renamed","path":"<new>","orig_path":"<old>"},…]}` with **absolute resolved paths**. The relay scans every successful Bash `tool_result`'s `output` for that prefix and mints `cmd` rows for each receipt op (rename → two rows per [P03]).

**Rationale:**
- The receipt is testimony of outcome from a tool we own: the verb performed the expansion (globs, many files) and reports exactly what happened — this is how the hard 20% (globs/variables) becomes proof.
- Scanning all Bash results (rather than only parsed `tugutil file` invocations) keeps the receipt usable even when the verb is invoked through a wrapper the grammar can't read; forgery is a non-risk (see Risks table — self-attribution only).

**Implications:**
- `InspectedToolResult` gains `#[serde(default)] pub output: String` ([Q01]).
- Receipt rows use the receipt's `op` verbatim and project paths repo-relative through the same `file_repo_root`/`project_repo_relative` machinery as exact rows (per-file repo resolution, the Where axiom).
- The receipt is versionless by design — additive JSON fields only; unknown fields ignored (serde partial-shape).

#### [P05] Renames write paired rows at capture (DECIDED) {#p05-paired-rename-rows}

**Decision:** Every rename the system can prove (parsed `mv`/`git mv` live or replay, or a receipt `renamed` op) records two `cmd` rows sharing the `tool_use_id`: the new path and the old path, both `op='renamed'`.

**Rationale:**
- The old-path row documents the takeoff point (today the old path leaves no record at all when it was clean pre-command), and gives the `--all` history view and future forensics a complete picture.
- The new-path row is what the read side matches for the dirty rename; the git-side `orig_path` join ([P03]) covers proof rows written under the old name *before* the rename.

**Implications:**
- Live path: the old path is usually absent from the post-delta (it left the dirty set); the minting step synthesizes the old-path row from the parse rather than from the delta.

#### [P06] Untracked-delete disambiguation by disk existence (DECIDED) {#p06-untracked-delete-fix}

**Decision:** `classify_op`'s `(Some(_), None)` arm ("fell out of the dirty set") checks whether the path still exists on disk: absent → `deleted`; present → `modified` (committed/reverted, as today).

**Rationale:** Deleting an *untracked* file removes it from the dirty set entirely (it never gets a ` D` status), so today it records a misleading `modified` row. Existence at delta time is the discriminator.

**Implications:** `classify_op` (or its caller `into_delta_rows`) does one `std::fs::metadata` per disappeared path — bounded by the delta size, negligible. Tests must cover: untracked file deleted (→ `deleted`), tracked file committed by the command (still on disk → `modified`).

#### [P07] The gate denies only what the grammar cannot read (DECIDED) {#p07-gate-only-unparseable}

**Decision:** The tugplug PreToolUse gate denies a Bash command only when it (a) contains an rm/mv-class file-lifecycle operation (`rm`, `mv`, `git rm`, `git mv`) AND (b) the shared grammar rules its operands non-literal (variables, substitution, globs). Literal commands pass untouched (Layer 1 proves them); everything else falls through to normal permission flow.

**Rationale:**
- Friction lands exactly where correlation would otherwise be the ceiling. The corpus says this is ~20% of rm/mv-class commands — a few denials per long session, each converting an unattributable operation into receipt-proof.
- The decision is computed by `tugutil file gate --command <cmd>` (same parser module), so the hook script stays a thin jq wrapper and the grammar cannot fork.

**Implications:**
- New executable script `tugplug/hooks/gate-file-ops.sh` appended to the existing Bash matcher in `tugplug/hooks/hooks.json`; deny output uses `hookSpecificOutput.permissionDecision: "deny"` with a `permissionDecisionReason` naming the `tugutil file` alternative. Claude Code runs both Bash hooks; deny wins over the auto-approver's allow.

#### [P08] The grammar lives in `tugchanges-core::shell_ops` (DECIDED) {#p08-grammar-home}

**Decision:** The parser is a new module `tugrust/crates/tugchanges-core/src/shell_ops.rs` — pure functions, no I/O — consumed by tugcast (live/replay minting) and tugutil (`file gate`).

**Rationale:** Both consumers already depend on `tugchanges-core`; the module is attribution-domain logic (it defines what counts as a declared file operation), matching the crate's charter. No new crate, no dependency edges added.

---

### Deep Dives {#deep-dives}

#### Corpus findings (2026-07-25 mining pass) {#corpus-findings}

**Table T01: Bash file-mutation distribution (29,115 commands, 2,096 transcripts)** {#t01-corpus-distribution}

| Category | Count | % of 1,508 mutating | Parseability |
|---|---|---|---|
| Redirection `>`/`>>` to a path | 450 | 29.8% | Target literal in the dominant `cat > path <<EOF` idiom |
| Inline script writes (python/JS heredoc rewrites) | ~415 | 28.3% | Opaque — out of scope, stays bracket-hinted |
| `rm` | 317 | 21.0% | ~80% literal operands |
| `sed -i` | 101 | 6.7% | Target files usually literal; `grep -rl | xargs`-style variants opaque |
| `git stash` (mutating forms) | 69 | 5.9% | No per-file operands — out of grammar |
| `cp` | 53 | 3.5% | mostly literal |
| `git mv` | 46 | 3.1% | mostly literal multi-pair chains, often followed by `sed -i` in the same command |
| `git restore` / `git checkout -- <path>` | 40 | 2.7% | literal |
| `git rm` | 34 | 2.3% | nearly all literal |
| `mv` (plain) | 11 | 0.7% | renames go `git mv` 5:1 |
| `tee` | 14 | 0.9% | literal |
| `xargs rm` / `rsync` / `trash` / `unlink` / `truncate` | 0 | — | absent from corpus |
| `find -exec rm` / `git clean` / `tar -x` | 1 each | — | negligible |

Hand-classified 100-sample of the rm/mv-class pool (395 commands): **80.6% fully literal** (including `cd X && rm file` chains — the `cd` prefix is itself static); the hard 19.4% is variables (12), globs (6), other (1); **zero** loop/xargs/find-exec cases. Regex-level detection hazard: ~2% of `git mv`/`git rm` regex matches are *mentions inside quoted commit messages* — the tokenizer approach is immune.

#### Where minting happens in the relay {#relay-minting-flow}

All capture flows through `tugcast/src/feeds/agent_bridge.rs::relay_session_io`. The relevant relay-local state today: `pending_calls: PendingCalls` (exact tools), `open_bash: HashMap<String, OpenBracket>` (per-call Bash brackets, opened at Bash `tool_use` when `!in_replay`), the turn bracket, and the `in_replay` latch with its `REPLAY_BRACKET_DEADLINE` watchdog. The changes:

1. **Bash `tool_use` (live arm and `replay_batch` inner-frame arm):** run `shell_ops::parse(command, repo_root)`; on `Ops(list)`, store in the new relay-local `pending_cmds` map keyed by `tool_use_id`. The live arm continues to open the bracket as today; the replay arm (which opens no bracket) stores only the parse.
2. **Bash `tool_result`, live:** at bracket close (where `open_bash.remove(&tr.tool_use_id)` resolves the delta today), take `pending_cmds` for the id, join declared paths (absolute) against the delta, and pass the matched set as `proof_paths` into `into_delta_rows` — matched rows carry `origin: "cmd"`. Synthesize the old-path row for parsed renames ([P05]). Then scan `tr.output` for the receipt sentinel and mint receipt rows ([P04]).
3. **Bash `tool_result`, replay (both the live-arm-under-`in_replay` case and `replay_batch` inner frames):** on `!tr.is_error`, mint `cmd` rows directly from the taken parse at the frames' historical timestamps; also scan the replayed `output` for receipts.
4. Row projection reuses `record_exact_pending`'s per-file repo-root resolution pattern (`file_repo_root` + repo-relative projection + the relay's `repo_root_cache`) — the Where axiom applies to `cmd` rows identically.

#### Current read-side rules being extended {#read-side-rules}

`tugchanges-core/src/changes.rs::compute_changes` classifies every dirty path over live rows: live self **proof** row → attributed; foreign live proof → foreign; else unattributed (self bracket row → hint). The liveness cut is `min_live_at_ms` (`git log -1 --format=%ct -- <path>`). The rename extension ([P03]) threads `StatusEntry.orig_path` from `parse_status_porcelain_v2` (which already captures it) through to the per-path classification loop — today the loop consumes only `v1_status_map()`, which flattens entries to `path → XY` and discards `orig_path`.

---

### Specification {#specification}

**List L01: Covered command grammar** {#l01-grammar}

Simple-command heads the parser recognizes (after splitting on `&&`, `||`, `;`, and pipeline segments, and applying any leading `cd <literal>` to the working directory):

- `rm [-rf/-f/-r/--] <paths…>` → `Remove` per path
- `mv [--] <src…> <dst>` → `Move` (multi-src: each src → dst-dir join)
- `cp [-r/-a/--] <src…> <dst>` → `Copy` per dest path
- `git rm [-q/-f/-r/--cached/--] <paths…>` → `Remove` per path (`--cached` still counts: the tracked entry leaves the index → the path goes dirty)
- `git mv <old> <new>` (and chained pairs) → `Move`
- `git restore [--] <paths…>` / `git checkout -- <paths…>` → `EditInPlace` per path
- `sed -i[suffix] <expr> <files…>` → `EditInPlace` per trailing file operand (macOS `-i ''` and `-i.bak` forms)
- `tee [-a] <files…>` → `WriteTarget` per file
- `touch <paths…>` → `Touch` per path
- Redirection `> <path>` / `>> <path>` on any simple command (excluding `/dev/null` and fd duplications) → `WriteTarget`; heredoc bodies are skipped before scanning
- `tugutil file …` → parses as its underlying op (and is always allowed by the gate)

**Refusal rules (whole simple-command contributes nothing):** any operand containing `$`, backtick, `$(`, glob metacharacters (`*`, `?`, `[`), brace expansion, or tilde-user forms; `for`/`while`/`if` compounds; `xargs`/`find -exec` (the operands aren't in the command text). Refusal of one simple command does not refuse its siblings in the same line. Quoted strings are tokenized before matching, so `git mv` inside a commit message never matches.

**Spec S01: Parser API (`tugchanges-core/src/shell_ops.rs`)** {#s01-parser-api}

```rust
pub enum DeclaredKind { Remove, Move { orig: PathBuf }, Copy, EditInPlace, WriteTarget, Touch }
pub struct DeclaredOp { pub kind: DeclaredKind, pub path: PathBuf }   // absolute, resolved against base_dir + any leading `cd`
pub enum ParseOutcome {
    Ops(Vec<DeclaredOp>),      // at least one literal file operation
    NoFileOps,                 // parsed fine, nothing file-mutating
    Unparseable { reason: String },  // rm/mv-class op present but operands non-literal — the gate's deny signal
}
pub fn parse_shell_ops(command: &str, base_dir: &Path) -> ParseOutcome;
```

`DeclaredOp.path` is resolved absolute against `base_dir` (plus any leading `cd`) but is **not** canonicalized by the parser — the module stays pure. Consumers that join against canonical-space keys (the relay's delta intersection, [P02]) canonicalize via `CanonicalPath::from_raw` at the join. A declared path may name a directory (recursive `rm`/`cp`); the [P02] equal-or-under match rule handles that at the join, not here.

`Unparseable` is returned **only** when a file-lifecycle head (`rm`/`mv`/`git rm`/`git mv`) is present with non-literal operands — a non-literal `tee` or redirect degrades to `NoFileOps` (the gate never denies those; the corpus shows they're log writes).

**Spec S02: Receipt line** {#s02-receipt}

One stdout line, absolute paths, emitted only on overall success (a partial failure emits the receipt for the ops that completed, then exits non-zero — the relay only reads receipts from successful results, keeping proof conservative). **Receipt ops name files, never directories**: the read side's status universe is per-file, so a directory row could never join — a recursive operation enumerates the affected files *before* acting and emits one op per file (a directory rename emits one `renamed` op per contained file, old and new spellings paired):

```
TUG-FILE-RECEIPT: {"ops":[{"op":"deleted","path":"/abs/a.ts"},{"op":"renamed","path":"/abs/new.ts","orig_path":"/abs/old.ts"},{"op":"created","path":"/abs/copy.ts"}]}
```

**Spec S03: `tugutil file` CLI contract** {#s03-file-cli}

- `tugutil file rm <paths-or-globs…>` — expands globs itself; `git rm` for tracked paths, `std::fs::remove_file`/`remove_dir_all` otherwise; prints receipt. A directory argument is walked first and the receipt enumerates every removed file (Spec S02's files-only rule).
- `tugutil file mv <src> <dst>` — `git mv` when src is tracked, else `std::fs::rename`; receipt op `renamed` with `orig_path`.
- `tugutil file cp <src> <dst>` — plain copy; receipt op `created` for dst.
- `tugutil file gate --command <cmd> [--base-dir <dir>]` — prints `{"decision":"allow"}` or `{"decision":"deny","reason":"…"}` (deny iff `Unparseable`); always exit 0 (the decision is in the JSON; a crashed gate must fail open — the hook treats missing/invalid output as allow).
- Registered as `Commands::File(FileCommands)` in `tugutil/src/cli.rs`, implemented in a new `tugutil/src/commands/file.rs` (the `commands/` module already hosts `gate.rs`, `instance.rs`, etc. — note the existing unrelated `gate.rs` is the concurrency gate; the new verb is `file gate`, no collision).

#### State Zone Mapping {#state-zone-mapping}

Non-frontend plan — no tugdeck state; omitted per skeleton.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugchanges-core/src/shell_ops.rs` | The shared command grammar (Spec S01, List L01) |
| `tugrust/crates/tugutil/src/commands/file.rs` | `tugutil file rm/mv/cp/gate` (Spec S03) |
| `tugplug/hooks/gate-file-ops.sh` | PreToolUse gate calling `tugutil file gate` ([P07]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `parse_shell_ops`, `DeclaredOp`, `DeclaredKind`, `ParseOutcome` | fn/enums | `tugchanges-core/src/shell_ops.rs` | new |
| `origin_is_proof` | fn ×2 | `tugcast/src/feeds/attribution.rs`, `tugchanges-core/src/ledger.rs` | add `"cmd"`; fix `sessions_for_path` SQL origin set to `('exact','replay','claim','cmd')` |
| `classify_op` | fn | `tugcast/src/feeds/attribution.rs` | [P06] disk-existence disambiguation |
| `OpenBracket::into_delta_rows` | fn | `tugcast/src/feeds/attribution.rs` | new `proof_paths` param ([P02]) |
| `InspectedToolResult.output` | field | `tugcast/src/feeds/attribution.rs` | `#[serde(default)]` ([Q01]) |
| `pending_cmds` map + minting arms | local state | `tugcast/src/feeds/agent_bridge.rs::relay_session_io` | see (#relay-minting-flow) |
| receipt scanner (`parse_receipt_line`) | fn | `tugcast/src/feeds/attribution.rs` | Spec S02 |
| `v1_status_map` callers / `compute_changes` | fn | `tugchanges-core/src/changes.rs` | orig-path merge ([P03]); thread `StatusEntry.orig_path` alongside the flattened map |
| `Commands::File`, `FileCommands` | enum | `tugutil/src/cli.rs` | Spec S03 |
| `hooks.json` Bash matcher | config | `tugplug/hooks/hooks.json` | append gate script |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/tracking-changes.md`: evidence table gains `cmd` (mechanism: parse∩delta live / parse+success replay / verb receipt); op vocabulary; paired-rename-rows and the read-side `orig_path` join; the untracked-delete fix; gate doctrine ("deny only the unparseable"); update the capture-origins table, invariants (proof set), and Consumers table (`tugutil file`, the gate hook).
- [ ] `tugplug/skills/draft/SKILL.md` hint-doctrine touch-up only if its wording enumerates proof origins (verify during Step 1).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Grammar table-tests (corpus-derived, including the hazard cases: quoted mentions, `cd` chains, globs, vars); `classify_op`; receipt parsing | Steps 2–4, 7 |
| **Integration** | Real-git end-to-end: frames through `relay_session_io` → rows in a scratch ledger → `compute_changes` buckets (the existing `attribution_brackets_a_real_bash_edit_end_to_end` pattern in `agent_bridge.rs` tests) | Steps 4–6, 8 |
| **Contract** | The two `origin_is_proof` copies + the schema contract test in `changes.rs` | Step 4 |
| **Scripted hook I/O** | Feed the gate script hook-JSON on stdin, assert the decision JSON | Step 9 |

#### What stays out of tests {#test-non-goals}

- App-tests — no tugdeck/tugapp surface changes; attribution is covered at the Rust layer (and changeset entries live ~2s in the app-test replay workspace, making UI-level ledger assertions structurally flaky). `just app-test-select` should confirm an empty selection.
- Real-model hook behavior (does Claude actually retry with the verb after a deny) — manual verification in a live session; not automatable without a real-claude run.
- Mock-store or synthetic-fixture tests — banned pattern; every integration test drives real git repos and real SQLite files.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Law amendment: the `cmd` origin doctrine | done | `fc57c9cd9` |
| #step-2 | `shell_ops` grammar module | done | `c4f5c15c4` |
| #step-3 | Untracked-delete op fix | done | `66b988891` |
| #step-4 | Live `cmd` minting (parse∩delta) + proof-set extension | done | `e70c9559c` |
| #step-5 | Replay `cmd` minting | done | `827e014a3` |
| #step-6 | Read-side rename lineage join | done | `7fefa9cf3` |
| #step-7 | `tugutil file` verb family | done | `a6b0d753d` |
| #step-8 | Receipt minting in the relay | done | `c6b3ae335` |
| #step-9 | tugplug gate hook | done | `2e966a39f` |
| #step-10 | Integration checkpoint | done | (verification only) |

#### Step 1: Law amendment: the `cmd` origin doctrine {#step-1}

**Commit:** `tuglaws(tracking-changes): admit cmd as a proof origin; rename lineage; gate doctrine`

**References:** [P01] cmd proof origin, [P02] parse∩delta, [P03] no schema change, [P05] paired rename rows, [P06] untracked-delete fix, [P07] gate only unparseable, (#context, #documentation-plan)

**Artifacts:**
- Amended `tuglaws/tracking-changes.md` per the Documentation Plan.

**Tasks:**
- [ ] Extend the capture-origins table with `cmd` (class: proof; mechanism: parsed literal operands ∩ bracket delta live, parse+success at replay, verb receipt) and the evidence-axiom prose with the parsed-command argument from [P01].
- [ ] Document paired rename rows, the read-side `orig_path` join, and the untracked-delete disk check.
- [ ] Update invariant 6's proof set and the Consumers table (`tugutil file`, `gate-file-ops.sh`).
- [ ] Check `tugplug/skills/draft/SKILL.md` for proof-origin enumerations; update if present.

**Tests:**
- [ ] N/A (docs).

**Checkpoint:**
- [ ] The doc's origin table, invariants, and gap inventory are mutually consistent (self-review pass); no hard-wrapped prose introduced.

---

#### Step 2: `shell_ops` grammar module {#step-2}

**Depends on:** #step-1

**Commit:** `tugchanges-core(shell-ops): conservative literal-operand command grammar`

**References:** [P08] grammar home, Spec S01, List L01, Table T01, (#corpus-findings)

**Artifacts:**
- `tugrust/crates/tugchanges-core/src/shell_ops.rs` + `pub mod shell_ops;` in `lib.rs`.

**Tasks:**
- [ ] Quote-aware tokenizer (single/double quotes, backslash escapes); heredoc-body stripping before scanning; split on `&&`, `||`, `;`, `|`; track a leading literal `cd` per segment chain.
- [ ] Implement the L01 heads and the refusal rules; resolve operands absolute against the effective directory.
- [ ] `Unparseable` only for rm/mv-class heads per Spec S01.

**Tests:**
- [ ] Table-tests drawn from the corpus samples in (#corpus-findings): literal `rm`/`git mv` chains with `cd` prefixes → `Ops`; `rm -rf apptest-*`, `rm "$WT/…"`, `mv "$LOG" "$LOG.bak"` → `Unparseable`; `tugdash commit --message "git mv a b"` → `NoFileOps` (quoted mention); `cat > path <<'EOF'` → `WriteTarget`; `sed -i '' expr f1 f2` → two `EditInPlace`; `grep rm foo` → `NoFileOps`; `… > /dev/null 2>&1` → no target.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core` green.

---

#### Step 3: Untracked-delete op fix {#step-3}

**Depends on:** #step-1

**Commit:** `tugcast(attribution): classify a vanished untracked file as deleted, not modified`

**References:** [P06] untracked-delete fix, (#read-side-rules)

**Artifacts:**
- Amended `classify_op`/`into_delta_rows` in `tugcast/src/feeds/attribution.rs`.

**Tasks:**
- [ ] `(Some(_), None)` arm: `std::fs::metadata` on the absolute path — absent → `"deleted"`, present → `"modified"`. (The delta path keys are absolute — `repo_root.join(rel)` — so the check needs no extra plumbing; if `classify_op` stays pure, do the check in `into_delta_rows` and pass the discriminator in.)

**Tests:**
- [ ] Unit: existing `classify_op_detects_appear_disappear_and_no_change` extended for both arms; real-git test: create untracked file → bracket → `rm` it → row `op="deleted"`; modify tracked file → bracket whose command commits it → row `op="modified"`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast attribution` green.

---

#### Step 4: Live `cmd` minting (parse∩delta) + proof-set extension {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugcast(attribution): mint cmd proof rows from parsed Bash operands confirmed by the bracket delta`

**References:** [P01] cmd proof origin, [P02] parse∩delta, [P05] paired rename rows, Spec S01, (#relay-minting-flow)

**Artifacts:**
- `into_delta_rows(proof_paths)` param; `pending_cmds` relay state; both `origin_is_proof` copies + the `sessions_for_path` SQL origin set.

**Tasks:**
- [ ] Add `proof_paths: &HashSet<PathBuf>` to `OpenBracket::into_delta_rows`; matched rows get `origin: "cmd"` (turn bracket passes an empty set).
- [ ] Relay: on Bash `tool_use` (live arm, `!in_replay`), run `parse_shell_ops(command, bracket.repo_root)`; store `Ops` in a size-capped `pending_cmds: HashMap<String, Vec<DeclaredOp>>`.
- [ ] At bracket close: canonicalize declared paths via `CanonicalPath::from_raw`, join against the delta keys **equal-or-under** (a declared directory matches every delta path beneath it — [P02]), pass the matched set as `proof_paths`; synthesize the old-path `renamed` row for `Move` ops whose new path made the delta ([P05]) — projected via the same per-file repo-root resolution `record_exact_pending` uses.
- [ ] Extend `origin_is_proof` in `tugcast/src/feeds/attribution.rs` AND `tugchanges-core/src/ledger.rs` with `"cmd"`; widen the SQL predicate in `ledger.rs::sessions_for_path` to `origin IN ('exact','replay','claim','cmd')` (also fixing the pre-existing `claim` omission there).

**Tests:**
- [ ] Real-git integration in `agent_bridge.rs` tests (pattern: `attribution_brackets_a_real_bash_edit_end_to_end`): a literal `rm` frame pair yields `origin="cmd"`, `op="deleted"`; a `git mv` yields two rows, one `tool_use_id`; a glob command yields plain `bash` rows; a hand-save path NOT named by the command stays `bash`.
- [ ] `rm -rf <dir>` with two files inside elevates both per-file rows to `cmd` (the equal-or-under match).
- [ ] An operand spelled through an alt path (a symlinked spelling of the repo root) still joins after canonicalization.
- [ ] `git rm --cached <path>` (which yields both a `1 D.` and a `? <path>` porcelain entry — `parse_worktree_states` is last-wins) still produces exactly one sane row.
- [ ] Contract: both `origin_is_proof` unit tests updated in the same commit; `tugchanges-core` read-side test proving a `cmd` row attributes and a `bash` row still doesn't.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugchanges-core` green.

---

#### Step 5: Replay `cmd` minting {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(attribution): backfill cmd rows from replayed Bash commands`

**References:** [P02] parse∩delta (replay half), [P05] paired rename rows, [Q01] tool_result output, (#relay-minting-flow)

**Artifacts:**
- `InspectedToolResult.output` field; replay-arm parsing in both the `replay_batch` unwrap and the live-arm-under-`in_replay` path.

**Tasks:**
- [ ] Add `#[serde(default)] pub output: String` to `InspectedToolResult`.
- [ ] Feed replayed Bash `tool_use` frames into `pending_cmds`; on the paired successful `tool_result`, mint `cmd` rows from the declared ops directly (no delta) at the frames' historical timestamps, using the [P02] replay op mapping.
- [ ] PK idempotency: re-streamed frames converge via `ON CONFLICT DO NOTHING` — no new dedup logic.

**Tests:**
- [ ] Extend the existing `attribution_unwraps_replay_batch_and_backfills_exact_rows` pattern: a batched Bash `rm` pair backfills `origin="cmd"`, `op="deleted"`, historical `at`; an errored result mints nothing; a re-streamed batch does not duplicate.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast replay` green.

---

#### Step 6: Read-side rename lineage join {#step-6}

**Depends on:** #step-4

**Commit:** `tugchanges-core(changes): renamed paths inherit proof rows written under their old name`

**References:** [P03] no schema change, [Q02] chained renames, (#read-side-rules)

**Artifacts:**
- `compute_changes` orig-path merge; orig-path threading beside `v1_status_map`.

**Tasks:**
- [ ] Thread `StatusEntry.orig_path` (already parsed by `parse_status_porcelain_v2`) into the classification loop — e.g. a parallel `path → orig_path` map built next to `v1_status_map()`.
- [ ] For a dirty renamed entry: also fetch self events and `sessions_for_path`/`foreign_proof_sessions_for_path` claims under `orig_path`, filtering old-name rows by `min_live_at_ms(repo_root, orig_path)` (each name's own liveness cut); merge into the same attributed/foreign/shared computation.

**Tests:**
- [ ] Real-git: exact-edit `A` (proof row) → `git mv A B` (no ledger rows for B) → `B` classifies attributed via the orig-path join; foreign proof under the old name marks foreign; a *committed* rename spends both names' rows (liveness).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core` green.

---

#### Step 7: `tugutil file` verb family {#step-7}

**Depends on:** #step-2

**Commit:** `tugutil(file): git-aware rm/mv/cp with attribution receipts, plus the gate verb`

**References:** [P04] verb receipts, [P07] gate only unparseable, Spec S02, Spec S03

**Artifacts:**
- `tugutil/src/commands/file.rs`; `Commands::File(FileCommands)` in `cli.rs`; module registration in `commands/mod.rs`.

**Tasks:**
- [ ] Implement `rm` (glob expansion, `git rm` for tracked / fs removal for untracked), `mv` (`git mv` vs `std::fs::rename`), `cp`, per Spec S03; receipt emission per Spec S02 (receipt only for completed ops; non-zero exit on any failure).
- [ ] Recursive ops enumerate affected files before acting — the receipt names files only, never directories (Spec S02).
- [ ] Implement `gate --command --base-dir` over `shell_ops::parse_shell_ops`; always exit 0, decision in JSON, fail-open on internal error.

**Tests:**
- [ ] Real-git unit/integration: tracked rm goes through `git rm` (index reflects it); untracked rm removes; mv preserves content and emits `orig_path`; glob rm receipt names every expanded path; gate allows literal `rm a.ts` and denies `rm -rf apptest-*` with a reason naming `tugutil file rm`.
- [ ] `file rm <dir>` on a directory of three files emits three per-file receipt ops and no directory op; `file mv <dir> <dst>` emits one paired `renamed` op per contained file.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil` green; manual: `tugutil file gate --command 'rm -rf x*'` prints a deny JSON.

---

#### Step 8: Receipt minting in the relay {#step-8}

**Depends on:** #step-5, #step-7

**Commit:** `tugcast(attribution): mint cmd proof rows from tugutil file receipts`

**References:** [P04] verb receipts, [P05] paired rename rows, Spec S02, (#relay-minting-flow)

**Artifacts:**
- Receipt scanner in `attribution.rs`; scan wiring at both Bash `tool_result` arms (live and replay).

**Tasks:**
- [ ] `parse_receipt_line(output) -> Vec<ReceiptOp>`: scan lines for the `TUG-FILE-RECEIPT: ` prefix, serde-parse the JSON, ignore unknown fields.
- [ ] On a successful Bash `tool_result` (live and replay): mint one `cmd` row per receipt op (renamed → two rows), paths projected per-file via `file_repo_root` — receipts carry absolute paths, including targets outside the session's repo, which resolve to their own repo root (the Where axiom) or store canonical-absolute off-repo.

**Tests:**
- [ ] Integration: a Bash result whose output embeds a receipt mints `cmd` rows for exactly the receipt's paths (delta not required); an errored result mints nothing; malformed receipt JSON warns and mints nothing (invariant 12 — capture failure is loud).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green.

---

#### Step 9: tugplug gate hook {#step-9}

**Depends on:** #step-7

**Commit:** `tugplug(hooks): deny unparseable file-lifecycle Bash, steering to tugutil file`

**References:** [P07] gate only unparseable, Spec S03, (#assumptions)

**Artifacts:**
- `tugplug/hooks/gate-file-ops.sh` (executable); amended `tugplug/hooks/hooks.json` Bash matcher.

**Tasks:**
- [ ] Script: read hook JSON from stdin (same I/O contract as `auto-approve-tug.sh`), extract `tool_input.command`, call `tugutil file gate --command …`; on `{"decision":"deny"}` emit `hookSpecificOutput.permissionDecision: "deny"` with the reason; otherwise `exit 0` (fall through). Missing `tugutil` or invalid gate output → `exit 0` (fail open).
- [ ] Append the script to the existing Bash matcher's `hooks` array in `hooks.json` (both hooks run; deny wins over the auto-approver's allow).

**Tests:**
- [ ] Scripted I/O: pipe crafted hook JSON for `rm -rf apptest-*` → deny JSON with a reason naming the verb; `rm a.ts` → exit 0 no output; `grep rm foo` → exit 0; absent `tugutil` on PATH → exit 0.

**Checkpoint:**
- [ ] `printf '%s' '<hook-json>' | tugplug/hooks/gate-file-ops.sh` behaves per the tests above (run for each case).

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-6, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P08]

**Tasks:**
- [ ] Verify the success-criteria list end-to-end on the dash worktree build.
- [ ] Confirm `just app-test-select` reports no app-tests implicated (no tugdeck/tugapp sources touched); if any are, run them.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` (full workspace) green under `-D warnings`.

**Checkpoint:**
- [ ] Full-workspace nextest green; a manual smoke in a live debug session: literal `rm` attributes, glob `rm` is denied and the retried `tugutil file rm` attributes via receipt.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Shell-driven deletes, moves, and writes with literal or receipt-resolved operands are proof-class attributed (origin `cmd`), renamed paths keep their attribution across the move, and the only remaining unattributed residue is genuinely opaque mutation (inline scripts, builds) — visible, hinted, never silent.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every Success Criterion in (#success-criteria) verified on the dash build.
- [ ] `tuglaws/tracking-changes.md` and the code agree: origin tables, proof sets, op vocabulary, consumers.
- [ ] Full-workspace `cargo nextest run` green; no app-test regressions per the derived selection.

**Acceptance tests:**
- [ ] The Step 4/5/6/8 integration tests (parse∩delta, replay backfill, rename lineage, receipts) all green.
- [ ] The Step 9 hook I/O cases all pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Measure the unattributed-bucket rate over a week of real use; revisit [Q02] (chained renames) and `sed -i` xargs-style variants if they show up.
- [ ] A CLAUDE.md / skill-doc nudge toward `tugutil file` for bulk operations (behavioral, optional — nothing depends on it).
- [ ] Consider surfacing `cmd`-origin provenance distinctly in the Changes card if users want to see "proved by command" vs "proved by edit".

| Checkpoint | Verification |
|------------|--------------|
| Grammar covers the corpus head | Step 2 table-tests drawn from Table T01 samples |
| No wrong proof, ever | Step 4 negative tests (glob → bash origin; unnamed path stays bash) |
| Replay heals history | Step 5 backfill test at historical timestamps |
| Renames keep attribution | Step 6 real-git `git mv` test |
| Hard 20% covered by receipts | Step 7+8 glob receipt round-trip |
| Friction only where correlation was the ceiling | Step 9 gate cases (literal allowed, glob denied) |
