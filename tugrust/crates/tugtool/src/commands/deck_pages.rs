//! `tugtool deck pages` — which page is on each of tugcast's WebSockets.
//!
//! GETs `/api/pages` off the running tugcast and prints one row per live
//! connection: its `client_id`, the role its hello named (`shell`, `body`, or
//! `tool` for a connection that named none), its page id, the card a body
//! renders, and the sessions it subscribed to (`all` until it narrows them,
//! `none` when it narrowed them to nothing).
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
        "{:<7} {:<6} {:<38} {:<20} sessions",
        "client", "role", "page", "card"
    )];
    for page in pages {
        let client = page
            .get("client_id")
            .and_then(|c| c.as_u64())
            .map(|c| c.to_string())
            .unwrap_or_else(|| "-".into());
        let sessions = match page.get("sessions") {
            Some(serde_json::Value::Array(ids)) if ids.is_empty() => "none".into(),
            Some(serde_json::Value::Array(ids)) => ids
                .iter()
                .filter_map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(","),
            _ => "all".into(),
        };
        rows.push(format!(
            "{:<7} {:<6} {:<38} {:<20} {}",
            client,
            text(page, "role"),
            text(page, "page_id"),
            text(page, "card_id"),
            sessions
        ));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_name_every_column_and_default_sessions_to_all() {
        let pages = vec![
            json!({"client_id": 3, "role": "shell", "page_id": "p3", "card_id": null, "sessions": null}),
            json!({"client_id": 5, "role": "body", "page_id": "p5", "card_id": "c1", "sessions": ["s1", "s2"]}),
            json!({"client_id": 6, "role": "tool", "page_id": null, "card_id": null, "sessions": null}),
            json!({"client_id": 8, "role": "body", "page_id": "p8", "card_id": "c2", "sessions": []}),
        ];
        let rows = render_rows(&pages);
        assert_eq!(rows.len(), 5);
        assert!(rows[0].starts_with("client"));
        let shell: Vec<&str> = rows[1].split_whitespace().collect();
        assert_eq!(shell, vec!["3", "shell", "p3", "-", "all"]);
        let body: Vec<&str> = rows[2].split_whitespace().collect();
        assert_eq!(body, vec!["5", "body", "p5", "c1", "s1,s2"]);
        let tool: Vec<&str> = rows[3].split_whitespace().collect();
        assert_eq!(tool, vec!["6", "tool", "-", "-", "all"]);
        let narrowed: Vec<&str> = rows[4].split_whitespace().collect();
        assert_eq!(narrowed, vec!["8", "body", "p8", "c2", "none"]);
    }
}
