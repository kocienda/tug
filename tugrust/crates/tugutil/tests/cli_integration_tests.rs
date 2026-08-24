//! CLI integration tests for tug commands

use std::path::PathBuf;
use std::process::Command;

/// Get the path to the tug binary
fn tug_binary() -> PathBuf {
    // Use the debug binary
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // repo root
    path.push("target");
    path.push("debug");
    path.push("tugutil");
    path
}

/// Create a temp directory with .tugtool initialized
fn setup_test_project() -> tempfile::TempDir {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    // Run tugutil init
    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init");

    assert!(
        output.status.success(),
        "tugutil init failed: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );

    temp
}

#[test]
fn test_init_creates_expected_files() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init");

    assert!(output.status.success(), "init should succeed");

    // Check files were created
    let tug_dir = temp.path().join(".tugtool");
    assert!(tug_dir.is_dir(), ".tugtool directory should exist");
    assert!(tug_dir.join("config.toml").is_file(), "config should exist");
    // The implementation-log fossil is no longer created.
    assert!(
        !tug_dir.join("tugplan-implementation-log.md").exists(),
        "implementation log should NOT be created"
    );
}

/// The front door onboards projects that are not Tugtool, so the config it
/// writes declares nothing Tugtool-shaped: no hydration commands, and the
/// ending's `verify`/`build` left undeclared as commented examples.
#[test]
fn test_init_default_config_is_project_neutral() {
    let temp = setup_test_project();
    let config_path = temp.path().join(".tugtool").join("config.toml");
    let text = std::fs::read_to_string(&config_path).expect("config should be readable");

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        assert!(
            !line.contains("bun") && !line.contains("tugdeck") && !line.contains("just "),
            "fresh init wrote a Tugtool-specific command: {line}"
        );
    }

    let config = tugutil_core::config::Config::load(&config_path).expect("default should parse");
    assert!(config.tugtool.dash.post_create.is_empty());
    assert!(config.tugtool.dash.verify.is_none());
    assert!(config.tugtool.dash.build.is_none());
}

#[test]
fn test_init_idempotent_on_existing_project() {
    let temp = setup_test_project();

    // Running init again should succeed (idempotent — creates missing files only)
    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init");

    assert!(
        output.status.success(),
        "init should succeed idempotently on existing project"
    );

    // Config should still exist; the fossil log is never created.
    let tug_dir = temp.path().join(".tugtool");
    assert!(tug_dir.join("config.toml").is_file());
    assert!(!tug_dir.join("tugplan-implementation-log.md").exists());
}

#[test]
fn test_init_creates_missing_files() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    // Create .tugtool/ with only a plan file (simulates worktree scenario)
    let tug_dir = temp.path().join(".tugtool");
    std::fs::create_dir_all(&tug_dir).expect("failed to create .tugtool");
    std::fs::write(tug_dir.join("tugplan-1.md"), "# My Plan\n").expect("failed to write plan");

    // Running init should create the missing infrastructure files
    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init");

    assert!(
        output.status.success(),
        "init should succeed and create missing files"
    );

    // The config should now exist; the fossil log is never created.
    assert!(tug_dir.join("config.toml").is_file());
    assert!(!tug_dir.join("tugplan-implementation-log.md").exists());

    // Original plan file should be untouched
    let content =
        std::fs::read_to_string(tug_dir.join("tugplan-1.md")).expect("failed to read plan");
    assert_eq!(content, "# My Plan\n");
}

#[test]
fn test_init_with_force_succeeds() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--force")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --force");

    assert!(output.status.success(), "init --force should succeed");
}

#[test]
fn test_json_output_init() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --json");

    assert!(output.status.success(), "init --json should succeed");
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON
    let json: serde_json::Value = serde_json::from_str(&stdout).expect("should be valid JSON");
    assert_eq!(json["schema_version"], "1");
    assert_eq!(json["command"], "init");
    assert_eq!(json["status"], "ok");
    assert!(json["data"]["files_created"].is_array());
}

#[test]
fn test_init_check_uninitialized_project() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--check")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --check");

    // Should return exit code 9 for uninitialized project
    assert_eq!(
        output.status.code(),
        Some(9),
        "init --check should return exit code 9 for uninitialized project"
    );
}

#[test]
fn test_init_check_initialized_project() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--check")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --check");

    // Should return exit code 0 for initialized project
    assert!(
        output.status.success(),
        "init --check should succeed on initialized project"
    );
    assert_eq!(output.status.code(), Some(0));
}

#[test]
fn test_init_check_json_uninitialized() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--check")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --check --json");

    assert_eq!(output.status.code(), Some(9));
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON
    let json: serde_json::Value = serde_json::from_str(&stdout).expect("should be valid JSON");
    assert_eq!(json["schema_version"], "1");
    assert_eq!(json["command"], "init");
    assert_eq!(json["status"], "ok");
    assert_eq!(json["data"]["initialized"], false);
    assert_eq!(json["data"]["path"], ".tugtool/");
}

#[test]
fn test_init_check_json_initialized() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--check")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --check --json");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON
    let json: serde_json::Value = serde_json::from_str(&stdout).expect("should be valid JSON");
    assert_eq!(json["schema_version"], "1");
    assert_eq!(json["command"], "init");
    assert_eq!(json["status"], "ok");
    assert_eq!(json["data"]["initialized"], true);
    assert_eq!(json["data"]["path"], ".tugtool/");
}

/// The seam has one reader, and it reports what the project declared.
#[test]
fn test_dash_config_reports_declarations() {
    let temp = setup_test_project();
    std::fs::write(
        temp.path().join(".tugtool").join("config.toml"),
        "[tugtool.dash]\npost_create = [\"npm install\"]\nverify = \"sh check.sh {base} {head}\"\nbuild = \"make app\"\n",
    )
    .expect("failed to write config");

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("config")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash config");

    assert!(output.status.success(), "dash config should succeed");
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid JSON");
    assert_eq!(json["command"], "dash config");
    assert_eq!(json["data"]["verify"], "sh check.sh {base} {head}");
    assert_eq!(json["data"]["build"], "make app");
    assert_eq!(json["data"]["post_create"][0], "npm install");
}

/// A project that never wrote a config is the all-undeclared state, not a
/// failure — the ending degrades rather than refusing to run.
#[test]
fn test_dash_config_missing_file_is_undeclared_not_an_error() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");
    std::fs::create_dir(temp.path().join(".tugtool")).expect("failed to create .tugtool");

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("config")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash config");

    assert!(
        output.status.success(),
        "a missing config file must exit 0: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid JSON");
    assert!(json["data"]["verify"].is_null());
    assert!(json["data"]["build"].is_null());
    assert!(json["data"]["docs"].is_null());
    assert_eq!(json["data"]["post_create"].as_array().unwrap().len(), 0);
}

/// The paperwork home is the project's to choose, and the verb reports the
/// choice as a path the caller can use directly.
#[test]
fn test_dash_docs_dir_reports_the_declaration() {
    let temp = setup_test_project();
    std::fs::write(
        temp.path().join(".tugtool").join("config.toml"),
        "[tugtool.dash]\ndocs = \"paperwork\"\n",
    )
    .expect("failed to write config");

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("docs-dir")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash docs-dir");

    assert!(output.status.success(), "docs-dir should succeed");
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid JSON");
    assert_eq!(json["command"], "dash docs-dir");
    assert_eq!(json["data"]["docs"], "paperwork");
    assert_eq!(json["data"]["declared"], true);
    assert!(
        json["data"]["path"]
            .as_str()
            .expect("a declared docs dir reports its path")
            .ends_with("paperwork")
    );
}

/// Undeclared is a state, not an error: the authoring skills read it to decide
/// whether to ask, so it has to be cheap and it has to exit 0.
#[test]
fn test_dash_docs_dir_undeclared_is_not_an_error() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("docs-dir")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash docs-dir");

    assert!(
        output.status.success(),
        "an undeclared project must exit 0: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid JSON");
    assert_eq!(json["data"]["declared"], false);
    assert!(json["data"]["docs"].is_null());
    assert!(json["data"]["path"].is_null());
}

/// `--set` is what makes asking once possible: the answer lands in the
/// project's own config, and the directory it names exists afterwards.
#[test]
fn test_dash_docs_dir_set_records_and_creates() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("docs-dir")
        .arg("--set")
        .arg("paperwork")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash docs-dir --set");

    assert!(
        output.status.success(),
        "recording a legal value should succeed: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid JSON");
    assert_eq!(json["data"]["docs"], "paperwork");
    assert_eq!(json["data"]["created_dir"], true);
    assert!(temp.path().join("paperwork").is_dir());

    // The reporter now answers from the file the setter wrote.
    let readback = Command::new(tug_binary())
        .arg("dash")
        .arg("docs-dir")
        .arg("--json")
        .current_dir(temp.path())
        .output()
        .expect("failed to re-run tugutil dash docs-dir");
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&readback.stdout)).expect("valid JSON");
    assert_eq!(json["data"]["docs"], "paperwork");
}

/// A value that cannot be joined onto the project root is refused before
/// anything is written.
#[test]
fn test_dash_docs_dir_set_refuses_an_escaping_path() {
    let temp = setup_test_project();

    let output = Command::new(tug_binary())
        .arg("dash")
        .arg("docs-dir")
        .arg("--set")
        .arg("../elsewhere")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil dash docs-dir --set");

    assert!(!output.status.success(), "an escaping path must be refused");
    // The template's own commented example mentions `docs`; what must not
    // appear is a live declaration.
    let config = std::fs::read_to_string(temp.path().join(".tugtool").join("config.toml"))
        .unwrap_or_default();
    assert!(
        !config
            .lines()
            .any(|l| l.trim_start().starts_with("docs") && l.contains('=')),
        "a refused value must not reach the config: {config}"
    );
}

#[test]
fn test_init_check_force_mutually_exclusive() {
    let temp = tempfile::tempdir().expect("failed to create temp dir");

    let output = Command::new(tug_binary())
        .arg("host")
        .arg("init")
        .arg("--check")
        .arg("--force")
        .current_dir(temp.path())
        .output()
        .expect("failed to run tugutil init --check --force");

    // Should fail due to mutually exclusive flags
    assert!(
        !output.status.success(),
        "init --check --force should fail due to mutually exclusive flags"
    );
}
