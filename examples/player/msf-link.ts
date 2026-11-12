/**
 * MSF URL support for the player page (draft-ietf-moq-msf-01 §11.1).
 *
 * The MSF URL lives in the PAGE'S FRAGMENT, which a browser never sends to
 * the server that hosts the page. Two forms are read:
 *
 *   …/player/?url=https://relay/moq#msf:<namespace>--catalog&c4m=<token>
 *   …/player/#moqt://relay/moq#msf:<namespace>--catalog&c4m=<token>
 *
 * The first carries only the MSF fragment and takes the relay from `?url=` (or
 * endpoint discovery) as before. The second carries a whole MSF URL and names
 * the relay too. Neither puts the token in a query string, which is the point:
 * a `?msf=` parameter would hand it to the page's host and its logs.
 *
 * No `window` access — the page passes `location.hash` and `location.search`.
 * Nothing here logs or echoes the fragment.
 */

import { parseMsfFragment, parseMsfUrl, type MsfFragment } from '@openmoq/msf';
import type { PlayerAuthorization } from '@openmoq/player';
import { catAuthorization, catTokenType } from '../shared/cat-authorization.js';

export interface PlayerMsfLink {
    /** Namespace tuple; replaces `?ns=` / `?nsField=`. */
    readonly namespace: readonly string[];
    /** The track the URL names. This page can only start from a catalog, so it is subscribed as one. */
    readonly catalogTrackName: string;
    /** WebTransport endpoint, when the fragment holds a whole MSF URL; replaces `?url=`. */
    readonly relayUrl?: string;
    /** Presents the `c4m` token, typed per `?authProfile=`. */
    readonly authorization?: PlayerAuthorization;
    /** DRM license URL from the page's own `license` fragment parameter; replaces `?license=`. */
    readonly licenseUrl?: string;
    /** Parts of the URL this page does not act on. Safe to log: names only, never values. */
    readonly notes: readonly string[];
}

/**
 * Read the MSF URL in a page fragment, or `undefined` when the fragment holds
 * none (empty, or not beginning with `msf:` or `moqt:`), in which case the
 * page's query parameters apply unchanged.
 *
 * `license` is NOT an MSF parameter. It is this page's own use of a
 * non-reserved name, so that a license URL carrying its own token can stay out
 * of the query string as well. Its value is percent-decoded.
 *
 * The `c4m` token is sent as the CAT4MOQ token type unless `?authProfile=moqx-compat`
 * selects the type current moqx relays expect. The profile is not a secret and
 * stays in the query string.
 *
 * @throws {Error} a malformed MSF URL; `connection=q`, which a browser cannot
 *   honour and §11.1.1 does not allow it to ignore; a setting given both in the
 *   MSF URL and in the query string; an invalid `license` or `?authProfile=`.
 */
export function readMsfLink(hash: string, search: string): PlayerMsfLink | undefined {
    const text = hash.startsWith('#') ? hash.slice(1) : hash;
    const whole = /^moqt:/i.test(text);
    if (!whole && !/^msf:/i.test(text)) return undefined;
    const query = new URLSearchParams(search);
    const conflict = (name: string): never => {
        throw new Error(`MSF URL and ?${name}= both set the same thing; remove ?${name}=`);
    };

    let fragment: MsfFragment;
    let relayUrl: string | undefined;
    if (whole) {
        const url = parseMsfUrl(text);
        if (query.get('url')) conflict('url');
        fragment = url;
        relayUrl = url.httpsUrl;
    } else {
        fragment = parseMsfFragment(text);
    }
    if (query.has('ns')) conflict('ns');
    if (query.has('nsField')) conflict('nsField');
    if (fragment.connection === 'q') {
        throw new Error('MSF URL requires a native QUIC connection (connection=q); a browser can only use WebTransport');
    }

    const notes: string[] = [];
    if (fragment.wallclockRanges.length > 0) notes.push('wallclock-range is not supported by this page and is ignored');
    if (fragment.mediatimeRanges.length > 0) notes.push('mediatime-range is not supported by this page and is ignored');
    if (fragment.locationRanges.length > 0) notes.push('location-range is not supported by this page and is ignored');

    let licenseUrl: string | undefined;
    let unknown = 0;
    for (const { name, value } of fragment.parameters) {
        if (name !== 'license') { unknown++; continue; }
        if (licenseUrl !== undefined) throw new Error('MSF URL repeats the license parameter');
        if (query.get('license')) conflict('license');
        licenseUrl = decodeLicenseUrl(value);
    }
    if (unknown > 0) notes.push(`${unknown} unrecognized parameter${unknown > 1 ? 's are' : ' is'} ignored`);

    let authorization: PlayerAuthorization | undefined;
    if (fragment.c4m !== undefined) {
        // The pre-fetch connects on its own, outside the player's authorization.
        if (query.get('fetchCatalog') === '1') throw new Error('MSF URL c4m token cannot be combined with ?fetchCatalog=1 on this page');
        authorization = catAuthorization(catTokenType(query.get('authProfile') ?? 'cat4moq'), fragment.c4m);
    }

    return {
        namespace: fragment.namespace,
        catalogTrackName: fragment.trackName,
        ...(relayUrl !== undefined ? { relayUrl } : {}),
        ...(authorization ? { authorization } : {}),
        ...(licenseUrl !== undefined ? { licenseUrl } : {}),
        notes,
    };
}

function decodeLicenseUrl(value: string): string {
    try {
        const decoded = decodeURIComponent(value);
        const url = new URL(decoded);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.hash) return decoded;
    } catch { /* refused below, without the value */ }
    throw new Error('MSF URL license parameter must be a percent-encoded http(s) URL without a fragment');
}
