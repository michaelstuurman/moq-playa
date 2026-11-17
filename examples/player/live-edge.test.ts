import { describe, expect, it } from 'vitest';

import { LiveEdgeController } from './live-edge.js';

// Runs the controller against a playhead it steers: media arrives every
// `burstMs`, the playhead advances at the rate last asked for.
function run(c: LiveEdgeController, seconds: number, burstMs: number, startAheadS: number, t0 = 0) {
    let ahead = startAheadS;
    let rate = 1;
    let jumps = 0;
    let lowest = Infinity;
    let sinceBurst = 0;
    for (let ms = t0; ms < t0 + seconds * 1000; ms += 50) {
        sinceBurst += 50;
        ahead -= 0.05 * rate;
        if (sinceBurst >= burstMs) {
            ahead += sinceBurst / 1000;
            sinceBurst = 0;
        }
        lowest = Math.min(lowest, ahead);
        const step = c.step(ms, ahead);
        if (step.jumpTo !== undefined) {
            ahead = step.jumpTo;
            jumps++;
        }
        rate = step.rate;
    }
    return { ahead, jumps, lowest, end: t0 + seconds * 1000 };
}

describe('LiveEdgeController', () => {
    it('holds a fixed target and never moves it', () => {
        const c = new LiveEdgeController(0.35);
        const r = run(c, 60, 50, 0.8);
        expect(c.targetS).toBe(0.35);
        expect(r.ahead).toBeGreaterThan(0.3);
        expect(r.ahead).toBeLessThan(0.4);
        expect(r.jumps).toBe(0);
    });

    it('jumps a lag of more than three seconds above the target, at most once per 10 s', () => {
        const c = new LiveEdgeController(0.35);
        expect(c.step(0, 5.2)).toEqual({ rate: 1, jumpTo: 0.35 });
        // Right after a jump the buffer refills while the browser seeks: no second jump.
        expect(c.step(2_000, 5.2).jumpTo).toBeUndefined();
        expect(c.step(10_000, 5.2).jumpTo).toBe(0.35);
    });

    it('closes a lag of one or two seconds by rate, not by a jump', () => {
        const c = new LiveEdgeController(0.35);
        const step = c.step(0, 1.6);
        expect(step.jumpTo).toBeUndefined();
        expect(step.rate).toBeGreaterThan(1);
    });

    it('lowers the target to its minimum on a smooth stream', () => {
        const c = new LiveEdgeController();
        const r = run(c, 120, 50, 0.4);
        expect(c.targetS).toBeLessThan(0.27);
        expect(r.ahead).toBeLessThan(0.33);
        expect(r.lowest).toBeGreaterThan(0.03);
    });

    it('keeps room for the bursts of a stream that arrives in bursts', () => {
        const c = new LiveEdgeController();
        const r = run(c, 180, 300, 0.4);
        // 300 ms bursts swing the buffer 300 ms; the dip is about half of it.
        expect(c.targetS).toBeGreaterThan(0.24);
        expect(c.targetS).toBeLessThan(0.45);
        expect(r.lowest).toBeGreaterThan(0.02);
    });

    it('raises the target at once when the bursts grow', () => {
        const c = new LiveEdgeController();
        const smooth = run(c, 120, 50, 0.4);
        const before = c.targetS;
        run(c, 5, 400, smooth.ahead, smooth.end);
        expect(c.targetS).toBeGreaterThan(before + 0.1);
    });

    it('a stall raises the target and holds it for 30 s', () => {
        const c = new LiveEdgeController();
        const smooth = run(c, 120, 50, 0.4);
        const before = c.targetS;
        c.stalled(smooth.end);
        expect(c.targetS).toBeCloseTo(before + 0.25, 5);
        const held = run(c, 25, 50, c.targetS, smooth.end);
        expect(c.targetS).toBeCloseTo(before + 0.25, 5);
        run(c, 60, 50, held.ahead, held.end);
        expect(c.targetS).toBeLessThan(before + 0.1);
    });

    it('a fixed target ignores a stall', () => {
        const c = new LiveEdgeController(0.2);
        c.stalled(0);
        expect(c.targetS).toBe(0.2);
    });

    it('limits the rate to 0.97 .. 1.10', () => {
        expect(new LiveEdgeController(0.35).step(0, 1.2).rate).toBe(1.1);
        expect(new LiveEdgeController(0.35).step(0, 0.0).rate).toBe(0.97);
        expect(new LiveEdgeController(0.35).step(0, 0.36).rate).toBe(1);
    });

    it('does not change the rate for the dip between two arrivals', () => {
        const c = new LiveEdgeController(0.35);
        const rates = new Set<number>();
        let ahead = 0.5;
        for (let ms = 0; ms < 20_000; ms += 50) {
            ahead -= 0.05;
            if (ms % 300 === 0) ahead += 0.3;
            if (ms > 10_000) rates.add(c.step(ms, ahead).rate);
            else c.step(ms, ahead);
        }
        expect(rates.size).toBe(1);
    });
});
