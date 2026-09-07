# Slash commands in the Session card

*How Claude Code slash commands flow through Tug end-to-end, and the procedure for
supporting a new one — mapping it, surfacing it, hiding it, or writing it.*

The Session card talks to `claude` over a stream-json / print-mode bridge (tugcode).
Everything about slash-command policy — which commands appear in the `/` popup,
which open a graphical surface, which are swallowed — is decided **client-side, in
tugdeck, at submit time**. tugcode never parses or intercepts a slash command; it
forwards user text verbatim and supplies the command *catalog*. This document is
the single source of truth for how that works and how to change it.

Companion: [session-card-unsupported-slash-commands.md](session-card-unsupported-slash-commands.md)
is the maintained mirror of the hidden set — the user-facing answer to "why isn't
`/vim` in the popup?". This document is the engineering doctrine behind it.

## The three-tier model {#three-tiers}

Every typed `/name` is classified by `classifySlashCommand()` in
`tugdeck/src/lib/slash-supported.ts` into exactly one tier:

| Tier | Meaning | On submit |
|------|---------|-----------|
| `supported-local` | Registered in `LOCAL_SLASH_COMMANDS` (`tugdeck/src/lib/slash-commands.ts`) — the command has a Tug graphical surface | Dispatches `RUN_SLASH_COMMAND`; the Session card's `slashCommandSurfaces` map opens the surface. **Never sent to claude.** |
| `hidden` | In `HIDDEN_SLASH_COMMANDS` (`slash-supported.ts`) — the command does nothing useful over the bridge, or is deferred feature work | Dispatches `SHOW_SLASH_COMMAND_NOTICE` (a "Command not available" alert). **Never sent to claude.** |
| `pass-through` | Everything else — **the safe default** | Sent to claude verbatim as user text; claude expands it and runs a real turn. |

The dispatch order lives in `performSubmit` in
`tugdeck/src/components/tugways/tug-prompt-entry.tsx`:

1. `matchLocalSlashCommand()` — local registry hit → open the surface, record
   history, clear the draft, return.
2. `isHiddenSlashCommand()` — hidden → notice, swallow, return.
3. `isUnknownRemoteCommand()` — a pass-through name is a *genuine unknown* only
   when the session's catalog is non-empty AND the name resolves to nothing (after
   namespace canonicalization, below). Unknowns get an "Unknown command" alert
   client-side instead of burning a turn.
4. Otherwise: normal send — the `/name` text reaches claude.

Nothing is ever silently dropped: local commands open a surface, hidden commands
alert, unknowns alert, pass-throughs run.

**tugdeck is the sole interceptor.** tugcode's `SessionManager.handleUserMessage`
(`tugcode/src/session.ts`) serializes the inbound `user_message` content straight
onto claude's stdin — no slash detection, no rewriting, no gating, no tool
allowlist. If a command reaches tugcode, it reaches claude.

### The unlisted set is presentation, not a tier {#unlisted}

`UNLISTED_SLASH_COMMANDS` in `slash-supported.ts` holds the arc's four stage
skills — `arc-devise`, `arc-review`, `arc-implement`, `arc-audit`. It is
deliberately **not** a fourth row in the table above, because it is not a
`SlashSupport` member and the classifier never returns it. It says exactly one
thing: the completion popup does not offer this name. Classification, the
dispatch order, the unknown-command check, and what reaches claude are all
unchanged — a stage skill typed anyway is a `pass-through` that resolves and
runs, the same as before.

The membership rule is that **a stage skill is not vocabulary anyone speaks**.
Each refuses to run outside an arc, so a user reading the popup for a door
should not have to read past four names that would stop the moment they were
typed. The door — `/arc` — stays listed, as does every local
command.

`isUnlistedSlashCommand()` matches on the part after the last `:`, so the
namespaced `tugplug:arc-devise` and the bare `arc-devise` answer alike, and a
name that is *also* in `LOCAL_SLASH_COMMANDS` is exempt. That exemption is what
keeps the `/arc-review` card verb offered even though it shares a leaf with a
stage skill.

`tuglaws/session-card-unsupported-slash-commands.md` is the **hidden** set's
user-facing mirror and does not list unlisted names: a hidden command is one the
user is told about when they type it, and an unlisted one is a command that
still works.

## Catalog sources {#catalog-sources}

The client learns which commands exist from two wire sources, both produced by
tugcode:

- **`session_capabilities`** (turn-free) — emitted once per spawn.
  `buildSessionCapabilities()` in `tugcode/src/capabilities.ts` parses claude's
  `initialize` control-response into `{ models, commands: CapabilityCommand[],
  agents, … }` (`CapabilityCommand` is `{name, description?, argumentHint?}` in
  `tugcode/src/types.ts`). Features that must work *from the drop* — the `/`
  popup, the unknown-command check — read this handshake, never the post-turn
  metadata.

  The completion layer applies one more filter on top of this catalog:
  `filterCommandProvider` in `use-session-card-services.ts` drops both the
  hidden tier and the [unlisted set](#unlisted) before the popup renders.
- **`system_metadata.slash_commands`** (post-turn) — claude's `system/init` event
  carries a `slash_commands` array, forwarded after the first turn. It is a
  late-arriving refinement, not the popup's source.

**Plugin augmentation.** claude answers the `initialize` handshake *before* it
loads `--plugin-dir` plugins, so plugin commands would be missing from a fresh
card. `enumeratePluginCommands()` (`capabilities.ts`) walks the bundled plugin's
`skills/*/SKILL.md` and `commands/*.md` and `mergePluginCommands()` folds them
into the catalog in qualified `<plugin>:<name>` form, dropping claude's bare twin.

**Namespace resolution.** A user types `/arc-devise`; the catalog holds
`tugplug:arc-devise`. `resolveRemoteCommand()` and `canonicalizeBareCommandLine()`
(consumed in `tug-prompt-entry.tsx`) resolve bare names against namespaced catalog
entries so both forms work and neither trips the unknown-command alert.

The same resolver answers in **three** places, and that is deliberate: the `/`
popup ranks a bare query against the namespace leaf (`scoreCommandMatch` scores
the leaf and takes the better, so `arc` hits `tugplug:arc` as an exact match);
submit canonicalizes; and the transcript's clickable-command gate
(`isKnownSlashCommandName` in `slash-supported.ts`, built in
`useKnownSlashCommand`) decides whether an inline `` `/code` `` span becomes a
chip. That gate used to test literal membership, which answered no to every bare
plugin-skill name and is why skills wrote the qualified `/tugplug:<leaf>` form in
their own prose. Routing all three through one function is what keeps *offered*,
*clickable*, and *sendable* from disagreeing — an ambiguous leaf resolves to
`null` everywhere at once rather than being a chip that submit then refuses.

**The popup.** `localCommandCompletionProvider()` offers the local registry;
`filterCommandProvider()` drops the hidden tier from claude's reported commands;
`mergeCommandProviders()` merges local + remote with local-first-wins dedup
(providers in
`tugdeck/src/components/tugways/cards/completion-providers/local-commands.ts`,
wired in `use-session-card-services.ts`). Consequence: **unhiding a catalogued command
makes it appear in the popup with zero popup plumbing.**

## Mapping an existing Claude Code command: the decision procedure {#decision-procedure}

When a Claude Code release adds a command (or an existing hidden one comes up for
support), classify it deliberately:

1. **Does it expand to a prompt / run real model turns?** (e.g. `/init`,
   `/insights`, `/recap`, every skill) → **pass-through**. Do nothing — the safe
   default already handles it, and the catalog puts it in the popup. Verify with a
   probe (below) that its output renders sensibly.
2. **Does Tug already have — or want — a graphical equivalent?** (e.g. `/model`,
   `/permissions`, `/context`) → **supported-local**. Reimplement the *surface*,
   not the command: the local registry + surfaces map (recipe below). Use this
   only when the Tug surface is genuinely better than the round-trip; a local
   command never reaches claude, so it must fully replace the upstream behavior
   the user expects.
3. **Is it terminal-only UI, TUI state, or a host/account/device concern?** (e.g.
   `/vim`, `/theme`, `/login`, `/ide`) → **hidden**. Nothing useful can happen
   over a headless bridge; hide it with the notice rather than letting it burn a
   turn or confuse.
4. **Is it a substantial feature Tug intends to support later?** (e.g. the
   conversation-structure group) → **hidden, as a marker**. The hidden registry
   doubles as the backlog of deliberate deferrals; each entry names its reason.

Worked examples: `/insights` is a pass-through (a prompt expansion; zero Tug
code). `/model` is supported-local (the model picker is the surface; the upstream
TUI picker is meaningless over the bridge). `/vim` is hidden (pure TUI state).
The slash-command work exercised every path
on probe evidence: `/goal` and `/loop` graduated from hidden-as-marker to
pass-throughs with lifecycle plumbing (goal state tracking, wake-trigger
chips); `/tasks` and `/bashes` graduated to supported-local, each with its own
surface — the TASKS popover ([D100]) and the JOBS popover ([D102]); and
`/btw` graduated to supported-local via a
**fourth support mechanism** — a native **control-request** (see below), a
different door than the user-text path that claude refuses headless.

**Control-request commands (a fourth mechanism).** Beyond text pass-through, a
local surface, and hidden-with-notice, a command can be serviced by driving one
of claude's native **inbound control-requests** — the same channel tugcode
already uses for `initialize`/`interrupt`/`set_model`/`set_permission_mode`.
`/btw` is the exemplar: it is *not* a text-expanding slash command (that path is
refused headless, `num_turns:0`), it is a `control_request { subtype:
"side_question", question }`. tugcode forwards it and correlates the turn-free
`control_response` into a `side_question_answer` frame; the answer renders in a
non-modal overlay and **never enters the transcript**. Probe-verified serviced
idle AND mid-turn on claude 2.1.204 (`tugcode/probes/btw/FINDINGS.md`). When a
command reads as "hidden — refused headless," check whether the *text* path is
the only door: a control-request subtype in the CLI's inbound dispatch is a
different, servicing door.

**The tie-breaker is honesty**: a command must either work (pass-through /
local surface) or visibly refuse (hidden notice). Accidental pass-through of a
command that misbehaves headless is the one failure mode this doctrine exists to
prevent — classify on evidence, not on guesswork (see the probe discipline below).

## Mechanical recipes {#recipes}

**Make a command supported-local** (give it a Tug surface):
1. Add a descriptor to `LOCAL_SLASH_COMMANDS` in `tugdeck/src/lib/slash-commands.ts`
   (`{name, description, takesArgs?}`). The name auto-joins `SUPPORTED_LOCAL` in
   `slash-supported.ts` — no second edit.
2. Wire the surface in `slashCommandSurfaces` in
   `tugdeck/src/components/tugways/cards/session-card.tsx`. The map is a
   `Record<LocalCommandName, …>` keyed on the registry's literal union, so a
   registry entry without a wired surface is a **compile error** — the two edits
   cannot drift.
3. If the command was previously hidden, remove it from `HIDDEN_SLASH_COMMANDS`
   and update the mirror doc.

**Name a command**: an operation is spelled the same on every user-visible
surface, and that spelling is its `tugtool` verb path, hyphenated. `tugtool arc
join` is `/arc-join`; `tugtool arc bind` is `/arc-bind`. The rule exists
because a card verb and a CLI verb that do the same thing under two names make
the pair unlearnable, and because it decides collisions without argument:
`/commit` is `tugtool commit` (the base branch's landing), so `tugtool arc
commit` can only ever be `/arc-commit` — reserved, and deliberately unshipped.

**Retire a spelling**: delete the old name. Two deletions do it — the descriptor
in `LOCAL_SLASH_COMMANDS` and its `slashCommandSurfaces` handler, which the
exhaustive `Record<LocalCommandName, …>` forces you to make in the same edit.
The registry carries the names an operation has, and only those: a card that
answers to two spellings of one verb teaches both. A typed old spelling is
submitted to claude as a prompt, which spends a turn — the cost of the rename,
paid once by whoever's fingers remember.

**Reclaim a bare name for a catalogued command**: the one case where deleting a
local entry is right, because falling through to claude is the *intent* rather
than the accident the rule above guards against. `/arc` is the worked example.
`/dash` — the name the arc door carried before the lexicon settled on one word
— was a local alias for `/arc-bind`, so a typed `/dash` was intercepted at
tier 1 and never left the client. The alias was deleted and the bare name
surrendered to the door skill; that skill is `tugplug:arc` today, and the bare
`/arc` reaches it by the same path.

What makes the fall-through safe is that **every hop after the local miss
resolves**: the name is in no hidden group, so it classifies as pass-through;
`resolveRemoteCommand` finds `tugplug:arc` by *unique* namespace suffix, so
`isUnknownRemoteCommand` says no and the alert never fires; and
`canonicalizeBareCommandLine` rewrites the line to `/tugplug:arc …` so the wire
and the transcript carry the name claude expands. The test to run before
deleting is therefore not "has this alias outlived its usefulness" but **"does a
catalog entry answer to the bare name, and only one?"** A second entry sharing
the leaf makes resolution ambiguous, which reads to the user as an unknown
command — so pin the leaf's uniqueness against the real enumerated list rather
than assuming it (`tugdeck/src/lib/__tests__/slash-arc-reclamation.test.ts`,
`tugcode/src/__tests__/plugin-commands.test.ts`).

Ordering matters for bisectability: ship the skill first, surrender the name
second, so no commit exists at which the name resolves to nothing.

**Hide a command**:
1. Add the bare name (no leading slash) to `HIDDEN_SLASH_COMMANDS` in
   `slash-supported.ts`, in the group whose comment states the reason. Aliases
   need their own entries (the set has no alias mechanism).
2. Mirror it, with the reason, in
   [session-card-unsupported-slash-commands.md](session-card-unsupported-slash-commands.md).

**Pass a command through**: do nothing — but run a probe first (below) and check
the output path: command results come back as `<local-command-stdout>` scaffolding
(next section); confirm the round-trip renders.

**Author a genuinely new command**: new commands are tugplug skills. Add
`tugplug/skills/<name>/SKILL.md` (or `tugplug/commands/<name>.md`);
`enumeratePluginCommands()` picks it up at the next spawn as `tugplug:<name>`, and
the bare `/name` resolves via namespace canonicalization. No tugdeck edits unless
it also needs a surface.

## Output flow-back {#output-flow-back}

Slash-command output rides the replay/stdout-synthesis path, not a dedicated wire
type:

- claude rewrites a slash-command user turn into a scaffolding envelope:
  `<command-name>`, `<command-message>`, `<command-args>`, and delivers local
  command output as `<local-command-stdout>` (and `-stderr`).
- **tugcode** matches `<local-command-stdout>` in the result content and
  synthesizes an assistant text block from it (`tugcode/src/session.ts`, string
  and array-content variants), so command output paints as ordinary assistant
  prose. On replay, `COMMAND_SCAFFOLDING_PREFIXES` in `tugcode/src/replay.ts`
  detects and filters the envelope so scaffolding never renders as prose.
- **tugdeck** parses the envelope for display: `command-atom.ts`
  (`COMMAND_NAME_RE` / `COMMAND_ARGS_RE`, tolerant — only `<command-name>` is
  required) renders the submitted command as a command atom rather than raw tags;
  `build-wire-payload.ts` and `synthesize-user-message.ts` handle claude's
  rewriting of the user turn; `code-session-store.ts` recovers the typed command
  when the echo replays.

## The probe-and-fixture discipline {#probe-discipline}

**Never move a command out of `HIDDEN_SLASH_COMMANDS` — and never rely on a
pass-through whose headless behavior is undocumented — without a capture on the
CLI version in `capabilities/LATEST`.**

- Probes live under `tugcode/probes/<topic>/` as runnable `.mjs` scripts plus
  timestamped captures and a `FINDINGS.md`; `tugcode/probes/wake-investigation/`
  is the reference shape.
- The capability baseline is produced by `just capture-capabilities` (real
  claude; refuses on a dirty `tugplug/` tree because the capture bakes plugin
  state into the golden). Fixture consumers — e.g.
  `tugdeck/src/__tests__/system-metadata-fixture.test.ts` and the tool-visibility
  governance test — pin the baseline; a claude upgrade is not "supported" until
  they are green against the new capture.
- The rationale is empirical: commands behave differently over the headless
  bridge than in the TUI (a TUI overlay command may error or burn a turn; a
  scheduler may not survive `--resume`). The wire is the contract; the capture is
  the proof.

## What this document is not {#non-scope}

- The hidden list itself lives in code (`HIDDEN_SLASH_COMMANDS`) and is mirrored
  in [session-card-unsupported-slash-commands.md](session-card-unsupported-slash-commands.md)
  — not here.
- `AskUserQuestion`'s 1–4 question / 2–4 option shape is a Claude Code schema
  constraint documented in the repository `CLAUDE.md`, not a slash-command
  concern.
