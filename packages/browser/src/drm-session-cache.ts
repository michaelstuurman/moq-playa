/**
 * Caller-owned retention of EME MediaKeys and licensed key sessions across
 * MseMediaSource adapters, so returning to content whose key IDs are already
 * licensed needs no new license request.
 *
 * @module
 */

/** Statuses after which a key can never decrypt again (EME MediaKeyStatus). */
const DEAD_KEY_STATUSES: ReadonlySet<string> = new Set(['expired', 'internal-error', 'released']);
/** Widevine's PSSH SystemID, whose version-0 data lists key IDs in field 2. */
const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed';

export interface DrmSessionCacheOptions {
  /** Retained sessions, held or idle. Beyond it the least recently used idle
   *  session is closed; held sessions are never evicted. Default 8: hardware
   *  CDMs cap concurrent sessions. */
  readonly maxSessions?: number;
}

/** @internal One retained key session. */
export interface DrmCachedSession {
  readonly session: MediaKeySession;
  readonly partition: string;
  readonly initDataType: string;
  readonly initData: Uint8Array;
  /** Key IDs the CDM reported in keyStatuses, lowercase hex. */
  readonly keyIds: Set<string>;
  /** Every reported key is `usable`. A session never reported is not. */
  usable: boolean;
  /** Revocation callback of the adapter holding the session; null when idle. */
  holder: (() => void) | null;
}

/**
 * Keeps MediaKeys and usable temporary sessions for the lifetime of this
 * object instead of the adapter. Pass one instance as `drmConfig.sessionCache`
 * to every adapter on the same media element and call {@link close} when the
 * player is torn down; without one, an adapter's sessions close with it.
 *
 * Caveats:
 * - One cache per media element. A MediaKeys object attaches to one element at
 *   a time; a second element's setMediaKeys rejects and surfaces via onError.
 * - Partitioned by key system, server certificate and license URL. MediaKeys
 *   and sessions never cross partitions, so a license fetched for one URL (and
 *   any token in it) never decrypts for another. Credentials outside the URL
 *   are not part of DrmConfig and so are not part of the partition either.
 * - Reuse is by key ID: from `cenc` PSSH boxes (version 1, or Widevine
 *   version 0) matched against the CDM's keyStatuses. Initialization data
 *   without parseable key IDs reuses only a session from identical bytes.
 * - Only a session whose reported keys are all `usable` is reused. A key
 *   turning `expired`, `internal-error` or `released` closes its session, held
 *   or not; the next initialization requests a fresh license.
 * - An idle session does not talk to the license server: a renewal message
 *   with no adapter holding it closes it instead.
 * - Temporary sessions only; nothing outlives the page.
 */
export class DrmSessionCache {
  private readonly maxSessions: number;
  private readonly partitions = new Map<string, MediaKeys>();
  /** Insertion order is recency, oldest first. */
  private readonly entries = new Set<DrmCachedSession>();
  private readonly listeners = new Map<DrmCachedSession, { statuses: () => void; message: () => void }>();
  private isClosed = false;

  constructor(options: DrmSessionCacheOptions = {}) {
    const max = options.maxSessions ?? 8;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`maxSessions must be a positive integer (got ${max})`);
    }
    this.maxSessions = max;
  }

  /** Whether {@link close} ran. A closed cache retains nothing new. */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Close every retained session, including those a live adapter holds, and
   * forget all MediaKeys. Idempotent. The element keeps its current MediaKeys
   * attachment, as after an adapter's destroy(). Adapters constructed with a
   * closed cache report a setup error.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const entry of [...this.entries]) this.drop(entry, true);
    this.partitions.clear();
  }

  /**
   * @internal MediaKeys for one partition. Pending creations are not shared:
   * a retired permission prompt may never finish. When creations race, the
   * first to complete wins and later ones are discarded unused.
   */
  async mediaKeys(partition: string, create: () => Promise<MediaKeys>): Promise<MediaKeys> {
    if (this.isClosed) throw new Error('DrmSessionCache is closed');
    const known = this.partitions.get(partition);
    if (known) return known;
    const keys = await create();
    if (this.isClosed) throw new Error('DrmSessionCache is closed');
    const raced = this.partitions.get(partition);
    if (raced) return raced;
    this.partitions.set(partition, keys);
    return keys;
  }

  /**
   * @internal A usable session in this partition covering the initialization,
   * now held by `revoke`'s adapter. A previous holder is revoked first-come:
   * it forgets the session without closing it.
   */
  acquire(partition: string, initDataType: string, initData: Uint8Array, revoke: () => void): DrmCachedSession | null {
    if (this.isClosed) return null;
    const wanted = initDataKeyIds(initDataType, initData);
    for (const entry of this.entries) {
      if (entry.partition !== partition || !entry.usable) continue;
      const covers = wanted.size > 0
        ? [...wanted].every((id) => entry.keyIds.has(id))
        : entry.initDataType === initDataType && equalBytes(entry.initData, initData);
      if (!covers) continue;
      const previous = entry.holder;
      entry.holder = revoke;
      entry.session.removeEventListener('message', this.listeners.get(entry)!.message);
      this.entries.delete(entry);
      this.entries.add(entry);
      if (previous) previous();
      return entry;
    }
    return null;
  }

  /** @internal Retain a session an adapter just created and holds. Null once closed. */
  track(partition: string, session: MediaKeySession, initDataType: string, initData: Uint8Array, revoke: () => void): DrmCachedSession | null {
    if (this.isClosed) return null;
    const entry: DrmCachedSession = {
      session, partition, initDataType, initData, keyIds: new Set(), usable: false, holder: revoke,
    };
    const listeners = { statuses: () => this.observe(entry), message: () => this.drop(entry, true) };
    this.listeners.set(entry, listeners);
    this.entries.add(entry);
    session.addEventListener('keystatuseschange', listeners.statuses);
    void session.closed.then(() => this.drop(entry, false), () => this.drop(entry, false));
    this.evict();
    return entry;
  }

  /** @internal The holder is done. A session not yet usable is closed. */
  release(entry: DrmCachedSession, revoke: () => void): void {
    if (entry.holder !== revoke || !this.entries.has(entry)) return;
    entry.holder = null;
    if (!entry.usable) {
      this.drop(entry, true);
      return;
    }
    entry.session.addEventListener('message', this.listeners.get(entry)!.message);
    this.evict();
  }

  /** @internal Forget a session; `close` also closes it. Idempotent. */
  drop(entry: DrmCachedSession, close: boolean): void {
    if (!this.entries.delete(entry)) return;
    const listeners = this.listeners.get(entry)!;
    this.listeners.delete(entry);
    entry.session.removeEventListener('keystatuseschange', listeners.statuses);
    entry.session.removeEventListener('message', listeners.message);
    entry.holder = null;
    entry.usable = false;
    if (close) {
      try { void entry.session.close().catch(() => {}); } catch { /* Already closed by the CDM. */ }
    }
  }

  private observe(entry: DrmCachedSession): void {
    if (!this.entries.has(entry)) return;
    let usable = true;
    let dead = false;
    entry.keyIds.clear();
    try {
      entry.session.keyStatuses.forEach((status, keyId) => {
        entry.keyIds.add(hex(bufferBytes(keyId)));
        if (DEAD_KEY_STATUSES.has(status)) dead = true;
        if (status !== 'usable') usable = false;
      });
    } catch {
      dead = true;
    }
    if (dead) {
      this.drop(entry, true);
      return;
    }
    entry.usable = usable && entry.keyIds.size > 0;
  }

  private evict(): void {
    for (const entry of this.entries) {
      if (this.entries.size <= this.maxSessions) return;
      if (entry.holder === null) this.drop(entry, true);
    }
  }
}

/** @internal Partition identity for one key system, certificate and license URL. */
export function drmPartition(keySystem: string, licenseUrl: string, certificate: Uint8Array | undefined): string {
  return JSON.stringify([keySystem, licenseUrl, certificate ? hex(certificate) : null]);
}

/**
 * @internal Key IDs named by `cenc` initialization data, lowercase hex: every
 * version-1 PSSH box's KID list, plus Widevine version-0 data's key_id field.
 * Empty for other types and for any malformed box, so a caller falls back to
 * exact-bytes matching rather than trusting a partial parse.
 */
export function initDataKeyIds(initDataType: string, initData: Uint8Array): Set<string> {
  const ids = new Set<string>();
  if (initDataType !== 'cenc') return ids;
  const view = new DataView(initData.buffer, initData.byteOffset, initData.byteLength);
  let offset = 0;
  while (offset < initData.length) {
    if (offset + 32 > initData.length) return new Set();
    const size = view.getUint32(offset);
    const end = offset + size;
    if (size < 32 || end > initData.length || ascii(initData, offset + 4, 4) !== 'pssh') return new Set();
    const version = initData[offset + 8]!;
    const systemId = hex(initData.subarray(offset + 12, offset + 28));
    let p = offset + 28;
    if (version > 0) {
      const count = view.getUint32(p);
      p += 4;
      if (p + count * 16 + 4 > end) return new Set();
      for (let i = 0; i < count; i++, p += 16) ids.add(hex(initData.subarray(p, p + 16)));
    }
    const dataSize = view.getUint32(p);
    p += 4;
    if (p + dataSize !== end) return new Set();
    if (version === 0 && systemId === WIDEVINE_SYSTEM_ID) {
      const widevine = widevineKeyIds(initData.subarray(p, end));
      if (!widevine) return new Set();
      for (const id of widevine) ids.add(id);
    }
    offset = end;
  }
  return ids;
}

/** WidevinePsshData `key_id` (field 2) values of 16 bytes; null if malformed. */
function widevineKeyIds(data: Uint8Array): string[] | null {
  const ids: string[] = [];
  let p = 0;
  const varint = (): number | null => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (p >= data.length) return null;
      const byte = data[p++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return null;
  };
  while (p < data.length) {
    const tag = varint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    switch (tag % 8) {
      case 0: if (varint() === null) return null; break;
      case 1: p += 8; break;
      case 5: p += 4; break;
      case 2: {
        const length = varint();
        if (length === null || p + length > data.length) return null;
        if (field === 2 && length === 16) ids.push(hex(data.subarray(p, p + 16)));
        p += length;
        break;
      }
      default: return null;
    }
    if (p > data.length) return null;
  }
  return ids;
}

function bufferBytes(source: BufferSource): Uint8Array {
  return source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
