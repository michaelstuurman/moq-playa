/**
 * A log line without the tokens a URL in it may carry: people copy this log
 * into bug reports. JWTs and the values of `jwt=` and `token=` are left out.
 */
export function withoutTokens(msg: string): string {
  return msg
    .replace(/\b(jwt|token)=[^&#\s"']+/g, '$1=...')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '...');
}

/** Append a line to the <pre id="log"> element. */
export function log(msg: string): void {
  const el = document.getElementById('log');
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  el.textContent += `[${ts}] ${withoutTokens(msg)}\n`;
  el.scrollTop = el.scrollHeight;
}

/** Clear the log element. */
export function clearLog(): void {
  const el = document.getElementById('log');
  if (el) el.textContent = '';
}
