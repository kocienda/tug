# `tugutil dash join` — silent success + unresolvable add/add (notes)

Captured while merging the `focus-by-construction` dash. Two distinct problems surfaced; both are tabled for a later tooling pass.

## What happened

`tugutil dash join focus-by-construction` printed `Joined dash 'focus-by-construction' to branch 'main'` and exited `0`, but merged nothing — `main` stayed at its pre-join HEAD, and the dash remained `active` with its branch and worktree intact. The join had actually hit a conflict and bailed, but reported success.

The conflict was an **add/add** on two plan docs:

- `dash/focus-by-construction.md`
- `dash/focus-system-state.md`

Both files were committed to `main` as *drafts* (`807fcfab6 plan(new): new plans`, all-`pending` ledger, no supersession banner) and *also* evolved on the dash into their completed forms. The merge base (`2f7e53a24`) had neither file, so a 3-way merge had no ancestor version to reconcile against — git cannot auto-resolve an add/add with no base, and the dash's versions were a strict superset of the drafts anyway.

## How it was resolved (this time)

`807fcfab6` touched *only* those two draft docs, so the fix was to drop it (`git reset --hard 8d2e7ce0a` on the local, unpushed `main`) and re-run the join. With `main` no longer carrying the drafts, the join saw `"conflicts": []`, landed a real squash commit (`5ded6b537`), and tore the dash down normally. Undo point was `807fcfab6fb`.

## The two bugs worth fixing

1. **Silent success on an unmerged conflict.** A `join` that conflicts and merges nothing must fail loudly — the same way the default `commit` path exits `3` and lists the unresolved paths on stderr. Reporting `Joined … exit 0` on a no-op is the worst failure mode: it looks done when it isn't.

2. **Add/add on plan docs is a recurring trap.** Any dash whose plan (or a companion doc) was committed to `main` as a draft *before* the dash completes it will hit this: base lacks the file, both sides add it, no common ancestor. Two candidate fixes, not exclusive:
   - Don't commit a draft plan to `main` before dashing it — let the dash own the file end to end, so the join is a pure add.
   - Teach the `--resolve` ladder to treat an **identical-origin add/add** (the dash's file descends from `main`'s draft copy) as "take the dash side," since the dash version is by construction the superset.

## Status

Tabled. The `focus-by-construction` work is merged to `main` and verified (`tsc` clean on the merged tree); this note exists only so the tooling gaps aren't lost.
