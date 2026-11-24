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

/**
 * When to license an announced key: `leadMs` before it takes effect, spread
 * over up to `spreadMs` earlier so viewers do not all ask at once; at once
 * (after up to `spreadMs / 10`) when that moment has passed.
 */
export function prelicenseDelay(validFrom: number, now: number, leadMs: number, spreadMs: number, random: number): number {
    const at = validFrom - leadMs - random * spreadMs;
    return at > now ? at - now : random * (spreadMs / 10);
}
