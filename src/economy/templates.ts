// ---------------------------------------------------------------------------
// 经济模板注册表：经济系统是可插拔的模板，不写死在任何故事里。
// - 引擎内置若干模板（清末银本位 / 现代都市 / 末日以物易物 / 通用）；
// - 故事设计时由导播按题材选择（design_story 的 economy.templateId）；
// - 特殊题材可通过 registerEconomyTemplate() 注册自定义模板后再开局。
// 模板的价值：物价/收入基准是代码管理的事实——写手与校对核对草稿中
// 金额与价格是否有据可依，防"一根油条卖五百两"式幻觉。
// ---------------------------------------------------------------------------

export interface EconomyTemplate {
	/** 注册 id（design_story.economy.templateId 引用） */
	id: string;
	name: string;
	/** 计价单位（如 两/元/罐头） */
	currency: string;
	/** 商品基准价表（数字是代码管理的锚点，模型只能引用不能篡改） */
	commodities: { name: string; basePrice: number; unit: string }[];
	/** 收入基准（月），给"谁买得起什么"提供标尺 */
	wages: { name: string; monthly: number }[];
	/** 模板说明：经济逻辑要点（进上下文） */
	notes: string;
}

const templates = new Map<string, EconomyTemplate>();

export function registerEconomyTemplate(t: EconomyTemplate): void {
	templates.set(t.id, t);
}

export function findEconomyTemplate(id: string): EconomyTemplate | undefined {
	return templates.get(id);
}

export function listEconomyTemplates(): EconomyTemplate[] {
	return [...templates.values()];
}

registerEconomyTemplate({
	id: "qing-silver",
	name: "清末银本位（银两/制钱）",
	currency: "两（白银，1两≈2000文制钱）",
	commodities: [
		{ name: "大米", basePrice: 2.0, unit: "两/石" },
		{ name: "白面", basePrice: 0.03, unit: "两/斤" },
		{ name: "猪肉", basePrice: 0.035, unit: "两/斤" },
		{ name: "粗布", basePrice: 0.015, unit: "两/尺" },
		{ name: "煤炭", basePrice: 0.01, unit: "两/斤" },
		{ name: "火车票（京津）", basePrice: 2.0, unit: "两/三等" },
		{ name: "四合院月租", basePrice: 5.0, unit: "两/月" },
	],
	wages: [
		{ name: "乡下长工", monthly: 1.0 },
		{ name: "城市苦力", monthly: 2.5 },
		{ name: "店铺伙计", monthly: 3.0 },
		{ name: "私塾先生", monthly: 6.0 },
		{ name: "知县（正俸+陋规）", monthly: 45.0 },
	],
	notes:
		"白银与制钱并行，大宗交易用银两、日常用制钱；洋货昂贵且是身份象征；新政/洋务背景下行业剧变。物价因灾荒与漕运波动剧烈，丰年米贱、灾年米贵。",
});

registerEconomyTemplate({
	id: "modern-cn",
	name: "现代都市（人民币）",
	currency: "元（人民币，移动支付普及）",
	commodities: [
		{ name: "大米", basePrice: 3.5, unit: "元/斤" },
		{ name: "猪肉", basePrice: 16.0, unit: "元/斤" },
		{ name: "地铁票", basePrice: 4.0, unit: "元/程" },
		{ name: "快餐", basePrice: 25.0, unit: "元/顿" },
		{ name: "经济型酒店", basePrice: 280.0, unit: "元/晚" },
		{ name: "市区一居室月租", basePrice: 3500.0, unit: "元/月" },
	],
	wages: [
		{ name: "普通工薪", monthly: 6000.0 },
		{ name: "技术岗位", monthly: 20000.0 },
		{ name: "退休金", monthly: 3500.0 },
	],
	notes: "移动支付与信用体系覆盖一切；房价/房租是最大的阶层分野；灰色产业走现金。收入差异即权力差异。",
});

registerEconomyTemplate({
	id: "scrap-barter",
	name: "末日/废土（以物易物）",
	currency: "罐头（硬通货，1罐头≈1天口粮）",
	commodities: [
		{ name: "子弹", basePrice: 0.5, unit: "罐头/发" },
		{ name: "抗生素（一板）", basePrice: 8.0, unit: "罐头" },
		{ name: "燃油", basePrice: 2.0, unit: "罐头/升" },
		{ name: "电池", basePrice: 1.0, unit: "罐头/节" },
		{ name: "净水泥土", basePrice: 3.0, unit: "罐头" },
	],
	wages: [{ name: "哨塔守卫", monthly: 25.0 }, { name: "拾荒者（好日子）", monthly: 15.0 }],
	notes: "没有货币发行方，硬通货=耐储存+高需求（口粮/弹药/药品）；暴力是定价的一部分；以物易物，赊账意味着人身依附。",
});

registerEconomyTemplate({
	id: "generic",
	name: "通用（自定世界观）",
	currency: "信用点",
	commodities: [
		{ name: "一餐饭", basePrice: 2.0, unit: "信用点" },
		{ name: "普通住宿（晚）", basePrice: 8.0, unit: "信用点" },
		{ name: "短途交通", basePrice: 1.0, unit: "信用点" },
	],
	wages: [{ name: "普通劳作", monthly: 90.0 }],
	notes: "抽象单位。适合异世界/奇幻等无现实锚点的题材；导播可在 worldRules 中细化交换逻辑。",
});
