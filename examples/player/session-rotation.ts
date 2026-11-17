// Session rotation for WebKit's WebTransport. Network.framework never returns
// flow-control credit on a WebTransport session: it stops receiving after
// 16 MiB in total or about 7,400 incoming unidirectional streams (WebKit bug
// 319818, FB25612910). So the player moves to a fresh session well before
// that, with the player's make-before-break migration: the new session is set
// up and subscribed next to the old one, the MediaSource, init and DRM sessions
// stay, and a FETCH fills the gap between the two.
//
// ?rotate=auto (default) rotates on WebKit only, ?rotate=on everywhere,
// ?rotate=off never, ?rotate=<MiB> everywhere at that many MiB.

export interface SessionBudget {
    bytes: number;
    streams: number;
}

export interface RotationLimits {
    readonly bytes: number;
    readonly streams: number;
}

/** Well below 16 MiB and 7,400 streams, with room for the migration itself. */
export const DEFAULT_LIMITS: RotationLimits = { bytes: 12 * 1024 * 1024, streams: 5000 };

/** WebKit, where every browser on iOS and Safari on the Mac run on Network.framework. */
export function isWebKit(userAgent: string): boolean {
    return /AppleWebKit/.test(userAgent) && !/Chrome\/|Chromium|Edg\/|OPR\//.test(userAgent);
}

/** The limits to rotate at, or null for no rotation. */
export function rotationLimits(param: string | null, userAgent: string): RotationLimits | null {
    if (param === 'off') return null;
    if (param === 'on') return DEFAULT_LIMITS;
    const mib = param === null ? NaN : Number(param);
    if (Number.isFinite(mib) && mib > 0) return { bytes: mib * 1024 * 1024, streams: DEFAULT_LIMITS.streams };
    return isWebKit(userAgent) ? DEFAULT_LIMITS : null;
}

export function overBudget(budget: SessionBudget, limits: RotationLimits): boolean {
    return budget.bytes >= limits.bytes || budget.streams >= limits.streams;
}

interface ReceptionHeader {
    readonly type: string;
    readonly streamId?: bigint | null;
    readonly payloadLength?: bigint;
    readonly propertiesLength?: number;
}
interface ObservableConnection {
    observeObjectReception?: (listener: (event: ReceptionHeader) => void) => () => void;
}

/** Counts payload bytes and distinct data streams that arrive on one MoQT connection. */
export function countReception(connection: unknown): SessionBudget {
    const budget: SessionBudget = { bytes: 0, streams: 0 };
    const seen = new Set<bigint>();
    (connection as ObservableConnection).observeObjectReception?.((event) => {
        if (event.type !== 'header') return;
        budget.bytes += Number(event.payloadLength ?? 0n) + (event.propertiesLength ?? 0);
        if (event.streamId != null && !seen.has(event.streamId)) {
            seen.add(event.streamId);
            budget.streams++;
        }
    });
    return budget;
}
