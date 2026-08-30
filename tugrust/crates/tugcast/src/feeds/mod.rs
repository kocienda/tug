//! Feed registry and orchestration for tugcast
//!
//! This module contains the implementations of different feed types
//! (terminal, filesystem, git, etc.) and manages their lifecycle.

pub mod activity;
pub mod agent_bridge;
pub mod agent_supervisor;
pub mod attribution;
pub mod base_motion;
pub mod changeset;
pub mod changeset_all;
pub mod claude_auth;
pub mod claude_usage;
pub mod code;
pub mod dash_arc;
pub mod dash_arc_runner;
pub mod deck_seatings;
pub mod defaults;
pub mod draft_engine;
pub mod facts_library;
pub mod file_watcher;
pub mod filesystem;
pub mod filetree;
pub mod fuzzy_scorer;
pub mod git;
pub mod git_watch;
pub mod join_board;
pub mod join_occupancy;
pub mod join_pilot;
pub mod join_resolve;
pub mod join_resolver;
pub mod jots;
pub mod observer;
pub mod observer_wake;
pub mod operator;
pub mod operator_ask;
pub mod overview_agent;
pub mod overview_replay;
pub mod payload_inspector;
pub mod pulse;
pub mod refs;
pub mod repo_files;
pub mod secret_filter;
pub mod session_metadata;
pub mod session_scoped;
pub mod session_synopsis;
pub mod shell;
pub mod shell_words;
pub mod stats;
pub mod terminal;
pub mod text_ref;
pub mod tripwire;
pub mod tripwire_dossier;
pub mod tripwire_session;
pub mod tripwire_tree;
pub mod walk;
pub mod workspace_registry;
