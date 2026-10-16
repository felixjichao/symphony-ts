import { afterEach, beforeEach } from "vitest";

const DECISION_ENV_KEYS = [
  "DECISION_BRIDGE_URL",
  "DECISION_BRIDGE_TOKEN",
  "DECISION_STORE_DIR",
  "SYMPHONY_PLANNING_ENABLED",
] as const;

// Strip external inherited Decision environment before tests run
for (const key of DECISION_ENV_KEYS) {
  delete process.env[key];
}

beforeEach(() => {
  for (const key of DECISION_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of DECISION_ENV_KEYS) {
    delete process.env[key];
  }
});
