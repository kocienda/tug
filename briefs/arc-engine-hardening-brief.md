<!-- brief-skeleton v1 -->

# Arc-engine hardening: no bare `git --version`, a race-free `write_atomic`, and no leaked interrogation shell

**Purpose:** Three small robustness defects in the Rust crates behind `tugtool arc`: the arc engine probes `git --version` on whatever `git` is on `PATH`, in two copies with two parsers, against the one rule the project states most firmly; `write_atomic` uses a fixed temp name so two writers race; and `tuggram`'s shell interrogation leaks a login shell on timeout.

---

## Purpose {#purpose}

Items 3 and 11 of `briefs/audit-punch-list.md`:

> 3. Route `git_supports_merge_base_flag` and `git_supports_merge_tree` through `tugcore::host_tools` instead of running `--version` on whatever is on PATH, and keep one parser.
> 11. Unique temp file in `write_atomic` in `ops.rs`, and kill the leaked login shell in `tuggram/src/words.rs` on timeout.

`CLAUDE.md`: "never add a bare `git --version` probe anywhere, and never collapse the order into one". The order is in `tugcore::host_tools::probe`.

---

## Evidence {#evidence}

**[F01] Two bare version probes** — `tugrust/crates/tugarc-core/src/resolve.rs:694` (`git_supports_merge_base_flag`, floor 2.40) and `ops.rs:3282` (`git_supports_merge_tree`, floor 2.38) each call `git_stdout(repo, &["--version"])`, then split on whitespace and parse `major.minor` by hand. `git_stdout` wraps `tugcore::git_command()`, which is `Command::new("git")`, so the binary is `PATH`-resolved with no shim check. **(verified)**

**[F02] The sanctioned implementation already exists** — `tugcore::host_tools::probe()` resolves `git` on `PATH`, runs `--version` only on a non-shim resolution, and reaches `xcode-select -p` before ever running the shim. It returns `HostTools { git_version: Option<String>, git_path, developer_dir }`, and `meets_floor` compares version components. There is no "at least X.Y" helper and no process-level cache; `probe` runs `xcode-select` each call. **(verified)**

**[F03] Where the probes are reachable from** — `tugtool arc` runs `host_tools::refusal(&probe())` in its preflight (`tugtool/src/arc.rs:157`) before any arc verb, so from the CLI the modal cannot pop. tugcast's join and resolve paths call into `tugarc-core` from feeds without that preflight, and the deck's `TugNoGitNotice` is a display, not a guard on those calls. So the exposure is tugcast on a machine with the shim and no developer directory. **(verified by reading; not reproduced on such a machine)**

**[F04] `write_atomic` races on a fixed sibling name** — `ops.rs` writes `.{stem}.tugtmp` beside the target, then renames. tugcast (arc runner) and the CLI (`tugtool arc step …`) both write arc documents; two concurrent writers share the temp path and one rename replaces the other's partial file. No `fsync` precedes the rename. `tempfile` is already a dependency of the crate. Four call sites. **(verified)**

**[F05] `tuggram` leaks a login shell on timeout** — `tuggram/src/words.rs::run_interrogation` spawns `$SHELL -ilc <script>` on a detached thread with `cmd.output()` and waits on an mpsc `recv_timeout`. On timeout the thread, the child, and its `setsid` session are abandoned; `output()` keeps waiting for the child forever. A `.zshrc` that blocks (a prompt, a network call) leaks one interactive shell per interrogation. **(verified)**

---

## Decisions {#decisions}

**[B01] `tugcore::host_tools` gains `git_version_at_least(major, minor) -> bool` over a once-per-process cached probe, and both arc-engine checks call it.** The cache is an `OnceLock<HostTools>`: the probe runs `xcode-select` and `git --version`, and a join can ask twice. The two hand parsers are deleted; `meets_floor`'s component comparison is generalized rather than duplicated. This keeps the forbidden shape out of `tugarc-core` by construction, since that crate no longer spells `--version` at all.

**[B02] The `tugcore::git_cmd` tests get a tripwire: no file under `tugarc-core`, `tugchanges-core`, `tugtool`, or `tugcast` passes `"--version"` to a git command.** The `no_ad_hoc_ledger_opens` test is the model: a source-scan test is what keeps a rule true after the people who learned it the hard way have moved on.

**[B03] `write_atomic` uses `tempfile::NamedTempFile::new_in(dir)`, syncs, and `persist`s.** Unique name per writer, so the race in [F04] becomes "last rename wins", which is the correct semantics for two writers of a whole document. `sync_all` before persist is cheap at four call sites and is what "atomic" promised.

**[B04] `run_interrogation` owns its child: `spawn()`, poll `try_wait` against the deadline, `kill()` the process group on timeout, then reap.** The thread goes away; the function reads stdout to a bounded buffer. The `setsid` stays, since it exists to keep the shell off the caller's terminal, and it is also what makes `kill(-pgid)` reach anything the shell started.

**[B05] Three steps, one arc, any order.** They share a crate neighbourhood and a size, not a dependency.

---

## Open Questions {#open-questions}

- Whether tugcast should call the cached probe at feed start so the no-git state is known before a join is attempted, rather than discovering it inside `resolve`. Likely yes, and cheap once [B01] exists; the arc can decide when it sees the call sites.

---

## Non-goals {#non-goals}

- **Making `tugcore::git_command()` resolve the binary through `host_tools`.** Tempting, but it would put a `xcode-select` call under every git invocation and change the one function every crate routes through. The version probe is the only call that can pop the modal; gate that.
- **A general `tugcore` "safe process" wrapper for the `tuggram` fix.** One call site; a wrapper is a design for a second caller that does not exist.

---

## Exit {#exit}

An arc. Three steps: the cached probe helper plus the source-scan tripwire and the two call-site rewrites, with `cargo nextest run -p tugcore -p tugarc-core`; `write_atomic` on `NamedTempFile` with a two-writer unit test; `run_interrogation` with a timeout test that uses a shell script that sleeps past the deadline and asserts no child survives.
