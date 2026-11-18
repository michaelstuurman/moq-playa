/**
 * MSF URL support for the player page (draft-ietf-moq-msf-01 §11.1).
 *
 * The MSF fragment lives in the PAGE'S FRAGMENT, which a browser never sends
 * to the server that hosts the page:
 *
 *   …/player/?url=https://relay/moq#msf:<namespace>--catalog&c4m=<token>
 *
 * The relay comes from `?url=` (or endpoint discovery) as before. The token is
 * never in a query string, which is the point: a `?msf=` parameter would hand
 * it to the page's host and its logs.
 *
 * No `window` access — the page passes `location.hash` and `location.search`.
 * Nothing here logs or echoes the fragment.
 */

import { parseMsfFragment } from '../shared/msf-url.js';
import type { PlayerAuthorization } from '@openmoq/player';
import { catAuthorization, catTokenType } from '../shared/cat-authorization.js';

export interface PlayerMsfLink {
    /** Namespace tuple; replaces `?ns=` / `?nsField=`. */
    readonly namespace: readonly string[];
    /** The track the URL names. This page can only start from a catalog, so it is subscribed as one. */
    readonly catalogTrackName: string;
    /** Presents the `c4m` token, typed per `?authProfile=`. */
    readonly authorization?: PlayerAuthorization;
    /** DRM license URL from the page's own `license` fragment parameter; replaces `?license=`. */
    readonly licenseUrl?: string;
    /** FairPlay license URL (`fairplay` fragment parameter); replaces `?fairplay=`. */
    readonly fairplayUrl?: string;
    /** FairPlay certificate URL (`fpscert` fragment parameter); replaces `?fpscert=`. */
    readonly fpsCertUrl?: string;
    /** Safe to log: fixed notices and counts, never input names or values. */
    readonly notes: readonly string[];
}

/**
 * Read the MSF fragment of a page, or `undefined` when the fragment holds none
 * (empty, or not beginning with `msf:`), in which case the page's query
 * parameters apply unchanged.
 *
 * The `c4m` token is sent as the CAT4MOQ token type unless `?authProfile=moqx-compat`
 * selects the type current moqx relays expect. The profile is not a secret and
 * stays in the query string.
 *
 * `license`, `fairplay` and `fpscert` are NOT MSF parameters. They are this
 * page's own use of non-reserved names, so that a license URL carrying its own
 * token can stay out of the query string as well. Their values are
 * percent-decoded.
 *
 * @throws {Error} a malformed MSF fragment; `connection=q`, which a browser
 *   cannot honour and §11.1.1 does not allow it to ignore; unsupported ranges;
 *   an invalid `?authProfile=`; a repeated or invalid `license`, `fairplay` or
 *   `fpscert`, or one also given in the query string.
 */
export function readMsfLink(hash: string, search: string): PlayerMsfLink | undefined {
    const text = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!/^msf:/i.test(text)) return undefined;
    const query = new URLSearchParams(search);
    const fragment = parseMsfFragment(text);
    if (fragment.connection === 'q') {
        throw new Error('MSF URL requires a native QUIC connection (connection=q); a browser can only use WebTransport');
    }

    // MSF-01 §11.1.1 requires range unions; this page cannot play ranges.
    if (fragment.parameters.some(({ name }) => ['wallclock-range', 'mediatime-range', 'location-range'].includes(name))) {
        throw new Error('MSF URL ranges are not supported by this page');
    }

    const urls = new Map<'license' | 'fairplay' | 'fpscert', string>();
    let ignored = 0;
    for (const { name, value } of fragment.parameters) {
        if (name !== 'license' && name !== 'fairplay' && name !== 'fpscert') { ignored++; continue; }
        if (urls.has(name)) throw new Error(`MSF URL repeats the ${name} parameter`);
        if (query.get(name)) throw new Error(`MSF URL and ?${name}= both set the same thing; remove ?${name}=`);
        urls.set(name, decodeLicenseUrl(value, name));
    }
    const licenseUrl = urls.get('license');
    const fairplayUrl = urls.get('fairplay');
    const fpsCertUrl = urls.get('fpscert');
    const notes = ignored > 0 ? [`${ignored} parameter${ignored > 1 ? 's are' : ' is'} not supported by this page and ignored`] : [];

    if (query.has('ns') || query.has('nsField')) {
        notes.push('?ns= and ?nsField= are ignored in favor of the fragment');
    }

    let authorization: PlayerAuthorization | undefined;
    if (fragment.c4m !== undefined) {
        // The pre-fetch connects on its own, outside the player's authorization.
        if (query.get('fetchCatalog') === '1') throw new Error('MSF URL c4m token cannot be combined with ?fetchCatalog=1 on this page');
        authorization = catAuthorization(catTokenType(query.get('authProfile') ?? 'cat4moq'), fragment.c4m);
    }

    return {
        namespace: fragment.namespace,
        catalogTrackName: fragment.trackName,
        ...(authorization ? { authorization } : {}),
        ...(licenseUrl !== undefined ? { licenseUrl } : {}),
        ...(fairplayUrl !== undefined ? { fairplayUrl } : {}),
        ...(fpsCertUrl !== undefined ? { fpsCertUrl } : {}),
        notes,
    };
}

function decodeLicenseUrl(value: string, name: string): string {
    try {
        const decoded = decodeURIComponent(value);
        const url = new URL(decoded);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.hash) return decoded;
    } catch { /* refused below, without the value */ }
    throw new Error(`MSF URL ${name} parameter must be a percent-encoded http(s) URL without a fragment`);
}
