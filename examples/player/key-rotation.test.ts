import { describe, expect, it } from 'vitest';
import { parseMsfCatalog } from '@openmoq/msf';
import { announcedKeys, prelicenseDelay } from './key-rotation.js';

const WV = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const CK = '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b';

function catalog(tracks: object[], protections: object[]): string {
    return JSON.stringify({ version: 1, contentProtections: protections, tracks });
}
function cp(refID: string, kid: string, systemID: string, pssh = 'AAECAw==') {
    return { refID, defaultKID: [kid], scheme: 'cbcs', drmSystem: { systemID, pssh } };
}

describe('key rotation announcements', () => {
    it('reads the announced keys of one DRM system, once per KID', () => {
        const text = catalog([
            { name: 'v', contentProtectionRefIDs: ['1'], nextContentProtectionRefIDs: ['next-2', 'next-3'], nextKeyValidFrom: '2026-11-25T00:00:00Z' },
            { name: 'v2', contentProtectionRefIDs: ['1'], nextContentProtectionRefIDs: ['next-2', 'next-3'], nextKeyValidFrom: '2026-11-25T00:00:00Z' },
            { name: 'a', contentProtectionRefIDs: ['4'], nextContentProtectionRefIDs: ['next-5'], nextKeyValidFrom: '2026-11-25T00:00:00Z' },
        ], [
            cp('1', 'aaaaaaaa-0000-0000-0000-000000000000', WV),
            cp('next-2', 'BBBBBBBB-0000-0000-0000-000000000000', WV),
            cp('next-3', 'bbbbbbbb-0000-0000-0000-000000000000', CK),
            cp('4', 'cccccccc-0000-0000-0000-000000000000', WV),
            cp('next-5', 'dddddddd-0000-0000-0000-000000000000', WV),
        ]);
        const keys = announcedKeys(text, WV);
        expect(keys.map((k) => k.kid)).toEqual(['bbbbbbbb-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-000000000000']);
        expect(keys[0]!.validFrom).toBe(Date.parse('2026-11-25T00:00:00Z'));
        expect([...keys[0]!.pssh]).toEqual([0, 1, 2, 3]);
    });

    it('finds nothing without an announcement or in malformed text', () => {
        expect(announcedKeys(catalog([{ name: 'v', contentProtectionRefIDs: ['1'] }], [cp('1', 'aaaaaaaa-0000-0000-0000-000000000000', WV)]), WV)).toEqual([]);
        expect(announcedKeys('{', WV)).toEqual([]);
        expect(announcedKeys(catalog([{ name: 'v', nextContentProtectionRefIDs: ['x'], nextKeyValidFrom: 'soon' }], []), WV)).toEqual([]);
    });

    it('licenses lead before the change, spread earlier, or at once when late', () => {
        const change = 1_000_000_000;
        expect(prelicenseDelay(change, change - 3_600_000, 600_000, 60_000, 0)).toBe(3_000_000);
        expect(prelicenseDelay(change, change - 3_600_000, 600_000, 60_000, 1)).toBe(2_940_000);
        expect(prelicenseDelay(change, change - 60_000, 600_000, 60_000, 0.5)).toBe(3_000);
    });
});

describe('catalog parser and the announcement', () => {
    it('accepts an announced key used by no track, and producer-defined track fields', () => {
        const text = JSON.stringify({
            version: '1',
            contentProtections: [
                { refID: '1', defaultKID: ['aaaaaaaa-0000-0000-0000-000000000000'], scheme: 'cbcs', drmSystem: { systemID: WV, pssh: 'AAECAw==' } },
                { refID: 'next-2', defaultKID: ['bbbbbbbb-0000-0000-0000-000000000000'], scheme: 'cbcs', drmSystem: { systemID: WV, pssh: 'AAECAw==' } },
            ],
            tracks: [{
                name: 'v', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc3.64001f', timescale: 90000,
                bitrate: 4000000, framerate: 25, width: 1280, height: 720,
                contentProtectionRefIDs: ['1'],
                nextContentProtectionRefIDs: ['next-2'], nextKeyValidFrom: '2026-11-25T00:00:00Z',
            }],
        });
        const catalog = parseMsfCatalog(text);
        expect(catalog.contentProtections).toHaveLength(2);
        expect(catalog.tracks[0]!.contentProtectionRefIDs).toEqual(['1']);
        expect(announcedKeys(text, WV).map((k) => k.kid)).toEqual(['bbbbbbbb-0000-0000-0000-000000000000']);
    });
});
