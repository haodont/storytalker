// 商汤 SenseNova 连通性 spike：跑通一条流式补全即接入成功
//   npm run spike
// 需要 .env 中配置 SENSENOVA_API_KEY

import { SENSENOVA } from "./config.js";
import { createLlm } from "./llm.js";

async function main() {
	const llm = createLlm();
	const model = llm.model("writer");
	console.log(`模型: ${SENSENOVA.providerId}/${model.id}  base_url: ${SENSENOVA.baseUrl}\n`);	const stream = llm.streamFn(model, {
		systemPrompt: "你是一位简洁的中文写作助手。",
		messages: [{ role: "user", content: "用两句话写一个悬疑故事的开头。", timestamp: Date.now() }],
	});

	for await (const event of stream) {
		if (event.type === "text_delta") {
			process.stdout.write(event.delta);
		} else if (event.type === "done") {
			process.stdout.write("\n\n✓ 流式补全成功。usage: ");
			console.log(JSON.stringify(event.message.usage));
		} else if (event.type === "error") {
			console.error("\n✗ 流式错误:", event.error.errorMessage);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error("✗ spike 失败:", err?.message ?? err);
	process.exit(1);
});
