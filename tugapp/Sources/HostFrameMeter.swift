import AppKit
import QuartzCore

/// The host's own frame meter: a display link on the window's view, armed
/// for a bounded window.
///
/// The deck's frame instruments all live in a page, so they share that page's
/// main thread — a stalled page stops its own meter, and nothing in a page can
/// say what the window did meanwhile. This one runs in the UI process, where a
/// busy WebContent process does not reach, so it reads what the render server
/// was asked to show. `NSView.displayLink(target:selector:)` follows the
/// window's screen without wiring, and `CVDisplayLink` is deprecated.
///
/// Each tick records the link's `timestamp`; with a layer to sample, it also
/// records that layer's `presentation()` position and opacity, which is what
/// tells a container the render server is moving from one that has stalled,
/// and what reads a fade's ramp. Nothing runs while it is not armed: the link
/// is created by `arm` and invalidated at the window's end.
///
/// It samples any number of named layers, and a layer may join while the
/// meter is armed: a body's container is named by its card id when a beat
/// plan carries it, with the windows its beats move it in, so a reading of
/// the window says per body whether its presentation advanced on every tick
/// it was meant to (`BodyViewController.runPlan`).
final class HostFrameMeter: NSObject {
    /// The name a single sampled layer goes under, whose samples `read`
    /// also reports flat, as it always has.
    static let singleLayerName = "layer"

    private struct Track {
        weak var layer: CALayer?
        var samples: [(t: Double, x: Double, y: Double, opacity: Double, width: Double, height: Double)] = []
        /// Spans from arming, ms, over which the layer is meant to move.
        var active: [(fromMs: Double, toMs: Double)] = []
    }

    private weak var view: NSView?
    private var link: CADisplayLink?
    private var endWork: DispatchWorkItem?
    private var tracks: [String: Track] = [:]

    /// Host time (`CACurrentMediaTime`, s) the meter was armed at.
    private(set) var armedAt: CFTimeInterval = 0
    /// The wall clock (`Date`, ms since 1970) at the same instant, so a page
    /// that marks its events with `performance.timeOrigin` can place them.
    private(set) var armedWallMs: Double = 0
    private var windowMs: Double = 0
    private var timestampsMs: [Double] = []
    private var periodsMs: [Double] = []

    init(view: NSView) {
        self.view = view
    }

    deinit {
        stop()
    }

    var isArmed: Bool { link != nil }

    /// Start a reading of `windowMs`, sampling `layer`'s presentation per tick
    /// when given. Re-arming discards the previous reading.
    func arm(windowMs: Int, sampling layer: CALayer? = nil) {
        arm(windowMs: windowMs, sampling: layer.map { [Self.singleLayerName: $0] } ?? [:])
    }

    /// Start a reading of `windowMs`, sampling each named layer's presentation
    /// per tick. Re-arming discards the previous reading.
    func arm(windowMs: Int, sampling layers: [String: CALayer]) {
        stop()
        guard let view else { return }
        self.windowMs = Double(max(0, windowMs))
        timestampsMs = []
        periodsMs = []
        tracks = layers.mapValues { Track(layer: $0) }
        armedAt = CACurrentMediaTime()
        armedWallMs = Date().timeIntervalSince1970 * 1000
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        let end = DispatchWorkItem { [weak self] in self?.stop() }
        endWork = end
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(windowMs), execute: end)
    }

    /// Sample `layer` under `name` from now on, meant to move over each of
    /// `active` (media times, s). A name already sampled keeps its samples
    /// and gains the spans. Nothing while the meter is not armed.
    func track(_ layer: CALayer, named name: String, active: [(from: CFTimeInterval, to: CFTimeInterval)]) {
        guard isArmed else { return }
        var track = tracks[name] ?? Track(layer: layer)
        track.layer = layer
        track.active += active.map { (fromMs: msSinceArm($0.from), toMs: msSinceArm($0.to)) }
        tracks[name] = track
    }

    /// `name` stopped being meant to move at `mediaTime` (s): a newer plan
    /// or a placement took its beats. Its spans end there, and a span that
    /// had not begun is dropped.
    func cut(named name: String, at mediaTime: CFTimeInterval) {
        guard var track = tracks[name] else { return }
        let at = msSinceArm(mediaTime)
        track.active = track.active.compactMap { span in
            span.fromMs >= at ? nil : (fromMs: span.fromMs, toMs: min(span.toMs, at))
        }
        tracks[name] = track
    }

    /// Invalidate the link. The reading is kept for `read`.
    func stop() {
        endWork?.cancel()
        endWork = nil
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        let t = (link.timestamp - armedAt) * 1000
        timestampsMs.append(t)
        let period = (link.targetTimestamp - link.timestamp) * 1000
        if period > 0 { periodsMs.append(period) }
        for name in tracks.keys {
            guard let layer = tracks[name]?.layer else { continue }
            let shown = layer.presentation() ?? layer
            tracks[name]?.samples.append((
                t: t,
                x: Double(shown.position.x),
                y: Double(shown.position.y),
                opacity: Double(shown.opacity),
                width: Double(shown.bounds.width),
                height: Double(shown.bounds.height)
            ))
        }
    }

    /// The link's display period, as the ticks reported it; 60 Hz before any.
    var periodMs: Double {
        guard !periodsMs.isEmpty else { return 1000.0 / 60.0 }
        return periodsMs.sorted()[periodsMs.count / 2]
    }

    /// Ms from arming of a host time, for a caller that marks its own events
    /// on the meter's clock.
    func msSinceArm(_ hostTime: CFTimeInterval) -> Double {
        (hostTime - armedAt) * 1000
    }

    /// The reading over `[fromMs, toMs]` from arming (the whole window by
    /// default), with `armedWallMs` and, per sampled name, its samples, its
    /// active spans, and over those spans the share of ticks it advanced on
    /// and its longest still run.
    func read(fromMs: Double = 0, toMs: Double? = nil) -> HostFrameReading {
        let end = toMs ?? windowMs
        let summary = FrameMeterStats.summarize(
            timestampsMs: timestampsMs,
            periodMs: periodMs,
            windowStartMs: fromMs,
            windowEndMs: end
        )
        let sampled = { (s: [(t: Double, x: Double, y: Double, opacity: Double, width: Double, height: Double)]) -> [HostFrameReading.Sample] in
            s.map { HostFrameReading.Sample(t: $0.t, x: $0.x, y: $0.y, opacity: $0.opacity) }
        }
        var layers: [String: HostFrameReading.Layer] = [:]
        for (name, track) in tracks {
            var moved = 0
            var pairs = 0
            var worstStill = 0.0
            for span in track.active {
                let inSpan = samplesIn(name, fromMs: span.fromMs, toMs: span.toMs)
                guard inSpan.count > 1 else { continue }
                // Position and size both: a container is origin-anchored, so a
                // beat that only resizes it moves its bounds and not its position.
                let states = inSpan.map { (t: $0.t, state: [$0.x, $0.y, $0.width, $0.height]) }
                pairs += states.count - 1
                moved += Int((FrameMeterStats.advanceRatio(states: states.map(\.state)) * Double(states.count - 1)).rounded())
                worstStill = max(worstStill, FrameMeterStats.worstStillMs(states: states))
            }
            layers[name] = HostFrameReading.Layer(
                samples: sampled(samplesIn(name, fromMs: fromMs, toMs: end)),
                active: track.active.map { HostFrameReading.Span(fromMs: $0.fromMs, toMs: $0.toMs) },
                activeTicks: pairs,
                advancedRatio: pairs > 0 ? Double(moved) / Double(pairs) : nil,
                worstStillMs: worstStill
            )
        }
        return HostFrameReading(
            summary: summary,
            armedWallMs: armedWallMs,
            tickMs: timestampsMs.filter { $0 >= fromMs && $0 <= end },
            samples: tracks[Self.singleLayerName] != nil
                ? sampled(samplesIn(Self.singleLayerName, fromMs: fromMs, toMs: end)) : nil,
            layers: layers
        )
    }

    /// The share of ticks over `[fromMs, toMs]` on which the sampled layer's
    /// presentation position moved.
    func presentationAdvancedRatio(fromMs: Double, toMs: Double) -> Double {
        FrameMeterStats.advanceRatio(
            samplesIn(Self.singleLayerName, fromMs: fromMs, toMs: toMs).map { (x: $0.x, y: $0.y) }
        )
    }

    private func samplesIn(
        _ name: String, fromMs: Double, toMs: Double
    ) -> [(t: Double, x: Double, y: Double, opacity: Double, width: Double, height: Double)] {
        (tracks[name]?.samples ?? []).filter { $0.t >= fromMs && $0.t <= toMs }
    }
}

/// A burst of composited window captures for the harness: the window as the
/// window server drew it, every `intervalMs` for `durationMs`, each cropped
/// to a rect in content points and written as a PNG. What a frame-by-frame
/// reading of a reveal or a departure compares against is the colour the
/// composite shows in a rect — the body's own surface, the shell's canvas
/// floor, the bare window background — and a single `captureWindow` sees one
/// frame of it, chosen by the test's timing. The burst sees every frame.
///
/// The captures run on a queue of their own so the cadence does not load
/// the main thread the display link ticks on; the PNGs are encoded on a
/// second queue so a slow encode does not stretch the interval. `read`
/// answers what has landed, and `done` once both have finished.
///
/// A burst armed with an `outDir` writes its frames as `frame-NNNN.png`
/// (NNNN the frame's capture index) and, once every frame is on disk, a
/// `reading.json` carrying what `read` answers, straight into that
/// directory, so a recording lands where it is wanted rather than being
/// copied out of the temporary location. `mark` stamps the index of the
/// next frame captured under a name; the marks ride the reading, so a
/// scene's loop points are the host's own count rather than a search over
/// frame timestamps.
final class CaptureBurst {
    /// The most a burst may run for. A clip's crop and interval are what
    /// keep its frames within their use; the cap only bounds a runaway.
    static let maxDurationMs = 30_000
    /// The shortest interval: the display's own period, near enough.
    static let minIntervalMs = 8

    struct Frame: Encodable {
        /// The frame's capture index, which `marks` point at and which names
        /// the file under an `outDir`.
        let index: Int
        /// Ms from arming, host clock.
        let t: Double
        /// Wall-clock ms (`Date().timeIntervalSince1970 * 1000`) at capture,
        /// for a reader that marks shell events with `Date.now()`.
        let wall: Double
        let path: String
    }

    private let captureQueue = DispatchQueue(label: "dev.tugapp.harness.capture-burst.capture")
    private let encodeQueue = DispatchQueue(label: "dev.tugapp.harness.capture-burst.encode")
    private let lock = NSLock()
    private var frames: [Frame] = []
    private var captured = 0
    private var encoded = 0
    private var captureFinished = false
    private var marks: [String: Int] = [:]
    /// Set once `reading.json` is on disk under `outDir`; always true without one.
    private var readingWritten: Bool

    private let windowNumber: CGWindowID
    private let durationMs: Int
    private let intervalMs: Int
    /// The crop in device pixels of the window image, or nil for the whole.
    private let cropPx: CGRect?
    /// Where the frames and `reading.json` go, or nil for the temporary location.
    private let outDir: URL?
    /// Reported back so a reader can place the crop in content points.
    let crop: CGRect?
    let scale: CGFloat
    let contentSize: CGSize
    let windowBackgroundHex: String
    let armedAt: CFTimeInterval

    /// `crop` is in the window's content points, top-left origin. `outDir`,
    /// when given, is made if missing.
    init(window: NSWindow, crop: CGRect?, durationMs: Int, intervalMs: Int, outDir: String? = nil) {
        let scale = window.backingScaleFactor
        let contentSize = window.contentView?.bounds.size ?? .zero
        windowNumber = CGWindowID(window.windowNumber)
        self.durationMs = min(max(0, durationMs), CaptureBurst.maxDurationMs)
        self.intervalMs = max(CaptureBurst.minIntervalMs, intervalMs)
        self.scale = scale
        self.contentSize = contentSize
        self.crop = crop
        let dir = outDir.map { URL(fileURLWithPath: $0, isDirectory: true) }
        if let dir {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        self.outDir = dir
        readingWritten = dir == nil
        let frameHeightPx = window.frame.height * scale
        let titleBarPx = frameHeightPx - contentSize.height * scale
        cropPx = crop.map { c in
            CGRect(
                x: c.minX * scale,
                y: titleBarPx + c.minY * scale,
                width: c.width * scale,
                height: c.height * scale
            ).integral
        }
        let bg = window.backgroundColor.usingColorSpace(.sRGB) ?? .black
        windowBackgroundHex = String(
            format: "#%02x%02x%02x",
            Int(round(bg.redComponent * 255)),
            Int(round(bg.greenComponent * 255)),
            Int(round(bg.blueComponent * 255))
        )
        armedAt = CACurrentMediaTime()
    }

    func start() {
        captureQueue.async { [self] in
            let end = armedAt + Double(durationMs) / 1000
            let interval = Double(intervalMs) / 1000
            var next = armedAt
            while CACurrentMediaTime() < end {
                let now = CACurrentMediaTime()
                if now < next {
                    usleep(UInt32((next - now) * 1_000_000))
                    continue
                }
                next += interval
                lock.lock()
                let index = captured
                lock.unlock()
                let t = (CACurrentMediaTime() - armedAt) * 1000
                let wall = Date().timeIntervalSince1970 * 1000
                guard let whole = captureOwnWindowImage(windowNumber) else { continue }
                let image = cropPx.flatMap { whole.cropping(to: $0) } ?? whole
                lock.lock()
                captured += 1
                lock.unlock()
                encodeQueue.async { [self] in
                    let path = outDir.map { $0.appendingPathComponent(String(format: "frame-%04d.png", index)).path }
                        ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("tugapp-burst-\(UUID().uuidString).png")
                    let rep = NSBitmapImageRep(cgImage: image)
                    if let png = rep.representation(using: .png, properties: [:]),
                       (try? png.write(to: URL(fileURLWithPath: path))) != nil {
                        lock.lock()
                        frames.append(Frame(index: index, t: t, wall: wall, path: path))
                        lock.unlock()
                    }
                    lock.lock()
                    encoded += 1
                    lock.unlock()
                }
            }
            lock.lock()
            captureFinished = true
            lock.unlock()
            // The encode queue is serial, so a block queued here runs after
            // the last frame's encode: every PNG is on disk when it writes.
            if let outDir {
                encodeQueue.async { [self] in
                    lock.lock()
                    var reading = snapshot()
                    lock.unlock()
                    reading.done = true
                    if let data = try? JSONEncoder().encode(reading) {
                        try? data.write(to: outDir.appendingPathComponent("reading.json"))
                    }
                    lock.lock()
                    readingWritten = true
                    lock.unlock()
                }
            }
        }
    }

    /// Stamp the index of the next frame captured under `name`. A name
    /// marked twice keeps the later index.
    func mark(_ name: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        marks[name] = captured
        return captured
    }

    /// A burst's reading: whether every frame is written, each frame's file,
    /// and what a reader needs to place them — in the harness's shape.
    struct Reading: Encodable {
        struct Crop: Encodable {
            var x: Double
            var y: Double
            var width: Double
            var height: Double
        }

        var done: Bool
        var frames: [Frame]
        var scale: Double
        var contentWidth: Double
        var contentHeight: Double
        var windowBackground: String
        var intervalMs: Int
        var durationMs: Int
        /// Absent for a burst of the whole window.
        var crop: Crop?
        /// Each mark's name and the capture index it stamped.
        var marks: [String: Int]
        /// Where the frames and `reading.json` went; absent for the temporary location.
        var outDir: String?
    }

    /// The reading so far. `done` holds once every frame is encoded and,
    /// under an `outDir`, `reading.json` is written too.
    func read() -> Reading {
        lock.lock()
        defer { lock.unlock() }
        return snapshot()
    }

    /// The reading under the lock, which the caller holds.
    private func snapshot() -> Reading {
        return Reading(
            done: captureFinished && encoded == captured && readingWritten,
            frames: frames.sorted { $0.t < $1.t },
            scale: Double(scale),
            contentWidth: Double(contentSize.width),
            contentHeight: Double(contentSize.height),
            windowBackground: windowBackgroundHex,
            intervalMs: intervalMs,
            durationMs: durationMs,
            crop: crop.map { .init(x: $0.minX, y: $0.minY, width: $0.width, height: $0.height) },
            marks: marks,
            outDir: outDir?.path
        )
    }
}
