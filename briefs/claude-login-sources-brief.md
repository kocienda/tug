<!-- brief-skeleton v1 -->

# Claude login sources

**Purpose:** Claude Code can be signed in through several sources, and Tug reports all of them as a single "logged in" with an optional email. Its one Log Out clears only the subscription login, so on 2026-11-21 a logout appeared to fail and the user was left very confused about which account Tug was using and why logging out did nothing.

---

## Purpose {#purpose}

The user pressed File → Log Out, confirmed "Log Out of Claude?", and stayed logged in. Two more presses changed nothing visible. The day before, they had installed Anthropic's `ant` CLI and run `ant auth login`. After clearing that, `claude auth status` in the card's shell reported a third login, an `ANTHROPIC_API_KEY` from the environment. In the user's words: "we need to be more savvy about these different login types in the app. I was left very confused."

The problem is not that logout broke. Tug has no idea *which* login is active, shows none of that to the user, and treats a logout that leaves another login in place as nothing worth mentioning.

---

## Evidence {#evidence}

**[F01] Claude Code fell back to the `ant` CLI's Console profile once its own login was gone.** With `~/.config/anthropic` present, `claude auth status --json` (2.1.325) reported `loggedIn: true`, `authMethod: "oauth_token"`, no email. With the config hidden (`XDG_CONFIG_HOME=/tmp/emptycfg claude auth status --json`), it reported `loggedIn: false`, `authMethod: "none"`. There was no `Claude Code-credentials` keychain item and no `oauthAccount` in `~/.claude.json`. `ant auth status` showed the active `default` profile, a `user_oauth` token for the Console org "self", and the credentials file had been rewritten at 09:44, the minute of the logout attempts. **(verified)**

**[F02] Each Log Out ran `claude auth logout`, and nobody can tell from the record what it returned.** The tugcast log has `dispatch_action: claude logout requested` at 17:44:20, 17:44:40 and 17:44:52 UTC. `logout()` (`tugrust/crates/tugcast/src/feeds/claude_auth.rs`) returns `(ok, error)`. The `ClaudeLogout` arm in `tugrust/crates/tugcast/src/actions.rs` sends that result as `claude_logout_result` and never logs it. The error text keeps only the last line of stderr, so a CLI that reports on stdout reads as "logout failed". **(verified, by reading the code and the log)**

**[F03] A logout that succeeds while another login remains is silent.** After `claude_logout_result`, tugcast probes again and broadcasts the auth state. If the probe still says logged in, `authStore` keeps the user logged in, Configure Tug never opens, and no alert fires (`tugdeck/src/components/chrome/logout.tsx` alerts only on `logoutError`). Whether the user's presses hit this case or a non-zero exit is unknown, per [F02]. The first press most likely removed the subscription login, because it was gone afterwards. That is inference. **(verified for the code path; inferred for what happened)**

**[F04] Tug carries `authMethod` and displays nothing from it.** `AccountInfo.auth_method` is parsed from the probe and sent on the wire (`broadcast_auth_result`), and it lands in `authStore` (`tugdeck/src/lib/auth-store.ts`). No component reads it. `apiKeySource` is not parsed at all. The signed-in row in `configure-tug.tsx` and `logoutConfirmMessage` (`configure-tug-copy.ts`) show only the email and plan, and fall back to a generic sentence when there's no email. The dialog the user saw was that generic sentence. **(verified)**

**[F05] The card's shell and Tug answer "am I logged in" differently.** Tug strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` before the probe and before every session (`AUTH_ENV_VARS` in `claude_auth.rs`, and `agent_bridge`). The card's shell does not. After the `ant` profile was cleared, `claude auth status --json` in that shell reported `authMethod: "api_key"`, `apiKeySource: "ANTHROPIC_API_KEY"`. **(verified)**

**[F06] While the Console profile was the active login, Tug sessions ran on it.** Sessions remove only the environment variables in [F05]. The `ant` profile is a file, so a session spawned during that window authenticated with the Console org's token, not the user's subscription. That probably means API billing to that org. **(inferred; the billing consequence is not confirmed)**

---

## Decisions {#decisions}

**[B01] Tug names the login source wherever it shows a login.** The probe keeps the whole of `claude auth status --json`, including `authMethod` and `apiKeySource`, and maps it to a small set: *subscription*, *Console profile*, *environment key*, *settings helper*, *unknown*. Configure Tug's signed-in row and the logout confirmation say which one in words. A non-subscription login says that it is not the user's Claude subscription and, where known, what it bills to. *Unknown* is said plainly. It never falls back to a generic sentence. This rules out hiding a source because it has no email: the no-email case is exactly the one that confused the user.

**[B02] Logout acts on the source it can actually clear.**
- Subscription: today's flow, `claude auth logout`.
- Console profile: name where it comes from, and offer `ant auth logout` as a command for the user to run. Tug doesn't run it.
- Environment key or settings helper: no Log Out button. Tug says it can't remove this login, names the variable or setting, and says where it is read from.

A single Log Out that runs one command for every source is what produced [F03].

**[B03] After logout, Tug checks again and reports what it found.** If the check still finds a login, the user is told: "Your subscription login was removed, but Claude Code is still signed in through <source>", followed by the step for that source. A logout that returns with nothing visible is a defect, whatever the CLI's exit code.

**[B04] Before logout, Tug warns about a fallback login.** If a lower-precedence source is also present, such as an `ant` profile behind a subscription login, the confirm dialog says Claude Code will fall back to it. This depends on knowing the precedence order (see Open Questions).

**[B05] Tug shows the shell's auth variables and does not scrub them.** When the card's shell environment holds an auth variable that Tug strips for sessions, Configure Tug notes it: the variable's name, and that sessions ignore it while `claude` run in a shell uses it. The shell is the user's, and Tug does not edit it. The fix for [F05] is making the difference visible.

**[B06] Tugcast logs every logout.** Each logout records the exit code, the tail of stdout and stderr, and the source before and after. The error the user sees comes from stderr, or from stdout when stderr is empty. This closes [F02]: the next "why did it fail" is answered from the log.

---

## Open Questions {#open-questions}

- **What order does Claude Code check these sources in?** Settled by experiment on the current CLI, not by docs, since [F01] was itself undocumented behaviour. [B04], and whether [B03]'s message can name the next source, depend on the answer. The experiment should also pin which `authMethod` / `apiKeySource` values each source produces, because the mapping in [B01] is built from them.
- **How does Tug detect a Console profile: run `ant auth status` when it is installed, or read `~/.config/anthropic/active_config` and the credentials file directly?** Reading the files doesn't need `ant` on `PATH`. Running `ant` couples Tug to that CLI's output. Leaning towards reading the files, but it depends on whether Claude Code's own reading is stable across versions.
- **Should a session start on a non-subscription login without the user agreeing?** [F06] means Tug can quietly run on Console billing. One option is a one-time agreement per source before the first session runs on it. This is the user's call about the product, not a technical one.

---

## Non-goals {#non-goals}

- **Tug running `ant auth logout` itself.** It revokes a Console login that other tools may depend on, and the user didn't create it through Tug. Tug offers the command and the user runs it.
- **Scrubbing auth variables from the card's shell.** That would make the shell disagree with the user's terminal instead, and hide the very login the user needs to see. See [B05].
- **Managing several accounts or switching between them.** Account switching was abandoned on 2026-10-08. This brief only makes the active login legible and its logout honest.
- **Reading credentials from the keychain or from token files.** Tug asks the CLIs and reads the config, never the secrets.

---

## Exit {#exit}

An arc. Its first steps, in roughly this order:

1. **The experiment:** for each source, record the `claude auth status --json` values it produces and which source wins when two are present. This answers the first open question, and everything after it depends on that answer.
2. **Carry the source on the wire:** parse `apiKeySource` in tugcast, map to the [B01] set, and add the logout logging from [B06].
3. **Name the source** in Configure Tug's signed-in row and the confirm dialog, with [B04]'s fallback warning.
4. **Logout per source** ([B02]), plus the check-afterwards message ([B03]).
5. **The shell-environment note** ([B05]).

Whether sessions should be held for agreement on a non-subscription login is the user's call before step 3 lands.
