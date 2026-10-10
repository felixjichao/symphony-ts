/**
 * Deterministic JSON serialization and deep equality comparison where key order does not matter.
 * Conforms to @symphony/decision canonical JSON semantics for browser environments.
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
