# P1 / P2 / P3 执行计划

> 目标：把「优化建议」中的 P1（可观测性）、P2（上下文与配置）、P3（体验）落成可执行、可验收的任务。
> P0（超时/重试/用量统计）**已由他人完成**（`src/llm-resilience.ts`），本计划不再包含。

---

## 📍 执行进度（2026-09-01 更新）

| 任务 | 状态 | 实际结果 |
|---|---|---|
| **P2-3** 安全止血 | ✅ 完成 | `.gitignore` 改通配；**已扫描确认历史无 Key 泄露** |
| **P1-1** 统一错误处理 | ✅ 完成 | 静默吞错 **8 处 → 0 处**；`messageText` 改读 `errorMessage`（假设 B 的真实缺陷） |
| **P1-2** 单测骨架 | ✅ 完成 | **69 用例**（config 17 / settle 10 / store 17 / validate 12 / context 6 / export 7），覆盖 6 模块（计划要求 4） |
| **P1-3** engine 拆分 | ⚠️ 部分完成 | 拆出 `validate.ts`（校验门禁）+ `state.ts`（状态工厂/归一化），`engine.ts` 1067→917 行。**`reviseArc`/`resolveChoice` 未拆**，详见下方遗留 |
| **P2-1** CAP 动态化 | ✅ 完成 | `capsFor(ctxWin)`（scale 0.5–4 夹逼），16k 与历史值逐字段一致；`Engine.syncCaps()` 取三角色最小窗口 |
| **P2-2** 角色模型/温度 | ✅ 完成 | `LlmSettings.roles`；openai 分支首次获得按角色温度（原实现在线温度从未生效） |
| **P3-1** 生成中断 | ✅ 完成 | `AbortController` 贯穿 11 处 agent 调用 + `/api/abort` + 前端「■ 停止」 |
| **P3-2** 导出 | ✅ 完成 | **TXT / MD / HTML** 三格式（EPUB 按用户决定不做） |
| **P3-3** webSearch 加固 | ✅ 完成 | 双源并行（原串行）、同域限频 1s、失败原因留痕 |

**门禁状态**：`typecheck` ✅ · `npm test` **69/69** ✅ · `npm run e2e` ✅ · `npm run e2e:web` ✅ · 已推送远程 `a1e308a`

**执行中新增的发现**（详见 §7）：
- 两个 E2E 脚本原用固定工作区目录，残留会导致**开头清理就抛错**（测试根本没跑）和**假失败**。已改 `mkdtemp` 临时目录。
- 假设 **B/C/D/E 已全部核实**，其中 B 是真实缺陷（已修）。

**遗留（需人工介入）**：
1. `reviseArc`(~230 行) / `resolveChoice`(~230 行) 拆分 —— 二者深度耦合 `this.state` / `pipelineBusy` / `diceBudget` / `proc` / `setPhase`。TS 私有成员在模块外不可访问，强拆需先引入显式 context 传参（`{ store, llm, emit, state, ... }`）或放宽封装，属"改逻辑"而非"搬代码"，**超出 AI 安全自动搬移范围**，建议人工重写。已折中拆出可安全提取的纯逻辑（validate/state）作为补偿。
2. `webSearch` 的 HTML 正则对上游页面结构敏感，失败已留痕（日志前缀 `[webSearch]`），结构变更后需人工跟进正则。

---

## 0. 已核实的事实基线（写计划前实测，非推断）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 源码 6352 行；最大文件 `engine.ts` 1058 行 | `wc -l` |
| F2 | `EngineEvent` **已含** `{ type: "error"; message: string }` | `engine.ts:156` |
| F3 | 前端 **已能渲染** error 事件 | `app.js:277 case "error"` |
| F4 | server 日志重放白名单已含 `error` | `server.ts:179` |
| F5 | 静默吞错共 5 处（server）+ 1 处（engine）+ 2 处（listDir 兜底）| `server.ts:269,271,276,283,288`；`engine.ts:742`；`engine.ts:351`、`server.ts:88` |
| F6 | 项目 **无测试框架**，仅 mock E2E（23 断言） | `package.json` scripts |
| F7 | `node --import tsx --test "src/**/*.test.ts"` **在本机实测通过**（Node 22.22 + tsx 4.23），零新依赖 | 已跑探针验证并清理 |
| F8 | `.gitignore` 只忽略 `novel-workspace/` 等，**未忽略 `test-workspace-web/`**；工作区设置文件名 `设置.json` | `git check-ignore` 返回未忽略；`store.ts:329/341` |
| F9 | 设置面 API Key **明文落盘**于 `<workspace>/设置.json` | `store.ts:341` |
| F10 | `CAP` 为 9 个硬编码常量，与模型 `contextWindow` 无关联 | `context.ts:14-23` |
| F11 | 角色模型/温度硬编码，切 openai/local 后三角色退化为一个模型 | `config.ts:27-31`、`llm.ts:142` |
| F12 | `engine.ts` 方法边界清晰，可按行区间切分 | 工具函数 1-160 / 生命周期 165-397 / 场景循环 557-788 / 选择 794-1023 / 杂项 1024-1058 |

**关键推论**：F2+F3+F4 意味着 P1-1 **不需要新增事件类型**，只需把吞错处接到已有 `error` 通道上。工作量比预期低一个量级。

---

## 1. 任务总览与优先级

| 编号 | 任务 | 优先级 | 工期 | 阻塞关系 |
|---|---|---|---|---|
| **P2-3** | API Key 与工作区安全止血 | 🔴 最高（成本最低、风险最高） | **0.5h** | 无依赖，**最先做** |
| **P1-1** | 统一错误处理，消除静默吞错 | 🔴 高 | 3h | 无依赖，可与 P2-3 并行 |
| **P1-2** | 单元测试骨架（node:test，零新依赖） | 🔴 高 | 4h | 无依赖；**必须先于 P1-3** |
| **P1-3** | `engine.ts` 拆分 | 🟡 中 | 6h | **硬阻塞：P1-2** |
| **P2-1** | CAP 按 contextWindow 动态化 | 🟡 中 | 3h | 建议后于 P1-2 |
| **P2-2** | 角色模型与温度可配 | 🟡 中 | 4h | 与 P2-1 串行（同文件冲突） |
| **P3-3** | webSearch 加固 | 🟢 低 | 3h | 无依赖 |
| **P3-2** | 导出 Markdown / EPUB | 🟢 低 | 4h | 无依赖 |
| **P3-1** | 生成中断按钮 | 🟢 低 | 5h | **软阻塞：P1-1** |

**合计 ≈ 32.5 工时**（单人，含自检），约 5–7 个工作日。

### 1.1 文件冲突矩阵（决定能否并行）

| 任务 | 主要触及文件 |
|---|---|
| P2-3 | `.gitignore`、`src/facts/store.ts` |
| P1-1 | `src/web/server.ts`、`src/engine/engine.ts`、`src/web/app.js` |
| P1-2 | `src/**/*.test.ts`（新增）、`package.json` |
| P1-3 | `src/engine/*.ts`（新增 4 文件）、`src/engine/engine.ts` |
| P2-1 | `src/engine/context.ts`、`src/config.ts` |
| P2-2 | `src/config.ts`、`src/llm.ts`、`src/facts/types.ts`、`src/web/index.html`、`src/web/app.js` |
| P3-1 | `src/engine/engine.ts`、`src/web/server.ts`、`src/web/app.js` |
| P3-2 | `src/facts/store.ts`、新增 `src/export/*` |
| P3-3 | `src/agents/tools.ts` |

**冲突结论**：
- ✅ **可并行组 A**：`P2-3` ∥ `P1-1` ∥ `P3-3` —— 三者文件零重叠。
- ⚠️ **串行组 B**：`P2-1 → P2-2`（同时碰 `config.ts` + `index.html` + `app.js`）。
- ⚠️ **串行组 C**：`P1-1 → P3-1`（同碰 `engine.ts`/`server.ts`/`app.js`）。
- 🔒 **硬阻塞**：`P1-2 → P1-3`（拆分 1058 行文件前必须有测试网）。

### 1.2 建议执行顺序（单人）

```
P2-3 (0.5h) ─┬─ P1-1 (3h) ──────────────┬─ P3-1 (5h)
             ├─ P3-3 (3h)               │
             └─ P1-2 (4h) ─ P1-3 (6h) ──┤
                                        └─ P2-1 (3h) ─ P2-2 (4h)
                                        └─ P3-2 (4h)
```

---

## 2. P1：可观测性

### P1-1 统一错误处理，消除静默吞错

**目标**：任何引擎侧异常都能在 UI 上看到明确错误提示，而不是表现为"卡住不动"。

**验收标准**：
1. `src/` 下 `catch(() => {})` 数量从 8 处降至 **≤2 处**（仅保留 E2E 清理与 SSE 断连这类真正无关路径）。
2. 人为在 `reviseArc` 中注入 `throw new Error("TEST")`，Web 端 toast 显示"生成失败：TEST"且状态不再卡在"生成中"。
3. `engine.ts:742` 的 `reportP` 异常被捕获并发 `error` 事件（不再是空 catch）。
4. `/api/llm-test` 的错误流判定字段与 pi-ai 实际流事件结构一致（**核实项**，见 §6 假设 B）。
5. `npm run typecheck` + `npm run e2e:web` 全绿。

**拆解步骤**：
1. `engine.ts` 新增 `private fail(err: unknown, ctx: string)`：把 `unknown` 归一化成消息 → `emit({ type:"error", message })`。
2. 改造 `engine.ts:253 private void(p)`：内部追加 `.catch((e) => this.fail(e, "..."))`。
3. 改造 `engine.ts:742`：`reportP.catch((e) => this.fail(e, "导播报告"))`。
4. `server.ts` 新建 `private run(p: Promise<void>, ctx: string)` 助手，替换 269/271/276/283/288 五处 `void ...catch(()=>{})`。
5. `engine.ts:351` 与 `server.ts:88` 的 `listDir().catch(() => [])` 加注释说明"此处降级是有意为之"，或改为 `catch((e) => { log(e); return []; })`。
6. 前端 `app.js` 确认 error 事件在"生成中"状态下能正确复位 loading 态（F3 已渲染，需验证状态机）。
7. 手动注入异常验证。

**前置依赖**：无。
**负责人 / 资源**：你（单人）；AI 可独立完成步骤 1–5（有 typecheck + e2e 双门禁，低风险）。
**工期**：3h（含手工验证 0.5h）。

**风险与应对**：
| 风险 | 影响 | 应对 |
|---|---|---|
| 错误事件洪水：重试循环里每次失败都 toast | UI 刷屏 | `fail()` 内加 3s 同消息去重；E2E 加"连续错误只显示一次"断言 |
| 前端 loading 态未复位，错误提示被遮挡 | 验收不过 | 步骤 6 单列，先读 `app.js` renderEvent 的状态机再改 |
| 改动触发已有 E2E 断言失败 | 阻塞合入 | 先跑一次 e2e 取基线，再逐处改，每改一处重跑 |

---

### P1-2 单元测试骨架（零新依赖）

**目标**：给确定性逻辑（不依赖 LLM）建立回归网，为 P1-3 的大规模重构提供安全网。

**验收标准**：
1. `package.json` 新增 `"test": "node --import tsx --test \"src/**/*.test.ts\""`，`npm test` 可跑通。
2. 用例数 **≥ 25**，覆盖 4 个模块（见下表）。
3. 全覆盖目标：**纯函数、零 I/O、零 LLM**。
4. `npm test` 与 `npm run e2e:web` 均不互相干扰（测试用临时目录，写入 `os.tmpdir()`）。
5. AGENTS.md「提交门槛」更新为：typecheck + `npm test` + `npm run e2e`。

**拆解步骤**：
1. 加 `test` script（命令已实测可用，F7）。
2. 建测试目录约定：`src/**/*.test.ts` 与被测文件同级。
3. 按模块铺用例：

| 被测模块 | 目标函数 | 用例数 | 价值 |
|---|---|---|---|
| `engine/validate*.ts`（P1-3 拆出后） | 复读检测、大纲长度 gate、design 校验、属性钳制 | ~10 | 防止"幻觉落盘"的护栏失效 |
| `engine/settle.ts` | 金额钳制 ±1e6、属性钳制 1-18、d20 预算 ≤3 | ~8 | 确定性结算，最该测 |
| `facts/store.ts` | 原子写、BM25 中文检索、损坏 JSON 恢复 | ~5 | 需 mock fs 或用 tmpdir |
| `config.ts` | `normalizeLlm` / `validateLlm` 边界 | ~6 | 刚新增的代码，零覆盖 |

4. 优先写 `config.ts` 的 6 个用例（刚上线、零覆盖、纯函数、30 分钟可完成），立刻拿到正反馈。
5. 更新 AGENTS.md 提交门槛。

**前置依赖**：无。**注意**：若先做 P1-3，步骤 3 第一行需引用拆分后的路径——故 **P1-2 必须先于 P1-3**。
**负责人 / 资源**：你（单人）；AI 可独立完成步骤 1–2、4–5；步骤 3 的 settle/validate 用例建议 AI 生成初稿 + 你审断言语义。
**工期**：4h（首次铺网，后续边际成本极低）。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| `store.ts` 强耦合真实 fs，难测 | 测试统一用 `os.tmpdir()` 建临时工作区；不改生产代码签名 |
| 用例写成"镜像实现"（照抄断言），无保护力 | 每个用例至少含 1 个边界值 + 1 个非法值；CR 时看是否含负数/超界/空串 |
| Node 22 的 `--test` glob 在 Windows Git Bash 被引号吃掉 | 命令已实测通过（F7）；写进 package.json 时用 `\"` 转义并验证 |

---

### P1-3 `engine.ts` 拆分（1058 行 → 5 个模块）

**目标**：降低单文件认知负荷，不改任何外部行为。

**验收标准**：
1. `engine.ts` **≤ 400 行**，仅保留 `Engine` 类 + 事件定义 + 编排调用。
2. 拆出 4 个模块：`validate.ts`、`scene-loop.ts`、`choice.ts`、`save.ts`。
3. **行为等价**：`npm run e2e`（23 项）+ `npm run e2e:web`（23 项）**全绿，且与拆分前的输出逐字一致**（建议先存一份基线日志）。
4. `npm test` 全绿。
5. 无新增 `any`（typecheck 严格模式兜底）。

**拆解步骤（按行区间，F12）**：

| 步骤 | 迁出内容 | 目标文件 | 行数 |
|---|---|---|---|
| 1 | 复读检测 / 大纲 gate / design 校验 / 属性钳制 | `engine/validate.ts` | ~160 |
| 2 | `listSaves` / `load` / `save` | `engine/save.ts` | ~90 |
| 3 | `reviseArc` 场景循环主体 | `engine/scene-loop.ts` | ~230 |
| 4 | `presentChoices` / `resolveChoice` | `engine/choice.ts` | ~230 |
| 5 | `engine.ts` 收尾：重导出、跑全部门禁 | — | 余 ~350 |

**执行纪律**（高风险重构，必须遵守）：
- **一次只搬一个模块**，每搬完立刻跑 `typecheck + npm test + e2e`，红了就回滚本次，不带着错误继续。
- 步骤 1 先做（纯函数、零状态依赖、P1-2 已为其写好用例），风险最低。
- 步骤 3、4 涉及引擎主循环与 `this` 状态，**建议人审，不要纯交给 AI 自动搬**。
- 拆分前先 `git tag pre-refactor`，随时可对比。

**前置依赖**：🔒 **P1-2 完成**（测试网）。
**负责人 / 资源**：你（单人），AI 辅助但需逐模块人工 review。
**工期**：6h（拆 4h + 验证与回滚 2h）。

**风险与应对**：
| 风险 | 影响 | 应对 |
|---|---|---|
| 搬移过程中 `this` 绑定丢失 | 运行时崩 | 需要 `this` 的方法改为显式传参（传 `store`/`llm`/`emit`），不搬 `this` |
| 循环依赖（`validate ↔ engine`） | 启动失败 | `validate.ts` 保持零 import（只收纯函数），从根上断环 |
| 与并行开发冲突（AGENTS.md 明确多模型并行） | 覆盖他人改动 | 每步操作前 `git pull` + 重读文件；拆分别与其他任务同日进行 |
| 拆分后 E2E 输出字符级不一致 | 说明行为被改了 | 严禁"顺手优化"，本任务只搬家不改逻辑 |

---

## 3. P2：上下文与配置

### P2-1 CAP 按 contextWindow 动态化

**目标**：换模型不再需要改代码；小窗口模型不溢出，大窗口模型用满。

**验收标准**：
1. `context.ts` 的 `CAP` 由函数 `capsFor(contextWindow: number)` 生成，保留现有 9 个默认值作为 **16k 基准**。
2. 缩放规则：`scale = clamp(contextWindow / 16384, 0.5, 4)`，各层 `Math.round(base * scale)`（16k 时与现状完全一致）。
3. 新增单测：4k / 16k / 128k 三档下，各层 CAP 值符合预期且总量不超过 `contextWindow * 0.6`。
4. 16k 模型下跑一章，prompt 长度与改造前差异 **< 1%**（行为等价验证）。
5. `providers` 侧：模型 `contextWindow` 已能从 `llm.model(role)` 读到（需确认，见 §6 假设 C）。

**拆解步骤**：
1. `context.ts` 新增 `capsFor(ctxWin)`，把 9 个常量改为基准表 `BASE_CAP`。
2. `clip()` 与各 `assemble*Prompt` 改为接收 `caps` 参数（默认值兜底 16k，保证旧调用点不炸）。
3. 从 `engine` 传 `this.llm.model(role).contextWindow` 进来。
4. 补 3 个单测 + 一次 16k 行为等价对比。

**前置依赖**：建议后于 P1-2（可直接往测试网里加用例）。
**与谁串行**：🔒 与 P2-2 串行（同碰 `config.ts`）。
**负责人 / 资源**：你（单人），AI 可独立完成步骤 1–2。
**工期**：3h。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| 无限放大 CAP 导致小模型溢出 | 硬上限 `scale ≤ 4`，且总量校验 `≤ ctxWin * 0.6`（写进单测） |
| 改签名导致 6 个 assemble 函数批量报错 | 用默认参数 `caps = capsFor(16384)` 保证渐进式迁移 |
| 在线模型返回的 contextWindow 不准 | 兜底 16384；见 §6 假设 C |

---

### P2-2 角色模型与温度可配

**目标**：恢复 director/writer/reviewer 的分级能力，并让温度可调（调风格不用改代码）。

**验收标准**：
1. `RuntimeSettings.llm` 增加可选 `roles?: { director?: RoleOverride; writer?: RoleOverride; reviewer?: RoleOverride }`，`RoleOverride = { modelId?: string; temperature?: number }`（未设则回退全局 `modelId` 与 `ROLE_MODELS[role].temperature`）。
2. `llm.ts:142 roleModelId` 改为：先查 `roles[role].modelId`，再回退 `s.modelId`，sensenova 下再回退 `ROLE_MODELS[role].modelId`。
3. 设置界面「LLM 服务商」分组下增加「按角色覆盖（高级）」折叠区：3 行 × （模型名 + 温度滑块）。
4. 温度滑块范围 `0–1.5`，步长 `0.05`，默认值来自 `ROLE_MODELS`。
5. 旧存档（无 `roles` 字段）能正常读取（`normalizeLlm` 补默认，**守 AGENTS.md 存档兼容原则**）。
6. `npm run typecheck` + `npm run e2e:web` 全绿。

**拆解步骤**：
1. `facts/types.ts`：加 `RoleOverride`、`roles?` 字段。
2. `config.ts`：`normalizeLlm` 补 `roles` 归一化；`validateLlm` 校验 `temperature ∈ [0,2]`。
3. `llm.ts`：改 `roleModelId` + `samplingParams` 温度来源（`llm.ts:27`）。
4. `index.html`：加折叠区 DOM + 样式（沿用现有 `#settingsDlg` 风格）。
5. `app.js`：填充/保存/切换服务商时重置覆盖值（切换服务商应清空 `roles.modelId`，避免残留无效模型名）。
6. 前端零构建原则保持：不加任何新依赖。

**前置依赖**：🔒 与 P2-1 串行（同文件）。
**负责人 / 资源**：你（单人）；后端 1–3 步 AI 可独立做；前端 4–5 步需你在 `web:mock` 下过一遍。
**工期**：4h。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| 用户填了模型不支持的温度（如推理模型拒绝 temperature） | 保存时只警告不拦截；运行时 400 错误由 P1-1 的错误通道暴露 |
| 切换服务商后残留旧模型名导致调用失败 | 步骤 5 明确：切换即清空 `roles.modelId` |
| 设置项变多，界面臃肿 | 用 `<details>` 折叠，默认收起 |
| 与 P2-1 同时改 `config.ts` 冲突 | 严格串行；P2-1 合入并验证后再开 P2-2 |

---

### P2-3 API Key 与工作区安全止血 🔴

**目标**：防止明文 API Key 被 `git add .` 提交。

**验收标准**：
1. `.gitignore` 增加通配规则，覆盖**任意**工作区名（不再只认 `novel-workspace`）：
   ```
   novel-workspace*/
   *-sessions/
   test-workspace*/
   ```
2. `git status --short` 中不再出现任何 `test-workspace*` 条目。
3. 历史提交中无 Key 泄露（`git log -p --all -S "sk-" | head` 返回空）——**必查**。
4. 工作区 `设置.json` 写入权限收紧（Windows 下至少保证不被 git 跟踪；可选：写入后设文件属性 Hidden）。
5. README 补一句："API Key 明文存于工作区 `设置.json`，工作区目录已在 `.gitignore` 中，请勿手动 commit。"

**拆解步骤**：
1. 改 `.gitignore`（5 分钟）。
2. 跑 `git status --short` 确认干净。
3. 跑 Key 泄露扫描；**若发现已泄露，立即吊销该 Key 并重新签发**（这是唯一必须人工介入的分支）。
4. 改 README 一行。

**前置依赖**：无。**这是全计划的第一个动作**——0.5 小时换取"Key 不会被推到 GitHub"的确定性。
**负责人 / 资源**：你（单人），5 分钟内可完成。
**工期**：0.5h（若发现泄露则 +1h 且需吊销重签）。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| 历史提交里已有 Key | 立即吊销重签；是否重写历史（`filter-repo`）**需你决策**，见 §6 假设 D |
| 通配规则误伤（把源码目录也忽略） | 规则带 `/` 后缀限定目录；改完立刻 `git status` 核对 |
| 用户手动 `git add -f` | README 明确警告；可选加 pre-commit hook 拦截 `设置.json`（**暂不做**，先观察） |

---

## 4. P3：体验

### P3-1 生成中断按钮

**目标**：在线模型跑一章可能数分钟，用户要能随时停。

**验收标准**：
1. 生成中 UI 出现「■ 停止」按钮，点击后 **≤2s** 内停止流式输出。
2. 中断后状态一致：已写入的部分场景保留，引擎回到 `pendingReport`/上一稳定态，**不产生半截存档**。
3. 中断后能正常继续下一轮输入（不卡死）。
4. `engine` 侧提供 `abort()`：`AbortController` 贯穿到 `streamFn` 的 options。
5. 幂等：连点 3 次停止不报错。

**拆解步骤**：
1. `engine` 持有 `private abortCtl: AbortController | null`；每次 `runAgent` 前重建。
2. `streamFn` 调用点传 `signal`（需确认 pi-ai 的 `SimpleStreamOptions` 是否支持 `signal`，见 §6 假设 E）。
3. `server.ts` 新增 `POST /api/abort`；`WebHub` 转发给 engine。
4. 前端生成中显示停止按钮，点击调用 `/api/abort`；SSE 收到 `ended`/`error` 后复位。
5. 测试：生成中点停止 → 检查 `current.json` 完整、能继续输入。

**前置依赖**：🔒 软阻塞于 P1-1（中断的本质是"用户主动触发的错误路径"，需复用同一套状态复位逻辑；先做完 P1-1 可省一半返工）。
**负责人 / 资源**：你（单人）；步骤 1–3 AI 可做；步骤 4–5 需人工实测（涉及异步时序）。
**工期**：5h（步骤 2 的 API 支持情况不确定，是工期主要波动源）。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| pi-ai 的 `streamFn` 不支持 `signal` | 降级方案 B：服务端丢弃已读流 + 置 `aborted` 标志，engine 循环每轮检查标志退出（不真正中断 HTTP，但 UI 立即响应） |
| 中断时正在写盘 → 半截 JSON | 复用 `store` 已有的原子写（`tmp + rename`），中断只发生在写盘间隙 |
| 中断后状态机停在非法 phase | 中断处理统一走 `setPhase` 回到上一个稳定态；E2E 加"中断后继续"用例 |

---

### P3-2 导出 Markdown / EPUB

**目标**：写完的小说能带走。

**验收标准**：
1. `GET /api/export?format=md` 返回整本 Markdown（含书名、分弧/分场景标题、正文）。
2. `format=epub` 返回一个可正常打开的最小 EPUB（**零新依赖**：手写 zip 或用 Node 内置 `zlib` + 手写 zip 容器，见风险）。
3. 导出不修改任何工作区状态（只读操作）。
4. 空故事导出返回明确错误提示而非崩溃。

**拆解步骤**：
1. `store.ts` 加 `readAllScenes()`（按弧/场景序读章稿）。
2. 新增 `src/export/markdown.ts`（简单）。
3. 新增 `src/export/epub.ts`（手写 zip：EPUB 本质是 zip + OPF + NCX，用 `zlib.deflateRawSync` 手写 central directory 约 120 行）。
4. `server.ts` 加导出路由，返回 `content-disposition: attachment`。
5. 前端设置页加「导出」按钮组。

**前置依赖**：无。
**负责人 / 资源**：你（单人）；Markdown 部分 AI 可独立完成；EPUB 手写 zip 建议先做 **spike（1h 可行性验证）** 再决定。
**工期**：4h（MD 1h + EPUB 3h，含 spike）。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| 手写 zip 容易出错（CRC32、central directory） | **先 spike**：1 小时内写不出可校验的 zip 就降级为「只导出 MD + 打包好的 HTML 单文件」，EPUB 列为后续 |
| 违反「服务端零依赖」原则 | 手写实现即零依赖；**禁止**引入 `archiver`/`epub-gen` |
| 大书导出内存溢出 | 流式写 `res`；超过 5MB 时提示分批 |

---

### P3-3 webSearch 加固

**目标**：联网查证失败时用户能看到，而不是静默返回空结果。

**验收标准**：
1. 查证失败时向前端发 `status` 或 `error` 事件："联网查证失败（原因），本次不引用外部资料"。
2. 至少 2 个备用源，主源失败自动切换（总耗时仍 ≤ 9s，沿用 `tools.ts:383` 的现有超时）。
3. 解析失败有明确日志（含 URL 与 HTTP 状态码），便于后续修正则。
4. 加限频（同域名 ≥1s 间隔），降低被封概率。

**拆解步骤**：
1. `tools.ts` 现有实现包一层错误处理，失败时不再静默返回 `[]`。
2. 加第二个源（建议优先选有 JSON API 的，比 HTML 正则稳）。
3. 加同域限频器（Map<host, lastMs>）。
4. 加解析失败日志。

**前置依赖**：无，可与 P1-1/P2-3 并行。
**负责人 / 资源**：你（单人），AI 可独立完成步骤 1、3、4；步骤 2 选源需你确认（涉及第三方服务条款）。
**工期**：3h。

**风险与应对**：
| 风险 | 应对 |
|---|---|
| HTML 爬取天然脆弱，改完还是会坏 | 目标是"坏得可见"，不是"永不坏"；验收标准 1 才是核心 |
| 加备用源后总耗时翻倍 | 总预算锁死 9s，主源 5s 未果即切备用 |
| 触发反爬被封 IP | 限频 + 失败即降级不重试 |

---

## 5. 里程碑与交付物

| 里程碑 | 包含任务 | 累计工时 | 交付物 | 完成判据 |
|---|---|---|---|---|
| **M0 安全止血** | P2-3 | 0.5h | `.gitignore` 更新、README 说明 | `git status` 无工作区条目；历史无 Key 泄露 |
| **M1 看得见错误** | P1-1 | 3.5h | 统一错误通道 | 注入异常 → UI 可见；静默 catch ≤2 处 |
| **M2 改得动代码** | P1-2 + P1-3 | 13.5h | `npm test`、4 个新模块 | 用例 ≥25；engine.ts ≤400 行；46 项 E2E 全绿 |
| **M3 配置自适应** | P2-1 + P2-2 | 20.5h | 动态 CAP、角色级模型/温度 | 16k 行为等价；旧存档可读 |
| **M4 体验补齐** | P3-1 + P3-2 + P3-3 | 32.5h | 中断按钮、导出、查证加固 | 中断 ≤2s 生效；MD 可导出；查证失败可见 |

### 交付物清单（最终）

**代码**
- `src/engine/validate.ts`（~160 行，零 import 纯函数）
- `src/engine/save.ts`（~90 行）
- `src/engine/scene-loop.ts`（~230 行）
- `src/engine/choice.ts`（~230 行）
- `src/engine/engine.ts`（瘦身至 ≤400 行）
- `src/export/markdown.ts`、`src/export/epub.ts`（EPUB 视 spike 结果决定）
- `src/**/*.test.ts`（≥25 用例，4 个模块）

**配置 / 文档**
- `package.json`：`test` script
- `.gitignore`：工作区通配规则
- `README.md`：导出说明、Key 存储警告
- `AGENTS.md`：提交门槛增加 `npm test`；目录约定补充 `engine/` 新模块与 `src/export/`

**能力**
- 错误可见（P1-1）
- 回归网（P1-2）
- 模型无关的自适应上下文（P2-1）
- 角色级模型与温度配置（P2-2）
- 生成可中断、小说可导出、查证失败可见（P3）

---

## 6. 需确认的假设

| # | 假设 | 影响 | 需你确认 |
|---|---|---|---|
| **A** | 计划不含 P0（超时/重试/用量统计），但 P1-1 会先铺好错误通道 | 若 P0 同期做，P1-1 的错误通道可直接复用，省一次返工 | **P0 是否并入本计划？**（建议：至少把"超时"并进来，约 +2h） |
| **B** | `server.ts:448` 判定流错误用 `ev.error`，但不确定 pi-ai 的流事件实际字段名 | 若字段名不对，`/api/llm-test` 永远检测不到失败，测试连接会假阳性 | 需查 `@earendil-works/pi-ai` 的流事件类型定义 |
| **C** | `llm.model(role).contextWindow` 对 openai/local 都能拿到真实值 | 若拿不到，P2-1 的动态缩放失去输入 | 需实测：openai provider 是否回填 contextWindow，否则用 `LOCAL_CONTEXT` / 手动配置项兜底 |
| **D** | 历史提交中无 API Key 泄露 | 若有，处理成本从 0.5h 升到数小时且需吊销重签 | M0 第一步执行 `git log -p --all -S "sk-"` 即知 |
| **E** | pi-ai 的 `SimpleStreamOptions` 支持传 `AbortSignal` | 不支持则 P3-1 要走降级方案 B（伪中断，UI 立即响应但不掐 HTTP） | 需查 `streamSimple` 签名 |
| **F** | 单人开发，无团队分工 | 若实际有协作者，"可并行组 A"可真并行，总工期从 32.5h 压到 ~22h（墙钟） | 是否有协作者？ |
| **G** | EPUB 值得手写 zip（约 120 行） | 若觉得不值，降级为"MD + 单文件 HTML"，P3-2 从 4h 降到 1.5h | 是否真的需要 EPUB？ |
| **H** | 现有 23 项 E2E 断言覆盖了场景循环主路径 | P1-3 拆分的安全性完全依赖这个假设 | M2 开工前先确认：若覆盖不足，先补 E2E 再拆 |

---

## 7. 立即可做的三件事（无需等待确认）

1. **P2-3 全量**（0.5h）—— 安全风险，无依赖，做完即收益。
2. **P1-2 步骤 4**（0.5h）—— 给 `config.ts` 的 `normalizeLlm`/`validateLlm` 写 6 个用例，立刻验证测试链路可用并拿到正反馈。
3. **核实假设 B / C / E**（0.5h）—— 三个 `node_modules` 里的类型定义查询，决定 P1-1、P2-1、P3-1 的实现路径，**越早查越省返工**。
