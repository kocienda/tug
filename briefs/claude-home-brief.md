# Claude Home API

**Purpose:** Tug builds Claude Code's config path (`~/.claude/…`) by hand at sixteen production sites and about two dozen app-test sites, with no shared definition. Every one of them should go through one API that answers "where does Claude Code keep things" the same way Claude Code does.

---

## Purpose {#purpose}

This came out of the abandoned accounts-switching sketch (`@session:tug/goofy-spelt`; see the memory note on accounts switching). That sketch observed that "Tug hardcodes `~/.claude` in ten places." The user rejected the accounts project but kept this one idea, in these words: "I dislike seeing an observation like this … We should resolve that with an API — *even if we decide not to go forward with account switching*."

So this work is hygiene in its own right. It does not depend on any multi-account feature, and it does not prepare for one.

---

## Evidence {#evidence}

**[F01] Sixteen production sites build the user config path by hand, across fifteen files.** Found by `rg` over `tugrust/crates/*/src`, `tugcode/src` and `tugdeck/src`, with comments and fixtures excluded. **(verified)**

| Layer | Site | Builds |
|---|---|---|
| tugcore | `tugrust/crates/tugcore/src/janitor.rs:282` `claude_projects_dir()` | `$HOME/.claude/projects` |
| tugcore | `tugrust/crates/tugcore/src/session_finder.rs:110` | same |
| tugcast | `tugrust/crates/tugcast/src/session_ledger.rs:9229` `default_claude_projects_root()` | same |
| tugcast | `tugrust/crates/tugcast/src/feeds/operator_ask.rs:178` `claude_projects_root()` | same |
| tugcast | `tugrust/crates/tugcast/src/live_corpus.rs:33` | same |
| tugcast | `tugrust/crates/tugcast/src/terminal_registry.rs:106` | `~/.claude/sessions` |
| tugcast | `tugrust/crates/tugcast/src/permissions.rs:93` | `~/.claude` (user scope) |
| tugtool | `tugrust/crates/tugtool/src/commands/restore_names.rs:190` | `~/.claude/projects` |
| tugcode | `tugcode/src/session.ts:346` `DEFAULT_CLAUDE_PROJECTS_ROOT` | same |
| tugcode | `tugcode/src/terminal-liveness.ts:39` | `~/.claude/sessions` |
| tugcode | `tugcode/src/claude-code-settings.ts:48` | `~/.claude/settings.json` |
| tugcode | `tugcode/src/hooks-inventory.ts:101` | `~/.claude/settings.json` |
| tugcode | `tugcode/src/skills-inventory.ts:137` | `~/.claude/skills` |
| tugcode | `tugcode/src/context-breakdown.ts:299–324` | `agents/`, `CLAUDE.md`, `skills/`, the memory index |
| tugdeck | `tugdeck/src/lib/memory-destinations.ts:64,72` | `~/.claude/CLAUDE.md` and the auto-memory folder, both passed to the OS to open |
| tugdeck | `tugdeck/src/components/tugways/cards/permission-rules-editor.tsx:228` | the label "Saved at ~/.claude/settings.json" |

**[F02] The sites find the home directory three different ways and disagree when it is missing.** Some read `HOME` from the environment, some call `dirs::home_dir()`, and some call `homedir()`. When home is missing, `operator_ask.rs` falls back to `/`, while `session_finder.rs` and `live_corpus.rs` fall back to an empty path. **(verified, by reading the code)**

**[F03] The project-directory encoder (`/a/b` → `-a-b`) is implemented at least four times.** The copies are `session_ledger.rs:9281` `claude_project_dir`, `live_corpus.rs` `encode_project_dir`, tugcode's `encodeProjectDir` in `tugcode/src/session.ts`, and the deck's `encodeProjectDir` used by `memory-destinations.ts`. App-test fixtures add a fifth, in `tests/app-test/picker-sessions-fixture.ts` and others. **(verified)**

**[F04] Project-scope `.claude` is a separate thing that the same literal also reaches.** `permissions.rs:94` and `hooks-inventory.ts:102–103` read `<cwd>/.claude/settings.json` and `settings.local.json`. `CLAUDE_CONFIG_DIR` does not move these files. **(verified, by reading the code; the env-var semantics come from Claude Code's documentation)**

**[F05] Nothing in Tug honours `CLAUDE_CONFIG_DIR` today, but the `claude` it spawns does.** tugcode's `buildClaudeSpawnEnv` (`tugcode/src/session.ts:~218`) passes tugcast's environment through, scrubbing only the auth variables. So if `CLAUDE_CONFIG_DIR` reaches tugcast, Claude Code writes transcripts, settings and its session registry in one directory while Tug's readers look in `~/.claude`. That is a latent split-brain, not a hypothetical. **(verified that the variable is not scrubbed; not reproduced end to end)**

**[F06] About two dozen app-test files build the path themselves.** `rg '"\.claude"' tests/app-test` lists `arc-fixture.ts`, `picker-sessions-fixture.ts`, `corpus/harvest.ts`, `corpus/resolve.ts`, `fixtures/resolve.ts`, and roughly twenty `at0xxx` tests: at0090, at0093, at0094, at0192, at0216, at0222, at0422, at0461, at0462, at0473, at0480–0482, at0495, at0568, at0602, at0603, at0655, at0659, at0720. Most seed transcript fixtures under `join(homedir(), ".claude", "projects", encodeProjectDir(dir))`. at0090, at0093 and at0094 use project scope. **(verified)**

**[F07] The repository already has a guard of the right shape.** `no_ad_hoc_ledger_opens` in `tugrust/crates/tugcore/src/ledger_db.rs` fails the build on a writable ledger open outside the one module that is allowed to do it. **(verified)**

---

## Decisions {#decisions}

**[B01] One concept, `ClaudeHome`, owns every Claude Code path, with a Rust half in `tugcore::claude_home` and a TypeScript half in `tugcode/src/claude-home.ts`.** It goes in tugcore because the janitor, the session finder, tugcast and tugtool all need it, and tugtool cannot link tugcast. tugcode is a separate bun binary, so it needs its own half rather than calling across processes for a path.

**[B02] The resolution rule is Claude Code's own: `CLAUDE_CONFIG_DIR` when set, otherwise `$HOME/.claude`.** The user's decision was "honor it." This is the whole point of the API rather than an extra: without it, the work is a rename and [F05] stays. Behaviour cannot change for anyone who doesn't set the variable. Home is resolved one way in each half, which ends [F02].

**[B03] `ClaudeHome` is a value with two constructors: `from_env()` and `at(root)`.** Its methods name every place Tug reads:
- `root()`
- `projects_dir()`
- `project_dir(project)`, which absorbs the one encoder
- `sessions_dir()`
- `settings_path()`
- `skills_dir()`
- `agents_dir()`
- `memory_path()`, for `CLAUDE.md`
- `auto_memory_dir(project)`

The TypeScript half uses the same names in camelCase. `at(root)` replaces today's scattered test injection: `FinderEnv.claude_projects_root`, the session ledger's root argument, and `SessionManager`'s `claudeProjectsRoot` option. Those seams then take a `ClaudeHome` rather than a bare path.

**[B04] The project-dir encoder lives only in `ClaudeHome`.** A projects-dir API that leaves the encoder outside still forces every caller to join the pieces, and the encoder is the part with the subtle rule (every character outside `[A-Za-z0-9-]` becomes `-`). Every copy listed in [F03] is deleted in favour of it, including the deck's (see [B06]).

**[B05] Project scope gets its own named function, `project_claude_dir(cwd)`, next to `ClaudeHome`.** It does not move with `CLAUDE_CONFIG_DIR` ([F04]), so it is not a `ClaudeHome` method. It still gets a name, so the literal ban in [B07] can be total, with no exemptions to argue over.

**[B06] The deck never resolves home. tugcast pushes the resolved `ClaudeHome` root to it once.** The deck runs in a browser and cannot read `HOME` or the environment. The root rides an existing connection-level payload (hello or settings, whichever already carries host facts). `memory-destinations.ts` and the permission-rules label format from that value, so a moved config dir shows its real path. The deck takes the encoder from the shared TypeScript half or a protocol-level copy, never from a new one of its own.

**[B07] A literal ban guards each half, in the style of `no_ad_hoc_ledger_opens` ([F07]).** A Rust test fails on any `".claude"` string literal in crate `src/` outside `claude_home.rs`. A bun test does the same over `tugcode/src`, `tugdeck/src` and `tests/app-test`, outside `claude-home.ts` and the harness helper. Comments and recorded fixtures (`*.jsonl` catalogs) are excluded. Without a guard, the API is a snapshot of today's sites and the next one is added by hand.

**[B08] The app-tests move onto the API in this same work.** The user's decision was "fix the app-tests." A harness helper under `tests/app-test/_harness/` re-exports tugcode's `claude-home.ts`, and every file in [F06] seeds and reads through it. This touches `_harness/`, so it answers the CORE TIER ADVISED advisory with one core-tier run (`just app-test`), per the CLAUDE.md rule. That run is part of the work, not a question.

**[B09] One shared table of test cases keeps the two halves in step.** It is a single data file of `(env, home, call) → expected path` rows, including the `CLAUDE_CONFIG_DIR` cases, the encoder's edge characters, and missing home. The Rust half and the TypeScript half both run it. Two implementations of one rule drift unless something compares them.

---

## Non-goals {#non-goals}

- **Accounts switching, or any multi-account feature.** That project was abandoned on 2026-10-08 and is not to be re-proposed. Honouring `CLAUDE_CONFIG_DIR` is the documented single-directory override, not a step toward per-account directories.
- **Setting `CLAUDE_CONFIG_DIR` from Tug.** Tug reads where Claude Code is pointed. It never chooses or changes the directory.
- **Pointing the app-test harness at a scratch config dir.** Now that the variable is honoured this becomes possible, and it would isolate fixtures from the user's real `~/.claude`. It is a separate change with its own consequences for every fixture's lifetime, so it is left out here.
- **Asking tugcast for paths over IPC from tugcode.** tugcode inherits tugcast's environment, so both halves resolve to the same answer locally. The shared test table ([B09]) is the agreement mechanism, not a runtime round trip.
- **Paths that only appear in comments and docs.** They describe Claude Code's default and stay as written. The guard skips comments.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. **`tugcore::claude_home`** with `ClaudeHome`, `project_claude_dir`, the encoder, the shared test table, and the Rust literal ban. Move the eight Rust sites onto it, including the test seams that take a root today.
2. **`tugcode/src/claude-home.ts`** running the same test table, plus the bun literal ban over `tugcode/src`. Move the six tugcode sites and `SessionManager`'s root option onto it.
3. **The deck push.** tugcast sends the resolved root, and `memory-destinations.ts` and the permission-rules label format from it. The deck's encoder copy is removed.
4. **App-tests.** Add the harness helper, move the [F06] files onto it, and extend the ban over `tests/app-test`. Run the core tier once for the `_harness/` touch, plus `just app-test-changed` for the moved files.

Steps 1 and 2 are independent of each other, but both come before 3 and 4. `cd tugrust && cargo nextest run` and the tugcode bun suite are the fast layer for every step.
