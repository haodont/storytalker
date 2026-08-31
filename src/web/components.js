// 组件封装：原生 Web Components（Custom Elements + Shadow DOM）。
// 零依赖、无构建；主题经 CSS 变量穿透 Shadow DOM，字体随文档继承。
// 全局可选依赖：marked / DOMPurify / hljs（x-markdown 检测后使用，缺失时降级为纯文本）。
"use strict";

(() => {
  const css = (s) => s[0].replace(/^\n/, "");

  // ---------------------------------------------------------------------------
  // <x-status> 状态徽章：圆点 + 文案；busy 呼吸闪烁，err 红点
  // ---------------------------------------------------------------------------
  class XStatus extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = css`
        <style>
          :host { display: inline-flex; }
          .pill {
            display: inline-flex; align-items: center; gap: 6px;
            font: 500 12px/1 var(--sans, system-ui, sans-serif); color: var(--dim, #7a7770);
            white-space: nowrap; background: var(--panel2, #232328);
            border: 1px solid var(--line, #2a2a30); border-radius: 999px; padding: 5px 10px;
          }
          .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim, #7a7770); flex-shrink: 0; }
          .pill.busy .dot { background: var(--accent, #d9a45b); animation: breathe 1.4s ease-in-out infinite; }
          .pill.err .dot { background: var(--err, #d98a7a); }
          .label { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; }
          @keyframes breathe { 50% { opacity: .25; } }
        </style>
        <span class="pill"><span class="dot"></span><span class="label">连接中……</span></span>`;
    }
    /** update({ phase, text, busy, err })：phase 为中文阶段名，text 为附加状态 */
    update({ phase, text, busy = false, err = false }) {
      const pill = this.shadowRoot.querySelector(".pill");
      pill.querySelector(".label").textContent = phase + (text ? " ｜ " + text : "");
      pill.classList.toggle("busy", busy);
      pill.classList.toggle("err", err);
    }
  }

  // ---------------------------------------------------------------------------
  // <x-toast-host> Toast 浮层：show(msg, cls, ms)
  // ---------------------------------------------------------------------------
  class XToastHost extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = css`
        <style>
          :host { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 30;
                  display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
          * { box-sizing: border-box; } /* 文档层的 box-sizing 穿不进 Shadow DOM */
          .toast {
            background: var(--panel2, #232328); border: 1px solid var(--line, #2a2a30); color: var(--ink, #d8d5cf);
            font: 14px/1.5 var(--sans, system-ui, sans-serif); border-radius: 10px; padding: 9px 16px;
            box-shadow: 0 8px 24px rgba(0,0,0,.5); animation: rise .18s ease-out; max-width: 80vw;
          }
          .toast.ok { border-color: color-mix(in srgb, var(--ok, #9ec49a) 50%, transparent); }
          .toast.err { border-color: color-mix(in srgb, var(--err, #d98a7a) 60%, transparent); }
          .toast.hide { opacity: 0; transition: opacity .25s; }
          @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
        </style>`;
    }
    show(msg, cls = "", ms = 2600) {
      const t = document.createElement("div");
      t.className = "toast " + cls;
      t.textContent = msg;
      this.shadowRoot.appendChild(t);
      setTimeout(() => { t.classList.add("hide"); setTimeout(() => t.remove(), 300); }, ms);
    }
  }

  // ---------------------------------------------------------------------------
  // <x-choices> 选项组：setChoices(list)；选中时抛 pick 事件（detail = 发送文本）
  // ---------------------------------------------------------------------------
  class XChoices extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = css`
        <style>
          :host { display: flex; flex-direction: column; gap: 8px; }
          button {
            display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; text-align: left;
            background: var(--bg, #141416); border: 1px solid var(--line, #2a2a30); color: var(--ink, #d8d5cf);
            border-radius: 10px; padding: 10px 14px; font: inherit; font-size: 15px; line-height: 1.5;
            cursor: pointer; transition: border-color .15s, transform .1s, background .15s;
          }
          button:hover { border-color: var(--accent, #d9a45b); background: var(--panel2, #232328); transform: translateY(-1px); }
          button:active { transform: none; }
          .num {
            flex-shrink: 0; font: 700 12px/1 var(--sans, system-ui, sans-serif); color: var(--accent, #d9a45b);
            border: 1px solid color-mix(in srgb, var(--accent, #d9a45b) 45%, transparent);
            border-radius: 6px; padding: 3px 7px;
          }
          .desc { color: var(--dim, #7a7770); font-size: 13.5px; }
          .prev {
            flex-basis: 100%; color: var(--dim, #7a7770); font-size: 12.5px; line-height: 1.6;
            border-left: 2px solid color-mix(in srgb, var(--accent, #d9a45b) 35%, transparent);
            padding-left: 8px; margin-top: 2px;
          }
        </style>`;
    }
    setChoices(list) {
      const root = this.shadowRoot;
      root.querySelectorAll("button").forEach((b) => b.remove());
      (list || []).forEach((c, i) => {
        const b = document.createElement("button");
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = String(i + 1);
        b.appendChild(num);
        b.appendChild(document.createTextNode(c.label));
        if (c.description) {
          const d = document.createElement("span");
          d.className = "desc";
          d.textContent = " —— " + c.description;
          b.appendChild(d);
        }
        if (c.preview) {
          const p = document.createElement("span");
          p.className = "prev";
          p.textContent = "▸ " + c.preview;
          b.appendChild(p);
        }
        b.onclick = () => this.dispatchEvent(new CustomEvent("pick", { detail: c }));
        root.appendChild(b);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // <x-menu> 下拉菜单：items = [{label, disabled?, fn?}]；open/close/toggle；点外部自动关
  // ---------------------------------------------------------------------------
  class XMenu extends HTMLElement {
    constructor() {
      super();
      this._items = [];
      this._outside = (e) => {
        if (!this.contains(e.target) && e.target !== this._anchor) this.close();
      };
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = css`
        <style>
          :host { position: absolute; right: 10px; top: 48px; z-index: 9; display: none; }
          :host(.open) { display: block; animation: rise .12s ease-out; }
          .panel {
            background: var(--panel, #1d1d21); border: 1px solid var(--line, #2a2a30); border-radius: 10px;
            padding: 6px; min-width: 170px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
          }
          button {
            display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--ink, #d8d5cf);
            padding: 9px 12px; font-size: 15px; border-radius: 6px; font-family: var(--sans, system-ui, sans-serif); cursor: pointer;
          }
          button:hover:not(:disabled), button:active:not(:disabled) { background: var(--line, #2a2a30); }
          button:disabled { color: var(--dim, #7a7770); cursor: default; }
          @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
        </style>
        <div class="panel"></div>`;
    }
    connectedCallback() { document.addEventListener("click", this._outside); }
    disconnectedCallback() { document.removeEventListener("click", this._outside); }
    set items(list) {
      this._items = list || [];
      const panel = this.shadowRoot.querySelector(".panel");
      panel.innerHTML = "";
      this._items.forEach((it) => {
        const b = document.createElement("button");
        b.textContent = it.label;
        b.disabled = !!it.disabled;
        if (it.fn) b.onclick = () => { this.close(); it.fn(); };
        panel.appendChild(b);
      });
    }
    set anchor(el) { this._anchor = el; }
    open() { this.classList.add("open"); }
    close() { this.classList.remove("open"); }
    toggle() { this.classList.toggle("open"); }
    get isOpen() { return this.classList.contains("open"); }
  }

  // ---------------------------------------------------------------------------
  // <x-confirm> 确认/输入对话框（内嵌浏览器无 confirm/prompt 的替代）：
  // ask(text, { input, value }) → Promise<true|false|string|null>
  // ---------------------------------------------------------------------------
  class XConfirm extends HTMLElement {
    constructor() {
      super();
      this._dialog = document.createElement("dialog");
      this._dialog.innerHTML = css`
        <style>
          /* 文档层的 * { box-sizing } 穿不进 Shadow DOM，组件内需自补 */
          dialog, dialog *, dialog *::before, dialog *::after { box-sizing: border-box; }
          dialog {
            background: var(--panel, #1d1d21); color: var(--ink, #d8d5cf); border: 1px solid var(--line, #2a2a30);
            border-radius: 14px; padding: clamp(16px, 2.4vw, 26px);
            width: clamp(300px, 88vw, 460px); max-width: 88vw; max-height: 72vh;
            font-family: var(--sans, system-ui, sans-serif); box-shadow: 0 16px 48px rgba(0,0,0,.6);
            display: flex; flex-direction: column; /* 超长文本时正文内滚动 */
          }
          dialog::backdrop { background: rgba(0,0,0,.55); }
          p { flex: 1; min-height: 0; overflow-y: auto; font-size: clamp(14px, 10px + 0.4vw, 16px); line-height: 1.7; margin: 0 0 16px; }
          input {
            display: none; width: 100%; margin-bottom: 16px; background: var(--bg, #141416);
            border: 1px solid var(--line, #2a2a30); color: var(--ink, #d8d5cf); border-radius: 8px;
            padding: 9px 12px; font-size: 15px; font-family: var(--sans, system-ui, sans-serif); outline: none;
          }
          .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
          button {
            border-radius: 8px; padding: 8px 16px; font-size: 14px; cursor: pointer;
            font-family: var(--sans, system-ui, sans-serif); background: none;
            border: 1px solid var(--line, #2a2a30); color: var(--dim, #7a7770);
          }
          button.danger { background: var(--err, #d98a7a); border-color: var(--err, #d98a7a); color: #20100c; font-weight: 700; }
        </style>
        <p></p><input autocomplete="off">
        <div class="row"><button class="cancel">取消</button><button class="ok danger">确定</button></div>`;
      const shadow = this.attachShadow({ mode: "open" });
      shadow.appendChild(this._dialog);
    }
    ask(text, opts = {}) {
      return new Promise((resolve) => {
        const dlg = this._dialog;
        const inp = dlg.querySelector("input");
        dlg.querySelector("p").textContent = text;
        inp.style.display = opts.input ? "" : "none";
        inp.value = opts.value || "";
        const done = (v) => { dlg.close(); resolve(v); };
        dlg.querySelector(".ok").onclick = () => done(opts.input ? inp.value.trim() : true);
        dlg.querySelector(".cancel").onclick = () => done(opts.input ? null : false);
        dlg.oncancel = () => resolve(opts.input ? null : false);
        dlg.showModal();
        if (opts.input) inp.focus();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // <x-proc-log> 过程面板日志：delta/tool/note/flushLive；自动滚动、上限裁剪
  // ---------------------------------------------------------------------------
  const ROLE_NAMES = { director: "导播", writer: "执笔", reviewer: "校对" };
  class XProcLog extends HTMLElement {
    constructor() {
      super();
      this._live = {}; // role -> 当前流式条目
      this._count = 0;
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = css`
        <style>
          :host { display: block; }
          .log { padding: 10px 14px 20px; font: 13px/1.7 var(--sans, system-ui, sans-serif); }
          .entry { margin-bottom: .9em; }
          /* 角色徽章：小圆角胶囊，按角色着色 */
          .role {
            display: inline-block; font: 700 10.5px/1 var(--sans, system-ui, sans-serif);
            letter-spacing: 1.5px; padding: 3px 8px; border-radius: 999px; margin-bottom: 4px;
          }
          .director .role { color: var(--accent, #d9a45b); background: color-mix(in srgb, var(--accent, #d9a45b) 14%, transparent); }
          .writer .role { color: var(--ok, #9ec49a); background: color-mix(in srgb, var(--ok, #9ec49a) 14%, transparent); }
          .reviewer .role { color: #8fb4d9; background: rgba(143, 180, 217, .14); }
          .body { color: var(--dim, #7a7770); white-space: pre-wrap; word-break: break-all; }
          .tool .body { color: #6f6c66; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
          .live .body::after { content: "▌"; color: var(--accent, #d9a45b); animation: blink 1s step-start infinite; }
          .sys { color: color-mix(in srgb, var(--dim, #7a7770) 72%, transparent); font-size: 12px; margin: .6em 0 .8em; }
          .sys::before { content: "· "; }
          @keyframes blink { 50% { opacity: 0; } }
        </style>
        <div class="log"></div>`;
    }
    _scroll() {
      const log = this.shadowRoot.querySelector(".log");
      log.scrollTop = log.scrollHeight;
    }
    _trim() {
      const log = this.shadowRoot.querySelector(".log");
      while (this._count > 300 && log.firstChild) { log.removeChild(log.firstChild); this._count--; }
    }
    _entry(role, cls) {
      const div = document.createElement("div");
      div.className = "entry " + (cls || "") + " " + role;
      div.innerHTML = '<span class="role">' + (ROLE_NAMES[role] || role) + "</span><span class='body'></span>";
      this.shadowRoot.querySelector(".log").appendChild(div);
      this._count++;
      this._trim();
      return div;
    }
    /** 流式追加：接到该角色当前条目，无则新开（带光标） */
    delta(role, text) {
      let div = this._live[role];
      if (!div) {
        div = this._entry(role, "live");
        this._live[role] = div;
      }
      div.querySelector(".body").textContent += text;
      this._scroll();
    }
    /** 工具调用：单行等宽展示，结束该角色当前流式条目 */
    tool(role, text) {
      this.flushLive(role);
      this._entry(role, "tool").querySelector(".body").textContent = "🔧 " + text;
      this._scroll();
    }
    /** 系统提示行 */
    note(text) {
      const div = document.createElement("div");
      div.className = "sys";
      div.textContent = text;
      this.shadowRoot.querySelector(".log").appendChild(div);
      this._count++;
      this._trim();
      this._scroll();
    }
    /** 结束流式条目（省略 role 则全部），阶段切换/结论类事件时调用 */
    flushLive(role) {
      const end = (k) => { this._live[k].classList.remove("live"); delete this._live[k]; };
      if (role) { if (this._live[role]) end(role); }
      else { for (const k of Object.keys(this._live)) end(k); }
    }
  }

  // ---------------------------------------------------------------------------
  // <x-markdown> Markdown 卡片（轻 DOM，复用全局 .md 排版）：
  //   .src = markdown 原文（marked + DOMPurify + hljs）；.code = 代码块文本；.loading 加载态
  // ---------------------------------------------------------------------------
  class XMarkdown extends HTMLElement {
    connectedCallback() {
      if (!this.classList.contains("card")) this.classList.add("card", "md");
    }
    set loading(v) { if (v) this.textContent = "（加载中…）"; }
    set code(raw) {
      this.textContent = "";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-json";
      code.textContent = raw;
      pre.appendChild(code);
      this.appendChild(pre);
      this._highlight();
    }
    set src(md) {
      if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
        // breaks: 单个换行也渲染成 <br>——模型偶尔忘写空行时段落不至于被吞成一块
        this.innerHTML = DOMPurify.sanitize(marked.parse(String(md), { breaks: true, gfm: true }));
      } else {
        this.textContent = String(md); // 组件库缺失时降级
      }
      this._highlight();
    }
    _highlight() {
      if (typeof hljs !== "object") return;
      this.querySelectorAll("pre code").forEach((el) => {
        try { hljs.highlightElement(el); } catch (e) { /* 未知语言等忽略 */ }
      });
    }
  }

  customElements.define("x-status", XStatus);
  customElements.define("x-toast-host", XToastHost);
  customElements.define("x-choices", XChoices);
  customElements.define("x-menu", XMenu);
  customElements.define("x-confirm", XConfirm);
  customElements.define("x-proc-log", XProcLog);
  customElements.define("x-markdown", XMarkdown);
})();
