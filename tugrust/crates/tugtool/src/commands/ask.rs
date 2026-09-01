//! Implementation of the `tugtool host ask` command — put a question to the
//! human in the deck and print their answer.
//!
//! The point of this verb is consent before disruption: a shell script that is
//! about to do something the developer will feel (take over the screen, restart
//! something, spend real time) can raise a dialog in the Session card and block
//! until it is answered.
//!
//! Three outcomes, three exit codes, because callers need to tell them apart:
//!
//! - `0` — answered. The chosen option's value is the only thing on stdout.
//! - `2` — declined, timed out, or the deck went away mid-question. The caller
//!   should not proceed.
//! - `3` — no route to a dialog at all. There is nobody to ask, which is not the
//!   same as being told no; the caller decides what to do, and for app-tests
//!   that means proceeding with a warning rather than blocking a terminal-only
//!   run that could never have shown a dialog.
//!
//! ## `--unattended` — a chance to intervene, not a block
//!
//! Blocking is right when the disruption needs a yes. It is wrong when the
//! honest default is to go ahead and the prompt exists only so a developer *at
//! the keyboard* can stop it: there, an unanswered question means nobody was
//! there to mind, and holding the caller until it times out — then reading that
//! silence as "no" — strands the work for as long as the developer is away.
//!
//! `--unattended VALUE` names the answer silence means. The dialog counts
//! `--timeout-secs` down where the developer can see it and commits the
//! selected option when it reaches zero, so the question resolves either way
//! and the developer's only cost for being present is a keystroke.

use std::time::Duration;

use crate::commands::tell::is_apptest_instance;

/// Exit code for "asked, and the answer was no" — including a timeout, which
/// means nobody was there to say yes.
const EXIT_DECLINED: i32 = 2;

/// Exit code for "there was nobody to ask". Distinct from a refusal.
const EXIT_NO_ROUTE: i32 = 3;

/// One selectable option, spelled `value:label[:description]` on the command line.
#[derive(Debug, PartialEq)]
struct AskOption {
    value: String,
    label: String,
    description: Option<String>,
}

/// Parse a `value:label[:description]` option spec.
///
/// Splits at most twice, so a description may contain colons — which it often
/// does, since descriptions are prose.
fn parse_option(spec: &str) -> Result<AskOption, String> {
    let mut parts = spec.splitn(3, ':');
    let value = parts.next().unwrap_or_default();
    let label = parts.next().unwrap_or_default();
    if value.is_empty() || label.is_empty() {
        return Err(format!(
            "invalid --option '{spec}': expected value:label[:description]"
        ));
    }
    Ok(AskOption {
        value: value.to_owned(),
        label: label.to_owned(),
        description: parts.next().filter(|d| !d.is_empty()).map(str::to_owned),
    })
}

/// Find the tugcast to ask, or `None` if there is no sensible one.
///
/// Deliberately more forgiving than `resolve_port` in `tell.rs`, which treats a
/// multi-instance registry as an error. That is right for `tell` — sending an
/// action to the wrong instance is a bug — but wrong here: during any app-test
/// run the registry holds the harness's own instances, and erroring out would
/// drop the question on the floor at exactly the moment two runs are competing
/// for the screen. Ambiguity resolves to "no route", which the caller handles.
fn resolve_ask_port(explicit_port: Option<u16>, explicit_instance: Option<String>) -> Option<u16> {
    if let Some(p) = explicit_port {
        return Some(p);
    }

    let id_from_arg = explicit_instance.filter(|s| !s.is_empty());
    let id_from_env = std::env::var("TUG_INSTANCE").ok().filter(|s| !s.is_empty());
    if let Some(id) = id_from_arg.or(id_from_env) {
        return match tugcore::registry::find_by_id(&id) {
            Ok(Some(i)) => Some(i.tugcast_port),
            _ => None,
        };
    }

    if let Ok(cwd) = std::env::current_dir()
        && let Ok(Some(i)) = tugcore::registry::find_for_cwd(&cwd)
    {
        return Some(i.tugcast_port);
    }

    match tugcore::registry::list_live() {
        Ok(live) => {
            let candidates: Vec<_> = live
                .iter()
                .filter(|i| !is_apptest_instance(&i.instance_id))
                .collect();
            match candidates.as_slice() {
                [only] => Some(only.tugcast_port),
                _ => None,
            }
        }
        Err(_) => None,
    }
}

/// Run the ask command. See the module docstring for the exit-code contract.
pub fn run_ask(
    title: String,
    description: Option<String>,
    option: Vec<String>,
    timeout_secs: u64,
    unattended: Option<String>,
    port: Option<u16>,
    instance: Option<String>,
) -> Result<i32, String> {
    if option.is_empty() {
        return Err("at least one --option is required".to_owned());
    }
    let options = option
        .iter()
        .map(|s| parse_option(s))
        .collect::<Result<Vec<_>, _>>()?;

    // An unattended answer nobody offered would count a question down to an
    // option that does not exist, so it is caught here rather than on the wire.
    if let Some(value) = unattended.as_deref()
        && !options.iter().any(|o| o.value == value)
    {
        return Err(format!(
            "--unattended '{value}' is not one of the --option values"
        ));
    }

    let Some(port) = resolve_ask_port(port, instance) else {
        eprintln!("tugtool host ask: no Tug instance to ask — proceeding without a prompt");
        return Ok(EXIT_NO_ROUTE);
    };

    // The dialog is routed to a card by session id, and the deck matches
    // exactly: a `$TUG_SESSION_ID` frozen before a rotation names no card, and
    // an unrouted ask is answered by the declining fallback without anyone
    // being asked. Resolve to the line's live segment first ([P01]).
    let session_id = crate::session_identity::resolve_soft(None).map(|r| r.session_id);
    let body = serde_json::json!({
        "sessionId": session_id,
        "title": title,
        "description": description,
        "timeoutSecs": timeout_secs,
        "unattendedChoice": unattended,
        "options": options.iter().map(|o| serde_json::json!({
            "value": o.value,
            "label": o.label,
            "description": o.description,
        })).collect::<Vec<_>>(),
    });

    // The default agent timeout is far shorter than a human takes to read a
    // dialog, so the wait is configured explicitly — with headroom over the
    // server's own timeout so the server's 504 is what we see, not a local
    // abort that would leave the deck showing a dialog nobody is waiting on.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs + 30)))
        .build()
        .into();

    let url = format!("http://127.0.0.1:{port}/api/ask");
    match agent.post(&url).send_json(&body) {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let parsed: serde_json::Value = response
                .body_mut()
                .read_json()
                .map_err(|e| format!("could not read the answer: {e}"))?;
            if status == 200 {
                match parsed.get("choice").and_then(|c| c.as_str()) {
                    Some(choice) => {
                        println!("{choice}");
                        Ok(0)
                    }
                    None => Err("the answer carried no choice".to_owned()),
                }
            } else {
                let message = parsed
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("no answer");
                eprintln!("tugtool host ask: {message}");
                // 503 means tugcast is up but no deck is attached to show the
                // dialog on. That is the same condition as an unreachable
                // instance — there was nobody to ask — not a refusal, so it must
                // not read as one. Everything else here IS an answer of sorts:
                // a malformed request, a timeout, a deck that dropped.
                if status == 503 {
                    Ok(EXIT_NO_ROUTE)
                } else {
                    Ok(EXIT_DECLINED)
                }
            }
        }
        Err(ureq::Error::StatusCode(code)) => {
            eprintln!("tugtool host ask: server returned {code}");
            Ok(EXIT_DECLINED)
        }
        Err(e) => {
            // Connection refused, DNS, a socket that closed under us — the
            // instance is gone or was never there. Nobody to ask.
            eprintln!(
                "tugtool host ask: could not reach the deck ({e}) — proceeding without a prompt"
            );
            Ok(EXIT_NO_ROUTE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_value_and_label() {
        assert_eq!(
            parse_option("run-all:Run all").unwrap(),
            AskOption {
                value: "run-all".to_owned(),
                label: "Run all".to_owned(),
                description: None,
            }
        );
    }

    #[test]
    fn description_may_contain_colons() {
        let o = parse_option("cancel:Cancel:Run nothing: not even the background tests").unwrap();
        assert_eq!(
            o.description.as_deref(),
            Some("Run nothing: not even the background tests")
        );
    }

    #[test]
    fn a_spec_with_no_separator_is_an_error() {
        assert!(parse_option("run-all").is_err());
    }

    #[test]
    fn an_empty_label_is_an_error() {
        assert!(parse_option("run-all:").is_err());
    }

    #[test]
    fn an_empty_value_is_an_error() {
        assert!(parse_option(":Run all").is_err());
    }

    #[test]
    fn apptest_instances_are_never_ask_targets() {
        assert!(is_apptest_instance("apptest-main-9f2c"));
        assert!(!is_apptest_instance("debug-main"));
        assert!(!is_apptest_instance("release"));
    }

    #[test]
    fn an_unattended_value_must_name_an_option() {
        let err = run_ask(
            "Take the screen?".to_owned(),
            None,
            vec!["run-all:Run them".to_owned(), "skip:Skip them".to_owned()],
            30,
            Some("run-them".to_owned()),
            Some(1),
            None,
        )
        .unwrap_err();
        assert!(err.contains("--unattended"), "{err}");
    }

    #[test]
    fn an_explicit_port_short_circuits_discovery() {
        assert_eq!(resolve_ask_port(Some(9999), None), Some(9999));
    }

    #[test]
    fn an_unknown_instance_is_no_route_rather_than_an_error() {
        assert_eq!(
            resolve_ask_port(None, Some("does-not-exist-xyz-zzz".to_owned())),
            None
        );
    }
}
