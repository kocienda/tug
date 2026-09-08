# Overview composer parity

**Purpose:** The Overview's prompt entry is missing features the Session card's prompt entry has, and a reader who has learned one composer meets a lesser one under the Overview. Close the gap for every feature that is not a session semantic.

---

## Purpose {#purpose}

The user's notes, verbatim: "It needs a *history*, just like we offer history support for prompt-entry components in session cards." And, over a screenshot of the Overview transcript's context menu showing `Copy as Atom` with no insert row beside it: "Needs *Insert Atom into Prompt*, just like the prompt-entry components in session cards." The standing rule: "There shouldn't be a feature gap for the Overview's prompt-entry component. It must be up to scratch in terms of features."

The audit that followed found five gaps, all of one cause. The Overview composer is a bare substrate rather than a `TugPromptEntry`, and every feature the entry layers above the substrate is wired to a `CodeSessionStore` the Overview does not have. The features were skipped rather than adapted.

---

## Evidence {#evidence}

**[F01] The Overview composer is a bare `TugTextEditor` inside a `TugEntryShell`, not a `TugPromptEntry`.** Read out of `tugdeck/src/components/overview/overview-card.tsx` (`OverviewComposer`). It already has everything the substrate provides on its own: `@` file completion against the bootstrap workspace, image drop and paste with the attachment strip and an inline error notice, the user's editor settings and Return policy, atom flattening plus file refs on submit, the chord-ring send button, the clipboard and undo responders, and the entity context menu on chips inside the field. **(verified)**

**[F02] History is one missing prop.** The substrate's keymap in `tugdeck/src/components/tugways/tug-text-editor/keymap.ts` already carries the whole history gesture set: Cmd-Up and Cmd-Down at the document edges, Opt-Up and Opt-Down as a position-independent walk. It walks whatever `historyProvider` the host passes, and the Overview passes none. The Session entry builds its provider from `PromptHistoryStore.createRouteProvider(sessionId, route)`, pushes on submit, and calls `resetToDraft` after. **(verified)**

**[F03] The prompt ledger accepts any session id string.** `tugrust/crates/tugcast/src/prompt_history_api.rs` takes `session_id` as a free string, and `prompt_lineage::chain_for` falls back to the bare id it was handed when no live session resolves. Nothing on the server requires the id to name a real session. The ledger is machine-global and append-only by doctrine, so an Overview corpus keyed on a synthetic id is global across projects. **(verified)**

**[F04] Insert Atom into Prompt is dropped on purpose, and the coupling is in the handler, not the menu.** `useAnnotationMenu` in `tugdeck/src/components/tugways/use-annotation-menu.tsx` filters the `INSERT_INTO_PROMPT` row out when it gets no `codeSessionStore`, and its handler performs the insert through `codeSessionStore.insertAtomDraft` or `insertJot`, which park a pending insert in the store snapshot that only `TugPromptEntry` consumes. The Overview's row menu (`useTranscriptCellMenu` in `overview-card.tsx`) passes no store, and its click layer (`useAnnotationClicks`) is mounted with a no-op `activateCard` and no store. The screenshot's menu is exactly this: `Copy as Atom` present, no insert row. **(verified)**

**[F05] Jot drop is entry-local code over a shared helper.** `TugPromptEntry` accepts a dragged jot in its own `dragover` and `drop` handlers, reading `hasJotDrag` and `readJotDrag` from `tugdeck/src/lib/jot-drag.ts`, painting the substrate's drop caret, and inserting through `codeSessionStore.insertJot` with the drop point. The substrate's own `drop-extension.ts` handles `Files` only, so a jot dragged onto the Overview composer lands nowhere. **(verified)**

**[F06] Double-clicking a jot to insert it does not exist anywhere.** The comment on `pendingJotInsert` in `code-session-store/types.ts` mentions "double-clicked into", but no Jots component calls `insertJot`. The only callers are the annotation menu and the entry's drop handler. Double-click is therefore not a parity gap. **(verified)**

**[F07] The Overview composer registers no state preservation.** It passes `preserveState={false}` to the substrate and mounts nothing in its place. The Session entry is the sole preserver for its compound through `useCardStatePreservation`, which is what carries a draft across hide, show, and relaunch. Whether hiding the Overview rail unmounts the card was **not verified**. If it does, the draft is lost on hide. On relaunch it is lost either way.

**[F08] The Overview passes no `atomPathRoots`.** The entry supplies a thunk returning the bound project dir and the session cwd, so a chip's Open and Reveal gestures resolve a project-relative mention to an absolute path. The Overview's `@` provider completes against the bootstrap workspace but hands the substrate no roots. Inferred, not reproduced: Open and Reveal on a chip in the Overview's field likely address nothing. A hand check on a chip in the field would confirm it.

**[F09] The answering post carries the rested paths of the question's images.** `OverviewPostEntry.attachments` is a list of `OverviewAttachmentWire` entries, each with the absolute path tugcast rested the bytes at, on the question post keyed by its `request_id`. The Overview sends bytes inline in the question frame rather than through the upload route, so there is no upload receipt to patch a history row from, but the post itself is that receipt. `rehydrateDraftAttachments` in `tugdeck/src/lib/attachment-upload.ts` already reads a path-only atom back through `/api/fs/blob` into a bytes store, and its header says the Overview's own attachment strip shares that fetch-decode-put shape. **(verified)**

**[F10] The Session entry's non-session features are the whole remainder.** Every other thing the entry has and the Overview lacks is session semantics: slash commands, argument hints, the inline command ghost, the route picker, shell classification, landing modes, Escape-to-rewind, the stop button, and the wave caret during a turn. The Overview disables its field while an answer is pending, and the Overview protocol has no cancel verb. **(verified)**

---

## Decisions {#decisions}

**[B01] The Overview keeps its own composer and does not move onto `TugPromptEntry`.** The entry is four thousand lines of session plumbing whose every feature reads a `CodeSessionStore`. Hosting the Overview there would mean a session-shaped store with no session behind it. The shared pieces are extracted instead, as hooks and interfaces both composers mount. Revisit only if a third composer appears and the extracted pieces have grown back into a second entry.

**[B02] Session-only semantics stay out.** Everything in [F10] is a property of a session, not of a composer, and the user agreed: "No need to bring these to the Overview prompt entry." The stop button in particular would be a store and wire change, not a composer one, and is not part of this work.

**[B03] History uses the shared `PromptHistoryStore` and the prompt ledger, keyed on a fixed synthetic session id and its own route.** The store, the ledger, the keymap, and the provider contract all exist; the Overview needs only to be a client. The id is the `OVERVIEW_CARD_ID` constant, and the route is a distinct string rather than the Code route, so an Overview prompt is never recalled in a session and a query by route finds the Overview corpus on its own. The store instance is the one the Session cards share, exported from a lib-level home rather than the module-private singleton in `use-session-card-services.ts`. Push on submit, `resetToDraft` after, and the ledger's append-failure caution surfaces in the composer's existing notice row, because the Overview has no pane bulletin to raise it in.

**[B04] Overview history is machine-global, and that is right.** The ledger is global by doctrine and the Overview narrates the whole app, so a question asked from one project is worth recalling from another. `project_path` is still recorded, as the bootstrap workspace the `@` provider completes against, so the row says where it was asked.

**[B05] A recalled prompt with an image is resubmittable, not merely legible.** The user's call. The history row's image atoms carry `id` and `path` as the Session's do, and the path is written when the question post comes back off the wire: the store already keys the answering post by `request_id`, and its `attachments` list is in composition order, so each image atom in the row is patched with its rested path through `patchAtomPath` on the same store. Recall then rehydrates through `rehydrateDraftAttachments` into the composer's bytes store, which is the shape [F09] says already exists. A row whose post never came back keeps a path-less atom, which recalls as legible only, the same degradation the Session accepts for an upload that never landed.

**[B06] Insert into Prompt is decoupled from `CodeSessionStore` through a narrow insert-target interface.** The menu and the click layer need three things of a target: insert an atom, insert text at a point or append, and raise the composer that will receive it. That is the interface. `CodeSessionStore` satisfies it by an adapter over `insertAtomDraft` and `insertJot`, so the Session path does not change. The Overview supplies a target backed by its editor delegate, with the same park-until-mounted semantics the store's pending fields give, so an insert requested while the composer is not mounted still lands. `useAnnotationMenu` and `useTranscriptCellMenu` take the target where they took the store, and the `Insert Atom into Prompt` and `Insert into Prompt` labels light up in the Overview unchanged, because the label predicate never depended on the store.

**[B07] Raising the Overview composer means focusing its field.** The Session's raise activates the annotation's card. The Overview is a sidebar rail that is already showing when its menu is open, so the gesture that corresponds is putting the caret in the field, through the focus engine's own stop rather than a bare `focus()`.

**[B08] Jot drop ships in this arc, as a shared hook both composers mount.** The user's call: "Want both of these right away." The entry's `dragover`, `dragleave`, and `drop` handlers over `jot-drag.ts` become one hook that takes the insert target from [B06], so the Overview composer accepts a dragged jot with the same drop caret an image gets and inserts it at the drop point. Double-click is not built, per [F06]: it does not exist for the Session either, so building it for the Overview alone would create a gap the other way.

**[B09] The Overview composer registers state preservation of its own.** The draft is the user's words, and losing it on hide or relaunch is a defect whether or not the rail unmounts on hide. The registration follows the entry's shape: one preserver for the compound, the substrate opted out as it is today, a payload of one draft snapshot with its atoms, and image atoms rehydrated from their rested paths on restore, which is [B05]'s machinery again.

**[B10] The Overview hands the substrate `atomPathRoots` naming the bootstrap workspace.** A chip's gestures speak absolute paths and the mention's value is root-relative, so the composer has to say which root. The bootstrap workspace is the root the `@` provider completes against, so the two agree by construction.

---

## Open Questions {#open-questions}

None that would change what gets written. Two facts were inferred rather than measured and should be confirmed in the first steps: whether hiding the rail unmounts the card ([F07], which changes only the urgency of [B09], not its content), and whether Open and Reveal on a chip in the Overview field fail today ([F08]).

---

## Non-goals {#non-goals}

- **Hosting the Overview on `TugPromptEntry`.** Rejected in [B01]. The entry is session-shaped through and through, and a sessionless mode would be a fourth thing to keep in step, not a simplification.
- **Any session semantic.** Slash commands, argument hints, the inline command ghost, the route picker, shell classification, landing modes, Escape-to-rewind, the stop button, the wave caret. Agreed out of scope in [B02].
- **Cancelling a pending Overview question.** The protocol has no verb for it. If it is wanted, it is a store and wire arc of its own.
- **Double-click on a jot.** Not shipped anywhere, per [F06]. A feature for both composers, if ever, not a parity item.
- **Pinning Overview history to a project.** Rejected in [B04]. The ledger is global and so is the channel.

---

## Exit {#exit}

**An arc.** The pieces fall in an order because three of them share one seam.

1. The insert-target interface ([B06]), with the `CodeSessionStore` adapter proving the Session path unchanged, then the Overview's target and the two menu sites taking it. `Insert Atom into Prompt` appears in the Overview's menu here.
2. The jot-drop hook ([B08]) over the same target, mounted in both composers.
3. History ([B03], [B04]): the shared store exported, the Overview's provider, push and reset on submit, the failure caution in the notice row. Then the rested-path patch from the question post ([B05]) and rehydration on recall.
4. State preservation ([B09]), which reuses the rehydration from step 3.
5. `atomPathRoots` ([B10]), independent of the rest and small.

Each step wants an app-test under `tests/app-test/` with `@covers` on `overview-card.tsx`, alongside the three that exist, and the `at0365` round trip is the template: real posts, the real FILETREE provider, the real ledger.
