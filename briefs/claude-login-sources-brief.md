<!-- brief-skeleton v1 -->

# Claude login sources

**Purpose:** Claude Code can be signed in through several sources, and Tug reports all of them as a single "logged in" with an optional email. Its one Log Out clears only the subscription login, so on 2026-11-21 a logout appeared to fail and the user was left very confused about which account Tug was using and why logging out did nothing.

---

## Purpose {#purpose}

The user pressed File → Log Out, confirmed "Log Out of Claude?", and stayed logged in. Two more presses changed nothing visible. The day before, they had installed Anthropic's `ant` CLI and run `ant auth login`. After clearing that, `claude auth status` in the card's shell reported a third login, an `ANTHROPIC_API_KEY` from the environment. In the user's words: "we need to be more savvy about these different login types in the app. I was left very confused."

The problem is not that logout broke. Tug has no idea *which* login is active, shows none of that to the user, and treats a logout that leaves another login in place as nothing worth mentioning. It also lets sessions run on a pay-per-token account without the user ever having chosen to.

---

## Evidence {#evidence}

**[F01] Claude Code fell back to the `ant` CLI's Console profile once its own login was gone.** With `~/.config/anthropic` present, `claude auth status --json` (2.1.325) reported `loggedIn: true`, `authMethod: "oauth_token"`, no email. With the config hidden (`XDG_CONFIG_HOME=/tmp/emptycfg claude auth status --json`), it reported `loggedIn: false`, `authMethod: "none"`. There was no `Claude Code-credentials` keychain item and no `oauthAccount` in `~/.claude.json`. `ant auth status` showed the active `default` profile, a `user_oauth` token for the Console org "self", and the credentials file had been rewritten at 09:44, the minute of the logout attempts. **(verified)**

**[F02] Each Log Out ran `claude auth logout`, and nobody can tell from the record what it returned.** The tugcast log has `dispatch_action: claude logout requested` at 17:44:20, 17:44:40 and 17:44:52 UTC. `logout()` (`tugrust/crates/tugcast/src/feeds/claude_auth.rs`) returns `(ok, error)`. The `ClaudeLogout` arm in `tugrust/crates/tugcast/src/actions.rs` sends that result as `claude_logout_result` and never logs it. The error text keeps only the last line of stderr. The CLI writes its own failure to stderr as `Logout failed: …`. **(verified, by reading the code, the log and the CLI binary)**

**[F03] A logout that succeeds while another login remains is silent.** After `claude_logout_result`, tugcast probes again and broadcasts the auth state. If the probe still says logged in, `authStore` keeps the user logged in, Configure Tug never opens, and no alert fires (`tugdeck/src/components/chrome/logout.tsx` alerts only on `logoutError`). Given [F07] (a subscription login outranks the profile), the first press most likely removed the subscription login and uncovered the `ant` profile beneath it. That is inference. **(verified for the code path; inferred for what happened)**

**[F04] Tug carries `authMethod` and displays nothing from it.** `AccountInfo.auth_method` is parsed from the probe and sent on the wire (`broadcast_auth_result`), and it lands in `authStore` (`tugdeck/src/lib/auth-store.ts`). No component reads it. `apiKeySource` is not parsed at all, and neither are the fields the CLI adds for a subscription login: `orgName`, `storedClaudeAiLogin`, `planTier`. The signed-in row in `configure-tug.tsx` and `logoutConfirmMessage` (`configure-tug-copy.ts`) show only the email and plan, and fall back to a generic sentence when there's no email. The dialog the user saw was that generic sentence. **(verified)**

**[F05] The card's shell and Tug answer "am I logged in" differently.** Tug strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` before the probe and before every session (`AUTH_ENV_VARS` in `claude_auth.rs`, and `agent_bridge`). The card's shell does not. After the `ant` profile was cleared, `claude auth status --json` in that shell reported `authMethod: "api_key"`, `apiKeySource: "ANTHROPIC_API_KEY"`. **(verified)**

**[F06] While the Console profile was the active login, Tug sessions ran on it.** Sessions remove only the environment variables in [F05]. The `ant` profile is a file, so a session spawned during that window authenticated with the Console org's token, not the user's subscription. That probably means pay-per-token API billing to that org. **(inferred; the billing consequence is not confirmed)**

**[F07] Precedence, by experiment.** `claude auth status --json` (2.1.325) was run against each source alone and in pairs. All credentials were fake and lived under `/tmp/login-exp/`, with the experiment script at `/tmp/login-exp/run.sh`. The stored subscription login was the user's real one, read and never changed. As `auth status` reports them, from highest to lowest:

| Rank | Source | `authMethod` | `apiKeySource` |
|---|---|---|---|
| 1 | `apiKeyHelper` in Claude Code settings | `api_key_helper` | `apiKeyHelper`, or the env key's name if one is also set |
| 2 | `ANTHROPIC_AUTH_TOKEN` | `oauth_token` | absent, or `ANTHROPIC_API_KEY` if one is also set |
| 3 | `ANTHROPIC_API_KEY` | `api_key` | `ANTHROPIC_API_KEY` |
| 4 | `CLAUDE_CODE_OAUTH_TOKEN` | `oauth_token` | absent |
| 5 | Stored subscription login (`claude auth login`) | `claude.ai`, with `email`, `orgName`, `subscriptionType`, `planTier` | absent |
| 6 | `ant` Console profile | `oauth_token` | absent |
| — | nothing | `none`; `auth status` exits 1 | — |

Pairs tested: subscription+profile → subscription; key+subscription → key; either token variable+subscription → token; key+profile → key; key+`CLAUDE_CODE_OAUTH_TOKEN` → key; `ANTHROPIC_AUTH_TOKEN`+key → auth token; helper+key and helper+profile → helper. Three things follow:
- `oauth_token` with no `apiKeySource` is ambiguous. It can mean rank 2, 4 or 6, so `authMethod` alone cannot name the source.
- Every source above rank 5 overrides a subscription silently.
- The profile is only a fallback. It is reached when nothing else is present, which is how [F01] happened.

**(verified for `auth status`. Not verified: that requests follow the same order, and how a settings-file `env` block that sets one of these variables ranks.)**

**[F08] The `ant` CLI keeps profiles by a fixed convention, and Claude Code reads it.**
- The config dir is `$ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic`.
- The active profile is `$ANTHROPIC_PROFILE`, else the name in `<dir>/active_config`.
- The profile's config is `<dir>/configs/<profile>.json`. Its `authentication.type` is `user_oauth` for a browser login, and it carries `organization_id` and `workspace_id`.
- Its token lives in `authentication.credentials_path`, else `<dir>/credentials/<profile>.json`.

Claude Code treats a `user_oauth` profile as present only when that credentials file is non-empty. Read from the `ant` man page, `ant auth status`, and the resolution code in the `claude` binary. Rows 14 and 15 of the experiment confirmed that `XDG_CONFIG_HOME` is honoured and that a missing `ANTHROPIC_PROFILE` falls through to the subscription. `ant auth logout` deletes the credentials file and leaves `active_config` and `configs/`. **(verified)**

---

## Decisions {#decisions}

**[B01] Tug names the login source wherever it shows a login.** The probe keeps the whole of `claude auth status --json`: `authMethod`, `apiKeySource`, `email`, `orgName`, `subscriptionType`, `planTier`. It maps that to one of *subscription*, *Console profile*, *environment key*, *environment token*, *settings helper*, *unknown*. An ambiguous `oauth_token` is resolved by [B07]. Configure Tug's signed-in row and the logout confirmation say which source it is, in words. A non-subscription login says that it is not the user's Claude subscription and that it is billed per token to the organisation it belongs to, named where known. *Unknown* is said plainly, and the generic sentence goes. This rules out hiding a source because it has no email: the no-email case is exactly the one that confused the user.

**[B02] Logout acts on the source it can actually clear.**
- Subscription: today's flow, `claude auth logout`.
- Console profile: name the profile and where it lives, and offer `ant auth logout` as a command for the user to run. Tug doesn't run it.
- Environment key or token, or settings helper: no Log Out button. Tug says it can't remove this login, names the variable or setting, and says where it is read from.

A single Log Out that runs one command for every source is what produced [F03].

**[B03] After logout, Tug checks again and reports what it found.** If the check still finds a login, the user is told: "Your subscription login was removed, but Claude Code is still signed in through <source>", followed by the step for that source. Under [F07] the only source that can sit beneath a subscription is the Console profile, so in practice that is the case to name. A logout that returns with nothing visible is a defect, whatever the CLI's exit code.

**[B04] Tug warns about a login that outranks or underlies the subscription.** If a stored subscription login and a Console profile are both present, the logout confirmation says Claude Code will fall back to the profile. If a source above rank 5 is active while a subscription login is stored, Configure Tug says the subscription is being overridden and by what. Nothing in the session's environment can do this, since sessions strip the variables, so in practice it is a settings helper or a settings `env` block.

**[B05] Tug shows the shell's auth variables and does not scrub them.** When the card's shell environment holds an auth variable that Tug strips for sessions, Configure Tug notes it: the variable's name, and that sessions ignore it while `claude` run in a shell uses it. The shell is the user's, and Tug does not edit it. The fix for [F05] is making the difference visible.

**[B06] Tugcast logs every logout.** Each logout records the exit code, the tail of stdout and stderr, and the source before and after. The error the user sees comes from stderr, or from stdout when stderr is empty. This closes [F02]: the next "why did it fail" is answered from the log.

**[B07] Tug detects a Console profile by the `ant` convention, reading only config.** Tug resolves the config dir and the active profile exactly as [F08] describes, using the same environment Claude Code sees. It reads `configs/<profile>.json` for the auth type, org and workspace, and checks only that the credentials file exists and is non-empty. It never opens the credentials file and never runs `ant`. The convention is what Claude Code itself reads, so Tug's answer cannot drift from Claude Code's while the convention holds. Not needing `ant` on `PATH` matters too, because Claude Code reads a profile without it. Running `ant auth status` was rejected: it couples Tug to that CLI's output and to its being installed.

**[B08] A session never starts on a pay-per-token login without the user's confirmation.** The subscription is the expected way to run Tug. When the active source is anything other than *subscription*, the gate that opens a session first asks the user to confirm. The ask names the source and the organisation it bills to. The confirmation is remembered for that login (source plus profile or org, or the variable's name) and asked again when the login changes. It is revocable from Configure Tug. Declining leaves the session unopened and offers the path to a subscription login. This settles the question [F06] raised: quietly billing a Console org was the worst consequence of the confusion, worse than the confusion itself.

---

## Open Questions {#open-questions}

- **Does a request authenticate in the same order `auth status` reports?** [F07] measures the status command only. The first arc step should confirm it against a real session start, using the session's own `system/init` record or the account it reports. [B08] gates on the reported source, so a mismatch would make that gate guard the wrong login.
- **Where does a settings-file `env` block rank?** Claude Code applies `env` from `~/.claude/settings.json` inside its own process, past Tug's scrub. Neither the experiment nor the code reading pinned it down. It decides whether [B04]'s override warning and [B08]'s gate must read settings files too.

---

## Non-goals {#non-goals}

- **Tug running `ant auth logout` itself.** It revokes a Console login that other tools may depend on, and the user didn't create it through Tug. Tug offers the command and the user runs it.
- **Scrubbing auth variables from the card's shell.** That would make the shell disagree with the user's terminal instead, and hide the very login the user needs to see. See [B05].
- **Running `ant` to detect a profile.** Rejected in [B07].
- **Managing several accounts or switching between them.** Account switching was abandoned on 2026-10-08. This brief only makes the active login legible, its logout honest, and its billing chosen.
- **Reading credentials from the keychain or from token files.** Tug asks the CLI and reads the config, never the secrets. [B07] checks that a credentials file exists and is non-empty, and never reads it.

---

## Exit {#exit}

An arc. Its first steps, in roughly this order:

1. **Close the open questions:** confirm that request-time authentication matches [F07], and rank a settings `env` block. The experiment harness at `/tmp/login-exp/run.sh` is the starting point. It is scratch and needs to be rewritten as a test that pins the [F07] table against the CLI.
2. **Carry the source on the wire:** parse the full status in tugcast, add [B07]'s profile detection, map to the [B01] set, and add [B06]'s logging.
3. **Name the source** in Configure Tug's signed-in row and the logout confirmation, with [B04]'s warnings.
4. **Logout per source** ([B02]), plus the check-afterwards message ([B03]).
5. **The pay-per-token gate** ([B08]) at session open.
6. **The shell-environment note** ([B05]).
