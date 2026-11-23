//! The request every per-checkout record verb parses: the docket family and
//! the idea family both name a checkout, carry a request id to echo, and read
//! their fields from one JSON object.

use std::path::Path;

/// The most ids one resolve, items one file, or keys one remove may carry.
pub(super) const MAX_ENTRIES: usize = 512;

/// A parsed request: its JSON, the checkout it names, and its id.
pub(super) struct Request {
    pub(super) value: serde_json::Value,
    pub(super) project_dir: String,
    pub(super) request_id: Option<String>,
}

impl Request {
    pub(super) fn parse(verb: &str, payload: &[u8]) -> Result<Request, String> {
        let value: serde_json::Value = serde_json::from_slice(payload)
            .map_err(|_| format!("{verb} payload is not valid JSON"))?;
        let project_dir = value
            .get("project_dir")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("{verb} payload is missing project_dir"))?
            .to_owned();
        let request_id = value
            .get("request_id")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        Ok(Request {
            value,
            project_dir,
            request_id,
        })
    }

    pub(super) fn repo(&self) -> &Path {
        Path::new(&self.project_dir)
    }

    pub(super) fn text(&self, verb: &str, key: &str) -> Result<String, String> {
        self.value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| format!("{verb} payload is missing {key}"))
    }

    /// An optional string field: absent, `null` or not a string is `None`.
    pub(super) fn opt_text(&self, key: &str) -> Option<String> {
        self.value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    }

    /// A whole-number field, refused when absent or not a `u32`.
    pub(super) fn number(&self, verb: &str, key: &str) -> Result<u32, String> {
        self.opt_number(key)
            .ok_or_else(|| format!("{verb} payload is missing {key}"))
    }

    /// An optional whole-number field.
    pub(super) fn opt_number(&self, key: &str) -> Option<u32> {
        self.value
            .get(key)
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok())
    }

    pub(super) fn strings(&self, verb: &str, key: &str) -> Result<Vec<String>, String> {
        Ok(self
            .value
            .get(key)
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("{verb} payload is missing {key}"))?
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .take(MAX_ENTRIES)
            .map(str::to_owned)
            .collect())
    }

    /// The `<verb>_ok` frame: `fields` with the action and the request id.
    pub(super) fn ok(&self, verb: &str, fields: serde_json::Value) -> serde_json::Value {
        let mut body = fields;
        body["action"] = serde_json::json!(format!("{verb}_ok"));
        body["request_id"] = serde_json::json!(self.request_id);
        body
    }
}
