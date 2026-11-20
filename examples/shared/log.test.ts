import { describe, expect, it } from 'vitest';

import { appendLine, MAX_LOG_LINES, withoutTokens, type LogElement } from './log.js';

/** A <pre> with only what appending uses; text nodes are plain objects. */
class FakeLog implements LogElement {
    readonly nodes: Array<{ data: string }> = [];
    scrollTop = 0;
    readonly ownerDocument = { createTextNode: (data: string) => ({ data }) as unknown as Node };
    get childNodes() { return { length: this.nodes.length }; }
    get firstChild() { return (this.nodes[0] ?? null) as unknown as Node | null; }
    get scrollHeight() { return this.nodes.length * 10; }
    get text() { return this.nodes.map(node => node.data).join(''); }
    appendChild(node: Node) { this.nodes.push(node as unknown as { data: string }); }
    removeChild(node: Node) {
        const at = this.nodes.indexOf(node as unknown as { data: string });
        if (at < 0) throw new Error('not a child');
        this.nodes.splice(at, 1);
    }
}

describe('withoutTokens', () => {
    it('leaves out jwt= and token= values and bare JWTs', () => {
        const jwt = 'eyJ0eXAiOiJKV1Qi.eyJleHAiOjE3OTQ1OTQ5NjB9.F5yuihWYY17BmZIcDYDo';
        expect(withoutTokens(`Relay: https://relay.example/?jwt=${jwt}`)).toBe('Relay: https://relay.example/?jwt=...');
        expect(withoutTokens(`Connecting to https://relay.example/?jwt=${jwt}&v=18...`)).toBe('Connecting to https://relay.example/?jwt=...&v=18...');
        expect(withoutTokens(`license https://l.example/license?token=abc123`)).toBe('license https://l.example/license?token=...');
        expect(withoutTokens(`bearer ${jwt} seen`)).toBe('bearer ... seen');
    });

    it('keeps ordinary lines as they are', () => {
        for (const line of ['Catalog: 6 tracks', '  video-main | hev1.2.4.L120.B0 | 1280x720 | 5000kbps',
            'startup seek to 0.040 did not settle within 2000ms (seeking=true, currentTime=0.040)',
            '[DRM] video protection: entry=encv frma=avc3 schm=cbcs v1.0 tenc v1 crypt:skip=1:9']) {
            expect(withoutTokens(line)).toBe(line);
        }
    });
});

describe('appendLine', () => {
    it('appends each line as its own node, in order', () => {
        const el = new FakeLog();
        for (const line of ['a\n', 'b\n', 'c\n']) appendLine(el, line, MAX_LOG_LINES, () => {});
        expect(el.nodes).toHaveLength(3);
        expect(el.text).toBe('a\nb\nc\n');
    });

    it('keeps only the newest lines beyond the limit', () => {
        const el = new FakeLog();
        for (let i = 0; i < MAX_LOG_LINES + 500; i++) appendLine(el, `line ${i}\n`, MAX_LOG_LINES, () => {});
        expect(el.nodes).toHaveLength(MAX_LOG_LINES);
        expect(el.nodes[0]!.data).toBe('line 500\n');
        expect(el.nodes.at(-1)!.data).toBe(`line ${MAX_LOG_LINES + 499}\n`);
    });

    it('scrolls to the end once per frame however many lines arrive', () => {
        const el = new FakeLog(), frames: Array<() => void> = [];
        for (let i = 0; i < 50; i++) appendLine(el, `x${i}\n`, 20, callback => frames.push(callback));
        expect(frames).toHaveLength(1);
        expect(el.scrollTop).toBe(0);
        frames.shift()!();
        expect(el.scrollTop).toBe(el.scrollHeight);
        appendLine(el, 'next\n', 20, callback => frames.push(callback));
        expect(frames).toHaveLength(1);
    });
});
