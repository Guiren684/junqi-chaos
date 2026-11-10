// lan.js — 局域网开黑（客户端）
//
// 角色只有两种：
//   房主（第一个加入的人，固定南家）：自己跑引擎，每一步把权威局面推给服务端
//   其他人（东/北/西）：只发操作意图，收到局面就整盘替换
//
// 为什么不各跑各的引擎：抽卡、掷等级、AI、里程碑发牌都有随机性，
// 四份状态一定会分叉；只有房主算一次、大家照着看才不会"我这边显示你死了"。
//
// 依赖 ui.js 暴露的 window.__junqi（load / lanStart / lanApply / state）
"use strict";
(function (global) {
  const SEATS = ["south", "east", "north", "west"];
  const SEAT_CN = { south: "南", east: "东", north: "北", west: "西" };

  const API = {
    base: "",
    pid: null,
    seat: null,
    isHost: false,
    joined: false,
    es: null,
    lobby: { players: [], started: false },
    lastSent: "",
  };
  let pushTimer = null;
  let panelEl = null;
  let statusEl = null;
  let listEl = null;
  let startBtn = null;

  // ---------------- 序列化：state 里有 Set（暗牌的 domain），JSON 会丢 ----------------
  function stringify(st) {
    return JSON.stringify(st, (k, v) => {
      if (v instanceof Set) return { __set: Array.from(v) };
      if (v instanceof Map) return { __map: Array.from(v.entries()) };
      return v;
    });
  }
  function revive(json) {
    const obj = typeof json === "string" ? JSON.parse(json) : json;
    const walk = (v) => {
      if (!v || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(walk);
      if (v.__set) return new Set(v.__set);
      if (v.__map) return new Map(v.__map);
      for (const k of Object.keys(v)) v[k] = walk(v[k]);
      return v;
    };
    return walk(obj);
  }

  function base() {
    if (API.base) return API.base;
    try {
      const saved = localStorage.getItem("junqi.lan.base");
      if (saved) { API.base = saved; return saved; }
    } catch (e) { /* 隐私模式 */ }
    // 页面本身就是 lan_server 发出来的 → 同源即可
    if (location.protocol === "http:" || location.protocol === "https:") {
      API.base = location.origin;
    } else {
      API.base = "";
    }
    return API.base;
  }

  function post(path, body) {
    return fetch(base() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message || e) }));
  }

  // ---------------- 面板 ----------------
  function ensurePanel() {
    if (panelEl) return panelEl;
    const style = document.createElement("style");
    style.textContent = `
      #lanBtn { border-color:#2d6a4f; }
      #lanPanel { position: fixed; z-index: 60; left: 50%; top: 90px; transform: translateX(-50%);
        width: 420px; max-width: calc(100vw - 32px); background: #0d1a26; color: #dfe9f4;
        border: 1px solid #26445c; border-radius: 12px; box-shadow: 0 18px 50px rgba(0,0,0,.55);
        font-size: 13px; padding: 16px 18px 14px; }
      #lanPanel.hidden { display: none; }
      #lanPanel h3 { margin: 0 0 4px; font-size: 15px; color: #ffd08a; }
      #lanPanel .sub { color: #8fa6bb; font-size: 12px; line-height: 1.5; margin-bottom: 10px; }
      #lanPanel .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
      #lanPanel input[type=text] { flex: 1; min-width: 0; background: #08131d; color: #dfe9f4;
        border: 1px solid #26445c; border-radius: 7px; padding: 6px 8px; font-size: 13px; }
      #lanPanel button { background: #16354a; color: #dfe9f4; border: 1px solid #2b5a78;
        border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
      #lanPanel button:hover { background: #1d4762; }
      #lanPanel button:disabled { opacity: .45; cursor: default; }
      #lanPanel button.primary { background: #21603f; border-color: #2f8a58; }
      #lanPanel .players { margin: 10px 0 4px; border-top: 1px solid #1d3143; padding-top: 8px; }
      #lanPanel .pl { display: flex; justify-content: space-between; padding: 3px 0; }
      #lanPanel .pl .seat { color: #7fd1a5; }
      #lanPanel .pl .me { color: #ffd08a; }
      #lanPanel .pl .host { color: #ffb454; font-size: 11px; margin-left: 6px; }
      #lanPanel .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 8px; }
      #lanPanel .status { color: #9fb6cc; font-size: 12px; }
      #lanBanner { position: fixed; z-index: 59; left: 50%; bottom: 18px; transform: translateX(-50%);
        background: #1b2a38; color: #ffd08a; border: 1px solid #3a5a72; border-radius: 9px;
        padding: 7px 14px; font-size: 13px; }
      #lanBanner.hidden { display: none; }
    `;
    document.head.appendChild(style);

    panelEl = document.createElement("div");
    panelEl.id = "lanPanel";
    panelEl.className = "hidden";
    panelEl.innerHTML = `
      <h3>局域网开黑</h3>
      <div class="sub">房主先创建，其他人打开同一地址加入。人不够的座位由 AI 补上。</div>
      <div class="row">
        <input type="text" id="lanName" maxlength="12" placeholder="你的名字">
        <button id="lanJoin" class="primary">创建 / 加入</button>
      </div>
      <div class="row" id="lanAddrRow">
        <input type="text" id="lanAddr" placeholder="服务端地址，例如 192.168.1.5:8080">
        <button id="lanAddrSave">用这个地址</button>
      </div>
      <div class="players" id="lanPlayers"></div>
      <div class="foot">
        <span class="status" id="lanStatus">未加入</span>
        <span>
          <button id="lanStart2" class="primary" disabled>开始对局</button>
          <button id="lanClose">关闭</button>
        </span>
      </div>
    `;
    document.body.appendChild(panelEl);

    const banner = document.createElement("div");
    banner.id = "lanBanner";
    banner.className = "hidden";
    document.body.appendChild(banner);

    statusEl = panelEl.querySelector("#lanStatus");
    listEl = panelEl.querySelector("#lanPlayers");
    startBtn = panelEl.querySelector("#lanStart2");

    panelEl.querySelector("#lanClose").onclick = () => panelEl.classList.add("hidden");
    panelEl.querySelector("#lanJoin").onclick = () => {
      const name = (panelEl.querySelector("#lanName").value || "").trim() || "玩家";
      if (!base()) {
        setStatus("先填服务端地址（房主屏幕上的 http://192.168.x.x:8080）");
        panelEl.querySelector("#lanAddr").focus();
        return;
      }
      join(name);
    };
    panelEl.querySelector("#lanAddrSave").onclick = () => {
      const v = (panelEl.querySelector("#lanAddr").value || "").trim();
      if (!v) return;
      API.base = /^https?:\/\//.test(v) ? v : "http://" + v;
      try { localStorage.setItem("junqi.lan.base", API.base); } catch (e) { /* */ }
      setStatus("地址已设为 " + API.base);
    };
    startBtn.onclick = () => hostStart();
    return panelEl;
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }
  function setBanner(text) {
    const b = document.getElementById("lanBanner");
    if (!b) return;
    if (!text) { b.classList.add("hidden"); return; }
    b.textContent = text;
    b.classList.remove("hidden");
  }

  function renderLobby() {
    if (!listEl) return;
    const ps = API.lobby.players || [];
    listEl.innerHTML = ps.length
      ? ps.map((p) => `<div class="pl"><span class="seat">${
        SEAT_CN[p.seat] || p.seat
      }家</span><span class="${p.pid === API.pid ? "me" : ""}">${p.name}${
        p.isHost ? '<span class="host">房主</span>' : ""
      }</span></div>`).join("")
      : '<div class="pl"><span class="seat">—</span><span>还没有人加入</span></div>';
    if (API.joined) {
      setStatus("我是" + (SEAT_CN[API.seat] || API.seat) + "家"
        + (API.isHost ? "（房主）" : "")
        + "　在线 " + ps.length + " 人");
    }
    if (startBtn) startBtn.disabled = !(API.joined && API.isHost) || ps.length < 1;
  }

  // ---------------- 加入 / 事件流 ----------------
  function savedPid() {
    try { return localStorage.getItem("junqi.lan.pid") || ""; } catch (e) { return ""; }
  }
  function savePid(pid) {
    try { localStorage.setItem("junqi.lan.pid", pid || ""); } catch (e) { /* */ }
  }

  function join(name, silent) {
    post("/api/join", { name, pid: API.pid || savedPid() }).then((r) => {
      if (!r || !r.ok) {
        if (!silent) setStatus("加入失败：" + ((r && r.error) || "服务端没开？"));
        return;
      }
      API.pid = r.pid;
      API.seat = r.seat;
      API.isHost = !!r.isHost;
      API.joined = true;
      savePid(r.pid);
      if (r.players) { API.lobby.players = r.players; API.lobby.started = !!r.started; }
      renderLobby();
      openStream();
      // 刷新页面回到房间时，服务端会把当前局面一起发回来，直接接着打
      if (r.latest) loadSnapshot(r.latest);
    });
  }

  // 页面一打开就悄悄回房（刷新不掉座位）；服务端没开就什么都不做
  function autoRejoin() {
    if (API.joined) return;              // 已经连上了就别再开一条流（会多出一条旧连接）
    if (!base() || !savedPid()) return;
    let name = "玩家";
    try { name = localStorage.getItem("junqi.lan.name") || "玩家"; } catch (e) { /* */ }
    join(name, true);
  }

  function openStream() {
    if (API.es) { try { API.es.close(); } catch (e) { /* */ } }
    const es = new EventSource(base() + "/api/events?pid=" + encodeURIComponent(API.pid));
    API.es = es;
    es.addEventListener("lobby", (ev) => {
      try { API.lobby = JSON.parse(ev.data); } catch (e) { return; }
      renderLobby();
    });
    es.addEventListener("start", (ev) => {
      const d = JSON.parse(ev.data);
      loadSnapshot(d.state);
      setBanner("");
      ensurePanel().classList.add("hidden");
    });
    es.addEventListener("snapshot", (ev) => {
      if (API.isHost) return;                 // 房主自己就是权威，不用吃回自己推的
      const d = JSON.parse(ev.data);
      loadSnapshot(d.state);
      setBanner("");                          // 房主回来了，别再挂着"掉线"提示
    });
    es.addEventListener("action", (ev) => {
      if (!API.isHost) return;
      const d = JSON.parse(ev.data);
      const api = global.__junqi;
      if (!api || !api.lanApply) return;
      try { api.lanApply(d.kind, d.payload, d.seat); } catch (e) { console.warn("[LAN] 远端操作失败", e); }
    });
    es.addEventListener("hostgone", () => {
      setBanner("房主掉线了，正在等他回来（他刷新一下页面就能接着打）。");
    });
    es.addEventListener("reset", () => {
      setBanner("房主重开了房间");
      ensurePanel().classList.remove("hidden");
    });
    es.onerror = () => { setBanner("和服务端断开，正在重连…"); };
    es.onopen = () => { setBanner(""); };
  }

  function loadSnapshot(json) {
    const api = global.__junqi;
    if (!api || !json) return;
    const st = revive(json);
    if (!API.isHost) st.human = API.seat;      // 客户端用自己的视角渲染
    if (typeof api.load === "function") api.load(st);
    if (API.isHost === false && st.phase === "playing") {
      setBanner(st.turn === API.seat ? "轮到你了" : "");
    }
  }

  // ---------------- 房主：开局 + 推送 ----------------
  function hostStart() {
    const api = global.__junqi;
    if (!api || !api.lanStart) { setStatus("页面版本太旧，缺少 lanStart"); return Promise.resolve(false); }
    // 开局前先从服务端拉一次最新名单：本地缓存的 lobby 可能是"别人刚进来"之前那一份，
    // 那样会把真人座位当成 AI —— 房主就会替他取牌、替他走棋（踩过）。
    return fetch(base() + "/api/lobby")
      .then((r) => r.json())
      .then((lobby) => {
        API.lobby = lobby;
        renderLobby();
        const humans = (lobby.players || []).map((p) => p.seat).filter(Boolean);
        if (!humans.length) humans.push("south");
        api.lanStart(humans);
        const json = stringify(api.state);
        API.lastSent = json;
        post("/api/push", { pid: API.pid, type: "start", state: json });
        ensurePanel().classList.add("hidden");
        setBanner("");
        return true;
      })
      .catch(() => { setStatus("开局失败：拿不到房间名单"); return false; });
  }

  // 房主每次 render 之后调；去抖 + 内容不变就不推
  function maybePush() {
    if (!API.joined || !API.isHost) return;
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const api = global.__junqi;
      if (!api || !api.state) return;
      let json = "";
      try { json = stringify(api.state); } catch (e) { return; }
      if (json === API.lastSent) return;
      API.lastSent = json;
      post("/api/push", { pid: API.pid, type: "snapshot", state: json });
    }, 220);
  }

  function sendAction(kind, payload) {
    if (!API.joined || API.isHost) return false;
    post("/api/action", { pid: API.pid, kind, payload: payload || {} });
    return true;
  }

  // ---------------- 对外 ----------------
  const LAN = {
    // ui.js 用：局域网里"人类"座位完全由房间决定
    seats() {
      if (!API.joined) return null;
      if (API.isHost) {
        const hs = (API.lobby.players || []).map((p) => p.seat).filter(Boolean);
        return hs.length ? hs : null;
      }
      return API.seat ? [API.seat] : null;
    },
    isClient() { return API.joined && !API.isHost; },
    isHost() { return API.joined && API.isHost; },
    maybePush,
    sendAction,
    // 调试/测试用
    get info() {
      return { pid: API.pid, seat: API.seat, isHost: API.isHost, joined: API.joined,
        base: base(), players: API.lobby.players };
    },
    join,
    start: hostStart,
    open() { ensurePanel().classList.remove("hidden"); },
    close() { ensurePanel().classList.add("hidden"); },
  };
  global.JunqiLAN = LAN;

  // ---------------- 挂按钮 ----------------
  function boot() {
    const anchor = document.getElementById("btnStart");
    if (!anchor || document.getElementById("lanBtn")) return;
    const btn = document.createElement("button");
    btn.id = "lanBtn";
    btn.textContent = "局域网";
    btn.title = "局域网开黑（需要先运行 node lan_server.js）";
    btn.onclick = () => {
      ensurePanel();
      const nameEl = panelEl.querySelector("#lanName");
      if (nameEl && !nameEl.value) {
        try { nameEl.value = localStorage.getItem("junqi.lan.name") || ""; } catch (e) { /* */ }
      }
      const addrEl = panelEl.querySelector("#lanAddr");
      if (addrEl) addrEl.value = base() || "";
      panelEl.classList.remove("hidden");
      renderLobby();
    };
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    const nameEl = document.getElementById("lanName");
    if (nameEl) {
      nameEl.addEventListener("change", () => {
        try { localStorage.setItem("junqi.lan.name", nameEl.value); } catch (e) { /* */ }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); autoRejoin(); });
  } else {
    boot();
    autoRejoin();
  }
})(typeof window !== "undefined" ? window : globalThis);
