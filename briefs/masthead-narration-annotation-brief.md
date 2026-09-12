<!-- brief-skeleton v1 -->

# Annotate the session masthead's narration line

**Purpose:** The masthead's narration line names files, and the names are inert ink. Every other prose surface in the deck marks a path so it earns the app's hover bubble and opens on click; the narration line renders its text untouched, literal backticks and all.

---

## Purpose {#purpose}

The user's words: "The text layout of session narration must include annotation of content like file links. Hovering directly over those links should take me to that file. Make that happen in the session narration. We do this elsewhere, like in the Overview, and in the Cards sidebar card." And the second half of the ask: "Can we pull this code together into a single set of components and helpers?"

The surface is the description line of the session masthead, the middle line of the identity stack that the description ladder ([D132], [D187]) fills with the Observer's newest post during a turn and the standing synopsis between turns. A post reads like `Resolved the tape-centring question by wrapping the description and beat in a real box in `tug-session-row.tsx` so the tape's lift can learn the group's true height`. The file named in it should be a reference the reader can hover and open, as it would be in the Overview post the sentence was written from.

"Hovering takes me to the file" is read as the deck's existing contract for a path in prose: hover shows the file bubble carrying the resolved absolute path, and a primary click opens the file. That is what the Overview and the transcript do, and this brief does not invent a second gesture vocabulary for the masthead.

---

## Evidence {#evidence}

**[F01] The deck has one annotation system, and it is not tied to markdown.** `annotateElement` in `tugdeck/src/lib/annotator/annotate-content.ts` walks any element's text nodes, confirms path, commit and session candidates against the context's resolvers, and stamps `data-tug-annotation` on the runs it confirms. `annotateContent` is the markdown-renderer entry that adds bare-link detection on top; `annotateElement` is documented as the entry "for a surface that renders its own DOM rather than markdown." **(verified)**

**[F02] The surfaces opt in through a scope and a hook.** `AnnotationScope` in `tugdeck/src/components/tugways/annotation-scope.tsx` publishes an `AnnotationContext` as React context, and `useAnnotatedElement(deps)` marks a component's own element in a layout effect and re-marks it when a verdict its last pass consulted arrives. Outside a provider the hook is inert. Its users today: `bash-tool-block.tsx`, `session-join-receipt-block.tsx`, `session-commit-receipt-block.tsx`, and `tug-markdown-text.tsx`. **(verified)**

**[F03] The `AnnotationContext` is assembled twice with one body.** `useAnnotationContext` in `tugdeck/src/components/tugways/cards/transcript-host-helpers.ts` and `useOverviewAnnotation` in `tugdeck/src/components/overview/overview-card.tsx` both call `fileNameResolverFor`, `commitResolverFor`, `makeReferenceResolver` over `pathResolutionStore`, and build a `VerdictBatcher` for `subscribe`. They differ in three inputs: where the project directory and workspace key come from (the card binding versus the post's root), the cwd handed to the reference resolver (the session's cwd versus the project directory), and the slash-command gate (the session's catalog versus a constant `false`). The Overview's additionally names `sessionCitationStore` as a batcher source and sets `resolveSession`. **(verified)**

**[F04] The hover is a portal pass, and it is bundled.** `useFileTipPortals` in `tugdeck/src/components/tugways/file-tip-portals.tsx` collects the annotator's `file-path` and `directory` wraps under a container, empties each host, and portals a `TugTooltip` carrying `fileTip({ path })` into it, preserving the run's own words on `FILE_TEXT_ATTRIBUTE` so the re-check survives. `useAnnotationPortals` in `annotation-portals.tsx` bundles it with the commit tip and the session citation chip behind one `onAnnotated` callback and one `portals` node. `TugMarkdownBlock` is the only caller that drives `onAnnotated`; a `useAnnotatedElement` surface gets the mark, the underline and the click, and no bubble. **(verified)**

**[F05] The click is a delegated root listener, already on the masthead.** `useAnnotationClicks(ref, ctx)` in `use-annotation-clicks.ts` services every stamped element under a root through the registry's `primaryClick`. `session-masthead.tsx` mounts it on the masthead root for the beat line's file reference, and `annotationClaimsClick` is how the beat line's own click-to-toggle stands down for a press on the path. The Cards card does not mount one. **(verified)**

**[F06] The narration line is rendered as a plain string.** `session-identity-row.tsx` computes `description` through `truncateForDisplay` and renders `renderFilterHighlight(description, highlight)` into a span, wrapped in `session-identity-description-post` when the activity register is the wall. No `AnnotationScope` encloses the masthead or the Cards session cell, no ref annotates the line, and no portals collect from it. The backticks in the screenshot render literally because nothing tones them. **(verified)**

**[F07] The same line appears in four mounts.** `SessionIdentityRow` is mounted by `session-masthead.tsx`, `cards-session-cell.tsx`, `session-picker-cells.tsx`, and `gallery-arc-lifecycle.tsx`. The Cards sidebar's session cell is the one the user named, and it has the same gap as the masthead. The Cards card's file rows are a different case: `cards-card.tsx` holds each row's path as a fact and hands it to `fileTip` directly, which is the known-path form of the same bubble, not an annotation. **(verified)**

**[F08] `TugMarkdownText` is most of the primitive the line needs.** `tug-markdown-text.tsx` runs `applyMarkdownTextStyle` so backticked runs take the inline-code tone with the syntax left visible, nests filter-highlight marks inside the styled runs, and calls `useAnnotatedElement`. It renders one `div` per line, which suits a commit body and not a single eliding run inside a `TugSessionRow` line, and it does not drive portals. Its only user is `commit-presentation.tsx`. **(verified)**

**[F09] The line already owns a hover.** `withDescriptionHover` in `tug-session-row.tsx` wraps the description line in a `TugTooltip` showing `descriptionFull` when the line is elided. An annotated path run inside that line would carry a second `TugTooltip` from the portal, and `TugTooltip` has no gate by which an outer trigger declines a hover that an inner entity is answering. This is read out of the two files; the nested behaviour was not run. **(not verified as behaviour)**

**[F10] The beat line's path is a self-stamping atom, not an annotation.** `beat-text.tsx` parses the beat's file target and renders `TugAtomRef`, which carries its own `file-path` stamp and its own tip. `file-tip-portals.tsx` deliberately scopes its selector to `WRAPPED_ATTRIBUTE` so it never empties an atom. **(verified)**

---

## Decisions {#decisions}

**[B01] The narration line joins the existing annotation system; nothing new is invented for it.** The line becomes an annotated element inside an `AnnotationScope`, its runs get the file bubble from the same portal pass and open through the same click layer. A masthead-only linkifier would be a fourth account of what a path is, which is the shape this line's own arc just retired for narration itself. What would revisit this: nothing short of the annotator being replaced.

**[B02] One context builder, with the two existing hooks as thin callers.** The shared body in [F03] moves into one hook keyed on a project directory and workspace key, taking the cwd, the slash-command gate, and whether to scan for sessions as inputs. `useAnnotationContext` and `useOverviewAnnotation` call it. The masthead and the Cards session cell already hold a `projectDir` and mount a scope from the same hook. The identity of the returned context stays stable across verdicts exactly as the transcript's does today; that property is the reason the two builders share one implementation rather than one being copied a third time.

**[B03] `TugMarkdownText` is the one prose primitive, extended in two ways.** It gains an inline register that renders a single eliding run rather than one block per line, and it drives `useAnnotationPortals` itself so every consumer gets the hover along with the mark. The masthead description, the Cards session cell, the picker and gallery cells, and the commit body all render it. The commit body gaining a bubble on its paths is an intended side effect. A new component beside it was rejected: it would be `TugMarkdownText` with the two features and a different name.

**[B04] An entity's tip wins over the run it covers; the line's full-text tooltip covers the rest of the line.** The description tooltip in [F09] stays, because an elided line still has to be readable whole. It yields when the pointer is over a stamped run. That is a gate on the outer `TugTooltip` opening, decided from the pointer's target at open time, not a change to what the annotator stamps. The gate lives in `TugTooltip` so any surface with a hover of its own can decline the same way.

**[B05] The Cards card mounts the click layer at its root.** Its session cells will carry stamped runs and nothing services them today. `useAnnotationClicks` on the card root, as the masthead already has it, is the whole of that change.

**[B06] The known-path form stays separate.** `TugAtomRef` on the beat line and `fileTip` on the Cards file rows hold a path as a fact and wear it; the narration line holds prose in which a path must be found. Two entry points into one bubble and one click layer is the right count. Folding the atom into the annotator, or the annotator into the atom, was considered and rejected: [F10] records why the portal pass already keeps them apart.

**[B07] Hover shows, click opens.** The user's phrasing "hovering takes me to the file" is honoured as the deck's existing gesture contract rather than as navigation on hover. A hover that navigated would open a card every time the pointer crossed the line.

**[B08] The Rust digester and the Sonnet ask are untouched.** The prose carries the paths as the model wrote them, and the annotator confirms them against the file index, so a bare basename resolves as a backticked one does. Prompting the model to backtick paths would be a presentation preference the renderer already satisfies.

---

## Open Questions {#open-questions}

- Whether Radix opens both tooltips when a trigger is nested inside a trigger, or only the inner one. [F09] reads the gate as necessary; a short run in the deck settles it, and if only the inner opens then [B04]'s gate is a smaller change than written.

---

## Non-goals {#non-goals}

- **A masthead-specific linkifier.** Rejected under [B01]; a regex over the description would be a second, weaker annotator with its own idea of what a path is.
- **A new prose component beside `TugMarkdownText`.** Rejected under [B03].
- **Rendering the description through `TugMarkdownBlock`.** The full markdown pipeline builds block DOM with its own layout and cannot elide as one run inside a `TugSessionRow` line. The inline register of the text primitive is the fit.
- **Changing what the narration says.** The digester, the sitrep cadence, and the ladder's rungs are the `session-narration` arc's and are not reopened here.
- **Annotating the beat line's text beyond its file target.** The beat's verb and count are plain by design.

---

## Exit {#exit}

An arc. The shape it starts from:

1. Extract the shared context builder from `transcript-host-helpers.ts` and `overview-card.tsx` into one hook; both existing hooks become callers, with their tests green and unchanged in intent.
2. Give `TugMarkdownText` the inline register and internal portals; the commit body keeps rendering as before and its paths gain the bubble.
3. Add the tooltip-yield gate to `TugTooltip`, settling the open question first.
4. Mount `AnnotationScope` in the masthead and the Cards session cell from the shared hook; render the description through the primitive in `session-identity-row.tsx`; mount `useAnnotationClicks` on the Cards card root.
5. An app-test that hovers a path in a masthead post and reads the bubble, and clicks it and reads the opened card.

Steps 1 through 3 are independent of each other; 4 depends on all three.
