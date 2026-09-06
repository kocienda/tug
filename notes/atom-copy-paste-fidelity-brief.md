<!-- brief-skeleton v1 -->

# Atom copy/paste fidelity

**Purpose:** An atom that is copied anywhere in Tug must paste back as the same atom anywhere in Tug, and must survive whatever the destination does with it afterwards. Today a commit pill copied out of a transcript pastes as broken code spans, and a file chip pasted into a Jot is gone the next time the Jot is opened. This brief is the audit of every seam where that rule breaks and the calls needed to close them all at once rather than one report at a time.

---

## Purpose {#purpose}

The rule, in the user's words: *within Tug, we must always maintain full fidelity with copied and pasted atoms.* Two reports prompted the audit:

- A `commit:64747b8c` pill selected in a transcript paragraph and pasted into the prompt entry arrives as `` `commit:``64747b8c` `` — two code spans, no pill, and not even the one-token spelling the doctrine says a commit copies as.
- A `CLAUDE.md` chip pasted into a Jot draws correctly, but closing and reopening the Jot shows `foo ` with the chip gone.

The user asked for a 360° audit rather than two fixes, because the general rule is what is broken. The audit below reads every copy door (selection ⌘C, menu Copy, a row's COPY button, an identity menu's copy items), every paste door (the editor's responder paste, the DOM `paste` event, the native bridge read), and every place a pasted atom has to *live* afterwards (the prompt draft, a Jot, a question answer, a commit message, the wire).

---

## Evidence {#evidence}

The substrate is one shape everywhere: text with a `U+FFFC` at each atom position and a parallel `atoms` array (`tugdeck/src/lib/atom-text.ts`). Copy writes that pair as a sidecar on the Tug-private `dev.tugapp.prompt-atoms` pasteboard type beside a `text/plain` flavor; paste reads the sidecar back through `parseClipboardSidecar` and `insertSidecar` (`tug-text-editor/clipboard-filters.ts`). Both halves are sound. Every failure below is at an edge of that machinery, not inside it.

**[F01] The prose commit pill is invisible to the selection serializer** — `selectionToTranscriptSubstrate` (`lib/markdown/serialize-selection.ts`) recognises a chip solely by the `data-atom-type` / `-label` / `-value` trio. The pill a confirmed commit mention wears is mounted by `useCommitTipPortals` (`components/tugways/commit-tip-portals.tsx:223`) as a bare `<TugCommitAtom sha=… />`, and `tug-commit-atom.tsx` emits `data-slot`, `data-tier`, `data-interactive`, `data-missing` and nothing else. So the serializer walks *into* the pill and reads its two inner spans (`tug-commit-atom-word`, `tug-commit-atom-hash`) as two prose runs. No sidecar entry is written, so the paste is text. The two mounts that do pass the trio through (`tug-atom-markdown-body.tsx:358`, `tug-atom-text-body.tsx:210`) are the *placed* commit atoms; the portal mount, which is the one the user selected, is the only one that does not. **(verified)** — by reading the grep of every `data-atom-type` writer in `tugdeck/src`; the portal is absent from the list.

**[F02] Marks are applied per text run, not per styled span** — `applyMarks` in `serialize-selection.ts` wraps each `Run` independently, and a run is one DOM text node. Two text nodes under one `<code>` therefore each earn their own backticks, which is exactly the `` `commit:``64747b8c` `` in the report: the mention's backticks put the pill inside a `<code>`, and the pill's word and hash are separate text nodes. Fixing [F01] alone makes this case disappear, but the defect is general — any inline element the annotator or a portal splits into several text nodes inside one `<code>`, `<strong>` or `<a>` will serialise as N adjacent marked spans. **(verified for the commit case; the general case is inference)** — a unit test over a `<code>` holding two text nodes would confirm it.

**[F03] The substrate copy spells a commit atom as a markdown link with a sha for a URL** — `formatAtomTextForCopy` (`lib/atom-text.ts`) has one rule: emit the bare label when `value === label`, else `[label](<value>)`. A commit atom's label is `commit:64747b8c` and its value is the sha, so the `text/plain` flavor of a user-turn COPY, a placed-pill selection copy, or a receipt copy is `[commit:64747b8c](<64747b8c>)`. The doctrine (`tuglaws/entity-presentation.md`, "An atom labels itself") and [D174] both say the plain spelling is `commit:<8>`, and `atomPlainTextFor` (`lib/annotator/atom-segment.ts`) already encodes that — but only the annotation menu calls it. The editor's own copy (`serializeClipboard` fallback) uses a third rule, `chipDisplayLabel`, which writes the bare label. Three functions answer "what does this atom look like as plain text" and they disagree for commits and for sessions (the menu writes the session *citation*; the other two write `project/tag`). **(verified)** — by reading the three functions; not reproduced on the pasteboard.

**[F04] A Jot persists text only, so an atom pasted into one is lost on reopen** — the Jot editor is `TugMessageEditor` (`components/jots/jots-card.tsx:857`) over the real `TugTextEditor`, so the shared paste path inserts a chip faithfully. But `TugMessageEditor`'s mirror fires `onChange(update.state.doc.toString())` (`tug-message-editor.tsx:254`), the store saves that string (`jots-store.ts:171` `updateJot(id, text)`), the `Jot` record has only `id`, `text`, `origins` (`lib/jots-doc.ts`, mirrored by `tugcast/src/jots.rs:38`), and the reopen seeds `restoreState({ text, atoms: [], selection: null })` (`tug-message-editor.tsx:261`). The chip cannot come back because nothing recorded it. **(verified)** — by reading; the on-disk `jots.json` was inspected and holds no `U+FFFC` today, so whether the placeholder character itself is saved in the text (nothing in the jot layer strips it) is **inferred**. Pasting a chip into a Jot and grepping `jots.json` for the byte sequence `EF BF BC` would confirm it.

**[F05] Every `TugMessageEditor` host has the same hole, not just the Jot** — the question wizard's free-text answer and reply fields (`chrome/session-question-dialog.tsx:1022`, `:2137`) and the prompt entry's commit-message mode (`buildCommitModeState` restores with an empty atom list, `tug-prompt-entry.tsx:692`) all accept the shared paste and all mirror out a bare string. A chip pasted into a question answer is submitted to Claude Code as whatever `doc.toString()` holds. **(inference)** — the paste path is shared by construction; that the answer string reaches the wire with a placeholder in it has not been reproduced.

**[F06] A lost atom leaves a placeholder that travels** — nothing in the Jot layer, `insertJot` (`lib/code-session-store.ts:1522`), the Jot drag (`lib/jot-drag.ts` carries `text/plain` only, dropped as text at `drop-extension.ts:1092`), or `copyJotText` (`jots-card.tsx:149`, text plus origins, no sidecar) knows about atoms, so a Jot that once held one hands a bare `U+FFFC` to the prompt, and `buildWirePayload` passes an unpaired placeholder through to the model by design (its defensive [S03] branch). The Jot bug is therefore not contained to the Jot. **(verified by reading; inferred end-to-end)**

**[F07] Placed commit pills outside the two transcript bodies carry no atom identity either** — the `/commit` receipt, the join receipt, the arc receipt and the History shade render `TugCommitAtom` directly and none passes the `data-atom-*` trio (`grep` over `session-commit-receipt-block.tsx`, `session-join-receipt-block.tsx`, `session-arc-receipt-block.tsx`, `tug-history-list.tsx` finds no `data-atom`). A selection dragged across a receipt header copies `commit:64747b8c` as two prose words with no sidecar. **(verified)**

**[F08] The two identity menus disagree about the clipboard** — the session menu's Copy Citation writes the session atom sidecar through `writeSessionAtomToClipboard` (`session-identity-menu.tsx:232`); every other item there and *every* item in `commit-identity-menu.tsx:126-132` (hash, short hash, subject, record) is a bare `navigator.clipboard.writeText` — no sidecar, no origin stamp, and the Safari permission popup outside the bridge. There is no "Copy as Atom" on a commit pill in a receipt or History row; the only way to put a commit *atom* on the pasteboard is to right-click a prose mention. **(verified)**

**[F09] Selection copy drops an image atom's identity** — `atomOf` in `serialize-selection.ts` builds the segment from the three attributes and never reads an id; the transcript chip (`lib/tug-atom-chip.tsx:158`) emits no `data-atom-id` (only the editor's `<img>` does, `tug-atom-img.ts:846`). A sidecar entry with no id can carry no bytes, so an image chip selected in a transcript row pastes as a chip with nothing behind it. The row's COPY button path (`copyAtomTextFrom` with `getBytes`) does carry bytes — the same row, two doors, two results. **(verified by reading; not reproduced)**

**[F10] Browser mode (no native bridge) loses the sidecar on the menu path** — `writeCopyClipboard` (`lib/copy-clipboard.ts`) writes `text/plain` + `text/html` through `ClipboardItem` when the bridge is absent and silently drops the `atoms` argument; only the DOM `copy` event path (`transcript-host-helpers.ts` `handleNativeCopy`) sets `application/x-tug-atoms` in browser mode. Low stakes — Tug.app always has the bridge — but it is the one door where the sidecar is discarded rather than written. **(verified)**

**[F11] What the tests already pin, and what they do not** — `at0477-transcript-copy-atoms` pins the user-turn COPY button round trip (plain flavor, sidecar, paste back); `at0376-session-atom-clipboard` pins the session atom; `at0512-commit-atom-surfaces` pins the pill's *appearance* on five surfaces; `at0241-jots-editor` pins typing in a Jot; `at0415-asset-clipboard-interop` pins document attachments. Nothing pins: a selection copy of a prose commit mention; the plain-text spelling of a commit atom from a substrate copy; a chip pasted into a Jot surviving close/reopen; a chip pasted into a Jot surviving relaunch. **(verified)** — from the test headers.

---

## Decisions {#decisions}

**[B01] What is drawn as an atom copies as an atom, through every door, and pastes back as the same atom in every Tug editor.** The doctrine already says the pill's label is the clipboard spelling because "the label is what the DOM holds", and [D174] says a copied sha "pastes back as a live pill instead of as text." This brief makes the *door* irrelevant: selection ⌘C, menu Copy, a row's COPY button and an identity menu's copy item all write the same sidecar for the same atom. The corollary settles the other half of the doctrine too: what is drawn as a written mention (an underlined path in prose, a session citation's surrounding words) copies as the text the author wrote. The commit is not an exception to that rule; it is the one mention that *wears the pill*, and so copies as what it wears.

**[B02] The atom components own their identity attributes; a mount cannot forget them.** Today the `data-atom-*` trio is a spread each caller remembers, and [F01]/[F07] are the callers that did not. `TugCommitAtom` takes the sha already and can emit the trio from it (`type: "commit"`, `label: commitAtomLabel(sha)`, `value: sha`) unconditionally; `TugAtomChip` and the session chip do the same from their props, plus `data-atom-id` when an id exists ([F09]). The serializer's `atomOf` reads the id back. A unit test over the three components asserts the attributes so a fourth renderer cannot ship without them. This is the [L20] move: one place authors the contract that one reader consumes.

**[B03] One plain-text spelling per atom kind, in one function, read by every writer.** `atomPlainTextFor`'s per-kind table becomes the rule; `formatAtomTextForCopy` and `serializeClipboard`'s fallback call it, and the `value === label` heuristic and `chipDisplayLabel`'s command-only special case fold into it as arms rather than standing as competing rules ([F03]). Commit → `commit:<8>`; session → the citation; command → `/name`; file and directory → `[name](<path>)` as today (the path is real information a plain paste should keep); link → `[label](<url>)`; image → the name. The `text/plain` flavor of any Tug copy is then one string per atom, wherever the copy started.

**[B04] An editor that can hold an atom persists it, or refuses it at the paste — never a bare placeholder.** `TugMessageEditor` reports the substrate (`{ text, atoms }`) rather than `doc.toString()`, and each host decides one of two things: *keep* — the Jot record gains an `atoms` field, serialised the way prompt history already serialises atoms (`prompt-history-store.ts` `SerializedAtom`), mirrored on the Rust `Jot` as an optional field exactly as `origins` was, and restored on reopen; or *demote* — a host whose output is a plain string (a question answer sent to Claude Code, a commit message handed to git) flattens each pasted atom to its [B03] plain form in the same transaction as the paste, so the document never holds a `U+FFFC` it cannot explain. Which hosts keep and which demote is [Open Question 1]; the invariant is not open.

**[B05] A placeholder without an atom is a defect at the boundary, not a character in the text.** Every place a substrate leaves an editor as a *string* (`TugMessageEditor.onChange`, `copyJotText`, the Jot drag payload, `insertJot`) flattens through [B03] rather than passing `U+FFFC` along. `buildWirePayload`'s pass-through stays as the last defensive line, but nothing above it should ever reach it with an unpaired placeholder ([F06]).

**[B06] The serializer merges adjacent runs that share a block and identical marks before applying marks.** This closes [F02] for every element that splits text into several nodes — the annotator, the portals, a future inline component — rather than for the commit alone. It changes no output for the ordinary one-text-node case.

**[B07] Both identity menus write through the shared copy path.** `commit-identity-menu.tsx` and `session-identity-menu.tsx` replace their local `writeText` with `writeCopyClipboard` (origin stamped, popup-free inside the bridge), and the commit menu gains Copy as Atom, writing the same one-atom sidecar the annotation menu's item writes ([F08]). The session menu's Copy Citation already does this; the two menus stop disagreeing.

**[B08] The sidecar rides every write, bridge or not.** `writeCopyClipboard` sets `application/x-tug-atoms` alongside the two flavors when it falls back to `ClipboardItem` ([F10]), so browser-mode development exercises the same round trip the app does. Cheap, and it removes the one door that drops the sidecar on purpose.

**[B09] The tests pin the round trips the reports named, on the real pasteboard.** Three app-tests, each driving the real gesture: (a) select a prose commit mention in a transcript, ⌘C, paste into the prompt entry, assert a commit chip and assert `pbpaste` reads `commit:<8>`; (b) paste a file chip into a Jot, close and reopen the card, assert the chip; then relaunch the app against the isolated `TUG_JOTS_PATH` and assert it again; (c) a receipt header's Copy as Atom pastes back as a pill. Plus unit tests for [B03]'s table (one row per kind), [B06]'s merge, and [B02]'s attribute contract. `at0477` stays as the user-turn baseline.

---

## Open Questions {#open-questions}

- **Which `TugMessageEditor` hosts keep atoms and which demote them ([B04])?** The Jot keeps: it is a scrap of the user's own material and the chip is the point. The question wizard's answer fields and the commit-message composer produce strings for a consumer that has no atom concept, so demotion at paste is the honest choice — but a demoted commit atom in a commit message spells `commit:<8>` where git would want a bare sha, so the demotion may need to be the *value* rather than the plain form for that host. Needs the user's call; a plan can carry the Jot as keep and the other two as demote-to-plain-form under a stated assumption.

- **Image atoms in a Jot.** A Jot has no bytes store and no asset base. Carrying the image's bytes in `jots.json` is wrong (it is a text document); carrying an `assetPath` the way a document copy does (`asset-clipboard.ts`) works only if the source file still exists. Recommend: a Jot keeps an image atom as metadata and draws it pending, exactly as the prompt draws an evicted image; the wire path already treats a bytes-less image atom as a mention. Confirm that is acceptable rather than demoting images to their name.

- **Whether the Jot's `atoms` field is a version bump or an additive optional field.** `origins` was added as an optional field without a version change, on both sides. Following that precedent is the smallest change; a plan should confirm `tugcast/src/jots.rs` tolerates an unknown-then-known optional field on the round trip the way `origins` does (the comment there says a field the two sides disagree on is dropped on the next save, which is the failure to test for).

---

## Non-goals {#non-goals}

- **Making prose mentions copy as atoms.** A file path or session name the author *wrote* copies as the text they wrote, whole-entity selection or not. The doctrine's authorship rule holds; the commit is not a counterexample, it is a mention that happens to wear a pill ([B01]).
- **Atoms inside Text card documents.** A document is a markdown file on disk; the `[P05]` rule that non-image attachments are markup, never atoms, stands. A non-asset atom pasted into a document lands as its [B03] plain form, which is the correct degradation and gets better for free when [B03] lands.
- **Arc sigils as atoms.** `tug-arc-atom` wears the identity pill but there is no `arc` atom type in the substrate; giving it one is a separate design question about what an arc reference *is* on the wire, not a fidelity bug.
- **Rich-text (`text/html`) fidelity for external apps.** What another application makes of Tug's HTML flavor is out of scope; the `text/plain` flavor is the contract that leaves the app.
- **Re-litigating the sidecar's positional schema.** One `U+FFFC` per entry has survived documents, images with bytes, provenance and assets; the failures here are all at renderers and persistence, not in the wire shape.

---

## Exit {#exit}

**A plan**, in three phases with a hard boundary after the second.

1. **The chip contract and the serializer** — [B02], [B03], [B06], [B08]. Land the attribute-owning atom components, the one plain-text function, and the run merge; retarget the three existing writers at them. This phase alone fixes the commit report end to end and can be verified by app-test (a) in [B09]. It touches no persistence and no Rust.
2. **Substrate persistence for message editors** — [B04], [B05]. `TugMessageEditor` reports the substrate; the Jot record, store and Rust model gain `atoms`; the flatten-at-boundary rule lands on `copyJotText`, the Jot drag and `insertJot`; the demoting hosts demote. Verified by app-test (b). This phase depends on the first (the demotion spells atoms through [B03]).
3. **The identity menus and the remaining doors** — [B07], receipt and History copies, app-test (c). Independent of phase two and can ride alongside it.

The plan's first step is the attribute contract test from [B02], written red against today's `TugCommitAtom`, so the seam the report found is the seam the plan opens on.
