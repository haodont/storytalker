# AI 互动小说引擎（边玩边读）

剧情由 AI 全自动推进的终端互动小说：导播维护滚动大纲与记忆，执笔流式写场景，校对拦截设定矛盾；你在关键节点做选择，选择会被织入后续大纲。基于 [pi](https://github.com/earendil-works/pi) 框架（pi-ai / pi-agent-core / pi-tui）+ 商汤 SenseNova（OpenAI 兼容模式）。

## 快速开始

```bash
npm install
cp .env.example .env        # 选择 LLM 来源并填入配置

# 来源一：本地 llama.cpp（WSL，免费，RTX 5070 上约 90 tok/s）
#   WSL 内：~/llama.cpp/build-cuda/bin/llama-server \
#     -m ~/models/Qwen3.5-9B-Q4_K_M.gguf -c 16384 -ngl 999 \
#     --port 8137 --host 0.0.0.0 --jinja \
#     --chat-template-kwargs '{"enable_thinking": false}' \
#     --dry-multiplier 0.8 --repeat-penalty 1.05
#   .env 里设 LLM_PROVIDER=local

# 来源二：商汤 SenseNova 云 API（.env 里设 LLM_PROVIDER=sensenova 并填 key）

npm run spike               # 验证 LLM 连通性（流式补全）
npm run e2e                 # mock 全流程自测（不依赖任何 LLM）
npm run try:local           # 本地模型试跑：开局 + 自动跑若干场景，评估内容质量
npm run dev                 # 终端 TUI 玩
npm run web                 # Web 版（手机浏览器可玩）
```

**本地模型说明**（Qwen3.5-9B Q4_K_M + llama.cpp CUDA）：
- `--jinja` + `enable_thinking:false` 关闭思考模式（思考会拖慢出字并污染正文）
- `--dry-multiplier 0.8 --repeat-penalty 1.05` 抗复读采样；引擎另有确定性的复读检测兜底（草稿中 24 字块重复 ≥4 次自动打回重写）

## 怎么玩

1. 启动后输入一句话灵感（如「都市异能者在便利店夜班遇到的怪事」），导播生成世界观、角色、第一弧大纲
2. `/accept` 确认开局，或直接输入修改意见让导播调整
3. 每个场景流式播出后给出 2-4 个走向候选：**输入序号**选择，或**直接描述**你想要的走向（会织入大纲）
4. `/mode auto` 切换挂机自动模式（导播按推荐走向自动推进）
5. 写作进行中直接打字 = 给执笔插话（steer），会影响当前场景

| 命令 | 作用 |
|------|------|
| `/accept` | 确认开局设计 |
| `/mode auto\|manual` | 切换自动挂机 / 手动选择 |
| `/save <名>` | 存档（autosave 始终在 `存档/current.json`，重启自动恢复） |
| `/restart` | 重新开始 |
| `/outline` `/bible` | 查看弧大纲 / 世界观 |
| `/quit` | 退出 |

## 架构

```
src/
├── config.ts          LLM 接入参数、角色→模型映射、引擎参数
├── llm.ts             pi-ai 自定义 provider + mock 模式
├── index.ts / index-web.ts   终端 TUI / Web 服务入口
├── facts/             事实层（文件即唯一事实源）
│   ├── types.ts       GameState/角色卡/弧大纲/伏笔/裁决 …
│   └── store.ts       原子读写、角色状态块、伏笔台账、关键词全文检索
├── agents/            三个角色（各自 system prompt + 工具集）
│   ├── prompts.ts     导播/执笔/校对提示词
│   ├── tools.ts       read_bible / search_story / read_foreshadows /
│   │                  design_story / save_scene_outline / save_arc_revision /
│   │                  save_scene_report / submit_verdict 等
│   └── agents.ts      runAgent：一次性角色调用（pi-agent-core Agent 封装）
├── engine/
│   ├── engine.ts      确定性状态机：boot→confirm→[场大纲推演→写稿→校验→重写→
│   │                  呈现→选择→报告]→弧边界；每步 checkpoint 原子落盘
│   ├── context.ts     上下文组装器（总纲→弧摘要→近期摘要→角色卡→伏笔）
│   └── settle.ts      场景报告结算：状态补丁/伏笔操作/经济流水
├── web/               Web 服务端（零依赖 node:http）+ 前端
│   ├── server.ts      SSE 事件流 / 命令 / 文件白名单 / 静态路由
│   ├── components.js  前端 UI 组件库（7 个原生 Web Components，Shadow DOM）
│   ├── app.js         业务编排层
│   ├── vendor/ fonts/ 本地 vendored 开源库与霞鹜文楷字体（零 CDN）
│   └── index.html
└── ui/tui.ts          pi-tui 界面：状态条 + 正文流式区 + 输入框
```

**开发规范见 [AGENTS.md](AGENTS.md)**：提交门槛（typecheck + e2e）、前端零构建链原则、
组件化约定、多模型并行协作注意事项。

**记忆设计**：角色 prompt 每轮由引擎确定性组装，不靠对话历史累积——永不塞全文；
角色状态以 JSON 块存在角色卡内随剧情更新；伏笔台账记录 plant/advance/resolve；
Reviewer 对照"活跃约束清单"（状态快照+规则+伏笔+近期摘要）做定点校验，
矛盾必须引用原文举证，打回重写（上限 2 次）。

**工作区布局**（`novel-workspace/`，可删除重来）：
`设定/`（世界观/规则/角色卡） `大纲/`（总纲+弧） `记忆/`（场景摘要/弧摘要/伏笔台账/选择历史） `章稿/` `存档/`

## 验证状态

- mock 全流程 E2E：14 项断言通过（开局→10 场景→校验重写环→自动选择→弧收束→断点恢复）
- SenseNova 真实联调：`npm run spike` 验证连通后即可游玩
