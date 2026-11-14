//! The sharing family of CONTROL actions: `scrub_share_text`, the deck's one
//! route to the secret filter before a selection of turns is rendered for
//! another person.
//!
//! The deck never ports the filter's patterns. It sends every string an
//! output will show, in one request, and gets them back in the same order
//! and number, each through [`scrub_text`] and then with the user's home
//! directory shortened to `~`. Tugcast is the side that knows `$HOME`
//! reliably, which is why the shortening rides here too.
//!
//! Every request is answered, a malformed one included: the answer is
//! `scrub_share_text_ok { request_id, texts }` or
//! `scrub_share_text_err { request_id, reason }`, broadcast like every
//! CONTROL answer, so the caller keeps only its own `request_id`. A caller
//! that hears nothing fails its share action at its own deadline, so an
//! unscrubbed string never renders.

use std::borrow::Cow;

use super::super::*;
use crate::feeds::secret_filter::scrub_text;
use tugcast_core::ControlAction;

/// The most strings one request may carry.
const MAX_TEXTS: usize = 20_000;

/// The most bytes, summed over every string, one request may carry. Sixteen
/// MiB is far past any selection a person would send, and well short of
/// what would hold the blocking pool for long.
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;

/// Why a request was refused, as the wire spells it.
#[derive(Debug, PartialEq, Eq)]
enum ScrubShareRefusal {
    Malformed,
    TooLarge,
}

impl ScrubShareRefusal {
    fn reason(&self) -> &'static str {
        match self {
            ScrubShareRefusal::Malformed => "malformed_request",
            ScrubShareRefusal::TooLarge => "too_large",
        }
    }
}

/// A parsed `scrub_share_text` request: the caller's id, echoed on the
/// answer, and the strings to scrub.
struct ScrubShareRequest {
    request_id: serde_json::Value,
    texts: Vec<String>,
}

/// The `request_id` of a payload, whatever else is wrong with it, so a
/// refusal can still be told apart by its caller. Absent or unreadable is
/// `null`.
fn request_id_of(payload: &[u8]) -> serde_json::Value {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("request_id").cloned())
        .filter(|v| v.is_string())
        .unwrap_or(serde_json::Value::Null)
}

/// Parse a `scrub_share_text` payload: `{ request_id, texts: string[] }`.
/// A `request_id` that is not a string, or a `texts` that is not an array of
/// strings, is malformed; more than [`MAX_TEXTS`] strings or more than
/// [`MAX_TOTAL_BYTES`] in total is too large. The limits are checked before
/// anything is scrubbed.
fn parse_scrub_share_payload(payload: &[u8]) -> Result<ScrubShareRequest, ScrubShareRefusal> {
    let value: serde_json::Value =
        serde_json::from_slice(payload).map_err(|_| ScrubShareRefusal::Malformed)?;
    let request_id = value
        .get("request_id")
        .filter(|v| v.is_string())
        .cloned()
        .ok_or(ScrubShareRefusal::Malformed)?;
    let items = value
        .get("texts")
        .and_then(|v| v.as_array())
        .ok_or(ScrubShareRefusal::Malformed)?;
    if items.len() > MAX_TEXTS {
        return Err(ScrubShareRefusal::TooLarge);
    }
    let mut total = 0usize;
    let mut texts = Vec::with_capacity(items.len());
    for item in items {
        let text = item.as_str().ok_or(ScrubShareRefusal::Malformed)?;
        total += text.len();
        if total > MAX_TOTAL_BYTES {
            return Err(ScrubShareRefusal::TooLarge);
        }
        texts.push(text.to_owned());
    }
    Ok(ScrubShareRequest { request_id, texts })
}

/// Whether `c` can continue a path component, so a home directory followed
/// by it names some other path (`/Users/ken` before `x` is `/Users/kenx`).
fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')
}

/// `text` with every occurrence of `home` that names the home directory
/// replaced by `~`.
///
/// An occurrence names the home directory when what follows it is `/`, the
/// end of the text, or a character that cannot continue a path component —
/// so a home of `/Users/ken` leaves `/Users/kenx` alone. A `.` that ends a
/// sentence (one followed by the end of the text or by whitespace) is
/// punctuation rather than part of a name, so `/Users/ken.` shortens to `~.`
/// while `/Users/ken.bak` does not. And it must start a path: an occurrence
/// preceded by a path character or a `/` is the tail of some longer path
/// (`/private/Users/ken`), which is left alone.
///
/// An empty home, or one that is only `/`, is a no-op. A trailing `/` on
/// `home` is ignored. Text that holds no occurrence comes back borrowed.
fn shorten_home<'a>(text: &'a str, home: &str) -> Cow<'a, str> {
    let home = home.trim_end_matches('/');
    if home.is_empty() || !text.contains(home) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut copied = 0usize;
    for (at, _) in text.match_indices(home) {
        if at < copied {
            continue;
        }
        let before = text[..at].chars().next_back();
        let starts_path = before.is_none_or(|c| c != '/' && !is_path_char(c));
        let rest = &text[at + home.len()..];
        let mut after = rest.chars();
        let ends_name = match after.next() {
            None | Some('/') => true,
            Some('.') => after.next().is_none_or(char::is_whitespace),
            Some(c) => !is_path_char(c),
        };
        if starts_path && ends_name {
            out.push_str(&text[copied..at]);
            out.push('~');
            copied = at + home.len();
        }
    }
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    out.push_str(&text[copied..]);
    Cow::Owned(out)
}

/// The whole answer to one `scrub_share_text` payload, given the home
/// directory to shorten (`None` when `$HOME` is unset). Pure, so the tests
/// read it without a supervisor; the async handler runs it on the blocking
/// pool and broadcasts what it returns.
fn scrub_share_answer(payload: &[u8], home: Option<&str>) -> serde_json::Value {
    match parse_scrub_share_payload(payload) {
        Ok(ScrubShareRequest { request_id, texts }) => {
            let texts: Vec<String> = texts
                .iter()
                .map(|text| {
                    let scrubbed = scrub_text(text);
                    match home {
                        Some(home) => shorten_home(&scrubbed, home).into_owned(),
                        None => scrubbed.into_owned(),
                    }
                })
                .collect();
            serde_json::json!({
                "action": "scrub_share_text_ok",
                "request_id": request_id,
                "texts": texts,
            })
        }
        Err(refusal) => serde_json::json!({
            "action": "scrub_share_text_err",
            "request_id": request_id_of(payload),
            "reason": refusal.reason(),
        }),
    }
}

impl AgentSupervisor {
    /// The sharing family's share of [`AgentSupervisor::handle_control`].
    /// Every payload is answered on CONTROL, a refused one with
    /// `scrub_share_text_err`, so the outcome is always `Handled`.
    pub(in crate::feeds::agent_supervisor) async fn handle_share_control(
        &self,
        action: ControlAction,
        payload: &[u8],
    ) -> ControlOutcome {
        match action {
            ControlAction::ScrubShareText => {
                let payload = payload.to_vec();
                let home = std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned());
                // Sixteen MiB of regex is not reactor work.
                let body = tokio::task::spawn_blocking(move || {
                    scrub_share_answer(&payload, home.as_deref())
                })
                .await
                .unwrap_or_else(|err| {
                    warn!(error = %err, "scrub_share_text: scrub task failed");
                    serde_json::json!({
                        "action": "scrub_share_text_err",
                        "request_id": serde_json::Value::Null,
                        "reason": "scrub_failed",
                    })
                });
                send_control(&self.control_tx, body);
                ControlOutcome::Handled
            }
            other => {
                warn!(
                    action = other.as_str(),
                    "handle_share_control: not a sharing action"
                );
                ControlOutcome::PassThrough
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/u";

    fn answer(payload: serde_json::Value) -> serde_json::Value {
        scrub_share_answer(payload.to_string().as_bytes(), Some(HOME))
    }

    fn texts_of(answer: &serde_json::Value) -> Vec<String> {
        answer["texts"]
            .as_array()
            .expect("texts")
            .iter()
            .map(|t| t.as_str().expect("string").to_owned())
            .collect()
    }

    #[test]
    fn scrub_share_takes_out_secrets_of_each_shape() {
        let out = answer(serde_json::json!({
            "request_id": "scrub-1",
            "texts": [
                "key sk-ant-api03-abcdefghijklmnopqrstuvwx here",
                "password: hunter2hunter",
                "Authorization: Bearer abcdefghijklmnop",
            ],
        }));
        assert_eq!(out["action"], "scrub_share_text_ok");
        assert_eq!(out["request_id"], "scrub-1");
        let texts = texts_of(&out);
        assert_eq!(texts[0], "key [secret] here");
        assert_eq!(texts[1], "password: [secret]");
        assert!(texts[2].contains("[secret]"), "{}", texts[2]);
        assert!(!texts[2].contains("abcdefghijklmnop"), "{}", texts[2]);
    }

    #[test]
    fn scrub_share_shortens_home_at_its_boundaries() {
        let cases = [
            ("/Users/u/a", "~/a"),
            ("/Users/u", "~"),
            ("cd /Users/u.", "cd ~."),
            ("\"/Users/u\"", "\"~\""),
            ("in /Users/u and /Users/u/b", "in ~ and ~/b"),
            ("/Users/ux/a", "/Users/ux/a"),
            ("/Users/u.bak", "/Users/u.bak"),
            ("/private/Users/u/a", "/private/Users/u/a"),
            ("nothing here", "nothing here"),
        ];
        for (text, want) in cases {
            assert_eq!(shorten_home(text, HOME), want, "{text}");
        }
    }

    #[test]
    fn scrub_share_home_shortening_is_a_noop_without_a_home() {
        assert_eq!(shorten_home("/Users/u/a", ""), "/Users/u/a");
        assert_eq!(shorten_home("/Users/u/a", "/"), "/Users/u/a");
        assert_eq!(shorten_home("/Users/u/a", "/Users/u/"), "~/a");
        let out = scrub_share_answer(
            serde_json::json!({ "request_id": "r", "texts": ["/Users/u/a"] })
                .to_string()
                .as_bytes(),
            None,
        );
        assert_eq!(texts_of(&out), vec!["/Users/u/a"]);
    }

    #[test]
    fn scrub_share_keeps_order_and_length() {
        let texts: Vec<String> = (0..50).map(|i| format!("line {i} /Users/u/f{i}")).collect();
        let out = answer(serde_json::json!({ "request_id": "r", "texts": texts }));
        let back = texts_of(&out);
        assert_eq!(back.len(), 50);
        for (i, text) in back.iter().enumerate() {
            assert_eq!(text, &format!("line {i} ~/f{i}"));
        }
        let empty = answer(serde_json::json!({ "request_id": "r", "texts": [] }));
        assert_eq!(texts_of(&empty), Vec::<String>::new());
    }

    #[test]
    fn scrub_share_refuses_an_over_limit_request() {
        let many = vec![""; MAX_TEXTS + 1];
        let out = answer(serde_json::json!({ "request_id": "big", "texts": many }));
        assert_eq!(out["action"], "scrub_share_text_err");
        assert_eq!(out["request_id"], "big");
        assert_eq!(out["reason"], "too_large");

        let half = "x".repeat(MAX_TOTAL_BYTES / 2 + 1);
        let out =
            answer(serde_json::json!({ "request_id": "heavy", "texts": [half.clone(), half] }));
        assert_eq!(out["reason"], "too_large");
    }

    #[test]
    fn scrub_share_refuses_a_malformed_request() {
        let out = scrub_share_answer(b"not json", Some(HOME));
        assert_eq!(out["action"], "scrub_share_text_err");
        assert_eq!(out["reason"], "malformed_request");
        assert!(out["request_id"].is_null());

        for payload in [
            serde_json::json!({ "request_id": "m", "texts": "one string" }),
            serde_json::json!({ "request_id": "m", "texts": ["ok", 3] }),
            serde_json::json!({ "request_id": "m" }),
        ] {
            let out = answer(payload);
            assert_eq!(out["reason"], "malformed_request");
            assert_eq!(out["request_id"], "m");
        }
        let out = answer(serde_json::json!({ "texts": ["a"] }));
        assert_eq!(out["reason"], "malformed_request");
        assert!(out["request_id"].is_null());
    }
}
