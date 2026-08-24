# Rename plan worktree prefix to `tugplan/`

## Context

Plan worktrees now use `tugplan/` as their branch prefix (e.g., `tugplan/auth-20260208-143022`), producing directory names like `.tugtree/tugplan__auth-20260208-143022`. The dash feature uses `tugdash/` (e.g., `tugdash/my-task` → `.tugtree/tugdash__my-task`). Worktrees are named with *either* `tugplan/` or `tugdash/` prefixes.

## Changes

### 1. Production code in `tugcode/crates/tugtool-core/src/worktree.rs`

All string literal replacements (branch prefix changed from old prefix to `tugplan/`):

| Line | New value |
|------|-----------|
| 132 | `strip_prefix("tugplan/")` |
| 208 | `format!("tugplan/{}-{}", ...)` |
| 688 | `starts_with("tugplan/")` |
| 822 | `format!("tugplan/{}-", slug)` |
| 910 | accepts `.tugtree/tugplan__` or `.tugtree/tugdash__` |
| 921 | `["branch", "--list", "tugplan/*"]` |

Update doc comments/examples referencing `tugplan/` branch names (lines 124-130, 205, 687, 779-785, 810, 900-903, 913-915).

Rename `list_tugtool_branches` → `list_tugplan_branches` (line 917).

### 2. Export in `tugcode/crates/tugtool-core/src/lib.rs`

Line 69: renamed `list_tugplan_branches` in the re-export.

### 3. Callers of `list_tugplan_branches`

- `tugcode/crates/tugcode/src/commands/merge.rs` line 14 (import) and line 984 (call): renamed to `list_tugplan_branches`
- `tugcode/crates/tugcode/src/commands/doctor.rs` line 311: changed to check for `"tugplan__"` or `"tugdash__"`, line 356: renamed call to `list_tugplan_branches`

### 4. Tests in `worktree.rs` (~52 occurrences)

All test string literals and assertions updated to use `tugplan/` branch prefix and `tugplan__` directory prefix.

### 5. Tests in `merge.rs` (~8 occurrences) and `worktree.rs` commands (~2 occurrences)

Same update in test fixtures that reference `tugplan/` branch names.

## Verification

```bash
cd tugcode && cargo build
cd tugcode && cargo nextest run
cd tugcode && cargo fmt --all --check
```

Grep to confirm no stale references remain:
```bash
grep -rn 'tugplan/' tugcode/crates/ --include='*.rs' | grep -v '\.tugtool/'
grep -rn 'tugplan__' tugcode/crates/ --include='*.rs'
```
(Both should return zero matches for any residual old-prefix patterns.)
