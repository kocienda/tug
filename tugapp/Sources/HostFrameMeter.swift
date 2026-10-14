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
final class HostFrameMeter: NSObject {
    private weak var view: NSView?
    private var link: CADisplayLink?
    private var endWork: DispatchWorkItem?
    private weak var sampledLayer: CALayer?

    /// Host time (`CACurrentMediaTime`, s) the meter was armed at.
    private(set) var armedAt: CFTimeInterval = 0
    private var windowMs: Double = 0
    private var timestampsMs: [Double] = []
    private var periodsMs: [Double] = []
    private var samples: [(t: Double, x: Double, y: Double, opacity: Double)] = []

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
        stop()
        guard let view else { return }
        self.windowMs = Double(max(0, windowMs))
        timestampsMs = []
        periodsMs = []
        samples = []
        sampledLayer = layer
        armedAt = CACurrentMediaTime()
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        let end = DispatchWorkItem { [weak self] in self?.stop() }
        endWork = end
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(windowMs), execute: end)
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
        if let layer = sampledLayer {
            let shown = layer.presentation() ?? layer
            samples.append((
                t: t,
                x: Double(shown.position.x),
                y: Double(shown.position.y),
                opacity: Double(shown.opacity)
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
    /// default), in Spec S06's `HostFrameReading` shape.
    func read(fromMs: Double = 0, toMs: Double? = nil) -> [String: Any] {
        let end = toMs ?? windowMs
        var reading = FrameMeterStats.summarize(
            timestampsMs: timestampsMs,
            periodMs: periodMs,
            windowStartMs: fromMs,
            windowEndMs: end
        ).dictionary
        if sampledLayer != nil || !samples.isEmpty {
            reading["samples"] = samplesIn(fromMs: fromMs, toMs: end).map {
                ["t": $0.t, "x": $0.x, "y": $0.y, "opacity": $0.opacity]
            }
        }
        return reading
    }

    /// The share of ticks over `[fromMs, toMs]` on which the sampled layer's
    /// presentation position moved.
    func presentationAdvancedRatio(fromMs: Double, toMs: Double) -> Double {
        FrameMeterStats.advanceRatio(samplesIn(fromMs: fromMs, toMs: toMs).map { (x: $0.x, y: $0.y) })
    }

    private func samplesIn(fromMs: Double, toMs: Double) -> [(t: Double, x: Double, y: Double, opacity: Double)] {
        samples.filter { $0.t >= fromMs && $0.t <= toMs }
    }
}
