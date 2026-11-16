// The live-edge controller of the example player, without the DOM: it takes
// samples of the buffer ahead of the MSE playhead and says what to do.
//
// A fixed target holds the playhead that far behind the buffered end. In auto
// mode the target follows the stream: media arrives in bursts, so the buffer
// ahead dips between arrivals, and the target is set so that the deepest dip
// of the last WINDOW_MS still leaves FLOOR_S in the buffer. It goes up at once,
// and down slowly. A stall raises it and holds it for a while.

export interface LiveEdgeStep {
    /** Playback rate to set. */
    readonly rate: number;
    /** Seek to this far behind the buffered end (seconds), when set. */
    readonly jumpTo?: number;
}

const FLOOR_S = 0.06;
const MIN_TARGET_S = 0.1;
const MAX_TARGET_S = 1.5;
const START_TARGET_S = 0.25;
const WINDOW_MS = 15_000;
/** Time constant of the average that the rate follows and dips are measured from. */
const MEAN_S = 2;
/** How fast the target comes down: seconds of target per second. */
const LOWER_PER_S = 0.01;
const STALL_STEP_S = 0.1;
const STALL_HOLD_MS = 30_000;
const DEADBAND_S = 0.03;
/**
 * A jump seeks the element, and a browser decodes from the previous keyframe
 * to get there (Safari visibly so, with 1 s GOPs). While it does, the buffer
 * grows again, so jumps are kept for real lag and spaced out; smaller lag is
 * closed by rate.
 */
const JUMP_ABOVE_S = 3.0;
const JUMP_COOLDOWN_MS = 10_000;
/** Rate change per second of error, and its limits. */
const GAIN = 0.4;
const MAX_FASTER = 0.1;
const MAX_SLOWER = 0.03;

export class LiveEdgeController {
    readonly auto: boolean;
    private target: number;
    private lastMs: number | undefined;
    private holdUntilMs = 0;
    private lastJumpMs = -Infinity;
    // A slow average of the buffer ahead, and the dips below it as [time, depth].
    private mean: number | undefined;
    private dips: Array<[number, number]> = [];

    /** `fixedTargetS` holds that target; without it the target adapts. */
    constructor(fixedTargetS?: number) {
        this.auto = fixedTargetS === undefined;
        this.target = fixedTargetS ?? START_TARGET_S;
    }

    get targetS(): number {
        return this.target;
    }

    /** The playhead ran dry. */
    stalled(nowMs: number): void {
        if (!this.auto) return;
        this.target = Math.min(MAX_TARGET_S, this.target + STALL_STEP_S);
        this.holdUntilMs = nowMs + STALL_HOLD_MS;
        this.dips = [];
    }

    /** One sample: `aheadS` is the buffered end minus the playhead. */
    step(nowMs: number, aheadS: number): LiveEdgeStep {
        const dt = this.lastMs === undefined ? 0 : Math.max(0, nowMs - this.lastMs) / 1000;
        this.lastMs = nowMs;

        if (aheadS > this.target + JUMP_ABOVE_S && nowMs - this.lastJumpMs >= JUMP_COOLDOWN_MS) {
            this.lastJumpMs = nowMs;
            this.dips = [];
            this.mean = undefined;
            return { rate: 1, jumpTo: this.target };
        }

        // The rate follows the average, so that the dip between two arrivals
        // does not change it.
        this.mean = this.mean === undefined ? aheadS : this.mean + (aheadS - this.mean) * Math.min(1, dt / MEAN_S);
        if (this.auto) this.adapt(nowMs, aheadS, dt);

        const error = this.mean - this.target;
        if (Math.abs(error) <= DEADBAND_S) return { rate: 1 };
        const rate = 1 + Math.max(-MAX_SLOWER, Math.min(MAX_FASTER, error * GAIN));
        return { rate: Math.round(rate * 100) / 100 };
    }

    private adapt(nowMs: number, aheadS: number, dt: number): void {
        // Dips are taken from the average and not from the target, so that a
        // target that just moved does not count as a dip of its own.
        this.dips.push([nowMs, this.mean! - aheadS]);
        while (this.dips.length > 0 && this.dips[0]![0] < nowMs - WINDOW_MS) this.dips.shift();
        let deepest = 0;
        for (const [, depth] of this.dips) if (depth > deepest) deepest = depth;
        // The target wanted keeps FLOOR_S under the deepest dip.
        const wanted = Math.max(MIN_TARGET_S, Math.min(MAX_TARGET_S, FLOOR_S + deepest));
        if (wanted > this.target) {
            this.target = wanted;
        } else if (nowMs >= this.holdUntilMs && this.dips[0]![0] <= nowMs - WINDOW_MS / 3) {
            this.target = Math.max(wanted, this.target - LOWER_PER_S * dt);
        }
    }
}
