// Web 模式入口：npm run web（真实模式）/ npm run web:mock（无 key 体验）
// 环境变量：PORT（默认 3456）、WEB_TOKEN（访问令牌，未设置则随机生成打印）、NOVEL_WORKSPACE
// 会话：main 用基础工作区，其余会话在 <工作区>/sessions/<id>；?session= 切换，fork 分叉

import { randomBytes } from "node:crypto";
import { createLlm, createMockLlm } from "./llm.js";
import { ENGINE } from "./config.js";
import { SessionManager, startWebServer } from "./web/server.js";

const mock = process.argv.includes("--mock");
const port = Number(process.env.PORT ?? 3456);
const token = process.env.WEB_TOKEN ?? process.env.TOKEN ?? randomBytes(9).toString("base64url");

const llm = mock ? createMockLlm() : createLlm();
const sessions = new SessionManager(ENGINE.workspace, token, llm);

await startWebServer(sessions, port);
console.log(`访问令牌: ${token}`);
console.log(mock ? "（mock 模式：流程演示，内容为预排文本）" : "（SenseNova 真实模式）");
void sessions.get("main"); // 主会话：立即创建并开始恢复进度
