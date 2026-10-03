import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEffectiveWorkflow, SymphonyConfigError, type EffectiveWorkflow } from "@symphony/config";
import { createStructuredLogger } from "@symphony/observability";
import { TrackerAdapterRegistry, TrackerError, type TrackerAdapterProfile } from "@symphony/tracker";
import type { EffectiveSchedulingConfig, OrchestratorAuthority } from "@symphony/orchestrator";
import { EffectiveRuntimeController } from "./effective-runtime";
import { createRuntimeLogObservers } from "./logging";

function makeProfile(kind: string, options: { failCreate?: boolean; secretEnv?: string[] } = {}): TrackerAdapterProfile {
  return {
    kind,
    documentation: `docs/testing.md#${kind}`,
    secretProviderKeys: ["token"],
    secretEnvVars: options.secretEnv ?? [`${kind.toUpperCase()}_TOKEN`],
    defaultActiveStates: ["open"],
    defaultTerminalStates: ["closed"],
    createAdapter: () => {
      if (options.failCreate) {
        throw new TrackerError("invalid_tracker_config", "simulated adapter factory failure");
      }
      return {
        kind,
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => [],
      };
    },
  };
}

let tempDir: string;
let workflowFilePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "symphony-effective-test-"));
  workflowFilePath = join(tempDir, "WORKFLOW.md");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function mockWorkflow(overrides: { command?: string; intervalMs?: number; trackerKind?: string } = {}): EffectiveWorkflow {
  const yaml = `---
tracker:
  kind: ${overrides.trackerKind ?? "p1"}
polling:
  interval_ms: ${overrides.intervalMs ?? 1000}
workspace:
  root: /tmp/symphony_test_workspaces
codex:
  command: ${overrides.command !== undefined ? JSON.stringify(overrides.command) : '"codex app-server"'}
---
prompt text
`;

  writeFileSync(workflowFilePath, yaml, "utf8");
  return loadEffectiveWorkflow({
    path: workflowFilePath,
  });
}

describe("EffectiveRuntimeController unit tests (M6.4)", () => {
  it("throws if current is accessed before initialization", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const registry = new TrackerAdapterRegistry([makeProfile("p1")]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    expect(() => controller.current).toThrow("EffectiveRuntimeController has not been initialized");
  });

  it("atomically initializes EffectiveRuntime with all 7 invariant components", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const p1 = makeProfile("p1", { secretEnv: ["SECRET_ALPHA", "SECRET_BETA"] });
    const registry = new TrackerAdapterRegistry([p1]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    const wf = mockWorkflow({ intervalMs: 2500, trackerKind: "p1" });
    controller.accept(wf);

    const runtime = controller.current;
    expect(runtime.effectiveWorkflow).toBe(wf);
    expect(runtime.serviceConfig).toBe(wf.serviceConfig);
    expect(runtime.profile).toBe(p1);
    expect(runtime.adapter.kind).toBe("p1");
    expect(runtime.excludeEnvNames).toEqual(["SECRET_ALPHA", "SECRET_BETA"]);
    expect(runtime.workspaceManager).toBeDefined();
    expect(runtime.scheduling.pollIntervalMs).toBe(2500);
    expect(runtime.scheduling.policy.activeStates).toEqual(["open"]);
  });

  it("rejects empty codex.command and retains previous runtime without partial update", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const p1 = makeProfile("p1");
    const registry = new TrackerAdapterRegistry([p1]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    const good = mockWorkflow({ command: "node server.mjs", intervalMs: 3000 });
    controller.accept(good);
    const firstRuntime = controller.current;

    const bad = mockWorkflow({ command: "   ", intervalMs: 1000 });
    expect(() => controller.accept(bad)).toThrowError(SymphonyConfigError);

    // Old runtime is 100% retained
    expect(controller.current).toBe(firstRuntime);
    expect(controller.current.scheduling.pollIntervalMs).toBe(3000);
  });

  it("rejects adapter construction failure (AC #8) without partial publish", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const pGood = makeProfile("p_good");
    const pBad = makeProfile("p_bad", { failCreate: true });
    const registry = new TrackerAdapterRegistry([pGood, pBad]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    const good = mockWorkflow({ trackerKind: "p_good", intervalMs: 4000 });
    controller.accept(good);
    const firstRuntime = controller.current;

    const bad = mockWorkflow({ trackerKind: "p_bad", intervalMs: 2000 });
    expect(() => controller.accept(bad)).toThrowError(SymphonyConfigError);

    expect(controller.current).toBe(firstRuntime);
    expect(controller.current.adapter.kind).toBe("p_good");
    expect(controller.current.scheduling.pollIntervalMs).toBe(4000);
  });

  it("applies scheduling config to authority upon commit", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const registry = new TrackerAdapterRegistry([makeProfile("p1")]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    const appliedConfigs: EffectiveSchedulingConfig[] = [];
    const mockAuthority = {
      applyEffectiveSchedulingConfig(config: EffectiveSchedulingConfig) {
        appliedConfigs.push(config);
      },
    } as unknown as OrchestratorAuthority;

    controller.setAuthority(mockAuthority);

    const wf1 = mockWorkflow({ intervalMs: 1200 });
    controller.accept(wf1);

    expect(appliedConfigs).toHaveLength(1);
    expect(appliedConfigs[0]?.pollIntervalMs).toBe(1200);

    const wf2 = mockWorkflow({ intervalMs: 5000 });
    controller.accept(wf2);

    expect(appliedConfigs).toHaveLength(2);
    expect(appliedConfigs[1]?.pollIntervalMs).toBe(5000);
  });

  it("provides store proxy matching WorkflowEffectiveStore contract", () => {
    const logger = createStructuredLogger({ sinks: [] });
    const observers = createRuntimeLogObservers(logger);
    const registry = new TrackerAdapterRegistry([makeProfile("p1")]);

    const controller = new EffectiveRuntimeController({
      workflowPath: "/test/WORKFLOW.md",
      registry,
      logger,
      observers,
    });

    const wf1 = mockWorkflow({ intervalMs: 1000 });
    controller.store.accept(wf1);

    expect(controller.store.current()).toBe(wf1);
    expect(controller.current.effectiveWorkflow).toBe(wf1);

    const wf2 = mockWorkflow({ intervalMs: 2000 });
    controller.store.accept(wf2);

    expect(controller.store.current()).toBe(wf2);
    expect(controller.current.effectiveWorkflow).toBe(wf2);
  });
});
