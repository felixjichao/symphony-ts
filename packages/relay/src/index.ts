/**
 * @symphony/relay — 网关前端的 L4/UDP 负载均衡（骨架）。
 *
 * 上游 relay 为网关群提供一个稳定入口：UDP 数据报按规则转发到某台网关；
 * 网关无需固定 DNS。M6 实现多网关集群时落地转发逻辑。
 */
import type { Address } from "@symphony/transport";

/** 转发规则：把一个服务段映射到一组后台网关。 */
export interface RelayRule {
  /** 如 `symphony`。 */
  service: string;
  /** 后台网关地址（不含服务名）。 */
  backends: Array<Pick<Address, "host" | "port">>;
}

/** 朴素轮询选择器（M6 起使用；实现便于单测）。 */
export function pickBackend(rule: RelayRule, counter: number): Pick<Address, "host" | "port"> {
  if (rule.backends.length === 0) {
    throw new Error(`relay: 服务 ${rule.service} 没有可用后端`);
  }
  return rule.backends[counter % rule.backends.length]!;
}

export class Relay {
  constructor(readonly rules: RelayRule[] = []) {}

  findRule(service: string): RelayRule | undefined {
    return this.rules.find((r) => r.service === service);
  }
}