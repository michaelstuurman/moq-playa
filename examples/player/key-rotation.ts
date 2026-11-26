/**
 * DRM key rotation (moqt-encoder docs/drm.md, "Key rotation"): while the next
 * key is announced, every protected track of the catalog names its
 * contentProtections entries in `nextContentProtectionRefIDs`, with the
 * moment it takes effect in `nextKeyValidFrom`. These producer-defined track
 * fields are read from the raw catalog text: the catalog parser keeps only
 * spec fields.
 */

/** One announced key of one DRM system. */
export interface AnnouncedKey {
    /** Default KID, lowercase hyphenated. */
    readonly kid: string;
    /** When it takes effect, Unix milliseconds. */
    readonly validFrom: number;
    /** The entry's pssh box. */
    readonly pssh: Uint8Array;
}

/** The announced keys of DRM system `systemId` (hyphenated UUID) in a catalog's text, once per KID. */
export function announcedKeys(catalogText: string, systemId: string): AnnouncedKey[] {
    let catalog: unknown;
    try {
        catalog = JSON.parse(catalogText);
    } catch {
        return [];
    }
    if (typeof catalog !== 'object' || catalog === null) return [];
    const root = catalog as { tracks?: unknown; contentProtections?: unknown };
    if (!Array.isArray(root.tracks) || !Array.isArray(root.contentProtections)) return [];
    const entries = new Map<string, { kid: string; pssh: string }>();
    for (const cp of root.contentProtections as Array<Record<string, unknown>>) {
        const system = cp?.['drmSystem'] as Record<string, unknown> | undefined;
        const kids = cp?.['defaultKID'];
        if (typeof cp?.['refID'] !== 'string' || !system || typeof system['pssh'] !== 'string'
            || String(system['systemID']).toLowerCase() !== systemId || !Array.isArray(kids) || typeof kids[0] !== 'string') continue;
        entries.set(cp['refID'], { kid: kids[0].toLowerCase(), pssh: system['pssh'] });
    }
    const out = new Map<string, AnnouncedKey>();
    for (const track of root.tracks as Array<Record<string, unknown>>) {
        const refs = track?.['nextContentProtectionRefIDs'];
        const validFrom = typeof track?.['nextKeyValidFrom'] === 'string' ? Date.parse(track['nextKeyValidFrom']) : NaN;
        if (!Array.isArray(refs) || !Number.isFinite(validFrom)) continue;
        for (const ref of refs) {
            const entry = typeof ref === 'string' ? entries.get(ref) : undefined;
            if (!entry || out.has(entry.kid)) continue;
            let pssh: Uint8Array;
            try {
                pssh = Uint8Array.from(atob(entry.pssh), (c) => c.charCodeAt(0));
            } catch {
                continue;
            }
            out.set(entry.kid, { kid: entry.kid, validFrom, pssh });
        }
    }
    return [...out.values()];
}

/** A key in use and the key that follows it, as lowercase hex key IDs. */
export interface AnnouncedChange {
    readonly current: string;
    readonly next: string;
    /** When `next` takes effect, Unix milliseconds. */
    readonly validFrom: number;
}

/**
 * Per key in use, the announced key that follows it, from any DRM system's
 * entries (a key ID is the same for every system). For FairPlay, which
 * licenses by key ID.
 */
export function announcedChanges(catalogText: string): AnnouncedChange[] {
    let catalog: unknown;
    try {
        catalog = JSON.parse(catalogText);
    } catch {
        return [];
    }
    if (typeof catalog !== 'object' || catalog === null) return [];
    const root = catalog as { tracks?: unknown; contentProtections?: unknown };
    if (!Array.isArray(root.tracks) || !Array.isArray(root.contentProtections)) return [];
    const kids = new Map<string, string>();
    for (const cp of root.contentProtections as Array<Record<string, unknown>>) {
        const list = cp?.['defaultKID'];
        if (typeof cp?.['refID'] === 'string' && Array.isArray(list) && typeof list[0] === 'string') {
            kids.set(cp['refID'], list[0].toLowerCase().replace(/-/g, ''));
        }
    }
    const out = new Map<string, AnnouncedChange>();
    for (const track of root.tracks as Array<Record<string, unknown>>) {
        const now = track?.['contentProtectionRefIDs'], after = track?.['nextContentProtectionRefIDs'];
        const validFrom = typeof track?.['nextKeyValidFrom'] === 'string' ? Date.parse(track['nextKeyValidFrom']) : NaN;
        if (!Array.isArray(now) || !Array.isArray(after) || !Number.isFinite(validFrom)) continue;
        const current = kids.get(String(now[0])), next = kids.get(String(after[0]));
        if (current && next && current !== next && /^[0-9a-f]{32}$/.test(current) && /^[0-9a-f]{32}$/.test(next) && !out.has(current)) {
            out.set(current, { current, next, validFrom });
        }
    }
    return [...out.values()];
}

/**
 * When to license an announced key: `leadMs` before it takes effect, spread
 * over up to `spreadMs` earlier so viewers do not all ask at once; at once
 * (after up to `spreadMs / 10`) when that moment has passed.
 */
export function prelicenseDelay(validFrom: number, now: number, leadMs: number, spreadMs: number, random: number): number {
    const at = validFrom - leadMs - random * spreadMs;
    return at > now ? at - now : random * (spreadMs / 10);
}

/** setTimeout's longest delay (2^31 - 1 ms, ~24.8 days); a longer one fires at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Runs `run` after `delayMs`, also beyond setTimeout's limit (a key rotation
 * period may be 30 days), by waiting in steps; `cancelled` is asked at every
 * step and stops it. `timer` is for tests.
 */
export function afterDelay(delayMs: number, run: () => void, cancelled: () => boolean = () => false,
    timer: (callback: () => void, ms: number) => unknown = setTimeout): void {
    const step = Math.min(Math.max(delayMs, 0), MAX_TIMEOUT_MS);
    timer(() => {
        if (cancelled()) return;
        const left = delayMs - step;
        if (left > 0) afterDelay(left, run, cancelled, timer);
        else run();
    }, step);
}
