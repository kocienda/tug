# Remove a directory from a session

**Purpose:** A session can be granted another directory with `/add-dir`, and nothing takes one away again. This adds `/remove-dir` and a remove control on each folder in the Session Summary.

---

## Purpose {#purpose}

The user, after the Session Summary gained its PROJECT row and clickable folders: "Now, we need to do /remove-dir. The summary card we just edited should get an `x` icon to remove an a confirm-popover to confirm the removal."

The arc that added `/add-dir` shipped with no remove: its Summary row was written with the note that "Claude Code has no remove, a session's grant ends with the session, and a remembered folder is removed in the Permission Rules editor's Workspace tab." That premise is half wrong (see [F01]), and the user wants removal where the folders are listed.

---

## Evidence {#evidence}

**[F01] A grant can be withdrawn live with the mechanism that makes it** — tugcode grants a folder by sending claude an `apply_flag_settings` request carrying the session's whole `permissions.additionalDirectories` list, and each request replaces the list the last one carried (`tugcode/src/session.ts`, `addDirectory` and the doc on `additionalDirectories`: "sending only the new folder would revoke the others"). So a request carrying the list without a folder is a removal. **(read from the code; that claude then actually refuses reads under the removed folder mid-session is not verified — see Open Questions)**

**[F02] A folder in the Summary's list has one of three origins, and they are removed differently** — the list the deck shows is `sessionDirectories()`: what claude's last `system/init` reported, then the bridge's own grants. Claude's report includes folders from settings (`permissions.additionalDirectories` in user, project, local or managed settings) that the bridge's list never holds. A folder is therefore (a) a session grant in the flag layer, (b) remembered for the project, written to the project's local settings by Add's checkbox through `rememberDirectory` (`/api/permissions/rule`, `scope: "local"`, `bucket: "additionalDirectories"`, `op: "add"`), or (c) from a settings scope Tug did not write. Shortening the flag layer cannot withdraw (b) or (c): the settings file grants them again. **(verified in `tugcode/src/session.ts` and `tugdeck/src/lib/directory-grant.ts`)**

**[F03] The rule endpoint already removes** — `RuleOp` is `"add" | "remove"` in `tugdeck/src/lib/permission-rules-store.ts`, and the Permission Rules editor reads those settings files across scopes, so the deck can both classify a folder's origin and take a remembered one out. **(verified)**

**[F04] A removed folder would linger in the Summary** — `sessionDirectories()` starts from `reportedDirectories`, which is only refreshed by a `system/init`, and that waits for the next turn. A folder removed between turns stays in the reported part, so the frame tugcode emits after a removal would still list it. Removal has to drop the folder from `reportedDirectories` as well. **(verified by reading `sessionDirectories` and `emitSessionDirectories`)**

**[F05] tugcast persists the granted list only from a granted result** — `agent_bridge.rs` peeks `add_directory_result`, and `parse_granted_dirs` reads the whole list from an `ok: true` frame into the ledger's `granted_dirs`, which respawns and relaunches re-apply as `--granted-dir`. A removal that does not reach this path comes back on the next respawn. **(verified)**

**[F06] The deck's downstream follows the list on its own** — `SessionFileCompletion.sync()` disposes a folder's store when it leaves `additionalDirectories`, and the Summary's DIRECTORIES row renders from the same list. **(verified; the unit test "a folder that leaves the session's list is let go" covers the completion)**

**[F07] The confirm primitive has a form made for a list** — `TugConfirmPopover`'s controlled API (`open`, `anchorEl`, `onConfirm`, `onCancel`) serves N anchors from one instance, and its notes say to anchor to the row rather than a row's button, because a button anchor can unmount under its own popover. The Summary is itself a `TugPopover` (`dismissOnChainActivity={false}`); a confirm popover opened inside it has not been tried. **(API verified; the nesting is not)**

**[F08] Grants are serialized** — `handleAddDirectory` chains on `addDirectoryChain` so two requests cannot each carry a list missing the other's folder. A removal sent beside a grant has the same race. **(verified)**

---

## Decisions {#decisions}

**[B01] Each removable folder in the Summary's DIRECTORIES row carries an always-visible `x`.** A small ghost icon button at the end of the folder's line, in the row's action track, where ATOM and CITATION put their copy button. Always visible, not hover-revealed: the user settled this directly, the list is short, and a hidden control is hard to find in a summary panel. The PROJECT row never has one.

**[B02] The `x` opens a confirm popover anchored to the folder's line.** `TugConfirmPopover` in its controlled form, anchored to the line and not to the `x` ([F07]). Title "Remove this directory?", message "`<path>` is no longer readable or writable by this session.", buttons Cancel and Remove, with Remove in the destructive role. Button labels stay bare actions; the message carries the consequence, which is the rule the Add dialog was rewritten to.

**[B03] What removal does follows the folder's origin.** A session grant is removed by tugcode sending the list without it ([F01]). A folder remembered for the project is removed from the project's local settings as well ([F03]), because removing it for this session alone cannot hold ([F02]); its message reads "`<path>` is no longer readable or writable by this session or by future `<project>` sessions." A folder from a scope Tug did not write is not removable here: no `x`, and a tooltip naming where it comes from and pointing at Permission Rules.

**[B04] There is no checkbox on the removal question.** Add's checkbox chooses between two states that both exist. "Keep it for future sessions but drop it now" is not a state the settings can express, so it is not offered.

**[B05] `/remove-dir <path>` asks the same question as a pane-modal sheet.** The path is read the way `/add-dir` reads its own and goes through the canonicalization gateway ([L29]) before it is compared or sent. Its completions are the session's removable folders, not the file system. A path the session does not hold is a caution, "This session doesn't hold `<path>`"; a path from a scope Tug did not write is a caution naming that scope. Bare `/remove-dir` opens the Session Summary.

**[B06] "Removed" is said only once the folder has left the session's list.** The same rule Add follows: the success bulletin waits for both tugcode's answer and the session metadata's list, so it is never said of a folder the session still holds.

**[B07] One result frame for both directions.** `add_directory_result` becomes `directory_result` with an `op` of `add` or `remove`, in place of a sibling frame, so tugcast's persist path ([F05]) and the deck's waiter read one shape. The install base is zero, so the rename needs no bridge.

**[B08] Removal runs on the grant chain and clears the reported list.** `handleRemoveDirectory` queues behind `addDirectoryChain` ([F08]) and drops the folder from `reportedDirectories` as well as the bridge's own list ([F04]).

---

## Open Questions {#open-questions}

- **Does claude actually stop allowing access to a removed folder mid-session?** [F01] is read from tugcode's comments about replace semantics, established while building Add. Nobody has sent a shortened list to a real claude and then tried a read under the removed folder. One real-claude probe settles it, and it comes first: if the flag layer only ever grows inside a process, removal needs a respawn, and [B03] and [B06] change shape.
- **Does claude pick up a local settings edit live?** For a remembered folder, taking the rule out of the settings file may or may not withdraw it from the running process. If it does not, the remembered case needs the same answer as the question above, or its message has to say the folder goes at the next session.
- **Does a confirm popover open cleanly inside the Summary popover?** ([F07]) If the Summary dismisses when the confirm takes focus, the confirm needs another host, such as the pane-modal sheet [B05] already uses.

---

## Non-goals {#non-goals}

- **A Session menu item for removal.** Add needs its menu item because there is nothing to click before a folder exists. Removal has the folder's own line.
- **Removing a folder from user, shared-project or managed settings.** Those reach beyond this project or belong to someone else; the Permission Rules editor is their door.
- **Releasing the browse hold on a removed folder.** Tug keeps an added folder indexed until the app quits, as it does for Open Quickly's folders. That policy is `default-workspace-store`'s and is not reopened here.
- **Removing the project directory.** Moving a session is `/cd`.

---

## Exit {#exit}

An arc. Its first act is the real-claude probe from Open Questions, since the answer decides whether removal is live or needs a respawn. After it, in the order the layers depend on each other: tugcode's `handleRemoveDirectory` on the grant chain with the reported list cleared, and the `directory_result` frame; tugcast's persist path reading a removal; the deck's store verb and waiter; the Summary's `x`, origin classification and confirm popover; the `/remove-dir` command with its completions and cautions; then `docs/recipes.md`. The app-test `at0808` already drives the Summary's rows and is the natural home for the `x`, the confirm and the "removed once gone" rule.
