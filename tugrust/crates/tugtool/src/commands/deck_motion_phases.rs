//! `tugtool deck motion settle --frame-phases` — every frame of a drive,
//! priced by phase, with the forcing reader named.
//!
//! `--sample` (`deck_motion_sample.rs`) reads `/usr/bin/sample`, whose report
//! is one call graph per run with no time on any sample: it prices a drive,
//! never a frame. This arm records the deck's WebKit WebContent process with
//! Instruments' Time Profiler (`xctrace`) at its 1 ms interval, whose samples
//! carry their own time, and files each sample under the frame of the drive it
//! fell in and the phase it was in.
//!
//! **The recipe.**
//!
//! ```text
//! xctrace record --template "Time Profiler" --attach <WebContent pid> \
//!     --time-limit <s>s --output <dir>/webcontent-<pid>.trace
//! xctrace export --input <trace> --toc
//! xctrace export --input <trace> --xpath \
//!     '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'
//! ```
//!
//! The table of contents carries the run's `<start-date>` (ISO 8601, to the
//! millisecond, with its offset). The table is one `<row>` per sample:
//! `<sample-time>` in nanoseconds from the run's start, `<thread>` (whose
//! `fmt` begins `Main Thread` for the main thread), and a `<backtrace>` of
//! `<frame name=…>` elements, leaf first. Any element after its first
//! occurrence may be written as `<tag ref="id"/>`, naming an earlier element's
//! `id`; the parser resolves both. WebCore, WebKit and JavaScriptCore frames
//! carry their symbol names; JIT'd JavaScript frames do not — they are bare
//! addresses (`0x1142c0e01`) — so the trace alone cannot name a JavaScript
//! caller. The caller comes from the forced-layout chain probe instead: with
//! `--chains` the read drives are armed with stacks, and a forced sample that
//! falls inside a chain's paying read is named by that chain's API and site.
//! Without `--chains` a forced sample names the engine's forcing entry (the
//! DOM getter it entered through) and no caller.
//!
//! **How a sample is filed.** By time: the drive's `t0Epoch` (the page's
//! `performance.timeOrigin + t0`, corrected by `clockDriftMs` when the page's
//! monotonic clock has drifted from the wall clock across a sleep) puts the
//! drive on the trace's clock, and each frame stamp the pump recorded becomes a
//! boundary. The `set-up` row is the drive to the first frame; each later row
//! runs from one frame stamp to the next, so it holds the rendering update
//! that stamp opened and whatever ran after it. By phase: the deepest frame on
//! the sample's stack that names a concrete phase — style, layout,
//! compositing, layer commit, paint, gc — wins, the way `deck_motion_sample`
//! files a sample; a sample with none is script when a script frame is on its
//! stack, rendering update when it is under the engine's update, and `other`
//! otherwise. A style, layout or compositing sample is **forced** when a script
//! frame is its ancestor: the deck's own script asked for it.
//!
//! **`boundary`.** The trace's start date is to the millisecond, so a sample
//! within 1 ms of a frame stamp may belong to the frame on the other side. It
//! is filed where its time puts it and counted under its row's `boundary`, so
//! an attribution that leans on such samples says so.
//!
//! **It is an instrument.** Every sample stops WebContent to walk its stack,
//! so the frames this arm reads are perturbed by the reading; it refuses
//! `--quiet-instruments` (the honesty rule) and `--sample` (two samplers on one
//! process double the perturbation). Take frame timings from a quiet run and
//! the attribution from this one.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// The `xctrace export` XPath of the Time Profiler's sample table.
pub const TIME_PROFILE_XPATH: &str =
    r#"/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]"#;

/// A sample within this many ms of a frame stamp is counted as `boundary`.
const BOUNDARY_MS: f64 = 1.0;

/// How long after `xctrace` says it is recording before the first drive.
const RECORDER_SETTLE_MS: u64 = 500;

/// The phases a script frame above them makes forced.
const FORCEABLE: [&str; 3] = ["style", "layout", "compositing"];

/// The concrete phases, by needle. The deepest frame on a stack matching one
/// of these files the sample.
const PHASES: &[(&str, &[&str])] = &[
    (
        "style",
        &[
            "Document::resolveStyle",
            "Style::TreeResolver::resolve",
            "Document::updateStyleIfNeeded",
            "Style::Scope::flushPendingUpdate",
            "RenderTreeUpdater::commit",
            "updateStyleIfNeededForProperty",
            "Style::Extractor::computeStyle",
            "Style::Resolver",
        ],
    ),
    (
        "layout",
        &[
            "Document::updateLayout(",
            "LocalFrameViewLayoutContext::layout",
            "LayoutContext::layout(",
            "RenderBlockFlow::layoutBlock",
            "RenderGrid::layoutBlock",
            "RenderFlexibleBox::layoutBlock",
            "RenderLayer::updateLayerPositions",
            "LayoutIntegration::",
        ],
    ),
    (
        "compositing",
        &[
            "RenderLayerCompositor::updateCompositingLayers",
            "computeCompositingRequirements",
            "updateBackingAndHierarchy",
        ],
    ),
    (
        "layer commit",
        &[
            "GraphicsLayerCA::commitLayerChanges",
            "GraphicsLayerCA::recursiveCommitChanges",
            "RenderLayerCompositor::flushPendingLayerChanges",
            "flushCompositingState",
            "RemoteLayerTreeDrawingArea::flushLayers",
            "RemoteLayerTreeTransaction",
            "PlatformCALayerRemote",
        ],
    ),
    (
        "paint",
        &[
            "RenderLayer::paint",
            "RenderLayerBacking::paintIntoLayer",
            "GraphicsLayerCA::paint",
            "platformCALayerPaintContents",
        ],
    ),
    (
        "gc",
        &[
            "JSC::Heap::",
            "JSC::MarkedSpace",
            "JSC::SlotVisitor",
            "MarkingConstraint",
        ],
    ),
];

/// A frame that means the deck's script is running.
const SCRIPT: &[&str] = &[
    "vmEntryToJavaScript",
    "JSC::Interpreter::execute",
    "JSC::profiledCall",
    "JSC::call(",
    "JSC::callMicrotask",
    "JSC::MicrotaskQueue::",
    "MicrotaskQueue::performMicrotaskCheckpoint",
    "JSEventListener::handleEvent",
    "JSRequestAnimationFrameCallback",
    "ScheduledAction::execute",
    "JSCallbackData",
    "globalFuncEval",
];

/// A frame that means the engine's own rendering update.
const RENDERING_UPDATE: &[&str] = &[
    "Page::updateRendering",
    "Page::doAfterUpdateRendering",
    "RemoteLayerTreeDrawingArea::updateRendering",
    "RenderingUpdateScheduler",
    "Document::updateIntersectionObservations",
    "ResizeObserver",
];

/// The DOM entries that force style or layout, by the API a script calls.
const FORCERS: &[(&str, &[&str])] = &[
    ("clientHeight", &["Element::clientHeight", "_clientHeight"]),
    ("clientWidth", &["Element::clientWidth", "_clientWidth"]),
    ("scrollTop", &["Element::scrollTop", "_scrollTop"]),
    ("scrollTop=", &["Element::setScrollTop", "_setScrollTop"]),
    ("scrollHeight", &["Element::scrollHeight", "_scrollHeight"]),
    ("scrollWidth", &["Element::scrollWidth", "_scrollWidth"]),
    ("scrollLeft", &["Element::scrollLeft", "_scrollLeft"]),
    ("offsetHeight", &["Element::offsetHeight", "_offsetHeight"]),
    ("offsetWidth", &["Element::offsetWidth", "_offsetWidth"]),
    ("offsetTop", &["Element::offsetTop", "_offsetTop"]),
    (
        "getBoundingClientRect",
        &["Element::getBoundingClientRect", "getBoundingClientRect"],
    ),
    (
        "getClientRects",
        &["Element::getClientRects", "getClientRects"],
    ),
    ("getAnimations", &["::getAnimations"]),
    ("commitStyles", &["::commitStyles"]),
    (
        "getComputedStyle",
        &["ComputedStyleDeclaration", "ComputedStyleExtractor"],
    ),
    ("focus", &["Element::focus"]),
    ("scrollIntoView", &["::scrollIntoView"]),
    ("innerText", &["::innerText"]),
];

fn matches(name: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| name.contains(n))
}

fn is_script(name: &str) -> bool {
    matches(name, SCRIPT)
}

/// A frame the trace could not name: JIT'd JavaScript.
fn is_unnamed(name: &str) -> bool {
    name.starts_with("0x")
}

/// A symbol without its argument list, for printing.
fn short(name: &str) -> String {
    let end = name.find('(').unwrap_or(name.len());
    name[..end].trim().to_string()
}

/// One sample on the main thread: its wall-clock time and its stack, leaf
/// first.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub epoch_ms: f64,
    pub stack: Vec<String>,
}

/// How one sample was filed.
#[derive(Debug, Clone, PartialEq)]
pub struct Filed {
    pub phase: &'static str,
    pub forced: bool,
    /// For a forced sample, the API it entered through — a [`FORCERS`] name,
    /// or the engine's forcing entry symbol when none matched.
    pub entry: Option<String>,
}

/// File one stack, leaf first.
pub fn classify(stack: &[String]) -> Filed {
    let concrete = stack.iter().enumerate().find_map(|(i, name)| {
        PHASES
            .iter()
            .find(|(_, needles)| matches(name, needles))
            .map(|(phase, _)| (i, *phase))
    });
    let Some((at, phase)) = concrete else {
        let phase = if stack.iter().any(|n| is_script(n)) {
            "script"
        } else if stack.iter().any(|n| matches(n, RENDERING_UPDATE)) {
            "rendering update"
        } else {
            "other"
        };
        return Filed {
            phase,
            forced: false,
            entry: None,
        };
    };
    let script_at = stack[at + 1..]
        .iter()
        .position(|n| is_script(n) || is_unnamed(n))
        .map(|i| i + at + 1);
    let forced = FORCEABLE.contains(&phase) && stack[at + 1..].iter().any(|n| is_script(n));
    let entry = forced.then(|| {
        let span = &stack[at..script_at.unwrap_or(stack.len())];
        FORCERS
            .iter()
            .find(|(_, needles)| span.iter().any(|n| matches(n, needles)))
            .map(|(api, _)| api.to_string())
            // The outermost named frame before script: where the engine was
            // entered from.
            .or_else(|| span.last().map(|n| short(n)))
            .unwrap_or_else(|| "—".to_string())
    });
    Filed {
        phase,
        forced,
        entry,
    }
}

/// One forced-layout chain's paying read, as the settle page reports it on
/// the drive's clock (`landChains`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ChainSpan {
    pub t: f64,
    pub ms: f64,
    pub site: String,
    /// The getter the probe wrapped — `clientHeight`, … Empty on a page that
    /// predates it.
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct PhaseCount {
    /// Samples the engine ran on its own schedule.
    pub engine: u64,
    /// Samples the deck's script forced (style, layout and compositing only).
    pub forced: u64,
}

/// What forced a frame's forced samples, and who called it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Forcer {
    pub api: String,
    /// The JavaScript caller: the chain probe's site for a sample inside a
    /// chain's paying read; `None` without one, since the trace names no
    /// JavaScript frame.
    #[serde(rename = "fn")]
    pub caller: Option<String>,
    pub samples: u64,
}

/// One row: the set-up, or one frame of the pump.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FrameReading {
    /// `set-up`, or the frame's 1-based index.
    pub frame: String,
    /// The row's start, relative to the drive.
    pub t: f64,
    pub len: f64,
    pub samples: u64,
    /// Samples within [`BOUNDARY_MS`] of either edge.
    pub boundary: u64,
    pub phases: BTreeMap<&'static str, PhaseCount>,
    /// Largest first.
    pub forcers: Vec<Forcer>,
}

/// One drive's frames, by phase.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FramePhases {
    /// The correction applied to the page's clock: its drift from the wall
    /// clock at the drive, when that exceeded the wall clock's 1 ms grain.
    pub skew_ms: f64,
    /// Every row's `boundary`, summed.
    pub boundary: u64,
    /// Main-thread samples from the drive to its last frame.
    pub samples: u64,
    pub frames: Vec<FrameReading>,
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// File every sample under the frame of the drive it fell in. `frames` are
/// the pump's stamps relative to the drive; `t0_epoch_ms` is the drive on the
/// trace's clock; `chains`, with `--chains`, name the caller of a forced
/// sample inside a chain's paying read. Samples before the drive or after the
/// last stamp are not the drive's and are dropped. Pure, so the fixture tests
/// pin it.
pub fn file_by_frame(
    samples: &[Sample],
    frames: &[f64],
    t0_epoch_ms: f64,
    chains: Option<&[ChainSpan]>,
) -> FramePhases {
    // Row edges: the drive, then every stamp.
    let mut edges = vec![0.0];
    edges.extend(frames.iter().copied().filter(|t| *t > 0.0));
    let mut rows: Vec<FrameReading> = edges
        .windows(2)
        .enumerate()
        .map(|(i, pair)| FrameReading {
            frame: if i == 0 {
                "set-up".to_string()
            } else {
                i.to_string()
            },
            t: round1(pair[0]),
            len: round1(pair[1] - pair[0]),
            samples: 0,
            boundary: 0,
            phases: BTreeMap::new(),
            forcers: Vec::new(),
        })
        .collect();
    let mut forcers: Vec<HashMap<(String, Option<String>), u64>> = vec![HashMap::new(); rows.len()];
    let end = edges.last().copied().unwrap_or(0.0);
    for sample in samples {
        let t = sample.epoch_ms - t0_epoch_ms;
        if t < 0.0 || t >= end {
            continue;
        }
        // The row whose start is the last edge at or before `t`.
        let row = edges.partition_point(|e| *e <= t) - 1;
        let r = &mut rows[row];
        r.samples += 1;
        if t - edges[row] < BOUNDARY_MS || edges[row + 1] - t < BOUNDARY_MS {
            r.boundary += 1;
        }
        let filed = classify(&sample.stack);
        let count = r.phases.entry(filed.phase).or_default();
        if filed.forced {
            count.forced += 1;
            let chain = chains
                .into_iter()
                .flatten()
                .find(|c| t >= c.t - 0.5 && t <= c.t + c.ms + 0.5);
            let key = match chain {
                Some(c) if !c.name.is_empty() => (c.name.clone(), Some(c.site.clone())),
                Some(c) => (
                    filed.entry.clone().unwrap_or_default(),
                    Some(c.site.clone()),
                ),
                None => (filed.entry.clone().unwrap_or_default(), None),
            };
            *forcers[row].entry(key).or_default() += 1;
        } else {
            count.engine += 1;
        }
    }
    for (r, map) in rows.iter_mut().zip(forcers) {
        let mut list: Vec<Forcer> = map
            .into_iter()
            .map(|((api, caller), samples)| Forcer {
                api,
                caller,
                samples,
            })
            .collect();
        list.sort_by(|a, b| {
            b.samples
                .cmp(&a.samples)
                .then_with(|| a.api.cmp(&b.api))
                .then_with(|| a.caller.cmp(&b.caller))
        });
        r.forcers = list;
    }
    FramePhases {
        skew_ms: 0.0,
        boundary: rows.iter().map(|r| r.boundary).sum(),
        samples: rows.iter().map(|r| r.samples).sum(),
        frames: rows,
    }
}

/// A rest window, priced by phase: `deck motion rest --frame-phases`.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct RestPhases {
    /// The chain's window, from its start to its last fire.
    pub window_ms: f64,
    /// Main-thread samples in the window: at 1 ms each, the busy time.
    pub samples: u64,
    pub boundary: u64,
    /// Every row's phases, summed.
    pub phases: BTreeMap<&'static str, PhaseCount>,
    /// Every row's forcers, summed; largest first.
    pub forcers: Vec<Forcer>,
    /// The rows the rest count reads as updates: a gap past the chain's
    /// median by more than the floor, each with its own phases.
    pub stalls: Vec<FrameReading>,
    /// The WebContent process's resident size at the reading, in KiB.
    pub rss_kb: Option<u64>,
}

/// File a rest window's samples by the rest chain's own stamps (each fire's
/// time from the window's start; `t0_epoch_ms` is that start on the trace's
/// clock), sum the rows, and keep the stall rows apart: the gaps the rest
/// count reads as updates, by the same rule (`restFromGaps`: past the median
/// by more than `floor_ms`). Pure, so the fixture tests pin it.
pub fn rest_phases(
    samples: &[Sample],
    stamps: &[f64],
    t0_epoch_ms: f64,
    floor_ms: f64,
) -> RestPhases {
    let fp = file_by_frame(samples, stamps, t0_epoch_ms, None);
    let mut lens: Vec<f64> = fp.frames.iter().map(|r| r.len).collect();
    lens.sort_by(|a, b| a.total_cmp(b));
    let median = lens.get(lens.len() / 2).copied().unwrap_or(0.0);
    let mut phases: BTreeMap<&'static str, PhaseCount> = BTreeMap::new();
    let mut forcers: HashMap<(String, Option<String>), u64> = HashMap::new();
    for r in &fp.frames {
        for (phase, count) in &r.phases {
            let sum = phases.entry(phase).or_default();
            sum.engine += count.engine;
            sum.forced += count.forced;
        }
        for f in &r.forcers {
            *forcers
                .entry((f.api.clone(), f.caller.clone()))
                .or_default() += f.samples;
        }
    }
    let mut forcers: Vec<Forcer> = forcers
        .into_iter()
        .map(|((api, caller), samples)| Forcer {
            api,
            caller,
            samples,
        })
        .collect();
    forcers.sort_by(|a, b| b.samples.cmp(&a.samples).then_with(|| a.api.cmp(&b.api)));
    RestPhases {
        window_ms: round1(stamps.last().copied().unwrap_or(0.0)),
        samples: fp.samples,
        boundary: fp.boundary,
        phases,
        forcers,
        stalls: fp
            .frames
            .into_iter()
            .filter(|r| r.len > median + floor_ms)
            .collect(),
        rss_kb: None,
    }
}

/// The WebContent process's resident size, in KiB.
pub fn resident_kb(pid: i32) -> Option<u64> {
    Command::new("/bin/ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
}

/// The drive on the trace's clock, and the correction applied: the page's
/// `performance.timeOrigin + t0`, less its drift from `Date.now()` when the
/// drift exceeds `Date.now()`'s own 1 ms grain.
pub fn drive_epoch(t0_epoch_ms: f64, clock_drift_ms: f64) -> (f64, f64) {
    if clock_drift_ms.abs() >= 1.0 {
        (t0_epoch_ms - clock_drift_ms, -clock_drift_ms)
    } else {
        (t0_epoch_ms, 0.0)
    }
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

/// The run's start on the wall clock, in ms since the epoch, from the
/// table of contents' `<start-date>`.
pub fn trace_start_epoch_ms(toc: &str) -> Result<f64, String> {
    let doc = roxmltree::Document::parse(toc)
        .map_err(|e| format!("the trace's table of contents did not parse: {e}"))?;
    let text = doc
        .descendants()
        .find(|n| n.has_tag_name("start-date"))
        .and_then(|n| n.text())
        .ok_or("the trace's table of contents has no <start-date>")?;
    let date = chrono::DateTime::parse_from_rfc3339(text.trim())
        .map_err(|e| format!("the trace's <start-date> {text:?} did not parse: {e}"))?;
    Ok(date.timestamp_micros() as f64 / 1000.0)
}

/// The main thread's samples from an exported `time-profile` table, on the
/// wall clock. An export with no `sample-time` column cannot be filed by
/// frame and is refused by name.
pub fn parse_time_profile(xml: &str, start_epoch_ms: f64) -> Result<Vec<Sample>, String> {
    let doc = roxmltree::Document::parse(xml)
        .map_err(|e| format!("the time-profile export did not parse: {e}"))?;
    let schema = doc
        .descendants()
        .find(|n| n.has_tag_name("schema"))
        .ok_or("the export has no <schema>; is it the time-profile table?")?;
    let has_time = schema
        .descendants()
        .any(|n| n.has_tag_name("engineering-type") && n.text() == Some("sample-time"));
    if !has_time {
        return Err(
            "the time-profile export has no `sample-time` column, so its samples cannot be filed by frame"
                .to_string(),
        );
    }

    let mut times: HashMap<&str, f64> = HashMap::new();
    let mut threads: HashMap<&str, bool> = HashMap::new();
    let mut names: HashMap<&str, String> = HashMap::new();
    let mut stacks: HashMap<&str, Vec<String>> = HashMap::new();
    let mut out = Vec::new();
    for row in doc.descendants().filter(|n| n.has_tag_name("row")) {
        let mut t = None;
        let mut main = None;
        let mut stack = None;
        for cell in row.children().filter(|n| n.is_element()) {
            let id = cell.attribute("id");
            let reference = cell.attribute("ref");
            match cell.tag_name().name() {
                "sample-time" => {
                    t = match reference {
                        Some(r) => times.get(r).copied(),
                        None => {
                            let ns: f64 =
                                cell.text().unwrap_or("").trim().parse().map_err(|_| {
                                    format!("a <sample-time> did not parse: {:?}", cell.text())
                                })?;
                            if let Some(id) = id {
                                times.insert(id, ns);
                            }
                            Some(ns)
                        }
                    };
                }
                "thread" => {
                    main = match reference {
                        Some(r) => threads.get(r).copied(),
                        None => {
                            let is_main = cell
                                .attribute("fmt")
                                .is_some_and(|f| f.starts_with("Main Thread"));
                            if let Some(id) = id {
                                threads.insert(id, is_main);
                            }
                            Some(is_main)
                        }
                    };
                }
                "backtrace" => {
                    stack = match reference {
                        Some(r) => stacks.get(r).cloned(),
                        None => {
                            let mut frames = Vec::new();
                            for frame in cell.children().filter(|n| n.has_tag_name("frame")) {
                                let name = match frame.attribute("ref") {
                                    Some(r) => names.get(r).cloned().unwrap_or_default(),
                                    None => {
                                        let name =
                                            frame.attribute("name").unwrap_or("").to_string();
                                        if let Some(id) = frame.attribute("id") {
                                            names.insert(id, name.clone());
                                        }
                                        name
                                    }
                                };
                                frames.push(name);
                            }
                            if let Some(id) = id {
                                stacks.insert(id, frames.clone());
                            }
                            Some(frames)
                        }
                    };
                }
                _ => {}
            }
        }
        if let (Some(ns), Some(true), Some(stack)) = (t, main, stack) {
            out.push(Sample {
                epoch_ms: start_epoch_ms + ns / 1_000_000.0,
                stack,
            });
        }
    }
    out.sort_by(|a, b| a.epoch_ms.total_cmp(&b.epoch_ms));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// `xctrace`'s path, or `None` without Xcode's Instruments.
pub fn xctrace() -> Option<PathBuf> {
    let out = Command::new("/usr/bin/xcrun")
        .args(["--find", "xctrace"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.exists().then_some(path)
}

/// The deck's WebContent process behind a tugcast port: of the WebContent
/// processes the Tug host is responsible for, the largest by resident size,
/// which is the deck's page rather than a helper view's.
pub fn deck_web_content(port: u16) -> Result<i32, String> {
    let pids: Vec<i32> = crate::commands::deck_motion_sample::targets(port)?
        .into_iter()
        .filter(|(label, _)| label == "WebContent")
        .map(|(_, pid)| pid)
        .collect();
    let rss = |pid: i32| -> u64 { resident_kb(pid).unwrap_or(0) };
    pids.into_iter()
        .max_by_key(|pid| rss(*pid))
        .ok_or_else(|| "found no WebContent process for the deck".to_string())
}

/// A running `xctrace record`.
pub struct Recorder {
    xctrace: PathBuf,
    child: Child,
    trace: PathBuf,
}

/// Start recording `pid` for at most `seconds`, returning once `xctrace`
/// says it is recording.
pub fn record(xctrace: &Path, pid: i32, seconds: u32) -> Result<Recorder, String> {
    let dir = std::env::temp_dir().join(format!("tug-frame-phases-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let trace = dir.join(format!("webcontent-{pid}.trace"));
    if trace.exists() {
        std::fs::remove_dir_all(&trace).map_err(|e| format!("{}: {e}", trace.display()))?;
    }
    let mut child = Command::new(xctrace)
        .args(["record", "--template", "Time Profiler", "--attach"])
        .arg(pid.to_string())
        .arg("--time-limit")
        .arg(format!("{seconds}s"))
        .arg("--output")
        .arg(&trace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("xctrace failed to start: {e}"))?;
    let stdout = child.stdout.take().ok_or("xctrace has no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut said = Vec::new();
    let started = loop {
        match lines.next() {
            Some(Ok(line)) => {
                let go = line.contains("Ctrl-C to stop");
                said.push(line);
                if go {
                    break true;
                }
            }
            _ => break false,
        }
    };
    if !started {
        let _ = child.wait();
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        return Err(format!(
            "xctrace did not start recording pid {pid}: {} {}",
            said.join(" "),
            err.trim()
        ));
    }
    // Keep the pipe drained so xctrace never blocks on a full one.
    std::thread::spawn(move || for _ in lines {});
    std::thread::sleep(std::time::Duration::from_millis(RECORDER_SETTLE_MS));
    Ok(Recorder {
        xctrace: xctrace.to_path_buf(),
        child,
        trace,
    })
}

impl Recorder {
    /// Stop the recording (as Ctrl-C does), wait for the trace to be saved,
    /// and export it: the run's start on the wall clock and the main thread's
    /// samples.
    pub fn finish(mut self) -> Result<(PathBuf, Vec<Sample>), String> {
        // SAFETY: a signal to our own child; an exited pid is a no-op error.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGINT);
        }
        let status = self
            .child
            .wait()
            .map_err(|e| format!("xctrace did not finish: {e}"))?;
        if !self.trace.exists() {
            let mut err = String::new();
            if let Some(mut stderr) = self.child.stderr.take() {
                let _ = stderr.read_to_string(&mut err);
            }
            return Err(format!(
                "xctrace ({status}) saved no trace at {}: {}",
                self.trace.display(),
                err.trim()
            ));
        }
        let export = |extra: &[&str]| -> Result<String, String> {
            let out = Command::new(&self.xctrace)
                .arg("export")
                .arg("--input")
                .arg(&self.trace)
                .args(extra)
                .output()
                .map_err(|e| format!("xctrace export failed to start: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "xctrace export {} failed: {}",
                    extra.join(" "),
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        };
        let start = trace_start_epoch_ms(&export(&["--toc"])?)?;
        let samples = parse_time_profile(&export(&["--xpath", TIME_PROFILE_XPATH])?, start)?;
        Ok((self.trace.clone(), samples))
    }
}

/// A recorder dropped before [`Recorder::finish`] — a run that returned early
/// on a shut eval door or a page error — stops its `xctrace` rather than
/// leaving it attached: the Time Profiler stops the deck's WebContent every
/// 1 ms, and it would go on doing so until its time limit, minutes later.
impl Drop for Recorder {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            // SAFETY: a signal to our own child, which has not exited.
            unsafe {
                libc::kill(self.child.id() as libc::pid_t, libc::SIGINT);
            }
            let _ = self.child.wait();
        }
    }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/// The table, as the human output prints it beneath a reading. Rows with no
/// sample are left out; the JSON keeps them.
pub fn print_frame_phases(fp: &FramePhases) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "   frame phases (xctrace 1 ms, WebContent main thread; skew assumed {:+.1} ms; {} sample(s), {} boundary)",
        fp.skew_ms, fp.samples, fp.boundary
    );
    let _ = writeln!(
        out,
        "     {:<7} {:>7} {:>6}  {:>7} {:>7} {:>7} {:>6} {:>5} {:>6} {:>4} {:>6} {:>5}   (style/layout/compos: engine/forced)",
        "frame",
        "t(ms)",
        "len",
        "style",
        "layout",
        "compos",
        "commit",
        "paint",
        "script",
        "gc",
        "update",
        "other"
    );
    for r in fp.frames.iter().filter(|r| r.samples > 0) {
        let get = |p: &str| r.phases.get(p).copied().unwrap_or_default();
        let split = |p: &str| {
            let c = get(p);
            if c.engine + c.forced == 0 {
                "—".to_string()
            } else {
                format!("{}/{}", c.engine, c.forced)
            }
        };
        let plain = |p: &str| {
            let c = get(p);
            match c.engine + c.forced {
                0 => "—".to_string(),
                n => n.to_string(),
            }
        };
        let _ = writeln!(
            out,
            "     {:<7} {:>7.1} {:>6.1}  {:>7} {:>7} {:>7} {:>6} {:>5} {:>6} {:>4} {:>6} {:>5}{}",
            r.frame,
            r.t,
            r.len,
            split("style"),
            split("layout"),
            split("compositing"),
            plain("layer commit"),
            plain("paint"),
            plain("script"),
            plain("gc"),
            plain("rendering update"),
            plain("other"),
            if r.boundary > 0 {
                format!("  ({} boundary)", r.boundary)
            } else {
                String::new()
            }
        );
        if !r.forcers.is_empty() {
            let named: Vec<String> = r
                .forcers
                .iter()
                .map(|f| match &f.caller {
                    Some(caller) => format!("{} ({}) {caller}", f.api, f.samples),
                    None => format!("{} ({})", f.api, f.samples),
                })
                .collect();
            let _ = writeln!(out, "       forced by: {}", named.join("; "));
        }
    }
    out
}

/// The rest window's table, as `deck motion rest --frame-phases` prints it
/// beneath the rest line: the window's phases summed, what forced, the
/// GC's share of the busy samples, and the stall rows in the frame table's
/// own form.
pub fn print_rest_phases(rp: &RestPhases) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let get = |p: &str| rp.phases.get(p).copied().unwrap_or_default();
    let split = |p: &str| {
        let c = get(p);
        format!("{}/{}", c.engine, c.forced)
    };
    let plain = |p: &str| {
        let c = get(p);
        c.engine + c.forced
    };
    let gc = plain("gc");
    let rss = rp
        .rss_kb
        .map(|kb| format!("; WebContent RSS {:.0} MB", kb as f64 / 1024.0))
        .unwrap_or_default();
    let _ = writeln!(
        out,
        "rest phases (xctrace 1 ms, WebContent main thread): {} busy sample(s) over {:.0} ms, {} boundary{rss}",
        rp.samples, rp.window_ms, rp.boundary
    );
    let _ = writeln!(
        out,
        "   style {}  layout {}  compositing {}  (engine/forced)",
        split("style"),
        split("layout"),
        split("compositing")
    );
    let _ = writeln!(
        out,
        "   layer commit {}  paint {}  script {}  rendering update {}  other {}",
        plain("layer commit"),
        plain("paint"),
        plain("script"),
        plain("rendering update"),
        plain("other")
    );
    let share = if rp.samples == 0 {
        0.0
    } else {
        100.0 * gc as f64 / rp.samples as f64
    };
    let _ = writeln!(out, "   gc {gc} ({share:.1}% of busy)");
    if !rp.forcers.is_empty() {
        let named: Vec<String> = rp
            .forcers
            .iter()
            .map(|f| match &f.caller {
                Some(caller) => format!("{} ({}) {caller}", f.api, f.samples),
                None => format!("{} ({})", f.api, f.samples),
            })
            .collect();
        let _ = writeln!(out, "   forced by: {}", named.join("; "));
    }
    let _ = writeln!(out, "   {} stall(s)", rp.stalls.len());
    if !rp.stalls.is_empty() {
        out.push_str(&print_frame_phases(&FramePhases {
            skew_ms: 0.0,
            boundary: rp.stalls.iter().map(|r| r.boundary).sum(),
            samples: rp.stalls.iter().map(|r| r.samples).sum(),
            frames: rp.stalls.clone(),
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stack(frames: &[&str]) -> Vec<String> {
        frames.iter().map(|s| s.to_string()).collect()
    }

    /// Leaf first, as the export lists them.
    fn forced_layout() -> Vec<String> {
        stack(&[
            "WebCore::RenderBlockFlow::layoutBlockChildren()",
            "WebCore::LocalFrameViewLayoutContext::layout(bool)",
            "WebCore::Document::updateLayout(WTF::OptionSet<WebCore::LayoutOptions>)",
            "WebCore::Element::clientHeight()",
            "WebCore::jsElement_clientHeight(JSC::JSGlobalObject*, long long)",
            "0x1142c0e01",
            "vmEntryToJavaScript",
            "JSC::MicrotaskQueue::drainWithoutUseCallOnEachMicrotask(JSC::VM&)",
            "__CFRunLoopRun",
        ])
    }

    fn engine_style() -> Vec<String> {
        stack(&[
            "WebCore::Style::TreeResolver::resolve()",
            "WebCore::Document::resolveStyle(WebCore::Document::ResolveStyleType)",
            "WebCore::Page::updateRendering()",
            "WebKit::RemoteLayerTreeDrawingArea::updateRendering()",
            "WebCore::timerFired(__CFRunLoopTimer*, void*)",
        ])
    }

    fn forced_rect() -> Vec<String> {
        stack(&[
            "WebCore::Style::TreeResolver::resolve()",
            "WebCore::Document::updateStyleIfNeeded()",
            "WebCore::Element::getBoundingClientRect()",
            "0x115105a97",
            "JSC::Interpreter::executeCall(JSC::JSObject*)",
        ])
    }

    fn script_only() -> Vec<String> {
        stack(&["0x1142c0e01", "0x115105a97", "vmEntryToJavaScript"])
    }

    fn commit() -> Vec<String> {
        stack(&[
            "WebCore::GraphicsLayerCA::recursiveCommitChanges(WebCore::CommitState&)",
            "WebCore::RenderLayerCompositor::flushPendingLayerChanges(bool)",
            "WebCore::Page::updateRendering()",
        ])
    }

    #[test]
    fn a_stack_is_filed_by_its_deepest_phase_and_forced_under_script() {
        let f = classify(&forced_layout());
        assert_eq!(
            (f.phase, f.forced, f.entry.as_deref()),
            ("layout", true, Some("clientHeight"))
        );
        let e = classify(&engine_style());
        assert_eq!((e.phase, e.forced, e.entry), ("style", false, None));
        assert_eq!(classify(&script_only()).phase, "script");
        assert_eq!(classify(&commit()).phase, "layer commit");
        assert_eq!(classify(&stack(&["mach_msg2_trap"])).phase, "other");
        // No known getter: the forcing entry is the outermost named frame
        // before script.
        let unknown = classify(&stack(&[
            "WebCore::LocalFrameViewLayoutContext::layout(bool)",
            "WebCore::Document::updateLayout(int)",
            "WebCore::HTMLTextAreaElement::somethingNew()",
            "0x1142c0e01",
        ]));
        // A bare address is no script frame, so nothing marks this forced.
        assert!(!unknown.forced);
        let unnamed = classify(&stack(&[
            "WebCore::LocalFrameViewLayoutContext::layout(bool)",
            "WebCore::Document::updateLayout(int)",
            "WebCore::HTMLTextAreaElement::somethingNew()",
            "0x1142c0e01",
            "vmEntryToJavaScript",
        ]));
        assert_eq!(
            unnamed.entry.as_deref(),
            Some("WebCore::HTMLTextAreaElement::somethingNew")
        );
    }

    /// A rest chain firing every 1 ms with one 10 ms stall (5–15): the
    /// window's phases are summed across every row, and only the stall is
    /// kept as a row — the gap the rest count reads as an update.
    #[test]
    fn a_rest_window_sums_its_phases_and_keeps_the_stall_rows() {
        let at = |t: f64, s: Vec<String>| Sample {
            epoch_ms: 1000.0 + t,
            stack: s,
        };
        let gc = stack(&[
            "JSC::Heap::collectInMutatorThread()",
            "JSC::Heap::collectIfNecessaryOrDefer(JSC::GCDeferralContext*)",
            "vmEntryToJavaScript",
        ]);
        let samples = vec![
            at(2.5, script_only()),
            at(8.0, forced_layout()),
            at(10.0, engine_style()),
            at(12.0, gc),
            at(20.0, engine_style()), // after the last stamp: not the window's
        ];
        let rp = rest_phases(
            &samples,
            &[2.0, 3.0, 4.0, 5.0, 15.0, 16.0, 17.0],
            1000.0,
            2.0,
        );
        assert_eq!(rp.window_ms, 17.0);
        assert_eq!(rp.samples, 4);
        assert_eq!(rp.phases["script"].engine, 1);
        assert_eq!(
            rp.phases["layout"],
            PhaseCount {
                engine: 0,
                forced: 1
            }
        );
        assert_eq!(
            rp.phases["style"],
            PhaseCount {
                engine: 1,
                forced: 0
            }
        );
        assert_eq!(rp.phases["gc"].engine, 1);
        assert_eq!(
            rp.forcers,
            vec![Forcer {
                api: "clientHeight".to_string(),
                caller: None,
                samples: 1
            }]
        );
        assert_eq!(rp.stalls.len(), 1);
        assert_eq!(
            (rp.stalls[0].t, rp.stalls[0].len, rp.stalls[0].samples),
            (5.0, 10.0, 3)
        );
        let text = print_rest_phases(&rp);
        assert!(text.contains("gc 1 (25.0% of busy)"), "{text}");
        assert!(text.contains("1 stall(s)"), "{text}");
    }

    /// Six samples over three frames: the set-up (0–20), frame 1 (20–36),
    /// frame 2 (36–52). The drive is at epoch 1000.
    #[test]
    fn samples_file_under_their_frame_with_phase_forcer_and_caller() {
        let at = |t: f64, s: Vec<String>| Sample {
            epoch_ms: 1000.0 + t,
            stack: s,
        };
        let samples = vec![
            at(-3.0, forced_layout()), // before the drive: not the drive's
            at(5.0, forced_layout()),
            at(6.0, forced_rect()),
            at(12.0, script_only()),
            at(20.5, engine_style()), // on frame 1's opening edge
            at(30.0, commit()),
            at(44.0, forced_layout()),
            at(60.0, engine_style()), // after the last stamp: dropped
        ];
        let chains = vec![ChainSpan {
            t: 4.0,
            ms: 1.0,
            site: "in onStillCrossingSettled: tug-list-view.tsx:1:2".to_string(),
            name: "clientHeight".to_string(),
        }];
        let fp = file_by_frame(&samples, &[20.0, 36.0, 52.0], 1000.0, Some(&chains));
        assert_eq!(fp.frames.len(), 3);
        assert_eq!(fp.samples, 6);

        let setup = &fp.frames[0];
        assert_eq!(
            (setup.frame.as_str(), setup.t, setup.len),
            ("set-up", 0.0, 20.0)
        );
        assert_eq!(setup.samples, 3);
        assert_eq!(
            setup.phases["layout"],
            PhaseCount {
                engine: 0,
                forced: 1
            }
        );
        assert_eq!(
            setup.phases["style"],
            PhaseCount {
                engine: 0,
                forced: 1
            }
        );
        assert_eq!(
            setup.phases["script"],
            PhaseCount {
                engine: 1,
                forced: 0
            }
        );
        // The sample inside the chain's read is named by the chain; the one
        // outside it by the engine's entry, with no caller.
        assert_eq!(
            setup.forcers,
            vec![
                Forcer {
                    api: "clientHeight".to_string(),
                    caller: Some("in onStillCrossingSettled: tug-list-view.tsx:1:2".to_string()),
                    samples: 1
                },
                Forcer {
                    api: "getBoundingClientRect".to_string(),
                    caller: None,
                    samples: 1
                },
            ]
        );

        let one = &fp.frames[1];
        assert_eq!((one.frame.as_str(), one.t, one.len), ("1", 20.0, 16.0));
        assert_eq!(
            one.phases["style"],
            PhaseCount {
                engine: 1,
                forced: 0
            }
        );
        assert_eq!(one.phases["layer commit"].engine, 1);
        assert!(one.forcers.is_empty());
        // Half a ms past the stamp: a boundary sample, filed where it fell.
        assert_eq!(one.boundary, 1);
        assert_eq!(fp.boundary, 1);

        let two = &fp.frames[2];
        assert_eq!(two.phases["layout"].forced, 1);
        assert_eq!(two.forcers[0].api, "clientHeight");
        assert_eq!(two.forcers[0].caller, None);
    }

    #[test]
    fn the_page_clock_is_corrected_only_past_the_wall_clocks_grain() {
        assert_eq!(drive_epoch(5000.0, 0.6), (5000.0, 0.0));
        assert_eq!(drive_epoch(5000.0, -812.5), (5812.5, 812.5));
    }

    const EXPORT: &str = r#"<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[12]'><schema name="time-profile"><col><mnemonic>time</mnemonic><name>Sample Time</name><engineering-type>sample-time</engineering-type></col><col><mnemonic>thread</mnemonic><name>Thread</name><engineering-type>thread</engineering-type></col><col><mnemonic>stack</mnemonic><name>Backtrace</name><engineering-type>backtrace</engineering-type></col></schema>
<row><sample-time id="1" fmt="00:00.348.872">348872541</sample-time><thread id="2" fmt="Main Thread 0x5df03f4 (com.apple.WebKit.WebContent, pid: 51903)"><tid id="3" fmt="0x5df03f4">98501620</tid></thread><backtrace id="10"><frame id="11" name="WebCore::Style::TreeResolver::resolve()" addr="0x1"/><frame id="12" name="WebCore::Page::updateRendering()" addr="0x2"/></backtrace></row>
<row><sample-time id="20" fmt="00:00.349.872">349872541</sample-time><thread ref="2"/><backtrace ref="10"/></row>
<row><sample-time ref="20"/><thread id="21" fmt="JIT Worklist Helper Thread 0x5e230d5 (com.apple.WebKit.WebContent, pid: 51903)"><tid id="22" fmt="0x5e230d5">1</tid></thread><backtrace ref="10"/></row>
<row><sample-time id="30" fmt="00:00.350.872">350872541</sample-time><thread ref="2"/><backtrace id="31"><frame id="32" name="0x1142c0e01" addr="0x1142c0e01"/><frame ref="12"/></backtrace></row>
</node></trace-query-result>"#;

    #[test]
    fn an_export_parses_its_main_thread_with_refs_resolved() {
        let samples = parse_time_profile(EXPORT, 1_000_000.0).unwrap();
        assert_eq!(
            samples.len(),
            3,
            "the worker's sample is not the main thread's"
        );
        assert!((samples[0].epoch_ms - 1_000_348.872541).abs() < 1e-6);
        assert_eq!(samples[1].stack, samples[0].stack);
        assert_eq!(
            samples[2].stack,
            vec![
                "0x1142c0e01".to_string(),
                "WebCore::Page::updateRendering()".to_string()
            ]
        );
    }

    #[test]
    fn an_export_with_no_sample_time_column_is_refused_by_name() {
        let without = EXPORT.replace(
            "<engineering-type>sample-time</engineering-type>",
            "<engineering-type>duration</engineering-type>",
        );
        let err = parse_time_profile(&without, 0.0).unwrap_err();
        assert!(err.contains("`sample-time` column"), "{err}");
    }

    #[test]
    fn the_start_date_reads_to_the_millisecond_with_its_offset() {
        let toc = "<trace-toc><run number=\"1\"><info><summary><start-date>2026-10-13T07:06:08.099-07:00</start-date></summary></info></run></trace-toc>";
        let ms = trace_start_epoch_ms(toc).unwrap();
        let expected = chrono::DateTime::parse_from_rfc3339("2026-10-13T14:06:08.099Z")
            .unwrap()
            .timestamp_millis() as f64;
        assert_eq!(ms, expected);
    }

    #[test]
    fn the_table_prints_a_set_up_row_and_its_forcers() {
        let at = |t: f64, s: Vec<String>| Sample {
            epoch_ms: t,
            stack: s,
        };
        let fp = file_by_frame(
            &[at(3.0, forced_layout()), at(25.0, engine_style())],
            &[20.0, 36.0],
            0.0,
            None,
        );
        let text = print_frame_phases(&fp);
        assert!(text.contains("set-up"), "{text}");
        assert!(text.contains("forced by: clientHeight (1)"), "{text}");
    }
}
