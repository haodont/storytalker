// 互动小说 Web 前端（业务编排层）：SSE 事件流 → UI 组件（见 components.js）。
// 本文件不直接拼装组件内部 DOM，只调用组件公开 API / 监听组件事件。
"use strict";

const $ = (id) => document.getElementById(id);
const reader = $("reader");
const input = $("input");
const hintEl = $("hint");
const statusEl = $("status"); // <x-status>
const choicesEl = $("choices"); // <x-choices>
const menuEl = $("menu"); // <x-menu>
const toastsEl = $("toasts"); // <x-toast-host>
const confirmEl = $("confirm"); // <x-confirm>
const procLogEl = $("procLog"); // <x-proc-log>

const state = {
  phase: "connecting",
  pendingChoices: null,
  streaming: null,
  streamBuffer: "",
  lastStatus: "",
  busy: false, // 任一角色流式输出中 → 状态徽章呼吸闪烁
  arcCount: 1, // 当前弧号（右栏大纲标题用）
  lastSceneOutline: null, // 最近一场的场大纲 { scene, text }
};
let lastBootCard = null; // 当前显示的开局设定卡（新卡替换旧卡）
let ideaStreaming = null; // 灵感对话流式块
let ideaStreamBuf = "";

// ---------- token ----------
const SESSION = new URLSearchParams(location.search).get("session") || "main";
let TOKEN = localStorage.getItem("novel_token") || "";
async function ensureToken() {
  // URL ?token= 优先（内嵌浏览器等不支持 prompt() 的环境靠它登录）
  const urlToken = new URLSearchParams(location.search).get("token");
  if (urlToken) {
    TOKEN = urlToken.trim();
    localStorage.setItem("novel_token", TOKEN);
  }
  if (TOKEN) {
    const r = await fetch("/api/state?token=" + encodeURIComponent(TOKEN) + "&session=" + encodeURIComponent(SESSION));
    if (r.status !== 401) return true;
  }
  let t = null;
  try { t = await confirmEl.ask("请输入访问令牌（WEB_TOKEN）", { input: true }); } catch (e) { /* 组件未就绪等 */ }
  if (!t) {
    document.body.innerHTML = "<p style='padding:2em;font-family:system-ui'>需要令牌才能访问：请在地址栏加上 ?token=你的令牌</p>";
    return false;
  }
  TOKEN = t.trim();
  localStorage.setItem("novel_token", TOKEN);
  return true;
}

// ---------- 渲染 ----------
// 智能跟随：贴底时才自动滚动；向上翻历史时不打断阅读，改由「↓ 最新」按钮回底
function nearBottom() {
  return reader.scrollHeight - reader.scrollTop - reader.clientHeight < 120;
}
function scrollNow() {
  reader.scrollTop = reader.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

function mountBlock(el) {
  const hero = document.getElementById("hero");
  if (hero && el !== hero) hero.remove(); // 有正内容时撤掉欢迎页
  const stick = nearBottom();
  el.classList.add("block");
  reader.appendChild(el);
  // 长会话内存防线：阅读流上限 400 块，超限移除最老块（完整历史在服务端事件日志里）
  while (reader.children.length > 400) reader.firstChild.remove();
  if (stick) scrollNow();
  updateJumpBtn();
  return el;
}

function newBlock(cls, text) {
  const div = document.createElement("div");
  div.className = cls || "";
  if (text !== undefined) div.textContent = text;
  return mountBlock(div);
}

// 细线渐隐分隔线：variant 为 "" / "choice" / "end"
function newSep(text, variant) {
  const div = newBlock("sep" + (variant ? " " + variant : ""));
  const mkLine = () => { const s = document.createElement("span"); s.className = "line"; return s; };
  if (variant !== "end") { div.appendChild(mkLine()); }
  const t = document.createElement("span");
  t.textContent = text;
  div.appendChild(t);
  if (variant !== "end") { div.appendChild(mkLine()); }
  return div;
}

const PHASE_NAMES = {
  empty: "等待灵感", idea_chat: "灵感酝酿", bootstrapping: "导播设计中", confirm_bible: "开局待确认",
  playing: "进行中", arc_boundary: "弧收束中", ended: "已完结", connecting: "连接中",
};

function renderStatus(text) {
  if (text !== undefined) state.lastStatus = text;
  statusEl.update({
    phase: PHASE_NAMES[state.phase] || state.phase,
    text: state.lastStatus,
    busy: state.busy || state.phase === "bootstrapping" || state.phase === "arc_boundary",
    err: state.phase === "connecting",
  });
  renderFooter();
  if (state.phase === "empty") renderHero();
}

// ---------- 空状态欢迎页 ----------
const HERO_EXAMPLES = [
  ["赛博都市的记忆贩子", "科幻悬疑 · 卖掉的记忆再也找不回来"],
  ["深山客栈的连环谜案", "古典推理 · 一夜风雪困住七个人"],
  ["小人物的王朝求生记", "历史权谋 · 没有金手指，只有谨慎"],
];
function renderHero() {
  if (document.getElementById("hero") || reader.children.length) return;
  const div = document.createElement("div");
  div.className = "hero";
  div.id = "hero";
  div.innerHTML = '<div class="hero-mark">✒</div><h2>从一句灵感开始</h2>'
    + "<p>和导播聊聊题材、主角与基调，它会为你设计开局、组织执笔与校对。写作途中你随时可以插话、做出选择，甚至分叉出平行世界。</p>"
    + '<div class="hero-examples">'
    + HERO_EXAMPLES.map((e, i) => '<button data-i="' + i + '">' + e[0] + '<span class="tag">' + e[1] + "</span></button>").join("")
    + "</div>";
  div.querySelectorAll(".hero-examples button").forEach((b) => {
    b.onclick = () => { input.value = HERO_EXAMPLES[Number(b.dataset.i)][0]; input.focus(); };
  });
  reader.appendChild(div);
}

function setBusy(b) {
  if (state.busy === b) return;
  state.busy = b;
  renderStatus();
}

function hintFor() {
  if (state.phase === "empty") return "随便聊聊你的灵感（题材/主角/想要的基调），聊透了再构建；也可输入「构建：一句话」直接开工";
  if (state.phase === "idea_chat") return "继续和导播聊；满意后点菜单「开始构建开局」，或输入「构建：补充要求」";
  if (state.phase === "confirm_bible") return "输入修改意见让导播调整，或点菜单里的「确认开局」";
  if (state.phase === "playing" && state.pendingChoices) return "点上方选项（或按数字键 1-3）、输入「大纲：意见」调整右侧大纲，或直接描述你想要的走向";
  if (state.phase === "playing") return "写作进行中：直接输入可插话影响当前场景；输入「大纲：意见」可让导播修订弧大纲";
  if (state.phase === "ended") return "本篇完结。菜单里「重新开始」开启新故事";
  return "";
}

function renderFooter() {
  hintEl.textContent = hintFor();
  input.placeholder = hintFor() ? "" : "输入…";
  choicesEl.setChoices(state.pendingChoices);
  syncLayoutVars(); // 选项/提示变化会改变底栏高度
}
choicesEl.addEventListener("pick", (e) => send(e.detail.label + "——" + e.detail.description));

function renderEvent(ev) {
  switch (ev.type) {
    case "phase":
      state.phase = ev.phase;
      if (ev.phase !== "playing") state.pendingChoices = null;
      setBusy(false);
      renderStatus();
      if (ev.phase === "playing") refreshOutline(); // 开弧/新场景：拉最新总纲与弧大纲
      break;
    case "status":
      renderStatus(ev.text);
      break;
    case "scene_outline":
      state.lastSceneOutline = { scene: ev.scene, text: ev.text };
      if (activeTab === "outline" && $("outlineView").children.length) {
        const old = document.getElementById("sceneOutlineSec");
        if (old) old.remove();
        renderSceneOutlineCard($("outlineView"));
      }
      break;
    case "outline_updated":
      state.lastSceneOutline = null;
      toastsEl.show("弧大纲已更新：「" + ev.title + "」", "ok");
      refreshOutline();
      break;
    case "scene_delta":
      if (!state.streaming) {
        state.streaming = newBlock();
        state.streamBuffer = "";
        state.streamNode = document.createTextNode("");
        state.streaming.appendChild(state.streamNode);
        state.streaming.classList.add("cursor");
      }
      {
        const stick = nearBottom();
        // 追加式写入 text node：每个 delta 只动增量，不整块重写（避免 O(n²) reflow）
        state.streamNode.data += ev.text;
        state.streamBuffer += ev.text;
        setBusy(true);
        if (stick) scrollNow();
      }
      break;

    case "idea_user":
      if (ideaStreaming) { ideaStreaming.classList.remove("cursor"); ideaStreaming = null; }
      newBlock("chat me", "").innerHTML = '<span class="who">你</span>';
      reader.lastChild.insertAdjacentText("beforeend", ev.text);
      break;
    case "idea_delta":
      if (!ideaStreaming) {
        ideaStreaming = newBlock("chat", "");
        ideaStreaming.innerHTML = '<span class="who">顾问</span>';
        ideaStreaming.appendChild(document.createTextNode(""));
        ideaStreaming.classList.add("cursor");
        ideaStreamBuf = "";
      }
      {
        const stick = nearBottom();
        ideaStreamBuf += ev.text;
        ideaStreaming.childNodes[1].textContent = ideaStreamBuf + " ";
        setBusy(true);
        if (stick) scrollNow();
      }
      break;
    case "idea_done":
      setBusy(false);
      if (ideaStreaming) {
        ideaStreaming.classList.remove("cursor");
        ideaStreaming.childNodes[1].textContent = ev.text;
        ideaStreaming = null;
      } else {
        const c = newBlock("chat", "");
        c.innerHTML = '<span class="who">顾问</span>';
        c.insertAdjacentText("beforeend", ev.text);
      }
      break;
    case "scene_done":
      setBusy(false);
      if (state.streaming) { state.streaming.textContent = ev.text; state.streaming.classList.remove("cursor"); }
      else newBlock("", ev.text);
      state.streaming = null; state.streamBuffer = "";
      newSep("第 " + ev.scene + " 场完");
      renderStatus();
      break;
    case "review":
      if (!ev.pass) newBlock("note", "【校对】发现 " + ev.issues.length + " 处疑义，打回重写：" + ev.issues.map((i) => i.problem).join("；"));
      break;
    case "boot_ready": {
      state.arcCount = 1;
      state.lastSceneOutline = null;
      // 新的开局设定卡替换旧的（避免反馈调整/重放时堆积多张卡）
      if (lastBootCard && lastBootCard.parentNode) lastBootCard.remove();
      const div = newBlock("card boot");
      const arc = ev.arcTitle.replace(/^第[一二三四五六七八九十]+弧[·:：、]?\s*/, "");
      div.innerHTML = '<div class="boot-kicker">开 局 设 定</div>'
        + '<h3 class="boot-title">《' + esc(ev.title) + '》</h3>'
        + '<p class="boot-premise">' + esc(ev.premise) + '</p>'
        + '<div class="boot-label">角 色</div><ul>' + ev.characters.map((c) => "<li>" + esc(c) + "</li>").join("") + "</ul>"
        + '<div class="boot-label">第一弧 · ' + esc(arc) + '</div><p>' + esc(ev.arcGoal) + '</p>'
        + '<div class="boot-label">开 场 拍</div><p>' + esc(ev.openingBeat) + '</p>';
      lastBootCard = div;
      refreshOutline(); // 总纲/弧大纲刚由导播生成
      break;
    }
    case "choices":
      state.pendingChoices = ev.choices;
      renderFooter();
      newSep("你的选择", "choice");
      break;
    case "arc_boundary":
      newBlock("note", ev.summary);
      break;
    case "ended":
      newSep("本 篇 完", "end");
      renderStatus();
      celebrate();
      break;
    case "error":
      newBlock("note err", "✗ " + ev.message);
      toastsEl.show(ev.message, "err");
      break;
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 完结庆祝：canvas-confetti 双侧礼花（组件加载失败时静默跳过）
function celebrate() {
  if (typeof confetti !== "function") return;
  const opts = { particleCount: 90, spread: 75, origin: { y: 0.7 }, zIndex: 40 };
  confetti({ ...opts, angle: 60, origin: { x: 0, y: 0.7 } });
  confetti({ ...opts, angle: 120, origin: { x: 1, y: 0.7 } });
}

// ---------- UI 组件调用（Toast / 对话框 / 命令反馈） ----------
// 命令统一入口：失败自动 Toast 反馈
async function command(cmd) {
  const r = await api("/api/command", { cmd });
  if (r && r.ok === false) toastsEl.show(r.message || "命令失败", "err");
  return r;
}

// dayjs 中文相对时间（UMD locale 全局为 dayjs_locale_zh_cn，需显式挂到 dayjs）
try {
  if (window.dayjs_locale_zh_cn) dayjs.locale(window.dayjs_locale_zh_cn);
  if (window.dayjs_plugin_relativeTime) dayjs.extend(window.dayjs_plugin_relativeTime);
} catch (e) { /* 相对时间不可用时退回绝对时间 */ }

// ---------- 主题与字号（localStorage 持久化） ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("novel_theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "paper" ? "#f5f1e8" : "#141416";
  $("themeBtn").textContent = t === "paper" ? "夜" : "纸";
}
$("themeBtn").onclick = () => applyTheme(document.documentElement.dataset.theme === "paper" ? "dark" : "paper");
applyTheme(localStorage.getItem("novel_theme") === "paper" ? "paper" : "dark");

let fsVal = parseFloat(localStorage.getItem("novel_fs")) || 1;
function applyFs(v) {
  fsVal = Math.min(1.4, Math.max(0.85, Math.round(v * 10) / 10));
  document.documentElement.style.setProperty("--fs", String(fsVal));
  localStorage.setItem("novel_fs", String(fsVal));
}
$("fontMinus").onclick = () => { applyFs(fsVal - 0.1); toastsEl.show("字号 " + Math.round(fsVal * 100) + "%", "", 1100); };
$("fontPlus").onclick = () => { applyFs(fsVal + 0.1); toastsEl.show("字号 " + Math.round(fsVal * 100) + "%", "", 1100); };
applyFs(fsVal);

// ---------- 回到底部按钮 ----------
const jumpBtn = $("jumpBtn");
function updateJumpBtn() {
  const hasContent = reader.scrollHeight > reader.clientHeight * 1.5;
  jumpBtn.classList.toggle("show", hasContent && !nearBottom());
}
reader.addEventListener("scroll", updateJumpBtn, { passive: true });
jumpBtn.onclick = () => { document.documentElement.style.scrollBehavior = "smooth"; scrollNow(); setTimeout(() => { document.documentElement.style.scrollBehavior = ""; updateJumpBtn(); }, 400); };

// 底栏/阅读栏几何自适应：
//   --footer-h  阅读区底部留白、「↓ 最新」按钮位置随底栏实际高度调整
//   --main-left/--main-w  底栏 composer 与阅读栏像素级对齐（阅读栏在扣除右侧
//   过程面板后的剩余区域居中，公式易错，直接实测阅读栏位置最可靠）
const footerEl = document.querySelector("footer");
const processEl = document.getElementById("process");
const mainEl = document.querySelector("main");
function syncLayoutVars() {
  const mr = mainEl.getBoundingClientRect();
  const cs = getComputedStyle(mainEl);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  document.documentElement.style.setProperty("--footer-h", footerEl.offsetHeight + "px");
  // composer 的 margin 相对 footer 内容盒（其左缘已含 footer 内边距），需把该内边距扣掉
  const fpad = parseFloat(getComputedStyle(footerEl).paddingLeft) || 0;
  document.documentElement.style.setProperty("--main-left", (mr.left + pl - fpad) + "px");
  document.documentElement.style.setProperty("--main-w", (mr.width - pl - pr) + "px");
}
// 内嵌浏览器可能节流 ResizeObserver，三重保险：RO + 渲染入口主动同步 + 低频轮询兜底
if (typeof ResizeObserver === "function") {
  const ro = new ResizeObserver(syncLayoutVars);
  ro.observe(footerEl);
  ro.observe(processEl);
  ro.observe(mainEl);
}
window.addEventListener("resize", syncLayoutVars);
setInterval(syncLayoutVars, 800);
syncLayoutVars();

// ---------- 键盘快捷键：数字选选项，/ 聚焦输入，Esc 关菜单 ----------
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (state.pendingChoices && /^[1-9]$/.test(e.key)) {
    const c = state.pendingChoices[Number(e.key) - 1];
    if (c) send(c.label + "——" + c.description);
  } else if (e.key === "/") {
    e.preventDefault();
    input.focus();
  } else if (e.key === "Escape") {
    menuEl.close();
  }
});

// ---------- 过程面板（x-proc-log） ----------
function renderProcess(ev) {
  if (ev.type === "agent_process") {
    setBusy(true);
    if (ev.kind === "tool") procLogEl.tool(ev.role, ev.text);
    else procLogEl.delta(ev.role, ev.text);
    return;
  }
  // 阶段切换/结论类事件会打断当前流式条目
  procLogEl.flushLive();
  setBusy(false);
  if (ev.type === "review") {
    procLogEl.note(ev.pass ? "【校对】通过 ✓" : "【校对】打回重写：" + ev.issues.map((i) => i.problem).join("；"));
  } else if (ev.type === "phase") {
    const names = { bootstrapping: "— 导播设计开始 —", playing: "— 场景循环 —", arc_boundary: "— 弧收束 —", ended: "— 完结 —" };
    if (names[ev.phase]) procLogEl.note(names[ev.phase]);
  }
}

// ---------- 右栏：大纲记录（默认 Tab）/ 过程日志 ----------
let activeTab = "outline";

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("outlineView").classList.toggle("active", tab === "outline");
  procLogEl.style.display = tab === "process" ? "" : "none";
  if (tab === "outline") refreshOutline();
}
document.querySelectorAll(".ptab").forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

// 本场大纲卡（引擎 scene_outline 事件推送；下一场推演后自动替换）
function renderSceneOutlineCard(view) {
  const sec = document.createElement("div");
  sec.className = "outline-sec";
  sec.id = "sceneOutlineSec";
  const h = document.createElement("div");
  h.className = "outline-h";
  h.textContent = "本场大纲" + (state.lastSceneOutline ? " · 第 " + state.lastSceneOutline.scene + " 场" : "");
  sec.appendChild(h);
  if (state.lastSceneOutline) {
    const md = document.createElement("x-markdown");
    md.className = "outline-scene";
    md.src = state.lastSceneOutline.text;
    sec.appendChild(md);
  } else {
    const empty = document.createElement("div");
    empty.className = "outline-meta";
    empty.textContent = "尚未推演";
    sec.appendChild(empty);
  }
  view.appendChild(sec);
}

// 旧版引擎写入的系统样板不进任何视图：弧 md 的「拍子不预排」引用气泡、总纲的英文 Premise 标题
function cleanOutlineMd(s) {
  return String(s || "")
    .replace(/^>[ \t]*拍子不预排[^\n]*\n?/m, "")
    .replace(/^(#{1,6})[ \t]*(?:Premise|故事 premise)[ \t]*$/m, "$1 故事梗概")
    .trim();
}

async function refreshOutline() {
  if (!TOKEN) return;
  const view = $("outlineView");
  // 本场大纲：本地事件状态，先渲染骨架再拉文件，避免面板闪空
  const [zong, arc] = await Promise.all([
    api("/api/file?path=" + encodeURIComponent("大纲/总纲.md") + "&token=" + encodeURIComponent(TOKEN)),
    api("/api/file?path=" + encodeURIComponent("大纲/弧-01.md") + "&token=" + encodeURIComponent(TOKEN)),
  ]).catch(() => [null, null]);
  if (activeTab !== "outline") return; // 期间切走了
  view.replaceChildren();
  const mk = (title, content) => {
    const sec = document.createElement("div");
    sec.className = "outline-sec";
    const h = document.createElement("div");
    h.className = "outline-h";
    h.textContent = title;
    sec.appendChild(h);
    if (content) {
      const md = document.createElement("x-markdown");
      md.src = content;
      sec.appendChild(md);
    } else {
      const empty = document.createElement("div");
      empty.className = "outline-meta";
      empty.textContent = "尚未生成";
      sec.appendChild(empty);
    }
    return sec;
  };
  view.appendChild(mk("总纲", zong && zong.ok !== false ? cleanOutlineMd(zong.content) : null));
  view.appendChild(mk("当前弧 · 第 " + (state.arcCount || 1) + " 弧", arc && arc.ok !== false ? cleanOutlineMd(arc.content) : null));
  renderSceneOutlineCard(view);
}

$("procToggle").onclick = () => $("process").classList.toggle("open");
$("procClose").onclick = () => $("process").classList.remove("open");

// ---------- API ----------
async function api(path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(path + sep + "session=" + encodeURIComponent(SESSION), {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { localStorage.removeItem("novel_token"); location.reload(); return; }
  return r.json();
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  input.value = "";
  await api("/api/input", { text });
}

$("send").onclick = () => send(input.value);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });

// ---------- 菜单 ----------
function menuItems() {
  const items = [];
  if (state.phase === "idea_chat") items.push(["开始构建开局", () => command("build")]);
  if (state.phase === "confirm_bible") items.push(["确认开局，开始故事", () => command("accept")]);
  if (state.phase === "playing" || state.phase === "confirm_bible") {
    items.push(["切换 自动/手动 模式", () => command("mode:" + (lastMode === "manual" ? "auto" : "manual"))]);
  }
  items.push(["存档", async () => { await command("save:slot" + Date.now() % 1000); toastsEl.show("已存档", "ok"); }]);
  items.push(["世界与存档…", () => $("worldsBtn").onclick()]);
  if (state.phase === "playing") {
    items.push(["调整大纲…", async () => {
      const feedback = await confirmEl.ask("想怎么调整当前弧的大纲？", { input: true });
      if (feedback) command("outline:" + feedback);
    }]);
  }
  items.push(["查看弧大纲", () => showFile("大纲/弧-01.md")]);
  items.push(["查看经济体系", () => showFile("设定/经济.md")]);
  items.push(["查看账本", () => showFile("记忆/账本.jsonl")]);
  items.push(["查看判定日志", () => showFile("记忆/判定日志.jsonl")]);
  items.push(["查看属性表", () => showFile("设定/属性.json")]);
  items.push(["查看世界观", () => showFile("设定/世界观.md")]);
  items.push(["查看伏笔台账", () => showFile("记忆/伏笔台账.json")]);
  items.push(["重新开始", async () => { if (await confirmEl.ask("放弃当前故事，重新开始？")) command("restart"); }]);
  return items.map(([label, fn]) => ({ label, fn }));
}

let lastMode = "manual";

function buildMenu() {
  menuEl.items = menuItems();
}
menuEl.anchor = $("menuBtn");
$("menuBtn").onclick = () => { buildMenu(); menuEl.toggle(); };

// ---------- 世界与存档 ----------
const worldsDlg = $("worldsDlg");
const worldListEl = $("worldList");
const saveTreeEl = $("saveTree");
let selectedWorld = SESSION;

const phaseNames = { empty: "待灵感", idea_chat: "灵感酝酿", bootstrapping: "设计中", confirm_bible: "待确认", playing: "进行中", arc_boundary: "弧收束中", ended: "已完结" };
function whenOf(t) { try { return dayjs(t).fromNow(); } catch (e) { return t || ""; } }

$("worldsBtn").onclick = openWorlds;
$("worldsClose").onclick = () => worldsDlg.close();
$("worldCreate").onclick = async () => {
  const id = await confirmEl.ask("新世界名（字母数字-_）", { input: true, value: "world-" + (Date.now() % 100000) });
  if (!id) return;
  const r = await fetch("/api/worlds", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify({ id }) }).then((x) => x.json());
  toastsEl.show(r && r.ok ? r.message : (r && r.message) || "创建失败", r && r.ok ? "ok" : "err");
  if (r && r.ok) { await refreshWorlds(); worldsDlg.close(); }
};
$("worldFork").onclick = async () => {
  const id = await confirmEl.ask("新分支名（字母数字-_）", { input: true, value: "fork-" + (Date.now() % 100000) });
  if (!id) return;
  const r = await command("fork:" + id);
  if (r && r.ok) {
    const u = new URL(location.href);
    u.searchParams.set("session", id);
    location.href = u.toString();
  } else {
    toastsEl.show(r && r.message ? r.message : "分叉失败", "err");
  }
};

async function openWorlds() {
  await refreshWorlds();
  worldsDlg.showModal();
}

async function refreshWorlds() {
  let worlds = [];
  try { worlds = await api("/api/worlds"); } catch (e) { /* 静默 */ }
  worldListEl.innerHTML = "";
  if (!Array.isArray(worlds) || worlds.length === 0) {
    worldListEl.innerHTML = '<div class="st-empty">（暂无世界）</div>';
    return;
  }
  for (const w of worlds) {
    const row = document.createElement("div");
    row.className = "world-row" + (w.id === SESSION ? " current" : "");
    row.dataset.wid = w.id;
    const info = document.createElement("div");
    info.className = "w-info";
    const title = document.createElement("div");
    title.className = "w-title";
    title.textContent = (w.title || "（未命名）") + " · " + w.id;
    const meta = document.createElement("div");
    meta.className = "w-meta";
    meta.textContent = (phaseNames[w.phase] || w.phase) + (w.sceneIndex ? " · 第" + w.sceneIndex + "场" : "") + (w.updatedAt ? " · " + whenOf(w.updatedAt) : "");
    info.appendChild(title);
    info.appendChild(meta);
    const enter = document.createElement("button");
    enter.className = "w-enter";
    enter.textContent = w.id === SESSION ? "当前" : "进入";
    if (w.id !== SESSION) enter.onclick = (e) => {
      e.stopPropagation();
      const u = new URL(location.href);
      u.searchParams.set("session", w.id);
      location.href = u.toString();
    };
    else enter.disabled = true;
    row.appendChild(info);
    row.appendChild(enter);
    row.onclick = () => { selectedWorld = w.id; markCurrent(); loadSaveTree(w.id); };
    worldListEl.appendChild(row);
  }
  if (!worldListEl.querySelector(".world-row.current")) selectedWorld = worlds[0].id;
  markCurrent();
  loadSaveTree(selectedWorld);
}

function markCurrent() {
  worldListEl.querySelectorAll(".world-row").forEach((el) => el.classList.remove("current"));
  for (const el of worldListEl.querySelectorAll(".world-row")) {
    if (el.dataset.wid === selectedWorld) el.classList.add("current");
  }
}

async function loadSaveTree(worldId) {
  saveTreeEl.innerHTML = '<div class="st-head">存 档 树 · ' + worldId + '</div>';
  let saves = [];
  try {
    saves = await fetch("/api/saves?session=" + encodeURIComponent(worldId), { headers: { authorization: "Bearer " + TOKEN } }).then((x) => x.json());
  } catch (e) { /* 静默 */ }
  if (!Array.isArray(saves)) saves = [];
  if (saves.length === 0) {
    saveTreeEl.insertAdjacentHTML("beforeend", '<div class="st-empty">（该世界还没有存档）</div>');
    return;
  }
  const byParent = new Map();
  const names = new Set(saves.map((s) => s.name));
  for (const s of saves) {
    const key = s.parent && names.has(s.parent) ? s.parent : "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(s);
  }
  const addNode = (s, depth, prefix) => {
    const div = document.createElement("div");
    div.className = "st-node" + (worldId === SESSION ? " loadable" : "");
    div.style.marginLeft = depth * 18 + "px";
    const label = document.createElement("span");
    label.textContent = (depth ? prefix : "● ") + s.name;
    const meta = document.createElement("span");
    meta.className = "st-meta";
    meta.textContent = (s.title ? s.title + " · " : "") + (phaseNames[s.phase] || s.phase) + (s.sceneIndex ? " · 第" + s.sceneIndex + "场" : "") + (s.updatedAt ? " · " + whenOf(s.updatedAt) : "");
    div.appendChild(label);
    div.appendChild(meta);
    if (worldId === SESSION) div.title = "点击读档「" + s.name + "」";
    if (worldId === SESSION) div.onclick = async () => {
      if (!(await confirmEl.ask("读档「" + s.name + "」？当前未存档进度将丢失。"))) return;
      await command("load:" + s.name);
      location.reload();
    };
    saveTreeEl.appendChild(div);
    const children = byParent.get(s.name) ?? [];
    children.forEach((c, i) => addNode(c, depth + 1, i === children.length - 1 ? "└─ " : "├─ "));
  };
  for (const root of byParent.get("") ?? []) addNode(root, 0, "● ");
}

// ---------- 设置 ----------
const settingsDlg = $("settingsDlg");
$("settingsBtn").onclick = async () => {
  const s = await api("/api/settings");
  if (!s || s.ok === false) { toastsEl.show((s && s.message) || "读取设置失败", "err"); return; }
  $("setMode").value = lastMode;
  $("setScenes").value = s.settings.scenesPerArc;
  $("setArcs").value = s.settings.maxArcs;
  $("setWeb").checked = !!s.settings.webSearch;
  $("setLan").textContent = location.origin + "/?token=" + s.token;
  $("setToken").textContent = s.token;
  settingsDlg.showModal();
};
$("setCancel").onclick = () => settingsDlg.close();
$("setSave").onclick = async () => {
  // 模式：与当前不同才发命令
  const wantMode = $("setMode").value;
  if (wantMode !== lastMode) await command("mode:" + wantMode);
  const r = await api("/api/settings", {
    scenesPerArc: Number($("setScenes").value),
    maxArcs: Number($("setArcs").value),
    webSearch: $("setWeb").checked,
  });
  if (r && r.ok === false) { toastsEl.show(r.message || "保存失败", "err"); return; }
  toastsEl.show("设置已保存", "ok");
  settingsDlg.close();
};

async function showFile(rel) {
  const r = await api("/api/file?path=" + encodeURIComponent(rel) + "&token=" + encodeURIComponent(TOKEN));
  if (!r || r.ok === false) { toastsEl.show((r && r.message) || "读取失败", "err"); return; }
  if (!r.content) { newBlock("note", "「" + rel + "」尚未生成"); return; }
  const card = mountBlock(document.createElement("x-markdown"));
  if (/\.jsonl?$/.test(rel)) card.code = r.content.split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.stringify(JSON.parse(l), null, 2); } catch (e) { return l; } }).join("\n\n");
  else card.src = /\.md$/.test(rel) ? cleanOutlineMd(r.content) : r.content;
}

// ---------- 启动：拉状态 + 建 SSE ----------
(async function init() {
  if (!(await ensureToken())) return;
  switchTab("outline"); // 右栏默认显示大纲
  try {
    const s = await api("/api/state");
    if (s && s.state) {
      state.phase = s.state.phase;
      state.arcCount = s.state.arcCount || 1;
      lastMode = s.state.mode || "manual";
      if (s.state.title) $("title").textContent = s.state.title;
    }
  } catch (e) { /* SSE 会补齐 */ }
  renderStatus();
  refreshOutline();

  // 挂机兜底：playing 期间每 20s 轻量刷新大纲（文件读取很便宜）
  setInterval(() => { if (activeTab === "outline" && state.phase === "playing") refreshOutline(); }, 20000);

  const es = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN) + "&session=" + encodeURIComponent(SESSION));
  es.onmessage = (m) => {
    try {
      const ev = JSON.parse(m.data);
      if (ev.type === "status" && /模式切换为 自动/.test(ev.text)) lastMode = "auto";
      if (ev.type === "status" && /模式切换为 手动/.test(ev.text)) lastMode = "manual";
      if (ev.type === "boot_ready") $("title").textContent = "《" + ev.title + "》";
      renderProcess(ev);
      renderEvent(ev);
    } catch (e) { /* 忽略坏帧 */ }
  };
  es.onerror = () => { statusEl.update({ phase: "连接中断", text: "重连中……", busy: false, err: true }); };
})();
