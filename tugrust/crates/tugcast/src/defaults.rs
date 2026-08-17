//! HTTP handlers for `/api/defaults` endpoints.
//!
//! Provides the tagged-object JSON wire format ([`TaggedValue`]) and
//! conversion functions between [`tugbank_core::Value`] and the wire format,
//! plus four HTTP handler functions for `/api/defaults/:domain` and
//! `/api/defaults/:domain/:key`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tracing::warn;
use tugbank_core::{Error as BankError, TugbankClient, Value};

/// Per-entry write cap for `/api/defaults`. Every defaults value is
/// serialized in full into the boot DEFAULTS frame (see
/// `feeds/defaults.rs`), so a single oversized entry is exactly the kind
/// of write that grows that frame toward the transport's 16 MB cap. A
/// legitimate default (theme, layout, a positions bag, a recents list) is
/// kilobytes; anything approaching this limit is misuse, rejected at the
/// boundary rather than allowed to accumulate and brick launch.
const MAX_DEFAULTS_VALUE_BYTES: usize = 256 * 1024;

/// Domain that used to hold per-session prompt history, keyed by session id.
/// History now lives in `prompt_history.db`; the constant survives as the key
/// the startup migration drains and as a root `draft_gc` still reads while
/// unmigrated instances may hold entries.
pub(crate) const PROMPT_HISTORY_DOMAIN: &str = "dev.tugtool.prompt.history";

/// Domain of per-card durable state, keyed by card id. Alongside prompt
/// history it is one of the two places a stored draft-attachment path can be
/// referenced from, so `draft_gc` reads both as its root set.
pub(crate) const CARDSTATE_DOMAIN: &str = "dev.tugtool.deck.cardstate";

// ── Tagged wire format ─────────────────────────────────────────────────────

/// Tagged JSON representation of a `tugbank_core::Value`.
///
/// The wire format uses `{"kind":"<type>","value":<payload>}` for all value
/// representations in both PUT request bodies and GET responses. See Table T01
/// in the plan for the full kind-string mapping.
///
/// - `Null` serializes as `{"kind":"null"}` — no `value` field.
/// - `Bytes` serializes the raw bytes as a standard base64 string.
/// - `Json` embeds the JSON value directly in the `value` field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct TaggedValue {
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<serde_json::Value>,
}

// ── Conversion: Value → TaggedValue ───────────────────────────────────────

/// Convert a `tugbank_core::Value` to its tagged wire representation.
///
/// `Bytes` payloads are encoded using standard base64. All other variants
/// map directly to their JSON counterparts per Table T01.
pub(crate) fn value_to_tagged(value: &Value) -> TaggedValue {
    match value {
        Value::Null => TaggedValue {
            kind: "null".to_owned(),
            value: None,
        },
        Value::Bool(b) => TaggedValue {
            kind: "bool".to_owned(),
            value: Some(serde_json::json!(b)),
        },
        Value::I64(n) => TaggedValue {
            kind: "i64".to_owned(),
            value: Some(serde_json::json!(n)),
        },
        Value::F64(f) => TaggedValue {
            kind: "f64".to_owned(),
            value: Some(serde_json::json!(f)),
        },
        Value::String(s) => TaggedValue {
            kind: "string".to_owned(),
            value: Some(serde_json::json!(s)),
        },
        Value::Bytes(b) => TaggedValue {
            kind: "bytes".to_owned(),
            value: Some(serde_json::json!(
                base64::engine::general_purpose::STANDARD.encode(b)
            )),
        },
        Value::Json(j) => TaggedValue {
            kind: "json".to_owned(),
            value: Some(j.clone()),
        },
    }
}

// ── Conversion: TaggedValue → Value ───────────────────────────────────────

/// Convert a tagged wire representation back to a `tugbank_core::Value`.
///
/// Returns `Err(String)` if the `kind` field is unrecognised, the `value`
/// field is missing or has the wrong JSON type, or the base64 payload for
/// `"bytes"` is invalid.
pub(crate) fn tagged_to_value(tagged: &TaggedValue) -> Result<Value, String> {
    match tagged.kind.as_str() {
        "null" => Ok(Value::Null),
        "bool" => {
            let b = tagged
                .value
                .as_ref()
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "\"bool\" value must be a JSON boolean".to_owned())?;
            Ok(Value::Bool(b))
        }
        "i64" => {
            let n = tagged
                .value
                .as_ref()
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "\"i64\" value must be a JSON integer".to_owned())?;
            Ok(Value::I64(n))
        }
        "f64" => {
            let f = tagged
                .value
                .as_ref()
                .and_then(|v| v.as_f64())
                .ok_or_else(|| "\"f64\" value must be a JSON number".to_owned())?;
            Ok(Value::F64(f))
        }
        "string" => {
            let s = tagged
                .value
                .as_ref()
                .and_then(|v| v.as_str())
                .ok_or_else(|| "\"string\" value must be a JSON string".to_owned())?;
            Ok(Value::String(s.to_owned()))
        }
        "bytes" => {
            let encoded = tagged
                .value
                .as_ref()
                .and_then(|v| v.as_str())
                .ok_or_else(|| "\"bytes\" value must be a base64-encoded JSON string".to_owned())?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| format!("invalid base64 for \"bytes\": {e}"))?;
            Ok(Value::Bytes(bytes))
        }
        "json" => {
            let j = tagged
                .value
                .clone()
                .ok_or_else(|| "\"json\" value must be present".to_owned())?;
            Ok(Value::Json(j))
        }
        other => Err(format!("unknown kind: \"{other}\"")),
    }
}

// ── Error mapping ──────────────────────────────────────────────────────────

/// Map a `tugbank_core::Error` to an HTTP response per [D05].
///
/// | Error variant          | Status | Body message         |
/// |------------------------|--------|----------------------|
/// | `InvalidDomain`        | 400    | "invalid domain"     |
/// | `InvalidKey`           | 400    | "invalid key"        |
/// | `ValueTooLarge`        | 413    | "value too large"    |
/// | `Serde`                | 400    | "invalid JSON"       |
/// | `Sqlite` / other       | 500    | "internal error"     |
pub(crate) fn bank_error_to_response(err: BankError) -> Response {
    match err {
        BankError::InvalidDomain(_) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"status": "error", "message": "invalid domain"})),
        )
            .into_response(),
        BankError::InvalidKey(_) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"status": "error", "message": "invalid key"})),
        )
            .into_response(),
        BankError::ValueTooLarge { .. } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({"status": "error", "message": "value too large"})),
        )
            .into_response(),
        BankError::Serde(_) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"status": "error", "message": "invalid JSON"})),
        )
            .into_response(),
        BankError::Sqlite(_) | BankError::Conflict => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

// ── Shared loopback guard ──────────────────────────────────────────────────

/// Return a 403 Forbidden response for non-loopback connections.
///
/// Returns `Some(Response)` when the connection should be rejected,
/// or `None` when the caller may proceed.
fn check_loopback(handler: &str, addr: SocketAddr) -> Option<Response> {
    if addr.ip().is_loopback() {
        return None;
    }
    warn!(
        "{}: rejected non-loopback connection from {}",
        handler, addr
    );
    Some(
        (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({"status": "error", "message": "forbidden"})),
        )
            .into_response(),
    )
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

/// Handle `GET /api/defaults/:domain`
///
/// Returns all key-value pairs in the specified domain as a JSON object
/// mapping keys to tagged values. An empty domain returns `{}`.
/// Restricted to loopback connections.
pub(crate) async fn get_domain(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(client): Extension<Arc<TugbankClient>>,
    Path(domain): Path<String>,
) -> Response {
    if let Some(resp) = check_loopback("get_domain", addr) {
        return resp;
    }

    let result = tokio::task::spawn_blocking(move || client.read_domain(&domain)).await;

    match result {
        Ok(Ok(map)) => {
            let tagged: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| {
                    let tv = value_to_tagged(v);
                    (k.clone(), serde_json::to_value(&tv).unwrap_or_default())
                })
                .collect();
            (
                StatusCode::OK,
                axum::Json(serde_json::Value::Object(tagged)),
            )
                .into_response()
        }
        Ok(Err(bank_err)) => bank_error_to_response(bank_err),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

/// Handle `GET /api/defaults/:domain/:key`
///
/// Returns the tagged value for a single key. Returns 404 when the key
/// does not exist. Restricted to loopback connections.
pub(crate) async fn get_key(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(client): Extension<Arc<TugbankClient>>,
    Path((domain, key)): Path<(String, String)>,
) -> Response {
    if let Some(resp) = check_loopback("get_key", addr) {
        return resp;
    }

    let result = tokio::task::spawn_blocking(move || client.get(&domain, &key)).await;

    match result {
        Ok(Ok(Some(value))) => {
            let tagged = value_to_tagged(&value);
            (
                StatusCode::OK,
                axum::Json(serde_json::to_value(&tagged).unwrap_or_default()),
            )
                .into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"status": "error", "message": "not found"})),
        )
            .into_response(),
        Ok(Err(bank_err)) => bank_error_to_response(bank_err),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

/// Handle `PUT /api/defaults/:domain/:key`
///
/// Writes a typed value to the specified domain/key. The request body must
/// be a tagged value object (`{"kind":"...","value":...}`). Returns 200 on
/// success. Restricted to loopback connections.
pub(crate) async fn put_key(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(client): Extension<Arc<TugbankClient>>,
    Path((domain, key)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    if let Some(resp) = check_loopback("put_key", addr) {
        return resp;
    }

    // Reject oversized entries at the boundary: they bloat the boot DEFAULTS
    // frame and can push it past the transport cap, hanging launch.
    if body.len() > MAX_DEFAULTS_VALUE_BYTES {
        warn!(
            domain = %domain,
            key = %key,
            bytes = body.len(),
            limit = MAX_DEFAULTS_VALUE_BYTES,
            "put_key: rejecting oversized defaults entry"
        );
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            axum::Json(serde_json::json!({
                "status": "error",
                "message": format!(
                    "value too large: {} bytes exceeds the {} byte per-entry defaults limit",
                    body.len(),
                    MAX_DEFAULTS_VALUE_BYTES
                ),
            })),
        )
            .into_response();
    }

    // Parse body as TaggedValue.
    let tagged: TaggedValue = match serde_json::from_slice(&body) {
        Ok(t) => t,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"status": "error", "message": "invalid JSON"})),
            )
                .into_response();
        }
    };

    // Convert tagged wire format to Value.
    let value = match tagged_to_value(&tagged) {
        Ok(v) => v,
        Err(detail) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"status": "error", "message": detail})),
            )
                .into_response();
        }
    };

    let result = tokio::task::spawn_blocking(move || {
        client.set(&domain, &key, value)?;
        Ok::<_, BankError>(())
    })
    .await;

    match result {
        Ok(Ok(())) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"status": "ok"})),
        )
            .into_response(),
        Ok(Err(bank_err)) => bank_error_to_response(bank_err),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

/// Handle `DELETE /api/defaults/:domain/:key`
///
/// Removes a key from the specified domain. Returns 200 if the key existed
/// and was removed, 404 if the key did not exist. Restricted to loopback
/// connections.
pub(crate) async fn delete_key(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Extension(client): Extension<Arc<TugbankClient>>,
    Path((domain, key)): Path<(String, String)>,
) -> Response {
    if let Some(resp) = check_loopback("delete_key", addr) {
        return resp;
    }

    let result = tokio::task::spawn_blocking(move || client.delete(&domain, &key)).await;

    match result {
        Ok(Ok(true)) => (
            StatusCode::OK,
            axum::Json(serde_json::json!({"status": "ok"})),
        )
            .into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"status": "error", "message": "not found"})),
        )
            .into_response(),
        Ok(Err(bank_err)) => bank_error_to_response(bank_err),
        Err(_join_err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"status": "error", "message": "internal error"})),
        )
            .into_response(),
    }
}

// ── Unit tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use serde_json::json;

    // ── TaggedValue serialization tests (T04–T12) ──────────────────────────

    // T04: Null produces {"kind":"null"} with no value field
    #[test]
    fn test_value_to_tagged_null() {
        let t = value_to_tagged(&Value::Null);
        assert_eq!(t.kind, "null");
        assert_eq!(t.value, None);
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"null"}"#);
    }

    // T05: Bool(true) produces {"kind":"bool","value":true}
    #[test]
    fn test_value_to_tagged_bool_true() {
        let t = value_to_tagged(&Value::Bool(true));
        assert_eq!(t.kind, "bool");
        assert_eq!(t.value, Some(json!(true)));
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"bool","value":true}"#);
    }

    // T05 (false variant): Bool(false) serializes correctly
    #[test]
    fn test_value_to_tagged_bool_false() {
        let t = value_to_tagged(&Value::Bool(false));
        assert_eq!(t.kind, "bool");
        assert_eq!(t.value, Some(json!(false)));
    }

    // T06: I64(42) produces {"kind":"i64","value":42}
    #[test]
    fn test_value_to_tagged_i64() {
        let t = value_to_tagged(&Value::I64(42));
        assert_eq!(t.kind, "i64");
        assert_eq!(t.value, Some(json!(42i64)));
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"i64","value":42}"#);
    }

    // T07: F64(2.5) produces {"kind":"f64","value":2.5}
    #[test]
    fn test_value_to_tagged_f64() {
        let t = value_to_tagged(&Value::F64(2.5));
        assert_eq!(t.kind, "f64");
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"f64","value":2.5}"#);
    }

    // T08: String("dark") produces {"kind":"string","value":"dark"}
    #[test]
    fn test_value_to_tagged_string() {
        let t = value_to_tagged(&Value::String("dark".into()));
        assert_eq!(t.kind, "string");
        assert_eq!(t.value, Some(json!("dark")));
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"string","value":"dark"}"#);
    }

    // T09: Bytes([1,2,3]) produces {"kind":"bytes","value":"AQID"}
    #[test]
    fn test_value_to_tagged_bytes() {
        let t = value_to_tagged(&Value::Bytes(vec![1, 2, 3]));
        assert_eq!(t.kind, "bytes");
        assert_eq!(t.value, Some(json!("AQID")));
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"bytes","value":"AQID"}"#);
    }

    // T10: Json({"a":1}) produces {"kind":"json","value":{"a":1}}
    #[test]
    fn test_value_to_tagged_json() {
        let t = value_to_tagged(&Value::Json(json!({"a": 1})));
        assert_eq!(t.kind, "json");
        assert_eq!(t.value, Some(json!({"a": 1})));
        let serialized = serde_json::to_string(&t).unwrap();
        assert_eq!(serialized, r#"{"kind":"json","value":{"a":1}}"#);
    }

    // T11: Round-trip for all seven variants
    fn roundtrip(v: Value) -> Value {
        let tagged = value_to_tagged(&v);
        tagged_to_value(&tagged).expect("round-trip should not fail")
    }

    #[test]
    fn test_roundtrip_null() {
        assert_eq!(roundtrip(Value::Null), Value::Null);
    }

    #[test]
    fn test_roundtrip_bool_true() {
        assert_eq!(roundtrip(Value::Bool(true)), Value::Bool(true));
    }

    #[test]
    fn test_roundtrip_bool_false() {
        assert_eq!(roundtrip(Value::Bool(false)), Value::Bool(false));
    }

    #[test]
    fn test_roundtrip_i64() {
        assert_eq!(roundtrip(Value::I64(i64::MAX)), Value::I64(i64::MAX));
        assert_eq!(roundtrip(Value::I64(i64::MIN)), Value::I64(i64::MIN));
        assert_eq!(roundtrip(Value::I64(0)), Value::I64(0));
    }

    #[test]
    fn test_roundtrip_f64() {
        assert_eq!(
            roundtrip(Value::F64(std::f64::consts::PI)),
            Value::F64(std::f64::consts::PI)
        );
        assert_eq!(roundtrip(Value::F64(0.0)), Value::F64(0.0));
    }

    #[test]
    fn test_roundtrip_string() {
        assert_eq!(
            roundtrip(Value::String("dark".into())),
            Value::String("dark".into())
        );
        assert_eq!(
            roundtrip(Value::String(String::new())),
            Value::String(String::new())
        );
    }

    #[test]
    fn test_roundtrip_bytes() {
        assert_eq!(
            roundtrip(Value::Bytes(vec![1, 2, 3])),
            Value::Bytes(vec![1, 2, 3])
        );
        assert_eq!(roundtrip(Value::Bytes(vec![])), Value::Bytes(vec![]));
    }

    #[test]
    fn test_roundtrip_json() {
        let j = json!({"a": 1, "b": [true, null, 1.5]});
        assert_eq!(roundtrip(Value::Json(j.clone())), Value::Json(j));
    }

    // T12: unknown kind string returns Err
    #[test]
    fn test_tagged_to_value_unknown_kind_returns_error() {
        let tagged = TaggedValue {
            kind: "bogus".to_owned(),
            value: None,
        };
        let result = tagged_to_value(&tagged);
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("unknown kind"), "error message: {msg}");
    }

    // Additional: wrong value field type for bool returns Err
    #[test]
    fn test_tagged_to_value_bool_wrong_type_returns_error() {
        let tagged = TaggedValue {
            kind: "bool".to_owned(),
            value: Some(json!("not-a-bool")),
        };
        assert!(tagged_to_value(&tagged).is_err());
    }

    // Additional: invalid base64 for bytes returns Err
    #[test]
    fn test_tagged_to_value_bytes_invalid_base64_returns_error() {
        let tagged = TaggedValue {
            kind: "bytes".to_owned(),
            value: Some(json!("!!!not-base64!!!")),
        };
        let result = tagged_to_value(&tagged);
        assert!(result.is_err());
    }

    // ── bank_error_to_response tests (T13–T16) ─────────────────────────────

    fn status_of(resp: Response) -> StatusCode {
        resp.status()
    }

    // T13: InvalidDomain → 400
    #[test]
    fn test_bank_error_invalid_domain_returns_400() {
        let resp = bank_error_to_response(BankError::InvalidDomain("".into()));
        assert_eq!(status_of(resp), StatusCode::BAD_REQUEST);
    }

    // T14: InvalidKey → 400
    #[test]
    fn test_bank_error_invalid_key_returns_400() {
        let resp = bank_error_to_response(BankError::InvalidKey("".into()));
        assert_eq!(status_of(resp), StatusCode::BAD_REQUEST);
    }

    // T15: ValueTooLarge → 413
    #[test]
    fn test_bank_error_value_too_large_returns_413() {
        let resp = bank_error_to_response(BankError::ValueTooLarge { size: 1024 });
        assert_eq!(status_of(resp), StatusCode::PAYLOAD_TOO_LARGE);
    }

    // T16: Sqlite → 500
    #[test]
    fn test_bank_error_sqlite_returns_500() {
        let resp = bank_error_to_response(BankError::Sqlite(rusqlite::Error::QueryReturnedNoRows));
        assert_eq!(status_of(resp), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // Additional: Serde → 400
    #[test]
    fn test_bank_error_serde_returns_400() {
        let serde_err: serde_json::Error =
            serde_json::from_str::<serde_json::Value>("bad json").unwrap_err();
        let resp = bank_error_to_response(BankError::Serde(serde_err));
        assert_eq!(status_of(resp), StatusCode::BAD_REQUEST);
    }

    // Additional: Conflict → 500
    #[test]
    fn test_bank_error_conflict_returns_500() {
        let resp = bank_error_to_response(BankError::Conflict);
        assert_eq!(status_of(resp), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
