# Markdown Attachments, Follow-on — one attachment experience across two surfaces

This brief is the decided design for the second round of attachment work. The first round ([dash/markdown-attachments.md](markdown-attachments.md)) shipped the storage story whole — the two-tier home (document-sibling `assets/` folders, app-owned draft attachments with GC), the upload routes, durable prompt-entry images across relaunch — and that storage split survives this brief untouched. What the first round got wrong was above the storage line: it specified two unrelated experiences that happened to share the word "attachment," and the seams showed the first time content moved between them. A prompt-entry image copied into a Text card degraded to the literal text `image-1`; a screenshot paste on a Text card did nothing at all; a drop on an unsaved buffer raised a card-modal scold with an empty detail sheet; and a successful drop's entire experience was a percent-encoded markdown link. The 2026-08-14 vetting read traced each of these to doctrine, not drift — the plan's own "raw-source editor, no preview, no atoms" stance, executed faithfully.

This round replaces that doctrine with one worked through in discussion, decision by decision. Everything below is settled product intent; the implementation plan derives from it.

## The product lines

**The prompt-entry experience** represents attachments as inline atoms — the U+FFFC chip machinery — and supports images only. This is unchanged.

**The markdown experience** (the Text card) represents attachments as standard markdown links and supports *any* file type. The document is and remains text: no widgets over links, no inline rendering, no chip decorations in the buffer. Editing the document is editing text, full stop.

**Both experiences** offer an attachment preview strip at the bottom of their editing areas. The prompt entry already has one (`TugAttachmentPreview`); the Text card gains one. And both experiences support back-and-forth interop: links and attachments copy/paste between the two representations, images flowing through as real attachments in either direction, non-images degrading to link markup when they land in a prompt.

## The strip is a projection, not a store

The Text card's strip derives from the document. The buffer is parsed for asset links, each is resolved against the document's own path, and tiles render with thumbnails fetched through `GET /api/fs/blob`. There is no second store and no synchronization problem: the strip is a view of the text and cannot disagree with it.

This is what makes hand-editing work for free — and hand-editing is supported, deliberately. Typing a link to a real file in `assets/` lights its tile; breaking a link drops the tile (or shows a missing state, which is honest feedback while editing); undo restores it. The Text card remains fundamentally a text-editing experience, and the strip follows the text wherever the user takes it.

**Strip scope: `assets/`-prefixed destinations only.** Ordinary markdown documents are full of relative links to other documents — roadmap and tuglaws files would project dozens of tiles if every relative link counted. Only the attachment convention this feature owns feeds the strip; other links are just markdown.

## Interop mechanics

The clipboard sidecar (`application/x-tug-atoms` / `dev.tug.prompt-atoms`) is the carrier between surfaces, and it grows one obligation: **when a copy originates in a Tug surface, the sidecar carries each attachment's resolved absolute path.** Relative links are doc-relative — `assets/x.png` copied out of `dash/foo.md` means `dash/assets/x.png` — so the absolute path is the only spelling that survives every hop. For bare text the user typed or pasted from outside, the prompt entry resolves against its project directory (every prompt-entry surface belongs to a project with a project directory); between the sidecar and the project root, links in prompts resolve essentially always.

The direction-by-direction rules:

- **Prompt atom → Text card:** the image flows through. Bytes from the sidecar are written into the destination document's `assets/`, and a markdown link is inserted. The Text card's paste path stops discarding the sidecar.
- **Text card image link → prompt:** the image flows through. The path resolves, the bytes are fetched, an atom is minted with its thumbnail.
- **Text card non-image link → prompt:** degrades to link markup — visible text, no preview, no atom. Pasted back into a text document, it re-ifies automatically: the strip is a projection, so markup that resolves simply lights up. No hidden state carries the "was an attachment" memory; none is needed.
- **Text card → Text card (cross-document):** asset copy. The sidecar's absolute path lets the destination card copy the file into its own `assets/` so the pasted link resolves there.

## Untitled buffers: our problem, never the user's

The shipped guard — refusing the drop with "Save the file first" — is removed, and nothing replaces it from the user's side. An unsaved document accepts drops and pastes identically to a saved one, from the first keystroke of its life.

The mechanism: an untitled buffer's draft file already has a real path in the drafts directory, so it gets a real `assets/` sibling there. Drops land bytes in it, relative links resolve against it, the strip projects tiles from it — nothing is special-cased. When the user saves the document somewhere real, the save-as rebinding moves the `assets/` folder along with the document, and because the links are relative, not one byte of the document changes. The drafts-directory copy is cleaned up with the draft.

## Screenshot paste on the Text card

Pasting raw image data (⌘V with a screenshot on the clipboard) can no longer be a silent no-op. The bytes are written into the document's `assets/` under a minted, self-describing name and a link is inserted — the same gesture as a drop, minus the filename. The minted-name scheme is an implementation detail to be settled in the plan with a good default (timestamp-style names are the current lean: collision-proof and legible in a directory listing).

## No error vocabulary

The card-modal `TugPaneBanner` for attachment failures is removed — there is no error taxonomy for the user to learn or manage. With the untitled case designed away, the failures that remain are disk-full, permission-denied, and server-down: genuinely rare, and they must *be* rare in practice, not merely presented better. What remains renders in place, in the thing that failed — a strip tile in a failed state carrying the filename and a retry affordance, the same visual grammar as the prompt entry's pending chips. No dialog, no banner, no separate surface; the tile is the status.

Independently of the vocabulary change, the Text card's double-banner defect is fixed: two sibling `TugPaneBanner` instances each toggling `inert` on the same pane body with no refcount is a focus race regardless of what the banners say. The card moves to the Session card's pattern — one banner instance derived from a spec, mutual exclusion by construction.

## The ✕ and the trash

Strip tiles get a ✕, and it is one compound, undoable gesture: the link text is removed from the document *and* the asset file moves to a Tug-owned trash under the per-instance data directory — and undo restores both, text back in the buffer, file back in `assets/`. The macOS system Trash was considered and passed over: programmatic "Put Back" is unreliable, and undo must be reliable. The Tug trash is a new concept introduced deliberately here — retention window, and eventually a browse/restore surface — because it is what makes destructive-looking gestures safe enough to feel ordinary. Phase one scopes the trash to the ✕ gesture.

Beyond ✕ (zoom via the existing click-to-zoom sheet, click-to-reveal the link in the text), tiles carry no other mutation affordances — editing the document is the text's job.

## Readable text everywhere

No `%20`, no percent-escapes, no entities anywhere the user reads. The link's visible label is already contractually the dropped filename (never the collision-suffixed stored name); this extends the same principle to the destination half. The concrete encoding choice (CommonMark's angle-bracket destination form for names with spaces is the current lean) is an implementation detail to be settled in the plan.

Also delegated to the plan as details with good defaults: the minted paste name above, and what a non-image Finder drop directly on the prompt inserts (absolute path text is the current lean — genuinely useful in a prompt, since the model can read the file).

## Git: local `assets/`, ignored by default

The sibling `assets/` directory stays — a relative link can only reach a file inside the document's own tree, and moving bytes to app-private space would recreate the dead-outside-the-app pattern the first round rejected. But the working reality is that these are overwhelmingly ephemeral screenshots, not durable resources owed to revision history forever. So: **assets stay local to the project, and Tug ignores them by default.** Committing is a later mode — a setting, possibly per-project or per-document; the mechanism below supports every variant.

The mechanism is `.git/info/exclude` — the repo-local ignore file git keeps outside the index. It needs no commit, creates no working-tree diff, reverses by deleting a line, and is shared across worktrees (dash worktrees inherit the policy). Two precision rules:

- **Never a bare `assets/` pattern.** In an arbitrary repo that name can be a load-bearing source directory. Tug excludes only the exact directories it created, as anchored paths (`/dash/assets/`), inside a marked block (`# tug:attachments` …) that future settings add and remove lines from.
- **Tracked files win, by git's own semantics.** If an assets directory is ever committed, the exclude line is inert for it — flipping the bit later is safe in both directions with no migration.

Stated consequences, both accepted deliberately: ignored assets do not appear in the Changes card, and they do not travel with a push — a document pushed to GitHub renders its images broken for others until the commit bit is flipped. Save-as migration writes the exclude entry at the destination repo; stale entries left behind are harmless but are swept anyway.

## What this amends in the first-round plan

- The "raw-source editor, no preview" strategy line is split: the *document* stays raw source (reaffirmed, stronger than before — no chip decorations either), but the no-preview stance is replaced by the projection strip.
- The untitled-buffer guard and its error path are removed in favor of the draft-sibling design.
- The Text card's "plain-text clipboard, no atom sidecar" doctrine is replaced by the interop rules above.
- The attachment-error `TugPaneBanner` is removed; the error-presentation posture inverts from modal to in-place.
- Open question [Q01] (non-image attachments in the prompt entry) resolves as: non-images in prompts are link markup, not atoms — the prompt takes on the markdown link scheme rather than growing a file-atom type.
- The "user-owned, git-visible" framing of Tier 1 assets becomes "user-owned, git-ignored by default, committing as a later mode."
