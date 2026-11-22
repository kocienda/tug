# The GPU wedge that locks the Mac

**Purpose:** Three times in six days the Mac had to be rebooted. Tug hung on its splash screen, and other apps stopped working too; Safari could not load pages. The suspected cause was a resource leak in Tug. The evidence points somewhere else: macOS's shared web-view graphics service gets stuck for the whole machine. This brief records what was found, the one real Tug defect it turned up, and what Tug should do about both.

---

## Purpose {#purpose}

The user's report, on the morning of 2026-11-22: "Tug was locked up. Would not launch. Stuck on splash screen. Not only that, other apps were blocked too, like I couldn't load web pages in Safari. This is the second time this has happened in the last few days. I suspect we have a serious resource leak of some sort in Tug."

The boot record shows forced reboots on Nov 16 (12:19), Nov 17 (15:18) and Nov 22 (06:33), each with a `shutdown_stall` report in `/Library/Logs/DiagnosticReports/`. Today's was investigated live, against the unified log and Tug's own logs. The older incidents could be checked only through Tug's logs, because the macOS logs from then have expired.

---

## Evidence {#evidence}

**[F01] The lockup is a hung WebKit GPU process in every app, not only Tug.** Between 06:28 and 06:32 on Nov 22, the unified log shows `GPUProcessProxy::didBecomeUnresponsive: GPUProcess with PID N became unresponsive, terminating it` from Tug, Tug-debug, **Safari** and `nsattributedstringagent`. Every app that shows web content hands its rendering to one of these GPU processes, so Safari could not render pages. In Tug, `loadURL` was issued at 06:28:38.9, the GPU process was declared unresponsive at 06:28:42 and again at 06:28:57, and the page did not report loaded until 06:28:54, 15 s after `loadURL`. Card bodies then failed `cause=deadline`, and the WebContent process was "terminated again — not reloading" (`instances/release-main/Logs/tugapp.log.2026-11-22`). **(verified)**

**[F02] The wedge started inside an app-test batch the night before, and outlived every Tug process.** From 20:17:52 on Nov 21, every `Tug-apptest` instance's GPU process went unresponsive within seconds of launch: 23 hangs by 20:19. The release Tug quit cleanly at 20:19 ("tugcast stopped … sigkills=0"). After that, `nsattributedstringagent`'s GPU process hung at 21h and again at 03h, when no Tug process was running. So the broken state lived in a shared system component (WindowServer or the GPU driver), not in any Tug process, and only a reboot cleared it. The machine slept between about 20:20 and 06:26. **(verified)**

**[F03] Nov 16 shows the same signature on Tug's side, after a heavy app-test hour.** At 12:17 local, `loadURL` → `page loaded` took 16,657 ms. Body deadlines failed, and the WebContent process was "terminated again — not reloading". The reboot came two minutes later. According to `apptest_results.db`, 11h–12h that day were its heaviest app-test hours: 35 runs over 260 files. The macOS logs from then have expired, so the GPU hang itself is **not verified** for Nov 16. Nov 17's incident does not show this signature in Tug's log, and no app-test batch came right before it, so its cause is unknown.

**[F04] Nothing ran out: not memory, file descriptors, processes or vnodes.** The kernel log between Nov 21 20:00 and the reboot has no `memorystatus`, jetsam, `maxproc`, "too many", zone-map or mbuf messages. The stall report shows 74.5% of vnodes free on a 128 GB machine. Tug's WebKit data stores are small (`~/Library/WebKit/dev.tugapp.app` is 840 KB). **(verified)**

**[F05] Tug's GPU surfaces do not grow while idle.** Fifteen minutes after launch, the release Tug (PID 1773) held about 900–914 IOSurfaces totalling 328 MB (peak footprint 1,138 MB), and its GPU process (PID 1775) held about 1,887–1,925 IOSurface mappings. Two samples a minute apart were flat. Growth under heavy card activity was not measured. **(verified, idle only)**

**[F06] Tug's GPU process spins on a dead message port for the whole session.** It logs `IPC::Signal::signal Could not send mach message, error 10000003` (`MACH_SEND_INVALID_DEST`), meaning it keeps signalling a peer whose receiving end is gone. Last night's release GPU process (PID 97146, owned by Tug PID 97140) did it from its spawn at 18:55 until 20:19: 53,650 failures between 19:50 and 20:20, about 1,500–2,200 a minute. Today's (PID 1775) was doing it at 600–2,000 a minute from the moment it launched. What leaves the dangling peer has not been found. **(verified as behaviour; cause unknown)**

**[F07] App-test instances die with a crash when their runner goes away, and leave debris.** Both `Tug-apptest` crashes at 20:18 on Nov 21 were SIGABRT. Foundation raised an exception in `-[NSConcreteFileHandle writeData:]` from `TestHarnessConnection.respond(id:ok:payload:)` inside `dispatchWaitForCondition`, because the harness pipe was closed. The batch at 20h never reached `apptest_results.db`. At the next launch, the janitor swept `sockets=221 tmux_sockets=235 data_dirs=14`, several times its usual count. **(verified)**

**[F08] Parallel app-test instances share one GPU and capture the window repeatedly.** `tests/app-test/scripts/app-test.sh` runs `TUG_APPTEST_JOBS` instances at once, 4 by default. Frame-judged tests arm `HostFrameMeter`, which calls `captureOwnWindowImage` (a `CGWindowListCreateImage` resolved with `dlsym`, in `tugapp/Sources/MainWindow.swift`) in a timed loop. Each call is a composited read-back from WindowServer. Whether this caused [F02] is **inference, not verified**. WindowServer's error rate did rise to 197–273 a minute at 20:14–20:16, and the GPU processes' errors doubled to about 4,000–4,500 a minute, just before the first hang.

**[F09] Other software on the machine was misbehaving, but none of it explains the wedge.** Overnight, `system/com.avid.sibelius` exited 4,596 times (a crash loop), which kept `ReportCrash` busy. Karabiner's `org.pqrs` services caused about 7,000 launch-disposition checks in `smd` and `backgroundtaskmanagementd`. The HID plug-in error burst in WindowServer at 06:27 is wake-time device enumeration. **(verified)**

---

## Decisions {#decisions}

**[B01] Treat this as a system GPU wedge that Tug can trigger or worsen, not as a leak inside a Tug process.** [F02] shows the broken state surviving every Tug process, and [F04]/[F05] find no growing Tug resource. So work aimed at Tug's memory, descriptors or processes would chase the wrong thing. This would be revisited if a Tug-owned resource is ever measured growing up to an incident.

**[B02] The next incident must be captured while it is happening.** The cause of [F02] cannot be proved from logs after the fact. When a page load runs past its budget, or WebKit reports an unresponsive GPU process, Tug writes a reading into the instance's `stalls/` directory:
- the recent unified-log lines for the GPU processes;
- `footprint` of Tug and its GPU process;
- a process list with ages;
- the app-test gate's holder.

That way the next occurrence arrives with its evidence attached. This comes first because every later fix would otherwise be a guess.

**[B03] Once the wedge is confirmed, Tug says what it is and stops reloading.** A second GPU hang, or a freshly spawned page that also stalls, counts as a wedge. Tug then replaces the silent splash with a notice: the Mac's graphics service is stuck, other apps are affected too, and restarting the Mac is the remedy. Tug cannot clear the state ([F02]), so the honest act is to say so rather than leave the user to work it out. A single hang only raises suspicion, because WebKit can recover from one.

**[B04] App-test batches check GPU health before they start and halt at the first wedge.** [F02] and [F03] put the strongest correlate in app-test batches. A runner that keeps launching instances onto a stuck GPU makes things worse and records nothing useful. Halting means no new instances are launched, the run is recorded as stopped and why, and the instances already running are let go.

**[B05] The harness exits cleanly when its runner goes away.** A write to a closed harness pipe should end the instance in an orderly way, not abort on a raised exception ([F07]). That removes the crash reports from every interrupted batch and lets the instance clean up its own sockets, tmux socket and data directory, instead of leaving them for the next janitor sweep.

**[B06] The dead-port spin in Tug's GPU process is a defect and gets fixed, whether or not it caused the wedge.** [F06] is live, steady and measurable: tens of failed sends a second, all session, into the system log. It is found by counting the failures against each web-view lifecycle event (launch, card open and close, dormancy, content-process reload, snapshots) until one is seen to leave a dangling peer. That lifecycle is then fixed.

**[B07] Window capture under parallel app-tests is tested as a cause, not assumed.** [F08] is a plausible trigger, but it is inference. If the readings from [B02] show a capture burst under parallel instances just before the next wedge, frame-capture tests run one at a time. Until then, no app-test is serialized on this account.

---

## Open Questions {#open-questions}

- **What actually wedges the shared GPU service?** It could be the window-capture read-backs ([F08]), the dead-port spin ([F06]), the load of parallel instances, or a macOS 27.0.1 defect that any heavy WebKit load can trigger. Only a reading taken during an incident ([B02]) can settle it.
- **Which lifecycle event leaves the GPU process signalling a dead peer?** Measuring it ([B06]) will tell. Whether its cause is in Tug or in WebKit decides whether the fix is in Tug's code or in a workaround.
- **What signal does the host have for "GPU process unresponsive"?** WebKit's public API reports content-process termination but not GPU-process hangs. [B02] and [B03] may have to rely on the load-time budget plus content-process terminations rather than the GPU message itself. This needs reading against the WebKit API and SPI that Tug already uses.
- **Nov 17's cause.** It does not show the [F01] signature, and no batch came right before it. It may be the same wedge reached another way, or something unrelated. Nothing on disk can settle it now.

---

## Non-goals {#non-goals}

- **A hunt for memory, descriptor or process leaks in Tug.** [F04] and [F05] found none, and [F02] places the stuck state outside Tug's processes.
- **Clearing the wedge from inside Tug.** WindowServer and the GPU driver are not Tug's to restart, and a reboot is the only known reset. Tug's part is to name the wedge and stop adding load ([B03], [B04]).
- **Fixing Sibelius's or Karabiner's behaviour.** That is real load on this machine ([F09]), but it belongs to the user's setup, not to Tug.
- **Lowering `TUG_APPTEST_JOBS` or serializing frame tests now.** That waits on evidence ([B07]). Slowing every app-test run on a guess is a cost with no proven return.

---

## Exit {#exit}

**An arc.** The first steps sketched, in the order they should land:

1. Incident capture ([B02]): the trigger, and the reading written into `stalls/`. This goes first so that everything after it has evidence to stand on.
2. The wedge notice and the stop on reload ([B03]).
3. The app-test runner's health check before a batch and its halt on a wedge ([B04]), plus the harness's clean exit on a closed pipe ([B05]). Both live in the test harness and can land together.
4. Find and fix the dead-port spin ([B06]), by bisecting it against web-view lifecycle events in a release build.
5. The window-capture question ([B07]) waits for the next captured incident, and may need no change at all.
