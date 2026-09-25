/**
 * @symphony/plugins — 控制器模块注册表与占位插件。
 *
 * 对齐上游 controller-module 插件集：mdns 发现 / a2a-inbound / workspace /
 * registry / external-runner。M0 提供注册分发骨架 + 各模块占位；
 * M4 起逐个落地最小可用实现。
 */
import type { Message } from "@symphony/sym";
import type { Address } from "@symphony/transport";

export interface PluginInput {
  msg: Message;
  from: Address;
}

export interface Plugin {
  readonly name: string;
  /** 处理一条消息；返回 true 表示已消费（不再继续分发）。 */
  handle(input: PluginInput): boolean;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`插件已注册: ${plugin.name}`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  list(): string[] {
    return [...this.plugins.keys()];
  }

  /** 依次询问插件；第一个消费的插件短路返回。 */
  dispatch(input: PluginInput): boolean {
    for (const plugin of this.plugins.values()) {
      if (plugin.handle(input)) return true;
    }
    return false;
  }

  /** 定向分发到指定插件（如核心路由插件）。 */
  dispatchTo(name: string, input: PluginInput): boolean {
    const plugin = this.plugins.get(name);
    return plugin?.handle(input) ?? false;
  }
}

/** 占位插件工厂：M4 前各模块仅登记名字。 */
export function makePlaceholderPlugin(name: string): Plugin {
  return { name, handle: () => false };
}

/**
 * 各控制模块占位。M4 里程碑映射：
 * mdns — 局域网 mDNS 发现网关与 Agent；
 * a2a-inbound — HTTP(S) 实现 A2A 入站，外部请求转内部 Message；
 * workspace — 数据/脚本存取与受控执行（进程 runner）；
 * registry — Agent 目录 + 健康检查；
 * external-runner — 预留外部执行器（如 CI）回传结果。
 */
export const mdnsPlugin = makePlaceholderPlugin("mdns");
export const a2aInboundPlugin = makePlaceholderPlugin("a2a-inbound");
export const workspacePlugin = makePlaceholderPlugin("workspace");
export const registryPlugin = makePlaceholderPlugin("registry");
export const externalRunnerPlugin = makePlaceholderPlugin("external-runner");

/** 默认装载全部占位模块。 */
export function createDefaultRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of [mdnsPlugin, a2aInboundPlugin, workspacePlugin, registryPlugin, externalRunnerPlugin]) {
    registry.register(plugin);
  }
  return registry;
}