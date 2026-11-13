import { describe, expect, it } from 'vitest';

import { withoutTokens } from './log.js';

describe('withoutTokens', () => {
    it('leaves out jwt= and token= values and bare JWTs', () => {
        const jwt = 'eyJ0eXAiOiJKV1Qi.eyJleHAiOjE3OTQ1OTQ5NjB9.F5yuihWYY17BmZIcDYDo';
        expect(withoutTokens(`Relay: https://relay.example/?jwt=${jwt}`)).toBe('Relay: https://relay.example/?jwt=...');
        expect(withoutTokens(`Connecting to https://relay.example/?jwt=${jwt}&v=18...`)).toBe('Connecting to https://relay.example/?jwt=...&v=18...');
        expect(withoutTokens(`license https://l.example/license?token=abc123`)).toBe('license https://l.example/license?token=...');
        expect(withoutTokens(`bearer ${jwt} seen`)).toBe('bearer ... seen');
    });

    it('keeps ordinary lines as they are', () => {
        for (const line of ['Catalog: 6 tracks', '  video-main | hev1.2.4.L120.B0 | 1280x720 | 5000kbps',
            'startup seek to 0.040 did not settle within 2000ms (seeking=true, currentTime=0.040)',
            '[DRM] video protection: entry=encv frma=avc3 schm=cbcs v1.0 tenc v1 crypt:skip=1:9']) {
            expect(withoutTokens(line)).toBe(line);
        }
    });
});
