/**
 * physics.ts -- Pre-computed physics solvers for TugAnimator.
 *
 * Provides SpringSolver, GravitySolver, and FrictionSolver. Each class
 * accepts physics parameters and pre-computes a keyframes array suitable
 * for WAAPI's keyframes parameter. Solvers run on creation via fixed-timestep
 * integration at 1/60s; WAAPI handles per-frame interpolation.
 *
 * All solvers cap output at 300 keyframes (5 seconds at 60fps) to prevent
 * performance issues for long durations.
 *
 * Normalized output convention (consistent across all solvers):
 *   SpringSolver:   0.0 = rest (start),   1.0 = target (end), overshoot possible
 *   GravitySolver:  1.0 = drop height,    0.0 = ground (rest)
 *   FrictionSolver: 0.0 = start position, 1.0 = asymptotic rest position
 *
 * Callers map the [0, 1] (or [0, >1]) output to CSS property values by
 * multiplying by the desired displacement.
 */

/** Maximum number of keyframes produced by any solver (5s at 60fps). */
const MAX_KEYFRAMES = 300;

/** Fixed integration timestep in seconds (1/60s). */
const DT = 1 / 60;

// ---------------------------------------------------------------------------
// SpringSolver
// ---------------------------------------------------------------------------

/**
 * SpringSolver -- damped harmonic oscillator.
 *
 * Solves the ODE: x'' = -(stiffness/mass) * x - (damping/mass) * x'
 * via semi-implicit Euler integration:
 *   v_new = v + a * dt
 *   x_new = x + v_new * dt
 *
 * Output is normalized position in [0, 1] (with possible overshoot > 1 for
 * underdamped configurations). Position starts at 0 (rest), converges to 1
 * (target). The final keyframe is always clamped to exactly 1.0 so WAAPI
 * always reaches the target value regardless of convergence speed.
 */
export class SpringSolver {
  private readonly mass: number;
  private readonly stiffness: number;
  private readonly damping: number;
  private readonly initialVelocity: number;

  constructor(params: {
    mass?: number;
    stiffness?: number;
    damping?: number;
    initialVelocity?: number;
  } = {}) {
    this.mass = params.mass ?? 1;
    this.stiffness = params.stiffness ?? 100;
    // Default: critically damped (ζ = 1). damping = 2 * sqrt(stiffness * mass).
    // No overshoot — smooth convergence to target. Pass a lower value for bounce.
    this.damping = params.damping ?? 2 * Math.sqrt((params.stiffness ?? 100) * (params.mass ?? 1));
    this.initialVelocity = params.initialVelocity ?? 0;
  }

  /**
   * Pre-compute normalized position keyframes over the given duration.
   * Returns an array of values (0 to 1, with possible overshoot).
   * Array length is capped at MAX_KEYFRAMES (300).
   * The final value is clamped to exactly 1.0.
   */
  keyframes(durationMs: number): number[] {
    const durationS = durationMs / 1000;
    const steps = Math.min(Math.ceil(durationS / DT), MAX_KEYFRAMES);

    // Spring is offset so that x = 0 is the rest (start) position and the
    // target is at x = 1. We model x as displacement from target:
    //   displacement = position - 1
    //   x = 0 means position = 0 (start, maximum displacement from target)
    // Actually, simpler to model position directly:
    //   position starts at 0, target is 1.
    //   Force = -stiffness * (position - 1) - damping * velocity
    //         = stiffness * (1 - position) - damping * velocity

    const result: number[] = [];
    let pos = 0; // normalized position, starts at 0
    let vel = this.initialVelocity; // initial velocity

    const kOverM = this.stiffness / this.mass;
    const dOverM = this.damping / this.mass;

    for (let i = 0; i < steps; i++) {
      result.push(pos);
      const acc = kOverM * (1 - pos) - dOverM * vel;
      vel = vel + acc * DT;
      pos = pos + vel * DT;
    }

    // Clamp final value to exactly 1.0 to ensure visual completion.
    if (result.length > 0) {
      result[result.length - 1] = 1.0;
    }

    return result;
  }

  /**
   * Return the instantaneous velocity at time t (in milliseconds).
   * Re-runs the integration up to t -- call only when needed (e.g., velocity
   * matching on animation interruption).
   */
  velocityAt(tMs: number): number {
    if (tMs <= 0) {
      return this.initialVelocity;
    }

    const tS = tMs / 1000;
    const steps = Math.min(Math.ceil(tS / DT), MAX_KEYFRAMES);

    const kOverM = this.stiffness / this.mass;
    const dOverM = this.damping / this.mass;

    let pos = 0;
    let vel = this.initialVelocity;

    for (let i = 0; i < steps; i++) {
      const acc = kOverM * (1 - pos) - dOverM * vel;
      vel = vel + acc * DT;
      pos = pos + vel * DT;
    }

    return vel;
  }

  /**
   * The first moment the spring is done, in milliseconds — the earliest
   * time from which position stays within `tolerance` of the target AND
   * velocity has fallen under `tolerance` per second.
   *
   * Both terms are needed. Position alone reports "done" the instant an
   * underdamped spring crosses its target at full speed, on its way to an
   * overshoot the eye plainly sees; velocity alone reports "done" at the
   * top of that overshoot, where the spring is momentarily still and as
   * far from settled as it gets.
   *
   * Used to size a recipe's playback window from its physics rather than
   * from a number somebody picked: a tween cut off before this is a
   * motion that visibly stops short. Returns `null` when the spring has
   * not settled within `MAX_KEYFRAMES` steps (5 seconds), which is a
   * badly-chosen parameter set rather than a slow one.
   */
  settleTimeMs(tolerance = 0.01): number | null {
    const kOverM = this.stiffness / this.mass;
    const dOverM = this.damping / this.mass;

    let pos = 0;
    let vel = this.initialVelocity;
    // The last step at which the spring was still outside the band; the
    // answer is the step after it. Tracked rather than returning on first
    // entry into the band, because an underdamped spring enters and leaves
    // it several times before it stays.
    let lastUnsettled = -1;
    for (let i = 0; i < MAX_KEYFRAMES; i++) {
      if (Math.abs(pos - 1) > tolerance || Math.abs(vel) > tolerance) {
        lastUnsettled = i;
      }
      const acc = kOverM * (1 - pos) - dOverM * vel;
      vel = vel + acc * DT;
      pos = pos + vel * DT;
    }
    if (lastUnsettled === MAX_KEYFRAMES - 1) return null;
    return (lastUnsettled + 1) * DT * 1000;
  }
}

// ---------------------------------------------------------------------------
// GravitySolver
// ---------------------------------------------------------------------------

/**
 * GravitySolver -- constant acceleration with elastic bounce.
 *
 * Simulates a ball dropped from height 1.0 toward ground at 0.0.
 * Each bounce amplitude is reduced by coefficientOfRestitution.
 * Position is clamped to >= 0 (cannot go below ground).
 *
 * Output: values in [0, 1] where 1.0 = initial drop height, 0.0 = ground.
 * Converges to 0.0 as bounce amplitude decays.
 *
 * Callers map: CSS value = keyframeValue * dropDistance
 */
export class GravitySolver {
  private readonly acceleration: number;
  private readonly coefficientOfRestitution: number;
  private readonly initialVelocity: number;

  constructor(params: {
    acceleration?: number;
    coefficientOfRestitution?: number;
    initialVelocity?: number;
  } = {}) {
    this.acceleration = params.acceleration ?? 9.8;
    this.coefficientOfRestitution = params.coefficientOfRestitution ?? 0.6;
    this.initialVelocity = params.initialVelocity ?? 0;
  }

  /**
   * Pre-compute bounce keyframes over the given duration.
   * Returns an array of values in [0, 1] (first value is 1.0, converges to 0.0).
   * Array length is capped at MAX_KEYFRAMES (300).
   */
  keyframes(durationMs: number): number[] {
    const durationS = durationMs / 1000;
    const steps = Math.min(Math.ceil(durationS / DT), MAX_KEYFRAMES);

    const result: number[] = [];
    let pos = 1.0; // start at drop height (normalized 1.0)
    let vel = this.initialVelocity; // initial velocity (positive = upward)
    const g = this.acceleration;
    const cor = this.coefficientOfRestitution;

    for (let i = 0; i < steps; i++) {
      result.push(pos);

      // Gravity pulls position toward ground (decreases pos).
      vel = vel - g * DT;
      pos = pos + vel * DT;

      // Bounce: if we hit or pass ground, reflect velocity.
      if (pos <= 0) {
        pos = 0;
        vel = Math.abs(vel) * cor;
        // If bounce velocity is negligible, stop at ground.
        if (vel < 0.001) {
          vel = 0;
        }
      }
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// FrictionSolver
// ---------------------------------------------------------------------------

/**
 * FrictionSolver -- exponential friction deceleration.
 *
 * Models a particle decelerating from initialVelocity under friction:
 *   raw_position(t) = (v0 / friction) * (1 - e^(-friction * t))
 *
 * Asymptotically approaches rest at position = v0/friction.
 * Normalized to [0, 1] by dividing by the asymptotic maximum (v0/friction):
 *   normalized(t) = 1 - e^(-friction * t)
 *
 * Output: 0.0 = start position, 1.0 = asymptotic rest position.
 * Callers scale by desired displacement.
 */
export class FrictionSolver {
  private readonly initialVelocity: number;
  private readonly friction: number;

  constructor(params: {
    initialVelocity: number;
    friction?: number;
  }) {
    this.initialVelocity = params.initialVelocity;
    this.friction = params.friction ?? 0.1;
  }

  /**
   * Pre-compute normalized friction deceleration keyframes over the given duration.
   * Returns an array of values in [0, 1] (0.0 = start, 1.0 = asymptotic rest).
   * Array length is capped at MAX_KEYFRAMES (300).
   */
  keyframes(durationMs: number): number[] {
    const durationS = durationMs / 1000;
    const steps = Math.min(Math.ceil(durationS / DT), MAX_KEYFRAMES);

    const result: number[] = [];
    const friction = this.friction;

    for (let i = 0; i < steps; i++) {
      const t = i * DT;
      // normalized(t) = 1 - e^(-friction * t)
      const normalized = 1 - Math.exp(-friction * t);
      result.push(normalized);
    }

    return result;
  }
}
