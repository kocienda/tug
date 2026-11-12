# The commit message leaks into the Prompt tab

**Purpose:** A commit message written in the Changes tab can turn up in the Prompt tab, most often after a transcript restore or a relaunch, and the prompt that was there is lost. Close every way one tab's text can reach the other.

---

## Purpose {#purpose}

The report, in the user's words: "Commit messages from the Changes tab can be moved incorrectly to the Prompt tab, especially on relaunches or reloading a transcript. … this typically takes a transcript restore, but I want to close down all avenues, and in any case: this is bad and wrong."

Two harms ride together. The commit message appears where a prompt belongs, and the prompt the user had typed before opening Changes is destroyed, because it was never saved anywhere.

---

## Evidence {#evidence}

Every finding below was read out of the code. None was reproduced in the running app; the first test of the work is the reproduction.

**[F01] The two tabs share one editor and one document.** Entering a landing mode stashes the prompt in a React ref, `preCommitDraftRef`, and overwrites the document with the message; leaving restores the stash. The swap is a layout effect keyed on `landingActive` at `tugdeck/src/components/tugways/cards/prompt-entry.tsx:1706`. Nothing outside that effect knows which document is on screen. **(verified by reading)**

**[F02] The card-state save captures whatever is on screen.** `onSave` at `prompt-entry.tsx:3765` calls `editor.captureState()` and files the result as the prompt `draft`, with no landing check. It also writes the same value to `lastKnownDraftRef`, which is forwarded when no editor is mounted. While Changes is up, both hold the commit message. **(verified by reading)**

**[F03] Opening Changes is enough to dirty the card.** The editor's update listener calls `markDirtyRef.current()` on every document change (`prompt-entry.tsx:2520`), and the seed written on entering the mode is a document change. So opening Changes over an existing drafted message, without typing, schedules a save that puts the message in the card's bag. Leaving the mode restores the stash, which dirties the card again and overwrites the bad save; that corrective save is why the bug is usually invisible. **(verified by reading)**

**[F04] A transcript restore unmounts the composer and both landing controllers.** `SessionCardServicesGate` returns the restoring backdrop in place of `SessionCardBody` whenever `transportState === "restoring"` (`tugdeck/src/components/tugways/cards/session-card.tsx:818`). The controllers are refs inside `SessionCardBody` (`session-card.tsx:1824`, `:1853`), so the stash and the mode's `active` flag are both gone. When the body remounts, `CardHost` counts a second real registration, resets `hasAppliedContentRestoreRef`, and replays the bag (`tugdeck/src/components/chrome/card-host.tsx:909`, `:1069`). With the mode now closed, the bag's draft, which is the commit message, lands in the Prompt tab. This is the reported case. **(verified by reading)**

**[F05] A relaunch does the same.** The mode is in-memory only. A quit while Changes is up, or inside the save debounce after leaving it, persists the commit message as the draft, and the next launch restores it as the prompt. The other save sources reach the same `onSave`: card deactivation, `flushCardStateNow`, the `saveState` RPC and the HMR save pass. **(verified by reading)**

**[F06] The termination save appends unsent prompts to the on-screen document.** On `source === "termination"`, queued sends and a pulled-back submission are appended to `draft` (`prompt-entry.tsx:3803`). In a landing mode they are appended to the commit message text. **(verified by reading)**

**[F07] A pulled-back prompt can land in the commit editor.** The `pendingDraftRestore` effect seeds the editor whenever it is effectively empty (`prompt-entry.tsx:1562`), with no landing check. With an empty commit message, a cancelled send is written into the commit editor, and the next user keystroke persists it as the commit message through the debounced `persistMessage`. **(verified by reading)**

**[F08] The command inserts replace the document with no mode check.** `pendingCommandInsert` (`prompt-entry.tsx:1999`) and `seedCommandChip` (`prompt-entry.tsx:3926`) both `restoreState` over whatever is on screen. Whether a `submit: true` insert can reach `performSubmit` while a landing is up, and so land a commit whose message is a command line, was not traced. **(the unguarded writes are verified; the submit path is inference)**

**[F09] A restore can write the prompt over an open landing.** `onRestore` (`prompt-entry.tsx:3831`) restores the saved draft into the editor without asking whether a landing is up, and stashes it in `pendingActivationDraftRef`, which the engine hook applies later at activation. A composer that remounts while its controller is still active would have its message overwritten by the saved prompt. No door that produces this today was found; it is an unguarded write of the same class. **(the write is verified; reachability is inference)**

**[F10] A commit-to-join handoff does not swap the document.** `JoinModeController.enter` exits commit mode and activates join in one tick (`tugdeck/src/lib/join-mode-controller.ts:653`), and `session-card.tsx:5527` hands the composer whichever controller is live. `landingActive` stays true across the change, so the swap effect does not run and the commit message stays on screen as the join message. Which UI door reaches this while commit mode is up was not confirmed. **(the mechanism is verified; reachability is inference)**

**[F11] A composer that unmounts mid-landing drops the last keystrokes of the message.** The debounced `persistMessage` timer is cleared on unmount (`prompt-entry.tsx:1697`) and nothing flushes it, so edits newer than the last debounce are lost in the [F04] case. **(verified by reading)**

**[F12] One comment describes a guard that does not exist.** The header of `tugdeck/src/lib/commit-mode-controller.ts` says "the composer force-exits on deactivate so the editor's own persistence only ever sees the prompt draft". No force-exit exists anywhere under `tugdeck/src`. **(verified by grep)**

---

## Decisions {#decisions}

**[B01] The prompt draft has one owner, and what is on screen never decides what it is.** This is the invariant the rest of the work serves. Every finding above is a reader or a writer that took the on-screen document for the prompt.

**[B02] One read seam.** A single function in the composer returns the prompt draft: the stash while a landing is up, the live editor otherwise. `onSave`, `lastKnownDraftRef` and the termination append read through it and through nothing else. This closes [F02] through [F06], and with them the reported case. The stash is the right source because it is the prompt exactly as the user left it; reading it also means the prompt survives a restore or relaunch that happens mid-landing, which repairs the second harm.

**[B03] One write seam.** A single function writes the prompt draft: into the stash while a landing is up, into the editor otherwise. `onRestore`, the `pendingActivationDraftRef` replay, the pulled-back prompt, `pendingCommandInsert` and `seedCommandChip` write through it. This closes [F07], [F08] and [F09]. A prompt-addressed write that arrives during a landing is held and shows when the user returns to the Prompt tab; it is never dropped and never shown in the commit editor.

**[B04] A command insert that carries `submit` does not submit while a landing is up.** It goes through the write seam like any other prompt write. Whether it then waits for the Prompt tab or leaves the landing first is a call for the work to make once the path in [F08] is traced; the fixed part is that it never reaches the land path.

**[B05] Atom insert stays as it is.** `pendingAtomInsert` drops a chip at the caret of whatever is on screen, and a chip in a commit message is intended behaviour (the composer's own `readCommitSubstrate` exists to carry them). It is not a leak and is not routed through the seam.

**[B06] The swap is keyed on which controller is live, as well as on the flag.** A change of landing controller while a landing is active is treated as an exit followed by an enter: the outgoing message is persisted through the outgoing controller, the stash is kept, and the document is reseeded from the incoming controller. This closes [F10] without needing to know which door reaches it.

**[B07] A composer unmounting mid-landing persists the typed message.** The same write `leave()` makes, fired from the unmount cleanup in place of the bare timer clear. This closes [F11].

**[B08] The stale comment is corrected.** The header of `commit-mode-controller.ts` is rewritten to say what is true after this work: the mode is in-memory, and the composer's read seam is what keeps persistence on the prompt draft.

**[B09] The fix is verified by tests that would have been red before it.** A unit test asserts that `onSave` returns the stashed prompt while a landing is up, on the ordinary and the termination source. An app-test types a prompt, opens Changes, types a message, drives the transport through `restoring`, and asserts the Prompt tab holds the prompt and Changes holds the message. A second covers the same across a relaunch. Each new app-test carries `@covers` for `prompt-entry.tsx`.

---

## Non-goals {#non-goals}

- **Separate editors, or a second CodeMirror state per tab.** It makes the leak impossible by construction, and it was considered. The user held it off: the two seams close every avenue found, with a much smaller change, and the second-state route touches undo history, focus and the height-borrowing logic. The user will live on the seam fix for a while; this is the option to return to if a leak appears that the seams did not anticipate.
- **Repairing bags already saved with a commit message in them.** A contaminated bag is indistinguishable from a real prompt, so a card saved wrong before this lands will show the message once more. Nothing scrubs it.
- **Persisting the landing mode across a restore or relaunch.** The mode stays in-memory. After a restore the card comes back on the Prompt tab with the prompt intact, and the message is waiting in Changes.

---

## Exit {#exit}

**An arc.** The read seam comes first, because it alone fixes the reported case and its unit test is the cheapest proof the diagnosis is right. The write seam follows, with the trace of the `submit` path from [F08] settling [B04]. The controller-identity keying and the unmount flush are independent of both and of each other. The comment fix rides whichever step touches the controller. The app-tests land last, once, as the verdict; `prompt-entry.tsx` has wide reach, so the step's own files are the selection.
