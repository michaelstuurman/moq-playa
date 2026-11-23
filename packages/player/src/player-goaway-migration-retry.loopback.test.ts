import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import type { PlayerError } from './errors.js';
import { MoqtPlayer } from './player.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';

// A relay restart hands its sockets to a new process and sends GOAWAY. Viewer
// and publisher both follow it, so the viewer can reach the new relay before
// the publisher has, and its first migration attempt fails. The player tries
// again while the draining session still serves, instead of giving up.

const decoder = new TextDecoder();

function peer(draft: 18 | 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  server.onSubscribe = (id, _namespace, name) => { requests.push({ id, name: decoder.decode(name) }); };
  let connected: Promise<void> | undefined;
  return {
    client, server, requests,
    start() { connected ??= server.connect(b); void connected.catch(() => {}); return a; },
    async close() { await client.close(); await server.close(); await connected?.catch(() => {}); },
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] }));
afterEach(() => vi.useRealTimers());

const NOT_YET = 'replacement catalog bootstrap failed: catalog is MSF-01 but was not retrievable via the mandated SUBSCRIBE + Joining FETCH';

async function playing(draft: 18 | 22, failures: number, failure = NOT_YET) {
  const old = peer(draft);
  const candidates: Array<ReturnType<typeof peer>> = [];
  let connects = 0;
  const errors: PlayerError[] = [];
  const player = new MoqtPlayer({
    url: 'https://relay.invalid/moq', namespace: 'live', draftVersion: draft, catalogBootstrap: 'subscribe',
    createConnection: () => {
      connects++;
      if (connects === 1) return old.client;
      const candidate = peer(draft);
      candidates.push(candidate);
      return candidate.client;
    },
    createTransport: async () => {
      if (connects === 1) return old.start();
      // The first `failures` replacement attempts find no publisher yet.
      if (connects - 1 <= failures) throw new Error(failure);
      return candidates.at(-1)!.start();
    },
    catalog: { version: 1, tracks: [{ name: 'video', role: 'video', packaging: 'loc', isLive: true,
      codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1 }] },
    disableAudio: true, autoQuality: false, connectionTimeoutMs: 5000,
  });
  player.on('error', event => { errors.push(event.error); });
  await player.load(); await flush(128);
  const request = old.requests.find(item => item.name === 'video');
  expect(request).toBeDefined();
  await old.server.acceptSubscribe(request!.id, 50n); await flush(128); player.play();
  old.server.setLargestLocationProvider(() => ({ group: 0n, object: 0n }));
  return {
    old, player, errors,
    connections: () => connects,
    async goaway() {
      await old.server.sendGoaway({ newSessionUri: '', requestId: 100n, timeout: 0n }); await flush(128);
    },
    async close() {
      await player.destroy();
      await old.close();
      for (const candidate of candidates) await candidate.close();
    },
  };
}

const migrationFailed = (errors: PlayerError[]) =>
  errors.filter(error => error.message.startsWith('Automatic GOAWAY migration failed'));

describe.each([18, 22] as const)('GOAWAY migration retry draft%i', draft => {
  it('tries again after a failed first attempt instead of reporting the migration failed', async () => {
    const f = await playing(draft, 1);
    try {
      await f.goaway();
      expect(f.connections()).toBe(2);
      await vi.advanceTimersByTimeAsync(400); await flush(256);
      expect(f.connections()).toBe(3);
      expect(migrationFailed(f.errors)).toEqual([]);
    } finally { await f.close(); }
  });

  it('reports any other replacement failure at once, without retrying', async () => {
    const f = await playing(draft, 100, 'replacement catalog update rejected: invalid initData');
    try {
      await f.goaway(); await flush(256);
      expect(f.connections()).toBe(2);
      expect(migrationFailed(f.errors)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000); await flush(256);
      expect(f.connections()).toBe(2);
    } finally { await f.close(); }
  });

  it('gives up after its last attempt and reports the failure once', async () => {
    const f = await playing(draft, 100);
    try {
      await f.goaway();
      await vi.advanceTimersByTimeAsync(10_000); await flush(256);
      // One original attempt plus four retries.
      expect(f.connections()).toBe(1 + 5);
      expect(migrationFailed(f.errors)).toHaveLength(1);
    } finally { await f.close(); }
  });
});
