import crypto from "node:crypto";

/**
 * Deterministic JSON serialization and deep equality comparison where key order does not matter.
 */

export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonStringify(item));
    return `[${items.join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => {
    const serializedKey = JSON.stringify(key);
    const serializedValue = canonicalJsonStringify(obj[key]);
    return `${serializedKey}:${serializedValue}`;
  });

  return `{${pairs.join(",")}}`;
}

export function canonicalJsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJsonStringify(a) === canonicalJsonStringify(b);
}

export function computeRequirementFingerprint(
  title: string,
  body: string,
  clarifications: readonly string[] = []
): string {
  const normalizedTitle = title.trim();
  const normalizedBody = body.trim();
  const normalizedClarifications = clarifications
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const payload = {
    title: normalizedTitle,
    body: normalizedBody,
    clarifications: normalizedClarifications,
  };
  // SHA-256 hex digest
  const hash = crypto.createHash("sha256");
  hash.update(canonicalJsonStringify(payload), "utf8");
  return hash.digest("hex");
}
