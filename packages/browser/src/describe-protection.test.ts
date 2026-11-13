import { describe, expect, it } from 'vitest';
import { describeProtection } from './mse-adapter.js';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
function box(type: string, ...body: number[][]): number[] {
  const content = body.flat();
  const size = 8 + content.length;
  return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...ascii(type), ...content];
}

describe('describeProtection', () => {
  it('summarizes a cbcs sample entry', () => {
    const kid = Array.from({ length: 16 }, (_, i) => i);
    const tenc = box('tenc', [1, 0, 0, 0, 0, 0x19, 1, 0], kid, [16], new Array(16).fill(7));
    const sinf = box('sinf', box('frma', ascii('avc3')), box('schm', [0, 0, 0, 0], ascii('cbcs'), [0, 1, 0, 0]),
      box('schi', tenc));
    const encv = box('encv', new Array(78).fill(0), sinf);
    const stsd = box('stsd', [0, 0, 0, 0, 0, 0, 0, 1], encv);
    const init = new Uint8Array([...box('ftyp', ascii('iso6')), ...box('moov', box('trak', stsd))]);
    expect(describeProtection(init)).toBe(
      'entry=encv frma=avc3 schm=cbcs v1.0 tenc v1 crypt:skip=1:9 protected=1 ivsize=0'
      + ' kid=000102030405060708090a0b0c0d0e0f constiv=16 bytes pssh=no');
  });

  it('says when there is no protection', () => {
    const init = new Uint8Array(box('moov', box('stsd', [0, 0, 0, 0, 0, 0, 0, 1], box('avc1', new Array(78).fill(0)))));
    expect(describeProtection(init)).toBe('entry=avc1 sinf=none pssh=no');
  });
});
