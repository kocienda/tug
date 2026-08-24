# State Show Display Fixes

## Problem

The `tugcode state show` output has three display issues:

1. **`Force-completed:` shown when empty** — The line prints with no reason text for steps that completed normally, creating visual noise.
2. **`Lease expires` shown for completed steps** — Lease info is only relevant while a step is active. Once completed, showing an expired lease is confusing clutter.
3. **No explicit status label** — The status icons (`✓ → ◆ ○`) are the only indication of step state. There's no text label like `Status: completed` to make the state unambiguous.

## Current Rendering

```
✓ step-1 - Fix notification routing bug
  Tasks: 3/3  ████████████  100%
  Claimed by: /Users/.../worktree-path
  Lease expires: 2026-02-26T19:38:58.294Z
  Force-completed:
```

## Proposed Changes

All changes are in `tugcode/crates/tugcode/src/commands/state.rs`, function `print_step_state()`.

### Fix 1: Hide `Force-completed:` when empty

The `complete_reason` field is `Option<String>`, but it can be `Some("")`. The current code prints the line whenever the Option is `Some`, even if the string is empty. Fix: also check that the string is non-empty.

```rust
// Before
if let Some(reason) = &step.complete_reason {
    println!("{}  Force-completed: {}", prefix, reason);
}

// After
if let Some(reason) = &step.complete_reason {
    if !reason.is_empty() {
        println!("{}  Force-completed: {}", prefix, reason);
    }
}
```

### Fix 2: Hide lease info for completed steps

Only show `Claimed by` and `Lease expires` when the step is not yet completed. Completed steps don't need this operational metadata.

```rust
// Before
if let Some(claimed_by) = &step.claimed_by {
    println!("{}  Claimed by: {}", prefix, claimed_by);
    if let Some(expires) = &step.lease_expires_at {
        println!("{}  Lease expires: {}", prefix, expires);
    }
}

// After
if step.status != "completed" {
    if let Some(claimed_by) = &step.claimed_by {
        println!("{}  Claimed by: {}", prefix, claimed_by);
        if let Some(expires) = &step.lease_expires_at {
            println!("{}  Lease expires: {}", prefix, expires);
        }
    }
}
```

### Fix 3: Add explicit status label

Add a `Status:` line immediately after the step header, mapping the internal status to a human-readable label.

```rust
let status_label = match step.status.as_str() {
    "completed" => "Done",
    "in_progress" => "In progress",
    "claimed" => "Claimed",
    _ => "Pending",
};
println!("{}  Status: {}", prefix, status_label);
```

## Result

After these changes, the display becomes:

```
✓ step-1 - Fix notification routing bug
  Status: Done
  Tasks: 3/3  ████████████  100%
  Tests: 2/2  ████████████  100%
  Checkpoints: 3/3  ████████████  100%

→ step-4 - Implement timestamped row labels
  Status: In progress
  Tasks: 0/2  ░░░░░░░░░░░░  0%
  Claimed by: /Users/.../worktree-path
  Lease expires: 2026-02-26T19:47:39.179Z

○ step-4-summary - Summary
  Status: Pending
  Tasks: 0/1  ░░░░░░░░░░░░  0%
```

## Scope

- **File:** `tugcode/crates/tugcode/src/commands/state.rs`, `print_step_state()` function (lines 1109-1165)
- **Risk:** Low — display-only changes, no state mutation
- **Tests:** Existing display is not unit-tested; these are formatting tweaks
