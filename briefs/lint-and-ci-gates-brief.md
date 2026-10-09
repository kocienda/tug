<!-- brief-skeleton v1 -->

# Wire the gates that already exist: a real TypeScript lint, typechecks in `just lint`, and a CI that runs more than Rust

**Purpose:** The checkout has a linter, three typecheckers, four bun test suites, a plugin lint, a standalone test, and a covers check. The linter is configured to catch almost nothing, `just lint` never typechecks, and CI runs only the Rust jobs with a compiler the toolchain file does not pin. Drift the gates would catch lands on `main` unseen.

---

## Purpose {#purpose}

Items 4, 5, and 6 of `briefs/audit-punch-list.md`:

> 4. Turn the linter on. Enable the `react-hooks` and `typescript` categories in `.oxlintrc.json`, then triage the 60 `exhaustive-deps` suppressions into refs.
> 5. Add `bun run check` for tugdeck, tugcode, and `tests/app-test` to `just lint`, and give the latter two a lint script at all.
> 6. Add a bun job to CI running `just lint test-ts test-standalone app-test-covers-check`, and let `rust-toolchain.toml` win over the action's `stable`.

The audit's theme: "gates that exist but are not wired". The code is stable; this work changes only what is checked.

---

## Evidence {#evidence}

**[F01] The TypeScript linter enforces two rules** — `tugdeck/.oxlintrc.json` sets `"categories": { "correctness": "off" }` and enables only `no-unused-expressions` and `no-unreachable`. oxlint `1.87.0` ships the `correctness`, `suspicious`, `pedantic`, `perf`, `style`, `restriction`, and `nursery` categories and the `react`, `typescript`, `unicorn`, `import`, `jsx-a11y`, `promise` and other plugins. **(verified)**

**[F02] 107 `eslint-disable` comments enforce nothing** — there is no ESLint config anywhere in the checkout; the comments are vestigial from an earlier linter. 56 are `react-hooks/exhaustive-deps`, 23 `no-console`, 9 `no-explicit-any`, 6 `no-non-null-assertion`. oxlint honours `eslint-disable-next-line` syntax, so once the matching rules are on these become live suppressions rather than comments. **(verified by grep)**

**[F03] What turning the linter on surfaces today** — measured with `bunx oxlint src` in `tugdeck/`:

| Enabled | Findings |
|---|---|
| `-D correctness` | 283, of which 226 outside tests |
| `react/exhaustive-deps` + `react/rules-of-hooks` | 71 |
| `react/rules-of-hooks` alone | 3 |

The correctness breakdown is 142 `no-unused-vars`, 89 `unicorn/no-useless-spread`, 30 `unicorn/no-new-array`, 12 `unicorn/no-useless-fallback-in-spread`, 3 `no-this-alias`, 3 `no-useless-escape`, 2 `no-unsafe-optional-chaining`, 1 `no-thenable`, 1 `no-eval`. **(verified)**

**[F04] The three `rules-of-hooks` findings are real** — `tugdeck/src/components/arcs/arcs-card.tsx` at the arc row cell: `if (row === undefined) return null;` precedes `useWorkerCard`, `useArcRowVerbs`, and `useChangesetJoinLand`. A hook after an early return changes hook order when the condition flips. The list view probably never hands a cell an undefined row, which is why it has not bitten, but it is the one class of lint finding that is a latent runtime defect rather than style. **(verified by reading)**

**[F05] `just lint` never typechecks** — the recipe runs `tugplug-lint`, five tugdeck audits, `bun run lint`, clippy, and `cargo fmt --check`. `tugdeck`'s `check` script (`bunx tsc --noEmit`) is not in it. `tugcode/package.json` has only a `test` script; `tests/app-test/package.json` has an empty `scripts` object. All three typecheck green today: tugdeck under `strict`, tugcode and `tests/app-test` with `tsc --noEmit -p tsconfig.json` exit 0. **(verified by running them)**

**[F06] CI runs Rust only** — `.github/workflows/ci.yml` has three jobs: build plus `cargo nextest`, `cargo fmt --check`, `cargo clippy`. Bun is installed in two of them only so the Rust build can find tugdeck's `node_modules`. Not run anywhere automatically: `test-ts` (tugdeck, tugdeck scripts, tugcode, app-test logic), `test-standalone`, `tugplug-lint`, `app-test-covers-check`, the five tugdeck audits, `bun run lint`. The `just ci` recipe (`lint test`) exists and nothing invokes it. **(verified)**

**[F07] CI's compiler is not the pinned one** — all three jobs use `dtolnay/rust-toolchain@stable`, which installs current stable and overrides `tugrust/rust-toolchain.toml`'s `1.93.0`. Local builds and CI compile with different compilers; a clippy lint added in a newer stable fails CI with no local reproduction, and the reverse. **(verified)**

**[F08] `tests/app-test` pins TypeScript 6 while the other two pin 5.9** — `tests/app-test/package.json` has `typescript ^6.0.3`; tugdeck `^5.9.3`; tugcode `5.9.3`. The harness typechecks on a different major from the code it drives. **(verified)**

---

## Decisions {#decisions}

**[B01] Turn on `correctness` and the React hooks rules, and fix what they find rather than suppressing it.** 283 findings sounds large, but the breakdown ([F03]) is dominated by three mechanical shapes (`no-unused-vars`, `no-useless-spread`, `no-new-array`) that a pass of edits clears without behaviour change. The react-hooks rules are the payload: 71 findings that the old `eslint-disable` comments were pretending to cover. `suspicious` and `pedantic` stay off; they are style, and the audit found the code's style consistent.

**[B02] The 56 `exhaustive-deps` suppressions are triaged, not carried.** Each is one of three things: a dependency that should be listed (add it), a value that should be a ref per L07 (make it one), or a deliberate once-only effect (keep the suppression, with a one-line reason comment that oxlint's `-- reason` syntax carries). The remaining 51 `eslint-disable` comments for rules that are not enabled (`no-console`, `no-explicit-any`, `no-non-null-assertion`) are deleted so a disable comment always names a live rule.

**[B03] The three `rules-of-hooks` findings are fixed by moving the early return below the hooks, with the hooks given a no-op argument when the row is undefined.** It is the one latent defect in the set ([F04]) and it lands as its own commit so the fix is findable.

**[B04] `just lint` typechecks all three TypeScript packages.** `tugdeck` gets `bun run check` added to the recipe; `tugcode` and `tests/app-test` each gain `check` and `lint` scripts that mirror tugdeck's, sharing one `.oxlintrc.json` by path so the rule set cannot fork. `tests/app-test` moves to TypeScript 5.9 to match ([F08]); if its tests need a TS 6 feature, that is the moment to move all three together, not one.

**[B05] CI gains one bun job that runs the recipes the checkout already defines, and the Rust jobs use the pinned toolchain.** The job is `just lint`, `just test-ts`, `just test-standalone`, `just app-test-covers-check` on `ubuntu-latest`. `test-standalone` builds `tugtool` with cargo, so the job installs Rust the same way the build job does. The three Rust jobs switch to `dtolnay/rust-toolchain@master` with no channel argument, so `rust-toolchain.toml` decides ([F07]). The app-test corpus stays out of CI; it needs a macOS host with a built `Tug.app` and is gated locally.

**[B06] Order of landing: typecheck and CI wiring first, then the linter.** The CI job and `just lint` changes are additive and go green immediately ([F05]). The linter change is the one that needs the 283 edits, and it should land with CI already watching so the edits are checked by the gate they enable.

---

## Open Questions {#open-questions}

- None that block. Whether `unicorn/no-useless-spread` and `no-new-array` are wanted at all is a taste call the arc can make at the first batch: either fix the 119 sites or turn those two rules off with a reason in the config. Fixing is the default.

---

## Non-goals {#non-goals}

- **Running app-tests in CI.** They need a macOS runner, a signed debug `Tug.app`, and a display; the machine-wide gate and the wedge cap exist because they are expensive even locally.
- **Enabling `suspicious`, `pedantic`, `style`, or `restriction`.** Not correctness, and the audit did not find the code's style inconsistent enough to earn a style linter.
- **Replacing oxlint with ESLint.** oxlint is already installed, fast, and honours the existing disable syntax; the problem is configuration, not the tool.
- **A `shellcheck` step.** Worth doing, but the audit's Justfile findings are their own item (the 1,102-line `app-test` recipe) and belong with it.

---

## Exit {#exit}

An arc. First `just lint` gains the three typechecks and the two packages gain scripts ([B04]), and CI gains the bun job and the toolchain fix ([B05]); both go green on the current tree. Then the hooks-rule fix in `arcs-card.tsx` as its own commit ([B03]). Then `.oxlintrc.json` turns on `correctness` and the React hooks rules, and the findings are cleared in batches by rule ([B01], [B02]), with `bun test` in tugdeck green after each batch and the `@covers`-derived app-test selection run once after the last.
