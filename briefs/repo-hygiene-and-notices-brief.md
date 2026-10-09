<!-- brief-skeleton v1 -->

# Repo hygiene: a `THIRD_PARTY_NOTICES.md` that covers what the app ships, and four stale artefacts gone

**Purpose:** `THIRD_PARTY_NOTICES.md` omits Sparkle and every npm and cargo library the bundle carries, which matters for a shipped `.app`. Beside it sit a six-month-stale `package-lock.json`, a `.gitignore` rule that refuses the lockfiles the repo tracks, and declared Cargo dependencies no crate uses.

---

## Purpose {#purpose}

Items 12 and 13 of `briefs/audit-punch-list.md`:

> 12. Regenerate `THIRD_PARTY_NOTICES.md` from the lockfiles. It lists five libraries Tug does not use and omits Sparkle, which is a real problem for a shipped app.
> 13. Repo hygiene in one pass: delete the stale `package-lock.json`, the dead `Cargo.lock` ignore rule, unused Cargo deps in four crates, and decide between committed fonts and `fetch-fonts`.

Two of the punch list's claims did not survive reading: see [F02] and Non-goals.

---

## Evidence {#evidence}

**[F01] The notices file has two halves by its own preamble** — "copyright notices for third-party code and patterns adopted in this repository, per [L21]" and, at the end, "third-party binaries and libraries shipped inside `Tug.app`". L21 (`tuglaws/tuglaws.md`) requires an entry when code or a substantial pattern is copied, and a source comment pointing at it. **(verified)**

**[F02] The "five unused libraries" are legitimate L21 pattern entries** — Excalidraw, Monaco, Lexical, ProseMirror, and Smoothie Charts are not dependencies, and the file does not claim they are; they are adopted-pattern credits under the first half. The audit's claim that they are stale is wrong and is withdrawn. **(verified)**

**[F03] The shipped-libraries half is incomplete** — it names fzf, WebKit, CodeMirror 6, use-stick-to-bottom, IBM Plex, pdf.js, tmux, libevent, ncurses, utf8proc. It omits Sparkle 2.9.4 (`tugapp/Tug.xcodeproj/…/Package.resolved`, the app's only SwiftPM dependency, MIT), the npm runtime tree in `tugdeck/package.json` (React, Radix, xterm, KaTeX, marked, mermaid, DOMPurify, lucide, sonner, react-resizable-panels, and the rest), and the cargo tree behind tugcast and tugtool (tokio, axum, rusqlite, and about 360 crates in `Cargo.lock`). No script generates or checks any of it; there is no `cargo about`, `cargo deny`, or license-checker installed. **(verified)**

**[F04] Two JS lockfiles in `tugdeck/`** — `bun.lock` (updated 2026-10-07) and `package-lock.json` (last commit `bc379d563`, 2026-03-31). CI installs with `bun install --frozen-lockfile`; nothing reads the npm one. **(verified)**

**[F05] `.gitignore` line 5 is `Cargo.lock`** while `tugrust/Cargo.lock` and `tugdeck/crates/Cargo.lock` are tracked. A tracked file is exempt, so the rule's only effect is to refuse a new crate's lockfile at `git add` and to mislead the next reader. **(verified with `git check-ignore -v`)**

**[F06] Declared Cargo dependencies with zero references** — by grep for `<crate>::` and `use <crate>` in each crate's `src/`: `tugtool` declares `thiserror`, `anyhow`, `regex`, `uuid`; `tugtool-core` declares `dirs`, `uuid`; `tugarc-core` declares `dirs`, `tuggram`; `tugcast` declares `toml`, `percent-encoding`. Rust does not warn on an unused crate dependency, so nothing catches these. `cargo udeps` and `cargo machete` are not installed; removal plus `cargo build` is the confirmation. **(verified by grep; not yet confirmed by build)**

**[F07] Fonts are committed on purpose** — `tugdeck/scripts/fetch-fonts.ts`'s header says "vendors them under `tugdeck/public/fonts/`. Everything is committed"; 931 tracked files, 21 MB. `fetch-fonts` is the refresh tool, not an alternative. The punch list's "decide between" is already decided. **(verified)**

**[F08] The wasm `pkg/` directories are committed on purpose** — `tuglaws/wasm-crates.md` says why, and normalises `pkg/.gitignore` so they can be. Not a hygiene item. **(verified)**

---

## Decisions {#decisions}

**[B01] The shipped-libraries half of `THIRD_PARTY_NOTICES.md` is generated from the three lockfiles plus `Package.resolved`, by a script, and a lint compares the generated section to the committed file.** Hand-maintained lists of 400 names drift by construction; a generator makes the file a build product and the lint makes drift a red `just lint`. The script reads `tugrust/Cargo.lock` with `cargo metadata` for license fields, `tugdeck/bun.lock` and `tugcode/bun.lock` with each package's `package.json` `license`, and `Package.resolved` with a small hand table for the one SwiftPM entry. Output is one line per package (name, version, license, repository) grouped by tree, under a heading that says it is generated. Full license texts are included for the licenses that require reproduction (MIT, BSD, Apache-2.0 notice, ISC), once each, not per package.

**[B02] The L21 pattern half stays hand-written and untouched.** [F02]. The generator writes only below a marker line, so the two halves cannot collide.

**[B03] The lint also refuses any license outside the permissive set L21 names.** This is the standing "no GPL in Tug" rule as a check rather than a memory; `cargo metadata` and `package.json` carry the field, and the allow-list is `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Unicode-DFS-2016`, `MPL-2.0` for the one or two crates that use it, `Zlib`, and `0BSD`, each reviewed once when the list is written.

**[B04] `package-lock.json` is deleted and the `Cargo.lock` rule leaves `.gitignore`.** Nothing reads the first ([F04]); the second only refuses correct adds ([F05]).

**[B05] The ten unused declared dependencies are removed and the workspace built; any that turn out to be needed by a feature or a macro go back with a comment saying by what.** Grep is a strong hint, not a proof ([F06]); `cargo build --all-targets` is the proof, and it is the one in CI.

**[B06] Fonts and wasm `pkg/` are not touched.** [F07], [F08].

---

## Open Questions {#open-questions}

- Whether the generated section should land in `THIRD_PARTY_NOTICES.md` at the repo root or in a second file the first links to. The root file is what L21 names and what the bundle's about panel would reference; one file is the default unless the generated section makes it unreadable, which the arc will see when it runs the generator.

---

## Non-goals {#non-goals}

- **Pruning the committed fonts or moving to fetch-on-build.** Decided the other way already ([F07]); the standalone contract wants the bundle self-contained.
- **Removing the wasm `pkg/` directories from git.** [F08].
- **Installing `cargo deny` or `cargo about` as a required tool.** A script over `cargo metadata` and `package.json` needs nothing the checkout does not already have, and the standalone contract frowns on new host prerequisites.
- **Auditing transitive license *compatibility*.** The check is "every license is permissive", which is L21's rule; a full compatibility matrix is a different project.

---

## Exit {#exit}

An arc. First the generator script and lint under `scripts/`, wired into `just lint`, with the regenerated notices committed; then the lockfile and `.gitignore` deletions; then the dependency removals with a workspace build and `cargo nextest run --workspace` as the verdict.
