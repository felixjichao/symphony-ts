/**
 * @symphony/ctl — 控制平面 CLI（symctl）骨架。
 *
 * 对齐 `symphony ctl --gateway <addr>`：自身是一个普通 Agent 客户端，
 * 直连网关后提供 list / send / spawn / inspect 等子命令（M5 落地交互）。
 * M0 先固化参数解析与命令表。
 */
import { TRANSPORT_VERSION } from "@symphony/sym";

export const SYMCTL_USAGE = `symctl <host:port:symphony> <command> [args...]

commands:
  list               列出连接的 Agent（M5）
  send <dst> <text>  发一条消息（M5）
  spawn <name>       启动一个 Agent（M5）
  inspect <id>       查看链路（M5）
`;

export type SymctlArgs = {
  gateway: string;
  command: string;
  rest: string[];
};

export function parseArgs(argv: readonly string[]): SymctlArgs | null {
  if (argv.length === 0) return null;
  const [gateway, command, ...rest] = argv;
  if (gateway === undefined || command === undefined) return null;
  if (!gateway.endsWith(`:${TRANSPORT_VERSION}`) && !/:[0-9]+:(symphony)$/.test(gateway)) {
    return null;
  }
  return { gateway, command, rest };
}

export function main(argv: readonly string[]): string {
  const args = parseArgs(argv);
  if (!args) return SYMCTL_USAGE;
  return `symctl: 已连接 ${args.gateway}，命令 ${args.command}（M5 实现）`;
}