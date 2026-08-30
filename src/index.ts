import { Store } from "./facts/store.js";
import { Engine } from "./engine/engine.js";
import { createLlm, createMockLlm } from "./llm.js";
import { ENGINE } from "./config.js";
import { startTui } from "./ui/tui.js";

// AI 互动小说引擎入口
//   npm run dev -- --mock          无 API Key 的 mock 模式（验证流程）
//   npm run dev                    SenseNova 真实模式
//   NOVEL_WORKSPACE=<路径>          自定义工作区

const mock = process.argv.includes("--mock");
const llm = mock ? createMockLlm() : createLlm();
const store = new Store(ENGINE.workspace);

// 引擎事件先空转，startTui 内部会挂接 UI 渲染
const engine = new Engine(store, llm, () => {});
startTui(engine);

engine.boot().catch((err) => {
	engine.emit({ type: "error", message: `启动失败：${err?.message ?? err}` });
});
