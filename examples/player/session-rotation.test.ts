import { describe, expect, it } from 'vitest';

import { countReception, DEFAULT_LIMITS, isWebKit, overBudget, rotationLimits } from './session-rotation.js';

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0 Mobile/15E148 Safari/604.1';

describe('session rotation', () => {
    it('rotates on WebKit by default, also Chrome on iOS, not Chrome on the Mac', () => {
        expect(isWebKit(SAFARI_MAC)).toBe(true);
        expect(isWebKit(CHROME_IOS)).toBe(true);
        expect(isWebKit(CHROME_MAC)).toBe(false);
        expect(rotationLimits(null, SAFARI_MAC)).toEqual(DEFAULT_LIMITS);
        expect(rotationLimits(null, CHROME_MAC)).toBeNull();
    });

    it('?rotate=off, on and a number of MiB', () => {
        expect(rotationLimits('off', SAFARI_MAC)).toBeNull();
        expect(rotationLimits('on', CHROME_MAC)).toEqual(DEFAULT_LIMITS);
        expect(rotationLimits('4', CHROME_MAC)).toEqual({ bytes: 4 * 1024 * 1024, streams: DEFAULT_LIMITS.streams });
        expect(rotationLimits('nonsense', CHROME_MAC)).toBeNull();
    });

    it('is over budget at either limit', () => {
        expect(overBudget({ bytes: 12 * 1024 * 1024, streams: 10 }, DEFAULT_LIMITS)).toBe(true);
        expect(overBudget({ bytes: 1, streams: 5000 }, DEFAULT_LIMITS)).toBe(true);
        expect(overBudget({ bytes: 1, streams: 4999 }, DEFAULT_LIMITS)).toBe(false);
    });

    it('counts payload bytes and distinct streams on a connection', () => {
        let listener: ((e: object) => void) | undefined;
        const connection = { observeObjectReception: (l: (e: object) => void) => { listener = l; return () => {}; } };
        const budget = countReception(connection);
        listener!({ type: 'header', streamId: 1n, payloadLength: 100n, propertiesLength: 4 });
        listener!({ type: 'header', streamId: 1n, payloadLength: 50n, propertiesLength: 0 });
        listener!({ type: 'progress', payloadReceived: 100n });
        listener!({ type: 'header', streamId: 2n, payloadLength: 10n, propertiesLength: 0 });
        expect(budget).toEqual({ bytes: 164, streams: 2 });
    });
});
