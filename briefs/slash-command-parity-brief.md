# Slash-command parity with Claude Code 2.1.311

**Purpose:** The Session card's slash-command classification has not been reviewed since 2026-09-30 while three Claude Code captures landed, so new commands fall through unclassified, two internal commands are offered in the popup, and the user-facing mirror is stale. Nothing makes a new command get classified when a capture lands.

---

## Purpose {#purpose}

The user asked to survey and update slash-command support parity with Claude Code: "It's been a while since we updated this."

The capture pipeline itself is current — `capabilities/LATEST` is `2.1.311`, which is the installed `claude`, and the fixture pins in `tugdeck/src/__tests__/system-metadata-fixture.test.ts` were updated for it. What has drifted is the *classification* layered on the catalog: which commands are local surfaces, which are hidden, and which pass through to claude. That layer is maintained by hand (`tuglaws/slash-commands.md`), and no check fires when a capture brings a name nobody has classified.

---

## Evidence {#evidence}

**[F01] The hidden set and its mirror were last edited on 2026-09-30.** `git log` on `tugdeck/src/lib/slash-supported.ts` and `tuglaws/session-card-unsupported-slash-commands.md` both stop at `b113e5f04` (the `/cd` arc). Captures `2.1.276`, `2.1.285` and `2.1.311` landed on or after that date; the catalog diffs since 2.1.204 added `autocompact`, `auto-mode-setup`, `import`, `list-agents`, `output-style`, `skill-doctor`, `focus`, `advisor`, `reload-plugins`, `workflow-launch-exec` and others. **(verified)**

**[F02] Two claude-internal commands are offered in the popup.** `__remote-workflow` and `workflow-launch-exec` carry `isHidden:!0` in claude's own command table ("server-launched sessions only"), but both arrive by name in `session_capabilities` (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.311/test-01-basic-round-trip.jsonl`) and in the `system_metadata` capture. The handshake carries no hidden flag, and `filterCommandProvider` in `tugdeck/src/components/tugways/cards/completion-providers/local-commands.ts` drops only the hidden tier and the arc-stage unlisted set, so nothing removes them. **(verified)**

**[F03] Fifteen hidden commands are ones claude now offers headless.** These names are in `HIDDEN_SLASH_COMMANDS` *and* in the 2.1.311 headless catalog: `advisor`, `color`, `config`, `doctor`, `extra-usage`, `fast`, `focus`, `heapdump`, `mcp`, `reload-plugins`, `reload-skills`, `schedule`, `team-onboarding`, `ultrareview`, `usage-credits`. Being in the catalog means claude offers them in print mode; it does not by itself mean they do anything useful over the bridge. **(verified — membership; usefulness unprobed)**

**[F04] `/fast` has a state Tug already receives.** The `system_metadata` frame carries a `fast_mode_state` key (2.1.311 capture). `/fast` is hidden today, so the state arrives and no command can change it. **(verified)**

**[F05] Six pass-throughs have never been probed headless.** `autocompact`, `auto-mode-setup`, `import`, `list-agents`, `output-style` and `skill-doctor` all arrived after the 2.1.204 probe round, are neither local nor hidden, and so pass through — against the doctrine's rule that no pass-through is relied on without a capture. `tugcode/probes/` holds only `btw`, `goal-loop`, `background-bash-wake` and `wake-investigation`. Claude marks all six `supportsNonInteractive:!0`. `output-style` changes session state (the `output_style` metadata key); `auto-mode-setup` takes wizard flags (`--wizard posture=… --propose | --apply-file`) that suggest it is not meant to be typed by hand. **(verified — classification and flags; headless behaviour unprobed)**

**[F06] At least thirteen TUI-only commands are classified nowhere.** Read out of the command table in the installed `claude` binary (`strings` over `~/.local/share/claude/versions/2.1.311`): `artifacts`, `cloud-plugins`, `daemon`, `design-login`, `install`, `pause-memory` (alias `memory-pause`), `rate-limit-options`, `restart` (alias `update`), `session` (alias `remote`), `subtask`, plus three claude itself disables or hides — `loops`, `wellbeing` (alias `breaks`), `pro-trial-expired`. None is in the headless catalog, so typing one in the Session card yields the *Unknown command* alert where the doctrine wants *Command not available*. `/subtask` ("Send a subagent off with your full context; its result comes back here") is a substantial conversation-structure feature of the same kind as `/fork`. **(verified — but the sweep is partial: the pattern used missed some entries known to exist, such as `vim`, `keybindings` and `sandbox`, so the list may be incomplete)**

**[F07] Claude has its own `/brief`, which shares a leaf with `tugplug:brief`.** It is a TUI-only `local-jsx` toggle ("Toggle brief-only mode"), absent from the headless catalog, so a bare `/brief` resolves uniquely to `tugplug:brief` today. Hiding the name would intercept it at tier 2 and break the brief skill's bare form. **(verified)**

**[F08] The user-facing mirror contradicts the code.** `tuglaws/session-card-unsupported-slash-commands.md` lists `/usage` (with `/cost`, `/stats`) and `/logout` in its hidden "Account" group, but both are in `LOCAL_SLASH_COMMANDS`; it also gives `/compact` as a pass-through example, and `/compact` is local. **(verified)**

**[F09] `/code-review ultra` reaches the billed cloud review that `/ultrareview` is hidden to prevent.** Claude now describes `/ultrareview` as a deprecated alias of `/code-review ultra`. `ultrareview` is hidden; `code-review` passes through, so its `ultra` argument reaches claude unexamined. Whether claude launches the cloud review headless is unprobed. **(verified — routing; headless behaviour unprobed)**

**[F10] The catalog separates built-ins from skills.** The capture's `slash_commands` lists 76 names, and the fixture test sorts them into 40 that "upgrade to skill" (those also named in the frame's `skills` array — tugplug, `anthropic-skills:*`, and account or project skills such as `design`, `dataviz`, `spike-card`) and 36 that stay `local`, i.e. claude built-ins. The skill half varies with the capturing account; the built-in half does not. **(verified — counts from the pinned fixture; that the split is account-independent is inference from where the skill names come from)**

---

## Decisions {#decisions}

**[B01] A capture fails red until every built-in command is classified.** Add a hand-kept set of acknowledged pass-throughs beside `HIDDEN_SLASH_COMMANDS`, and a test that reads the `LATEST` capture and requires every built-in name (the non-skill half, [F10]) to be exactly one of local, hidden, or acknowledged. A new claude built-in then turns the capture red at the moment it lands, rather than passing through unprobed until someone notices. Skills are exempt because they vary by account and are pass-throughs by construction. This is what makes "it's been a while" impossible to recur silently, and it is the reason the rest of this work is worth doing once.

**[B02] TUI-only names are reported at capture time, not gated.** Commands absent from the headless catalog can only be read out of the minified `claude` binary, and that read is fragile ([F06] missed known entries). `just capture-capabilities` prints the names it finds that are neither local nor hidden as an advisory list. A gate on a fragile extraction would go red on a minifier change rather than on a real new command.

**[B03] Claude-internal commands are dropped from the popup, not hidden.** `__remote-workflow`, `workflow-launch-exec`, and any `__`-prefixed name join the presentation-only unlisted mechanism (`UNLISTED_SLASH_COMMANDS` / `isUnlistedSlashCommand`) as a second group, so they leave the popup but remain sendable if typed. Hiding them would put a *not available* alert in front of a command claude does accept; unlisting is the existing tool for "works, but not vocabulary".

**[B04] The thirteen TUI-only names in [F06] are hidden, with `subtask` as a backlog marker.** Each goes into `HIDDEN_SLASH_COMMANDS` in the group whose reason fits, with its aliases as their own entries (`memory-pause`, `update`, `remote`, `breaks`). `subtask` sits beside `fork` in the conversation-structure group as deliberate deferred feature work. The disabled ones (`loops`, `wellbeing`, `pro-trial-expired`) are hidden too: the alert is accurate, and it keeps the set a complete account of what claude names.

**[B05] `/brief` is not hidden, and its uniqueness is pinned.** Per [F07], the bare name must keep resolving to `tugplug:brief`. The pin is the same shape as `/arc`'s (`tugdeck/src/lib/__tests__/slash-arc-reclamation.test.ts`): it fails if `brief` lands in the hidden set or if a second catalog entry comes to share the leaf.

**[B06] The mirror doc is corrected to match the code.** `/usage`, `/logout` and `/compact` move to where `LOCAL_SLASH_COMMANDS` puts them, and every name added by [B04] is mirrored with its reason. The mirror is the user's answer to "why isn't this in the popup", so it is fixed in the same arc as the set it mirrors.

**[B07] One probe round on 2.1.311 settles the unprobed commands.** Under `tugcode/probes/<topic>/` in the reference shape: `/fast`, `/reload-plugins`, `/reload-skills`, `/doctor`, `/output-style`, `/autocompact`, `/import`, `/skill-doctor`, `/list-agents`, and `/code-review ultra`. Each finding moves its command into exactly one tier on evidence, which is what the probe discipline in `tuglaws/slash-commands.md#probe-discipline` already requires and what [F03]/[F05] show was skipped.

**[B08] Graduations follow the probes, with these defaults.** If the probes support it: `/fast` becomes a local toggle beside `/effort` and `/model`, reading `fast_mode_state` ([F04]); `/reload-plugins` and `/reload-skills` leave the hidden set as pass-throughs, because they are the tugplug edit loop; `/output-style` is a candidate for a picker in the same family as `/model`. Any probed pass-through that misbehaves headless is hidden instead. The remaining hidden-but-catalogued names in [F03] (`color`, `focus`, `config`, account and setup commands, `mcp`) stay hidden — their reasons are unchanged by claude listing them.

---

## Open Questions {#open-questions}

- **What does `/code-review ultra` do headless?** If it launches a billed cloud review from a typed line, the Session card must refuse the `ultra` argument the way it refuses `/ultrareview` — which is an argument-level rule the three-tier model does not have today. If claude refuses it headless, nothing changes. The probe in [B07] settles which.
- **Does each graduation in [B08] hold up?** `/fast` as a local toggle needs a way to set fast mode (a control-request or the text command) and a confirmed state echo; `/reload-*` need to visibly reload without corrupting the session; `/output-style` needs to switch styles mid-session. Each is a probe outcome, not a call this brief can make.
- **Is the [F06] list complete?** A better extraction from the binary, or a second pattern, would say whether more TUI-only names are unclassified. [B02]'s advisory report is where that answer would surface.

---

## Non-goals {#non-goals}

- **Gating on the binary's TUI command table.** Rejected in [B02]: the extraction reads minified code and misses entries, so a gate would fail on a minifier change rather than on a new command.
- **Unhiding commands because claude now lists them headless.** [F03] shows membership, not usefulness; `color`, `focus` and the account commands do nothing the card wants, and the doctrine's tie-breaker is honesty, not catalog membership.
- **Building `/subtask`, `/fork`, `/plan` or the other conversation-structure markers.** Each is its own feature; this work only classifies them.
- **Gating skills in the parity test.** Skills vary with the capturing account and are pass-throughs by construction ([F10]).
- **Touching the capture pipeline beyond the advisory report.** `LATEST`, the snapshot and the fixture pins are current.

---

## Exit {#exit}

An arc. The shape of its first steps:

1. **Classify without claude:** the acknowledged-pass-through set and the red-until-classified test ([B01]); unlist the claude-internal names ([B03]); hide the [F06] names ([B04]); pin `/brief` ([B05]); correct the mirror doc ([B06]). None of this needs a probe, and [B01] goes first so the rest lands against a test that says when the classification is complete.
2. **The capture-time advisory report** in `just capture-capabilities` ([B02]).
3. **The probe round** ([B07]), recording a `FINDINGS.md` per topic.
4. **Graduations and the `/code-review ultra` ruling** ([B08] and the first open question), each landing with the probe evidence it rests on and the acknowledged/hidden sets updated so the [B01] test stays green.

Steps 3 and 4 depend on real `claude`; steps 1 and 2 do not.
