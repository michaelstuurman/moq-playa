/**
 * MSF URLs (draft-ietf-moq-msf-01 §11.1).
 *
 * An MSF URL names a MOQT session and one track within it:
 *
 *   moqt://authority/path?query#msf:<namespace-name>[&name=value ...]
 *
 * Everything before `#` identifies the session and is sent to the server.
 * The fragment is CLIENT-SIDE: it carries the track and the client's
 * parameters — including the `c4m` token — and never reaches the server as
 * part of the URL. Callers must keep it that way: do not copy a parsed
 * fragment into a query string, a log, or a link meant for someone else.
 *
 * Where the draft is silent this module refuses rather than guesses; each such
 * choice is marked CHOICE below. Errors never echo the input, because any part
 * of it may be a mistyped credential.
 *
 * LIMITATION: a namespace field and a track name are byte strings on the wire,
 * but this library carries them as text (see track-identity.ts). A URL whose
 * escapes do not decode to well-formed UTF-8 is refused, not approximated.
 *
 * @see draft-ietf-moq-msf-01 §11.1, §11.1.1, §11.1.2
 * @see RFC 3986 §3 (authority, path-abempty, query, pchar)
 * @module
 */

import { assertUtf8EncodableIdentityText } from './track-identity.js';

/** An inclusive range of milliseconds (§11.1.1). No `endMs` means open-ended. */
export interface MsfTimeRange {
    readonly startMs: number;
    readonly endMs?: number;
}

/**
 * A MOQT Location as written in `location-range` (§11.1.1).
 *
 * An omitted `object` is NOT zero. It means the whole group: the first object
 * when it opens a range, the last one when it closes it.
 */
export interface MsfLocation {
    readonly group: bigint;
    readonly object?: bigint;
}

/** An inclusive range of Locations (§11.1.1). No `end` runs to the end of the content. */
export interface MsfLocationRange {
    readonly start: MsfLocation;
    readonly end?: MsfLocation;
}

/** A fragment parameter this module does not interpret, exactly as written. */
export interface MsfUrlParameter {
    readonly name: string;
    /** NOT percent-decoded: §11.1 does not say that a parameter value is. */
    readonly value: string;
}

/** The `msf:` fragment of an MSF URL (§11.1). */
export interface MsfFragment {
    /** Namespace tuple, one string per field (§11.1.2). At least one field, none empty. */
    readonly namespace: readonly string[];
    /** Track name. The draft's examples name the catalog, but any track may be named. */
    readonly trackName: string;
    /** `q` — native QUIC MUST be used; `wt` — WebTransport MUST be used; absent — either. */
    readonly connection?: 'q' | 'wt';
    /** The decoded `c4m` token: opaque bytes for the relay to validate. */
    readonly c4m?: Uint8Array;
    /** Union of every `wallclock-range`, in ms since the Unix epoch; sorted, overlaps merged. */
    readonly wallclockRanges: readonly MsfTimeRange[];
    /** Union of every `mediatime-range`, in ms; sorted, overlaps merged. */
    readonly mediatimeRanges: readonly MsfTimeRange[];
    /** Union of every `location-range`; sorted, overlaps merged. */
    readonly locationRanges: readonly MsfLocationRange[];
    /** Non-reserved parameters in document order. Names are case-sensitive and may repeat. */
    readonly parameters: readonly MsfUrlParameter[];
}

/** A parsed MSF URL (§11.1). */
export interface MsfUrl extends MsfFragment {
    /** The session: the URL up to, not including, `#`. The scheme is lower-cased, the rest is as written. */
    readonly sessionUrl: string;
    /** `sessionUrl` with the scheme replaced by `https` (§11.1): the WebTransport endpoint. */
    readonly httpsUrl: string;
}

type Optional<T> = { readonly [K in keyof T]?: T[K] | undefined };

/** Input of {@link formatMsfFragment}. Absent and `undefined` members are omitted from the output. */
export type MsfFragmentInit =
    Pick<MsfFragment, 'namespace' | 'trackName'> & Optional<Omit<MsfFragment, 'namespace' | 'trackName'>>;

/** Input of {@link formatMsfUrl}. */
export type MsfUrlInit = MsfFragmentInit & {
    /** The session as a `moqt://` or `https://` URL, without a fragment. */
    readonly sessionUrl: string;
};

// RFC 3986 character classes, without pct-encoded.
const UNRESERVED = 'A-Za-z0-9\\-._~';
const SUB_DELIMS = "!$&'()*+,;=";
const PCT = '%[0-9A-Fa-f]{2}';
const PCHAR = `(?:[${UNRESERVED}${SUB_DELIMS}:@]|${PCT})`;

// reg-name must be non-empty: §11.1 requires the authority to contain the host.
// IP-literal content is checked by the URL parser below.
const AUTHORITY = new RegExp(`^(?:\\[[0-9A-Fa-f:.]+\\]|(?:[${UNRESERVED}${SUB_DELIMS}]|${PCT})+)(?::([0-9]+))?$`);
const PATH_ABEMPTY = new RegExp(`^(?:/${PCHAR}*)*$`);
const QUERY = new RegExp(`^(?:${PCHAR}|[/?])*$`);
// §11.1: *( pchar-no-amp / "/" ) — pchar without '&', and never '?'.
const FRAGMENT_COMPONENT = new RegExp(`^(?:[${UNRESERVED}!$'()*+,;=:@/]|${PCT})*$`);

/** Bound on the decoded `c4m` token, matching the 32 KiB credential bound in @openmoq/webtransport. */
const MAX_C4M_BYTES = 32_768;
/** MOQT Group and Object IDs are 62-bit variable-length integers. */
const MAX_LOCATION_ID = (1n << 62n) - 1n;
/** Sorts after every Location; stands for "no end" and for "the last object of the group". */
const UNBOUNDED = 1n << 64n;

/**
 * Parse an MSF URL.
 *
 * Stricter than RFC 3986 in three places, all CHOICES: userinfo is refused
 * (a credential there would be sent to the server, and §11.1 says the
 * authority holds "the host and optional port"); an empty port and port 0 are
 * refused; and `?` with an empty query is refused, since §11.1 says the
 * separator MUST be omitted when the query is absent.
 *
 * @throws {Error} not `moqt://`, malformed session part, missing or malformed
 *   `msf:` fragment — see {@link parseMsfFragment}.
 */
export function parseMsfUrl(text: string): MsfUrl {
    if (typeof text !== 'string') throw new TypeError('MSF URL must be a string');
    // The scheme is case-insensitive (§11.1).
    if (text.slice(0, 7).toLowerCase() !== 'moqt://') throw new Error('MSF URL must use the moqt:// scheme (§11.1)');
    const hash = text.indexOf('#');
    if (hash < 0) throw new Error('MSF URL must contain a "#msf:" fragment (§11.1)');
    const sessionUrl = formatSession(text.slice(7, hash));
    return { sessionUrl, httpsUrl: `https${sessionUrl.slice(4)}`, ...parseMsfFragment(text.slice(hash + 1)) };
}

/**
 * Parse the fragment of an MSF URL: `msf:` and everything after it, without
 * the leading `#`.
 *
 * Exposed separately for a client that already knows its session and receives
 * only the fragment, e.g. in the fragment of its own page URL.
 *
 * CHOICES, where §11.1 is silent:
 * - A parameter is split at its FIRST `=`. The grammar admits `=` in both
 *   param-name and param-value, so `a=b=c` is otherwise ambiguous.
 * - `connection` and `c4m` may each appear once. Only ranges are given a
 *   meaning when repeated (their union, §11.1.1).
 * - An empty namespace, namespace field, or track name is refused: the
 *   encoding of §11.1.2 cannot express one unambiguously.
 * - `c4m` accepts base64 with padding (RFC 4648 §4), and base64url with or
 *   without it (§5). Either way the encoding must be canonical and the two
 *   alphabets must not be mixed.
 * - Time values must be safe integers; Group and Object IDs must fit 62 bits.
 *
 * `.` escapes are accepted with upper-case hex digits and for bytes that need
 * no escaping, although §11.1.2 only ever produces the lower-case, minimal form.
 *
 * @throws {Error} missing `msf:` type, character outside the §11.1 grammar,
 *   malformed namespace-name string, malformed parameter, invalid or repeated
 *   reserved parameter.
 */
export function parseMsfFragment(fragment: string): MsfFragment {
    if (typeof fragment !== 'string') throw new TypeError('MSF URL fragment must be a string');
    // Fragment type names are not declared case-insensitive; "msf" is matched exactly.
    if (!fragment.startsWith('msf:')) throw new Error('MSF URL fragment must begin with "msf:" (§11.1)');
    // '&' only ever delimits: it is in neither the identifier's nor a parameter's alphabet.
    const [identifier = '', ...parameters] = fragment.slice(4).split('&');
    if (![identifier, ...parameters].every(part => FRAGMENT_COMPONENT.test(part))) {
        throw new Error('MSF URL fragment contains a character outside the msf-fragment grammar (§11.1)');
    }
    const track = decodeNamespaceName(identifier);

    let connection: 'q' | 'wt' | undefined;
    let c4m: Uint8Array | undefined;
    const wallclock: MsfTimeRange[] = [];
    const mediatime: MsfTimeRange[] = [];
    const location: MsfLocationRange[] = [];
    const other: MsfUrlParameter[] = [];
    for (const parameter of parameters) {
        if (parameter === '') throw new Error('MSF URL fragment has an empty parameter between or after "&" (§11.1)');
        const equals = parameter.indexOf('=');
        if (equals < 0) throw new Error('MSF URL fragment parameter has no "=" (§11.1)');
        if (equals === 0) throw new Error('MSF URL fragment parameter has an empty name (§11.1)');
        const name = parameter.slice(0, equals);
        const value = parameter.slice(equals + 1);
        // Key names are case-sensitive (§11.1.1): `Connection` is not reserved.
        switch (name) {
            case 'connection':
                if (connection !== undefined) throw new Error('MSF URL repeats the "connection" parameter (§11.1.1)');
                if (value !== 'q' && value !== 'wt') throw new Error('MSF URL "connection" must be "q" or "wt" (§11.1.1)');
                connection = value;
                break;
            case 'c4m':
                if (c4m !== undefined) throw new Error('MSF URL repeats the "c4m" parameter (§11.1.1)');
                c4m = decodeC4m(value);
                break;
            case 'wallclock-range': wallclock.push(parseTimeRange(value, name)); break;
            case 'mediatime-range': mediatime.push(parseTimeRange(value, name)); break;
            case 'location-range': location.push(parseLocationRange(value)); break;
            default: other.push({ name, value });
        }
    }
    return {
        ...track,
        ...(connection !== undefined ? { connection } : {}),
        ...(c4m !== undefined ? { c4m } : {}),
        wallclockRanges: unionTimeRanges(wallclock),
        mediatimeRanges: unionTimeRanges(mediatime),
        locationRanges: unionLocationRanges(location),
        parameters: other,
    };
}

/**
 * Build the `msf:` fragment (no leading `#`) for a track.
 *
 * Reserved parameters are written first, `parameters` after them, and `c4m`
 * last, as standard padded base64 ([C4M] refers to RFC 4648 base64). Ranges are
 * written as given, not merged. The result is re-parsed before it is returned,
 * so this never produces a fragment {@link parseMsfFragment} would refuse.
 *
 * The result CONTAINS THE TOKEN when `c4m` is given. Treat it as a credential.
 *
 * @throws {Error} anything {@link parseMsfFragment} refuses, or a reserved
 *   name in `parameters`.
 */
export function formatMsfFragment(init: MsfFragmentInit): string {
    if (!Array.isArray(init.namespace) || init.namespace.length === 0) {
        throw new Error('MSF namespace must have at least one field (§11.1.2)');
    }
    const fields = init.namespace.map((field: string, index: number) => encodeElement(field, `MSF namespace field ${index}`));
    let out = `msf:${fields.join('-')}--${encodeElement(init.trackName, 'MSF track name')}`;
    if (init.connection !== undefined) out += `&connection=${init.connection}`;
    for (const range of init.wallclockRanges ?? []) out += `&wallclock-range=${formatTimeRange(range)}`;
    for (const range of init.mediatimeRanges ?? []) out += `&mediatime-range=${formatTimeRange(range)}`;
    for (const range of init.locationRanges ?? []) out += `&location-range=${formatLocationRange(range)}`;
    for (const { name, value } of init.parameters ?? []) {
        if (RESERVED.has(name)) throw new Error(`"${name}" is a reserved MSF URL parameter (§11.1.1)`);
        // Checked here, not by the re-parse: '&' or '=' would silently yield OTHER parameters.
        if (typeof name !== 'string' || typeof value !== 'string' || name.includes('=')
            || !FRAGMENT_COMPONENT.test(name) || !FRAGMENT_COMPONENT.test(value)) {
            throw new Error('MSF URL parameter contains a character outside the msf-fragment grammar (§11.1)');
        }
        out += `&${name}=${value}`;
    }
    if (init.c4m !== undefined) out += `&c4m=${encodeBase64(init.c4m)}`;
    parseMsfFragment(out);
    return out;
}

/**
 * Build an MSF URL. `sessionUrl` may be given as `https://`, the form a
 * WebTransport client already holds; the result always uses `moqt://`.
 *
 * @throws {Error} anything {@link parseMsfUrl} or {@link formatMsfFragment} refuses.
 */
export function formatMsfUrl(init: MsfUrlInit): string {
    const session = typeof init.sessionUrl === 'string' ? /^(?:moqt|https):\/\/(.*)$/is.exec(init.sessionUrl)?.[1] : undefined;
    if (session === undefined) throw new Error('MSF session URL must use the moqt:// or https:// scheme (§11.1)');
    if (session.includes('#')) throw new Error('MSF session URL must not contain a fragment (§11.1)');
    return `${formatSession(session)}#${formatMsfFragment(init)}`;
}

const RESERVED = new Set(['wallclock-range', 'mediatime-range', 'location-range', 'c4m', 'connection']);

/** Validate `authority path-abempty [ "?" query ]` and return it as a `moqt://` URL. */
function formatSession(rest: string): string {
    const question = rest.indexOf('?');
    const hier = question < 0 ? rest : rest.slice(0, question);
    const slash = hier.indexOf('/');
    const authority = slash < 0 ? hier : hier.slice(0, slash);
    if (authority.includes('@')) throw new Error('MSF URL must not contain userinfo (§11.1)');
    const match = AUTHORITY.exec(authority);
    if (!match) throw new Error('MSF URL must contain a valid host and optional port (§11.1)');
    if (match[1] !== undefined && !(Number(match[1]) >= 1 && Number(match[1]) <= 65535)) {
        throw new Error('MSF URL port must be between 1 and 65535 (§11.1)');
    }
    if (!PATH_ABEMPTY.test(slash < 0 ? '' : hier.slice(slash))) throw new Error('MSF URL path is malformed (§11.1)');
    if (question >= 0) {
        if (question === rest.length - 1) throw new Error('MSF URL must omit "?" when it has no query (§11.1)');
        if (!QUERY.test(rest.slice(question + 1))) throw new Error('MSF URL query is malformed (§11.1)');
    }
    // The grammar above does not validate the inside of an IP literal.
    try { new URL(`https://${authority}`); }
    catch { throw new Error('MSF URL must contain a valid host and optional port (§11.1)'); }
    return `moqt://${rest}`;
}

// ─── Namespace-name string (§11.1.2) ─────────────────────────────────

function isLiteral(byte: number): boolean {
    return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
}

function encodeElement(text: string, what: string): string {
    if (typeof text !== 'string' || text === '') throw new Error(`${what} must be a non-empty string (§11.1.2)`);
    assertUtf8EncodableIdentityText(text, what);
    let out = '';
    for (const byte of new TextEncoder().encode(text)) {
        out += isLiteral(byte) ? String.fromCharCode(byte) : `.${byte.toString(16).padStart(2, '0')}`;
    }
    return out;
}

function decodeElement(text: string, what: string): string {
    if (text === '') throw new Error(`MSF namespace-name string has an empty ${what} (§11.1.2)`);
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit === 0x2e) {
            const hex = text.slice(i + 1, i + 3);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error(`MSF ${what} has a "." not followed by two hexadecimal digits (§11.1.2)`);
            bytes.push(parseInt(hex, 16));
            i += 2;
        } else if (isLiteral(unit)) {
            bytes.push(unit);
        } else {
            throw new Error(`MSF ${what} contains a character that must be escaped (§11.1.2)`);
        }
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
    catch { throw new Error(`MSF ${what} is not valid UTF-8, which this library requires of a track identity`); }
}

function decodeNamespaceName(text: string): Pick<MsfFragment, 'namespace' | 'trackName'> {
    // A hyphen in data is escaped as .2d, so the only "--" is the delimiter
    // between namespace and track name. Two of them cannot be told apart.
    const delimiter = text.indexOf('--');
    if (delimiter < 0) throw new Error('MSF namespace-name string has no "--" before the track name (§11.1.2)');
    if (text.indexOf('--', delimiter + 2) >= 0) throw new Error('MSF namespace-name string has more than one "--" (§11.1.2)');
    const namespace = text.slice(0, delimiter).split('-').map(field => decodeElement(field, 'namespace field'));
    return { namespace, trackName: decodeElement(text.slice(delimiter + 2), 'track name') };
}

// ─── Reserved parameters (§11.1.1) ───────────────────────────────────

/** "start[-end]". The dash and the end are omitted together or not at all. */
function splitRange(text: string, what: string): [string, string | undefined] {
    const parts = text.split('-');
    if (parts.length > 2) throw new Error(`MSF URL "${what}" has more than one "-" (§11.1.1)`);
    return [parts[0]!, parts[1]];
}

function parseDigits(text: string, what: string): bigint {
    if (!/^[0-9]+$/.test(text)) throw new Error(`MSF URL "${what}" has a missing or non-numeric value (§11.1.1)`);
    return BigInt(text);
}

function parseTimeRange(text: string, what: string): MsfTimeRange {
    const [start, end] = splitRange(text, what).map(part => {
        if (part === undefined) return undefined;
        const value = parseDigits(part, what);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MSF URL "${what}" value is too large (§11.1.1)`);
        return Number(value);
    });
    if (end === undefined) return { startMs: start! };
    if (end < start!) throw new Error(`MSF URL "${what}" ends before it starts (§11.1.1)`);
    return { startMs: start!, endMs: end };
}

function parseLocation(text: string): MsfLocation {
    // "." is omitted together with the Object ID (§11.1.1), so "16." is refused.
    const [group, object, ...rest] = text.split('.').map(part => {
        const value = parseDigits(part, 'location-range');
        if (value > MAX_LOCATION_ID) throw new Error('MSF URL "location-range" value exceeds 62 bits (§11.1.1)');
        return value;
    });
    if (rest.length > 0) throw new Error('MSF URL "location-range" Location has more than one "." (§11.1.1)');
    return object === undefined ? { group: group! } : { group: group!, object };
}

type Key = readonly [bigint, bigint];
const startKey = (location: MsfLocation): Key => [location.group, location.object ?? 0n];
const endKey = (location: MsfLocation | undefined): Key =>
    location === undefined ? [UNBOUNDED, UNBOUNDED] : [location.group, location.object ?? UNBOUNDED];
const compareKeys = (a: Key, b: Key): number =>
    a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : 0;

function parseLocationRange(text: string): MsfLocationRange {
    const [startText, endText] = splitRange(text, 'location-range');
    const start = parseLocation(startText);
    if (endText === undefined) return { start };
    const end = parseLocation(endText);
    // "16.24-16" is valid: an end without an Object ID covers its whole group.
    if (compareKeys(endKey(end), startKey(start)) < 0) throw new Error('MSF URL "location-range" ends before it starts (§11.1.1)');
    return { start, end };
}

/** §11.1.1: several ranges for one parameter mean their union. Touching ranges are left apart. */
function unionTimeRanges(ranges: MsfTimeRange[]): MsfTimeRange[] {
    const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
    const merged: MsfTimeRange[] = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        const lastEnd = last?.endMs ?? Infinity;
        if (last === undefined || range.startMs > lastEnd) { merged.push(range); continue; }
        const end = Math.max(lastEnd, range.endMs ?? Infinity);
        merged[merged.length - 1] = end === Infinity ? { startMs: last.startMs } : { startMs: last.startMs, endMs: end };
    }
    return merged;
}

function unionLocationRanges(ranges: MsfLocationRange[]): MsfLocationRange[] {
    const sorted = [...ranges].sort((a, b) => compareKeys(startKey(a.start), startKey(b.start)));
    const merged: MsfLocationRange[] = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last === undefined || compareKeys(startKey(range.start), endKey(last.end)) > 0) { merged.push(range); continue; }
        if (compareKeys(endKey(range.end), endKey(last.end)) <= 0) continue;
        merged[merged.length - 1] = range.end === undefined ? { start: last.start } : { start: last.start, end: range.end };
    }
    return merged;
}

function formatTimeRange(range: MsfTimeRange): string {
    return range.endMs === undefined ? `${range.startMs}` : `${range.startMs}-${range.endMs}`;
}

function formatLocation(location: MsfLocation): string {
    return location.object === undefined ? `${location.group}` : `${location.group}.${location.object}`;
}

function formatLocationRange(range: MsfLocationRange): string {
    return range.end === undefined ? formatLocation(range.start) : `${formatLocation(range.start)}-${formatLocation(range.end)}`;
}

// ─── c4m (§11.1.1) ───────────────────────────────────────────────────

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode the `c4m` value. Never throws with the value in the message.
 *
 * Non-canonical input (non-zero bits after the last whole byte) is refused so
 * that one token has one spelling per alphabet. The token fragment printed in
 * §11.1.1 is such a string — it is cut short for display — and does not decode.
 */
function decodeC4m(text: string): Uint8Array {
    const invalid = (): never => { throw new Error('MSF URL "c4m" is not a valid base64 token (§11.1.1)'); };
    // Check the encoded size before decoding an untrusted credential.
    if (text === '' || text.length > 4 * Math.ceil(MAX_C4M_BYTES / 3)) invalid();
    const urlSafe = !/[+/]/.test(text);
    const data = text.replace(/={1,2}$/, '');
    const padding = text.length - data.length;
    if (!(urlSafe ? /^[A-Za-z0-9\-_]+$/ : /^[A-Za-z0-9+/]+$/).test(data)) invalid();
    // Padding, when present, must complete the quantum; RFC 4648 §4 base64 requires it.
    if (data.length % 4 === 1 || (padding > 0 ? (data.length + padding) % 4 !== 0 : !urlSafe && data.length % 4 !== 0)) invalid();
    const out = new Uint8Array(Math.floor(data.length * 6 / 8));
    let accumulator = 0;
    let bits = 0;
    let length = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data[i]!;
        accumulator = (accumulator << 6) | BASE64.indexOf(char === '-' ? '+' : char === '_' ? '/' : char);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[length++] = accumulator >> bits;
            accumulator &= (1 << bits) - 1;
        }
    }
    if (accumulator !== 0 || out.length > MAX_C4M_BYTES) invalid();
    return out;
}

function encodeBase64(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('MSF URL "c4m" token must be a non-empty Uint8Array (§11.1.1)');
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += BASE64[chunk >> 18]! + BASE64[(chunk >> 12) & 63]!
            + (i + 1 < bytes.length ? BASE64[(chunk >> 6) & 63]! : '=')
            + (i + 2 < bytes.length ? BASE64[chunk & 63]! : '=');
    }
    return out;
}
