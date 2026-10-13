//! Page identity: who is on the other end of a WebSocket.
//!
//! A connection names itself in its handshake hello. A `shell` page is the
//! deck's chrome, a `body` page renders one card, and anything that says
//! nothing is a `tool` (the harness's spike Worker, a test client, curl),
//! served exactly as every connection was before pages had names.

use serde::{Deserialize, Serialize};

/// The longest `page_id` or `card_id` a hello may carry.
pub const MAX_PAGE_FIELD_LEN: usize = 128;

/// What kind of page a connection is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageRole {
    Shell,
    Body,
    Tool,
}

impl PageRole {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            PageRole::Shell => "shell",
            PageRole::Body => "body",
            PageRole::Tool => "tool",
        }
    }
}

/// A connection's identity, as its hello stated it.
///
/// `card_id` is only ever present on a `body`: a shell or tool hello that
/// carries one has it ignored, so nothing downstream can mistake a shell
/// for the page of the card it named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageIdentity {
    pub role: PageRole,
    pub page_id: Option<String>,
    pub card_id: Option<String>,
}

impl PageIdentity {
    /// The identity of a connection that said nothing about itself.
    pub fn tool() -> Self {
        Self {
            role: PageRole::Tool,
            page_id: None,
            card_id: None,
        }
    }
}

/// Read one optional identity field: absent or `null` is `None`; a string
/// must be non-empty and at most [`MAX_PAGE_FIELD_LEN`] characters.
fn field(
    hello: &serde_json::Value,
    name: &str,
    empty: &'static str,
    long: &'static str,
    not_string: &'static str,
) -> Result<Option<String>, &'static str> {
    match hello.get(name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) if s.is_empty() => Err(empty),
        Some(serde_json::Value::String(s)) if s.chars().count() > MAX_PAGE_FIELD_LEN => Err(long),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(not_string),
    }
}

/// Parse the identity fields of a handshake hello.
///
/// An absent `role` is a tool. `shell` and `body` need a `page_id`; a `body`
/// needs a `card_id` too. The `Err` is the reason the socket is closed with,
/// after the `bad page identity: ` prefix.
pub fn parse_page_hello(hello: &serde_json::Value) -> Result<PageIdentity, &'static str> {
    let role = match hello.get("role") {
        None | Some(serde_json::Value::Null) => PageRole::Tool,
        Some(serde_json::Value::String(s)) => match s.as_str() {
            "shell" => PageRole::Shell,
            "body" => PageRole::Body,
            "tool" => PageRole::Tool,
            _ => return Err("unknown role"),
        },
        Some(_) => return Err("unknown role"),
    };
    let page_id = field(
        hello,
        "page_id",
        "empty page_id",
        "page_id too long",
        "page_id is not a string",
    )?;
    let card_id = field(
        hello,
        "card_id",
        "empty card_id",
        "card_id too long",
        "card_id is not a string",
    )?;
    match role {
        PageRole::Shell | PageRole::Body if page_id.is_none() => Err("missing page_id"),
        PageRole::Body if card_id.is_none() => Err("missing card_id"),
        PageRole::Body => Ok(PageIdentity {
            role,
            page_id,
            card_id,
        }),
        PageRole::Shell | PageRole::Tool => Ok(PageIdentity {
            role,
            page_id,
            card_id: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hello(extra: serde_json::Value) -> serde_json::Value {
        let mut v = json!({"protocol": "tugcast", "version": 1});
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    #[test]
    fn accepts_shell_body_and_tool() {
        let shell = parse_page_hello(&hello(json!({"role": "shell", "page_id": "p1"}))).unwrap();
        assert_eq!(shell.role, PageRole::Shell);
        assert_eq!(shell.page_id.as_deref(), Some("p1"));
        assert_eq!(shell.card_id, None);

        let body = parse_page_hello(&hello(
            json!({"role": "body", "page_id": "p2", "card_id": "c1"}),
        ))
        .unwrap();
        assert_eq!(body.role, PageRole::Body);
        assert_eq!(body.card_id.as_deref(), Some("c1"));

        let tool = parse_page_hello(&hello(json!({"role": "tool"}))).unwrap();
        assert_eq!(tool, PageIdentity::tool());
    }

    #[test]
    fn a_missing_role_is_a_tool() {
        assert_eq!(
            parse_page_hello(&hello(json!({}))).unwrap(),
            PageIdentity::tool()
        );
    }

    #[test]
    fn a_shell_ignores_a_card_id() {
        let shell = parse_page_hello(&hello(
            json!({"role": "shell", "page_id": "p", "card_id": "c"}),
        ))
        .unwrap();
        assert_eq!(shell.card_id, None);
    }

    #[test]
    fn refuses_malformed_identities() {
        assert_eq!(
            parse_page_hello(&hello(json!({"role": "chrome", "page_id": "p"}))),
            Err("unknown role")
        );
        assert_eq!(
            parse_page_hello(&hello(json!({"role": "body", "page_id": "p"}))),
            Err("missing card_id")
        );
        assert_eq!(
            parse_page_hello(&hello(json!({"role": "shell"}))),
            Err("missing page_id")
        );
        let long = "x".repeat(MAX_PAGE_FIELD_LEN + 1);
        assert_eq!(
            parse_page_hello(&hello(json!({"role": "shell", "page_id": long}))),
            Err("page_id too long")
        );
        let exact = "x".repeat(MAX_PAGE_FIELD_LEN);
        assert!(parse_page_hello(&hello(json!({"role": "shell", "page_id": exact}))).is_ok());
        assert_eq!(
            parse_page_hello(&hello(json!({"role": "shell", "page_id": ""}))),
            Err("empty page_id")
        );
    }
}
