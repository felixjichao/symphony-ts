# Agent Note: Workspace Path Safety Contract
Status: accepted

## Problem

SPEC §9.5 是官方标注的"最重要可移植性约束"：Invariant 2 要求 workspace path 恒在 workspace root 之内。M3.1 只落地了同步 lexical 层（`path.resolve` + 带 `path.sep` 的前缀判定），M3.1 代码审查明确记录了缺口：字符串前缀判定无法防御 symlink——workspace 目录或其任一 ancestor 被替换成指向 root 外的 symlink 后，字符串路径依然"看起来在 root 内"，而 M4 将要以该路径为 subprocess cwd 执行 shell/agent，#29 / M5 将要对该路径执行 destructive delete。

#28 要求在 M3.1 内核上叠加 filesystem safety boundary，并提供可被 M4 / M5 直接复用的校验入口，错误面须区分 workspace_equals_root / workspace_outside_root / workspace_symlink_escape / workspace_path_unreadable 四类，且不得以裸 `startsWith(root)` 作为唯一 containment 判断。这是跨包契约（M4 launch 前、#29 / M5 cleanup 前必须重验），按 Working Rule 5 记录。

## Decision

1. **双层 containment**：同步 lexical 层保持 M3.1 契约不变（`resolveWorkspacePath*` 继续同步拒绝）；新增 async canonical 层——`WorkspaceManager.validateWorkspacePath(path)` 返回 discriminated 结果（不抛安全拒绝），`WorkspaceManager.assertWorkspacePathSafe(path, options?)` 为 throwing 形态。安全不变量为 `absolute && !== root && lexicalContained && canonicalContained`。
2. **canonical root 权威、每次实时解析、不缓存**：每次校验执行 `fs.realpath(root)`。root 自身含 symlink 时以 canonical root 判定 containment；root 被替换（含换成 symlink）后下一次校验立即生效。
3. **尚不存在路径不跳过校验**：向上找最近已存在 ancestor，realpath 该 ancestor 后 join 剩余 segment 得到 predicted canonical path，要求其严格落在 canonical root 之下；root 自身尚不存在时按同一规则推定 projected canonical root（保持 M3.1"递归创建 root"语义可用）。
4. **dangling symlink fail-closed（对称语义）**：目标不存在的 symlink 无法 canonicalize，按 `workspace_path_unreadable` 拒绝，不自行解析多级 symlink 链预测落点；无论 dangling 出现在目标级还是上溯途中的已存在 ancestor（realpath ENOENT 后经 lstat 判别），一律 fail-closed，不得被当作「不存在」让 predicted 落点越过它投影。校验全程不逃逸非类型化异常：投影走查中的极端 I/O 故障（EIO / ESTALE 等）同样收敛为 typed 结果（`validateWorkspacePath` 不抛、`assertWorkspacePathSafe` 只抛 `WorkspaceError`）。
5. **错误面**：顶层 `WorkspaceErrorCode` 集合保持 M3.1 已发布契约不变；`unsafe_path` 新增 `unsafeReason` 子判别字段（`UnsafePathReason` 四类），canonical root 边界经 `canonicalRoot` 字段透出，原始 fs 异常经 `cause` 保留。root 自身为非目录对象 / dangling symlink 时映射回既有 `invalid_root_path`。
6. **接线点**：`createWorkspace` 在 lstat 探测之后、复用返回与 mkdir 之前执行 `assertWorkspacePathSafe`——复用与新建两条路径都必须过 safety gate；探测先行是为保持 M3.1 root-is-file → `invalid_root_path`（含 `cause`）的错误面与优先级不变。逃逸 symlink 的拒绝优先级为 `unsafe_path`（比对象类型分类 `existing_non_directory` 更根本）；root 内 symlink 仍按 M3.1 语义 `existing_non_directory`。
7. **消费方契约**：M4 agent launch 前（以 workspace path 为 cwd 前）与 #29 / M5 任何 destructive cleanup 前必须重新调用 `assertWorkspacePathSafe`（TOCTOU 重验入口）。§17.2 "Agent launch uses the per-issue workspace path as cwd and rejects out-of-root paths" 仍属 planned M4，本 Note 不宣告其实现。

## Alternatives considered

1. **四类拒绝面提升为顶层 `WorkspaceErrorCode`**：判别更直白，但会改变 M3.1 已合入 main 的公共错误码集合并要求同步改写既有测试 / README / conformance 表述；`code === "unsafe_path"` + `unsafeReason` 子字段同样可机器判别，且不破坏已发布契约。否掉。
2. **缓存 canonical root（构造时 realpath 一次）**：省每次校验 1–2 个 syscall，但 root 在运行期被替换成 symlink 后缓存失效、containment 判定停留在旧世界；校验频率是每 issue 级别，实时 realpath 的开销可忽略。否掉。
3. **裸 `startsWith(root)` 判定 containment**：`/root2` 一类前缀混淆直接穿透。采用带 `path.sep` 的 segment 级前缀判定 + canonical 层双保险，并有专门测试用例锁定。否掉。
4. **同步 API（`realpathSync`）**：调用方（M4 launch、#29 cleanup）都在长运行 orchestrator 的事件循环里，同步 fs IO 阻塞整个进程；async 与 `createWorkspace` 既有入口形态一致。否掉。
5. **dangling symlink 解析 readlink 链预测落点**：需要自行实现多级 symlink 链解析与环检测（Node 只在 realpath 提供），复杂度高且扩大 TOCTOU 面；无法确认落点时 fail-closed 更符合本包 Fail Safely 先例（M3.1 non-directory policy）。否掉。
6. **O_NOFOLLOW / openat 级原子校验消除 TOCTOU**：可根除 validate 与 delete/launch 之间的理论窗口，但超出 #28 范围（issue 口径为"提供破坏性动作前重验 primitive，TOCTOU 只能收窄"），且需要 native binding 或 `fs.opendir` 句柄传递重构。留作 M7 安全加固（SPEC §15）候选，本次不做。否掉（延后）。

## Consequences

- **正面**：M4 / #29 / M5 拿到单一、可复用、无 orchestrator 依赖的 execution-boundary primitive；symlink escape / root equality / 前缀混淆 / 尚不存在路径四类绕过全部有真实文件系统测试锁定（mutation 自检：短路 canonical 判定即 6 个用例变红）；`unsafeReason` 让下游能按拒绝原因分流（如 cleanup 遇 escape 只告警不删）。
- **负面与承诺**：每次校验 2–5 个 syscall（realpath + lstat 走查），在每 issue 一次的频率下可接受；validate 与后续动作之间的 TOCTOU 窗口固有存在，消费方**必须**在破坏性动作前重验（契约写入 README 与 assert 的 doc comment）；symlink 测试依赖 host 能力，不支持的平台显式 skip（不静默 pass），root 运行时 chmod 000 用例同样显式 skip、其错误面由 ELOOP / ENOTDIR 用例覆盖；后续不得在任何消费方绕过 `assertWorkspacePathSafe` 自行实现字符串 containment 判定。
