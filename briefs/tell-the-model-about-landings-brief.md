<!-- brief-skeleton v1 -->

# Tell the model about landings

**Purpose:** A session's model never learns that the user committed, pushed, joined or discarded. It should — these are the most consequential events in a session's life, and the user reasonably assumes the model can see what the transcript shows.

---

## Purpose {#purpose}

The report, in the user's words: "The model, through its transcript, doesn't seem to see commits and joins. It should."

A landing changes the ground the model is standing on. After a `/commit` its edits are no longer uncommitted; after an `/arc-join` the arc's worktree and branch are gone. The transcript the user reads shows a receipt row for each of these, sitting in line with the conversation. The model's own record of the conversation holds nothing at that position, so it carries on from a picture of the tree that stopped being true.

---

## Evidence {#evidence}

**[F01] Landing receipts are non-context ink by decision, not by omission.** [D111] in `tuglaws/design-decisions.md` makes shell exchanges "durable, visually-distinct *non-context ink*" and states "Claude never sees a shell exchange implicitly ([P08])". Landings ride that same mechanism: the docstring of `tugdeck/src/components/tugways/cards/use-landing-receipts.ts` says the row "records what the user did, never what Claude knows; it is not session context". **(verified — read in both files)**

**[F02] The receipt lives in the shell ledger and nowhere in Claude's JSONL.** `tugrust/crates/tugcast/src/shell_ledger.rs` records it as a `shell_exchanges` row whose `command` is the bare verb, and says of a receipt that "Claude's JSONL never sees one". The summary text is formatted server-side in `tugrust/crates/tugcast/src/feeds/changeset.rs` (`format_commit_summary`, `format_join_summary`, `format_discard_summary`, `format_push_summary`). **(verified)**

**[F03] The ledger already treats landings as a class apart from chatter.** `LANDING_RECEIPT_COMMANDS` (`/commit`, `/push`, `/arc-join`, `/arc-discard`, plus three retired read-only spellings) exempts receipts from the 500-row per-session eviction cap, on the stated ground that a receipt is "the user's act rather than session chatter". The distinction this brief needs is one the code has already drawn. **(verified)**

**[F04] Receipts are keyed by line of work and anchored to a transcript position.** Each row carries `line_id` (so every segment of a conversation reads the same receipts back) and `anchor_msg_id` (the assistant `message.id` it follows). The facts needed to say *which* receipts fall after a given point are already on the row. **(verified — struct read; the write gateway that stamps the anchor was not read)**

**[F05] The one existing bridge into context is manual and deck-held.** `tugdeck/src/lib/pending-context-store.ts` stages `shell`, `btw` and `refs` items and prepends them to the next submission inside `<tug-context source="…" ref="…">` sentinels. The queue is in-memory and per card: an item staged and not sent does not survive a reload, and a landing this card did not initiate would never be staged. **(verified)**

**[F06] There is a precedent for a model-addressed trailing block that is stripped on replay.** `tugdeck/src/lib/session-ref-block.ts` builds the `<!-- tug:session-refs -->` fact sheet, `build-wire-payload.ts` appends it as a final text block, and `SWALLOWED_MARKERS` in `tugrust/crates/tugcore/src/session_transcript.rs` lists it (with `<!-- tug:compact-seed -->`) so `tugtool session show` does not print it. **(verified)**

**[F07] `tugtool session show` omits landings.** `session_transcript.rs` has no reference to the shell ledger or to ink, and the ledger type lives in the tugcast crate, which tugtool cannot link. This is inference from a grep, not a run of the command against a session with a known landing; running it would confirm.

**[F08] The receipt summary is too heavy to send as-is.** A commit or join summary carries a `files:` line of per-file JSON stats and the full message, sized for the receipt block's expandable file list rather than for a model. **(verified — format read in `changeset.rs`)**

---

## Decisions {#decisions}

**[B01] A landing is told to the model automatically, on the next submission.** This amends [P08] for landing receipts only — the rows `LANDING_RECEIPT_COMMANDS` names. Shell chatter stays opt-in through Add to context, exactly as [D111] has it. The line is the one [F03] already draws: chatter is noise the user may choose to share, a landing is a fact about the tree the model is working in.

**[B02] Next-submission is the whole delivery story.** Landings do not happen mid-turn, so there is no mid-turn case to design for and no hook-driven injection path.

**[B03] The ledger decides what is untold, not the deck.** Each line of work keeps a watermark of the last receipt told; at send time every landing receipt past it rides the message and the watermark advances. The deck's pending-context queue is rejected as the vehicle for the reasons in [F05] — it forgets on reload and only knows what its own card did. A fact the model must not miss cannot rest on in-memory client state.

**[B04] tugcast builds the block.** It owns the ledger, the watermark and the summary formatters, so the block is composed where the truth is. The deck's only part is to strip the block on replay so the user's row renders as they wrote it.

**[B05] The wire shape is a trailing fact sheet, like `tug:session-refs`.** One final text block opened by `<!-- tug:landings -->`, one line per landing, addressed to the model. A message with no untold landing gets no block and is byte-identical to today's. Because it travels inside the user message it lands in the JSONL, so it survives resume and compaction without further machinery.

```text
<!-- tug:landings -->
Since your last turn (the user's acts; your view of the tree may be stale):
- committed 302d43b5d on main · 4 files · "Add ⇧⌘D to finish the mic…" — paths: …
- joined 9ac1… · arc dictation → main · 3 rounds — the arc worktree and branch are gone
```

**[B06] The block is compact and says the consequence.** Header, subject, a capped path list, and the one thing the model must update on — the tree is clean of these files, the arc worktree and branch no longer exist. It does not carry the `files:` JSON ([F08]); a model that wants the detail has the sha.

**[B07] The transcript gains nothing.** No "in context" mark, no attached-context sub-row. The receipt row is already there, and users assume the model sees what the transcript shows; the change makes that assumption true rather than annotating it.

**[B08] The block is swallowed wherever session text is replayed.** It joins `SWALLOWED_MARKERS` in `session_transcript.rs` and the deck's strip in `synthesize-user-message.ts`, on the same terms as `tug:session-refs`.

**[B09] A short `tugplug/landings.md` rides the system prompt.** It tells the model what the block is, that it reports the user's own acts, and that it is plumbing not to be quoted back — the role `tugplug/session-references.md` plays for the refs block. It ships in the plugin so it holds on every project, per the standalone contract.

**[B10] `tugtool session show` prints landings in line.** A session read by reference should show its landings where they happened. Sessions that have the block in their JSONL get this from the block itself; see the open question for the ones that do not.

---

## Open Questions {#open-questions}

- **Where tugcast attaches the block.** The path an outbound user message takes through tugcast to the bridge was not read. The block must be appended after the deck's payload and before the message reaches claude, and the watermark must advance only when the send is accepted — a send that fails must not mark a landing told. Reading the send path settles where and how.
- **How `session show` reaches landings made before this lands.** Going forward the block in the JSONL is enough ([B10]), though `show` then has to render it rather than swallow it — which sits against [B08] and needs one rule for both. Older sessions have receipts only in the per-instance `shell_exchanges.db`, whose reader lives in tugcast. Either `show` prints landings only from the block and older sessions stay as they are, or a read-only ledger reader moves to `tugcore`. With an install base of zero the first is likely enough; it is the user's call.
- **Whether an arc's ending row counts.** `use-landing-receipts.ts` also paints an arc's ending ([P12]) and its quiet run notes through the same ink mechanism, and neither is in `LANDING_RECEIPT_COMMANDS`. The ending of an arc looks like the same kind of fact as a join; the notes look like chatter. Not settled in conversation.
- **What a first send after an upgrade does.** A long-lived line has many old receipts and no watermark. Seeding the watermark at the newest existing receipt avoids replaying history into the next message; confirm that is the wanted behaviour.

---

## Non-goals {#non-goals}

- **Telling other sessions.** A join moves the base under every other live session on the checkout. Nobody else is told for now; this brief covers only the session whose line holds the receipt.
- **Mid-turn delivery.** Not a case ([B02]). No `PostToolUse` or `UserPromptSubmit` hook path is built.
- **Auto-sharing shell chatter.** [P08] stands for every row that is not a landing receipt.
- **Reusing the pending-context queue.** Rejected in [B03]; its sentinel format and composer chip are for things the user chooses to share.
- **A transcript mark that the model was told.** Rejected in [B07].
- **A pull-only answer.** A verb the model could call to ask "what landed?" was considered as the whole fix and rejected: the model does not know to ask, which is the defect.

---

## Exit {#exit}

**An arc.** The first steps, roughly in the order they depend on each other:

- Read the outbound send path in tugcast and settle the first open question — where the block attaches and when the watermark advances.
- Add the per-line told watermark to the shell ledger (a schema change under the ledger's migration regime) with the upgrade seeding rule.
- Write the model-facing formatter for each landing verb beside the existing summary formatters in `changeset.rs`, compact per [B06].
- Append the block at send, advance the watermark on acceptance.
- Strip the block on replay in the deck and in `session_transcript.rs`; settle how `session show` presents it.
- Add `tugplug/landings.md` and wire it into the system prompt alongside its siblings.
- Amend [D111]/[P08] in `tuglaws/design-decisions.md` to record the exception.
