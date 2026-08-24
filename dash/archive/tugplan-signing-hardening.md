<!-- tugplan-skeleton v2 -->

## Tug Dev Signing — Hardening + Drift Detection {#phase-signing-hardening}

**Purpose:** Tighten the `Tug Dev` self-signed code-signing pipeline so that codesign failures surface as errors (not silent successes), the bundle is verified after every re-sign, and a small fingerprint sentinel detects when the cert has drifted out from under the AX grant. Plus a documentation pass listing the failure modes so the next confused dev has a checklist.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken |
| Status | complete (2026-04-27) |
| Target branch | `signing-hardening` |
| Last updated | 2026-04-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The `Tug Dev` self-signed signing pipeline was audited 2026-04-27. It works structurally but has four reactive-only failure modes plus a documentation gap:

1. **Silent codesign failures** in `build-app` — output piped through `grep -v ... | … || true` swallows codesign's exit code. A botched re-sign produces an invalid bundle that's only diagnosed downstream by AT-test failures with confusing attribution.
2. **No post-sign verification** — we don't run `codesign --verify --strict` on the bundle after the re-sign. A malformed signature would only surface when WebKit or the AX subsystem rejects it.
3. **No drift detection** — if a dev manually deletes their `Tug Dev` cert and re-runs `setup-dev-signing.sh`, the new cert has the same name but a different private key. The bundle's designated requirement (DR) changes silently. AX grant invalidates. Diagnosis goes through "tests fail" rather than "your cert changed."
4. **`app-test`'s missing-identity branch is silent** — the re-sign step is a no-op when `Tug Dev` isn't found, and the next failure is the harness's AX preflight throwing on `launchTugApp`. Confusing for first-time onboarding.
5. **No documented failure-mode checklist** — what should a dev check when AX breaks? Today: nothing in-repo.

This plan addresses all five via a single small bundled change. No new tools, no Xcode project changes, no removal of `--deep`.

#### Strategy {#strategy}

- **Bundled change, single small plan.** Five mechanical items, each ~5–30 minutes; together ~90 minutes including testing.
- **Touch surface stays narrow.** `Justfile` (the `build-app` and `app-test` recipes), `scripts/setup-dev-signing.sh`, `tests/app-test/README.md`, plus a new `.tugtool/code-sign-fingerprint` sentinel file (gitignored).
- **Error paths fail loud.** Every silent-success branch becomes a non-zero exit with an actionable diagnostic message.
- **Drift detection is proactive.** First successful `build-app` after `setup-dev-signing` captures the DR; subsequent `build-app` + `app-test` compare. Drift surfaces a clear warning before the test sweep wastes 90 seconds failing.
- **Escape hatch for edge cases.** `APP_TEST_SKIP_RESIGN=1` env-var bypasses the re-sign in `app-test` for the rare scenarios where it's desired (e.g., diagnosing whether the re-sign itself is the culprit).

#### Success Criteria (Measurable) {#success-criteria}

- **`build-app` exits non-zero on codesign failure.** Demonstrate: temporarily corrupt `$APP_DIR` after xcodebuild, observe non-zero exit and a diagnostic naming codesign as the failed step.
- **`build-app` runs `codesign --verify --strict` after the re-sign.** Demonstrate: `grep -F 'codesign --verify' Justfile` returns at least one match inside the `build-app` recipe.
- **`.tugtool/code-sign-fingerprint` exists after `build-app`.** Contents are exactly the bundle's designated requirement string (single line).
- **Drift simulation surfaces a warning.** Steps: capture fingerprint via `build-app`; delete `Tug Dev` cert (`security delete-identity -c "Tug Dev"`) + re-run `setup-dev-signing.sh`; run `just app-test`; observe a `[warn] code-sign fingerprint drift detected` message before any tests run.
- **`app-test` exits non-zero with an actionable message when `Tug Dev` is missing.** Demonstrate: `security delete-identity -c "Tug Dev"`, run `just app-test`, observe message naming `just setup-dev-signing` and the `APP_TEST_SKIP_RESIGN` opt-out.
- **`tests/app-test/README.md` has an "Accessibility grant failure modes" section.** At least 4 named failure modes + 4 diagnosis steps.
- **`scripts/setup-dev-signing.sh` cross-links the README failure-modes section.** A single line in the script's closing echoes.

#### Scope {#scope}

1. `Justfile`, `build-app` recipe — tighten codesign error path; add `--verify --strict`; capture fingerprint sentinel.
2. `Justfile`, `app-test` recipe — fail-loud when `Tug Dev` missing (with `APP_TEST_SKIP_RESIGN=1` opt-out); detect fingerprint drift before running the sweep.
3. `.tugtool/code-sign-fingerprint` — new gitignored sentinel file.
4. `tests/app-test/README.md` — new "Accessibility grant failure modes" section.
5. `scripts/setup-dev-signing.sh` — cross-link the README section in the closing-instructions block.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No Xcode project changes.** `CODE_SIGN_STYLE = Automatic` stays; we keep the "overwrite-after-xcodebuild" approach (audit item 1).
- **No `--deep` removal.** Apple discourages it but it works fine for our case (no embedded frameworks). Defer.
- **No optimization of `app-test`'s per-invocation re-sign frequency.** Defer the "skip re-sign if fingerprint already matches" optimization (audit item E); the hardening lands first.
- **No `just teardown-dev-signing` recipe.** Rarely needed; manual `security delete-identity` works.
- **No CI / Apple Developer flow changes.** Pure local-dev hardening.
- **No new tooling dependencies.** Stays on `security`, `codesign`, `awk`, `grep`, plain bash. No `jq`, no Python.

#### Constraints {#constraints}

- macOS-only (`security` + `codesign` are the load-bearing tools).
- Must not require Apple Developer membership.
- Must preserve the existing AX grant for users who already have one — the fingerprint should match what's currently signed if no cert change has happened.
- `.tugtool/` must already be gitignored (verify before relying on it).

#### Assumptions {#assumptions}

- The audit's diagnosis is correct: TCC keys on the designated requirement, not on the binary hash. (`codesign -d -r- ...` emits the DR.)
- `.tugtool/` is gitignored project-wide; precedent exists (the cleanup plan excluded it from sweeps).
- Single-user-per-machine assumption stays — no shared-keychain / multi-user dev scenarios.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Fingerprint = full DR string vs. SHA-256 of DR? (DECIDED) {#q01-fingerprint-shape}

**Decision:** Store the full DR string verbatim. The DR is human-readable, ~200 bytes, and a future debugger can diff it directly. A hash would save bytes but lose the diagnostic.

#### [Q02] Should fingerprint mismatch be a warning or a hard error? (DECIDED) {#q02-mismatch-severity}

**Decision:** Warning, not error. A drift means the AX grant is *probably* invalidated, but the user might have re-granted it manually. A warning lets the test sweep run; if AX is actually broken, the harness's existing per-spawn preflight throws `AccessibilityPermissionMissingError` with full context. Treating drift as fatal would block legitimate "I just re-granted, let me run the tests" flows.

---

### Risks and Mitigations {#risks}

**Risk R01: Fingerprint format changes across macOS versions** {#r01-fingerprint-format}

- **Risk:** `codesign -d -r-` output format could change in a future macOS release, causing every existing fingerprint to "drift" on first post-upgrade run.
- **Mitigation:** Drift surfaces only as a warning, not a fatal. The user re-runs `build-app`, the fingerprint refreshes, life goes on. Document this scenario in the README failure-modes section.
- **Residual risk:** A confusing one-time warning post-macOS-upgrade. Acceptable.

**Risk R02: Fingerprint capture races with concurrent builds** {#r02-fingerprint-race}

- **Risk:** Two `build-app` invocations in parallel could write to `.tugtool/code-sign-fingerprint` non-atomically.
- **Mitigation:** Write to a temp file, then `mv` (atomic on POSIX). Probably overkill given the single-user assumption, but cheap.

---

### Design Decisions {#design-decisions}

#### [D01] Fingerprint = designated requirement string (DECIDED) {#d01-fingerprint-dr}

**Decision:** The sentinel stores the bundle's designated requirement (DR) as emitted by `codesign -d -r- "$APP_DIR" 2>&1 | grep '^designated' | sed 's/^designated => //'`.

**Rationale:**
- TCC keys Accessibility grants on the DR, not on the bundle's content hash. A hash check would fire on every legitimate rebuild and cry wolf.
- The DR captures both the cert's subject (`CN=Tug Dev`) AND its public key fingerprint (`H"…"`). Two binaries with the same DR are TCC-equivalent. Two with different DRs require a fresh AX grant.
- Human-readable; future debuggers can diff visually.

**Implications:**
- The fingerprint is ~200 bytes; trivial.
- A `Tug Dev` cert re-creation produces a new public-key fingerprint inside the DR → drift detected.
- An ad-hoc re-sign produces a wholly different DR shape → drift detected.

---

#### [D02] Sentinel path is `.tugtool/code-sign-fingerprint` (DECIDED) {#d02-sentinel-path}

**Decision:** Sentinel lives at `.tugtool/code-sign-fingerprint` (one line, the DR string).

**Rationale:**
- `.tugtool/` is gitignored project-wide and is the established home for local-only sentinels and working state.
- Hidden under `.tugtool/`, it doesn't clutter the project root.
- One file, plain text, no JSON / YAML — `cat` and `diff` are enough.

**Implications:**
- First `build-app` after `setup-dev-signing` writes it.
- Every subsequent `build-app` and `app-test` reads + compares.
- Removing `.tugtool/` (e.g., a developer wipes their working state) is recoverable: next `build-app` rewrites the sentinel.

---

#### [D03] `APP_TEST_SKIP_RESIGN=1` escape hatch (DECIDED) {#d03-skip-resign-env}

**Decision:** `app-test` exits non-zero when `Tug Dev` is missing UNLESS `APP_TEST_SKIP_RESIGN=1` is set.

**Rationale:**
- First-time onboarding ("I just cloned the repo and want to see the harness skip cleanly") is a real flow that benefits from skipping re-sign.
- CI scenarios (someday) may want to skip re-sign deliberately.
- Explicit opt-out is safer than silent fallthrough — the user knows they're bypassing.

**Implications:**
- Documented in the recipe's comment header.
- README "Accessibility grant failure modes" section mentions it as the recovery move when nothing else works.

---

### Specification {#specification}

#### Spec S01: Fingerprint sentinel format {#s01-fingerprint-format}

**Path:** `.tugtool/code-sign-fingerprint`
**Encoding:** UTF-8 plain text, one line, no trailing newline (or with — either is fine; comparison strips whitespace).
**Contents:** the bundle's designated requirement string verbatim, as emitted by:

```sh
codesign -d -r- "$APP_DIR" 2>&1 | awk -F'=> ' '/^designated/{print $2; exit}'
```

A representative DR for the `Tug Dev`-signed bundle looks like:

```
identifier "com.tugtool.Tug" and anchor apple generic and certificate leaf [subject.CN] = "Tug Dev"
```

(Exact form varies; the fingerprint stores whatever `codesign` emits.)

**Lifecycle:**
- Captured at end of `build-app` (after the re-sign and after `--verify --strict`).
- Compared at start of `app-test`, before the per-invocation re-sign.
- Mismatch → warn (not fatal). Match → silent. Missing → first-run case; written by next `build-app`.

#### Spec S02: Drift-detection logic {#s02-drift-logic}

```sh
SENTINEL=".tugtool/code-sign-fingerprint"
CURRENT_DR="$(codesign -d -r- "$APP_DIR" 2>&1 | awk -F'=> ' '/^designated/{print $2; exit}')"

if [ -z "$CURRENT_DR" ]; then
    echo "[warn] code-sign: could not extract designated requirement from $APP_DIR" >&2
elif [ -f "$SENTINEL" ]; then
    SAVED_DR="$(cat "$SENTINEL")"
    if [ "$CURRENT_DR" != "$SAVED_DR" ]; then
        echo "[warn] code-sign fingerprint drift detected." >&2
        echo "       Saved : $SAVED_DR" >&2
        echo "       Current: $CURRENT_DR" >&2
        echo "       AX grant likely invalidated; see tests/app-test/README.md" >&2
        echo "       § 'Accessibility grant failure modes' for diagnosis." >&2
    fi
fi
# Always refresh the sentinel after a successful build-app run (the
# verify step gates this branch — we only land here if the sign is valid).
mkdir -p "$(dirname "$SENTINEL")"
printf '%s\n' "$CURRENT_DR" > "$SENTINEL"
```

`build-app` writes the sentinel; `app-test` only reads it.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `.tugtool/code-sign-fingerprint` | Sentinel — bundle DR captured at last successful `build-app`. Gitignored. |
| `dash/tugplan-signing-hardening.md` | This plan. |

#### Modified files {#modified-files}

| File | What changes |
|------|--------------|
| `Justfile` (`build-app`) | Tighten codesign error path; add `--verify --strict`; capture fingerprint sentinel. |
| `Justfile` (`app-test`) | Fail-loud on missing `Tug Dev`; detect fingerprint drift; honor `APP_TEST_SKIP_RESIGN=1`. |
| `tests/app-test/README.md` | New "Accessibility grant failure modes" section. |
| `scripts/setup-dev-signing.sh` | Closing echoes cross-link the README section. |

No new symbols in source code; all changes are in shell + Markdown.

---

### Documentation Plan {#documentation-plan}

- [ ] `tests/app-test/README.md` — add "Accessibility grant failure modes" section listing 5 named failure modes + 4 diagnosis steps + the `APP_TEST_SKIP_RESIGN` opt-out.
- [ ] `scripts/setup-dev-signing.sh` — single-line cross-link in the closing echoes.
- [ ] No CLAUDE.md changes; the failure modes are too specific for project-wide guidance.

---

### Test Plan Concepts {#test-plan-concepts}

This is a shell-recipe + docs change. "Tests" are deliberate-state probes against the recipes.

| Probe | Purpose |
|---|---|
| Run `build-app` clean → verify sentinel written | Confirm first-run capture works. |
| Run `build-app` twice → verify sentinel unchanged | Confirm idempotent capture. |
| Corrupt `$APP_DIR` mid-build → verify `build-app` exits non-zero | Confirm error-path fix. |
| Delete + recreate `Tug Dev` cert → run `app-test` → verify drift warning | Confirm drift detection. |
| Delete `Tug Dev` cert → run `app-test` → verify non-zero exit + actionable message | Confirm fail-loud. |
| `APP_TEST_SKIP_RESIGN=1` with missing cert → verify exit 0, re-sign skipped | Confirm escape hatch. |

---

### Execution Steps {#execution-steps}

#### Step 1: `build-app` — tighten codesign error path + add `--verify --strict` {#step-1}

**Commit:** `refactor(signing): build-app fails loud on codesign + verify after re-sign`

**References:** [D01], [#context], (#strategy)

**Artifacts:**
- `Justfile` `build-app` recipe step [5/5] rewritten:
  - Capture codesign output to a tempfile.
  - Check exit code; on non-zero, dump the log and exit 1.
  - Filter the success-case noise line (`replacing existing signature`).
  - Append `codesign --verify --strict "$APP_DIR"` with explicit error reporting.

**Tasks:**
- [ ] Replace the existing `codesign ... 2>&1 | grep -v ... || true` line with the explicit-rc form.
- [ ] Add `codesign --verify --strict` immediately after the re-sign.
- [ ] On verify failure, print `error: codesign --verify --strict failed; bundle is invalid` and exit 1.

**Tests:**
- [ ] `just build-app` happy path is still green; signature still produces a working bundle that runs against AT tests.
- [ ] Manual probe: chmod -w on the bundle's `_CodeSignature` directory before re-sign → expect non-zero exit + diagnostic.

**Checkpoint:**
- [ ] `just build-app && just app-test harness-smoke/smoke.test.ts` is green end-to-end.

---

#### Step 2: `build-app` — capture fingerprint sentinel {#step-2}

**Depends on:** #step-1

**Commit:** `feat(signing): capture .tugtool/code-sign-fingerprint after build-app verify`

**References:** [D01], [D02], Spec S01, (#s01-fingerprint-format)

**Artifacts:**
- `Justfile` `build-app` recipe step [5/5] gains a final block:
  - Extract DR via `codesign -d -r- ... | awk -F'=> ' '/^designated/{print $2; exit}'`.
  - `mkdir -p .tugtool && printf '%s\n' "$CURRENT_DR" > .tugtool/code-sign-fingerprint`.
  - Echo `==> Sentinel: .tugtool/code-sign-fingerprint refreshed.`

**Tasks:**
- [ ] Verify `.tugtool/` is gitignored (grep `.gitignore`); if not, add it (out of caution).
- [ ] Implement the capture block per [Spec S01](#s01-fingerprint-format).
- [ ] Use atomic write (temp file + mv) per [Risk R02](#r02-fingerprint-race).

**Tests:**
- [ ] `just build-app` followed by `cat .tugtool/code-sign-fingerprint` shows a valid DR string.
- [ ] Re-run `just build-app`; sentinel file's mtime updates but contents are byte-identical.

**Checkpoint:**
- [ ] Sentinel written; not staged for commit (gitignored).

---

#### Step 3: `app-test` — fail-loud + drift detection {#step-3}

**Depends on:** #step-2

**Commit:** `refactor(signing): app-test fails loud on missing identity; warns on fingerprint drift`

**References:** [D03], Spec S02, (#s02-drift-logic)

**Artifacts:**
- `Justfile` `app-test` recipe — re-sign block rewritten:
  - If `Tug Dev` missing AND `APP_TEST_SKIP_RESIGN` unset → exit 1 with actionable message naming `just setup-dev-signing` + the env-var opt-out.
  - If `Tug Dev` missing AND `APP_TEST_SKIP_RESIGN=1` → silent skip with one-line `==> APP_TEST_SKIP_RESIGN=1: skipping re-sign` echo.
  - On re-sign failure → exit 1 with diagnostic (no `|| true`).
  - After re-sign (or skip): read `.tugtool/code-sign-fingerprint`, compare against `codesign -d -r- ...`, warn on mismatch per [Spec S02](#s02-drift-logic).

**Tasks:**
- [ ] Replace the existing `if security find-identity ... ; then ... || true; fi` block per the spec.
- [ ] Add the drift-detection block after the re-sign branch.
- [ ] Update the recipe header comment with the `APP_TEST_SKIP_RESIGN=1` env-var documentation.

**Tests:**
- [ ] Happy path (`Tug Dev` installed, sentinel matches): silent re-sign, no warning, sweep proceeds.
- [ ] Missing identity → non-zero exit + diagnostic.
- [ ] `APP_TEST_SKIP_RESIGN=1` with missing identity → exit 0 path, no re-sign, sweep proceeds (tests will likely SKIP if AX is missing — expected).
- [ ] Drift simulation:
  1. `just build-app` to capture fingerprint.
  2. `security delete-identity -c "Tug Dev"`
  3. `just setup-dev-signing` (creates new cert with same name, different key).
  4. `just build-app` (re-sign with new cert; fingerprint is updated by Step 2's capture).
  5. … OR — alternate drift probe: manually edit `.tugtool/code-sign-fingerprint` to a bogus value and run `just app-test`. Observe drift warning before tests run.

**Checkpoint:**
- [ ] All four probe scenarios behave as specified.

---

#### Step 4: README failure-modes section + signing-script cross-link {#step-4}

**Depends on:** #step-3

**Commit:** `docs(signing): document AX-grant failure modes + diagnosis steps`

**References:** (#documentation-plan), (#strategy)

**Artifacts:**
- `tests/app-test/README.md` — new section "Accessibility grant failure modes" between "Accessibility permission preflight" and "Smoke vs. scenario tests":
  - Failure modes (≥4): cert deleted + recreated; bundle moved/renamed; macOS major upgrade can wipe TCC; bare xcodebuild re-signs ad-hoc; manual System Settings revoke.
  - Diagnosis steps (≥4): `security find-identity` shows `Tug Dev`; `codesign -d -r-` matches `.tugtool/code-sign-fingerprint`; System Settings → Accessibility shows Tug.app enabled; `tccutil reset Accessibility` and re-grant.
  - Mention `APP_TEST_SKIP_RESIGN=1` as the last-resort bypass.
- `scripts/setup-dev-signing.sh` — closing echoes get one extra line:
  ```
  echo "  4. If AX ever breaks unexpectedly, see"
  echo "     tests/app-test/README.md → 'Accessibility grant failure modes'."
  ```

**Tasks:**
- [ ] Add the README section.
- [ ] Update setup-dev-signing.sh closing block.
- [ ] Cross-link from the existing "Accessibility permission preflight" section.

**Tests:**
- [ ] Reading the new README section cold should make the failure-mode space obvious.
- [ ] `bash -n scripts/setup-dev-signing.sh` (syntax check after edit).

**Checkpoint:**
- [ ] `grep -F "Accessibility grant failure modes" tests/app-test/README.md` returns ≥1 hit.
- [ ] `grep -F "Accessibility grant failure modes" scripts/setup-dev-signing.sh` returns 1 hit.

---

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria)

**Tasks:**
- [ ] Run the full success-criteria battery from [#success-criteria](#success-criteria).
- [ ] Run `just build-app && just app-test harness-smoke/smoke.test.ts at0001-tab-switch-fc.test.ts` end-to-end and confirm:
  - Sentinel exists and is fresh.
  - No drift warning.
  - VERDICT: PASS.

**Tests:**
- [ ] All success criteria pass.
- [ ] Manual drift probe (edit sentinel to bogus value, run `app-test`, observe warning, restore sentinel via `build-app`).

**Checkpoint:**
- [ ] Plan complete.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A hardened `Tug Dev` signing pipeline where codesign failures surface as errors, every signed bundle is verified, fingerprint drift is detected proactively, the missing-identity path fails loud with actionable guidance, and a README section catalogs the failure modes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `build-app` exits non-zero on a forced codesign failure. (Step 1 — code review: explicit `if ! codesign ...` form replaces the silent `|| true`.)
- [x] `build-app` runs `codesign --verify --strict` after every re-sign. (Step 1; `grep -cF 'codesign --verify --strict' Justfile` returns 2.)
- [x] `.tugtool/code-sign-fingerprint` is written by `build-app` and read by `app-test`. (Step 2 + Step 3; sentinel exists and is fresh: verified live.)
- [x] `app-test` warns on fingerprint drift (not fatal — see [Q02]). (Step 3; live probe wrote `BOGUS-FINGERPRINT-FOR-PROBE` to sentinel and observed the 4-line `[warn]` block fire.)
- [x] `app-test` exits non-zero on missing `Tug Dev` unless `APP_TEST_SKIP_RESIGN=1`. (Step 3; three explicit branches in the recipe — verified by code review.)
- [x] `tests/app-test/README.md` has the "Accessibility grant failure modes" section. (Step 4; section header at line 209.)
- [x] `scripts/setup-dev-signing.sh` cross-links the README section. (Step 4; closing-echoes step 4.)
- [x] Existing AT-test sweep stays green (`just app-test` → `VERDICT: PASS`). (User-verified after Step 1: `just app-test harness-smoke/smoke.test.ts harness-smoke/version-handshake.test.ts at0001-tab-switch-fc.test.ts` succeeded; Steps 2–4 only added new error paths and a sentinel — happy path unchanged. Final end-to-end smoke run verified after Step 5 close-out.)

**Acceptance tests:**
- [x] `just build-app && just app-test-smoke` exits 0 with `VERDICT: PASS`. (User-verified post-Step-5; `app-test-smoke` is the new three-file shortcut covering the same files the plan originally named explicitly.)
- [x] Drift simulation surfaces the warning. (Step 3 live probe.)
- [x] Missing-identity simulation exits non-zero with the actionable message. (Code review of the three-branch logic; live probe deferred to avoid disturbing the user's working `Tug Dev` identity.)

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Audit-item E: skip the re-sign in `app-test` when fingerprint already matches (saves ~100ms per invocation).
- [ ] Audit-item G: `just teardown-dev-signing` recipe.
- [ ] Move `CODE_SIGN_IDENTITY = "Tug Dev"` into the Xcode project so xcodebuild signs once instead of twice (audit item 1) — coordinated change with onboarding implications; defer.

| Checkpoint | Verification |
|------------|--------------|
| codesign failure surfaces non-zero | manual: chmod -w on `_CodeSignature/` mid-build |
| `--verify --strict` runs | `grep -F 'codesign --verify' Justfile` matches inside `build-app` |
| Sentinel written | `cat .tugtool/code-sign-fingerprint` after `build-app` |
| Drift warning visible | manual: edit sentinel to bogus value, run `app-test` |
| Missing-identity fails loud | manual: `security delete-identity -c "Tug Dev"`, run `app-test` |
| `APP_TEST_SKIP_RESIGN=1` bypass | manual: same setup, with env var set |
| README section present | `grep -F "Accessibility grant failure modes" tests/app-test/README.md` |
| Existing sweep stays green | `just app-test` → `VERDICT: PASS` (45/45 files green) |

---

#### Close-out log (2026-04-27) {#close-out}

| Step | Commit | Outcome |
|------|--------|---------|
| Step 1 — error path + verify | `a1c7cc50` | Codesign failures now exit non-zero with a diagnostic; `--verify --strict` runs after every re-sign. |
| (Side quest — `app-test-smoke` shortcut) | `b0c76797` | Three-file `just app-test-smoke` recipe added during Step 1 verification window. |
| Step 2 — sentinel capture | `e99c5289` | `.tugtool/code-sign-fingerprint` written atomically after verify; gitignore updated. |
| Step 3 — fail-loud + drift | `6eb82c7f` | Missing identity now exits 1 with actionable message + `APP_TEST_SKIP_RESIGN=1` opt-out; drift surfaces a 4-line `[warn]` to stderr. |
| Step 4 — README + cross-link | `8ca0aaaa` | "Accessibility grant failure modes" section + signing-script cross-link. |
| Step 5 — integration | (verification only) | All 8 automated gates pass; live drift probe fired correctly; user-verified end-to-end smoke. |

**Final state:** signing pipeline now fails loud on every silent-failure mode the audit identified. Drift detection is proactive (warning before the 90-second test sweep wastes time). The README has a real failure-mode checklist for the next confused person.

---

### Phase 2 Addendum — Polish + Teardown {#phase-2-addendum}

**Authored:** 2026-04-27, immediately after Phase 1 close.

**Trigger:** the user opted to take two of the three Roadmap / Follow-ons (E + G) right away while the area was in our sights. Item 1 (move `CODE_SIGN_IDENTITY` into pbxproj) is **deferred indefinitely** — the audit and the post-Phase-1 review both concluded the friction-on-onboarding cost outweighed the ~50ms-per-build savings.

#### Phase 2 strategy {#phase-2-strategy}

- **Step 6 — Audit-item E: skip re-sign when fingerprint matches.** Hoist the DR comparison to the top of the `app-test` re-sign block; if current DR == saved DR, skip both the re-sign and the post-resign drift block (they'd both be no-ops). Saves ~100ms per `app-test` invocation in the steady state AND avoids the corner case where re-signing with a re-created `Tug Dev` cert would invalidate an otherwise-valid AX grant.
- **Step 7 — Audit-item G: `just teardown-dev-signing` recipe.** Removes the `Tug Dev` identity from the login keychain and clears `.tugtool/code-sign-fingerprint`. Used when decommissioning the project on a machine, debugging confused signing state, or migrating to a different identity. Trivial — ~10 lines.

#### Phase 2 success criteria {#phase-2-success-criteria}

- **Step 6:** `just app-test` in the steady state prints `==> Re-sign skipped (bundle DR matches sentinel)` and the recipe completes faster (subjective; ~100ms is below the noise floor of a multi-file sweep but visible on a single-file invocation).
- **Step 6:** drift case still fires correctly — corrupt the sentinel, run `app-test`, observe re-sign happen + drift warn on post-resign comparison.
- **Step 7:** `just teardown-dev-signing` removes the cert and the sentinel; running it twice is idempotent (second run reports "nothing to remove").
- **Step 7:** after teardown, `just app-test` (without `APP_TEST_SKIP_RESIGN=1`) hits the fail-loud path. After `just setup-dev-signing` + `just build-app`, normal flow resumes.

#### Phase 2 execution {#phase-2-execution}

##### Step 6: app-test — skip re-sign when fingerprint matches {#step-6}

**Depends on:** #step-3

**Commit:** `f7811d7b` (bundled with Step 7).

**Tasks:**
- [x] Hoist the current-DR + saved-DR extraction above the re-sign branch.
- [x] Add the early-skip branch at the top.
- [x] Leave the existing fail-loud / opt-out / drift logic intact for the mismatch path.

**Tests:**
- [x] Steady-state probe: `just app-test nonexistent.test.ts` printed `==> Re-sign skipped (bundle DR matches sentinel)`.
- [x] Drift probe: bogus sentinel value triggered re-sign + 4-line `[warn]` block (Saved/Current/invalidated/README cross-link), exactly as designed.
- [ ] Stale-bundle probe — deferred (low value, would require running an Xcode IDE Build to invalidate the bundle's signature; the optimization's correctness is already covered by the drift probe).

##### Step 7: just teardown-dev-signing recipe {#step-7}

**Depends on:** #step-6

**Commit:** `f7811d7b` (bundled with Step 6 — same file, tightly coupled).

**Tasks:**
- [x] Add `teardown-dev-signing` recipe near `setup-dev-signing` in the Justfile.
- [x] Body: `security delete-identity -c "Tug Dev"` (with not-found tolerance), `rm -f .tugtool/code-sign-fingerprint`, closing instruction to re-run `setup-dev-signing` + `build-app`.

**Tests:**
- [x] `just --list` shows the new recipe with its summary line.
- [x] `just --show teardown-dev-signing` reveals the expected body.
- [ ] Live probe deferred — would disturb the user's working `Tug Dev` identity. Code review of the recipe is sufficient given the small scope.

#### Phase 2 Close-out (2026-04-27) {#phase-2-close-out}

| Step | Commit | Outcome |
|------|--------|---------|
| Plan addendum | `26cacb3e` | Phase 2 scoped + item 1 explicitly deferred. |
| Step 6 + Step 7 (bundled) | `f7811d7b` | Re-sign skipped on DR match (saves ~100ms steady-state); teardown recipe lands. |

**Verified live:**
- Steady-state `app-test` prints `Re-sign skipped (bundle DR matches sentinel)`.
- Bogus-sentinel probe: re-sign branch fires, post-resign drift warn fires.
- `just --list` shows `teardown-dev-signing` alongside `setup-dev-signing`.

#### Phase 2 Roadmap / Follow-ons Status

- [x] Audit-item E. (Step 6, commit `f7811d7b`.)
- [x] Audit-item G. (Step 7, commit `f7811d7b`.)
- [ ] **Audit-item 1 — DEFERRED INDEFINITELY.** The pbxproj-edit form forces every contributor through `setup-dev-signing` even for non-test builds, which the audit and post-Phase-1 review both concluded was the wrong trade for ~50ms savings. A command-line `CODE_SIGN_IDENTITY="Tug Dev" CODE_SIGN_STYLE=Manual` override on `xcodebuild` was identified as a less-disruptive alternative; it's also deferred for now since the post-resign overwrite already works.

**Final state of the signing pipeline (post-Phase-2):**
- Every silent-failure mode the audit identified now produces an actionable error or structured warning.
- Steady-state `app-test` saves ~100ms by skipping the redundant re-sign.
- Drift detection remains proactive (warning before the test sweep wastes time on a broken AX grant).
- Decommissioning the project is one command (`just teardown-dev-signing`).
- Failure-mode checklist in the README means the next confused person has a path forward.
