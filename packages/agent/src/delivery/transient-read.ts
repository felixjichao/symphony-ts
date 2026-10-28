/** Only supported observation failures may be retried. Unknown errors, auth,
 * corrupt results/store and identity failures retain their original hard stop. */
export function isTransientReadError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof SyntaxError) return false;
  const code = "code" in error ? error.code : undefined;
  const status = "status" in error ? error.status : undefined;
  if (status === 401 || status === 403 || (typeof code === "string" &&
    !["http_error", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code))) return false;
  const message = error.message;
  if (/401|403|bad credentials|permission|unauthorized|forbidden|corrupt|identity/i.test(message)) return false;
  return (typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code))
    || [502, 503, 504].includes(Number(status)) || error.name === "TimeoutError"
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network|timed?\s*out|timeout|connection (reset|refused)|HTTP 50[234]/i.test(message);
}
