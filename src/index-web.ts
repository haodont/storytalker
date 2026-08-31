// Web 模式入口：npm run web（真实模式）/ npm run web:mock（无 key 体验）
// 环境变量：PORT（默认 3456）、WEB_TOKEN（访问令牌；不设置或留空 = 关闭鉴权，打开页面即用）、NOVEL_WORKSPACE
// 会话：main 用基础工作区，其余会话在 <工作区>/sessions/<id>；?session= 切换，fork 分叉
// LLM 服务商由设置界面配置（按会话持久化），默认沿用 .env 的 LLM_PROVIDER

import { ENGINE } from "./config.js";
import { SessionManager, startWebServer } from "./web/server.js";

const mock = process.argv.includes("--mock");
const port = Number(process.env.PORT ?? 3456);
const token = (process.env.WEB_TOKEN ?? process.env.TOKEN ?? "").trim();

const sessions = new SessionManager(ENGINE.workspace, token, mock);

await startWebServer(sessions, port);
console.log(token ? `访问令牌: ${token}` : "鉴权已关闭（未设置 WEB_TOKEN）：局域网内打开页面即可使用");
console.log(mock ? "（mock 模式：流程演示，内容为预排文本）" : "（LLM 服务商由设置界面配置，默认沿用 .env 的 LLM_PROVIDER）");
void sessions.get("main"); // 主会话：立即创建并开始恢复进度
