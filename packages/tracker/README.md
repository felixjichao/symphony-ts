# @symphony/tracker

## Purpose

SPEC **§11 Issue Tracker Integration Contract** 的 owner 包，对应 §3 的 Issue Tracker Adapter：定义 provider 无关的工单读取接口，处理认证，把 provider payload 归一化为 `@symphony/domain` 的 Issue 类型（保留 provider keys）。**新增 tracker provider 的唯一落点在本包。**

## Configuration

provider 的连接参数（endpoint、token 等）由 `@symphony/config` 产出的 typed config 提供；本包不自行读取环境变量或配置文件。

## Extension points

- 新 provider：实现本包的 adapter 接口，归一化结果类型复用 `@symphony/domain`，不在 adapter 内另造 Issue 模型；
- provider payload 的字段映射差异在 adapter 层吸收，对 orchestrator 暴露统一的读取语义。

## Known limitations

- M0.6 仅建立边界，`src/index.ts` 暂无公共 API；
- 首个 provider 与归一化测试随后续里程碑落地（SPEC §11、§17）；
- 边界约束：**永不 import `@symphony/orchestrator`**——调度 / claim / retry 属于 coordination 层。
