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

/** Where {@link DrmSessionCache.prelicense} licenses: the adapters' DrmConfig fields that name a partition. */
export interface PrelicenseConfig {
  readonly keySystem?: string;
  readonly licenseUrl: string;
  readonly serverCertificate?: Uint8Array;
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
  /** Licensed ahead of its content (prelicense). Only such a FairPlay session is matched by key ID. */
  prelicensed?: boolean;
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
      // FairPlay `sinf`: by key ID only for a session licensed ahead; a
      // track's own session is still matched by its exact bytes (video and
      // audio sharing one key each need their own request in Safari).
      const covers = wanted.size > 0 && (initDataType !== 'sinf' || entry.prelicensed === true)
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

  /**
   * License a key before any content needs it (key rotation: the next key a
   * catalog announces), so the adapter that meets that key later reuses the
   * session without a license request at that moment. Widevine-style `cenc`
   * initialization only; FairPlay is not prelicensed. Needs this partition's
   * MediaKeys, which an adapter using this cache creates.
   *
   * Resolves `true` once a usable session covers the initialization (also
   * when one already did), `false` when skipped: FairPlay, no MediaKeys yet,
   * closed cache, or initialization without key IDs. Rejects when the license
   * request fails; the session is then closed. The session is idle once
   * licensed and is evicted like any other idle session.
   */
  async prelicense(drm: PrelicenseConfig, initDataType: string, initData: Uint8Array,
      options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
    const keySystem = drm.keySystem ?? 'com.widevine.alpha';
    const fairplay = keySystem.startsWith('com.apple.fps');
    // Widevine and others license from `cenc` (pssh); FairPlay from a `sinf`
    // naming the key (see prelicenseFairplay).
    if (this.isClosed || initDataType !== (fairplay ? 'sinf' : 'cenc')) return false;
    const wanted = initDataKeyIds(initDataType, initData);
    if (wanted.size === 0) return false;
    const partition = drmPartition(keySystem, drm.licenseUrl, drm.serverCertificate);
    const keys = this.partitions.get(partition);
    if (!keys) return false;
    for (const entry of this.entries) {
      if (entry.partition === partition && entry.usable && (!fairplay || entry.prelicensed === true)
          && [...wanted].every((id) => entry.keyIds.has(id))) return true;
    }
    const data = initData.slice();
    const session = keys.createSession('temporary');
    const revoke = (): void => { /* Another adapter took it over: nothing held here to stop. */ };
    const entry = this.track(partition, session, initDataType, data, revoke);
    if (entry) entry.prelicensed = true;
    if (!entry) {
      try { void session.close().catch(() => {}); } catch { /* not opened */ }
      return false;
    }
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    options.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 30_000);
    try {
      // Every CDM message goes to the license server and its answer back:
      // Widevine first asks for the service certificate, then for the
      // license, so this answers more than one message until the key is usable.
      let onMessage: ((event: MediaKeyMessageEvent) => void) | null = null;
      const failed = new Promise<never>((_, reject) => {
        onMessage = (event: MediaKeyMessageEvent): void => {
          void (async () => {
            const url = fairplay ? fairplayKeyUrl(drm.licenseUrl, [...wanted][0]!) : drm.licenseUrl;
            const response = await fetch(url, { method: 'POST', body: event.message, signal: abort.signal });
            if (!response.ok) throw new Error(`License server returned ${response.status} ${response.statusText}`);
            await session.update(new Uint8Array(await response.arrayBuffer()));
          })().catch(reject);
        };
        abort.signal.addEventListener('abort', () => reject(new Error('prelicense aborted')));
      });
      failed.catch(() => { /* raced below; a failed generateRequest must not leave it unhandled */ });
      session.addEventListener('message', onMessage as unknown as EventListener);
      const usable = (async () => {
        // keyStatuses follow the license's update().
        while (!entry.usable) {
          if (abort.signal.aborted || !this.entries.has(entry)) throw new Error('prelicensed key not usable');
          await new Promise<void>((resolve) => {
            const done = (): void => { session.removeEventListener('keystatuseschange', done); resolve(); };
            session.addEventListener('keystatuseschange', done);
            abort.signal.addEventListener('abort', done);
          });
        }
      })();
      usable.catch(() => { /* raced below */ });
      try {
        await session.generateRequest(initDataType, data);
        await Promise.race([usable, failed]);
      } finally {
        session.removeEventListener('message', onMessage as unknown as EventListener);
      }
      return true;
    } catch (err) {
      this.drop(entry, true);
      throw err;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (this.entries.has(entry)) this.release(entry, revoke);
    }
  }

  /**
   * FairPlay: license the keys that follow the ones in use (key rotation).
   * `next` maps a key ID in use to the one that follows it, lowercase hex.
   * Safari requests a FairPlay license from a track's `sinf`, and matches a
   * licensed key to later content by the key ID in it, across sessions. So
   * for every retained usable FairPlay session whose key has a successor,
   * this requests a license from that session's `sinf` with the next key ID
   * in its place (video and audio each keep their own `sinf`). Resolves the
   * number of keys now licensed ahead; 0 when no session is usable yet.
   */
  async prelicenseFairplay(drm: PrelicenseConfig, next: ReadonlyMap<string, string>,
      options: { signal?: AbortSignal; timeoutMs?: number; log?: (line: string) => void } = {}): Promise<number> {
    const keySystem = drm.keySystem ?? '';
    if (this.isClosed || !keySystem.startsWith('com.apple.fps')) return 0;
    const partition = drmPartition(keySystem, drm.licenseUrl, drm.serverCertificate);
    const requests: Uint8Array[] = [];
    // Why a session yields no request, for the page log: no key material, only key IDs and box bytes.
    const note = options.log;
    if (note && this.entries.size === 0) note('prelicense: no retained sessions');
    for (const entry of this.entries) {
      const current = entry.initDataType === 'sinf' ? sinfKeyId(entry.initData) : null;
      const following = current === null ? undefined : next.get(current);
      const initData = following === undefined ? null : sinfWithKeyId(entry.initData, following);
      const eligible = entry.partition === partition && entry.usable && entry.initDataType === 'sinf';
      note?.(`prelicense: session type=${entry.initDataType} bytes=${entry.initData.byteLength} partition=${entry.partition === partition ? 'same' : 'other'}`
        + ` usable=${entry.usable} ahead=${entry.prelicensed === true} kid=${current ?? 'not found'} successor=${following ?? 'none'}`
        + ` request=${initData ? 'built' : 'none'} head=${hex((sinfBoxes(entry.initData)?.[0] ?? entry.initData).subarray(0, 24))}`);
      if (eligible && initData) requests.push(initData);
    }
    let licensed = 0;
    for (const initData of requests) if (await this.prelicense(drm, 'sinf', initData, options)) licensed++;
    return licensed;
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
    // FairPlay: the key the request named, whatever form the CDM reports it in.
    if (entry.initDataType === 'sinf' && entry.prelicensed) { const kid = sinfKeyId(entry.initData); if (kid) entry.keyIds.add(kid); }
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
  if (initDataType === 'sinf') {
    const kid = sinfKeyId(initData);
    if (kid) ids.add(kid);
    return ids;
  }
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

/** The `sinf` boxes of FairPlay `sinf` initialization data (JSON `{"sinf":[base64,...]}`), or the raw boxes. */
function sinfBoxes(initData: Uint8Array): Uint8Array[] | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(initData)) as { sinf?: unknown };
    const list = Array.isArray(json.sinf) ? json.sinf : typeof json.sinf === 'string' ? [json.sinf] : null;
    if (!list || list.some((item) => typeof item !== 'string')) return null;
    return (list as string[]).map((item) => Uint8Array.from(atob(item), (c) => c.charCodeAt(0)));
  } catch {
    return [initData];
  }
}

/** A child box of `type` within [from, to), by box boundaries: [payload start, box end), or null. */
function childBox(bytes: Uint8Array, from: number, to: number, type: string): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > to) return null;
    if (ascii(bytes, at + 4, 4) === type) return [at + 8, at + size];
    at += size;
  }
  return null;
}

/**
 * Offset of `tenc`'s default_KID in FairPlay `sinf` bytes, or -1. By box
 * boundaries when the bytes are a sinf box (sinf > schi > tenc, or tenc
 * directly under sinf); otherwise, as browsers hand these bytes over in more
 * than one shape, the first `tenc` type found.
 */
function tencKidOffset(sinf: Uint8Array): number {
  const outer = childBox(sinf, 0, sinf.byteLength, 'sinf');
  const schi = outer && childBox(sinf, outer[0], outer[1], 'schi');
  const tenc = outer && (schi ? childBox(sinf, schi[0], schi[1], 'tenc') : childBox(sinf, outer[0], outer[1], 'tenc'));
  // FullBox header (4), reserved and pattern (2), isProtected (1), IV size (1), then the KID.
  if (tenc) return tenc[0] + 8 + 16 <= tenc[1] ? tenc[0] + 8 : -1;
  for (let i = 4; i + 4 <= sinf.byteLength; i++) {
    if (sinf[i] === 0x74 && sinf[i + 1] === 0x65 && sinf[i + 2] === 0x6e && sinf[i + 3] === 0x63) {
      return i + 12 + 16 <= sinf.byteLength ? i + 12 : -1;
    }
  }
  return -1;
}

/** @internal The key ID (`tenc` default_KID, lowercase hex) FairPlay `sinf` initialization data names. */
export function sinfKeyId(initData: Uint8Array): string | null {
  const first = sinfBoxes(initData)?.[0];
  const at = first ? tencKidOffset(first) : -1;
  return first && at >= 0 ? hex(first.subarray(at, at + 16)) : null;
}

/** @internal The same `sinf` initialization data naming another key ID (32 hex digits); null if it cannot be built. */
export function sinfWithKeyId(initData: Uint8Array, keyId: string): Uint8Array | null {
  const boxes = sinfBoxes(initData);
  if (!boxes || boxes.length === 0 || !/^[0-9a-f]{32}$/.test(keyId)) return null;
  const out: string[] = [];
  for (const box of boxes) {
    const at = tencKidOffset(box);
    if (at < 0) return null;
    const copy = box.slice();
    for (let i = 0; i < 16; i++) copy[at + i] = parseInt(keyId.slice(2 * i, 2 * i + 2), 16);
    out.push(btoa(String.fromCharCode(...copy)));
  }
  return new TextEncoder().encode(JSON.stringify({ sinf: out }));
}

/** The FairPlay license URL of one key: the configured URL plus `kid`, unless it names one. */
function fairplayKeyUrl(licenseUrl: string, keyId: string): string {
  try {
    // An absolute URL needs no base; a page without a usable location must not lose `kid`.
    let url: URL;
    try { url = new URL(licenseUrl); } catch { url = new URL(licenseUrl, globalThis.location?.href); }
    if (url.searchParams.has('kid')) return licenseUrl;
    url.searchParams.set('kid', keyId);
    return url.toString();
  } catch {
    return licenseUrl;
  }
}
