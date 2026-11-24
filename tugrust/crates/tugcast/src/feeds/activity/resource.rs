//! OS subtree resource sampler for the ACTIVITY feed ([P08], [P10], [P20]).
//!
//! This module owns the `(pid, start_time)` reuse-guard and the process-tree
//! reader: the capture and guard primitives the supervisor uses to retain
//! each session's `(pid, start_time)`, and the sampler task that walks each
//! subtree, publishes its CPU, memory and disk gauges, and reads its tool
//! processes at the tape's grain.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio_util::sync::CancellationToken;

use crate::feeds::agent_supervisor::AgentSupervisor;
use crate::feeds::session_scoped::SessionScopedFeed;

/// The sampler's tick: the activity tape's 250 ms bin. See [`cadence`] for
/// what each tick does, and why only every fourth one walks the whole table.
const TAPE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Every this-many ticks the sampler walks the whole process table (1 Hz).
/// The gauges ride the walk alone, so their cadence is unchanged ([Q02]): 1 Hz
/// is the coarsest rate that still shows a legible CPU hump, and the walk is
/// gated to ticks where at least one session has a live pid, so an idle
/// tugcast does no sysinfo work.
const TICKS_PER_WALK: u64 = 4;

/// How many processes the tool-process `System` may hold beyond the ones
/// still wanted before it is rebuilt. A tool process that leaves every
/// session's subtree while still alive (a daemon reparented to launchd) is
/// never named in a refresh again and so never removed as dead; this bounds
/// what such orphans can cost over a long-lived tugcast.
const MAX_HELD_ORPHANS: usize = 256;

/// No news is no news: a gauge channel rides a frame only when it moved at
/// least this much from the value last published for it. An unchanged (or
/// sub-threshold jittering) gauge sends nothing, and a frame with no moved
/// channels is not sent at all — the wire is silent for an idle session, and
/// the deck holds the last published level as the truth until told
/// otherwise. The thresholds are wire-level dedup, deliberately finer than
/// any display grain downstream: CPU below half a percent of one core, and
/// memory below 4 MiB, cannot be read off any Tug surface.
const CPU_PUBLISH_EPSILON_PCT: f32 = 0.5;
const RSS_PUBLISH_EPSILON_BYTES: u64 = 4 * 1024 * 1024;

/// The gauge values last published for one session — the change gate's
/// reference. Advances only when a channel is published, so slow drift
/// accumulates against a fixed point and eventually fires.
#[derive(Debug, Clone, Copy, Default)]
struct PublishedGauges {
    cpu_pct: f32,
    rss_bytes: u64,
    #[cfg(target_os = "macos")]
    disk_read_bps: u64,
    #[cfg(target_os = "macos")]
    disk_write_bps: u64,
}

/// One process's contribution to a subtree sum: its own CPU% and resident
/// memory. `cpu_pct` follows sysinfo's convention (100 == one core saturated;
/// a multi-core process may exceed 100).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SubtreeUsage {
    pub cpu_pct: f32,
    pub rss_bytes: u64,
}

/// One process node in a refresh snapshot — its parent link (for the subtree
/// walk), its start time (so a recycled pid reads as a different process),
/// and its own resource readings.
#[derive(Debug, Clone, Copy)]
pub struct ProcNode {
    pub parent: Option<u32>,
    /// Seconds since the Unix epoch, as sysinfo reports it.
    pub start_time: u64,
    pub cpu_pct: f32,
    pub rss_bytes: u64,
}

/// pid → node for one refresh. Built from a `System` snapshot; the pure
/// [`subtree_usage`] sums over it so the walk is testable without sysinfo.
pub type ProcMap = HashMap<u32, ProcNode>;

/// Invert a [`ProcMap`] into a parent → children adjacency index, so the
/// subtree walk is O(subtree) rather than O(all-processes) per root.
pub fn children_index(procs: &ProcMap) -> HashMap<u32, Vec<u32>> {
    let mut idx: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, node) in procs {
        if let Some(parent) = node.parent {
            idx.entry(parent).or_default().push(pid);
        }
    }
    idx
}

/// Every pid in the subtree rooted at `root` (inclusive), following child
/// links ([P08]). Returns `None` when `root` is absent — a dead root has no
/// subtree. The `seen` set guards against a cyclic parent map (never expected
/// from the kernel, but cheap insurance).
pub fn subtree_pids(
    procs: &ProcMap,
    children: &HashMap<u32, Vec<u32>>,
    root: u32,
) -> Option<Vec<u32>> {
    procs.get(&root)?;
    let mut seen: HashSet<u32> = HashSet::new();
    let mut out: Vec<u32> = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    Some(out)
}

// ── The `machine` channel's reading ───────────────────────────────────────
//
// Machine work is what a session's tool processes consume: everything below
// the session's `claude`, measured from the operating system. tugcode and
// `claude` themselves are left out, because their CPU is the model's client
// reading its stream, which the `text` and `tokens` channels already draw.
// Nothing is excluded by name: a standing helper that idles sits under the
// noise gate, and one that works was called by a tool, so its work is real.
//
// Three signals become units on the activity tape's scale, whose full height
// is 1200 units a second: CPU consumed, processes spawned, and disk bytes
// moved. The constants below are the channel's only level knobs.
pub mod machine {
    use std::collections::{HashMap, HashSet};

    use super::ProcMap;

    /// Units credited for one core saturated for one second — half the tape's
    /// full scale, so one busy core draws a tall line and a multi-core build
    /// reaches the top.
    pub const MACHINE_UNITS_PER_CORE_SEC: f64 = 600.0;

    /// The noise gate, in sysinfo's percent of one core: a tool subtree reading
    /// under this credits no CPU at all. It sits above the 0.0–0.3% an idle
    /// process reads, so a standing process that waits draws nothing.
    pub const MACHINE_CPU_GATE_PCT: f32 = 2.0;

    /// Units credited for each tool process not seen in the previous interval.
    /// This is what makes a run of many short commands read as busy, since each
    /// may live for less than one sample.
    pub const MACHINE_UNITS_PER_SPAWN: f64 = 60.0;

    /// Units credited per MiB a second of disk bytes moved, read and written
    /// together, for a command that is I/O-bound and light on CPU.
    pub const MACHINE_UNITS_PER_DISK_MIB_SEC: f64 = 100.0;

    /// The ceiling on the disk signal, in units a second, so a large copy is at
    /// most as loud as one saturated core.
    pub const MACHINE_DISK_CAP_UNITS_PER_SEC: f64 = 600.0;

    /// A process as the spawn count identifies it: its pid and its start time,
    /// so a pid the kernel recycled for a new process counts as a new spawn.
    pub type ProcIdentity = (u32, u64);

    /// The session's tool processes: the subtree rooted at its tugcode pid with
    /// tugcode itself and its direct children (the `claude` it runs) left out —
    /// every process at depth two and below. `None` when `root` is absent; an
    /// empty list when nothing runs below `claude`.
    pub fn tool_subtree_pids(
        procs: &ProcMap,
        children: &HashMap<u32, Vec<u32>>,
        root: u32,
    ) -> Option<Vec<u32>> {
        procs.get(&root)?;
        let mut seen: HashSet<u32> = HashSet::from([root]);
        let mut out: Vec<u32> = Vec::new();
        // Start below the direct children, so neither tugcode nor its `claude`
        // is in the set; the walk below them is the same as `subtree_pids`.
        let mut stack: Vec<u32> = Vec::new();
        for &child in children.get(&root).map(Vec::as_slice).unwrap_or_default() {
            if seen.insert(child)
                && let Some(grandkids) = children.get(&child)
            {
                stack.extend(grandkids.iter().copied());
            }
        }
        while let Some(pid) = stack.pop() {
            if !seen.insert(pid) {
                continue;
            }
            out.push(pid);
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        Some(out)
    }

    /// One interval's reading of a session's tool processes, ready to be turned
    /// into units: their summed CPU (sysinfo's percent of one core, averaged
    /// over the interval), who they are, and the disk bytes they moved in it.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct ToolReading {
        pub cpu_pct: f32,
        pub identities: HashSet<ProcIdentity>,
        pub disk_bytes: u64,
    }

    /// Read the CPU and identities of `pids` out of one refresh snapshot. Disk
    /// bytes are platform-specific and left at zero for the caller to fill.
    pub fn tool_reading(procs: &ProcMap, pids: &[u32]) -> ToolReading {
        let mut reading = ToolReading::default();
        for &pid in pids {
            if let Some(node) = procs.get(&pid) {
                reading.cpu_pct += node.cpu_pct;
                reading.identities.insert((pid, node.start_time));
            }
        }
        reading
    }

    /// One interval's machine work, by signal, in units on the tape's scale.
    #[derive(Debug, Clone, Copy, Default, PartialEq)]
    pub struct MachineUnits {
        pub cpu: f64,
        pub spawns: f64,
        pub disk: f64,
    }

    impl MachineUnits {
        /// The interval's whole credit, the value the channel carries.
        pub fn total(&self) -> f64 {
            self.cpu + self.spawns + self.disk
        }
    }

    /// Turn one interval's reading into units. `interval_secs` is the time the
    /// reading covers; `previous` is the set of tool processes the last interval
    /// saw, or `None` on a session's first reading — whose processes were already
    /// running, and so are a baseline rather than a burst of spawns.
    pub fn machine_units(
        interval_secs: f64,
        reading: &ToolReading,
        previous: Option<&HashSet<ProcIdentity>>,
    ) -> MachineUnits {
        if interval_secs <= 0.0 {
            return MachineUnits::default();
        }
        let cpu = if reading.cpu_pct < MACHINE_CPU_GATE_PCT {
            0.0
        } else {
            f64::from(reading.cpu_pct) / 100.0 * MACHINE_UNITS_PER_CORE_SEC * interval_secs
        };
        let spawned = previous.map_or(0, |prev| reading.identities.difference(prev).count());
        let spawns = spawned as f64 * MACHINE_UNITS_PER_SPAWN;
        let mib_per_sec = reading.disk_bytes as f64 / (1024.0 * 1024.0) / interval_secs;
        let disk = (mib_per_sec * MACHINE_UNITS_PER_DISK_MIB_SEC)
            .min(MACHINE_DISK_CAP_UNITS_PER_SEC)
            * interval_secs;
        MachineUnits { cpu, spawns, disk }
    }
}

/// The sampler's cadence: the whole process table at 1 Hz, and a session's
/// tool processes alone at the tape's 4 Hz while it has any.
///
/// The `machine` channel wants the tape's 250 ms grain: a 1 Hz sample against
/// 250 ms bins draws one spike a second with three empty bins between. A full
/// sysinfo refresh at 4 Hz was measured too dear for that (2026-11-24, sysinfo
/// 0.34.2, release build, 16 cores, about 1,200 processes): 1.1–1.9% of one
/// core at 1 Hz against 4.5–8.5% at 4 Hz, 11–21 ms a walk. Refreshing only
/// the pids already known to be tool processes between the 1 Hz walks cost
/// 1.2–2.4% in all, a tenth to a half of a percent over the walk alone. So:
///
/// - every [`TICKS_PER_WALK`]th tick walks the whole table, publishes the
///   gauges exactly as before, and learns each session's tool pids;
/// - every tick on which some session has tool pids refreshes just those, on
///   a second `System` of their own;
/// - every other tick does nothing, so an idle instance does no more work
///   than it did at 1 Hz.
///
/// The second `System` is not a convenience. On macOS sysinfo computes every
/// process's CPU against one interval per `System`, measured since that
/// `System`'s last refresh of any kind, so a targeted refresh on the walk's
/// `System` would make the next walk read every process it skipped at four
/// times its real CPU — the gauges included.
///
/// A tool process spawned between walks is found at the next walk, and its
/// CPU counts from the tick after; its spawn is counted at the walk.
pub mod cadence {
    use std::collections::HashSet;

    use super::{MAX_HELD_ORPHANS, TICKS_PER_WALK};

    /// What one tick does.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum TickPlan {
        /// Walk the whole table (gauges, tool pids), then refresh the tools.
        Walk,
        /// Refresh the known tool processes alone.
        Tools,
        /// Nothing: no session has a tool process.
        Rest,
    }

    /// The plan for tick number `tick` (counting from zero, the first tick
    /// walks), given whether any session has tool processes known.
    pub fn plan_tick(tick: u64, tools_known: bool) -> TickPlan {
        if tick % TICKS_PER_WALK == 0 {
            TickPlan::Walk
        } else if tools_known {
            TickPlan::Tools
        } else {
            TickPlan::Rest
        }
    }

    /// The pids to name in a targeted refresh of the tool-process `System`:
    /// every pid wanted, and every pid it holds that is no longer wanted, so
    /// that the refresh removes the ones that have died. The flag says the
    /// `System` holds so many unwanted live pids that it should be rebuilt
    /// before the refresh rather than carry them.
    pub fn refresh_list(
        wanted: &HashSet<u32>,
        held: impl IntoIterator<Item = u32>,
    ) -> (Vec<u32>, bool) {
        let stale: Vec<u32> = held.into_iter().filter(|p| !wanted.contains(p)).collect();
        if stale.len() > MAX_HELD_ORPHANS {
            return (wanted.iter().copied().collect(), true);
        }
        let mut list: Vec<u32> = wanted.iter().copied().collect();
        list.extend(stale);
        (list, false)
    }
}

/// Refresh the tool-process `System` over the pids `wanted`, the 4 Hz half of
/// the [`cadence`]. A wanted pid's first refresh reads no CPU, since sysinfo
/// has nothing to difference it against.
fn refresh_tool_processes(system: &mut System, wanted: &HashSet<u32>) {
    let held = system.processes().keys().map(|p| p.as_u32());
    let (list, rebuild) = cadence::refresh_list(wanted, held);
    if rebuild {
        *system = System::new();
    }
    if list.is_empty() {
        return;
    }
    let pids: Vec<Pid> = list.into_iter().map(Pid::from_u32).collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_cpu(),
    );
}

/// The wire key of the `machine` rate channel.
const MACHINE_WIRE_KEY: &str = "machine";

/// The channel map for one interval's machine work, or `None` when it rounds
/// to nothing: a rate channel says nothing when there is nothing to say, so
/// a session with nothing below `claude`, or everything under the gate, is
/// silent on the wire.
fn machine_channels(units: f64) -> Option<serde_json::Map<String, serde_json::Value>> {
    let units = units.round();
    if !units.is_finite() || units < 1.0 {
        return None;
    }
    let mut channels = serde_json::Map::new();
    channels.insert(MACHINE_WIRE_KEY.into(), serde_json::json!(units as u64));
    Some(channels)
}

/// The `machine` channel's half of the sampler: the tool processes' own
/// `System`, each live session's tool processes as of the last walk, and
/// what each session's tool processes were in the interval before, for the
/// spawn count. It consults no turn state, so a background job, a call moved
/// to the background and a command a wake started all draw.
struct MachineSampler {
    system: System,
    /// Every live session the walk could attribute, with its tool processes
    /// as `(pid, start_time)` — empty for a session with nothing below
    /// `claude`, which is still a session whose next process is a spawn.
    sessions: HashMap<String, Vec<machine::ProcIdentity>>,
    /// The tool processes each session's last reading saw. Absent for a
    /// session not yet read, whose first reading is a baseline.
    seen: HashMap<String, HashSet<machine::ProcIdentity>>,
    /// Per-pid cumulative disk counters, differenced tick to tick (the
    /// gauge's own are differenced walk to walk).
    #[cfg(target_os = "macos")]
    disk_last: HashMap<u32, disk::DiskCounters>,
    last_read: Option<std::time::Instant>,
}

impl MachineSampler {
    fn new() -> Self {
        Self {
            system: System::new(),
            sessions: HashMap::new(),
            seen: HashMap::new(),
            #[cfg(target_os = "macos")]
            disk_last: HashMap::new(),
            last_read: None,
        }
    }

    /// Does any session have a tool process? The cadence's question.
    fn tools_known(&self) -> bool {
        self.sessions.values().any(|ids| !ids.is_empty())
    }

    /// Take a walk's account of every attributable session's tool processes.
    /// A session the walk did not attribute is forgotten.
    fn learn(&mut self, sessions: HashMap<String, Vec<machine::ProcIdentity>>) {
        self.seen.retain(|id, _| sessions.contains_key(id));
        self.sessions = sessions;
    }

    /// Refresh the tool processes and read each session's machine work over
    /// the interval since the last read.
    fn sample(&mut self, now: std::time::Instant) -> Vec<(String, f64)> {
        let wanted: HashSet<u32> = self
            .sessions
            .values()
            .flatten()
            .map(|&(pid, _)| pid)
            .collect();
        refresh_tool_processes(&mut self.system, &wanted);
        // The interval sysinfo's CPU reading covers. After a stretch with
        // nothing to read it is capped, since every pid is then new and reads
        // no CPU anyway.
        let interval = self
            .last_read
            .map_or(TAPE_INTERVAL, |t| now.saturating_duration_since(t))
            .min(std::time::Duration::from_secs(1))
            .as_secs_f64();
        self.last_read = Some(now);

        let mut out = Vec::with_capacity(self.sessions.len());
        for (id, ids) in &self.sessions {
            // Only a process that is still the one the walk found: a pid
            // recycled since then is not this session's.
            let mut procs: ProcMap = HashMap::new();
            for &(pid, start_time) in ids {
                if let Some(p) = self.system.process(Pid::from_u32(pid))
                    && p.start_time() == start_time
                {
                    procs.insert(
                        pid,
                        ProcNode {
                            parent: None,
                            start_time,
                            cpu_pct: p.cpu_usage(),
                            rss_bytes: 0,
                        },
                    );
                }
            }
            let pids: Vec<u32> = procs.keys().copied().collect();
            #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
            let mut reading = machine::tool_reading(&procs, &pids);
            #[cfg(target_os = "macos")]
            for &pid in &pids {
                let Some(cur) = disk::proc_disk_counters(pid) else {
                    continue;
                };
                if let Some(prev) = self.disk_last.insert(pid, cur) {
                    let d = disk::non_negative_delta(prev, cur);
                    reading.disk_bytes = reading
                        .disk_bytes
                        .saturating_add(d.read)
                        .saturating_add(d.write);
                }
            }
            let units = machine::machine_units(interval, &reading, self.seen.get(id));
            self.seen.insert(id.clone(), reading.identities);
            out.push((id.clone(), units.total()));
        }
        #[cfg(target_os = "macos")]
        self.disk_last.retain(|pid, _| wanted.contains(pid));
        out
    }

    /// Read every session and publish what each has to say.
    fn sample_and_publish(&mut self, activity: &SessionScopedFeed) {
        for (id, units) in self.sample(std::time::Instant::now()) {
            let Some(channels) = machine_channels(units) else {
                continue;
            };
            let payload = serde_json::json!({ "channels": channels });
            if let Ok(bytes) = serde_json::to_vec(&payload) {
                activity.publish(id.as_str(), &bytes);
            }
        }
    }
}

/// macOS per-process disk I/O via `proc_pid_rusage(RUSAGE_INFO_V2)` ([P11]).
/// The counters are cumulative-since-process-start; the sampler differences
/// them across ticks into a bytes/sec gauge. Absent on other platforms — the
/// `disk` channel is simply not produced there ([Q03]).
#[cfg(target_os = "macos")]
pub mod disk {
    /// Cumulative disk bytes for one process (read + written since it started).
    #[derive(Debug, Clone, Copy, Default, PartialEq)]
    pub struct DiskCounters {
        pub read: u64,
        pub write: u64,
    }

    /// Read a process's cumulative disk bytes, or `None` if the pid is gone or
    /// access is denied (a subprocess we don't own — rare for our own subtree).
    pub fn proc_disk_counters(pid: u32) -> Option<DiskCounters> {
        // SAFETY: a zeroed `rusage_info_v2` is a valid all-zero POD. On success
        // `proc_pid_rusage` returns 0 and fills the struct; on failure it
        // returns non-zero and we ignore the (untouched) buffer. The buffer
        // arg is typed `*mut rusage_info_t` (itself `*mut c_void`), so the
        // struct pointer is reinterpreted per the C `proc_pid_rusage` idiom.
        unsafe {
            let mut ri: libc::rusage_info_v2 = std::mem::zeroed();
            let ret = libc::proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V2,
                &mut ri as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t,
            );
            if ret != 0 {
                return None;
            }
            Some(DiskCounters {
                read: ri.ri_diskio_bytesread,
                write: ri.ri_diskio_byteswritten,
            })
        }
    }

    /// Non-negative per-tick delta (bytes/sec at the 1 Hz cadence). The
    /// counters are monotonic per process, but the subtree's process *set*
    /// shifts as bash children come and go, so a raw session-level difference
    /// can go negative when a child exits mid-window; `saturating_sub` clamps
    /// that to zero ([Q03]).
    pub fn non_negative_delta(last: DiskCounters, cur: DiskCounters) -> DiskCounters {
        DiskCounters {
            read: cur.read.saturating_sub(last.read),
            write: cur.write.saturating_sub(last.write),
        }
    }
}

/// Read every live process into a [`ProcMap`] from a refreshed `System`.
fn snapshot_processes(system: &System) -> ProcMap {
    system
        .processes()
        .iter()
        .map(|(pid, proc)| {
            (
                pid.as_u32(),
                ProcNode {
                    parent: proc.parent().map(|p| p.as_u32()),
                    start_time: proc.start_time(),
                    cpu_pct: proc.cpu_usage(),
                    rss_bytes: proc.memory(),
                },
            )
        })
        .collect()
}

/// Has a CPU reading moved enough from its last published value to be news?
fn cpu_moved(published: f32, current: f32) -> bool {
    (current - published).abs() >= CPU_PUBLISH_EPSILON_PCT
}

/// Has a resident-memory reading moved enough to be news?
fn rss_moved(published: u64, current: u64) -> bool {
    published.abs_diff(current) >= RSS_PUBLISH_EPSILON_BYTES
}

/// The final frame for a departed session: every gauge at zero. Sent once
/// when a session leaves the live set, so the deck's held levels fall to
/// rest instead of freezing at the last reading — silence afterward means
/// "still zero", per the no-news contract.
fn zeroed_gauge_channels() -> serde_json::Map<String, serde_json::Value> {
    let mut channels = serde_json::Map::new();
    channels.insert("cpu_pct".into(), serde_json::json!(0.0_f32));
    channels.insert("rss_bytes".into(), serde_json::json!(0_u64));
    #[cfg(target_os = "macos")]
    {
        channels.insert("disk_read_bps".into(), serde_json::json!(0_u64));
        channels.insert("disk_write_bps".into(), serde_json::json!(0_u64));
    }
    channels
}

/// Per-session OS sampler task ([P10]). It ticks at the tape's 250 ms grain
/// on the [`cadence`] that module describes. On each 1 Hz walk it asks the
/// supervisor for every session with a live tugcode child, and — only if
/// there is at least one — refreshes the full process table once, builds the
/// parent map, and for each session walks its child pid's subtree, summing
/// CPU% + memory. The `(pid, start_time)` reuse-guard ([P20]) rejects a
/// recycled or dead pid, attributing zero so the deck gauge falls to rest
/// rather than misattributing another process's work. Samples ride the
/// ACTIVITY feed as gauge channels ([P09]), session-tagged by the
/// `SessionScopedFeed` splice.
///
/// NO NEWS IS NO NEWS: a channel is published only when it moved past its
/// epsilon from the value last published for it (first observation always
/// publishes), a frame with no moved channels is not sent, and a session
/// leaving the live set gets one final all-zero frame. The deck holds each
/// gauge's last published level indefinitely on the strength of this
/// contract — an idle session costs the wire, and every client downstream
/// of it, nothing.
///
/// Beside the gauges it publishes one rate channel, `machine`: what each
/// session's tool processes (everything below its `claude`) consumed over
/// each tick, as units on the tape's scale ([`machine`]). It is read on every
/// walk and every tool tick, whether or not a turn is open, and a tick whose
/// units round to nothing sends nothing.
pub async fn run_resource_sampler(
    supervisor: Arc<AgentSupervisor>,
    activity: SessionScopedFeed,
    cancel: CancellationToken,
) {
    let mut system = System::new();
    // The `machine` channel's reading, at the tape's grain; see [`cadence`]
    // for why its processes have a `System` of their own.
    let mut machine_sampler = MachineSampler::new();
    let mut tick: u64 = 0;
    // macOS per-pid cumulative disk counters, carried across ticks so the
    // sampler can difference them into a bytes/sec gauge ([P11]).
    #[cfg(target_os = "macos")]
    let mut disk_last: HashMap<u32, disk::DiskCounters> = HashMap::new();
    // The change gate's per-session reference: what the wire last said.
    let mut published: HashMap<String, PublishedGauges> = HashMap::new();
    let mut ticker = tokio::time::interval(TAPE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = ticker.tick() => {
                let plan = cadence::plan_tick(tick, machine_sampler.tools_known());
                tick = tick.wrapping_add(1);
                if plan != cadence::TickPlan::Walk {
                    if plan == cadence::TickPlan::Tools {
                        machine_sampler.sample_and_publish(&activity);
                    }
                    continue;
                }
                let live = supervisor.live_session_processes().await;
                // Departed sessions get their final zero frame — before the
                // empty-gate below, so the last session's death still flushes.
                let live_ids: HashSet<&str> =
                    live.iter().map(|s| s.tug_session_id.as_str()).collect();
                let departed: Vec<String> = published
                    .keys()
                    .filter(|id| !live_ids.contains(id.as_str()))
                    .cloned()
                    .collect();
                for id in departed {
                    published.remove(&id);
                    let payload =
                        serde_json::json!({ "channels": zeroed_gauge_channels() });
                    if let Ok(bytes) = serde_json::to_vec(&payload) {
                        activity.publish(id.as_str(), &bytes);
                    }
                }
                // Gate the (relatively expensive) full refresh to ticks where
                // at least one session actually has a live pid ([Q02]).
                if live.is_empty() {
                    machine_sampler.learn(HashMap::new());
                    continue;
                }
                system.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing().with_cpu().with_memory(),
                );
                let procs = snapshot_processes(&system);
                let children = children_index(&procs);
                #[cfg(target_os = "macos")]
                let mut disk_seen: HashSet<u32> = HashSet::new();
                let mut walked: HashMap<String, Vec<machine::ProcIdentity>> = HashMap::new();
                for session in &live {
                    let live_start = system
                        .process(Pid::from_u32(session.pid))
                        .map(|p| p.start_time());
                    // Reuse-guard: a recycled/dead pid attributes nothing ([P20]).
                    let same = is_same_process(session.start_time, live_start);
                    let pids = if same {
                        subtree_pids(&procs, &children, session.pid).unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    if same {
                        let tools = machine::tool_subtree_pids(&procs, &children, session.pid)
                            .unwrap_or_default();
                        let ids = tools
                            .into_iter()
                            .filter_map(|pid| procs.get(&pid).map(|n| (pid, n.start_time)))
                            .collect();
                        walked.insert(session.tug_session_id.to_string(), ids);
                    }

                    let mut usage = SubtreeUsage::default();
                    for &pid in &pids {
                        if let Some(node) = procs.get(&pid) {
                            usage.cpu_pct += node.cpu_pct;
                            usage.rss_bytes = usage.rss_bytes.saturating_add(node.rss_bytes);
                        }
                    }

                    // The change gate: only moved channels ride the frame,
                    // and the reference advances exactly when they do.
                    let prev = published.get(session.tug_session_id.as_str()).copied();
                    let first = prev.is_none();
                    let mut next = prev.unwrap_or_default();
                    let mut channels = serde_json::Map::new();
                    if first || cpu_moved(next.cpu_pct, usage.cpu_pct) {
                        channels.insert("cpu_pct".into(), serde_json::json!(usage.cpu_pct));
                        next.cpu_pct = usage.cpu_pct;
                    }
                    if first || rss_moved(next.rss_bytes, usage.rss_bytes) {
                        channels.insert("rss_bytes".into(), serde_json::json!(usage.rss_bytes));
                        next.rss_bytes = usage.rss_bytes;
                    }

                    // Disk I/O (macOS only, [P11]/[Q03]): sum each subtree pid's
                    // per-tick counter delta. A pid's first observation seeds a
                    // baseline and contributes zero (its cumulative counter is
                    // since process start, not since this window). The gauge is
                    // already a per-tick delta, so its change gate is exact
                    // equality — an idle subtree's 0 B/s repeats and is silent.
                    #[cfg(target_os = "macos")]
                    {
                        let mut read_bps = 0u64;
                        let mut write_bps = 0u64;
                        for &pid in &pids {
                            let Some(cur) = disk::proc_disk_counters(pid) else { continue };
                            disk_seen.insert(pid);
                            if let Some(prev) = disk_last.get(&pid).copied() {
                                let d = disk::non_negative_delta(prev, cur);
                                read_bps = read_bps.saturating_add(d.read);
                                write_bps = write_bps.saturating_add(d.write);
                            }
                            disk_last.insert(pid, cur);
                        }
                        if first || read_bps != next.disk_read_bps {
                            channels.insert("disk_read_bps".into(), serde_json::json!(read_bps));
                            next.disk_read_bps = read_bps;
                        }
                        if first || write_bps != next.disk_write_bps {
                            channels.insert("disk_write_bps".into(), serde_json::json!(write_bps));
                            next.disk_write_bps = write_bps;
                        }
                    }

                    if channels.is_empty() {
                        continue;
                    }
                    published.insert(session.tug_session_id.to_string(), next);
                    let payload = serde_json::json!({ "channels": channels });
                    if let Ok(bytes) = serde_json::to_vec(&payload) {
                        activity.publish(session.tug_session_id.as_str(), &bytes);
                    }
                }
                // Drop disk counters for pids no longer in any live subtree so
                // the map can't grow without bound over a long-lived tugcast.
                #[cfg(target_os = "macos")]
                disk_last.retain(|pid, _| disk_seen.contains(pid));
                machine_sampler.learn(walked);
                machine_sampler.sample_and_publish(&activity);
            }
        }
    }
}

/// Read a live process's start time (seconds since the Unix epoch), or `None`
/// if `pid` is not currently a live process. Captured at spawn as the
/// reuse-guard baseline ([P20]): a pid that is later recycled for a different
/// process will report a different start time.
pub fn process_start_time(pid: u32) -> Option<u64> {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).map(|p| p.start_time())
}

/// The PID-reuse guard ([P20]): a session's captured `(pid, start_time)` still
/// names the same process iff the pid is currently live **and** its start time
/// equals the captured baseline. A recycled pid has a different start time; a
/// dead pid has no start time at all. In either case the subtree must not be
/// attributed to the session, so this returns `false` and the sampler emits a
/// zero sample.
pub fn is_same_process(captured_start_time: u64, live_start_time: Option<u64>) -> bool {
    live_start_time == Some(captured_start_time)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reused_pid_with_a_different_start_time_is_rejected() {
        // The session captured its child at start time T. The pid is later
        // recycled for an unrelated process that started at T+5 — the guard
        // must reject it so the new process's work is never attributed.
        assert!(is_same_process(1000, Some(1000)));
        assert!(!is_same_process(1000, Some(1005)));
    }

    #[test]
    fn a_dead_pid_is_not_attributed() {
        // The process exited: no live start time to match, so not attributable.
        assert!(!is_same_process(1000, None));
    }

    fn node(parent: Option<u32>, cpu: f32, rss: u64) -> ProcNode {
        ProcNode {
            parent,
            start_time: 0,
            cpu_pct: cpu,
            rss_bytes: rss,
        }
    }

    /// Sum CPU% + rss over a subtree the way the sampler does inline.
    fn sum_subtree(
        procs: &ProcMap,
        children: &HashMap<u32, Vec<u32>>,
        root: u32,
    ) -> Option<SubtreeUsage> {
        let pids = subtree_pids(procs, children, root)?;
        let mut usage = SubtreeUsage::default();
        for pid in pids {
            if let Some(n) = procs.get(&pid) {
                usage.cpu_pct += n.cpu_pct;
                usage.rss_bytes = usage.rss_bytes.saturating_add(n.rss_bytes);
            }
        }
        Some(usage)
    }

    #[test]
    fn subtree_sum_covers_descendants_and_excludes_outsiders() {
        // root(10) → claude(20) → bash(30); plus an unrelated process(99).
        let mut procs: ProcMap = HashMap::new();
        procs.insert(10, node(None, 5.0, 100));
        procs.insert(20, node(Some(10), 10.0, 200));
        procs.insert(30, node(Some(20), 20.0, 400));
        procs.insert(99, node(None, 77.0, 9_000)); // a second session — excluded
        let children = children_index(&procs);
        let usage = sum_subtree(&procs, &children, 10).expect("root is live");
        // 5+10+20 CPU, 100+200+400 rss — the unrelated 99 is not in the subtree.
        assert_eq!(usage.cpu_pct, 35.0);
        assert_eq!(usage.rss_bytes, 700);
    }

    #[test]
    fn subtree_of_a_dead_root_is_none() {
        let procs: ProcMap = HashMap::new();
        let children = children_index(&procs);
        assert!(subtree_pids(&procs, &children, 10).is_none());
    }

    #[test]
    fn two_same_directory_sessions_are_distinct_subtrees() {
        // Two independent trees under the same conceptual cwd. Each session's
        // subtree sums only its own processes — parentage, not directory,
        // separates them ([P08]).
        let mut procs: ProcMap = HashMap::new();
        procs.insert(10, node(None, 1.0, 10)); // session A root
        procs.insert(11, node(Some(10), 2.0, 20));
        procs.insert(50, node(None, 40.0, 500)); // session B root — busy build
        procs.insert(51, node(Some(50), 60.0, 800));
        let children = children_index(&procs);
        let a = sum_subtree(&procs, &children, 10).unwrap();
        let b = sum_subtree(&procs, &children, 50).unwrap();
        assert_eq!(a.cpu_pct, 3.0);
        assert_eq!(b.cpu_pct, 100.0);
        assert_ne!(a.rss_bytes, b.rss_bytes);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn disk_differencing_is_monotonic_and_non_negative() {
        use super::disk::{DiskCounters, non_negative_delta};
        let last = DiskCounters {
            read: 1_000,
            write: 500,
        };
        // Monotonic growth → the delta is the growth.
        let cur = DiskCounters {
            read: 1_600,
            write: 900,
        };
        let d = non_negative_delta(last, cur);
        assert_eq!(d.read, 600);
        assert_eq!(d.write, 400);
        // A counter that appears to go backward (a child exited, its bytes
        // left the session sum) clamps to zero rather than underflowing.
        let shrunk = DiskCounters {
            read: 400,
            write: 100,
        };
        let d2 = non_negative_delta(last, shrunk);
        assert_eq!(d2.read, 0);
        assert_eq!(d2.write, 0);
    }

    #[test]
    fn change_gate_suppresses_sub_epsilon_jitter_and_passes_real_moves() {
        // CPU breathing under half a percent is not news; a real move is.
        assert!(!cpu_moved(37.2, 37.5));
        assert!(cpu_moved(37.2, 38.0));
        // Memory jitter under 4 MiB is not news; a real allocation is.
        assert!(!rss_moved(500_000_000, 500_000_000 + 1024 * 1024));
        assert!(rss_moved(500_000_000, 500_000_000 + 8 * 1024 * 1024));
        // The gate compares against the last PUBLISHED value, so drift that
        // ratchets in sub-epsilon steps still fires once accumulated: the
        // caller only advances the reference when a channel publishes.
        let published = 37.2_f32;
        assert!(!cpu_moved(published, 37.5)); // reference stays 37.2
        assert!(cpu_moved(published, 37.8)); // accumulated drift crosses
    }

    #[test]
    fn a_departed_session_flushes_every_gauge_to_zero() {
        let channels = zeroed_gauge_channels();
        assert_eq!(channels.get("cpu_pct").and_then(|v| v.as_f64()), Some(0.0));
        assert_eq!(channels.get("rss_bytes").and_then(|v| v.as_u64()), Some(0));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                channels.get("disk_read_bps").and_then(|v| v.as_u64()),
                Some(0)
            );
            assert_eq!(
                channels.get("disk_write_bps").and_then(|v| v.as_u64()),
                Some(0)
            );
        }
    }

    #[test]
    fn reads_a_live_process_start_time() {
        // The test process itself is live, so its own pid yields a start time;
        // a pid that cannot exist (0 is the kernel scheduler, never a sysinfo
        // user process) yields none — and re-reading the same live pid is
        // stable, which is exactly what the guard relies on.
        let me = std::process::id();
        let start = process_start_time(me);
        assert!(
            start.is_some(),
            "the running test process must have a start time"
        );
        assert_eq!(start, process_start_time(me), "start time must be stable");
    }

    // ── The sampler's cadence ────────────────────────────────────────────

    use super::cadence::{TickPlan, plan_tick, refresh_list};

    #[test]
    fn every_fourth_tick_walks_whether_or_not_tools_run() {
        for tools in [false, true] {
            assert_eq!(plan_tick(0, tools), TickPlan::Walk);
            assert_eq!(plan_tick(4, tools), TickPlan::Walk);
            assert_eq!(plan_tick(400, tools), TickPlan::Walk);
        }
    }

    #[test]
    fn the_ticks_between_walks_refresh_tools_only_when_some_are_known() {
        for tick in [1, 2, 3, 5, 6, 7] {
            assert_eq!(plan_tick(tick, true), TickPlan::Tools);
            // An idle instance does no more work than one walk a second.
            assert_eq!(plan_tick(tick, false), TickPlan::Rest);
        }
    }

    #[test]
    fn a_tool_refresh_names_the_wanted_and_the_departed() {
        let wanted: HashSet<u32> = HashSet::from([30, 31]);
        // 31 is held and still wanted; 29 is held and has left every subtree,
        // so it is named too, and the refresh removes it if it has died.
        let (mut list, rebuild) = refresh_list(&wanted, [29, 31]);
        list.sort_unstable();
        assert_eq!(list, vec![29, 30, 31]);
        assert!(!rebuild);
        // Nothing wanted and nothing held: nothing to refresh.
        let (list, rebuild) = refresh_list(&HashSet::new(), []);
        assert!(list.is_empty() && !rebuild);
    }

    #[test]
    fn too_many_held_orphans_rebuild_the_tool_system() {
        let wanted: HashSet<u32> = HashSet::from([30]);
        let orphans = 1_000..(1_000 + super::MAX_HELD_ORPHANS as u32 + 1);
        let (list, rebuild) = refresh_list(&wanted, orphans);
        assert!(rebuild);
        assert_eq!(
            list,
            vec![30],
            "a rebuilt system refreshes the wanted alone"
        );
    }

    // ── The `machine` channel's reading ──────────────────────────────────

    use super::machine::{
        MACHINE_DISK_CAP_UNITS_PER_SEC, MACHINE_UNITS_PER_CORE_SEC, MACHINE_UNITS_PER_SPAWN,
        MachineUnits, ProcIdentity, ToolReading, machine_units, tool_reading, tool_subtree_pids,
    };

    fn proc_at(parent: Option<u32>, start_time: u64, cpu: f32) -> ProcNode {
        ProcNode {
            parent,
            start_time,
            cpu_pct: cpu,
            rss_bytes: 0,
        }
    }

    /// tugcode(10) → claude(20), plus a second session's tree and an outsider.
    fn idle_session() -> ProcMap {
        let mut procs: ProcMap = HashMap::new();
        procs.insert(10, proc_at(None, 100, 0.4));
        procs.insert(20, proc_at(Some(10), 101, 0.3));
        procs.insert(90, proc_at(None, 50, 0.0)); // another session's tugcode
        procs.insert(91, proc_at(Some(90), 51, 0.0));
        procs.insert(92, proc_at(Some(91), 52, 300.0)); // its busy build
        procs
    }

    /// One interval's units for the session rooted at 10.
    fn units_of(
        procs: &ProcMap,
        interval_secs: f64,
        previous: Option<&HashSet<ProcIdentity>>,
    ) -> (ToolReading, MachineUnits) {
        let children = children_index(procs);
        let pids = tool_subtree_pids(procs, &children, 10).expect("root is live");
        let reading = tool_reading(procs, &pids);
        let units = machine_units(interval_secs, &reading, previous);
        (reading, units)
    }

    #[test]
    fn an_idle_tugcode_and_claude_yield_nothing() {
        let procs = idle_session();
        let (reading, units) = units_of(&procs, 1.0, Some(&HashSet::new()));
        assert!(
            reading.identities.is_empty(),
            "neither tugcode nor claude is a tool"
        );
        assert_eq!(units.total(), 0.0);
    }

    #[test]
    fn a_busy_claude_alone_yields_nothing() {
        // The model's client reading its stream is `text` and `tokens`, not
        // machine work, however hard it runs.
        let mut procs = idle_session();
        procs.insert(20, proc_at(Some(10), 101, 85.0));
        let (_, units) = units_of(&procs, 1.0, Some(&HashSet::new()));
        assert_eq!(units.total(), 0.0);
    }

    #[test]
    fn the_tool_subtree_is_everything_below_claude_and_only_that() {
        // tugcode(10) → claude(20) → zsh(30) → cargo(31) → rustc(32), with a
        // second direct child of tugcode (21) and its own child (33).
        let mut procs = idle_session();
        procs.insert(21, proc_at(Some(10), 102, 0.0));
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        procs.insert(31, proc_at(Some(30), 201, 0.0));
        procs.insert(32, proc_at(Some(31), 202, 0.0));
        procs.insert(33, proc_at(Some(21), 203, 0.0));
        let children = children_index(&procs);
        let mut pids = tool_subtree_pids(&procs, &children, 10).unwrap();
        pids.sort_unstable();
        assert_eq!(pids, vec![30, 31, 32, 33]);
        assert!(tool_subtree_pids(&procs, &children, 999).is_none());
    }

    #[test]
    fn a_tool_process_under_the_gate_yields_nothing() {
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 1.5));
        let seen: HashSet<ProcIdentity> = HashSet::from([(30, 200)]);
        let (_, units) = units_of(&procs, 1.0, Some(&seen));
        assert_eq!(units.total(), 0.0);
    }

    #[test]
    fn a_saturated_core_yields_600_units_a_second() {
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        procs.insert(31, proc_at(Some(30), 201, 100.0));
        let seen: HashSet<ProcIdentity> = HashSet::from([(30, 200), (31, 201)]);
        let (_, second) = units_of(&procs, 1.0, Some(&seen));
        assert_eq!(second.cpu, MACHINE_UNITS_PER_CORE_SEC);
        assert_eq!(second.total(), 600.0);
        // A quarter-second interval credits a quarter of it.
        let (_, quarter) = units_of(&procs, 0.25, Some(&seen));
        assert_eq!(quarter.total(), 150.0);
    }

    #[test]
    fn a_new_pid_and_a_recycled_pid_each_count_one_spawn() {
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        procs.insert(31, proc_at(Some(30), 201, 0.0));
        // 31 is new since the last interval.
        let before: HashSet<ProcIdentity> = HashSet::from([(30, 200)]);
        let (_, units) = units_of(&procs, 1.0, Some(&before));
        assert_eq!(units.spawns, MACHINE_UNITS_PER_SPAWN);
        // 31 was seen before, but under an earlier start time: the kernel
        // recycled the pid for a new process, which is a spawn.
        let recycled: HashSet<ProcIdentity> = HashSet::from([(30, 200), (31, 150)]);
        let (_, units) = units_of(&procs, 1.0, Some(&recycled));
        assert_eq!(units.spawns, MACHINE_UNITS_PER_SPAWN);
        // The same set seen again spawns nothing.
        let same: HashSet<ProcIdentity> = HashSet::from([(30, 200), (31, 201)]);
        assert_eq!(units_of(&procs, 1.0, Some(&same)).1.spawns, 0.0);
    }

    #[test]
    fn a_first_reading_is_a_baseline_not_a_burst_of_spawns() {
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        procs.insert(31, proc_at(Some(30), 201, 0.0));
        assert_eq!(units_of(&procs, 1.0, None).1.total(), 0.0);
    }

    #[test]
    fn disk_credits_per_mib_a_second_and_caps() {
        const MIB: u64 = 1024 * 1024;
        let reading = |disk_bytes| ToolReading {
            disk_bytes,
            ..ToolReading::default()
        };
        assert_eq!(machine_units(1.0, &reading(MIB), None).disk, 100.0);
        assert_eq!(machine_units(2.0, &reading(MIB), None).disk, 100.0);
        assert_eq!(
            machine_units(1.0, &reading(10 * MIB), None).disk,
            MACHINE_DISK_CAP_UNITS_PER_SEC
        );
        // The cap is a rate: a quarter-second interval caps at a quarter.
        assert_eq!(machine_units(0.25, &reading(10 * MIB), None).disk, 150.0);
    }

    // ── Publishing `machine` ─────────────────────────────────────────────

    /// What the sampler publishes for the session rooted at 10 over one
    /// 250 ms tick, given the tool processes its last reading saw.
    fn machine_frame(
        procs: &ProcMap,
        previous: &HashSet<ProcIdentity>,
    ) -> Option<serde_json::Map<String, serde_json::Value>> {
        let (_, units) = units_of(procs, 0.25, Some(previous));
        super::machine_channels(units.total())
    }

    #[test]
    fn a_busy_tool_subtree_publishes_a_machine_frame() {
        // tugcode → claude → zsh → cargo, cargo on two cores.
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        procs.insert(31, proc_at(Some(30), 201, 200.0));
        let seen: HashSet<ProcIdentity> = HashSet::from([(30, 200), (31, 201)]);
        let channels = machine_frame(&procs, &seen).expect("busy work is news");
        assert_eq!(channels.len(), 1, "the frame carries `machine` alone");
        // Two cores for a quarter second: 2 × 600 × 0.25.
        assert_eq!(channels.get("machine").and_then(|v| v.as_u64()), Some(300));
    }

    #[test]
    fn an_idle_session_publishes_nothing_on_machine() {
        // Nothing below claude.
        let procs = idle_session();
        assert!(machine_frame(&procs, &HashSet::new()).is_none());
        // A tool process idling under the gate.
        let mut waiting = idle_session();
        waiting.insert(30, proc_at(Some(20), 200, 0.3));
        assert!(machine_frame(&waiting, &HashSet::from([(30, 200)])).is_none());
    }

    #[test]
    fn a_short_command_publishes_its_spawn() {
        // A process that used no measurable CPU in its tick still arrived.
        let mut procs = idle_session();
        procs.insert(30, proc_at(Some(20), 200, 0.0));
        let channels = machine_frame(&procs, &HashSet::new()).expect("a spawn is news");
        assert_eq!(channels.get("machine").and_then(|v| v.as_u64()), Some(60));
    }

    #[test]
    fn machine_units_that_round_to_nothing_send_nothing() {
        assert!(super::machine_channels(0.0).is_none());
        assert!(super::machine_channels(0.4).is_none());
        assert!(super::machine_channels(f64::NAN).is_none());
        assert_eq!(
            super::machine_channels(0.6).and_then(|c| c.get("machine").and_then(|v| v.as_u64())),
            Some(1)
        );
    }
}
