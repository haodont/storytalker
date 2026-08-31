# 开发规范（AGENTS.md）

本文件约束人类与 AI 贡献者的开发行为。改动前请先读完。

## 常用命令

```bash
npm run typecheck   # tsc --noEmit，提交前必须通过（唯一静态门禁）
npm test            # 单元测试（node:test + tsx，零新增依赖）；新增纯函数时同步补用例
npm run e2e         # mock 全流程自测（不依赖 LLM）
npm run e2e:web     # Web 端 mock 自测（工作区用系统临时目录，每轮独立）
npm run web         # Web 服务（WEB_TOKEN 可选：不设则关闭鉴权）
npm run dev         # 终端 TUI
npm run tune        # Prompt 调优台（输出到 tune-out/）
```

## 目录约定

```
src/
  agents/    三个 agent 的系统提示词与工具定义（director/writer/reviewer）
  engine/    引擎主循环（engine.ts）、确定性校验（validate.ts）、状态工厂/归一化（state.ts）、
            上下文组装（context.ts）、结算（settle.ts）；纯函数优先放独立模块便于单测
  export/    整本导出（markdown.ts：MD/HTML 组装，只读工作区）
  facts/     工作区持久层（store.ts）与类型（types.ts）
  web/       Web 服务端（server.ts）+ 前端（index.html / components.js / app.js）
  ui/        终端 TUI
  根目录的 index*.ts / e2e-*.ts / try-local.ts / tune.ts / spike.ts 是各入口脚本
novel-workspace*/  运行时玩家数据（存档/章稿/记忆），不入库
tune-out/          调优台输出，不入库
deploy/            服务器部署脚本
```

## 硬性原则

1. **前端零构建链、零 CDN 依赖**：不引入打包器/框架；第三方库以 UMD/预构建产物 vendored 进 `src/web/vendor` 与 `src/web/fonts`（来源记录在 package.json devDependencies），通过 `/vendor/`、`/fonts/` 路由静态服务。
2. **前端组件化**：UI 组件一律写成 `src/web/components.js` 里的原生 Web Components（Shadow DOM）；`app.js` 只做业务编排，不直接操作组件内部 DOM。注意 `* { box-sizing }` 等文档级样式穿不进 Shadow DOM，组件内需自带。
3. **提交门槛**：`npm run typecheck` + `npm test` + `npm run e2e` 全部通过。纯前端改动至少在 mock 模式（`npm run web:mock`）过一遍核心流程。
4. **禁止静默吞错**：不得写 `.catch(() => {})`。异步动作失败必须转成 `error` 事件（引擎侧用 `this.void()`，Web 侧用 `WebHub.run()`），否则失败表现为「界面卡住」且查无痕迹。确属有意降级的（如目录不存在返回空列表）必须就地写注释说明。
5. **运行时数据不入库**：工作区目录、日志、.env 永远 gitignore；`.env.example` 是唯一配置模板。工作区含明文 API Key 的 `设置.json`，`.gitignore` 用通配（`novel-workspace*`/`*-sessions`/`test-workspace*`），新增工作区路径必须同步更新。
6. **服务端零依赖**：Web 服务只用 node:http（见 server.ts 头注释），新增后端能力优先保持零依赖。单元测试同理，只用 `node:test`，不引测试框架。

## 协作注意事项

- **多模型并行开发**：改文件前先重读最新版本（文件可能刚被并行修改），编辑工具报 "modified since read" 时必须重新读取后再改，不得凭旧内容覆盖。
- **存档兼容**：GameState（facts/types.ts）字段变更须考虑旧存档恢复（engine.restoreOrEmpty 的容错模式：缺字段补默认值）。
- **事件即契约**：EngineEvent（engine.ts）是引擎→前端的唯一通道，新增事件要同步更新 server.ts 日志合并（logPush）、app.js renderEvent/renderProcess。
- **Web 令牌**：可选。不设 WEB_TOKEN = 关闭鉴权（局域网打开页面即用，默认玩法）；要限权时显式设置该环境变量即可。
- 行尾 LF；TS 用 tab 缩进，前端 js/json 用 2 空格（.editorconfig 已定义）。
