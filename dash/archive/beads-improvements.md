# Beads Improvements: Idempotency, Naming, and Worktree Isolation

## Problem Statement

Three issues with the current beads integration need fixing:

1. **Sync is not idempotent.** Running `tugcode beads sync` twice creates duplicate beads. The system collects known bead IDs from the plan file's metadata/step fields, but since sync no longer writes bead IDs back to the plan file, a second run finds no IDs to check against, and creates everything fresh.

2. **Bead names are poorly formatted.** The real `bd` generates IDs like `tugtool-imw` with only 3 characters of randomness. The `bd-fake` test mock generates `bd-fake-1`, `bd-fake-2` (sequential). Both are problematic: the 3-char suffix has too little entropy, and the project-name prefix wastes characters that could carry meaningful context (like branch name).

3. **`.beads/` lives on main, not in the worktree.** `bd init` runs against `repo_root` (line 596 of `worktree.rs`), creating `.beads/` in the main checkout. All `bd` commands walk up the directory tree to find this database. This means implementation work leaks state into main, violating the principle that `/tugplug:implement` runs should be fully isolated to their worktree.

## Current Architecture

### Sync Flow (`sync.rs`)

1. Collects `known_ids` from `plan.metadata.beads_root_id` and each `step.bead_id`
2. Batch-queries `bd list --id <ids>` to build `existing_ids` HashSet
3. For each step, calls `ensure_step_bead()` which checks `existing_ids` — reuses if found, creates if not
4. Creates dependency edges for newly-created beads

**Root cause of non-idempotency:** Step 1 only finds IDs if they're already in the plan file. Since the policy is "plan files are never modified by sync" (per `tugplug/CLAUDE.md`), `known_ids` is always empty on a second run, so `existing_ids` is empty, so every bead gets recreated.

### Bead Naming (`bd init`)

Real `bd` init output:
```
Issue prefix: bd-test
Issues will be named: bd-test-<hash> (e.g., bd-test-a3f2dd)
```

Actual IDs observed: `tugtool-imw`, `tugtool-qvp`, `tugtool-8he` — only 3 hex-ish chars.

### Worktree Init (`worktree.rs:574-604`)

```rust
// Ensure beads is initialized in the project root.
if !beads.is_initialized(&repo_root) {
    beads.init(&repo_root)?;
}
```

`is_initialized()` walks up from `project_root` looking for `.beads/` directory. `bd init` creates `.beads/` in the specified working directory — which is `repo_root` (main checkout), not the worktree.

## Proposed Solutions

### Fix 1: Make Sync Idempotent via Title-Based Matching

**Strategy:** Instead of relying on bead IDs stored in plan files, use a deterministic lookup to find existing beads before creating new ones. Query the root bead's children and match by title.

**How it works:**

1. First, resolve the root bead:
   - If `plan.metadata.beads_root_id` is set and the bead exists → reuse it
   - Otherwise, query `bd list` and match by title (the phase title is unique per plan)
   - If no match → create it

2. For each step, query the root bead's children via `bd dep list <root_id> --direction down` or the `children()` method, and match by the step title pattern `"Step N: <title>"`.
   - If a child bead matches → reuse it (and add to `existing_ids`)
   - If no match → create it

3. Same for substeps: query the parent step bead's children and match.

**Why title-based matching works:**
- Step titles are unique within a plan (enforced by the anchor system)
- The title format `"Step 0: Setup"` is deterministic from the plan content
- No external state needed — the beads database *is* the source of truth

**Changes required:**
- `sync.rs`: Replace the `known_ids` → `list_by_ids` approach with root-resolution + children-matching
- `beads.rs`: May need a `list_with_filter()` or `find_by_title()` helper (or reuse `children()` which already exists)
- `beads_integration_tests.rs`: Un-ignore `test_beads_sync_is_idempotent` and make it pass

**Edge cases:**
- Plan title changes between syncs → creates new root, orphans old one. Acceptable: title changes are rare and manual cleanup is fine.
- Step title changes → creates new step bead. Same rationale.
- Deleted steps → orphaned beads remain. Same as today, no regression.

### Fix 2: Better Bead Naming

The 3-char suffix (~46K combinations) is fine for uniqueness within a single project's beads. The real issue is the **prefix**. `bd init` defaults to the current directory name, so beads in this project get IDs like `tugtool-imw`. That's wasted characters — we already know we're in tugtool. The prefix should carry meaningful context, like which plan is being implemented.

`bd init --prefix <name>` controls the prefix. We should derive it from the plan slug so bead IDs are self-documenting. For example, `tugplan-auth.md` → prefix `auth` → IDs like `auth-imw`, `auth-imw.1`, `auth-imw.2`.

**Proposed change:**
- In `worktree.rs` where `beads.init()` is called, derive a short prefix from the plan slug (e.g., `tugplan-auth.md` → `auth`)
- Update `BeadsCli::init()` to accept an optional prefix parameter and pass it as `bd init --prefix <slug>`
- Update `bd-fake` to accept `--prefix` and use it in ID generation

### Fix 3: Move `.beads/` Into the Worktree

**This is the most impactful change.** Currently all worktrees share a single `.beads/` database at repo root. Each implementation run should have its own isolated beads database.

**Proposed approach:**

1. **Init beads in the worktree, not repo root.** Change `worktree.rs:595-596` from:
   ```rust
   if !beads.is_initialized(&repo_root) {
       beads.init(&repo_root)?;
   }
   ```
   to:
   ```rust
   beads.init(&worktree_path)?;
   ```

2. **Pass `--working-dir` consistently.** All `BeadsCli` calls from the worktree context must pass the worktree path so `bd` finds the local `.beads/` database instead of walking up to find one in a parent directory. Review all call sites:
   - `sync_beads_in_worktree()` — already sets `current_dir(worktree_path)` ✓
   - Agent commands (`tugcode beads inspect`, `append-design`, etc.) — already use `--working-dir` ✓
   - `bd ready` call at line 818 — currently uses `None` for working_dir, needs to pass `Some(&worktree_path)`

3. **Exclude `.beads/` from git in worktrees.** Add `.beads/` to `.gitignore` (it's a local database, not a tracked artifact). This prevents the beads SQLite database from being committed to the branch.

4. **Update the merge skill.** The merge skill currently mentions `.beads/` in its infrastructure diff section. After this change, `.beads/` is per-worktree and disposable — it gets cleaned up with the worktree.

5. **Remove the walk-up logic from `is_initialized()`.** Since each worktree has its own `.beads/`, the walk-up search is no longer needed. `is_initialized()` should check only the given path:
   ```rust
   pub fn is_initialized(&self, project_root: &Path) -> bool {
       project_root.join(".beads").is_dir()
   }
   ```

**What about standalone `tugcode beads sync` (outside worktrees)?** The standalone sync command (run directly by users on main) still needs `.beads/` somewhere. Two options:
- (a) Init `.beads/` in the project root when running standalone, same as today.
- (b) Only support beads sync within worktrees (since that's the only real use case).

**Recommendation: Option (a)** — keep standalone sync working for debugging/exploration, but the primary path remains worktree-based. The key principle is: `worktree create` inits beads *in the worktree*, not at repo root.

## Implementation Order

1. **Fix 3 first** (worktree isolation) — this is the most important correctness fix and changes where `.beads/` lives
2. **Fix 1 second** (idempotent sync) — builds on the new per-worktree model
3. **Fix 2 last** (naming) — smallest impact, partially depends on `bd` upstream

## Testing Strategy

- Un-ignore `test_beads_sync_is_idempotent` and make it pass
- Un-ignore `test_beads_status_computes_readiness` (requires bead IDs to be discoverable)
- Add test: `test_beads_sync_in_worktree_does_not_touch_repo_root` — verify no `.beads/` at repo root after worktree create
- Add test: `test_beads_sync_idempotent_with_title_matching` — two syncs produce same bead count
- Update `bd-fake` to support `--prefix` if implementing Fix 2b

## Risk Assessment

- **Fix 3** changes the fundamental beads lifecycle. All agent `--working-dir` paths must be correct. The safety net is that agents already pass `--working-dir` in their commands (verified in agent .md files).
- **Fix 1** changes sync behavior. A plan that previously silently created duplicates will now silently reuse. This is strictly better.
- **Fix 2** is cosmetic and low-risk.
