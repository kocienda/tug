# Smart insert for dropped atoms

**Purpose:** A file dropped into the composer lands welded to whatever text is already at the drop point. The insert should pad itself with spaces when — and only when — the neighbouring characters need them, the way macOS smart paste has for decades.

---

## Purpose {#purpose}

> "When I drag and drop a file, I want it to do a *smart insert*, à la *smart paste* as has been done in macOS for decades. In other words, the atom should get spaces around them, if needed."

Dropping a file inserts its atom at exactly the resolved drop position, verbatim. Drop into the middle of a word and the chip welds to the characters on both sides; drop a second file beside the first and the two chips sit flush against each other. The user then backs up and types the spaces by hand, which is the work the insert should have done.

The reference behaviour is not "always add a space" — it is the macOS smart-paste judgment: look at what is on either side and add air only where air is missing.

---

## Evidence {#evidence}

**[F01] The drop insert writes its run with no regard for its neighbours.** `insertMixedAt` (`tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts:664`) builds one string from the dropped items, joins them with a single space, and dispatches `changes: { from: pos, insert }`. Nothing reads the character before `pos` or at `pos`. The interior join is correct; the two outer edges are the defect. **(verified)**

**[F02] The same omission is in every other insert door, not just the file drop.** `insertSubstrateAt` (`drop-extension.ts:624`, the jot substrate path, reached from `tugdeck/src/components/overview/overview-insert-target.ts:126` and `tugdeck/src/components/tugways/tug-prompt-entry.tsx:1916`), `insertAtomAt` and `insertAtomAtSelection` (`tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts:428` and `:446`), and the text-card CommonMark-link drop (`tugdeck/src/components/tugways/tug-text-card-editor/file-drop.ts:249`) each dispatch a bare `from`/`insert` pair the same way. A fix that lives only in the file-drop handler would leave the picker and the jot drop welding. **(verified)**

**[F03] Two of the padding cases fall out of the whitespace test rather than needing rules of their own.** `U+FFFC` — the atom sentinel — is not whitespace, so a chip-against-chip drop is already caught by "the preceding character is not whitespace". A newline *is* whitespace, so a drop at the head or tail of a line correctly adds nothing, which is the common case and stays byte-for-byte unchanged. **(verified — read out of the sentinel's definition and the insert sites; not yet exercised by a test.)**

**[F04] Every insert door already dispatches exactly one transaction.** `changes`, `addAtomsEffect`, `setTugDropCaretPos` and the selection all ride together in each of the sites above. Padding can join that transaction rather than following it, with no restructuring. **(verified)**

---

## Decisions {#decisions}

**[B01] The decision is one pure function, `padForInsert(state, from, to) → { before: boolean, after: boolean }`.** It reads exactly two characters — the one before `from` and the one at `to` — and answers whether each side needs air. Purity is what makes the rule testable as a table instead of through the drag-and-drop machinery, and a single function is what keeps the answer identical at every door. It lives beside the atom machinery, in `tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts` or its own `smart-insert.ts` next to it.

**[B02] A space goes *before* unless the point is at the start of the document or a line, the preceding character is whitespace, or it is an "opener".** The opener set is `(`, `[`, `{`, `<`, `"`, `'`, `` ` ``, `=`, `@`. Those are the characters that mean the atom is being seated *inside* something rather than after it — `--paths=⟨atom⟩` and `"⟨atom⟩"` must not acquire a space that changes what the line means.

**[B03] A space goes *after* unless the point is at the end of the document or a line, the following character is whitespace, or it is trailing punctuation.** The closer set is `)`, `]`, `}`, `>`, `"`, `'`, `` ` ``, `,`, `;`, `:`, `.`, `?`, `!`. Dropping just before a period leaves the sentence intact rather than pushing its punctuation away from it.

**[B04] The padding rides the insert's own transaction, never a second dispatch.** One undo takes the atom and its spaces together, and no intermediate state exists in which the document holds a space with nothing beside it. [F04] says every door is already shaped for this.

**[B05] The rule is applied in the insert helpers, not in the drop handlers.** All five sites in [F02] route through them, so every door — file drop, image drop, custom host handler, jot substrate, atom picker, text-card link — inherits the behaviour without each caller remembering to ask for it. A caller that wants verbatim insertion is the exception and should say so explicitly.

**[B06] The caret keeps today's convention: it lands at the end of the whole insert, trailing pad included.** So `foo|bar` becomes `foo ⟨atom⟩ |bar` and typing continues in clean air rather than welding to the chip. Changing the convention per-case would make the caret's landing unpredictable for one insert in three.

**[B07] `insertSubstrateAt` gets the outer padding despite its docblock's warning.** That docblock is right that a separator must not be injected into a carried substrate — the text already says where everything goes. Smart insert touches only the two outer edges and nothing interior, so the warning is honoured rather than overridden.

**[B08] `insertAtomAtSelection` measures its neighbours outside the replaced range.** A drop or insert over a selection compares against the characters that will actually abut the result, not against the text being replaced.

---

## Open Questions {#open-questions}

- **Whether an atom-sidecar paste joins the padded doors.** Classic smart paste *is* a paste feature, and a sidecar paste is arguably a chip insert rather than a text paste. It is not settled here because it needs the user's read on where the line sits, and the answer changes which door list the work touches.
- **Whether `@` belongs in the opener set and `:` in the closer set.** `⟨atom⟩:` staying tight reads right for `path:line`, and `@⟨atom⟩` reads right for a session reference — but both are judgment calls about the composer's idiom, and either could be dropped from its set without disturbing the rest of the rule.

---

## Non-goals {#non-goals}

- **Padding plain text paste.** CM6 owns that path, and padding arbitrary pasted text means rewriting bytes the user copied on purpose. The atom-sidecar case is held open above; general text paste is not.
- **Changing the interior single-space join between dropped items.** `insertMixedAt`'s join is already correct for a multi-file drop. Smart insert wraps the run, and leaves its inside alone.
- **A padding preference or setting.** The macOS behaviour is not configurable and does not need to be; a rule that is right does not need a switch.
- **Reworking drop-position resolution or the drop caret.** The resolved position is already the position the user aimed at. This work is only about what gets written there.

---

## Exit {#exit}

An arc. Its raw material, in the order the pieces depend on each other:

- Write `padForInsert` with the opener and closer sets from [B02] and [B03], plus its table-driven unit test: empty doc, line start, line end, mid-word on both sides, before a period, after `=`, inside quotes, chip-adjacent, and drop-over-selection.
- Route `insertMixedAt` and `insertSubstrateAt` through it, padding inside the existing transaction ([B04], [B07]).
- Route `insertAtomAt` and `insertAtomAtSelection` through it, with the outside-the-range neighbour read from [B08].
- Route the text-card CommonMark-link drop (`file-drop.ts:249`) through it.
- One app-test that drops a file into the middle of a word in the composer and asserts `walkAtomText` reads `foo ⟨atom⟩ bar`. Any new test carries `@covers`.

The two open questions are worth settling before the door commits to a step list: the sets in [B02]/[B03] are what the unit-test table encodes, and the paste answer decides whether a sixth door is in scope.
