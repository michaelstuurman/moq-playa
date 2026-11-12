/**
 * MSF URL tests (draft-ietf-moq-msf-01 §11.1).
 *
 * Cover the draft's own URLs (§11.1.3) and parameter examples (§11.1.1), the
 * namespace-name encoding (§11.1.2), every refusal, and format/parse round
 * trips. Vectors marked "moqxr" are shared with that implementation's
 * `tests/msf_url_test.cpp` so the two parse the same links alike.
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import { parseMsfUrl, parseMsfFragment, formatMsfUrl, formatMsfFragment } from './msf-url.js';

const DRAFT_TOKEN = 'gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lYnJmcmVqMTIzNDU2NzgwMHZpc3VlZF9hdD0xNzMwNDM';
const fragment = (parameters: string) => parseMsfFragment(`msf:ns--t&${parameters}`);
const bytes = (text: string) => new TextEncoder().encode(text);

describe('MSF URL — draft examples (§11.1.3)', () => {
    it('decomposes the catalog URL as the draft states', () => {
        expect(parseMsfUrl('moqt://example.com/server/config?a=1&b=2#msf:customer-livestream-123--catalog')).toEqual({
            sessionUrl: 'moqt://example.com/server/config?a=1&b=2',
            httpsUrl: 'https://example.com/server/config?a=1&b=2',
            namespace: ['customer', 'livestream', '123'],
            trackName: 'catalog',
            wallclockRanges: [], mediatimeRanges: [], locationRanges: [], parameters: [],
        });
    });

    it('reads a required native QUIC connection', () => {
        const url = parseMsfUrl('moqt://example.com/relay-app/relayID#msf:customerID-broadcastID--catalog&connection=q');
        expect(url.namespace).toEqual(['customerID', 'broadcastID']);
        expect(url.trackName).toBe('catalog');
        expect(url.connection).toBe('q');
    });

    it('reads a non-catalog track with a required WebTransport connection', () => {
        const url = parseMsfUrl('moqt://example.com/relay-app/relayID#msf:customerID-broadcastID--video&connection=wt');
        expect(url.trackName).toBe('video');
        expect(url.connection).toBe('wt');
    });

    it('reads a subclip', () => {
        const url = parseMsfUrl('moqt://example.com/relay-app/relayID#msf:customerID-broadcastID--catalog&location-range=34-64');
        expect(url.locationRanges).toEqual([{ start: { group: 34n }, end: { group: 64n } }]);
    });

    it('reads a client token', () => {
        const url = parseMsfUrl(`moqt://example.com/relay-app/relayID#msf:customerID-broadcastID--catalog&c4m=${DRAFT_TOKEN}`);
        expect(url.c4m).toHaveLength(87);
        expect(Array.from(url.c4m!.subarray(0, 4))).toEqual([0x82, 0xa8, 0x64, 0x61]);
        expect(url.parameters).toEqual([]);
    });

    it('keeps the server token in the session and the client token out of it', () => {
        const url = parseMsfUrl('moqt://example.com/relay-app/relayID?token=HTRCII74GHFT@JHBCVSW56HKKneH2Dbyq6NHBI2'
            + `#msf:customerID-broadcastID--catalog&c4m=${DRAFT_TOKEN}`);
        expect(url.sessionUrl).toBe('moqt://example.com/relay-app/relayID?token=HTRCII74GHFT@JHBCVSW56HKKneH2Dbyq6NHBI2');
        expect(url.httpsUrl).toBe('https://example.com/relay-app/relayID?token=HTRCII74GHFT@JHBCVSW56HKKneH2Dbyq6NHBI2');
        expect(url.sessionUrl).not.toContain('c4m');
        expect(url.c4m).toHaveLength(87);
    });
});

describe('MSF URL — session (§11.1)', () => {
    it('keeps an explicit port, an absent path, and an IP literal as written (moqxr)', () => {
        expect(parseMsfUrl('moqt://example.com:4433#msf:ns--catalog').httpsUrl).toBe('https://example.com:4433');
        expect(parseMsfUrl('moqt://h/#msf:ns--t').sessionUrl).toBe('moqt://h/');
        expect(parseMsfUrl('moqt://[2001:db8::1]:4433/moq#msf:ns--t').httpsUrl).toBe('https://[2001:db8::1]:4433/moq');
    });

    it('treats the scheme as case-insensitive and nothing else (moqxr)', () => {
        expect(parseMsfUrl('MOQT://Example.com/A#msf:ns--catalog').sessionUrl).toBe('moqt://Example.com/A');
        expect(() => parseMsfUrl('moqt://h#MSF:ns--t')).toThrow('"msf:"');
    });

    it.each([
        ['https://example.com#msf:ns--t', 'moqt://'],
        ['moqt:/example.com#msf:ns--t', 'moqt://'],
        ['moqt://example.com', 'fragment'],
        ['moqt://example.com#other:ns--t', '"msf:"'],
        ['moqt://example.com#', '"msf:"'],
        ['moqt://#msf:ns--t', 'host'],
        ['moqt:///path#msf:ns--t', 'host'],
        ['moqt://h:0#msf:ns--t', 'port'],
        ['moqt://h:70000#msf:ns--t', 'port'],
        ['moqt://h:8x#msf:ns--t', 'host and optional port'],
        ['moqt://h:#msf:ns--t', 'host and optional port'],
        ['moqt://[::zz]#msf:ns--t', 'host and optional port'],
        ['moqt://user:secret@h#msf:ns--t', 'userinfo'],
        ['moqt://h/a b#msf:ns--t', 'path'],
        ['moqt://h/%zz#msf:ns--t', 'path'],
        ['moqt://h/p?#msf:ns--t', 'omit "?"'],
        ['moqt://h/p?a=<#msf:ns--t', 'query'],
    ])('refuses %j', (text, message) => {
        expect(() => parseMsfUrl(text)).toThrow(message);
    });
});

describe('MSF URL — namespace-name string (§11.1.2)', () => {
    // Asserted literally: an encoder wrong in the same way as its decoder would round-trip.
    it.each([
        [['a-b'], 't', 'a.2db--t'],
        [['a.b'], 't', 'a.2eb--t'],
        [['a/b'], 't', 'a.2fb--t'],
        [['a b'], 't', 'a.20b--t'],
        [['é'], 't', '.c3.a9--t'],
        [['one'], 'two-three', 'one--two.2dthree'],
        [['a_b', 'C9'], '_', 'a_b-C9--_'],
        [['~'], '%', '.7e--.25'],
    ])('encodes %j / %j as %s and back (moqxr)', (namespace, trackName, encoded) => {
        expect(formatMsfFragment({ namespace, trackName })).toBe(`msf:${encoded}`);
        expect(parseMsfFragment(`msf:${encoded}`)).toMatchObject({ namespace, trackName });
    });

    it('accepts upper-case and unnecessary escapes on input (moqxr)', () => {
        expect(parseMsfFragment('msf:a.2Db--.74').namespace).toEqual(['a-b']);
        expect(parseMsfFragment('msf:a.2Db--.74').trackName).toBe('t');
    });

    it.each([
        ['nodelimiter', 'no "--"'],
        ['a--b--c', 'more than one "--"'],
        ['a----t', 'more than one "--"'],
        ['a--', 'empty track name'],
        ['--t', 'empty namespace field'],
        ['a-b---t', 'must be escaped'],
        ['a.2--t', 'two hexadecimal digits'],
        ['a.zz--t', 'two hexadecimal digits'],
        ['a--t.', 'two hexadecimal digits'],
        ['a~b--t', 'must be escaped'],
        ['a/b--t', 'must be escaped'],
        ['a%2Db--t', 'must be escaped'],
        ['a.ff--t', 'not valid UTF-8'],
        ['', 'no "--"'],
    ])('refuses %j', (encoded, message) => {
        expect(() => parseMsfFragment(`msf:${encoded}`)).toThrow(message);
    });

    it.each([
        [{ namespace: [], trackName: 't' }, 'at least one field'],
        [{ namespace: ['a', '', 'b'], trackName: 't' }, 'namespace field 1'],
        [{ namespace: ['a'], trackName: '' }, 'track name'],
        [{ namespace: ['\ud800'], trackName: 't' }, 'unpaired surrogate'],
    ])('refuses to encode %j', (init, message) => {
        expect(() => formatMsfFragment(init)).toThrow(message);
    });
});

describe('MSF URL — parameters (§11.1, §11.1.1)', () => {
    it('preserves non-reserved parameters verbatim and in order (moqxr)', () => {
        expect(fragment('alpha=1&beta=2&alpha=&x=a=b&p=%26/%3F').parameters).toEqual([
            { name: 'alpha', value: '1' }, { name: 'beta', value: '2' }, { name: 'alpha', value: '' },
            { name: 'x', value: 'a=b' }, { name: 'p', value: '%26/%3F' },
        ]);
    });

    it('matches reserved names case-sensitively (moqxr)', () => {
        const parsed = fragment('Connection=q&C4M=!');
        expect(parsed.connection).toBeUndefined();
        expect(parsed.c4m).toBeUndefined();
        expect(parsed.parameters).toEqual([{ name: 'Connection', value: 'q' }, { name: 'C4M', value: '!' }]);
    });

    it.each([
        ['msf:ns--t&noequals', 'no "="'],
        ['msf:ns--t&=1', 'empty name'],
        ['msf:ns--t&&x=1', 'empty parameter'],
        ['msf:ns--t&x=1&', 'empty parameter'],
        ['msf:ns--t&', 'empty parameter'],
        ['msf:ns--t&x=a?b', 'grammar'],
        ['msf:ns--t&x=a#b', 'grammar'],
        ['msf:ns--t&x=a b', 'grammar'],
        ['msf:ns--t&x=%2', 'grammar'],
        ['msf:ns--t?x=1', 'grammar'],
        ['#msf:ns--t', '"msf:"'],
    ])('refuses %j', (text, message) => {
        expect(() => parseMsfFragment(text)).toThrow(message);
    });

    it('reads connection and refuses other values and repeats (moqxr)', () => {
        expect(fragment('connection=q').connection).toBe('q');
        expect(fragment('connection=wt').connection).toBe('wt');
        expect(parseMsfFragment('msf:ns--t').connection).toBeUndefined();
        expect(fragment('connection=q').parameters).toEqual([]);
        for (const bad of ['connection=tcp', 'connection=Q', 'connection=', 'connection=q&connection=wt', 'connection=q&connection=q']) {
            expect(() => fragment(bad)).toThrow('"connection"');
        }
    });
});

describe('MSF URL — ranges (§11.1.1)', () => {
    it('reads the draft time range examples', () => {
        expect(fragment('wallclock-range=1761759637565-1761759836189').wallclockRanges)
            .toEqual([{ startMs: 1761759637565, endMs: 1761759836189 }]);
        expect(fragment('wallclock-range=1761751753894').wallclockRanges).toEqual([{ startMs: 1761751753894 }]);
        expect(fragment('mediatime-range=0-13421').mediatimeRanges).toEqual([{ startMs: 0, endMs: 13421 }]);
        expect(fragment('mediatime-range=982').mediatimeRanges).toEqual([{ startMs: 982 }]);
    });

    it('reads the draft location range examples; 16.24 and 16-24 differ', () => {
        expect(fragment('location-range=34.0-2145.16').locationRanges)
            .toEqual([{ start: { group: 34n, object: 0n }, end: { group: 2145n, object: 16n } }]);
        expect(fragment('location-range=16.24').locationRanges).toEqual([{ start: { group: 16n, object: 24n } }]);
        expect(fragment('location-range=16-24').locationRanges).toEqual([{ start: { group: 16n }, end: { group: 24n } }]);
    });

    it('lets an end without an Object ID cover its whole group (moqxr)', () => {
        expect(fragment('location-range=16.24-16').locationRanges)
            .toEqual([{ start: { group: 16n, object: 24n }, end: { group: 16n } }]);
        expect(fragment('location-range=5-5').locationRanges).toEqual([{ start: { group: 5n }, end: { group: 5n } }]);
    });

    it('takes the union of repeated time ranges (moqxr)', () => {
        expect(fragment('mediatime-range=0-100&mediatime-range=50-200').mediatimeRanges).toEqual([{ startMs: 0, endMs: 200 }]);
        expect(fragment('mediatime-range=500-600&mediatime-range=0-100').mediatimeRanges)
            .toEqual([{ startMs: 0, endMs: 100 }, { startMs: 500, endMs: 600 }]);
        expect(fragment('mediatime-range=500&mediatime-range=0-600').mediatimeRanges).toEqual([{ startMs: 0 }]);
        expect(fragment('mediatime-range=0-100&mediatime-range=10-20').mediatimeRanges).toEqual([{ startMs: 0, endMs: 100 }]);
        expect(fragment('mediatime-range=7&mediatime-range=7').mediatimeRanges).toEqual([{ startMs: 7 }]);
        // Touching, not overlapping: the same set, left as two ranges.
        expect(fragment('mediatime-range=0-100&mediatime-range=101-200').mediatimeRanges).toHaveLength(2);
    });

    it('keeps the two time parameters apart', () => {
        const parsed = fragment('mediatime-range=0-100&wallclock-range=50-200');
        expect(parsed.mediatimeRanges).toEqual([{ startMs: 0, endMs: 100 }]);
        expect(parsed.wallclockRanges).toEqual([{ startMs: 50, endMs: 200 }]);
    });

    it('takes the union of repeated location ranges (moqxr)', () => {
        expect(fragment('location-range=0-5&location-range=5.3-9').locationRanges)
            .toEqual([{ start: { group: 0n }, end: { group: 9n } }]);
        expect(fragment('location-range=1&location-range=0-2').locationRanges).toEqual([{ start: { group: 0n } }]);
        expect(fragment('location-range=0-5&location-range=2.1-3.4').locationRanges)
            .toEqual([{ start: { group: 0n }, end: { group: 5n } }]);
        expect(fragment('location-range=0-5.3&location-range=5.4-9').locationRanges).toHaveLength(2);
        expect(fragment('location-range=8-9&location-range=0-5').locationRanges)
            .toEqual([{ start: { group: 0n }, end: { group: 5n } }, { start: { group: 8n }, end: { group: 9n } }]);
    });

    it('accepts the largest values and refuses larger ones', () => {
        expect(fragment('mediatime-range=9007199254740991').mediatimeRanges).toEqual([{ startMs: Number.MAX_SAFE_INTEGER }]);
        expect(() => fragment('mediatime-range=9007199254740992')).toThrow('too large');
        expect(fragment('location-range=4611686018427387903.4611686018427387903').locationRanges)
            .toEqual([{ start: { group: (1n << 62n) - 1n, object: (1n << 62n) - 1n } }]);
        expect(() => fragment('location-range=4611686018427387904')).toThrow('62 bits');
    });

    it.each([
        ['mediatime-range=200-100', 'ends before'],
        ['mediatime-range=a-b', 'non-numeric'],
        ['mediatime-range=1-2-3', 'more than one "-"'],
        ['mediatime-range=', 'non-numeric'],
        ['mediatime-range=5-', 'non-numeric'],
        ['mediatime-range=-5', 'non-numeric'],
        ['mediatime-range=1.5', 'non-numeric'],
        ['mediatime-range=+5', 'non-numeric'],
        ['wallclock-range=0x10', 'non-numeric'],
        ['location-range=16.', 'non-numeric'],
        ['location-range=.5', 'non-numeric'],
        ['location-range=16-', 'non-numeric'],
        ['location-range=1.2.3', 'more than one "."'],
        ['location-range=1-2-3', 'more than one "-"'],
        ['location-range=5-4', 'ends before'],
        ['location-range=5.3-5.2', 'ends before'],
    ])('refuses %j', (parameters, message) => {
        expect(() => fragment(parameters)).toThrow(message);
    });
});

describe('MSF URL — c4m (§11.1.1)', () => {
    it.each([
        ['AAH+/w==', [0, 1, 254, 255]],     // base64, RFC 4648 §4
        ['AAH-_w==', [0, 1, 254, 255]],     // base64url, padded
        ['AAH-_w', [0, 1, 254, 255]],       // base64url, unpadded
        ['YWJj', [97, 98, 99]],
        ['YWI=', [97, 98]],
        ['YWI', [97, 98]],
        ['YQ', [97]],
    ])('decodes %j', (value, expected) => {
        expect(Array.from(fragment(`c4m=${value}`).c4m!)).toEqual(expected);
    });

    it.each([
        '', '=', 'Y', 'YWJjZ', 'Y===', 'YQ=', 'YWJj=', 'YWJj====', 'YR==', 'YR', 'YWJ', 'Y=Q=', '=YQ=',
        'AAH+/w',       // base64 with its padding removed
        'AAH+_w==',     // mixed alphabets
        'YW.j', 'YW%6Aj', 'base64:YWJj',
    ])('refuses %j without echoing it', (value) => {
        let message = '';
        try { fragment(`alpha=1&c4m=${value}`); } catch (error) { message = (error as Error).message; }
        expect(message).toBe('MSF URL "c4m" is not a valid base64 token (§11.1.1)');
    });

    it('does not decode the token fragment of §11.1.1, which is cut short for display', () => {
        expect(() => fragment('c4m=gqhkYWxnIGVzaGFyqGR0eXBNhdZ9hdWQAY3VybGZlbWlzcwZleWV2aW5uZWlhdGVwQWNyZW5lY')).toThrow('"c4m"');
    });

    it('refuses a repeated token (moqxr)', () => {
        expect(() => fragment('c4m=YQ&c4m=Yg')).toThrow('repeats the "c4m"');
        expect(() => fragment('c4m=YQ&c4m=YQ')).toThrow('repeats the "c4m"');
    });

    it('bounds the decoded token at 32 KiB', () => {
        expect(fragment(`c4m=${'A'.repeat(43691)}`).c4m).toHaveLength(32768);
        expect(() => fragment(`c4m=${'A'.repeat(43692)}`)).toThrow('"c4m"');
    });
});

describe('MSF URL — formatting', () => {
    it('writes exact URLs (moqxr)', () => {
        expect(formatMsfUrl({ sessionUrl: 'moqt://relay.example:4433/moq', namespace: ['customerID', 'broadcastID'], trackName: 'catalog' }))
            .toBe('moqt://relay.example:4433/moq#msf:customerID-broadcastID--catalog');
        expect(formatMsfUrl({ sessionUrl: 'https://relay.example/moq', namespace: ['ns'], trackName: 'video', connection: 'wt' }))
            .toBe('moqt://relay.example/moq#msf:ns--video&connection=wt');
        expect(formatMsfUrl({ sessionUrl: 'moqt://h', namespace: ['a', 'b', 'c'], trackName: 'track', connection: 'q' }))
            .toBe('moqt://h#msf:a-b-c--track&connection=q');
        expect(formatMsfUrl({ sessionUrl: 'moqt://h', namespace: ['/'], trackName: 'catalog' })).toBe('moqt://h#msf:.2f--catalog');
    });

    it('writes reserved parameters first, others in order, and the token last as padded base64', () => {
        expect(formatMsfFragment({
            namespace: ['ns'], trackName: 't',
            c4m: Uint8Array.of(0, 1, 254, 255),
            parameters: [{ name: 'license', value: 'https%3A%2F%2Fdrm.example%2F' }, { name: 'beta', value: '' }],
            locationRanges: [{ start: { group: 16n, object: 24n }, end: { group: 16n } }, { start: { group: 2n } }],
            mediatimeRanges: [{ startMs: 0, endMs: 13421 }],
            wallclockRanges: [{ startMs: 1761751753894 }],
            connection: 'wt',
        })).toBe('msf:ns--t&connection=wt&wallclock-range=1761751753894&mediatime-range=0-13421'
            + '&location-range=16.24-16&location-range=2&license=https%3A%2F%2Fdrm.example%2F&beta=&c4m=AAH+/w==');
    });

    it.each([Uint8Array.of(1), Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3), Uint8Array.of(251, 255, 191, 0)])(
        'round-trips token %j', (c4m) => {
            expect(parseMsfFragment(formatMsfFragment({ namespace: ['ns'], trackName: 't', c4m })).c4m).toEqual(c4m);
        });

    it.each([
        'moqt://example.com/server/config?a=1&b=2#msf:customer-livestream-123--catalog',
        'moqt://example.com:4433#msf:ns--catalog',
        'moqt://example.com/p#msf:a.2db--track.2ename',
        'moqt://h#msf:ns--t&alpha=1&beta=2',
        'moqt://h/#msf:ns--t',
        'moqt://h#msf:ns--t&connection=wt&c4m=YWJj',
        'moqt://h#msf:ns--t&connection=q&alpha=1&beta=2&c4m=eHl6',
        'moqt://h#msf:ns--t&wallclock-range=5&mediatime-range=0-100&mediatime-range=500-600&location-range=34-64',
    ])('parse(format(parse(%j))) is stable (moqxr)', (text) => {
        const first = parseMsfUrl(text);
        expect(formatMsfUrl(first)).toBe(text);
        expect(parseMsfUrl(formatMsfUrl(first))).toEqual(first);
    });

    it.each([
        [{ sessionUrl: 'wss://h' }, 'moqt:// or https://'],
        [{ sessionUrl: 'moqt://h/p#x' }, 'fragment'],
        [{ sessionUrl: 'moqt://h#x/p' }, 'fragment'],
        [{ sessionUrl: 'moqt://' }, 'host'],
        [{ parameters: [{ name: 'c4m', value: 'YQ' }] }, 'reserved'],
        [{ parameters: [{ name: 'a&b', value: '1' }] }, 'grammar'],
        [{ parameters: [{ name: 'a=b', value: '1' }] }, 'grammar'],
        [{ parameters: [{ name: 'a', value: 'x&connection=q' }] }, 'grammar'],
        [{ parameters: [{ name: 'a', value: 'b c' }] }, 'grammar'],
        [{ parameters: [{ name: '', value: '1' }] }, 'empty name'],
        [{ c4m: new Uint8Array(0) }, 'non-empty'],
        [{ c4m: new Uint8Array(32769) }, '"c4m"'],
        [{ connection: 'tcp' as 'q' }, '"connection"'],
        [{ mediatimeRanges: [{ startMs: -1 }] }, 'non-numeric'],
        [{ mediatimeRanges: [{ startMs: 1.5 }] }, 'non-numeric'],
        [{ mediatimeRanges: [{ startMs: 2, endMs: 1 }] }, 'ends before'],
    ])('refuses to format %j', (init, message) => {
        expect(() => formatMsfUrl({ sessionUrl: 'moqt://h', namespace: ['ns'], trackName: 't', ...init })).toThrow(message);
    });

    it('refuses to format a negative Location', () => {
        expect(() => formatMsfFragment({ namespace: ['ns'], trackName: 't', locationRanges: [{ start: { group: -1n } }] }))
            .toThrow('non-numeric');
    });

    it('does not put the token in an error', () => {
        const c4m = bytes('secret-token-bytes');
        let message = '';
        try { formatMsfUrl({ sessionUrl: 'moqt://h', namespace: ['ns'], trackName: '', c4m }); }
        catch (error) { message = (error as Error).message; }
        expect(message).toContain('track name');
        expect(message).not.toMatch(/c2VjcmV0|secret/);
    });
});
