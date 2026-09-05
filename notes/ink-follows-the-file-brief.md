# A path in ink acts like the file it names, now

**Purpose:** Two paths in one transcript, written the same way, pointing at two files that both exist, behave differently: one carries the file's menu and opens in the editor, the other is inert text with the native editing menu. The reader cannot tell why, because there is no why they could see. This brief settles the rule the user should be able to hold in their head — *a path acts like the file it names, as the file is right now* — and what has to change so the app keeps that promise without ever explaining itself.

---

## Purpose {#purpose}

The user's words, on seeing the two menus side by side:

> The user has no idea why these things should be different.

That is the whole standard. A reader looks at `notes/a.md` and `notes/b.md` in a sentence, sees the same tone, and reasonably expects the same behaviour. When one lights and one does not, they go looking for a reason in the *text* — is the second one spelled wrong? is it a different kind of thing? — and there is none to find. The real reason is a fact about *when the sentence was painted relative to when the file was written*, which is a fact about our implementation and nothing a reader should ever have to know.

So the priority is not "make the resolver correct". It is that the user's model of the feature stays one sentence long:

> **If it names a file that exists, it acts like that file. Everywhere, the same, at the same time.**

Everything below is in service of that sentence. Anything the user could notice that is *not* explained by that sentence — a path that lights on one line and not another, a path that lights after a reload but not before, a menu that depends on which turn wrote the path — is a defect, whatever the cache thought.

---

## Evidence {#evidence}

The gate is `resolvePath` in `tugdeck/src/lib/annotator/annotate-content.ts`; the store is `PathResolutionStore` in `tugdeck/src/lib/annotator/path-resolution.ts`; the re-mark subscription is the `useLayoutEffect` at the bottom of `tugdeck/src/components/tugways/tug-markdown-block.tsx` and its twin in `annotation-scope.tsx`; the filesystem feed the deck already receives is `FeedId.FILESYSTEM`, consumed today by `tugdeck/src/lib/text-card-store.ts`.

**[F01] Both files exist, and have since the turn that wrote them.** `notes/arc-notes-restore-seat-brief.md` (18:42) and `notes/load-bar-line-fraction-brief.md` (18:44) are both on disk. The difference the user saw is not a difference in the world. **(verified)**

**[F02] A verdict is asked once and answered about a moment.** `lookup` returns a cached verdict for a resolved path; a `missing` or `unknown` answer is served as-is for `RETRY_AFTER_MS` (60s). The store is one per app, shared by every card and every surface. **(verified)**

**[F03] The Bash tool header asks about a path before the command that creates it has run.** `bash-tool-block.tsx:295` annotates the command line with `useAnnotatedElement` when the block renders. A command shaped `cat > notes/x.md <<'EOF'` names `notes/x.md`, the resolver probes it, and the file is not there yet. The store now holds `missing` for that path, app-wide. **(verified in code; the specific turn is inferred from the screenshot's heredoc header immediately above the prose)**

**[F04] The prose that follows reads the stale "no" and is never revisited.** Seconds later the assistant's sentence renders; the inline `<code>` span classifies as a path and gets the cached `missing`. `payloadForReference` returns `null`, so no mark. Only a `pending` verdict counts toward `data-tugx-awaiting` (`trackAwaits`), so the container is not flagged as waiting, and a verdict batch re-marks only flagged containers (`containerAwaitsVerdicts`). **(verified)**

**[F05] The sixty-second re-ask cannot reach ink that is not waiting.** `expired` is evaluated inside `lookup`, which runs only inside a pass; a pass runs on a container only on context-identity change or when it is flagged awaiting. So a container holding a `missing` verdict never re-asks, and even when some *other* pass re-asks the same key and the answer flips to `confirmed`, the notification is filtered to awaiting containers and the dead ink stays dead. The store's header comment promises "a newly-arrived one lights up on the next pass"; there is no next pass. **(verified)**

**[F06] The first path lit only because its file already existed when its ink was first seen.** Nothing about its spelling, its surface, or its markup earned it the menu. The two paths differ in exactly one input: the clock. **(verified from [F01]–[F05])**

**[F07] The deck already hears the filesystem change.** tugcast's `FileWatcher` broadcasts `Created` / `Modified` / `Removed` events per workspace; `FilesystemFeed` forwards them as `FILESYSTEM` frames; `text-card-store.ts:1327` parses them today to notice its own file vanishing. The signal that says "this path now exists" is already on the wire and already decoded in the deck. Nobody has told the path store about it. **(verified)**

**[F08] The registry already makes menus uniform, and the press already makes selection uniform.** A confirmed path on any surface gets the same items (`lib/annotator/registry.ts`) and the same whole-entity selection (`lib/whole-entity-press.ts`, `c84149c2f`). Both are downstream of the verdict. Fix the verdict and the rest follows; there is no second seam to close. **(verified)**

**[F09] Nothing pins any of this.** `path-resolution.test.ts` covers expiry inside the store; no test asserts that a flipped verdict reaches ink that was painted under the old one, and no app-test creates a file after naming it. **(verified)**

---

## Decisions {#decisions}

**[D01] The user-facing rule is one sentence, and it is the spec.** *A path in ink acts like the file it names, as that file is right now.* The same path in two places always wears the same face. A file that appears lights its mentions; a file that goes away darkens them. Neither transition asks anything of the reader, and neither is announced: the ink just becomes correct, the way a Finder window does. Every decision below exists to make that sentence true and to keep it from acquiring footnotes.

**[D02] The world drives the verdict, not the clock.** The path store subscribes to the `FILESYSTEM` feed it already has access to. A `Created` or `Removed` (or rename) event naming a path, or a directory a path lives under, invalidates that key: a negative verdict is dropped and re-probed, a confirmed one is re-checked. The sixty-second timer stays only as a fallback for paths outside any watched workspace, and the store must fire that re-ask *itself* when it comes due, since today a re-ask can only happen inside a pass that never comes. No feature may depend on the timer to be correct; it exists so that nothing is stuck forever, never so that something is right eventually.

**[D03] Ink depends on keys, not on a "waiting" flag.** Every pass records, per container, the resolved keys it consulted whose verdict was anything but `confirmed` — missing, unknown, pending alike — and a confirmed key too, so a deletion can reach it. A verdict change names its keys; the subscriber re-marks exactly the containers that depend on one of them. `data-tugx-awaiting` becomes one case of this and is retired as the gate. Cost is per changed key, not per waiting container, and correctness no longer depends on which state the first answer happened to be in.

**[D04] Nothing the reader can see leaks the mechanism.** No "checking…" state, no dimmed or dotted path while a probe is in flight, no tooltip saying a file was not found, no flash on a path that lights late. A path is either the file or plain text, and it moves between the two silently. The transient between a file's creation and its ink lighting is bounded by the watcher's debounce plus one verdict batch — around two hundred milliseconds — which is beneath what a reader notices and needs no cover. A path that genuinely names nothing stays plain text with the native menu, exactly as today: silence is the right answer when there is nothing to open, and the fault was never the silence, it was the silence being *wrong*.

**[D05] One key, one face, is an invariant with a test, not a hope.** Three guards, at three altitudes:

- A unit test over the annotator: one store answering `missing`, three references to one path (an inline `<code>` span, a bare token in prose, a command line under `useAnnotatedElement`), the verdict flips, and all three carry the mark after one batch with no container ever flagged awaiting. Then the verdict flips back and all three are plain.
- An app-test in the real app: the assistant names a file in prose, a tool then creates it, and the mention earns the underline, the registry menu, and the whole-entity selection — asserted against the same table `at0520` drives, so the press and the verdict are proven on the same surfaces.
- A debug audit that walks the transcript, groups every path-shaped run by its resolved key, and fails when one key wears two faces. Cheap to run after any batch in tests; the mechanical check that nothing has regrown a second clock.

**[D06] The doctrine says the gate can reopen.** `tuglaws/entity-presentation.md` states the resolver is the only gate. Add the other half: a verdict is a fact about now, and ink follows it. Name where the dependence lives so the next surface that paints paths composes it rather than remembering it.

---

## Open Questions {#open-questions}

- **Paths outside every open workspace.** An absolute path into a directory no card has open gets no watcher events and falls to the timer. Is a minute acceptable there, or should the store ask tugcast to watch a path's parent on demand while a mention of it is on screen? Recommendation: ship the timer fallback, log how often it fires, decide from the number.

---

## Non-goals {#non-goals}

- **Explaining to the user why a path is plain.** A "not found" hover or a dotted underline would make the app narrate its own resolver. Once [D01] holds there is nothing to narrate: plain text means no such file, and the reader already has a file browser for the rest.
- **Changing what a confirmed path's menu contains, or how the press selects it.** Both are settled and uniform ([F08]); this brief only ensures they are reached.
- **Making the grammar stricter** so fewer tokens are probed. Detection is permissive by design and the resolver is the gate; the cure for a stale gate is a live gate, not a smaller one.
- **Per-surface fixes.** Any change that lights the transcript's `<code>` spans without lighting the Bash header, the receipt subject, or prose by the same mechanism recreates the fault on the next surface.

---

## Exit {#exit}

The two screenshots cannot be reproduced: name a file in prose, create it in the next tool call, and the mention lights within a beat without a reload, on every surface in the `at0520` table. Delete the file and the mention goes plain. The three guards in [D05] are green, `data-tugx-awaiting` is gone as a gate, and the store's comment about "the next pass" describes something that actually happens. A reader who never learns the word "verdict" can predict, from the sentence in [D01] alone, what every path in the transcript will do when they right-click it.
