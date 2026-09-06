# ConfigureTug — the one tool the machine has to supply

**Status:** sketch, unbuilt. Investigation + proposed shape.

ConfigureTug's step 1 is "Claude Code", and it assumes the machine already
carries everything else Tug shells out to. On a fresh Mac that assumption is
wrong in exactly one place — `git`. This is the survey, the decision on how to
close the gap, and the shape of the row.

## What Tug actually asks of the machine

Every `Command::new` in `tugrust/crates`, plus the Swift host and the plugin,
sorts into five classes.

**Bundled — nothing to check.** `tmux` is inside `Tug.app`:
`tugrust/scripts/fetch-tmux.sh` builds a relocatable, statically-linked tmux from
pinned source, `scripts/build-app.sh` lands it in `Contents/Resources/bin/`, and
`ProcessManager` points `TUG_TMUX`/`TERMINFO_DIRS` at it. `tugcore::instance::tmux_bin()`
only falls back to a system tmux when the user sets `TUG_USE_SYSTEM_TMUX`.

**Always on macOS — nothing to check.** `sh`, `bash`, `curl`, `ps`, `lsof`,
`which`, `open`, `man`, `tccutil`, `/usr/libexec/PlistBuddy`.

**Already a wizard step.** `claude`, installed and updated by row one.

**Required, absent on a fresh Mac, unhandled anywhere today — `git`.** 255 call
sites, more than every other external binary combined: the changes ledger, the
Changes shade, every arc worktree, and the whole commit surface. The floor is
**git 2.23** — `git switch` and `git restore` both arrived there (2019);
`--porcelain=v2` (2.11) and `--no-optional-locks` (2.15) are older. Today a
missing git surfaces as a shell-out failing deep inside a feature, phrased as
that feature's error.

**Checkout-only — must never be checked.** `just`, `jq`, `bun`, `node`, `gh`,
`rg`. `just` reads like a candidate because every recipe here is one, but
`tugplug/CLAUDE.md` refuses the word inside the plugin precisely because a user's
project has no `justfile`. The project-declared build (`.tugtool/config.toml`,
`just app-debug` in this checkout) is a real dependency, but it is per-project,
discovered when an arc first builds, and belongs to `tugtool arc doctor` — not to
a launch-time wizard that runs before any project is chosen.

So: **one gap, and it is git.**

## Decision: Tug does not ship git

Bundling git the way tmux is bundled is technically straightforward — it links
only system libraries once `NO_GETTEXT`/`NO_PERL`/pcre2-off are set, and
`fetch-tmux.sh` is a working template for exactly this. **It is rejected on
licensing.** Git is GPLv2-only, and Tug does not take on GPL obligations,
including the source-offer obligation that shipping a GPL binary would create.
Every other bundled component (tmux/ISC, libevent/BSD, ncurses/MIT-ish,
utf8proc/MIT) is permissive, and that is the line.

The Apple Command Line Tools route keeps that line cleanly: the GPL program
arrives from **Apple**, installed by the user, from Apple's servers. Tug ships
nothing, distributes nothing, and takes on no obligation. It only points.

## Is `xcode-select` guaranteed to be there?

**Yes. It cannot be missing on a booted Mac.** Verified on macOS 15 (Darwin 24.6):

- `/usr/bin/xcode-select` sits on `/dev/disk3s1s1` — the **sealed System volume
  snapshot**. That volume is read-only and cryptographically sealed; a user
  cannot delete the file, and an installer cannot fail to place it.
- `codesign -dv` reports `Identifier=com.apple.xcode-select`, `Authority=Software
  Signing`, `Platform identifier=16` — an Apple platform binary, part of the OS
  itself.
- `pkgutil --file-info` returns no owning package receipt, which is what a base-OS
  file looks like (as opposed to something a `.pkg` dropped).

Same for `/usr/bin/xcrun`. And `/usr/bin/git` is always present too — but as a
**shim**: it is byte-identical to `/usr/bin/clang` (same SHA-256, link count 78,
one shim hardlinked under every developer-tool name), and its job when no
developer directory is active is to pop the "install the command line developer
tools?" dialog.

**So the program is never missing. What can fail is the install it triggers**, and
that is what the design has to handle:

| failure | what the row does |
|---|---|
| user cancels Apple's dialog | nothing installed; `xcode-select --install` already returned. Row stays offering, Recheck available |
| MDM-managed Mac blocks software installs | the offer will never settle; after a long wait, fall back to prose ("ask your administrator", plus the manual link) |
| no network | Apple's installer reports it; Tug re-probes and stays where it was |
| already installed | `xcode-select --install` exits **1** with "already installed" — must be read as fine, never as an error |
| full Xcode.app, no separate CLT | `xcode-select -p` points into Xcode and git is there. Already satisfied; offer nothing |
| stale developer dir (Xcode.app deleted) | `-p` succeeds but git fails. The fix is `--install` (or `--switch`), and the row should say which |

Manual escape hatch in prose for anyone who wants it: the Command Line Tools
package at `developer.apple.com/download` (Apple ID required), or Xcode from the
App Store.

## Probing without ambushing the user

The hostile detail: **merely running `git --version` on a Mac with no developer
directory pops Apple's install dialog.** A launch-time probe done naively throws
a system modal in the user's face before the wizard has said a word. And it
would be wrong as often as it was rude — a user with Homebrew git and no CLT has
a perfectly good git.

The order that is both silent and correct:

1. **Resolve `git` on `PATH`.** If it resolves to anything other than
   `/usr/bin/git`, it is a real git (Homebrew, MacPorts, Nix). Run `--version`.
   No dialog is possible, and the CLT question never comes up.
2. **If it resolves to `/usr/bin/git` or to nothing**, that is the shim. Ask
   `xcode-select -p` first — silent, never prompts, exits 2 when no developer
   directory is active. Only on exit 0 is it safe to run `git --version`.
3. **Compare against the 2.23 floor.**

Step 1 is what stops the common case from ever reaching the shim, and step 2 is
what stops the uncommon case from popping a dialog. Both are load-bearing.

## Shape of the change

Mirrors the Claude row's plumbing everywhere it can.

**Backend — `tugrust/crates/tugcast/src/feeds/host_tools.rs`** (new, beside
`claude_auth.rs`):

- `probe() -> HostTools { git_version: Option<String>, git_path: Option<String>, developer_dir: Option<String> }`
  implementing the three-step order above. Version parsing reuses the leading-
  `MAJOR.MINOR.PATCH` helper `claude_auth::parse_version` already has — lift it
  into a shared spot rather than copying it.
- `offer_developer_tools() -> (bool, Option<String>)` — runs `xcode-select --install`,
  with exit 1 + "already installed" folded to success.

**Actions — `tugcast/src/actions.rs`**, two verbs alongside `check_auth` /
`install_claude`: `check_host_tools` → broadcasts `host_tools_result`;
`offer_host_tools` → runs the offer, broadcasts the outcome, re-probes.

**Settling the row without polling.** Apple's installer is a GUI the backend
cannot await, and a timer asking "is git here yet?" every two seconds is exactly
the polling the house forbids. Watch the thing instead: an FS watch on
`/Library/Developer/CommandLineTools` fires a re-probe when the tools land. A
**Recheck** CTA sits on the row as the manual answer, covering both a missed
watch and the user who took the manual route.

**Frontend:**

- `tugdeck/src/lib/host-tools-store.ts` — the [L02] store; probe fired from
  `main.tsx` beside `check_auth` and `check_claude_version`.
- `configure-tug.tsx` — a `toolsStep` above `claudeStep`.
- `configure-tug-copy.ts` — `hostToolsCopy(tools)`, pure and unit-tested next to
  `claudeInstalledCopy`. `compareVersions` is already there for the floor.

**The row's states**, in the existing `StepStatus` vocabulary:

| condition | status | copy | CTA |
|---|---|---|---|
| probe in flight | `pending` | "Checking for git…" | — |
| shim only, no developer dir | `active` | "Tug needs git. Apple's Command Line Tools include it — about 3 GB." | **Install** + Skip for now |
| offer accepted | `busy` | "Finish the install in Apple's installer window." | Recheck (ghost) |
| offer failed | `error` | the last stderr line + the manual link | **Try Again** |
| git below 2.23 | `active` | "git 2.19 is here; Tug needs 2.23 or newer." | **Update** |
| git present | `done` | "git 2.51.0" | — |

**Say the size out loud.** The Command Line Tools are ~2.8 GB installed. A row
that says "Install" without saying that is an ambush, and a user on a metered or
nearly-full machine deserves the number before they click.

**Tests.** An app-test beside `at0440-configure-tug-version-row.test.ts`,
`@covers`-ing the new store, the copy module, and the feed, driving a **faked**
probe result — every developer machine running the corpus has git and would
otherwise decide the outcome. Rust unit tests on the version parse, the
exit-1-means-installed reading, and the resolve order (a PATH git that is not
`/usr/bin/git` must never consult `xcode-select`).

**Docs.** A `[D…]` entry for the probe order — it is precisely the kind of thing
a later simplification would collapse back into a dialog-popping `git --version` —
and the new row in the `configure-tug.tsx` docblock's step list.

## Calls to make before building

1. **Blocking, or deferrable?** Recommendation: **deferrable** — a "Skip for now"
   beside the Install CTA. Git is load-bearing for Changes, commits, and arcs,
   but 2.8 GB is a lot to demand before a user has seen the app work once, and
   plenty of first sessions are a chat in a scratch directory. The hard block
   belongs where the need is real: the Changes shade and the arc doors present
   the same offer when they are actually stuck. This is the one place I'd diverge
   from "pre-step 1 blocks everything".
2. **Enforce the 2.23 floor?** Recommendation: yes. One comparison, and a 2.19
   git otherwise fails at `git switch` inside an arc rather than at the door.
3. **How long before the "managed Mac" prose appears?** The MDM case is
   indistinguishable from a slow download except by time. Something like ten
   minutes with no change, then soften the copy and show the manual link.

## Related cleanup already done

`THIRD_PARTY_NOTICES.md` had no entry for `tmux` or for the three libraries
statically linked into the tmux we ship (libevent, ncurses, utf8proc), though
`fetch-tmux.sh` already collects their license texts and `build-app.sh` stages
them at `Contents/Resources/third-party-licenses/`. All four are now recorded.
