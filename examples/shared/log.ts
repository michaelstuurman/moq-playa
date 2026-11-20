/**
 * A log line without the tokens a URL in it may carry: people copy this log
 * into bug reports. JWTs and the values of `jwt=` and `token=` are left out.
 */
export function withoutTokens(msg: string): string {
  return msg
    .replace(/\b(jwt|token)=[^&#\s"']+/g, '$1=...')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '...');
}

/** Lines the on-page log keeps; older lines are dropped. */
export const MAX_LOG_LINES = 2000;

/** The part of the log element that appending uses (a <pre> in the pages). */
export interface LogElement {
  readonly ownerDocument: { createTextNode(data: string): Node };
  readonly childNodes: { readonly length: number };
  readonly firstChild: Node | null;
  appendChild(node: Node): unknown;
  removeChild(node: Node): unknown;
  scrollTop: number;
  readonly scrollHeight: number;
}

/** Elements with a scroll to the end already scheduled for the next frame. */
const scrollPending = new WeakSet<object>();

/**
 * Append one line as its own text node, drop the oldest lines beyond
 * `maxLines`, and scroll to the end once per frame however many lines arrive.
 *
 * The cost of a line stays flat over a long run. Appending with
 * `textContent +=` and scrolling for every line copied the whole log and laid
 * it out again each time: with ?msedebug=1 (about two mirrored lines a second)
 * that grew to some 200 ms per line after ten hours and stalled playback.
 */
export function appendLine(
  el: LogElement,
  line: string,
  maxLines = MAX_LOG_LINES,
  schedule: (callback: () => void) => void = nextFrame,
): void {
  el.appendChild(el.ownerDocument.createTextNode(line));
  while (el.childNodes.length > maxLines && el.firstChild) el.removeChild(el.firstChild);
  if (scrollPending.has(el)) return;
  scrollPending.add(el);
  schedule(() => {
    scrollPending.delete(el);
    el.scrollTop = el.scrollHeight;
  });
}

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
}

/** Append a line to the <pre id="log"> element. */
export function log(msg: string): void {
  const el = document.getElementById('log');
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  appendLine(el, `[${ts}] ${withoutTokens(msg)}\n`);
}

/** Clear the log element. */
export function clearLog(): void {
  const el = document.getElementById('log');
  if (el) el.textContent = '';
}
