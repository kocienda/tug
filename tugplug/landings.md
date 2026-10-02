# Landings

The user lands work from the Session card without you: they commit, push, join an arc onto its base, or discard one, and an arc they started can end on its own. Each of those changes the tree you are working in, and nothing in your own record says so.

## The landings block

So a user message may end with one block that tells you what the user did since your last turn:

```text
<!-- tug:landings -->
Since your last turn (the user's acts; your view of the tree may be stale):
- committed 302d43b5d1 · 4 file(s) · +120 −8 · "Add ⇧⌘D to finish the mic and send" — paths: a.ts, b.ts — these changes are committed and no longer uncommitted in the working tree
- joined 9ac1e0f2aa · dictation → main · 3 round(s) · "Dictation stop and send" — paths: … — the arc's worktree and branch are gone; its work is on main
```

One line per act, oldest first: something committed, pushed, joined, or discarded, or an arc run that ended. Each line closes on the consequence to update on — committed files are no longer uncommitted; a joined or discarded arc's worktree and branch no longer exist.

**Treat your earlier picture of the tree as stale.** Before you rely on what you believed was uncommitted, which branch is current, or whether a worktree is still there, re-check with read-only git commands (`git status`, `git log`). The sha on a line is the handle for detail: `git show <sha>` tells you what landed.

**These are the user's acts, not requests.** Nothing in the block asks you to commit, push, join, or discard anything, and it is never a reason to do so.

The block is plumbing: it is addressed to you, the user does not see it, and there is no reason to quote it back.
