import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubDecisionRoot,
  decisionSessionId,
  type DecisionReviewResult,
  type DecisionReviewTarget,
} from "@symphony/domain";
import { DecisionBridge } from "./bridge";
import { DecisionBridgeClient } from "./client";

describe("DecisionBridge HTTP server", () => {
  it("serves REST endpoints with authentication, trust boundaries, and client compatibility", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    const token = "secret-token-123";

    const bridge = new DecisionBridge({
      storeDir: tmpDir,
      port: 0,
      host: "127.0.0.1",
      authToken: token,
      allowedOrigins: ["http://localhost:3000"],
    });

    try {
      const { port } = await bridge.start();
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Unauthenticated request receives 401
      const unauthRes = await fetch(`${baseUrl}/v1/tasks/next`, {
        headers: { Accept: "application/json" },
      });
      expect(unauthRes.status).toBe(401);

      // 2. Host header rebinding protection
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        void import("node:http").then((http) => {
          const r = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/v1/tasks/next",
              method: "GET",
              headers: {
                Host: "attacker.com",
                Authorization: `Bearer ${token}`,
              },
            },
            (res) => {
              resolve(res.statusCode ?? 0);
            }
          );
          r.on("error", reject);
          r.end();
        });
      });
      expect(rebindingStatus).toBe(400);

      // 3. Client with valid token
      const client = new DecisionBridgeClient(baseUrl, { authToken: token });

      // Initially next task is 204
      const initialNext = await client.getNextTask();
      expect(initialNext).toBeNull();

      // Create session
      const root = githubDecisionRoot("felixjichao", "symphony-ts", 95);
      const sessionRes = await client.createSession(root);
      expect(sessionRes.session.id).toBe(decisionSessionId(root));

      // Put binding
      const bindingRes = await client.putBinding(sessionRes.session.id, {
        adapter: "browser-agent",
        externalSessionRef: "chat-001",
        resumeUri: null,
      });
      expect(bindingRes.session.binding?.generation).toBe(1);

      // Create review task
      const target: DecisionReviewTarget = {
        repository: "felixjichao/symphony-ts",
        prNumber: 95,
        headSha: "f".repeat(40),
      };
      const taskRes = await client.createTask({
        sessionId: sessionRes.session.id,
        kind: "review",
        target,
        operationKey: "op-create-1",
      });
      expect(taskRes.task.status).toBe("pending");

      // Now next task returns this task
      const nextRes = await client.getNextTask();
      expect(nextRes).not.toBeNull();
      expect(nextRes?.task.id).toBe(taskRes.task.id);

      // Claim task
      const claimRes = await client.claimTask(taskRes.task.id, {
        owner: "executor-agent",
        ttlMs: 60_000,
      });
      expect(claimRes.task.status).toBe("claimed");
      expect(claimRes.lease.generation).toBe(1);

      // Start task
      const startRes = await client.startTask(taskRes.task.id, {
        owner: "executor-agent",
        token: claimRes.lease.token,
        generation: claimRes.lease.generation,
      });
      expect(startRes.task.status).toBe("running");

      // Heartbeat
      const hbRes = await client.heartbeatTask(taskRes.task.id, {
        owner: "executor-agent",
        token: claimRes.lease.token,
        generation: claimRes.lease.generation,
        ttlMs: 90_000,
      });
      expect(hbRes.expiresAtMs).toBeGreaterThan(Date.now());

      // Submit result
      const reviewResult: DecisionReviewResult = {
        schemaVersion: 1,
        kind: "review",
        taskId: taskRes.task.id,
        sessionId: sessionRes.session.id,
        revision: 1,
        target,
        verdict: "approve",
        findings: [],
        createdAtMs: Date.now(),
      };

      const submitRes = await client.submitResult(taskRes.task.id, {
        owner: "executor-agent",
        token: claimRes.lease.token,
        generation: claimRes.lease.generation,
        result: reviewResult,
      });
      expect(submitRes.receipt.type).toBe("result");
      expect(submitRes.result.verdict).toBe("approve");
      expect(submitRes.superseded).toBe(false);

      // Rebind session
      const rebindRes = await client.rebindSession(sessionRes.session.id, {
        adapter: "browser-agent-v2",
        externalSessionRef: "chat-002",
        resumeUri: null,
        expectedGeneration: 1,
      });
      expect(rebindRes.session.bindingGeneration).toBe(2);

      // Test payload too large (> 1MB)
      const oversizedPayload = "x".repeat(1.5 * 1024 * 1024);
      const largeRes = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: oversizedPayload }),
      });
      expect(largeRes.status).toBe(413);
    } finally {
      await bridge.stop();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
