# Transcript Copy Defaults to Plain Text

**Purpose:** Copy on rendered transcript prose writes Markdown, but the text is almost always headed back into a prompt, a text message or an email, where the markup is noise. Copy should give plain text there, with Markdown one command away.

---

## Purpose {#purpose}

The request, in the user's words:

> Let's switch the default for copying text when the selected content is styled/Markdown *in the session card*. Most of the time, I want to paste the content back into a prompt (or into a text message or email). So, let's switch the default to copying plain text for the *Copy* command, and replace all our *Copy as Plain Text* commands with *Copy as Markdown*. Let's leave the default in *Text file cards as it is*, with my reasoning being that if you're editing a Markdown file, you want the Markdown.

Two refinements were settled in conversation and are recorded as [B05] and [B06]: the alternate command's name follows the surface rather than being replaced everywhere, and the Overview card follows the session card.

---

## Evidence {#evidence}

**[F01] Only two surfaces copy Markdown by default** — the session transcript and the Overview card, both through `useTranscriptCellMenu` in `tugdeck/src/components/tugways/cards/transcript-host-helpers.ts`. Each passes a `resolveCopyMarkdown` that calls `selectionToTranscriptSubstrate` (`session-card-transcript.tsx` lines 649 and 2028, `overview-card.tsx` line 897). The transcript's user row and shell-ink cells pass no resolver and already copy literal text. **(verified)**

**[F02] A transcript copy has two doors and one body** — the context menu's Copy arrives as a `TUG_ACTIONS.COPY` chain dispatch (`handleCopy`); native ⌘C never enters the chain and is caught by the cell's `onCopy` (`handleNativeCopy`). Both call `reconstructCopy`, which returns the Markdown as `text`, that Markdown re-rendered as `html`, and the atom `sidecar`. The clipboard gets `text/plain` = Markdown, `text/html`, the sidecar, and the origin from `clipboardOriginFor`. **(verified)**

**[F03] Copy as Plain Text is one global handler that knows nothing about its surface** — `copySelectionAsPlainText` in `tugdeck/src/lib/copy-as-plain-text.ts`, answered at the deck root (`deck-canvas.tsx` line 3178) and again in `body-root.tsx` line 175 for a body card's own page. It reads `window.getSelection().toString()`, runs `stripMarkdown`, and writes plain text with the origin and no atom sidecar. **(verified)**

**[F04] Stripping the rendered string is lossy in two directions** — `strip_markdown` (`tugdeck/crates/tugmark/src/plain.rs`) drops list markers by design, so a copied list becomes bare lines. And because [F03] strips text that is already rendered, it parses prose as Markdown a second time. That literal `*` and line-leading `#` characters in rendered prose are eaten by this is inferred from the pipeline, not reproduced. **(list markers verified; the second claim is inference — a fixture with `**kwargs` in a code span would confirm it)**

**[F05] Source surfaces already copy their Markdown** — the composer (`tug-text-editor.tsx`), Text cards (`tug-text-card-editor.tsx`) and jots (`jot-row-menu.tsx`, `jots-card.tsx`) copy their text verbatim. On these, Copy as Plain Text is the only strip-on-copy. **(verified)**

**[F06] The command registry already supports a title that follows live state** — `dynamicTitle?: (chain: CommandValidationSource) => string | undefined` in `command-registry.ts` (line 479), used by Show/Hide Session Changes (line 2035), and `AppDelegate.swift` line 2146 applies the pushed title to the menu item. What was not checked is whether a `CommandValidationSource` can already see which kind of surface holds the first responder; today's uses read `chain.menu` snapshots. **(mechanism verified; the surface signal is unverified)**

**[F07] The command's seats** — the Edit menu item (`MenuBarBuilder.swift` line 384, `performCopyAsPlainText` in `AppDelegate.swift`, menu item id `edit.copyAsPlainText`), the registry entry with chord ⌥⇧⌘C (`command-registry.ts` line 1637), the shared context-menu row (`text-editing-menu.ts` line 230), and the jot row menu's own `COPY_JOT_AS_PLAIN_TEXT`. It is documented in `tuglaws/menus.md`, `tuglaws/commands.md` and `docs/features.md`, and pinned by `MenuBarBuilderTests.swift`, `command-routing-drift.test.ts`, `keymap-registry.test.ts`, `text-editing-menu-shortcuts.test.ts`, `text-editing-menu-validity.test.ts`, and app-tests `at0181`, `at0188`, `at0366`, `at0615` and `body-grounding/_row-06.ts`. **(verified)**

---

## Decisions {#decisions}

**[B01] On a rendered-Markdown transcript cell, Copy writes plain text.** Both doors of [F02] change together, since they share `reconstructCopy`; a selection must never yield two clipboards depending on whether the menu or ⌘C was used. The rule is stated by surface kind, not by card: a cell that has a `resolveCopyMarkdown` is a rendered surface and its Copy is plain; a surface whose text is its source keeps Copy as it is.

**[B02] The plain copy writes `text/plain` only, and keeps the atom sidecar and the origin.** No `text/html`: with it on the pasteboard, Mail and Messages would still paste styled text, which is the thing being left behind. The sidecar and origin stay because the most common destination is a Tug prompt, where chips should rebuild and cited paths should still resolve.

**[B03] Plain text is emitted from the serializer's tree, not by stripping.** `serialize-selection.ts` already builds a tree of the selected runs and their containers; a second, mark-free emitter over that tree produces the plain form. It drops emphasis, heading and fence markers, collapses a link to its label, writes code verbatim, and tab-separates table cells. It **keeps list markers** (`- `, `1.`, with the same start-index rule the Markdown emitter uses) and keeps block spacing, because a list without markers pasted into a prompt reads as run-together lines. This avoids both defects of [F04] and leaves `strip_markdown` and Paste as Plain Text untouched.

**[B04] Copy as Markdown is today's transcript Copy, relocated.** On a rendered surface the alternate command writes exactly what Copy writes now: Markdown as `text/plain`, the re-rendered `text/html`, sidecar and origin. The cell answers it, because it needs the cell's resolver; it is no longer something a root handler can do alone.

**[B05] One alternate seat, named by the surface.** The ⌥⇧⌘C command stays a single command with a single chord and a single Edit menu item and context-menu row. Where Copy gives plain text (rendered cells) it reads **Copy as Markdown** and does [B04]. Where Copy gives source (composer, Text cards, native inputs, and the jot row menu) it reads **Copy as Plain Text** and behaves as it does today. A literal "replace all" was rejected because on source surfaces Copy as Markdown would be identical to Copy and would remove the only strip-on-copy ([F05]). The Edit menu title follows the first responder through `dynamicTitle` ([F06]); the context menu knows its own surface and labels its row directly.

**[B06] The Overview card follows the session card.** It shares the hook and shows the same rendered transcript prose, so the same text must not copy two ways. No per-surface flag is added to `useTranscriptCellMenu`.

**[B07] Text cards, the composer and jots do not change.** Copy stays source there, per the user's reasoning that someone editing Markdown wants the Markdown.

**[B08] Renames are clean breaks.** If the action or menu item id is renamed to name the seat rather than one of its two faces, it is renamed outright with no alias; there is no install base to bridge. Docs and pins listed in [F07] move in the same change.

---

## Open Questions {#open-questions}

- **How does the Edit menu title learn the surface?** [F06] shows the title mechanism but not a signal for "the first responder is a rendered cell". The arc picks one: a responder-declared capability the chain can be asked about, or a `chain.menu` snapshot field. It does not change what the user sees, only where the fact is read.

---

## Non-goals {#non-goals}

- **Copy as Markdown on every surface.** Rejected in favour of [B05]; redundant on source surfaces and costs the strip.
- **Changing what Paste as Plain Text or `strip_markdown` does.** The list-marker choice in [B03] is the copy emitter's alone.
- **Changing Copy on surfaces that use WebKit's native copy** (standalone Markdown blocks through `use-read-only-text-surface.tsx`, help cards). They never copied Markdown and are not part of this.
- **Whole-entity copy affordances** — block copy buttons, the share view's Copy, command-copy actions. They copy a named thing, not a selection.
- **A setting for the default.** One default, chosen here.

---

## Exit {#exit}

**An arc.** Raw material for its steps:

- The plain emitter in `serialize-selection.ts`, with unit cases beside the existing round-trip corpus: lists tight, loose, nested and starting above one; a partial bold run; a table row; fenced code; a link; a selection crossing an atom.
- `reconstructCopy` split into its two forms, with Copy and native ⌘C taking the plain one ([B01], [B02]) and the alternate action answered by the cell with the Markdown one ([B04]).
- The alternate seat: the surface signal and `dynamicTitle` for the Edit menu, the context-menu row's label by surface, and the root and `BodyRoot` handlers kept as the source-surface behaviour ([B05]).
- Docs and pins from [F07]. `at0188` and `at0366` assert the copied bytes for the transcript and the Overview card and are where the new default and the Markdown alternate are each asserted; `at0615` keeps the jot menu's Copy as Plain Text.
