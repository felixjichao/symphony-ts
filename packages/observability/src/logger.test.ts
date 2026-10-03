import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createStructuredLogger, createStderrLogSink, renderStructuredLogEvent, type StructuredLogEvent } from "./logger";
const event: StructuredLogEvent = { scope: "session", severity: "info", event: "session_started", outcome: "started", issue_id: "1", issue_identifier: "GH-1", session_id: "thread-turn" };
describe("structured logger §17.6", () => {
  it("renders fixed key order and REQUIRED context independently of input insertion order", () => {
    const line = renderStructuredLogEvent({ ...event, timestamp: "2026-10-03T00:00:00Z", message: 'a\nb="x"' });
    expect(line).toBe('timestamp="2026-10-03T00:00:00Z" severity="info" event="session_started" outcome="started" issue_id="1" issue_identifier="GH-1" session_id="thread-turn" message="a\\nb=\\"x\\""');
    expect(renderStructuredLogEvent({ scope: "issue", severity: "info", event: "retry_scheduled", outcome: "retrying", issue_id: "1", issue_identifier: null })).toContain('issue_identifier=null');
  });
  it("redacts every allowed string, URL/JSON encodings and retained rotated secrets before truncation", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ secrets: ['secret"\n值'], sinks: [{ write: (s) => lines.push(s) }] });
    logger.registerSecrets(["new-token"]);
    logger.emit({ ...event, issue_url: encodeURIComponent('secret"\n值'), reason: "new-token", message: 'x'.repeat(980) + 'secret"\n值', error: JSON.stringify('secret"\n值'), stderr: 'secret"\n值 new-token' });
    expect(lines[0]).not.toContain("new-token");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).toContain("[REDACTED]");
    expect(lines[0]).not.toContain("\n");
  });
  it("bounds escaped UTF-8 text and never truncates away REQUIRED fields", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (s) => lines.push(s) }] });
    logger.emit({ ...event, message: '\n😀'.repeat(2000), error: '\n'.repeat(5000), stderr: '值'.repeat(2000) });
    for (const [key, max] of [["message", 1024], ["error", 1024], ["stderr", 2048]] as const) {
      const encoded = lines[0]!.match(new RegExp(`${key}=("(?:[^"\\\\]|\\\\.)*")`))![1]!;
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(max);
      expect(JSON.parse(encoded)).toContain("[truncated]");
    }
    expect(lines[0]).toContain('session_id="thread-turn"');
    logger.emit({ ...event, stderr: "payload".repeat(100000) });
    expect(lines[1]).toContain("diagnostic text omitted");
  });
  it("never touches unknown properties, Error causes or raw payload serializers", () => {
    const lines: string[] = [];
    const poison = { ...event, get raw() { throw new Error("SECRET"); }, toJSON() { throw new Error("SECRET"); } };
    createStructuredLogger({ sinks: [{ write: (s) => lines.push(s) }] }).emit(poison);
    expect(lines[0]).toContain("session_started");
    expect(lines[0]).not.toContain("SECRET");
  });
  it("isolates getter/serialization/clock failures and individual sinks without recursive diagnostics", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ sinks: [{ write() { throw new Error("SECRET"); } }, { write: (s) => lines.push(s) }] });
    logger.emit({ ...event, get message(): string { throw new Error("SECRET"); } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("logging_format_failed");
    expect(lines[1]).toContain("logging_sink_failed");
    expect(lines.join()).not.toContain("SECRET");
    const circular: { self?: unknown } = {}; circular.self = circular;
    logger.emit({ ...event, error: circular as unknown as string });
    logger.emit({ ...event, error: 1n as unknown as string });
    logger.emit({ ...event, issue_id: "x".repeat(5000) });
    expect(lines.slice(2).every((s) => s.includes("logging_"))).toBe(true);
    createStructuredLogger({ now() { throw new Error("SECRET"); }, sinks: [{ write: (s) => lines.push(s) }] }).emit(event);
    expect(lines.at(-1)).toContain("logging_format_failed");
  });
  it("bounds default sink buffering under backpressure until drain", async () => {
    const stream = new PassThrough({ highWaterMark: 1 });
    const sink = createStderrLogSink(stream as unknown as NodeJS.WriteStream);
    sink.write("first"); sink.write("dropped");
    expect(stream.read().toString()).toBe("first\n");
    await new Promise((resolve) => setImmediate(resolve));
    sink.write("after drain"); expect(stream.read().toString()).toBe("after drain\n");
    sink.close();
  });
  it("owns asynchronous stderr stream errors and stops output after close", () => {
    const stream = new PassThrough();
    const sink = createStderrLogSink(stream as unknown as NodeJS.WriteStream);
    sink.write("line");
    expect(stream.read().toString()).toBe("line\n");
    expect(() => stream.emit("error", new Error("EPIPE"))).not.toThrow();
    sink.close();
    const lines: string[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (s) => lines.push(s) }] });
    logger.close(); logger.emit(event); expect(lines).toEqual([]);
  });
});
