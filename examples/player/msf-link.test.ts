import { describe, expect, it } from 'vitest';
import { readMsfLink } from './msf-link.js';

const ctx = { operation: 'SETUP' as const, draftVersion: 16 as const, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal };

describe('player MSF link', () => {
  it.each(['', '#', '#log', '#top&c4m=AAH-_w', '#https://relay.test/moq#msf:live--catalog'])('ignores the unrelated fragment %j', hash => {
    expect(readMsfLink(hash, '?ns=live&url=https://relay.test/moq')).toBeUndefined();
  });

  it('takes namespace and track from the fragment and leaves the relay to ?url=', () => {
    expect(readMsfLink('#msf:live-demo.2dtest--catalog', '?url=https://relay.test/moq&v=16')).toEqual({
      namespace: ['live', 'demo-test'], catalogTrackName: 'catalog', notes: [],
    });
    expect(readMsfLink('msf:live--catalog.2dv2', '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog-v2', notes: [] });
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
    const hash = `#msf:live--catalog&license=${encodeURIComponent(licenseUrl)}`;
    expect(hash.slice(1)).not.toContain('?');
    expect(readMsfLink(hash, '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog', licenseUrl, notes: [] });
  });

  it('reads the FairPlay license and certificate parameters', () => {
    const fairplayUrl = 'https://drm.test/fairplay/license?token=a';
    const fpsCertUrl = 'https://drm.test/fairplay/certificate';
    const hash = `#msf:live--catalog&fairplay=${encodeURIComponent(fairplayUrl)}&fpscert=${encodeURIComponent(fpsCertUrl)}`;
    expect(readMsfLink(hash, '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog', fairplayUrl, fpsCertUrl, notes: [] });
    expect(() => readMsfLink(hash, '?fairplay=x')).toThrow('?fairplay=');
    expect(() => readMsfLink('#msf:live--catalog&fpscert=nope', '')).toThrow(/^MSF URL fpscert parameter must be/);
  });

  it.each(['license=', 'license=%ff', 'license=drm.test%2Flicense', 'license=javascript%3Aalert(1)', 'license=https%3A%2F%2Fdrm.test%2F%23x',
    'license=https%3A%2F%2Fa.test%2F&license=https%3A%2F%2Fb.test%2F'])('rejects %j without echoing it', parameters => {
    let message = '';
    try { readMsfLink(`#msf:live--catalog&${parameters}`, ''); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/^MSF URL (repeats the license parameter|license parameter must be)/);
    expect(message).not.toMatch(/test|alert|zz/);
  });

  it('counts the license parameters apart from what it ignores', () => {
    const link = readMsfLink(`#msf:live--catalog&license=${encodeURIComponent('https://drm.test/l')}&other=1`, '')!;
    expect(link.notes).toEqual(['1 parameter is not supported by this page and ignored']);
  });

  it('refuses a required native QUIC connection and accepts WebTransport', () => {
    expect(() => readMsfLink('#msf:live--catalog&connection=q', '')).toThrow('native QUIC');
    expect(readMsfLink('#msf:live--catalog&connection=wt', '')).toBeDefined();
    expect(() => readMsfLink('#msf:live--catalog&%63onnection=q', '')).toThrow('native QUIC');
  });

  it.each([
    ['#msf:live--catalog&c4m=YWJj', '?fetchCatalog=1', '?fetchCatalog=1'],
  ])('refuses %j together with %j', (hash, search, message) => {
    expect(() => readMsfLink(hash, search)).toThrow(message);
  });

  it('allows ?url= and ?fetchCatalog=1 where the fragment does not set the same thing', () => {
    expect(readMsfLink('#msf:live--catalog', '?url=https://relay.test/moq&fetchCatalog=1')).toBeDefined();
  });

  it.each(['#msf:', '#msf:live', '#MSF:live--catalog', '#msf:live--catalog&c4m=%%%', '#msf:live--catalog&c4m=YQ&c4m=YQ'])('refuses the malformed MSF fragment %j', hash => {
    expect(() => readMsfLink(hash, '')).toThrow(/^MSF /);
  });

  it('counts what it does not act on, without names or values', () => {
    const link = readMsfLink('#msf:live--catalog&unknown=34-64&secret=hunter2&other=1', '')!;
    expect(link.notes).toEqual(['3 parameters are not supported by this page and ignored']);
    expect(readMsfLink('#msf:live--catalog&x=1', '')!.notes).toEqual(['1 parameter is not supported by this page and ignored']);
  });
});

it.each(['wallclock-range', 'mediatime-range', 'location-range', '%6cocation-range'])('refuses unsupported %s links without exposing values', name => {
  expect(() => readMsfLink(`#msf:live--catalog&${name}=1-2&${name}=3-4&c4m=YWJj`, ''))
    .toThrow('MSF URL ranges are not supported by this page');
});

it.each(['x=%ff', '%ff=1', 'x=%c3'])('accepts a link with one ignored non-UTF-8 parameter: %s', parameter => {
  expect(readMsfLink(`#msf:live--catalog&${parameter}`, '')).toEqual({
    namespace: ['live'], catalogTrackName: 'catalog',
    notes: ['1 parameter is not supported by this page and ignored'],
  });
});
