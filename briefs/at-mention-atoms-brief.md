<!-- brief-skeleton v1 -->

# `@` Mentions for Sessions and Commits

**Purpose:** Typing `@` in a Tug composer completes files only, so a session or a commit reaches a prompt only by paste, drag, **Copy as Atom** or **Insert Atom into Prompt**. The `@` popup should offer sessions and commits too, across every project on the machine and the whole of a repository's history.

---

## Purpose {#purpose}

The gap was found by a research pass for a short video about session and commit atoms (session `vids/faint-surf`), which compared Tug with other AI coding tools and reported:

> **Where Tug is behind:** in Tug, `@` completes files only. A session or commit gets into a prompt by paste, drag, **Copy as Atom** or **Insert Atom into Prompt**, while Cursor, Codex and Zed offer an `@` picker for sessions. The script must not say "just type @".

The user's ask: add the `@` feature to Tug, "making it possible to cite sessions and commits as atoms."

A first sketch held two things back as follow-ups: sessions in other projects, and commits older than the first loaded page of the log. The user rejected both cuts ("Why do half the job?"). The whole job is in scope: any session on this machine and any commit in the repository can be reached by typing `@`.

---

## Evidence {#evidence}

Every finding below was read out of the code in this session unless it says otherwise.

**[F01] The `@` trigger is wired to one provider, in two places.** The Session card sets `"@"` to `services.fileCompletionProvider` at `tugdeck/src/components/tugways/cards/use-session-card-services.ts:109`. The Overview sets `"@"` to its own file provider at `tugdeck/src/components/overview/overview-card.tsx:1995`. **(verified)**

**[F02] The completion contract is type-agnostic.** A `CompletionItem` in `tugdeck/src/lib/tug-text-types.ts` is `label`, an `AtomSegment`, optional `matches` and an optional `description`. A `CompletionProvider` is `(query) => CompletionItem[]` with an optional `subscribe` for providers whose results arrive asynchronously. Nothing in the contract says the atom is a file. **(verified)**

**[F03] The accept path inserts whatever segment the item carries.** `acceptCompletionAt` in `tugdeck/src/components/tugways/tug-text-editor/completion-extension.ts` replaces the typed token with the item's atom. The only type it inspects is `directory`, for descent (`descendIntoDirectory`, line 1161). **(verified by grep of the file; the function body was not read line by line)**

**[F04] Both atoms already have minting code.** `sessionAtomSegment(identity)` in `tugdeck/src/lib/session-atom.ts` builds a session segment whose value is `<project>/<callsign>` and which carries the session uuid and project dir when both are known. The commit segment (`COMMIT_ATOM_TYPE`, `tugdeck/src/lib/command-atom.ts:112`) is built at `tugdeck/src/lib/annotator/atom-segment.ts:102` and in `tug-commit-atom.tsx:177`. **(verified)**

**[F05] Everything downstream of insertion already works for both atoms.** The wire marker, clipboard paste, the chip's findability verdict and the model's `tugtool session show` were built by the session-atom-reach and commit-atom work (`briefs/session-atom-reach-brief.md`, `briefs/commit-atom-brief.md`). An atom behaves the same however it got into the prompt. **(read from the briefs and module docs, not re-tested)**

**[F06] The machine-wide session list is one read.** `session_index.db` holds one row per session segment with `session_id`, `callsign`, `project_dir`, `project_leaf`, `instance`, `title`, `created_at_ms` and `updated_at_ms`. `all_entries` in `tugrust/crates/tugcore/src/session_index.rs` reads every row, and its doc comment names it "the machine-wide half of the Overview's session surface". `callsign` and `title` are nullable. **(verified)**

**[F07] The deck's per-project session list is `SessionLedgerStore`.** `tugdeck/src/lib/session-ledger-store.ts` caches `list_sessions` answers by project dir and patches them from `session_updated` pushes. It knows only projects the deck has asked about. **(verified)**

**[F08] The log query pages but does not search.** `GIT_LOG_QUERY` is parsed in `tugrust/crates/tugcast/src/boot/feeds.rs` as `{root, requestId, offset, limit}` and answered by `build_git_log_snapshot`, one `git log` per request in its own task, addressed to the asking client. `limit` clamps to 1–1000. There is no filter field. **(verified)**

**[F09] `GitLogStore` is one shared store following one project.** `tugdeck/src/lib/git-log-store.ts` is a module-level store for the Git History section, which shows the followed card's project. A composer in a different project cannot borrow it without crossing the two. **(verified)**

**[F10] Any sha can already be confirmed.** `tugdeck/src/lib/annotator/commit-resolution.ts` asks `GIT_COMMIT_FILES_QUERY` about a sha and caches a verdict carrying subject, author and date for the app's life. **(verified)**

**[F11] The existing provider merge is synchronous only.** `mergeCommandProviders` in `tugdeck/src/components/tugways/cards/completion-providers/local-commands.ts` de-duplicates and ranks command items and its doc says it does not carry `subscribe`. **(verified)**

**[F12] Other tools offer an `@` picker for sessions.** The research in `vids/faint-surf` found Cursor, Codex and Zed do. That research read the tools' documentation and did not inspect their UIs.

---

## Decisions {#decisions}

**[B01] One `@` trigger offers files, sessions and commits.** A merged provider replaces the file provider in both `"@"` slots ([F01]), so the Session card and the Overview gain the feature together. No new trigger character is introduced, because `@` is what the user already types and what the wire marker already spells.

**[B02] Files keep their place.** File results rank and appear exactly as they do today, first in the popup. Sessions and commits follow as their own groups, capped at about three rows each. The cap protects existing file muscle memory; the exact number is the arc's to tune.

**[B03] `@session:` and `@commit:` narrow to one kind, uncapped.** The prefixes match the wire spelling the user already sees on a submitted session atom, so the typed form and the recorded form read the same.

**[B04] Bare `@` shows recents.** With an empty query, the most recent sessions and the newest commits appear beneath the files. This is what makes the feature discoverable without documentation.

**[B05] The session provider is machine-wide.** It matches callsign, title, project leaf and `project/callsign` over every session the machine-wide index holds ([F06]). Sessions in the composer's own project rank first, then the rest by recency. The session being typed in is left out. This is in scope, not a follow-up.

**[B06] A session with no callsign is not offered.** Its chip would have no name to read, and `sessionAtomSegmentFor` already refuses to mint a segment with an empty value ([F04]).

**[B07] Commit search runs in git and covers the whole history.** `GIT_LOG_QUERY` gains an optional `query` field ([F08]). Tugcast answers it with a `git log` filtered by subject, and by sha prefix when the query is hex. A commit of any age is reachable by typing part of its subject or sha. Filtering in the deck was rejected: it would mean loading a whole history to search it. This is in scope, not a follow-up.

**[B08] The composer does not use `GitLogStore`.** The commit provider sends its own correlated `GIT_LOG_QUERY` requests keyed by the composer's project dir, because the shared store follows the Git History section's project ([F09]).

**[B09] A new merge function carries async providers.** `mergeMentionProviders` sits beside `mergeCommandProviders` and forwards `subscribe` from all three sources ([F11]). An answer for a query the user has typed past is dropped rather than shown.

**[B10] Popup rows say what they are.** A session row shows `<project>/<callsign>` with its title as the description. A commit row shows the short sha with its subject as the description.

---

## Open Questions {#open-questions}

- **How does the machine-wide session list reach a Session card?** [F06] shows the read exists and is used for the Overview, but the wire verb that carries it to the deck was not traced. If that path serves only the Overview, [B05] needs it exposed to Session cards. Reading the caller of `all_entries` in tugcast settles it.
- **Do popup rows carry a per-type glyph?** The row renderer in `tugdeck/src/components/tugways/tug-text-editor.tsx` was not read. If rows are label and description only, a glyph per kind should be added so the three groups read apart.
- **Does the completion token admit `:`?** The token stops at whitespace and the atom character and clearly admits `/`. [B03] depends on `:` passing too. Reading `LEADING_TOKEN_PUNCTUATION` and the token scan in `completion-extension.ts` settles it.

---

## Non-goals {#non-goals}

- **A separate trigger or picker dialog for sessions and commits.** Rejected by [B01]: the feature is the `@` the user already knows.
- **Filtering the commit log in the deck.** Rejected by [B07].
- **Changing how atoms travel after insertion.** The wire marker, paste, verdicts and model reach are settled work ([F05]) and are not touched.
- **Sessions on other machines.** The index is machine-wide and no wider; a cross-machine reference stays unfindable, as `briefs/session-atom-reach-brief.md` already records.
- **Arc atoms in the popup.** Not asked for.

---

## Exit {#exit}

**An arc.** A shape for its first steps, in an order that keeps each one testable:

1. Add the `query` field to `GIT_LOG_QUERY` and the filtered `git log` behind it, with Rust tests for subject match, sha prefix, a commit far past any page, and no match.
2. Settle the first open question, and expose the machine-wide session list to Session cards if it is not already.
3. Write the session provider and the commit provider in `completion-providers/`, with unit tests for matching, ranking, the own-session exclusion and the no-callsign skip.
4. Write `mergeMentionProviders`, with unit tests for group order, caps, prefix narrowing, subscribe forwarding and stale answers.
5. Wire the merged provider into both `"@"` slots, and add a row glyph if the second open question calls for one.
6. One app-test: type `@` plus a fragment and press Enter, once for a session in another project and once for an old commit, asserting the chip and its submitted marker.

Once it lands, the video script's caveat no longer applies and "type `@`" is a true claim.
