//! `tugtool deck pages` — which page is on each of tugcast's WebSockets.
//!
//! GETs `/api/pages` off the running tugcast and prints one row per live
//! connection: its `client_id`, the role its hello named (`shell`, `body`, or
//! `tool` for a connection that named none), its page id, the card a body
//! renders, the sessions it watches (`none` until it names some, `all` for
//! a page that lists every session), and the sessions it subscribed to (`all`
//! until it narrows them, `none` when it narrowed them to nothing).
//! `--json` emits the response as tugcast sent it.

use crate::commands::tell::{Remedy, resolve_port};

pub fn run_deck_pages(
    port: Option<u16>,
    instance: Option<String>,
    json_output: bool,
) -> Result<i32, String> {
    let port = resolve_port(port, instance).map_err(|e| e.describe(Remedy::Flags))?;
    let url = format!("http://127.0.0.1:{port}/api/pages");

    let mut response = ureq::get(&url)
        .call()
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("reading response failed: {e}"))?;

    if json_output {
        crate::output::print_ok("deck pages", &body);
        return Ok(0);
    }

    let pages = body
        .get("pages")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    if pages.is_empty() {
        println!("no pages connected");
        return Ok(0);
    }
    for row in render_rows(&pages) {
        println!("{row}");
    }
    Ok(0)
}

/// The text form: a header and one aligned row per page.
fn render_rows(pages: &[serde_json::Value]) -> Vec<String> {
    fn text(v: &serde_json::Value, key: &str) -> String {
        v.get(key)
            .and_then(|s| s.as_str())
            .unwrap_or("-")
            .to_string()
    }
    let mut rows = vec![format!(
        "{:<7} {:<6} {:<38} {:<20} {:<8} sessions",
        "client", "role", "page", "card", "watch"
    )];
    for page in pages {
        let client = page
            .get("client_id")
            .and_then(|c| c.as_u64())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "-".into());
        // `null` is all in both fields. A missing field is the field's
        // default: every session for `sessions`, none for `watch`, which a
        // tugcast older than the watch scope does not send.
        let sessions = scope(page.get("sessions"), "all");
        let watch = scope(page.get("watch"), "none");
        rows.push(format!(
            "{:<7} {:<6} {:<38} {:<20} {:<8} {}",
            client,
            text(page, "role"),
            text(page, "page_id"),
            text(page, "card_id"),
            watch,
            sessions
        ));
    }
    rows
}

/// A session scope as the listing spells it: `all`, `none`, or the ids
/// joined by commas; `absent` when the page record carries no such field.
fn scope(field: Option<&serde_json::Value>, absent: &str) -> String {
    match field {
        None => absent.into(),
        Some(serde_json::Value::Array(ids)) if ids.is_empty() => "none".into(),
        Some(serde_json::Value::Array(ids)) => ids
            .iter()
            .filter_map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(","),
        Some(_) => "all".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_name_every_column_and_default_sessions_to_all() {
        let pages = vec![
            json!({"client_id": 3, "role": "shell", "page_id": "p3", "card_id": null, "sessions": null, "watch": []}),
            json!({"client_id": 5, "role": "body", "page_id": "p5", "card_id": "c1", "sessions": ["s1", "s2"], "watch": []}),
            json!({"client_id": 6, "role": "tool", "page_id": null, "card_id": null, "sessions": null}),
            json!({"client_id": 8, "role": "body", "page_id": "p8", "card_id": "c2", "sessions": [], "watch": null}),
            json!({"client_id": 9, "role": "body", "page_id": "p9", "card_id": "c3", "sessions": [], "watch": ["s1"]}),
        ];
        let rows = render_rows(&pages);
        assert_eq!(rows.len(), 6);
        assert!(rows[0].starts_with("client"));
        let header: Vec<&str> = rows[0].split_whitespace().collect();
        assert_eq!(
            header,
            vec!["client", "role", "page", "card", "watch", "sessions"]
        );
        let shell: Vec<&str> = rows[1].split_whitespace().collect();
        assert_eq!(shell, vec!["3", "shell", "p3", "-", "none", "all"]);
        let body: Vec<&str> = rows[2].split_whitespace().collect();
        assert_eq!(body, vec!["5", "body", "p5", "c1", "none", "s1,s2"]);
        let tool: Vec<&str> = rows[3].split_whitespace().collect();
        assert_eq!(
            tool,
            vec!["6", "tool", "-", "-", "none", "all"],
            "a missing watch is none"
        );
        let listing: Vec<&str> = rows[4].split_whitespace().collect();
        assert_eq!(
            listing,
            vec!["8", "body", "p8", "c2", "all", "none"],
            "a listing page watches all"
        );
        let named: Vec<&str> = rows[5].split_whitespace().collect();
        assert_eq!(named, vec!["9", "body", "p9", "c3", "s1", "none"]);
    }
}
