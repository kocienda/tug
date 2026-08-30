//! `tugtool host changesets` — dump the live changeset aggregate.
//!
//! GETs `/api/changesets` off the running tugcast (the same fresh compose the
//! Changes view reads) and prints it. Plain output is one line per project with
//! its dirty/unattributed/changeset counts; `--json` emits the whole snapshot.
//! Ground truth for diagnosing a stale or empty Changes view against the actual
//! working-tree scan.

use crate::commands::tell::{Remedy, resolve_port};

pub fn run_changesets(
    port: Option<u16>,
    instance: Option<String>,
    json_output: bool,
) -> Result<i32, String> {
    let port = resolve_port(port, instance).map_err(|e| e.describe(Remedy::Flags))?;
    let url = format!("http://127.0.0.1:{}/api/changesets", port);

    let mut response = ureq::get(&url)
        .call()
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    let body: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("reading response failed: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&body).unwrap());
        return Ok(0);
    }

    let projects = body.get("projects").and_then(|p| p.as_array());
    match projects {
        Some(projects) if !projects.is_empty() => {
            for project in projects {
                // `ProjectChangeset` flattens its `ChangesetSnapshot`, so
                // `changesets`/`unattributed` sit inline on the project object,
                // not under a `snapshot` key.
                let dir = project
                    .get("project_dir")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unknown>");
                let no_repo = project
                    .get("no_repo")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let changesets = project
                    .get("changesets")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let unattributed = project
                    .get("unattributed")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let orphaned = project
                    .get("orphaned")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let repo = if no_repo { "no-repo" } else { "repo" };
                println!(
                    "{repo:<7}  changesets={:<3} unattributed={:<3} orphaned={:<3}  {dir}",
                    changesets.len(),
                    unattributed.len(),
                    orphaned.len()
                );
                // Each changeset's owner + liveness + its files — so a file
                // owned by a dead (non-live) session is visible here, the gap
                // that reads as "No changes" in a live card's Changes view.
                for changeset in &changesets {
                    let kind = changeset
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?");
                    let name = changeset
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .or_else(|| changeset.get("name").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    let live = changeset.get("live").and_then(|v| v.as_bool());
                    let live_tag = match live {
                        Some(true) => "live",
                        Some(false) => "dead",
                        None => "-",
                    };
                    let files = changeset
                        .get("files")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    println!(
                        "           [{kind} {name} {live_tag}] {} file(s)",
                        files.len()
                    );
                    for file in &files {
                        if let Some(path) = file.get("path").and_then(|v| v.as_str()) {
                            let status = file
                                .get("git_status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let origin = file.get("origin").and_then(|v| v.as_str()).unwrap_or("");
                            println!("             {status:<2} {path} ({origin})");
                        }
                    }
                }
                // Unattributed paths — nothing owns them at all.
                for file in &unattributed {
                    if let Some(path) = file.get("path").and_then(|v| v.as_str()) {
                        let status = file
                            .get("git_status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        println!("           unattributed {status:<2} {path}");
                    }
                }
                // Orphaned paths — owned by a dead session, claimable.
                for file in &orphaned {
                    if let Some(path) = file.get("path").and_then(|v| v.as_str()) {
                        let status = file
                            .get("git_status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let prior = file
                            .get("prior_owner_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        println!("           orphaned {status:<2} {path} (from {prior})");
                    }
                }
            }
        }
        _ => println!("no open projects"),
    }
    Ok(0)
}
