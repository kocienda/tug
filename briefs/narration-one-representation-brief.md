<!-- brief-skeleton v1 -->

# One representation for the session narration line

**Purpose:** The description line under a session's name renders through a different markdown renderer than the Overview post it was copied from, so the same sentence reads two ways: visible backticks and oversized mono in the masthead and the Cards rail, consumed backticks and quiet mono in the Overview. On top of that, the beat line draws raw escape bytes as tofu, and a commit atom in the description is cut off top and bottom on every mount.

---

## Purpose {#purpose}

The `narration-annotation` arc landed on 2026-09-12 as `9e498f72c`. It made a path in the masthead's narration line hover and open, which was asked for. It did not make the line look like the Overview, which was asked for more specifically: "I asked ***specifically*** to have a single representation and code path here." The user's notes on the landed work, in their words:

- "The monospace font we're using here looks too big next to the proportional text."
- "The format for annotations in the Overview and session card masthead *is different*. … I want *one* style here: the one from Overview." Including the Sessions section of the Cards sidebar card.
- "We're getting missing characters/entities in the display. COME ON. This can't happen." The beat line reads `→ 396:⊠[2m2026-09-12T00:16:43.832954Z⊠[0m …`.
- "We're clipping commit atoms in the masthead. We can't."

The arc was faithful to its brief. Its brief chose the wrong primitive: `[B03]` of `briefs/masthead-narration-annotation-brief.md` named `TugMarkdownText` as "the one prose primitive", and its Non-goals rejected `TugMarkdownBlock` on the claim that the markdown pipeline "cannot elide as one run inside a `TugSessionRow` line". That claim is false and the same row disproves it ([F02]). This brief corrects the earlier one; where the two disagree, this one stands.

---

## Evidence {#evidence}

**[F01] The Overview's style is one call.** `OverviewPostBody` in `tugdeck/src/components/overview/overview-card.tsx` renders `TugMarkdownBlock` in static `initialText` mode, keyed on the post, with `onAnnotated` from `useAnnotationPortals`. The pipeline is pulldown-cmark plus DOMPurify plus the enhancer chain, so a backticked name becomes a `<code>` element with the backticks consumed, and the annotator confirms it through `classifyInlineCode`. `.tugx-md-block code` in `tug-markdown-view.css` sets inline code at `--tugx-md-inline-code-size` (0.95em) in `--tug7-element-tone-text-normal-code-rest`, and a following rule retires that tone on a `<code>` whose whole content the annotator replaced with an atom. **(verified)**

**[F02] The masthead already flattens parsed markdown into one eliding line.** The beat line on the same row renders block HTML from `renderBeatLine` (the transcript's `parseMarkdownToSanitizedBlocks`) and `session-masthead.css` flattens it: `.session-masthead-beat-text :is(p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, pre) { display: inline; margin: 0; … }`, with its own `code { font-family: mono; font-size: 0.95em }` beside it. This is the premise the earlier brief's non-goal denied, running in production on the line directly under the description. **(verified)**

**[F03] The description renders through a second renderer.** `session-identity-row.tsx` renders the description as `TugMarkdownText register="inline"`, the CodeMirror-grammar styler in `lib/markdown-text-styling.ts`, whose contract is that "raw markdown syntax is never removed or hidden". Its inline register sets `font: inherit` on the run, so a backticked path is mono at 1em beside 13px sans, with both backticks drawn. The Cards rail's session cell renders the same row, so it has the same look. The picker and gallery cells render it too, unscoped. **(verified)**

**[F04] The tofu is the ESC byte, and nothing strips it.** In `tugrust/crates/tugcast/src/feeds/session_digest.rs`, the `tool_result` branch builds the beat as `clip(&one_line(output), RESULT_CLIP)`, and `one_line` is `split_whitespace().join(" ")`: whitespace is collapsed and every other byte survives. A colored grep line arrives with its CSI sequences intact, and the deck draws U+001B as a box. No ANSI stripper exists in the Rust workspace (`nu-ansi-term` in `Cargo.lock` is tracing's). The deck has one, `stripAnsi` in `tugdeck/src/lib/ansi/strip-ansi.ts`, used only by the search index. Digest rows already in the ledger carry the bytes, and `tugdeck/src/lib/digest-store.ts` ingests text at two points: the live frame and the `list_digest_lines` replay. **(verified)**

**[F05] A commit atom is one height, and the description's leading is smaller than it.** `tugdeck/src/lib/atom-register.ts` sets the atom at 22px and 13px type, retired every per-site size on 2026-09-04, and `at0513-atom-surfaces-one-height` pins it. The description's leading is `--tugx-session-row-description-line` in `tug-session-row.css`, `13px × 1.2 = 15.6px`. The masthead's wall register is a `-webkit-box` two-line clamp with `overflow: hidden` (`session-masthead.css`), and the rail's single line is `overflow: hidden` with `nowrap`. A 22px box in a 15.6px leading inside a clipped box loses its top and bottom on every mount. The Overview paragraph is `1.6 × 15px = 24px`, which is why the same pill fits there. **(verified by reading; the clip was seen in the masthead screenshot and inferred for the rail from the same rules)**

**[F06] The rail's filter marks the description by re-rendering it.** `CardsSessionRow` passes `filterQuery` as `highlight`, and the row hands it to the renderer, which nests `<mark class="tug-filter-mark">` inside the styled runs through `renderFilterHighlightSpans`. `TugMarkdownBlock` has no such prop. It has `findable`, and the transcript Find painter walks a `data-tugx-findable` container's live text and paints marks over the DOM it finds. **(verified)**

**[F07] The `TugMarkdownText` inline register has one consumer.** The description line. The block register's consumer is `commit-presentation.tsx`, which keeps the portals the arc gave it. **(verified)**

---

## Decisions {#decisions}

**[B01] The description line renders `TugMarkdownBlock` in static `initialText` mode, with the Overview's exact call.** Keyed on the text so a new post remounts, `onAnnotated` from `useAnnotationPortals`, portals rendered beside it. One component and one call is what "single representation and code path" means; a second renderer that matched the first by tuning would drift the day one of them is touched. The masthead and the Cards rail get it by rendering the same `SessionIdentityRow`; the picker and gallery cells render it unscoped and stay inert. What would revisit this: `TugMarkdownBlock` being replaced as the Overview's renderer, in which case the description follows it.

**[B02] The flatten rule moves to the row and both lines read it.** One rule in `tug-session-row.css`, keyed on the row's line elements, replaces the masthead's private `:is(p, …) { display: inline }` and its private `code` size rule ([F02]). The description and the beat are then the same shape of thing on the same row, flattened by the same words. The mono size comes from `--tugx-md-inline-code-size` and nothing else, which settles the "too big" note without a number of its own.

**[B03] `TugMarkdownText`'s inline register is retired.** It loses its only consumer under [B01] ([F07]). The block register stays for the commit body, portals included. A register kept for nobody is the seed of the next second renderer.

**[B04] Escape and control bytes are scrubbed at the source, in the digester.** `session_digest.rs` gains a visible-text scrub, applied to every payload string the digester quotes: tool output, shell output, assistant text, and tool inputs, since a `command` carries escapes as readily as a result does. It drops CSI, OSC and two-byte escapes and every other C0/C1 control except whitespace. The Rust side is the fix because the bytes are wrong the moment the line is composed, before any reader; a deck that scrubs alone leaves the ledger and every other reader holding them.

**[B05] The deck guards its ingress as well.** `digest-store.ts` runs the existing `stripAnsi` at both points it takes text ([F04]). Rows already in the ledger were written before [B04] and will replay until they age out; a guard at the door is cheaper than a migration and costs nothing once the source is clean.

**[B06] The commit atom stays a pill at the one register, and the line makes room.** Neither the atom's height nor its form is reopened: both were settled on 2026-09-04 and this brief does not spend that decision. The clipping is the leading's, which nobody decided.

**[B07] The description line takes per-mount type settings: a font size and a leading in two settings, loose and tight.** The rendered DOM is identical at every mount under [B01]; what each mount declares is how the identical thing is set. Loose is a leading that holds an atom, floored at the register's height through `atomRegisterVars`, which exists for exactly this. Tight is the current `--tug-line-height-tight`. The masthead's wall register and the Cards rail declare loose, because both mount an `AnnotationScope` and an atom can land in their line. The picker and gallery cells declare tight, because outside a provider nothing mounts an atom and there is nothing to make room for. The masthead's tier is the pinned number in `tug-pane.css`; it moves once, by the difference the loose leading costs over two lines, and stays fixed in every form as the `masthead-second-line` arc required.

**[B08] The rail's filter mark is the Find painter over the rendered description.** The description is marked `findable` and the rail's filter drives the painter that already walks a container's live text ([F06]), rather than a second marker that nests `<mark>` at render time. One painter for one kind of mark; and it is the only way a mark can land on DOM that a markdown pipeline built.

**[B09] The app-test is amended, not added to.** `at0561-narration-annotation.test.ts` gains three claims: the path run is a `<code>` child and the line's text carries no literal backtick; a post naming a sha renders a pill whose rect sits inside the line's rect; a beat carrying an ESC byte renders none. A Cards rail test gains the first of those. The commit body's existing pins hold as they are.

---

## Non-goals {#non-goals}

- **Tuning `TugMarkdownText` until it matches.** A styler that keeps syntax visible cannot be tuned into a pipeline that consumes it; the difference is what each one is for. Rejected under [B01].
- **A masthead-only inline-code size.** The size is the transcript's token or it is a second number. Rejected under [B02].
- **A second atom height, or a mono-run form of a commit in the description.** Both reopen the 2026-09-04 decisions. Rejected under [B06].
- **A leading that changes with content.** A line whose height grows when a pill lands in it moves the tier per post, which the `masthead-second-line` arc ruled out. The loose setting is declared by the mount, not discovered from the sentence. Rejected under [B07].
- **A digest migration.** Rows with escape bytes age out of the ledger's cap on their own; [B05] covers them until then.
- **Changing what the digester says.** The scrub removes bytes that were never text. The sitrep cadence, the rungs, and the sentence rules stay the `session-narration` arc's.
- **The beat line's JSON quoting.** `→ — 06d01639-… {"scroll…Anchor":…}` is an ugly result excerpt, not a rendering defect, and is not reopened here.

---

## Exit {#exit}

An arc. The shape it starts from:

1. The digester scrub ([B04]) with a unit test on a colored grep line, and `stripAnsi` at both `digest-store.ts` ingress points ([B05]) with a test through `_ingestDigestFrameForTest`.
2. The description through `TugMarkdownBlock` ([B01]); the shared flatten rule on the row with the masthead's private copies retired ([B02]); the rail's filter through the Find painter ([B08]).
3. Retire the inline register ([B03]).
4. The per-mount type settings, the loose floor from `atomRegisterVars`, and the tier's one move ([B07]).
5. The amended app-tests ([B09]).

1 is independent of the rest. 3 depends on 2; 4 can land beside 2; 5 closes.
