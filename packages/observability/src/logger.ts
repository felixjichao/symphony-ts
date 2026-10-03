/** SPEC §13.1 / §13.2: whitelist → redact → bounded JSON quoting → isolated sinks. */
import type { StructuredLogEvent } from "@symphony/domain";
export type { StructuredLogEvent } from "@symphony/domain";

export interface LogSink { write(line: string): void }
export interface StructuredLogger {
  /** Never throws, including hostile input properties, clock and stream failures. */
  emit(event: StructuredLogEvent): void;
  /** Retain old secrets for in-flight operations; values never leave this closure. */
  registerSecrets(values: readonly string[]): void;
  close(): void;
}
export interface StructuredLoggerOptions {
  readonly sinks?: readonly LogSink[];
  readonly secrets?: readonly string[];
  readonly now?: () => Date;
}
const CONTEXT = ["issue_url", "attempt", "thread_id", "turn_id", "codex_app_server_pid", "status", "duration_ms", "retry_in_ms", "retry_kind", "hook", "error_code", "operation"] as const;
const TEXT = ["message", "error", "stderr"] as const;
const NUMBERS = new Set<string>(["attempt", "duration_ms", "retry_in_ms"]);
const RAW_TEXT_LIMIT = 65536;
const CONTEXT_LIMIT = 4096;

/** Default operator output. Own the error listener until close, so EPIPE cannot crash. */
export function createStderrLogSink(stream: NodeJS.WriteStream = process.stderr): LogSink & { close(): void } {
  let blocked = false;
  const ignore = (): void => { blocked = true; };
  const resume = (): void => { blocked = false; };
  let pending = 0;
  let closed = false;
  const release = (): void => {
    // Node emits stream errors after invoking failed write callbacks.
    if (closed && pending === 0) setImmediate(() => {
      if (pending === 0) { stream.removeListener("error", ignore); stream.removeListener("drain", resume); }
    });
  };
  stream.on("error", ignore);
  stream.on("drain", resume);
  return {
    write(line) {
      if (closed || blocked) return;
      pending++;
      try { blocked = !stream.write(`${line}\n`, () => { pending--; release(); }); }
      catch (error) { pending--; release(); throw error; }
    },
    close() { closed = true; release(); },
  };
}
function primitive(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("invalid scalar");
}
/** Includes quotes and truncation marker in the escaped UTF-8 budget; no split codepoints. */
function quote(text: string, budget: number): string {
  if (Buffer.byteLength(JSON.stringify(text)) <= budget) return JSON.stringify(text);
  let clipped = "";
  let bytes = 2 + Buffer.byteLength("[truncated]");
  for (const char of text) {
    const cost = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + cost > budget) break;
    clipped += char;
    bytes += cost;
  }
  return JSON.stringify(`${clipped}[truncated]`);
}
function redact(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}
function render(event: StructuredLogEvent, secrets: readonly string[], timestamp: string): string {
  // Access only named scalar properties; never stringify input or Error/cause objects.
  const fields: [string, unknown][] = [["timestamp", event.timestamp ?? timestamp], ["severity", event.severity], ["event", event.event], ["outcome", event.outcome]];
  if (!/^(debug|info|warn|error)$/.test(event.severity) || !/^(started|completed|failed|retrying|stopped|omitted)$/.test(event.outcome)) throw new Error("invalid enum");
  if (event.reason !== undefined) {
    if (typeof event.reason !== "string" || Buffer.byteLength(JSON.stringify(event.reason)) > 128) throw new Error("oversized reason");
    fields.push(["reason", event.reason]);
  }
  if (event.scope === "issue" || event.scope === "session") {
    if ((event.issue_id !== null && typeof event.issue_id !== "string") || (event.issue_identifier !== null && typeof event.issue_identifier !== "string")) throw new Error("invalid identity");
    fields.push(["issue_id", event.issue_id], ["issue_identifier", event.issue_identifier]);
  } else if (event.scope !== "service") throw new Error("invalid scope");
  if (event.scope === "session") {
    if (typeof event.session_id !== "string" || !event.session_id) throw new Error("missing session");
    fields.push(["session_id", event.session_id]);
  }
  for (const key of CONTEXT) if (event[key] !== undefined) fields.push([key, event[key]]);
  for (const key of TEXT) if (event[key] !== undefined) fields.push([key, event[key]]);
  return fields.map(([key, input]) => {
    const value = primitive(input);
    if (NUMBERS.has(key) && value !== null && typeof value !== "number") throw new Error("invalid number");
    if (typeof value !== "string") return `${key}=${String(value)}`;
    const isText = (TEXT as readonly string[]).includes(key);
    // Identity is never silently truncated; fail closed with a payload-free diagnostic.
    if (!isText && value.length > CONTEXT_LIMIT) throw new Error("oversized context");
    const safe = isText && value.length > RAW_TEXT_LIMIT ? "diagnostic text omitted [truncated]" : redact(value, secrets);
    if (isText) return `${key}=${quote(safe, key === "stderr" ? 2048 : key === "message" ? 896 : 1024)}`;
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded) > (key === "reason" ? 128 : CONTEXT_LIMIT)) throw new Error("oversized escaped context");
    return `${key}=${encoded}`;
  }).join(" ");
}
export function renderStructuredLogEvent(event: StructuredLogEvent): string {
  return render(event, [], new Date().toISOString());
}
export function createStructuredLogger(options: StructuredLoggerOptions = {}): StructuredLogger {
  const owned = options.sinks === undefined ? createStderrLogSink() : undefined;
  const sinks = options.sinks ?? (owned ? [owned] : []);
  const secretSet = new Set<string>();
  let secrets: string[] = [];
  let closed = false;
  const registerSecrets = (values: readonly string[]): void => {
    for (const value of values) {
      if (!value) continue;
      secretSet.add(value);
      secretSet.add(JSON.stringify(value).slice(1, -1));
      try { secretSet.add(encodeURIComponent(value)); } catch { /* raw/JSON forms still registered for lone surrogates */ }
    }
    secrets = [...secretSet].sort((a, b) => b.length - a.length);
  };
  registerSecrets(options.secrets ?? []);
  const warning = (kind: "logging_format_failed" | "logging_sink_failed"): string =>
    `severity="warn" event="${kind}" outcome="failed" reason="${kind}" issue_id=null issue_identifier=null session_id=null`;
  return {
    registerSecrets,
    emit(event) {
      if (closed) return;
      let line: string;
      try { line = render(event, secrets, (options.now?.() ?? new Date()).toISOString()); }
      catch { line = warning("logging_format_failed"); }
      const remaining: LogSink[] = [];
      let failed = false;
      for (const sink of sinks) {
        try { sink.write(line); remaining.push(sink); }
        catch { failed = true; }
      }
      if (failed) for (const sink of remaining) {
        try { sink.write(warning("logging_sink_failed")); } catch { /* never recurse */ }
      }
    },
    close() { closed = true; secretSet.clear(); secrets = []; owned?.close(); },
  };
}
