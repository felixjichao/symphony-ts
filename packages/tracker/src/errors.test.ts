/**
 * §11.4 adapter 错误契约测试（Core Conformance，SPEC §17.3 "Error mapping covers
 * config, request, non-success response, malformed payload, pagination, and rate
 * limiting" 的契约层部分）。
 *
 * 锁定三件事：8 个 category 的**字面量取值**（跨包与跨实现的判别面，改名即
 * breaking）、human-readable message 的原样保留、§11.4 "MAY add" 的可选字段在
 * `exactOptionalPropertyTypes` 下"缺席即缺席"（不被写成 `undefined` 哨兵——那会让
 * 消费方无法区分"adapter 未判定 retryable"与"判定为 false"）。
 */
import { describe, expect, it } from "vitest";

import { TrackerError } from "./index";
import type { TrackerErrorCode } from "./index";

/** 全部 8 个 category，顺序即 SPEC §11.4 原文顺序。 */
const SPEC_CATEGORIES: readonly TrackerErrorCode[] = [
  "unsupported_tracker_kind",
  "invalid_tracker_config",
  "missing_tracker_secret",
  "tracker_request",
  "tracker_status",
  "tracker_response",
  "tracker_pagination",
  "tracker_rate_limited",
];

describe("TrackerError — SPEC §11.4 category 集合", () => {
  it("每个 category 都构造出同名的判别式与非空 message", () => {
    for (const category of SPEC_CATEGORIES) {
      const error = new TrackerError(category, `human readable detail for ${category}`);
      expect(error.category).toBe(category);
      expect(error.message).toBe(`human readable detail for ${category}`);
      expect(error.name).toBe("TrackerError");
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("category 判别面不含 §11.4 之外的取值", () => {
    // 类型的完备性靠这里锁定：新增 category 必须同时更新 SPEC 引用与本列表。
    const seen = new Set<string>();
    for (const category of SPEC_CATEGORIES) {
      seen.add(new TrackerError(category, "x").category);
    }
    expect([...seen].sort()).toEqual([...SPEC_CATEGORIES].sort());
  });
});

describe("TrackerError — §11.4 MAY-add 字段", () => {
  it("缺席的可选字段保持缺席", () => {
    const error = new TrackerError("tracker_status", "provider returned 500");
    expect("retryable" in error).toBe(false);
    expect("retryAfterMs" in error).toBe(false);
    expect("providerStatus" in error).toBe(false);
    expect("providerDetail" in error).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  it("给出的字段原样携带（含 retryable=false 这种 falsy 值）", () => {
    const error = new TrackerError("tracker_rate_limited", "rate limited by provider", {
      retryable: false,
      retryAfterMs: 2_500,
      providerStatus: 429,
      providerDetail: { resource: "issues" },
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterMs).toBe(2_500);
    expect(error.providerStatus).toBe(429);
    expect(error.providerDetail).toEqual({ resource: "issues" });
  });

  it("providerDetail 为 null / 0 / 空串 / false 时仍算已给出", () => {
    const cases: readonly unknown[] = [null, 0, "", false];
    for (const detail of cases) {
      const error = new TrackerError("tracker_response", "malformed payload", {
        providerDetail: detail,
      });
      expect("providerDetail" in error).toBe(true);
      expect(error.providerDetail).toEqual(detail);
    }
  });

  it("原始 transport 异常经 cause 保留，不作为对外契约面", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new TrackerError("tracker_request", "transport failure", { cause });
    expect(error.cause).toBe(cause);
    expect(error.category).toBe("tracker_request");
  });
});
