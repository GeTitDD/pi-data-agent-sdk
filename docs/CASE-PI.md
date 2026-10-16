# 案例：用信任阶梯法解剖 Pi Agent

> 目的：用一套**外部系统**检验方法论是否可用、是否可预测。
> Pi 是理想样本——它是我们的**宿主**，同时它自身就是一个完整的 A0–A4 系统。
> 结论：**方法论可用，且有四条可证伪的预测全部命中。** 并因此产出一条**新推论**（第 8 节）。

---

## 1. 五层映射

| 层 | Pi 的对应物 | 位置（`@earendil-works/pi-coding-agent/dist`）|
|---|---|---|
| **A0** 语汇 | 消息 / 工具结果 / 用法等纯类型 | `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core` |
| **A1** 能力 | **8 个工具定义 + 8 个 `*Operations` 端口 + 4 个外部适配器** | `core/tools/*`、`core/bash-executor`、`core/model-runtime`、`core/auth-storage`、`core/trust-manager` |
| **A2** 变换 | 压缩、系统提示构建、扩展运行时 | `core/compaction/*`、`core/system-prompt`、`core/extensions/runner` |
| **A3** 流程 | 会话、会话运行时、会话管理 | `core/agent-session`、`core/agent-session-runtime`、`core/session-manager` |
| **A4** 宿主 | 交互/RPC/JSON/print 模式、CLI、SDK、设置 | `modes/*`、`cli`、`sdk`、`settings-manager` |
| **A5** 度量 | **包内缺失** | — |

---

## 2. MUTU 在哪里：**工具执行边界**（不是模型，也不是提示词）

按方法论的定位法——找「**不可信输入 → 受控副作用**」那条路径：

```
模型输出（不可信）→ tool_call → 参数校验 → *Operations 执行 → 真实副作用（文件/进程/DB）
                                  └─────────── ★ MUTU 在这里 ───────────┘
```

**不是**模型层（那里没有副作用），**不是**提示词层（那里不强制任何东西）。
Pi 把这条路径做成了标准 A1 形状（见下节），这正是方法论预测的形态。

---

## 3. A1 形状验证：定义与执行分离

方法论说 A1 永远是「**一个受控的对外通道 + 一组不可绕过的保证**」。Pi 完全吻合——**schema 与执行被拆成两半**：

| 工具 | 定义（含 TypeBox schema）| 执行端口 | 本地实现 |
|---|---|---|---|
| read | `createReadToolDefinition` | `ReadOperations` | `createLocalReadOperations` |
| bash | `createBashToolDefinition` | `BashOperations` | `createLocalBashOperations` |
| edit | `createEditToolDefinition` | `EditOperations` | — |
| write | `createWriteToolDefinition` | `WriteOperations` | — |
| grep | `createGrepToolDefinition` | `GrepOperations` | — |
| find | `createFindToolDefinition` | `FindOperations` | — |
| ls | `createLsToolDefinition` | `LsOperations` | — |
| powershell | `createPowerShellToolDefinition` | `PowerShellOperations` | `createLocalPowerShellOperations` |

**核实结果**：8 个工具定义 ✅、8 个 `*Operations` 端口 ✅（`FileOperations` 属压缩模块，不计入）。

> 这意味着 **Pi 的每个内置工具都可替换**（远程沙箱、SSH、容器）。
> 这正是"有膜"的证据：没有 `*Operations` 端口，工具就是组织液。

---

## 4. 保证强度审计（按维度，不按整体）

**这是方法论最有价值的一步**：一个系统的保证强度**不是一个数字**，而是**分维度**的。

| 维度 | 强度 | 依据 |
|---|---|---|
| **正确性**（参数合法） | 🟢 | TypeBox schema 校验，模型传错直接被拒 |
| **协调性**（并发写同一文件） | 🟢 | `withFileMutationQueue(filePath, fn)` 同路径串行化 |
| **失败分类** | 🟢 | `ExecStatus`/`stopReason` 等显式枚举，不用异常类型表达业务失败 |
| **契约冻结** | 🟢 | 扩展 API 有成体系的类型 + 四个模式的行为差异被文档化 |
| **授权**（能不能做） | 🔴 **默认开放** | bash **无沙箱**；edit/write **可写任意路径**；无内置权限系统 |
| **隔离**（能不能碰到别人的东西） | 🔴 默认无 | 同上 |

**关键判断**：🔴 本身**不构成违规**——因为 Pi **如实声明**了它。方法论纪律要求的是"**不得把 🟡 当 🟢 用**"，而不是"必须全 🟢"。
Pi 的默认姿态是明示的：**信任模型 + 信任扩展作者**（其文档反复强调"扩展以你的用户权限运行，只安装可信来源"）。

> 对照反模式 ③（用约定代替强制）：Pi 在授权维度是"**明示的缺失**"，而不是"**假装的拥有**"。这是本质区别。

---

## 5. 两处值得表扬的设计

### 5.1 `BoundaryContextPreview` —— 唯一通道的**高级形态**

```ts
export interface BoundaryContextPreview {   // core/extensions/types.d.ts:779
  contextEntries: ProjectedSessionEntry[];
  contextMessages: AgentMessage[];
  llmMessages: Message[];
  pendingMessages: AgentMessage[];
  canContinue: boolean;
}
```

多数系统的"边界"是**黑箱**（你只能提交，不能看）。
Pi 在最终结算处（`agent_before_settle`）把**将要发给模型的东西**摊开给扩展：既能看到 `llmMessages`，也能看到 `pendingMessages`，还能用 `canContinue` 决定是否续跑。
👉 **这是"唯一通道"的进阶形态：可预览、可改写。** 值得作为 A2/A3 边界的设计目标。

### 5.2 系统提示做成**可差分结构**

```ts
buildSystemPromptSections(input): SystemPromptSections
diffSystemPromptSections(previous, current): Record<string, string | null> | undefined
```

系统提示被拆成独立命名的 section，并与上一轮 **diff**，只推送变化部分。
👉 收益：**缓存前缀稳定 → 省钱**。这是把"prompt 工程"当**数据结构**而非字符串拼接来做。我们的 M1 上下文注入应照此办理（`sections` 而非一大段字符串）。

---

## 6. 三处偏离（如实记录）

### 6.1 `core → modes` 的类型泄漏（呈现类型向上污染）
`Theme` 定义在 `modes/interactive/theme/theme.ts`（**A4**），却被 **A1/A2** 引用：

| 文件 | 层 |
|---|---|
| `core/extensions/types.d.ts` | A1（扩展契约）|
| `core/tools/render-utils.d.ts` | A1（工具渲染）|
| `core/resource-loader.d.ts` | A2 |
| `core/export-html/tool-renderer.d.ts` | A2 |
| `extensions/mcp/ui.d.ts` | A1 扩展 |
| `index.d.ts` | 公共 API（re-export，可接受）|

> **修正**：BTW 会话记录为"4 处"；实测为 **`core/` 内 4 处 + `extensions/mcp/ui.d.ts` 1 处 + `index.d.ts` 的 re-export**。
> 差异不影响结论，但记录应精确。

**性质**：全部是 `import type`，**不产生运行时耦合**，因此是"轻违规"。
**但它揭示了结构问题**：**"给人看"的东西被放进了下层**。

### 6.2 A5 度量缺失
包内无评测设施。→ 预测：使用者会自建（见第 9 节）。

### 6.3 授权默认开放
见第 4 节。→ 预测：生态会长出权限扩展（见第 9 节）。

---

## 7. 反向收益：Pi 也验证了我们的纪律

| 我们的纪律 | Pi 的对应证据 |
|---|---|
| 唯一通道 | `tool_call` / `tool_result` 拦截点 + `BoundaryContextPreview` |
| 契约冻结后才向上 | 扩展 API 高度稳定，且有 `MIGRATION_GUIDE` |
| 失败分类 | `stopReason` / `ExecStatus` 显式枚举 |
| 复杂度控制 | 内置工具只有 8 个，克制 |
| 旁路即最弱路径 | `--no-tools` / `--tools` 的过滤在**通道层**统一生效，不靠各工具自觉 |

---

## 8. ★ 由本案例产生的新推论（方法论升级）

### 推论：「呈现类型不得向上污染」

> **"给人看"的类型（主题 / 样式 / 布局 / 文案 / 颜色）属于最上层（A4），
> 必须留在那里，只能经端口向下暴露，不得让下层 import。**

**依据**：Pi 的 `Theme` 定义在 A4，却被 A1/A2 的 6 个文件引用。
**为什么原版方法论没覆盖**：原版只谈"依赖只向下 import 接口"，默认"下层定义、上层使用"。但呈现类型是**反方向**的需求（下层要输出颜色/文本给上层渲染），于是形成了一条**隐式的向上依赖**。

**判断标准**：如果一个类型的字段是给人看的（颜色、字号、间距、措辞），它就不该出现在 A2 及以下。

**修法（两种，均可行）**：
1. 下层只输出**语义**（如 `status: "denied"`、`severity: "warning"`），由 A4 决定颜色与文案；
2. 下层接受一个**注入的呈现端口**（如 `Renderer`），由 A4 提供实现。

> 我们的 SDK 里对应的是：**`answer` 里不该出现 ANSI 颜色或 Markdown 细节，`ExecStatus` 才是下层的语言。**
> （这也是为什么 M1 选择"渲染与判定分离"——答案渲染在 A4，A2 只产出 `ExecResult` + `evidence`。）

---

## 9. 分形/嵌套推论：**子系统的 MUTU 不能假设宿主的 MUTU 会保护它**

Pi 自身是一个 A0–A4 系统；我们的 Data Agent SDK 是**插进 Pi 的另一个 A0–A4 系统**。

于是出现一个嵌套结构：

```
Pi（宿主 A0–A4）
  └── 我们的 SDK（子系统 A0–A4）
        └── SQLite（外部世界）
```

Pi 的 A1 在**授权维度是 🔴**（bash 无沙箱、可写任意路径）。
**因此：我们的 `readOnly` 必须做在 SQLite 引擎层（🟢 外部强制），绝不能指望宿主兜底。**

> 这正是 M0 的 `openReadOnly()` 用 `new DatabaseSync(path, { readOnly: true })` 而非依赖 Pi 权限的原因。
> **一般化**：嵌套系统中，子系统的保证强度**只能由子系统自己用 🟢 实现**——宿主可能是 🟡 或 🔴。

---

## 10. 可预测性检验：四条预测全部命中

方法论若只是"事后解释"，就没有价值。用它**先预测、再验证**：

| # | 预测（由审计结论推出） | 真实验证 |
|---|---|---|
| 1 | A1 授权 🔴 → 生态会长出**权限扩展** | ✅ `@gotgenes/pi-permission-system`（6.8 万下载/月）、`@agentapprove/pi` |
| 2 | A5 缺失 → 使用者会**自建评测** | ✅ `pi-subagents` 内置 `evidence-auditor`；`pi-goal-x` 内置独立完成审计员 |
| 3 | 呈现类型泄漏（`ctx.mode === "tui"`）→ 扩展作者被迫**感知宿主模式** | ✅ 官方文档明确要求「用 `ctx.mode === "tui"` 守护终端专属行为」 |
| 4 | bash 是最大未受控面 → **保护会集中在 bash** | ✅ `pi-permission-system` 的规则重点在 `bash` 通配匹配；`confirm-destructive` 类扩展也针对命令 |

**四条全中。** 这说明方法论不只是描述性的——它能**预测生态的演化方向**。

---

## 11. Pi 得分卡

| 维度 | 评级 | 说明 |
|---|---|---|
| 分层清晰度 | 🟢 | A0–A4 边界清楚，目录即分层 |
| 端口—适配器 | 🟢 | 8 工具 × 8 Operations，形态标准 |
| 唯一通道 | 🟢（且可内省）| `tool_call`/`tool_result` + `BoundaryContextPreview` |
| 契约冻结 | 🟢 | 扩展 API 稳定 + MIGRATION_GUIDE |
| 失败分类 | 🟢 | 显式枚举 |
| 复杂度控制 | 🟢 | 内置工具仅 8 个 |
| **授权** | 🟡（分维度）| 正确性/协调性 🟢；授权/隔离 🔴 **但如实声明** |
| **依赖方向** | 🟡 | `Theme` 向上污染（`core/` 4 处 + `extensions/mcp` 1 处）|
| **A5 度量** | 🔴 | 包内缺失（生态自建）|

---

## 12. 对本项目的直接启示（可执行）

| 启示 | 落到我们哪里 |
|---|---|
| 下层只说语义，上层才谈呈现 | `ExecStatus` 在下层；`answer` 渲染放 A4（M2）；M1 的 `answer` 保持纯结构 |
| 边界要可内省 | M1 的 `ask()` 返回值包含 `sql` + `results`·`evidence`，而不是只给一句话 |
| 提示词当结构而非字符串 | M1 的上下文用**命名 section** 组织，便于将来 diff（对齐 `buildSystemPromptSections`）|
| 嵌套时自己保证 | `readOnly` 做在 SQLite 引擎层（M0 已完成）✅ |
| 授权维度要显式声明 | 我们的 `guard` 是 🟡，**必须在文档里写明兜底在引擎只读**（M0 已做）✅ |

---

## 附：一页速记

```
Pi 的 MUTU = 工具执行边界（8 定义 + 8 Operations）
Pi 的强项  = 分层 / 端口 / 唯一通道（且可内省）/ 失败分类 / 复杂度控制
Pi 的弱项  = 授权默认开放（但如实声明）/ 呈现类型向上污染 / A5 缺失
新推论    = "给人看"的类型必须留在最上层，只能经端口向下暴露
嵌套推论  = 子系统的 MUTU 不能假设宿主的 MUTU 会保护它
可预测性  = 四条预测全部命中（权限扩展 / 自建评测 / mode 感知 / bash 保护集中）
```
