//! The running instance the lab drives: found by id in the instance
//! registry, spoken to over its tugcast's loopback session API — the three
//! doors the lab owns there: `spawn_headless`, `say`, `trash_headless`.

use std::path::{Path, PathBuf};

/// A live instance, by registry record.
pub struct Instance {
    pub id: String,
    pub port: u16,
}

impl Instance {
    /// The live instance registered under `id`, or why there is none.
    pub fn find(id: &str) -> Result<Self, String> {
        let instance = tugcore::registry::find_by_id(id)
            .map_err(|e| format!("reading the instance registry: {e}"))?
            .ok_or_else(|| {
                let live: Vec<String> = tugcore::registry::list_live()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|i| i.instance_id)
                    .collect();
                format!(
                    "no live instance named {id}; live: {}",
                    if live.is_empty() {
                        "none".to_string()
                    } else {
                        live.join(", ")
                    }
                )
            })?;
        Ok(Self {
            id: instance.instance_id,
            port: instance.tugcast_port,
        })
    }

    pub fn session_api(&self) -> SessionApi {
        SessionApi::new(self.port)
    }
}

/// What a sweep did, as the instance reported it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Swept {
    pub trashed: Vec<String>,
    pub kept: Vec<(String, String)>,
}

/// The session API of one tugcast, loopback only.
pub struct SessionApi {
    url: String,
    agent: ureq::Agent,
}

impl SessionApi {
    pub fn new(port: u16) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            url: format!("http://127.0.0.1:{port}/api/session"),
            agent,
        }
    }

    fn post(&self, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let response = self
            .agent
            .post(&self.url)
            .send_json(body)
            .map_err(|e| format!("cannot reach tugcast at {}: {e}", self.url))?;
        let status = response.status().as_u16();
        let value: serde_json::Value = response
            .into_body()
            .read_json()
            .map_err(|e| format!("unreadable answer from {}: {e}", self.url))?;
        if value["status"] == "ok" {
            Ok(value)
        } else {
            Err(format!(
                "{} answered {status}: {}",
                self.url,
                value["message"].as_str().unwrap_or("no message")
            ))
        }
    }

    /// Spawn a headless session under `owner` in `project_dir`, running with
    /// `permission_mode`. Answers the session id.
    pub fn spawn_headless(
        &self,
        owner: &str,
        project_dir: &Path,
        permission_mode: &str,
    ) -> Result<String, String> {
        let answer = self.post(serde_json::json!({
            "op": "spawn_headless",
            "owner": owner,
            "project_dir": project_dir.to_string_lossy(),
            "permission_mode": permission_mode,
        }))?;
        answer["session_id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "spawn_headless answered with no session_id".to_string())
    }

    /// Hand `session` a turn saying `text`, under the lab's origin.
    pub fn say(&self, session: &str, text: &str) -> Result<(), String> {
        self.post(serde_json::json!({
            "op": "say",
            "tug_session_id": session,
            "text": text,
        }))
        .map(|_| ())
    }

    /// Whether the instance's ledger knows `session` yet. A headless spawn
    /// answers before its bridge has written the row, and a bind posted in
    /// that gap is refused as `unknown_session`, so the lab asks this first.
    pub fn knows(&self, session: &str) -> Result<bool, String> {
        match self.post(serde_json::json!({
            "op": "resolve",
            "tug_session_id": session,
        })) {
            Ok(_) => Ok(true),
            Err(message) if message.contains("unknown_session") => Ok(false),
            Err(message) => Err(message),
        }
    }

    /// Trash every session `owner` spawned.
    pub fn trash_headless(&self, owner: &str) -> Result<Swept, String> {
        let answer = self.post(serde_json::json!({
            "op": "trash_headless",
            "owner": owner,
        }))?;
        let trashed = answer["trashed"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let kept = answer["kept"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|v| {
                        (
                            v["session_id"].as_str().unwrap_or("").to_string(),
                            v["reason"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Swept { trashed, kept })
    }
}

/// The `tugtool` the lab drives: the one built beside this binary, never the
/// app's on `PATH`, so a change on the worktree is the one exercised.
pub fn tugtool_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "the lab binary has no directory".to_string())?;
    let tugtool = dir.join("tugtool");
    if tugtool.is_file() {
        Ok(tugtool)
    } else {
        Err(format!(
            "no tugtool beside {}; build it with `cargo build -p tugtool`",
            exe.display()
        ))
    }
}
