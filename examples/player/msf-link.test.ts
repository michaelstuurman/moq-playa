import { describe, expect, it } from 'vitest';
import { formatMsfFragment } from '@openmoq/msf';
import { readMsfLink } from './msf-link.js';

const ctx = { operation: 'SETUP' as const, draftVersion: 16 as const, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal };

describe('player MSF link', () => {
  it.each(['', '#', '#log', '#top&c4m=AAH-_w', '#https://relay.test/moq#msf:live--catalog'])('ignores the unrelated fragment %j', hash => {
    expect(readMsfLink(hash, '?ns=live&url=https://relay.test/moq')).toBeUndefined();
  });

  it('takes namespace and track from the fragment and leaves the relay to ?url=', () => {
    expect(readMsfLink('#msf:hypersolid-drm.2dtest--catalog', '?url=https://relay.test/moq&v=16')).toEqual({
      namespace: ['hypersolid', 'drm-test'], catalogTrackName: 'catalog', notes: [],
    });
    expect(readMsfLink('msf:live--catalog.2dv2', '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog-v2', notes: [] });
  });

  it('takes the relay from a whole MSF URL, keeping its server query and dropping the fragment', () => {
    const link = readMsfLink('#moqt://relay.test:4433/moq?tenant=a#msf:live--catalog&connection=wt&c4m=AAH-_w', '?v=16')!;
    expect(link.relayUrl).toBe('https://relay.test:4433/moq?tenant=a');
    expect(link.namespace).toEqual(['live']);
    expect(link.authorization).toBeDefined();
  });

  it.each([[undefined, 1n], ['cat4moq', 1n], ['moqx-compat', 16n]] as const)('presents c4m with ?authProfile=%s and preserves opaque bytes', async (profile, tokenType) => {
    const link = readMsfLink('#msf:live--catalog&c4m=AAH+/w==', profile ? `?authProfile=${profile}` : '')!;
    const tokens = await link.authorization!.getTokens(ctx);
    expect(tokens).toEqual([{ tokenType, value: Uint8Array.of(0, 1, 254, 255) }]);
    tokens[0]!.value.fill(9);
    expect((await link.authorization!.getTokens({ ...ctx, operation: 'SUBSCRIBE' }))[0]!.value).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  it('rejects unknown profiles rather than falling back, but only when a token is present', () => {
    expect(() => readMsfLink('#msf:live--catalog&c4m=YWJj', '?authProfile=invalid')).toThrow('Invalid authorization profile');
    expect(readMsfLink('#msf:live--catalog', '?authProfile=invalid')!.authorization).toBeUndefined();
  });

  it('reads the page\'s own license parameter, percent-decoded', () => {
    const licenseUrl = 'https://drm.test/license?token=a+b&x=%20';
    const hash = `#${formatMsfFragment({ namespace: ['live'], trackName: 'catalog', parameters: [{ name: 'license', value: encodeURIComponent(licenseUrl) }] })}`;
    expect(hash).not.toContain('?');
    expect(readMsfLink(hash, '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog', licenseUrl, notes: [] });
  });

  it.each(['license=', 'license=%ff', 'license=drm.test%2Flicense', 'license=javascript%3Aalert(1)', 'license=https%3A%2F%2Fdrm.test%2F%23x',
    'license=https%3A%2F%2Fa.test%2F&license=https%3A%2F%2Fb.test%2F'])('rejects %j without echoing it', parameters => {
    let message = '';
    try { readMsfLink(`#msf:live--catalog&${parameters}`, ''); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/^MSF URL (repeats the license parameter|license parameter must be)/);
    expect(message).not.toMatch(/test|alert|zz/);
  });

  it('refuses a required native QUIC connection', () => {
    expect(() => readMsfLink('#msf:live--catalog&connection=q', '')).toThrow('native QUIC');
    expect(() => readMsfLink('#moqt://relay.test/moq#msf:live--catalog&connection=q', '')).toThrow('native QUIC');
  });

  it.each([
    ['#msf:live--catalog', '?ns=live', '?ns='],
    ['#msf:live--catalog', '?ns=', '?ns='],
    ['#msf:live--catalog', '?nsField=live', '?nsField='],
    ['#moqt://relay.test/moq#msf:live--catalog', '?url=https://relay.test/moq', '?url='],
    ['#msf:live--catalog&license=https%3A%2F%2Fdrm.test%2F', '?license=https://drm.test/', '?license='],
    ['#msf:live--catalog&c4m=YWJj', '?fetchCatalog=1', '?fetchCatalog=1'],
  ])('refuses %j together with %j', (hash, search, message) => {
    expect(() => readMsfLink(hash, search)).toThrow(message);
  });

  it('allows ?url=, ?license= and ?fetchCatalog=1 where the MSF URL does not set the same thing', () => {
    expect(readMsfLink('#msf:live--catalog', '?url=https://relay.test/moq&license=https://drm.test/&fetchCatalog=1')).toBeDefined();
    expect(readMsfLink('#moqt://relay.test/moq#msf:live--catalog', '?url=')).toBeDefined();
  });

  it.each(['#msf:', '#msf:live', '#MSF:live--catalog', '#msf:live--catalog&c4m=%%%', '#msf:live--catalog&c4m=YQ&c4m=YQ',
    '#moqt://#msf:live--catalog', '#moqt://relay.test/moq', '#MOQT:relay.test#msf:live--catalog'])('refuses the malformed MSF URL %j', hash => {
    expect(() => readMsfLink(hash, '')).toThrow(/^MSF /);
  });

  it('notes what it does not act on by name only', () => {
    const link = readMsfLink('#msf:live--catalog&location-range=34-64&mediatime-range=0-5&wallclock-range=7&secret=hunter2&other=1', '')!;
    expect(link.notes).toEqual([
      'wallclock-range is not supported by this page and is ignored',
      'mediatime-range is not supported by this page and is ignored',
      'location-range is not supported by this page and is ignored',
      '2 unrecognized parameters are ignored',
    ]);
    expect(readMsfLink('#msf:live--catalog&x=1', '')!.notes).toEqual(['1 unrecognized parameter is ignored']);
  });
});
