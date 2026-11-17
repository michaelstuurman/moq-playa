import { describe, expect, it } from 'vitest';
import { fairplayLicenseUrl, sinfKid } from './mse-adapter.js';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function box(type: string, ...body: number[][]): number[] {
  const content = body.flat();
  const size = 8 + content.length;
  return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...ascii(type), ...content];
}

const kid = Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const kidHex = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';
const sinf = box('sinf', box('frma', ascii('mp4a')), box('schm', [0, 0, 0, 0], ascii('cbcs'), [0, 1, 0, 0]),
  box('schi', box('tenc', [0, 0, 0, 0, 0, 0, 1, 0], kid, [16], new Array(16).fill(7))));
// Safari's form: JSON with the base64 sinf box.
const safari = new TextEncoder().encode(JSON.stringify({ sinf: [btoa(String.fromCharCode(...sinf))] }));

describe('sinfKid', () => {
  it('reads the KID from Safari init data and from raw boxes', () => {
    expect(sinfKid(safari)).toBe(kidHex);
    expect(sinfKid(new Uint8Array(sinf))).toBe(kidHex);
  });

  it('gives null without a whole tenc', () => {
    expect(sinfKid(new TextEncoder().encode('{"sinf": []}'))).toBeNull();
    expect(sinfKid(new Uint8Array(box('sinf', box('frma', ascii('avc1')))))).toBeNull();
    expect(sinfKid(new Uint8Array(sinf.slice(0, sinf.length - 20)))).toBeNull();
  });
});

describe('fairplayLicenseUrl', () => {
  const base = 'https://drm.example/drm/v1/fairplay/license?token=abc';

  it('adds the track KID', () => {
    expect(fairplayLicenseUrl(base, safari)).toBe(`${base}&kid=${kidHex}`);
  });

  it('keeps a URL that names a kid, or init data without one', () => {
    expect(fairplayLicenseUrl(`${base}&kid=x`, safari)).toBe(`${base}&kid=x`);
    expect(fairplayLicenseUrl(base, new Uint8Array([1, 2, 3]))).toBe(base);
  });
});
