# Git Path Fidelity

**Purpose:** A file whose name git considers unusual — `01_Stanisław_…jpg` — made a whole commit impossible, with a retry button that could never succeed. The ask is that a path Tug reads from git is always the file's real name, so that this class of failure cannot recur anywhere Tug lists or commits files.

---

## Purpose {#purpose}

In the `eucit/ferny-ladle` session the commit sheet refused a sixty-file commit with:

> pathspec '"01_Stanis\305\202aw_Kocienda_Polish_Army_Form_B_Medical.jpg"' did not match any file(s) known to git
>
> Read git's message below, fix what it names, and try again — your message is kept.

There was nothing for the user to fix. The file exists and is named correctly; the string git rejected is one Tug manufactured. "Retry commit" re-sends the same string, so it fails identically forever. The user's question was what prevents this "*ever again*" — not what unblocks this one commit.

---

## Evidence {#evidence}

**[F01] Git C-quotes unusual paths in line-oriented output, and Tug takes the quoted form as the path.** In any listing without `-z`, git wraps a path containing a non-ASCII byte, `"`, `\`, a tab or a newline in double quotes and escapes the bytes; `ł` (UTF-8 `C5 82`) becomes `\305\202`. `parse_status_porcelain_v2` (`tugrust/crates/tugchanges-core/src/git.rs:143`) stores that field verbatim in `StatusEntry.path` and `StatusReport.untracked`. Read from the code. **(verified)**

**[F02] The quoted string reaches git as a pathspec.** It becomes the key of `v1_status_map`, the row in the changes list, and an operand of `git commit -m … -- <paths>` (`tugrust/crates/tugchanges-core/src/commit.rs:308`) and the `git add --` before it (`commit.rs:302`, `:390`). Git looks for a file whose name begins with a literal `"` and finds none. The doubled quoting in the banner is git quoting Tug's already-quoted string. Read from the code. **(verified)**

**[F03] Reproduced outside eucit.** A scratch repo with `Stanisław.jpg`, `plain name.txt`, `tab<TAB>x.txt` and `quo"te.txt`: the debug `tugtool changes --json` reports `"path": "\"Stanis\\305\\202aw.jpg\""`, `"\"quo\\\"te.txt\""` and `"\"tab\\tx.txt\""`. Only `plain name.txt` survives intact — a space alone does not trigger quoting in porcelain v2. **(verified)**

**[F04] `core.quotepath=false` is a partial cure; `-z` is the total one.** In the same repo, `-c core.quotepath=false` un-quotes `Stanisław.jpg` but leaves the `"` and tab names quoted. `-z` yields every name as its raw bytes. `core.quotepath=false` is already applied at exactly one site (`tugrust/crates/tugcast/src/feeds/changeset.rs:1981`, with a comment explaining why) — a local discovery that never spread. **(verified)**

**[F05] The failure is atomic and the retry is futile.** One quoted operand fails the entire `git commit`, so one unusual file among N blocks all N. The sheet's retry resubmits the same operands. Follows from [F02] and the screenshot; the retry path was not traced in code.

**[F06] The defect is everywhere Tug lists paths.** About 90 path-bearing git invocations (`status --porcelain`, `--name-only`, `--name-status`, `--numstat`, `ls-files`, `ls-tree`) across 22 Rust files; 32 are in `tugrust/crates/tugarc-core/src/ops.rs`, 14 in `tugchanges-core/src/commit.rs`. None passes `-z`. Counted by grep, test modules included in the count; the production share was not separated out. **(verified as an order of magnitude)**

**[F07] No call site uses literal pathspecs.** No occurrence of `GIT_LITERAL_PATHSPECS`, `--literal-pathspecs` or `--pathspec-from-file` in `tugrust/crates`. So an operand after `--` is still a *pattern*: a file named `*.jpg` or `:(top)x` handed to `git add --` is glob- or magic-matched. Grep is verified; the mis-staging consequence is git's documented behaviour and was not reproduced.

**[F08] Attribution probably misses silently for such files.** The changes ledger records the real path from the tool input; the status side yields the quoted key ([F01]). The join in `tugchanges-core/src/changes.rs` would therefore never match, leaving a non-ASCII file unattributed with no error. **Inference — not verified.** Confirm by editing a `ł`-named file through `Edit` in a scratch project and reading `tugtool changes --json`.

**[F09] There is already a chokepoint, and a precedent for guarding it.** Every production git spawn goes through `tugcore::git_command()` (`tugrust/crates/tugcore/src/git_cmd.rs:22`), enforced by the source-scanning test `no_ad_hoc_git_spawns` (`git_cmd.rs:48`), whose own comment gives the reason: "a per-call-site rule is the one that was forgotten." **(verified)**

**[F10] TypeScript does not feed paths to git.** `tugcode` runs no git. `tugdeck` consumes typed fields produced by Rust, with two exceptions that scrape raw numstat text for display only: `tugdeck/src/components/tugways/body-kinds/commit-block.tsx` and `tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx`. They would mis-render a quoted path but never return one to git. Established by grep and by reading the matched lines, not the whole files.

**[F11] It survived because every fixture is ASCII.** The Tug checkout contains no unusual filenames, so neither do its test repos. eucit — scans of Polish records — is the first project with real-world names. Inference from the repo's contents; no test was found that seeds a non-ASCII path, but the search was not exhaustive.

---

## Decisions {#decisions}

**[B01] Path listings go through one typed door that always uses `-z`.** A function family in the shared git layer (`tugchanges-core::git` or `tugcore`) appends `-z`, splits on NUL, and returns real paths. The four parsers — status v2, name-status, numstat, name-only — are rewritten once against NUL records, including the `-z` rename shape, where the original path arrives as a *separate* NUL field rather than after a tab. The alternative, an unquoter applied at each parser, was rejected: it fixes the symptom at 90 sites instead of removing the encoding at one, and [F04] shows how a per-site fix fails to spread. With the door, no unquoting code exists because nothing is ever quoted.

**[B02] A source-scan guard test makes the door the only way in.** Beside `no_ad_hoc_git_spawns` ([F09]), a test fails the build when a git argument list outside the door contains a path-listing flag (`--porcelain`, `--name-only`, `--name-status`, `--numstat`, `ls-files`, `ls-tree`). This is the part that answers "ever again": [B01] fixes today's sites, [B02] fixes the one written next year. It would be revisited only if the scan proves too coarse to tell a listing from a non-listing use of the same flag.

**[B03] `GIT_LITERAL_PATHSPECS=1` is set in `git_command()` itself.** Tug always holds exact paths and never wants git to pattern-match its operands ([F07]). Setting it at the constructor covers every site at once and needs no guard of its own. Precondition: confirm no existing site relies on a glob or magic pathspec; none was seen, but the survey was by flag, not by operand.

**[B04] A tripwire at the commit boundary names Tug's bug as Tug's.** Before committing, every operand must exist on disk or be a known deletion in the status map. One that is neither is refused with a message saying Tug produced a path git does not know, and naming it — not git's pathspec error relayed beside a retry that cannot work ([F05]). After [B01] this should never fire; it exists so that the next encoding-class bug is diagnosable in one read instead of reaching the user as an instruction to fix something that is not broken.

**[B05] A shared hostile-filename fixture, driven through the real verbs.** One helper seeds a repo with `ł`, a decomposable `ó`, an en-dash, a space, a tab, `"`, `\`, a leading `-`, `*`, and a newline. Round-trip tests run `changes` → `commit`, arc `lay`/`commit`/`join`, `file mv`/`rm`, and receipt stats against it, plus one app-test that commits a `ł` file through the actual sheet. The fixture is shared because [F11] is the root cause of the root cause: the defect was invisible to a test corpus that only ever saw ASCII.

**[B06] A non-UTF-8 path is rejected and reported, not lossily renamed.** `String::from_utf8_lossy` turns an invalid byte into U+FFFD, which is a *different, nonexistent* path — the same failure shape as this bug. Paths stay `String` on the wire (the wire is JSON and the UI is text), and the door surfaces an undecodable name as an explicit error. Rare on macOS; an honest refusal beats a silent wrong path. Revisit only if a real project needs such files committed through Tug.

**[B07] eucit is unblocked by hand, today, and that is not the fix.** `git config core.quotepath false` in that one repo lets this commit through, because its unusual names are all non-ASCII ([F04]). It is not shipped, not defaulted, and not written into any repo by Tug: it leaves `"`, `\`, tab and newline broken and would mask the defect in exactly the project that found it.

---

## Open Questions {#open-questions}

- **Unicode normalization.** `ó` is one codepoint (NFC) or two (NFD). Git on macOS precomposes when `core.precomposeunicode` is set, APFS preserves whichever form was written, and the ledger stores whatever the tool input said. If those disagree, the attribution join ([F08]) misses even after `-z`. Whether the door's path type normalizes to NFC on construction — and whether the ledger must too — cannot be decided by reading; measure it with the [B05] fixture first (a file created NFD, listed by git, joined against a ledger row written NFC).

- **`parse_unified_diff` has no `-z` form.** It takes paths from `diff --git a/… b/…` and `+++ b/…` headers, which git quotes the same way. The recommendation is to take the path set from a `-z` listing and use the diff text only for hunks, so that still no unquoter exists. Open because hunk identity ([P06] in `tugchanges-core::hunks`) keys on those headers, and whether it can be re-keyed without moving existing hunk ids was not read.

- **The two tugdeck scrapers ([F10]).** Either they move to typed fields from Rust, or the raw text they receive is produced unquoted. The first is cleaner and larger; which one depends on why they scrape text at all — `commit-block.tsx` parses a transcript's tool output, which Tug does not author, so it may have no typed source to move to.

- **How much of [F06] is production.** The 90-site figure includes test modules. Tests that list paths for assertions could stay on plain git if [B02]'s scan exempts `#[cfg(test)]`, as `no_ad_hoc_git_spawns` may already do; whether it should is a judgment about how much the guard is worth in test code.

---

## Non-goals {#non-goals}

- **An unquoter for git's C-quoting.** Rejected in [B01]. If the unified-diff question forces one, it lives in exactly one place and the guard still forbids line-oriented listings elsewhere.
- **Defaulting `core.quotepath=false`, per-repo or via `-c` in `git_command()`.** Partial by measurement ([F04]); it would make the common case pass and leave the rest as a rarer, harder-to-find version of the same bug.
- **Sanitizing, renaming, or warning about the user's filenames.** `Stanisław` is the correct name of that file. The defect is Tug's and no part of the remedy touches the user's tree.
- **A partial-commit mode** that commits the files it can and reports the rest. It would turn an obvious failure into a quiet one, and [B01] removes the cause.
- **Byte-typed paths end to end.** Considered and set aside in [B06]: the cost lands on every wire type and UI surface to serve a case macOS almost never produces.

---

## Exit {#exit}

**An arc.** The work is mechanical but wide — 22 files — and 32 of the sites are arc operations, where a mistake costs someone's work rather than a render.

The order matters in one respect: the fixture and the failing tests come first, so that every later step turns a red test green rather than being believed.

- Build the [B05] fixture and the round-trip tests; watch them fail on today's code. Settle the normalization question by measurement here.
- Build the [B01] door and its NUL-record parsers; move `tugchanges-core` onto it (`changes.rs`, `commit.rs`) — this is the path that failed in eucit, and the first tests go green.
- Add the [B04] tripwire and the [B06] refusal at the same boundary.
- Move `tugarc-core` (`ops.rs`, `workshop.rs`, `replay.rs`, `resolve.rs`), then the `tugcast` feeds and `tugtool file` verbs.
- Audit for glob-reliant operands, then set [B03] in `git_command()`.
- Land the [B02] guard last, once no site trips it, so it arrives green and stays.
- The unified-diff parser and the tugdeck scrapers, per whatever their open questions resolve to.
- The app-test through the commit sheet, against a rebuilt bundle.
