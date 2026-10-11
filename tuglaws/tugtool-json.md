# The `tugtool --json` envelope

`--json` is a global flag, and it means one thing on every verb: stdout carries exactly one JSON document, the **envelope**, whether the verb succeeded or failed. A caller that asked for JSON always has something to parse, and reads *why* a verb said no from a field rather than from a stderr sentence.

The envelope is `JsonResponse` in `tugrust/crates/tugtool/src/output.rs`, and the printers beside it are the only code that writes one.

---

## The five fields

```json
{
  "schema_version": "1",
  "command": "arc create",
  "status": "error",
  "data": null,
  "issues": [
    { "code": "arc_invalid_name", "severity": "error", "message": "…" }
  ]
}
```

| Field | Meaning |
|---|---|
| `schema_version` | `"1"`. Bumped only for a change a reader of `"1"` would misread. |
| `command` | The verb's full path, as typed: `arc create`, `draft set`, `host gate run`, `deck motion slide`. |
| `status` | `"ok"`, `"error"`, or `"held"` — see below. |
| `data` | The verb's payload. On an error it is `null`, or the receipt of the part of the work that was done before the failure. |
| `issues` | Diagnostics. Empty on a plain success; on an error, `issues[0]` is the failure. |

Each issue carries `code`, `severity` (`"error"` or `"warning"`) and `message`, and may carry `file`, `line` and `anchor` (`"#…"`) when it points into a document.

## The three statuses

- **`ok`** — the verb did what it was asked. `issues` may still hold warnings.
- **`error`** — it did not. `issues[0]` says why.
- **`held`** — the verb found its resource held by someone else and, asked not to wait, reports who. This is neither success nor failure. Only `host gate run --no-wait` answers `held` today.

## `issues[0].code` is the cause

On `status: "error"`, **`issues[0].code` is the machine-readable cause**. Branch on it; never match `message`, which is a sentence for people and is free to change. A code is `snake_case` and stable once shipped. Every code is named, even one no caller reads yet, because the next caller will. `failed` is the code for a failure with no more specific cause.

A verb that did part of its work and then judged it prints **one** document either way: the success envelope when the verdict is good, otherwise the error envelope with the receipt as `data` and the verdict as `issues[0]`. Examples are a join that conflicted, a doctor that found disagreements, or a claim the instance refused. stdout never carries a success envelope followed by an error one.

A verb whose answer *is* a list of diagnostics (`plan lint`) puts every diagnostic in `issues`. Its status is `error` when any of them has severity `error`, and `ok` otherwise.

Under `--json` the human `error: …` line on stderr is suppressed, because the envelope carries its message. Without `--json`, nothing about the text output changes.

### The codes

| Code | Raised by | Exit |
|---|---|---|
| `failed` | any verb, for a failure with no more specific cause | 1 |
| `no_session_id`, `no_ledger`, `unknown_session` | the changes verbs, when the session or its ledger cannot be found | 2 |
| `unknown_session`, `session_refused` | session-addressed arc verbs: the ledger does not know the session as live yet, or its owner said no | 1 |
| `unattributed_present` | `commit` with unattributed files in the bucket | 3 |
| `hunk_drift`, `bad_path` | `commit` | 1 |
| `ownership_refused`, `ownership_shortfall` | `claim`, `disclaim` | 1 |
| `unresolved` | the `plan` verbs, for a document that does not resolve or parse | 2 |
| `not_a_repository`, `git_unavailable` | arc verbs that check the repository and git before they start (others outside a repository answer `arc_refused`) | 1 |
| `arc_invalid_name`, `arc_not_found` | arc verbs | 2 |
| `arc_blocked`, `arc_conflicted`, `arc_refused`, `arc_unresolved` | arc verbs (`arc_refused` includes a resolve lease another resolver holds) | 3 |
| `git_index_locked` | arc verbs, when another git process holds `index.lock` (worth retrying) | 1 |
| `git_lock_held` | arc verbs, when another git process holds some other lock — a ref, a config file (worth retrying) | 1 |
| `git_failed`, `io_failed` | arc verbs | 1 |
| `records_disagree` | `arc doctor` | 1 |
| `claim_refused` | `arc create`, `arc step`, when the instance refuses the binding | 1 |
| `not_a_session_reference` | `session find`, `session show`, for a spelling that is no session reference | 1 |
| `session_absent` | `session show`, for a session not on this machine (`session find` answers `ok` with `verdict: "absent"`) | 3 |
| `eval_gated` | `deck motion` verbs, when the deck's eval door is shut | 2 |
| `instance_unresolved`, `bad_params`, `server_error`, `connection_failed` | `host tell` | 1 |
| `unknown_gate` | `host gate run` | 64 |
| `gate_port_conflict`, `gate_bind_failed` | `host gate run` | 1 |

## Fields are additive

A reader ignores fields it does not know. New fields may appear in the envelope, in an issue, or in any verb's `data` without a `schema_version` bump. A field is never removed, renamed or retyped without one.

## Exit codes

`--json` changes what is printed and nothing about how the process ends. The exit code is the same with and without it.

| Exit | Meaning |
|---|---|
| 0 | Success, warnings or not. |
| 1 | The verb failed. |
| 2 | The subject could not be found or resolved (no such arc, no session, no ledger, an unresolvable plan), or eval is gated, or `host gate run --no-wait` found the gate held (`status: "held"`). |
| 3 | Refused on the merits: blocked, conflicted, unattributed files present, or a session that is not on this machine (`session show` errors with `session_absent`; `session find` answers `ok`). |
| 9 | `host init --check` on a project with no `.tugtool/` (`status: "ok"`, `data.initialized: false`). |
| 64 | `host gate run` with a gate name it does not know (usage). |
| other | Passed through from a child: `host gate run`, `file run` and `file probe` exit with their command's status. |

Some verbs answer with a non-zero exit and `status: "ok"`, because the report *is* the answer and the exit is its summary: `arc verify`, `arc replay`, `session find` on an absent session (exit 3, `data.verdict: "absent"`), and `host init --check` on an uninitialized project (exit 9). Their `data` says what the exit means.

## Out of scope

The record receipts — `apptest record`, `apptest reach record`, `apptest reach show`, `test record` — always print bare JSON, take no `--json` flag, and are read only by the harness that wrote them.
