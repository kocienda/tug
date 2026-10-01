//! `tugtool deck motion slide --sample` — where the processes spent the slide.
//!
//! Runs `/usr/bin/sample` at 1 ms on the three processes a frame of the deck
//! passes through — the `Tug` host, its WebKit WebContent process (script,
//! style, layout, compositing, paint) and its WebKit GPU process (drawing the
//! layers) — while the slide verb clicks, then reduces each report to what a
//! reading needs: per thread, how many samples were busy rather than waiting,
//! and for the busy ones, which phase they were in and which frames they sat
//! on.
//!
//! The phase is the **deepest** recognized frame on a sample's stack, never
//! the outermost. WebContent's rendering update is itself driven by a run-loop
//! timer, so a reading that filed everything under `WebCore::timerFired` as
//! "script" counted the rendering update twice and misnamed it once — which is
//! what `[F04]` of `briefs/flow-slide-loose-threads-brief.md` did by hand. A
//! layout that script forced is filed as layout, inside script, for the same
//! reason.
//!
//! The helpers are found by asking macOS which app is *responsible* for each
//! WebKit process, so another app's WebKit (Safari, Mail) and another Tug
//! instance's are never sampled by mistake.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const SAMPLE_BIN: &str = "/usr/bin/sample";

/// Sampling interval, in ms.
const INTERVAL_MS: u32 = 1;

/// How many threads, and how many frames per thread, a report keeps.
const THREADS_KEPT: usize = 4;
const FRAMES_KEPT: usize = 8;

/// The phases a busy sample is filed under, by the deepest frame on its stack
/// whose name contains one of the needles. Order within the table does not
/// matter; depth does.
const PHASES: &[(&str, &[&str])] = &[
    (
        "script",
        &[
            "vmEntryToJavaScript",
            "JSC::Interpreter::execute",
            "JSC::call(",
            "JSC::profiledCall(",
            // Promise continuations: JIT'd code under a microtask drain is
            // otherwise an unsymbolicated `???` with no recognized ancestor.
            "JSC::callMicrotask",
            "JSC::MicrotaskQueue::",
        ],
    ),
    // A selector query is script's cost, but its own line: one run over the
    // whole deck grows with the deck rather than with the change.
    (
        "dom query",
        &[
            "SelectorDataList::execute",
            "SelectorQuery",
            "querySelector",
        ],
    ),
    (
        "gc",
        &["JSC::Heap::", "JSC::MarkedSpace", "JSC::SlotVisitor"],
    ),
    (
        "style",
        &[
            "Style::TreeResolver",
            "Document::resolveStyle",
            "Style::Resolver",
        ],
    ),
    (
        "layout",
        &[
            "LocalFrameViewLayoutContext::layout",
            "RenderBlock::layout",
            "RenderFlexibleBox::layout",
            "LayoutIntegration::",
        ],
    ),
    ("compositing", &["RenderLayerCompositor::"]),
    (
        "paint",
        &[
            "RenderLayer::paint",
            "GraphicsLayerCA::paint",
            "RenderLayerBacking::paint",
            "GraphicsContext",
        ],
    ),
    (
        "layer commit",
        &[
            "RemoteLayerTreeTransaction",
            "GraphicsLayerCA::recursiveCommitChanges",
            "PlatformCALayerRemote",
            "RemoteLayerTreeHost",
            "CA::Transaction",
        ],
    ),
    (
        "drawing",
        &[
            "RemoteRenderingBackend",
            "RemoteDisplayListRecorder",
            "RemoteImageBuffer",
            "CGContext",
            "IOSurface",
        ],
    ),
    (
        "rendering update",
        &[
            "Page::updateRendering",
            "RemoteLayerTreeDrawingArea::updateRendering",
        ],
    ),
    ("ipc", &["IPC::Connection::"]),
];

/// A leaf frame that means the thread was waiting, not working.
fn is_idle_leaf(name: &str) -> bool {
    const WAITS: &[&str] = &[
        "mach_msg2_trap",
        "mach_msg_trap",
        "__psynch_cvwait",
        "__psynch_mutexwait",
        "__workq_kernreturn",
        "kevent",
        "__semwait_signal",
        "__ulock_wait",
        "semaphore_wait_trap",
        "semaphore_timedwait_trap",
        "__select",
        "mach_wait_until",
        "__sigsuspend",
        "start_wqthread",
        "thread_start",
        "_pthread_wqthread",
    ];
    WAITS.iter().any(|w| name.starts_with(w))
}

fn phase_of(name: &str) -> Option<&'static str> {
    PHASES
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| name.contains(n)))
        .map(|(phase, _)| *phase)
}

/// One parsed `Call graph:` line.
struct Node {
    indent: usize,
    count: u64,
    name: String,
}

/// The function name of a call-graph line's body: everything before
/// `  (in <image>)`, or before the address when there is no image.
fn frame_name(body: &str) -> String {
    let end = body
        .find("  (in ")
        .or_else(|| body.find("  [0x"))
        .unwrap_or(body.len());
    body[..end].trim().to_string()
}

fn parse_line(line: &str) -> Option<Node> {
    let digits_at = line.find(|c: char| c.is_ascii_digit())?;
    // Everything before the count is indentation and the tree's own glyphs.
    if !line[..digits_at]
        .chars()
        .all(|c| matches!(c, ' ' | '+' | '!' | ':' | '|'))
    {
        return None;
    }
    let rest = &line[digits_at..];
    let space = rest.find(' ')?;
    let count = rest[..space].parse().ok()?;
    Some(Node {
        indent: digits_at,
        count,
        name: frame_name(rest[space..].trim_start()),
    })
}

/// One thread's reduction.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ThreadReading {
    pub thread: String,
    pub samples: u64,
    pub busy: u64,
    /// Busy samples by phase, largest first; `other` is busy and unrecognized.
    pub phases: Vec<(String, u64)>,
    /// The busy samples' top-of-stack frames, largest first.
    pub frames: Vec<(String, u64)>,
}

/// One process's reduction.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ProcessReading {
    pub process: String,
    pub pid: i32,
    /// The raw `sample` report, kept so a reading can be drilled into.
    pub report: PathBuf,
    pub threads: Vec<ThreadReading>,
}

struct Accum {
    thread: String,
    samples: u64,
    busy: u64,
    phases: HashMap<String, u64>,
    frames: HashMap<String, u64>,
}

fn sorted(map: HashMap<String, u64>, keep: usize) -> Vec<(String, u64)> {
    let mut v: Vec<(String, u64)> = map.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(keep);
    v
}

/// Reduce a `sample` report's call graph. Pure, so the fixture tests pin it.
pub fn reduce_report(text: &str) -> Vec<ThreadReading> {
    let graph: Vec<Node> = text
        .lines()
        .skip_while(|l| !l.starts_with("Call graph:"))
        .skip(1)
        .take_while(|l| !l.trim().is_empty())
        .filter_map(parse_line)
        .collect();

    let mut threads: Vec<Accum> = Vec::new();
    // The open path: (indent, count, phase-so-far) per ancestor.
    let mut path: Vec<(usize, Option<&'static str>)> = Vec::new();
    for (i, node) in graph.iter().enumerate() {
        while path
            .last()
            .is_some_and(|(indent, _)| *indent >= node.indent)
        {
            path.pop();
        }
        if path.is_empty() {
            threads.push(Accum {
                thread: node.name.clone(),
                samples: node.count,
                busy: 0,
                phases: HashMap::new(),
                frames: HashMap::new(),
            });
            path.push((node.indent, None));
            continue;
        }
        let inherited = path.last().and_then(|(_, p)| *p);
        let phase = phase_of(&node.name).or(inherited);
        path.push((node.indent, phase));

        // Samples whose top of stack is this frame: its count less its
        // children's, which are the following lines indented further.
        let children: u64 = graph[i + 1..]
            .iter()
            .take_while(|n| n.indent > node.indent)
            .filter(|n| {
                // Direct children only: the shallowest indent after this line.
                let first = graph.get(i + 1).map(|f| f.indent).unwrap_or(usize::MAX);
                n.indent == first
            })
            .map(|n| n.count)
            .sum();
        let own = node.count.saturating_sub(children);
        if own == 0 || is_idle_leaf(&node.name) {
            continue;
        }
        let Some(t) = threads.last_mut() else {
            continue;
        };
        t.busy += own;
        *t.phases
            .entry(phase.unwrap_or("other").to_string())
            .or_default() += own;
        *t.frames.entry(node.name.clone()).or_default() += own;
    }

    let mut out: Vec<ThreadReading> = threads
        .into_iter()
        .map(|t| ThreadReading {
            thread: t.thread,
            samples: t.samples,
            busy: t.busy,
            phases: sorted(t.phases, usize::MAX),
            frames: sorted(t.frames, FRAMES_KEPT),
        })
        .collect();
    out.sort_by(|a, b| b.busy.cmp(&a.busy));
    out.truncate(THREADS_KEPT);
    out
}

// ---------------------------------------------------------------------------
// Finding the processes
// ---------------------------------------------------------------------------

unsafe extern "C" {
    /// The pid macOS holds responsible for `pid` — for a WebKit XPC service,
    /// the app whose web view launched it. Exported by libSystem; undocumented
    /// but stable, and what Activity Monitor's grouping reads.
    fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
}

fn responsible_for(pid: i32) -> i32 {
    // SAFETY: a pure query on a pid; an unknown pid answers -1.
    unsafe { responsibility_get_pid_responsible_for_pid(pid) }
}

/// The `Tug` host behind a tugcast port, from the instance registry.
fn host_pid_for_port(port: u16) -> Result<i32, String> {
    let instances = tugcore::registry::load().map_err(|e| e.to_string())?;
    let instance = instances
        .into_iter()
        .find(|i| i.tugcast_port == port)
        .ok_or_else(|| format!("no registered instance serves port {port}"))?;
    if instance.host_pid > 0 {
        return Ok(instance.host_pid);
    }
    Err(format!(
        "instance {} records no host app (tugcast is running standalone), so there is nothing to sample",
        instance.instance_id
    ))
}

/// The processes to sample: the host, then each WebKit WebContent and GPU
/// process it is responsible for.
pub fn targets(port: u16) -> Result<Vec<(String, i32)>, String> {
    let host = host_pid_for_port(port)?;
    let out = Command::new("/bin/ps")
        .args(["-axo", "pid=,comm="])
        .output()
        .map_err(|e| format!("ps failed: {e}"))?;
    let mut found = vec![("Tug".to_string(), host)];
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        let Some((pid, comm)) = line.split_once(' ') else {
            continue;
        };
        let Ok(pid) = pid.parse::<i32>() else {
            continue;
        };
        let base = Path::new(comm.trim())
            .file_name()
            .map(|b| b.to_string_lossy().to_string())
            .unwrap_or_default();
        let label = match base.as_str() {
            "com.apple.WebKit.WebContent" => "WebContent",
            "com.apple.WebKit.GPU" => "GPU",
            _ => continue,
        };
        if responsible_for(pid) == host {
            found.push((label.to_string(), pid));
        }
    }
    if found.len() == 1 {
        return Err(format!(
            "found no WebKit processes that Tug (pid {host}) is responsible for"
        ));
    }
    Ok(found)
}

// ---------------------------------------------------------------------------
// Running the samplers
// ---------------------------------------------------------------------------

pub struct Samplers {
    running: Vec<(String, i32, PathBuf, Child)>,
}

/// Start one `sample` per target, each running for `seconds`.
pub fn start(targets: &[(String, i32)], seconds: u32) -> Result<Samplers, String> {
    let dir = std::env::temp_dir().join(format!("tug-slide-sample-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut running = Vec::new();
    for (label, pid) in targets {
        let file = dir.join(format!("{label}-{pid}.txt"));
        let child = Command::new(SAMPLE_BIN)
            .arg(pid.to_string())
            .arg(seconds.to_string())
            .arg(INTERVAL_MS.to_string())
            .arg("-mayDie")
            .arg("-file")
            .arg(&file)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{SAMPLE_BIN} failed to start: {e}"))?;
        running.push((label.clone(), *pid, file, child));
    }
    Ok(Samplers { running })
}

impl Samplers {
    /// Wait for every sampler and reduce its report.
    pub fn finish(self) -> Result<Vec<ProcessReading>, String> {
        let mut readings = Vec::new();
        for (label, pid, file, child) in self.running {
            let out = child
                .wait_with_output()
                .map_err(|e| format!("{SAMPLE_BIN} on {label}: {e}"))?;
            let text = std::fs::read_to_string(&file).map_err(|e| {
                format!(
                    "{SAMPLE_BIN} on {label} (pid {pid}) wrote no report: {e}; it said: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )
            })?;
            readings.push(ProcessReading {
                process: label,
                pid,
                report: file,
                threads: reduce_report(&text),
            });
        }
        Ok(readings)
    }
}

pub fn print(readings: &[ProcessReading], clicks: usize) {
    for p in readings {
        println!();
        println!("{} (pid {}) — {}", p.process, p.pid, p.report.display());
        for t in &p.threads {
            if t.busy == 0 {
                continue;
            }
            let per_click = if clicks > 0 {
                t.busy as f64 * INTERVAL_MS as f64 / clicks as f64
            } else {
                0.0
            };
            println!(
                "  {}: {} busy of {} samples (~{per_click:.0} ms per click, rests included)",
                t.thread, t.busy, t.samples
            );
            let phases: Vec<String> = t.phases.iter().map(|(p, n)| format!("{p} {n}")).collect();
            println!("    phases: {}", phases.join(", "));
            for (frame, n) in &t.frames {
                let short: String = frame.chars().take(110).collect();
                println!("    {n:>6}  {short}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "\
Analysis of sampling com.apple.WebKit.WebContent (pid 1) every 1 millisecond
----

Call graph:
    100 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
    + 100 start  (in dyld) + 6688  [0x19ed3fe80]
    +   100 __CFRunLoopRun  (in CoreFoundation) + 1172  [0x1]
    +     58 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x2]
    +     40 WebCore::timerFired(__CFRunLoopTimer*, void*)  (in WebCore) + 76  [0x3]
    +       30 WebKit::RemoteLayerTreeDrawingArea::updateRendering()  (in WebKit) + 168  [0x4]
    +       ! 20 WebCore::RenderLayerCompositor::computeCompositingRequirements(WebCore::RenderLayer*)  (in WebCore) + 860  [0x5]
    +       ! 6 WebCore::Document::resolveStyle(WebCore::Document::ResolveStyleType)  (in WebCore) + 764  [0x6]
    +       ! : 6 WebCore::Style::TreeResolver::resolve()  (in WebCore) + 1  [0x7]
    +       10 JSC::vmEntryToJavaScript  (in JavaScriptCore) + 1  [0x8]
    +         4 WebCore::LocalFrameViewLayoutContext::layout(bool)  (in WebCore) + 1  [0x9]
    +     2 JSC::MicrotaskQueue::drainWithoutUseCallOnEachMicrotask(JSC::VM&)  (in JavaScriptCore) + 1  [0xc]
    +       2 ???  (in <unknown binary>)  [0xd]
    7 Thread_2: JavaScriptCore libpas scavenger
    + 7 thread_start  (in libsystem_pthread.dylib) + 8  [0xa]
    +   7 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0xb]

Total number in stack (recursive counted multiple, when >=5):
";

    #[test]
    fn a_call_graph_line_parses_its_depth_count_and_name() {
        let n = parse_line(
            "    +       ! 20 WebCore::RenderLayerCompositor::update()  (in WebCore) + 860  [0x5]",
        )
        .unwrap();
        assert_eq!(n.count, 20);
        assert_eq!(n.name, "WebCore::RenderLayerCompositor::update()");
        assert_eq!(n.indent, 14);
        assert!(parse_line("Total number in stack").is_none());
    }

    /// The rendering update runs under `timerFired`; filing by the deepest
    /// frame keeps it out of "script", which is the misreading this fixes.
    #[test]
    fn a_busy_sample_is_filed_by_its_deepest_recognized_frame() {
        let threads = reduce_report(FIXTURE);
        let main = &threads[0];
        assert_eq!(
            main.thread,
            "Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)"
        );
        assert_eq!(main.samples, 100);
        // 58 waiting; 42 busy.
        assert_eq!(main.busy, 42);
        let phases: HashMap<String, u64> = main.phases.iter().cloned().collect();
        assert_eq!(phases.get("compositing"), Some(&20));
        assert_eq!(phases.get("style"), Some(&6));
        // updateRendering's own 4 samples (30 − 20 − 6).
        assert_eq!(phases.get("rendering update"), Some(&4));
        // Script's own 6, and the layout it forced filed as layout.
        // Script's own 6, plus 2 of JIT'd code under a microtask drain.
        assert_eq!(phases.get("script"), Some(&8));
        assert_eq!(phases.get("layout"), Some(&4));
        assert_eq!(phases.get("other"), None);
        assert_eq!(phases.values().sum::<u64>(), main.busy);
        assert_eq!(main.frames[0].1, 20);
    }

    #[test]
    fn a_thread_that_only_waits_is_not_busy() {
        let threads = reduce_report(FIXTURE);
        let scavenger = threads
            .iter()
            .find(|t| t.thread.contains("scavenger"))
            .unwrap();
        assert_eq!(scavenger.busy, 0);
        assert!(scavenger.phases.is_empty());
    }
}
