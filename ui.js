(function () {
  "use strict";
  const G = window.JunqiGame;
  const B = window.JunqiBoard;
  const LAYOUT = window.QQ_LAYOUT || {};
  const SVG_NS = "http://www.w3.org/2000/svg";
  const HUMAN = "south";

  const svg = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const playersEl = document.getElementById("players");
  const logEl = document.getElementById("log");
  const stepInfo = document.getElementById("stepInfo");
  const turnInfo = document.getElementById("turnInfo");
  const btnNew = document.getElementById("btnNew");
  const btnCheat = document.getElementById("btnCheat");
  const btnAuto = document.getElementById("btnAuto");
  const btnStart = document.getElementById("btnStart");
  const btnSound = document.getElementById("btnSound");
  const btnSave = document.getElementById("btnSave");
  const btnLoad = document.getElementById("btnLoad");
  const btnReplay = document.getElementById("btnReplay");
  const replayBar = document.getElementById("replayBar");
  const replayInfo = document.getElementById("replayInfo");
  const btnReplayPrev = document.getElementById("btnReplayPrev");
  const btnReplayNext = document.getElementById("btnReplayNext");
  const btnReplayExit = document.getElementById("btnReplayExit");
  const btnSaveReplay = document.getElementById("btnSaveReplay");
  const btnReplayAll = document.getElementById("btnReplayAll");
  const btnLoadReplay = document.getElementById("btnLoadReplay");
  const modeSelect = document.getElementById("modeSelect");
  const chkDuel = document.getElementById("chkDuel");   // 双人对局：南（人）vs 北（AI）
  const viewSelect = document.getElementById("viewSelect");
  const setupSeatSel = document.getElementById("setupSeatSel");
  const btnResult = document.getElementById("btnResult");
  const seatAiRows = document.getElementById("seatAiRows");
  const resultModal = document.getElementById("resultModal");
  const resultTitle = document.getElementById("resultTitle");
  const resultTip = document.getElementById("resultTip");
  const resultGrid = document.getElementById("resultGrid");
  const resultTeam = document.getElementById("resultTeam");
  const resultClose = document.getElementById("resultClose");

  // 沙盘（自定义局面 → 四家对弈）
  const sandboxEl = document.getElementById("sandbox");
  const sandboxSeatsEl = document.getElementById("sandboxSeats");
  const sandboxPoolEl = document.getElementById("sandboxPool");
  const sandboxHintEl = document.getElementById("sandboxHint");
  const btnSandbox = document.getElementById("btnSandbox");
  const btnSandboxFill = document.getElementById("btnSandboxFill");
  const btnSandboxClear = document.getElementById("btnSandboxClear");
  const btnSandboxStart = document.getElementById("btnSandboxStart");
  const btnSandboxExit = document.getElementById("btnSandboxExit");
  const btnTakeover = document.getElementById("btnTakeover");

  const aiStyle = document.getElementById("aiStyle");
  const boardMode = document.getElementById("boardMode");
  const doubleFlagWrap = document.getElementById("doubleFlagWrap");
  const chkDoubleFlag = document.getElementById("chkDoubleFlag");
  const latentWrap = document.getElementById("latentWrap");
  const chkLatentSeats = Array.from(document.querySelectorAll(".chk-latent"));
  const chkAiSouth = document.getElementById("chkAiSouth");
  const markMenu = document.getElementById("markMenu");
  const replayModal = document.getElementById("replayModal");
  const replayList = document.getElementById("replayList");
  const replayFile = document.getElementById("replayFile");
  const replayImport = document.getElementById("replayImport");
  const replayModalClose = document.getElementById("replayModalClose");
  const btnFormation = document.getElementById("btnFormation");
  const formationModal = document.getElementById("formationModal");
  const formationList = document.getElementById("formationList");
  const formationSave = document.getElementById("formationSave");
  const formationClose = document.getElementById("formationClose");
  const domains = document.getElementById("domains");
  const adviceBox = document.getElementById("adviceBox");
  const advTip = document.getElementById("advTip");
  const zeroLevelSel = document.getElementById("zeroLevel");
  const chkAdvice = document.getElementById("chkAdvice");
  const battleStats = document.getElementById("battleStats");

  const cheatModal = document.getElementById("cheatModal");
  const cheatList = document.getElementById("cheatList");
  const cheatTotal = document.getElementById("cheatTotal");
  const cheatCancel = document.getElementById("cheatCancel");
  const cheatConfirm = document.getElementById("cheatConfirm");

  let state = null;
  let selected = null;
  let legal = [];
  let hoverPos = null;
  let aiTimer = null;
  let replayMode = false;
  let replayLive = null;
  let replayFrames = [];
  let replayIndex = 0;
  let replayFaceMap = new Map();
  let replayHiddenIds = new Set();
  let replayView = "south";
  let autoSaveKey = null;          // 本局是否已经自动存过复盘
  // 信息模式：normal=只看自己 / double=你控南北、南北互明 / full=四家全明
  let viewMode = "normal";
  // 用户在下拉里自己选的那一档。双座模式只是「本局临时强制双明」，
  // 不许把这份偏好改掉——否则关掉外援之后会一直卡在双明，天命暗牌也跟着灰掉。
  let viewModePref = "normal";
  function normalizeViewMode(v) {
    return v === "double" || v === "full" ? v : "normal";
  }
  // 布阵阶段当前正在布置的座位（双明模式下可切南/北）
  let setupSeat = HUMAN;
  // 每局结束自动弹一次战果
  let resultShown = false;
  let autoSouth = false;                 // 南方也交给 AI
  // 外援座位：这些座位由本地桥后面的 agent 来下
  //   单座：?agent=north             （它执北，你执南，四暗）
  //   双座：?agent=east,west         （它执东西，你执南北，双明）
  //   关掉：?agent=off               也会记住，下次开页面照旧
  function parseAgentMode(value) {
    const s = String(value || "").trim().toLowerCase();
    if (!s || s === "off" || s === "0" || s === "no" || s === "none") return [];
    if (s === "ew" || s === "eastwest" || s === "east+west") return ["east", "west"];
    const seats = s.split(/[,+\s]+/).filter((x) => B.SEATS.includes(x));
    return seats.length ? seats : [];
  }
  let agentSeats = (() => {
    try {
      const q = new URLSearchParams(location.search).get("agent");
      const stored = localStorage.getItem("junqi.agentMode") || "";
      const seats = parseAgentMode(q !== null ? q : stored);
      if (q !== null) {
        if (seats.length) localStorage.setItem("junqi.agentMode", seats.join(","));
        else localStorage.removeItem("junqi.agentMode");
      }
      return seats;
    } catch (err) { return []; }
  })();
  let agentThinking = false;             // 外援正在想这一手
  let agentSince = 0;                    // 开始想的时间戳
  const agentLayoutApplied = Object.create(null);   // seat -> 是否已经按外援给的阵铺过
  function agentBridgeUrl() {
    try { return new URLSearchParams(location.search).get("bridge") || undefined; } catch (err) { return undefined; }
  }
  function persistAgentMode(seats) {
    try {
      if (seats && seats.length) localStorage.setItem("junqi.agentMode", seats.join(","));
      else localStorage.removeItem("junqi.agentMode");
    } catch (err) { /* file:// 下可能不让写，无所谓 */ }
  }
  const pieceMarks = new Map();          // piece.id -> 军衔名 或 "?"
  const REPLAY_LIB_KEY = "junqi.replayLib.v1";
  const REPLAY_LIB_MAX = 50;        // 原来是 3，太小；localStorage 有配额，超了会提示
  const VIEW_ANGLE = { south: 0, east: 90, north: 180, west: 270 };
  const SAVE_KEY = "junqiSaveV1";
  const REPLAY_KEY = "junqiReplaySaveV1";
  const FORM_KEY = "junqi.formationLib.v1";
  let hlLayer = null;
  let pieceLayer = null;
  let arrowLayer = null;

  // ---------- 音效（QQ 四国军棋 res） ----------
  const SOUND_FILES = {
    move: "sounds/move.wav",
    attack: "sounds/eat.wav",
    die: "sounds/killed.wav",
    equal: "sounds/bomb.wav",
    flag: "sounds/showflag.wav",
    dead: "sounds/dead.wav",
    start: "sounds/start.wav",
    select: "sounds/Select.wav",
  };
  const audioCache = {};
  let soundOn = true;
  try { soundOn = localStorage.getItem("junqiSound") !== "0"; } catch (e) { /* file:// */ }
  function playSound(name) {
    if (!soundOn || !name || !SOUND_FILES[name]) return;
    try {
      let a = audioCache[name];
      if (!a) { a = new Audio(SOUND_FILES[name]); audioCache[name] = a; }
      a.currentTime = 0;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }
  function updateSoundLabel() {
    btnSound.textContent = soundOn ? "🔊 音效开" : "🔇 音效关";
  }
  btnSound.addEventListener("click", () => {
    soundOn = !soundOn;
    try { localStorage.setItem("junqiSound", soundOn ? "1" : "0"); } catch (e) { /* ignore */ }
    updateSoundLabel();
    if (soundOn) playSound("select");
  });
  updateSoundLabel();

  function playReplaySound(frame) {
    if (!frame) return;
    if (frame.lastSound) playSound(frame.lastSound);
    if (frame.flagRevealSound) setTimeout(() => playSound("flag"), 140);
  }

  function playResultSound(res) {
    if (res && res.sound) playSound(res.sound);
    if (state && state.flagRevealSound) {
      state.flagRevealSound = false;
      setTimeout(() => playSound("flag"), 160);
    }
  }

  // ---------- SVG 基础 ----------
  function make(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }
  function rect(x, y, w, h, rx, fill, stroke, sw, dash) {
    const r = make("rect", {
      x, y, width: Math.max(0.1, w), height: Math.max(0.1, h), rx: rx || 0,
      fill: fill || "none",
      stroke: stroke || "none",
      "stroke-width": sw || 0,
    });
    if (dash) r.setAttribute("stroke-dasharray", dash);
    return r;
  }
  function tileBox(L) {
    const center = !!L.center;
    const vertical = !center && L.h > L.w;
    return {
      center, vertical,
      w: center ? 50 : vertical ? 31 : 50,
      h: center ? 31 : vertical ? 50 : 31,
    };
  }

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = 1 + amount;
    r = Math.max(0, Math.min(255, Math.round(r * f)));
    g = Math.max(0, Math.min(255, Math.round(g * f)));
    b = Math.max(0, Math.min(255, Math.round(b * f)));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function buildStatic() {
    svg.innerHTML = "";
    const defs = make("defs", {});
    for (const [id, color] of [["arrowGold", "#ffd166"], ["arrowWhite", "#ffffff"], ["arrowGreen", "#7cff6b"], ["arrowCyan", "#6ee7ff"], ["arrowViolet", "#c084fc"]]) {
      const marker = make("marker", {
        id, viewBox: "0 0 6 6", markerWidth: "4.5", markerHeight: "4.5",
        refX: "5", refY: "3", orient: "auto", markerUnits: "strokeWidth",
      });
      marker.appendChild(make("path", { d: "M0,0 L6,3 L0,6 Z", fill: color }));
      defs.appendChild(marker);
    }
    svg.appendChild(defs);

    hlLayer = make("g", { id: "hl" });
    pieceLayer = make("g", { id: "pieces" });
    arrowLayer = make("g", { id: "arrows", "pointer-events": "none" });
    const hitLayer = make("g", { id: "hits" });
    svg.append(hlLayer, pieceLayer, arrowLayer, hitLayer);

    for (const node of B.BOARD.nodes) {
      const L = LAYOUT[node.id];
      if (!L) continue;
      const box = tileBox(L);
      const x = L.cx - box.w / 2;
      const y = L.cy - box.h / 2;
      const hl = rect(x, y, box.w, box.h, 5, "transparent", "none", 0);
      hl.setAttribute("class", "hl");
      hl.setAttribute("data-pos", node.id);
      hlLayer.appendChild(hl);

      const hit = rect(x, y, box.w, box.h, 5, "transparent", "none", 0);
      hit.setAttribute("class", "hit");
      hit.setAttribute("data-pos", node.id);
      hit.setAttribute("pointer-events", "all");
      hitLayer.appendChild(hit);
    }
  }

  const AI_PROFILE_LABELS = { wind: "风", forest: "林", fire: "火", mountain: "山", dyn: "自适应", bc: "二代", zero: "零代" };

  // ---------- 每家 AI 风格 ----------
  const SEAT_STYLE_KEY = "junqi.seatStyle.v1";
  const AI_ALL = ["wind", "forest", "fire", "mountain"];
  // 顶部「AI 随机」的抽取池：一代四风格 + 一代自适应 + 二代克隆 + 零代
  // 「dyn」= 一代 · 自适应：开局林试探，之后按兵力账在 火/山/风 之间切换（见 training/REPORT_STYLE.md）。
  // 它比固定风格强（实测 A/B 56.3% vs 43.8%），所以进默认池。
  const AI_POOL = ["wind", "forest", "fire", "mountain", "dyn", "bc", "zero"];
  const AI_STYLE_OPTIONS = [
    ["auto", "跟随默认"],
    ["agent", "外援（DeepSeek 代下）"],
    ["mixed", "混合（随机 风/林/火/山）"],
    ["bc", "二代 · 克隆（更像人，偏保守）"],
    ["zero", "零代 · 2007《四国争霸》逆向（概率+相克，三档等级）"],
    ["wind", "一代 · 风（善攻）"],
    ["forest", "一代 · 林（均衡）"],
    ["dyn", "一代 · 自适应（林试探 → 火扩大 / 山守 / 风打开）"],
    ["fire", "一代 · 火（最凶）"],
    ["mountain", "一代 · 山（重守）"],
  ];

  const ZERO_LEVEL_LABEL = { basic: "初级", mid: "中级", high: "高级" };
  let zeroLevel = "high";          // 零代等级（初级/中级/高级），下面读本机设置

  function loadSeatStyles() {
    const out = { north: "auto", east: "auto", south: "auto", west: "auto" };
    try {
      const raw = localStorage.getItem(SEAT_STYLE_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o) for (const seat of B.SEATS) if (AI_STYLE_OPTIONS.some((x) => x[0] === o[seat])) out[seat] = o[seat];
    } catch (err) { /* ignore */ }
    return out;
  }
  let seatStyles = loadSeatStyles();
  function saveSeatStyles() {
    try { localStorage.setItem(SEAT_STYLE_KEY, JSON.stringify(seatStyles)); } catch (err) { /* ignore */ }
  }

  function assignAIProfiles(state) {
    const style = aiStyle ? aiStyle.value : "mixed";
    const seats = B.SEATS.filter((s) => !isHumanSeat(s) || (autoSouth && s === HUMAN));
    const offset = Math.floor(Math.random() * AI_POOL.length);
    const profiles = {};
    seats.forEach((seat, i) => {
      const o = seatStyles[seat] || "auto";
      let pick = o === "auto" ? style : o;
      if (pick === "random") pick = AI_POOL[(offset + i) % AI_POOL.length];
      else if (pick === "mixed") pick = AI_ALL[(offset + i) % AI_ALL.length];
      profiles[seat] = pick;
    });
    state.aiStyle = style;
    state.aiProfiles = profiles;
  }

  // 对局中改设置：立刻改写未出局 AI 座位的 profile，下一步生效
  function refreshSeatProfiles() {
    if (!state || !state.aiProfiles) return;
    const style = state.aiStyle || "mixed";
    for (const seat of B.SEATS) {
      if (isHumanSeat(seat)) continue;
      if (autoSouth && seat === HUMAN) continue;
      const o = seatStyles[seat] || "auto";
      if (o === "auto") {
        if (style === "random" || style === "mixed") {
          if (!state.aiProfiles[seat]) state.aiProfiles[seat] = AI_POOL[Math.floor(Math.random() * AI_POOL.length)];
        } else state.aiProfiles[seat] = style;
      } else if (o === "mixed") {
        state.aiProfiles[seat] = AI_ALL[Math.floor(Math.random() * AI_ALL.length)];
      } else {
        state.aiProfiles[seat] = o;
      }
    }
  }

  // 侧栏常驻的四家 AI 选择。结构只在「人控座位变化」时重建，其余帧只同步值，
  // 否则每帧重建 select 会打断用户操作。
  let seatAiKey = "";
  const seatAiSels = {};
  // 把某一家的角色改成「AI 风格」或「外援」。座位面板和调试接口都走这里。
  function setSeatRole(seat, value) {
    if (!B.SEATS.includes(seat)) return;
    if (value === "agent") {
      if (!agentSeats.includes(seat)) agentSeats.push(seat);
    } else {
      agentSeats = agentSeats.filter((s) => s !== seat);
      seatStyles[seat] = value || "auto";
      saveSeatStyles();
    }
    persistAgentMode(agentSeats);
    if (!agentSeats.length && window.JunqiAgent) window.JunqiAgent.disable();
    newGame();                      // 人控/AI/外援 的归属变了，重开一局最干净
    if (agentSeats.length) initAgent();
    updatePanel();
  }

  function renderSeatAi() {
    if (!seatAiRows) return;
    const key = viewMode + "|" + (autoSouth ? 1 : 0) + "|" + agentSeats.join(",") + "|" + zeroLevel;
    if (key === seatAiKey) {
      for (const seat of B.SEATS) {
        const sel = seatAiSels[seat];
        if (!sel) continue;
        const want = isAgentSeat(seat) ? "agent" : (seatStyles[seat] || "auto");
        if (sel.value !== want) sel.value = want;
      }
      return;
    }
    seatAiKey = key;
    seatAiRows.innerHTML = "";
    for (const seat of B.SEATS) {
      const row = document.createElement("div");
      row.className = "seat-ai-row";
      const nm = document.createElement("div");
      nm.className = "sn";
      nm.textContent = B.SEAT_NAMES[seat].slice(0, 1);
      nm.style.color = B.SEAT_COLORS[seat];
      row.appendChild(nm);
      if (isHumanSeat(seat) && !(autoSouth && seat === HUMAN)) {
        const you = document.createElement("div");
        you.className = "you";
        you.textContent = "你（人控）";
        row.appendChild(you);
        seatAiSels[seat] = null;
      } else {
        const sel = document.createElement("select");
        for (const [v, label] of AI_STYLE_OPTIONS) {
          const op = document.createElement("option");
          op.value = v;
          op.textContent = v === "zero" ? `${label} · ${ZERO_LEVEL_LABEL[zeroLevel] || "高级"}` : label;
          sel.appendChild(op);
        }
        sel.value = isAgentSeat(seat) ? "agent" : (seatStyles[seat] || "auto");
        sel.addEventListener("change", () => {
          setSeatRole(seat, sel.value);
        });
        seatAiSels[seat] = sel;
        row.appendChild(sel);
      }
      seatAiRows.appendChild(row);
    }
  }

  // ---------- 战果面板 ----------
  const SCORE_NAME = { commander: "司令", army: "军长", division: "师长", brigade: "旅长", regiment: "团长", battalion: "营长", company: "连长", platoon: "排长", engineer: "工兵", mine: "地雷", bomb: "炸弹", flag: "军旗" };

  function killDetailText(obj) {
    const arr = Object.entries(obj || {});
    if (!arr.length) return "—";
    arr.sort((a, b) => (B.PIECE_INFO[b[0]] ? B.PIECE_INFO[b[0]].rank : 0) - (B.PIECE_INFO[a[0]] ? B.PIECE_INFO[a[0]].rank : 0));
    return arr.map(([t, n]) => `${SCORE_NAME[t] || t}×${n}`).join(" ");
  }

  function seatOutcome(seat) {
    if (!state || state.phase !== "over") return { cls: "", text: "进行中" };
    if (!state.winner) return { cls: "draw", text: "和棋" };
    return B.teamOf(seat) === state.winner
      ? { cls: "win", text: "胜" }
      : { cls: "lose", text: "负" };
  }

  function renderResult() {
    if (!resultGrid || !state) return;
    const st = state.stats || {};
    if (resultTitle) {
      resultTitle.textContent = state.phase === "over" ? "对局战果" : "当前战果";
    }
    if (resultTip) {
      const t = state.phase === "over"
        ? (state.winner ? `${state.winner === "A" ? "南 + 北" : "东 + 西"} 获胜` : "和棋")
          + ` · 共 ${state.moveCount} 步`
        : `对局进行中 · 已走 ${state.moveCount} 步（数字实时更新）`;
      resultTip.textContent = t;
    }
    resultGrid.innerHTML = "";
    for (const seat of ["south", "east", "north", "west"]) {
      const x = st[seat] || {};
      const out = seatOutcome(seat);
      const died = x.survived === false;
      const net = (x.killScore || 0) - (x.lossScore || 0);
      const card = document.createElement("div");
      card.className = "result-card" + (out.cls === "win" ? " win" : "") + (died ? " out" : "");
      const who = isHumanSeat(seat) ? "你" : (state.aiProfiles && state.aiProfiles[seat]
        ? (AI_PROFILE_LABELS[state.aiProfiles[seat]] || state.aiProfiles[seat]) : "");
      card.innerHTML = `
        <div class="rc-head">
          <span class="rc-seat">${B.SEAT_NAMES[seat].slice(0, 1)}方 ${who ? `<span style="color:#7f8fa6;font-weight:400">${who}</span>` : ""}</span>
          <span class="rc-tag ${out.cls}">${out.text}${died ? " · 出局" : ""}</span>
        </div>
        <div class="rc-line"><span>击杀</span><b>${x.killScore || 0} 分 <span style="color:#7f8fa6">${x.killPieces || 0} 子</span></b></div>
        <div class="rc-line"><span>损失</span><b>${x.lossScore || 0} 分 <span style="color:#7f8fa6">${x.lossPieces || 0} 子</span></b></div>
        <div class="rc-line"><span>净战果</span><b class="${net >= 0 ? "pos" : "neg"}">${net >= 0 ? "+" : ""}${net}</b></div>
        <div class="rc-line"><span>扛旗 / 被扛</span><b>${x.flagsTaken || 0} / ${x.flagLost || 0}</b></div>
        <div class="rc-line"><span>走子</span><b>${x.moves || 0}</b></div>
        <div class="rc-note">吃：${killDetailText(x.kills)}</div>`;
      resultGrid.appendChild(card);
    }
    // 金手指（作弊发牌）下额外给一块「AI 自己的账」：
    // 战果卡片用的是真实兵种，这块用的是 AI 在四暗里能拿到的信息（位置 + 身份域），
    // 所以两边的数字必然不完全一样——那正是「估」和「记」的区别。
    if (state.cheat && window.JunqiAI && window.JunqiAI.forceReport) {
      const box = document.createElement("div");
      box.className = "result-card force-card";
      const rows = ["south", "east", "north", "west"].map((seat) => {
        let txt = "—";
        try {
          const rep = window.JunqiAI.forceReport(state, seat);
          txt = rep.一句话;
        } catch (err) { txt = "（算不出来）"; }
        return `<div class="rc-line" style="align-items:flex-start"><span>${B.SEAT_NAMES[seat].slice(0, 1)}方</span>
          <b style="font-weight:400;text-align:right;max-width:72%">${txt}</b></div>`;
      }).join("");
      box.innerHTML = `<div class="rc-head"><span class="rc-seat">AI 视角（估）</span>
        <span class="rc-tag" style="color:#7f8fa6">金手指</span></div>${rows}
        <div class="rc-note">这块是 AI 自己算的：敌方还剩几个是精确的，值多少是按身份域估的。</div>`;
      resultGrid.appendChild(box);
    }
    // 战术卡使用清单（只有开过 DLC 的对局才有记录，没有就整块不出现）
    const cardLog = state.cardLog || [];
    if (cardLog.length) {
      const box = document.createElement("div");
      box.className = "result-card card-log-card";
      const rows = ["south", "east", "north", "west"].map((seat) => {
        const list = cardLog.filter((c) => c.seat === seat);
        if (!list.length) {
          return `<div class="rc-line"><span>${B.SEAT_NAMES[seat].slice(0, 1)}方</span>`
            + `<b style="font-weight:400;color:#64748b">未用牌</b></div>`;
        }
        // 同名同级的合并成「炸药包Ⅱ ×2」，按打出先后排
        const agg = new Map();
        for (const c of list) {
          const k = c.cardId + "|" + (c.tier || 1);
          const cur = agg.get(k);
          if (cur) cur.n += 1;
          else agg.set(k, { name: c.name, tier: c.tier || 1, n: 1, dev: !!c.dev });
        }
        const txt = [...agg.values()].map((x) => x.name + "ⅠⅡⅢ"[(x.tier || 1) - 1]
          + (x.n > 1 ? " ×" + x.n : "") + (x.dev ? "(DEV)" : "")).join("、");
        return `<div class="rc-line" style="align-items:flex-start"><span>${B.SEAT_NAMES[seat].slice(0, 1)}方</span>`
          + `<b style="font-weight:400;text-align:right;max-width:76%">${txt}</b></div>`;
      }).join("");
      const n = cardLog.length;
      box.innerHTML = `<div class="rc-head"><span class="rc-seat">战术卡</span>`
        + `<span class="rc-tag">全场 ${n} 次</span></div>${rows}`
        + `<div class="rc-note">只记已打出的卡，不含手里没用的；每张的等级就是打出时的等级。</div>`;
      resultGrid.appendChild(box);
    }

    if (resultTeam) {
      const sum = (seats, key) => seats.reduce((a, s2) => a + ((st[s2] && st[s2][key]) || 0), 0);
      const a = ["south", "north"];
      const b = ["east", "west"];
      const line = (name, seats) => {
        const ks = sum(seats, "killScore");
        const kp = sum(seats, "killPieces");
        const ls = sum(seats, "lossScore");
        const lp = sum(seats, "lossPieces");
        const net = ks - ls;
        return `<div>${name}：击杀 ${ks} 分 / ${kp} 子 · 损失 ${ls} 分 / ${lp} 子 · 净 <b style="color:${net >= 0 ? "#8ddc9b" : "#e79b9b"}">${net >= 0 ? "+" : ""}${net}</b></div>`;
      };
      resultTeam.innerHTML = line("A 队（南 + 北）", a) + line("B 队（东 + 西）", b);
    }
  }

  function showResult() {
    if (!state) return;
    renderResult();
    autoSaveReplay();
    if (resultModal) resultModal.classList.remove("hidden");
  }
  function closeResult() {
    if (resultModal) resultModal.classList.add("hidden");
  }

  function playerName(seat) {
    if (isHumanSeat(seat)) {
      return viewMode === "double" ? `你（${B.SEAT_NAMES[seat]}）` : "你";
    }
    if (isAgentSeat(seat)) return `队友·外援（${B.SEAT_NAMES[seat].slice(0, 1)}）`;
    const p = state && state.aiProfiles ? state.aiProfiles[seat] : null;
    return p ? `${B.SEAT_NAMES[seat]}·${AI_PROFILE_LABELS[p] || p}` : B.SEAT_NAMES[seat];
  }
  function roleLabel(seat) {
    if (isHumanSeat(seat)) {
      if (autoSouth && seat === HUMAN) return "AI 代下";
      return viewMode === "double" ? "你控" : "你";
    }
    if (isAgentSeat(seat)) return (window.JunqiAgent && window.JunqiAgent.online) ? "外援·在线" : "外援·离线";
    return B.teamOf(seat) === B.teamOf(HUMAN) ? "盟友" : "敌方";
  }

  // ---------- 人控座位 / 外援座位 / 南方托管 / 分座位暗牌 / 敌方标记 ----------
  // 双明模式：一个人同时操纵南、北两家（同队）
  // 外援座位由「每家 AI 种类」里把某家选成「外援」决定；被外援拿走的那家就不再是人控
  // 双人对局（南 vs 北）：只有两家，人控南、北一律交给本地 AI。
  // 必须用独立标志硬判，不能靠 viewMode/agentSeats 推 —— 那两个是模块级状态，
  // 用户上次开过「外援=北」或双明，就会残留下来；残留的后果是北被当成外援，
  // 一直等桥交子，表面上就是「双人模式北方不走棋」。
  let duelMode = false;
  // 封印开关：改这里一处即可放行（UI 入口的 hidden 也要一起去掉）。
  // 测试可以经 window.__junqi.setDuelSeal(false) 临时放行，跑 tools/duel_smoke.js。
  let duelSeal = true;
  function duelSealed() { return duelSeal; }
  function inPlay(seat) {
    return !state || !state.seats || state.seats.indexOf(seat) >= 0;
  }
  function humanSeats() {
    if (duelMode) return [HUMAN];
    const base = (viewMode === "double" || agentSeats.length >= 2) ? [HUMAN, "north"] : [HUMAN];
    return base.filter((s) => !agentSeats.includes(s));
  }
  function isHumanSeat(seat) {
    if (sandboxMatch) return false;          // 沙盘局四家都交给 AI
    if (!inPlay(seat)) return false;
    return humanSeats().includes(seat);
  }
  function isAgentSeat(seat) {
    if (duelMode) return false;              // 双人：北是本地 AI，不是外援
    return agentSeats.includes(seat);
  }
  function syncViewFromState(st) {
    const mode = st && st.infoMode === "all" ? "full"
      : (st && st.infoMode === "team" ? "double" : "normal");
    viewMode = mode;
    if (!(agentSeats.length >= 2)) viewModePref = mode;
    if (viewSelect) viewSelect.value = mode;
    setupSeat = HUMAN;
  }
  function isHumanTurn() {
    if (autoSouth || !state || state.phase !== "playing") return false;
    return isHumanSeat(state.turn);
  }

  function readLatentSeats() {
    const out = { north: false, east: false, south: false, west: false };
    for (const el of chkLatentSeats) if (el.checked) out[el.value] = true;
    return out;
  }

  const MARK_TYPES = [
    ["commander", "司令"], ["army", "军长"], ["division", "师长"], ["brigade", "旅长"],
    ["regiment", "团长"], ["battalion", "营长"], ["company", "连长"], ["platoon", "排长"],
    ["engineer", "工兵"], ["mine", "地雷"], ["bomb", "炸弹"], ["flag", "军旗"],
  ];
  const MARK_CHAR = {
    commander: "司", army: "军", division: "师", brigade: "旅", regiment: "团",
    battalion: "营", company: "连", platoon: "排", engineer: "工", mine: "雷", bomb: "炸", flag: "旗",
  };

  function markStyle(mk) {
    if (mk === "!") return { ch: "!", bg: "#8e44ad" };      // 已知不是工兵
    if (mk === "?") return { ch: "?", bg: "#566573" };
    if (mk === "mine" || mk === "bomb" || mk === "flag") return { ch: MARK_CHAR[mk], bg: "#7d3c98" };
    const info = B.PIECE_INFO[mk];
    const r = info ? info.rank : 0;
    if (r >= 7) return { ch: MARK_CHAR[mk], bg: "#c0392b" };
    if (r >= 4) return { ch: MARK_CHAR[mk], bg: "#d68910" };
    return { ch: MARK_CHAR[mk], bg: "#2e86c1" };
  }

  // 开局给敌方第一排打「!」：工兵一般留在后排挖雷，一线的子大概率不是工兵。
  // 这是一条概率提示，不是确定信息——可以直接在菜单里改成别的军衔或 ?。
  function hideMarkMenu() {
    if (markMenu) markMenu.classList.add("hidden");
  }

  function setMark(pieceId, key) {
    if (key) pieceMarks.set(pieceId, key);
    else pieceMarks.delete(pieceId);
    hideMarkMenu();
    playSound("select");
    render();
  }

  function showMarkMenu(piece, x, y) {
    if (!markMenu) return;
    markMenu.innerHTML = "";
    const head = document.createElement("div");
    head.className = "mm-head";
    head.textContent = "标记这枚暗子";
    markMenu.appendChild(head);
    const addBtn = (label, cls, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener("click", onClick);
      markMenu.appendChild(b);
    };
    for (const [key, label] of MARK_TYPES) addBtn(label, "", () => setMark(piece.id, key));
    addBtn("不确定 ?", "", () => setMark(piece.id, "?"));
    addBtn("清除标记", "mm-clear", () => setMark(piece.id, null));
    markMenu.classList.remove("hidden");
    const box = markMenu.getBoundingClientRect();
    markMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + "px";
    markMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + "px";
  }

  // ---------- 棋子（QQ 实色方块牌） ----------
  function pieceEl(piece) {
    const L = LAYOUT[piece.position];
    if (!L) return null;
    const replayHidden = replayMode && replayHiddenIds.has(piece.id);
    // 沙盘/接管编辑期间亮真牌：摆子时必须看得见摆的是什么，否则只能靠记忆下盲棋
    const visible = replayMode ? !replayHidden : (sandboxMode ? true : G.visibleTo(state, HUMAN, piece));
    const shownType = replayMode ? (piece.replayType || piece.actualType || piece.type) : piece.type;
    const color = B.SEAT_COLORS[piece.owner];
    const box = tileBox(L);
    const vertical = box.vertical;
    const w = box.w;
    const h = box.h;
    const classes = ["qp"];
    if (!visible) classes.push("qp-hidden");
    if (selected === piece.position) classes.push("qp-selected");
    const g = make("g", { class: classes.join(" "), "data-pos": piece.position });
    g.setAttribute("transform", `translate(${L.cx},${L.cy})`);

    g.appendChild(rect(-w / 2 + 1.5, -h / 2 + 2.5, w, h, 5, "rgba(0,0,0,.30)", "none", 0));

    if (visible) {
      g.appendChild(rect(-w / 2, -h / 2, w, h, 5, color, shade(color, -0.42), 2));
      g.appendChild(rect(-w / 2 + 2, -h / 2 + 2, w - 4, (h - 4) / 2, 3, "rgba(255,255,255,.14)", "none", 0));
      g.appendChild(rect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5, 3, "none", "rgba(255,255,255,.22)", 1));
      const t = make("text", {
        x: 0, y: 1, class: "qp-text",
        "text-anchor": "middle", "dominant-baseline": "central",
        "font-size": 14,
        fill: shownType === "flag" ? "#fff2b8" : "#ffffff",
        stroke: "rgba(0,0,0,.20)", "stroke-width": 0.4, "paint-order": "stroke",
      });
      const viewAngle = replayMode ? (VIEW_ANGLE[replayView] || 0) : 0;
      const textRotate = viewAngle ? -viewAngle : (vertical ? 90 : 0);
      if (textRotate) t.setAttribute("transform", `rotate(${textRotate})`);
      t.textContent = B.PIECE_INFO[shownType].name;
      g.appendChild(t);
    } else {
      g.appendChild(rect(-w / 2, -h / 2, w, h, 5, shade(color, -0.08), shade(color, -0.5), 2));
      // 棋背保持干净：不再画「!」。暗子只靠颜色/虚线框区分，需要提示就右键自己标。
      g.appendChild(rect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3, "rgba(0,0,0,.16)", "rgba(255,255,255,.38)", 1, "4 3"));
    }

    // 敌方（不可见）棋子的手工标记：军衔单字徽章 或 "?"
    if (!visible && !replayMode) {
      const mk = pieceMarks.get(piece.id);
      if (mk) {
        const badge = markStyle(mk);
        const bx = w / 2 - 6.5;
        const by = -h / 2 + 1;
        g.appendChild(make("circle", { cx: bx, cy: by, r: 6.5, fill: badge.bg,
          stroke: "#0b1220", "stroke-width": 1 }));
        const bt = make("text", { x: bx, y: by + 0.5, "text-anchor": "middle",
          "dominant-baseline": "central", "font-size": 9, fill: "#fff", "font-weight": "700" });
        bt.textContent = badge.ch;
        g.appendChild(bt);
      }
    }

    if (selected === piece.position) {
      g.appendChild(rect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, 7, "none", "#ffd166", 2));
    }
    return g;
  }

  function currentRaiseTargets() {
    if (state.phase !== "raise" || !state.pendingRaise) return [];
    const seat = state.pendingRaise.seat;
    return B.hqCells(seat).filter((id) => !state.hqCaptured[seat].has(id));
  }

  function drawArrow(from, to, color, width, markerId, opacity) {
    const a = LAYOUT[from];
    const b = LAYOUT[to];
    if (!a || !b || from === to) return;
    const line = make("line", {
      x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy,
      stroke: color, "stroke-width": width, "stroke-linecap": "round",
      opacity, "pointer-events": "none",
    });
    if (markerId) line.setAttribute("marker-end", `url(#${markerId})`);
    arrowLayer.appendChild(line);
  }

  function renderArrows() {
    if (!arrowLayer) return;
    arrowLayer.innerHTML = "";
    if (!state) return;
    if (state.lastMove) {
      drawArrow(state.lastMove.from, state.lastMove.to, "#061018", 7, null, 0.35);
      drawArrow(state.lastMove.from, state.lastMove.to, "#ffffff", 2.6, "arrowWhite", 0.95);
    }
    if (selected && hoverPos && legal.includes(hoverPos)) {
      drawArrow(selected, hoverPos, "#7cff6b", 3.6, "arrowGreen", 0.98);
    }
    // 三引擎参谋的推荐走法：零代金 / 一代青 / 二代紫。只在轮到你、且没在手动选子时画。
    // 三家指向同一格时箭头会重叠——所以宽度递减、透明度略错开，看得出叠了几支。
    if (adv3 && isHumanTurn() && !replayMode) {
      const layer = [
        [adv3.gen0 && adv3.gen0.best, "#ffd166", "arrowGold", 3.2, 0.95],
        [adv3.gen1 && adv3.gen1.best, "#6ee7ff", "arrowCyan", 2.2, 0.85],
        [adv3.gen2 && adv3.gen2.best, "#c084fc", "arrowViolet", 1.5, 0.75],
      ];
      for (const [b, color, marker, w, op] of layer) {
        if (!b || !b.from || !b.to) continue;
        if (selected === b.from && hoverPos === b.to) continue;
        drawArrow(b.from, b.to, color, w, marker, op);
      }
    }
  }

  // 四角阵亡清单 + 令子候选。
  //
  // 两个曾经致命的细节：
  // ① 面板必须**常驻**。上一版「0 阵亡就 remove("show")」，开局四角空白，
  //    看起来就像功能没开 —— 而令子候选又只在已显示的角上追加，于是整块一起隐形。
  // ② 不能只认 p.revealed。战斗里**不公开对方身份**（game.js 只给军旗置 revealed，
  //    只有工兵探路会给守方置 revealedTo），所以按 revealed 过滤，绝大多数阵亡都显示不出来。
  //    这里按「你有权知道什么」来分：
  //      自家阵亡      → 兵种确知（你派谁去你自己清楚；天命暗牌下打完也会亮真值）
  //      同队/明牌模式  → 确知
  //      对手暗子阵亡  → 不知道兵种，只记个数（显示 ?n）——这本身就是公开信息
  const FALLEN_CH = {
    flag: "旗", mine: "雷", bomb: "炸", commander: "司", army: "军",
    division: "师", brigade: "旅", regiment: "团", battalion: "营",
    company: "连", platoon: "排", engineer: "工",
  };
  const FALLEN_ORDER = ["commander", "army", "division", "brigade", "regiment",
    "battalion", "company", "platoon", "engineer", "bomb", "mine", "flag"];
  const FALLEN_BIG = { commander: 1, army: 1, division: 1 };
  const SEAT_CN = { north: "北", east: "东", south: "南", west: "西" };

  const myTeam = B.teamOf ? B.teamOf(HUMAN) : "A";
  function revealsToMe(seat) {
    if (seat === HUMAN) return true;
    if (!state) return false;
    if (state.infoMode === "all") return true;
    if (state.infoMode === "team" && B.teamOf && B.teamOf(seat) === myTeam) return true;
    return false;
  }
  // 已阵亡棋子的兵种：不知道就返回 null（显示成 ?）
  function knownDeadType(p) {
    if (!p.type) return null;
    if (p.actualType && p.actualType !== p.type) return p.actualType;
    if (p.latent) return null;                       // 还没打过，type 只是占位下界
    if (revealsToMe(p.owner)) return p.type;
    if (p.revealed) return p.type;                   // 军旗
    if (p.revealedTo && p.revealedTo === myTeam) return p.type;   // 工兵探路亮给本队
    return null;
  }

  // 敌方令子候选（集合级定位，实测 44.6%，随机基线 7.8%）
  let domCache = { state: null, key: "", val: [] };
  const DOM_SHOW = 2;                      // 每家显示前 2 个候选
  function domKeyOf(st) {
    return (st.moveTape ? st.moveTape.length : 0) + "|" + (st.battles ? st.battles.length : 0);
  }
  function dominantsMap() {
    const out = {};
    const I = window.JunqiAI && window.JunqiAI._internals;
    if (!I || !I.dominantCandidates) return out;
    if (!state || state.phase === "over" || (state.out && state.out[HUMAN])) return out;
    const key = domKeyOf(state);
    if (domCache.state !== state || domCache.key !== key) {
      let val = [];
      try { val = I.dominantCandidates(state, HUMAN, DOM_SHOW) || []; } catch (err) { val = []; }
      domCache = { state: state, key: key, val: val };
    }
    for (const group of domCache.val) {
      const spots = group.top
        .filter((x) => x.p > 0.08)
        .map((x) => {
          const m = /-(\d+)-(\d+)$/.exec(x.position || "");
          return m ? `${m[1]},${m[2]}` : "?";
        });
      if (spots.length) out[group.owner] = `⚑${spots.join(" ")}`;
    }
    return out;
  }

  function renderFallen() {
    if (!state) return;
    const doms = dominantsMap();
    for (const seat of B.SEATS) {
      const el = document.querySelector(`.fallen[data-seat="${seat}"]`);
      if (!el) continue;
      const cnt = {};
      let unknown = 0;
      let alive = 0;
      for (const p of state.pieces) {
        if (p.owner !== seat) continue;
        if (p.position) { alive += 1; continue; }
        const t = knownDeadType(p);
        if (!t) { unknown += 1; continue; }
        cnt[t] = (cnt[t] || 0) + 1;
      }
      const parts = [];
      for (const t of FALLEN_ORDER) {
        const c = cnt[t];
        if (!c) continue;
        const cls = FALLEN_BIG[t] ? "big" : (t === "bomb" ? "bomb" : (t === "mine" ? "mine" : ""));
        parts.push(`<span class="${cls}">${FALLEN_CH[t]}${c > 1 ? c : ""}</span>`);
      }
      if (unknown) parts.push(`<span class="unk">?${unknown > 1 ? unknown : ""}</span>`);
      const body = parts.length ? parts.join("") : `<span class="unk">—</span>`;
      const dom = doms[seat] ? `<span class="dom">${doms[seat]}</span>` : "";
      el.innerHTML = `<b>${SEAT_CN[seat] || seat}</b>${body}${dom}`;
      el.classList.add("show");
      if (alive === 0) el.classList.add("dead");
      else el.classList.remove("dead");
    }
  }

  function render() {
    if (!state) return;
    renderFallen();
    try { renderDLC(); } catch (e) { /* DLC 出错不影响棋盘渲染 */ }
    try { devRender(); } catch (e) { /* DEV 出错不影响棋盘渲染 */ }
    const targets = new Set(state.phase === "raise" ? currentRaiseTargets() : legal);
    for (const hl of hlLayer.children) {
      const pos = hl.getAttribute("data-pos");
      const isTarget = targets.has(pos);
      const isSelected = pos === selected;
      const isLast = !!state.lastMove && (state.lastMove.from === pos || state.lastMove.to === pos);
      const node = B.BOARD.byId.get(pos);
      const isCaptured = node && node.seat && node.kind === "hq"
        && state.hqCaptured[node.seat] && state.hqCaptured[node.seat].has(pos);

      let fill = "transparent", stroke = "none", sw = 0, dash = "";
      if (isTarget) { fill = "rgba(46,204,113,.32)"; stroke = "#2ecc71"; sw = 2; }
      else if (isSelected) { fill = "rgba(255,209,102,.28)"; stroke = "#ffd166"; sw = 2; }
      else if (isCaptured) { stroke = "#e74c3c"; sw = 2; dash = "6 4"; }
      else if (isLast) { stroke = "rgba(255,255,255,.60)"; sw = 1.5; dash = "5 4"; }
      hl.setAttribute("fill", fill);
      hl.setAttribute("stroke", stroke);
      hl.setAttribute("stroke-width", String(sw));
      if (dash) hl.setAttribute("stroke-dasharray", dash); else hl.removeAttribute("stroke-dasharray");
    }

    pieceLayer.innerHTML = "";
    for (const piece of state.pieces) {
      if (!piece.position) continue;
      const el = pieceEl(piece);
      if (el) pieceLayer.appendChild(el);
    }
    renderArrows();
    updatePanel();
    // 实时监听：每走一手把局面推给桥，外援那边不用等到自己回合也能看直播
    if (!replayMode && window.JunqiAgent && window.JunqiAgent.enabled) {
      window.JunqiAgent.watch(state);
    }
  }

  function computeBattleStats(state) {
    const byId = new Map(state.pieces.map((p) => [p.id, p]));
    const seats = {};
    for (const seat of B.SEATS) seats[seat] = { active: 0, passive: 0, mutual: 0, flags: 0 };
    for (const b of state.battles || []) {
      const a = byId.get(b.attacker);
      const d = byId.get(b.defender);
      if (!a || !d) continue;
      const av = a.type === "flag" ? 0 : (G.VALUE[a.type] || 0);
      const dv = d.type === "flag" ? 0 : (G.VALUE[d.type] || 0);
      if (b.outcome === "attacker") {
        seats[a.owner].active += dv;
        if (d.type === "flag") seats[a.owner].flags += 1;
      } else if (b.outcome === "defender") {
        seats[d.owner].passive += av;
      } else if (b.outcome === "both") {
        seats[a.owner].mutual += dv;
        seats[d.owner].mutual += av;
        if (d.type === "flag") seats[a.owner].flags += 1;
      }
    }
    const dead = {};
    for (const seat of B.SEATS) dead[seat] = 0;
    for (const p of state.pieces) {
      if (!p.owner || p.position || !p.type || p.type === "flag") continue;
      dead[p.owner] += G.VALUE[p.type] || 0;
    }
    // 双人模式只有南/北上场，且 teamOf 被改判（东西是 "X"）：这里必须只看参赛座位，
    // 否则 teams["X"] 是 undefined，push 直接把 render 打断（整页就"卡住不动"了）。
    const live = (state.seats && state.seats.length) ? state.seats : B.SEATS;
    const teams = { A: [], B: [] };
    for (const seat of live) {
      const t = B.teamOf(seat);
      if (teams[t]) teams[t].push(seat);
    }
    const out = {};
    for (const key of ["A", "B"]) {
      const seatsOfTeam = teams[key];
      const enemies = live.filter((s) => !seatsOfTeam.includes(s));
      const total = enemies.reduce((s, e) => s + dead[e], 0);
      const active = seatsOfTeam.reduce((s, e) => s + seats[e].active, 0);
      const passive = seatsOfTeam.reduce((s, e) => s + seats[e].passive, 0);
      const mutual = seatsOfTeam.reduce((s, e) => s + seats[e].mutual, 0);
      const flags = seatsOfTeam.reduce((s, e) => s + seats[e].flags, 0);
      out[key] = { total, active, passive, mutual, flags, other: Math.max(0, total - active - passive - mutual) };
    }
    return out;
  }

  function renderBattleStats() {
    if (!battleStats || !state) return;
    const st = computeBattleStats(state);
    const row = (key, label) => {
      const x = st[key];
      return `<div class="bs-row">
        <span class="bs-name">${label}</span>
        <span class="bs-nums"><b>${x.total.toFixed(1)}</b> 子力 · 主动 ${x.active.toFixed(1)} / 被动 ${x.passive.toFixed(1)} / 兑子 ${x.mutual.toFixed(1)}${x.other > 0.05 ? ` / 其它 ${x.other.toFixed(1)}` : ""}${x.flags ? ` · 夺旗 ${x.flags}` : ""}</span>
      </div>`;
    };
    battleStats.innerHTML = `<div class="bs-title">战果（不含军旗子力）</div>
      ${row("A", "南 + 北（我队）")}
      ${row("B", "东 + 西")}
      <div class="bs-sub" style="margin-top:5px">主动=我方进攻吃掉；被动=敌方撞死在我方子上；兑子=同归于尽；其它=出局清场。</div>`;
  }

  function updatePanel() {
    if (!state) return;
    const phase = state.phase;
    const turn = state.turn;

    const modeLabel = state.mode === "standard" ? "一般军棋" : "乱战四国";
    const viewLabel = viewMode === "double" ? " · 双明" : (viewMode === "full" ? " · 全明" : "");
    if (boardMode) boardMode.textContent = `四国争霸 · ${modeLabel}${viewLabel}`;
    // 下拉框与当前局面保持一致（读档/读复盘后尤其重要）
    if (viewSelect && viewSelect.value !== viewMode) viewSelect.value = viewMode;
    if (viewSelect) viewSelect.disabled = replayMode;
    if (modeSelect && modeSelect.value !== state.mode) modeSelect.value = state.mode;
    if (modeSelect) modeSelect.disabled = replayMode;
    if (aiStyle) {
      if (state.aiStyle && aiStyle.value !== state.aiStyle) aiStyle.value = state.aiStyle;
      aiStyle.disabled = replayMode;
    }

    const stage = document.querySelector(".board-stage");
    if (stage) {
      for (const seat of B.SEATS) stage.classList.remove("turn-" + seat);
      for (const seat of B.SEATS) stage.classList.remove("view-" + seat);
      if (replayMode && replayView !== "south") stage.classList.add("view-" + replayView);
      if (phase === "playing" || phase === "raise") stage.classList.add("turn-" + turn);
    }
    document.querySelectorAll(".replay-view").forEach((el) => {
      el.classList.toggle("active", replayMode && el.dataset.view === replayView);
    });
    document.querySelectorAll(".replay-side").forEach((el) => {
      const own = state.pieces.filter((p) => p.owner === el.dataset.side && p.position);
      const hidden = own.length > 0 && own.every((p) => replayHiddenIds.has(p.id));
      el.classList.toggle("active", replayMode && hidden);
    });
    if (stepInfo) stepInfo.textContent = `第 ${state.moveCount} 步`;
    if (turnInfo) {
      if (phase === "over") turnInfo.textContent = "对局结束";
      else if (phase === "setup") turnInfo.textContent = "布阵中";
      else if (phase === "raise") turnInfo.textContent = "升旗";
      else turnInfo.textContent = `轮到 ${B.SEAT_NAMES[turn]}`;
      turnInfo.style.color = phase === "playing" && B.SEAT_COLORS[turn] ? B.SEAT_COLORS[turn] : "#cbb98f";
    }

    if (phase === "over") {
      statusEl.innerHTML = state.winner
        ? `<b>对局结束</b> · ${state.winner === "A" ? "南 + 北" : "东 + 西"} 获胜`
        : "<b>对局结束</b> · 和棋";
    } else if (phase === "raise" && state.pendingRaise) {
      const seat = state.pendingRaise.seat;
      statusEl.innerHTML = isHumanSeat(seat)
        ? `<b>请升旗（${B.SEAT_NAMES[seat]}）</b> · 你的最后一个司令阵亡，点击一个大本营升旗。`
        : `<b>${B.SEAT_NAMES[seat]} 升旗中…</b>`;
    } else if (phase === "setup") {
      const cur = B.SEAT_NAMES[setupSeat];
      const hint = viewMode === "double" ? `当前布阵：<b>${cur}</b>（下方下拉可切南北）。` : "";
      statusEl.innerHTML = hint + (state.mode === "standard"
        ? `<b>布阵阶段</b> · 一般军棋：每家 25 枚标准棋子，位置随机；点自己的两枚棋子可交换。`
        : `<b>布阵阶段</b> · 每人 25 子，25 格摆满；点自己的两枚棋子可交换，也可「自动布阵」或「作弊选子」。`);
    } else if (isHumanTurn() && isHumanSeat(turn)) {
      const where = viewMode === "double" ? `你控·${B.SEAT_NAMES[turn]}` : "南";
      statusEl.innerHTML = `<b>轮到你（${where}）</b> · 选择一枚棋子，再点绿色目标格；鼠标悬停目标可看移动指向。`;
    } else if (isAgentSeat(turn)) {
      const sec = agentThinking ? Math.max(0, Math.floor((Date.now() - agentSince) / 1000)) : 0;
      const on = !!(window.JunqiAgent && window.JunqiAgent.online);
      statusEl.innerHTML = `<b>队友（${B.SEAT_NAMES[turn]}·外援）思考中…</b> · ${sec}s`
        + (on ? " · 你在对家等着就行" : " · 本地桥没连上，超时后由本地 AI 代走");
    } else {
      statusEl.innerHTML = `<b>${B.SEAT_NAMES[turn]} 行动中…</b>`;
    }
    if (state.log && state.log.length) {
      statusEl.innerHTML += `<div class="lastlog">${state.log[state.log.length - 1]}</div>`;
    }
    if (replayMode) {
      const last = state.log && state.log.length ? state.log[state.log.length - 1] : "";
      statusEl.innerHTML = `<b>复盘（点棋子/按方切换明暗，视角可转）</b> · 第 ${replayIndex + 1} / ${replayFrames.length} 帧`
        + (last ? `<div class="lastlog">${last}</div>` : "");
    }

    doubleFlagWrap.classList.toggle("hidden", !(phase === "setup" && state.mode === "chaos" && (state.handFlags[setupSeat] || 0) >= 2));
    chkDoubleFlag.checked = !!(state.doubleFlag && state.doubleFlag[setupSeat]);
    if (setupSeatSel) {
      setupSeatSel.classList.toggle("hidden", !(phase === "setup" && viewMode === "double"));
      setupSeatSel.value = setupSeat;
    }
    for (const el of chkLatentSeats) {
      el.checked = !!(state.latentSeats && state.latentSeats[el.value]);
      // 暗牌现在在任何信息模式下都能开（双明也行），但只能布阵阶段选
      el.disabled = replayMode || phase !== "setup";
    }
    if (chkAiSouth) {
      chkAiSouth.checked = autoSouth;
      chkAiSouth.disabled = replayMode || viewMode === "double";
    }
    if (latentWrap) {
      const off = replayMode || phase !== "setup";
      latentWrap.classList.toggle("disabled", off);
      latentWrap.title = off
        ? "天命暗牌只能在布阵阶段选（开局后要重开一局）。"
        : "天命暗牌：按座位给暗子延迟身份（作弊）。双明/全明下也能开，只对勾了的那几家生效。";
    }
    chkDoubleFlag.disabled = replayMode || phase !== "setup";

    playersEl.innerHTML = B.SEATS.map((seat) => {
      const own = state.pieces.filter((p) => p.owner === seat && p.position);
      const shown = (p) => (replayMode ? (p.replayType || p.actualType || p.type) : p.type);
      const flags = own.filter((p) => shown(p) === "flag").length;
      const cmds = own.filter((p) => shown(p) === "commander").length;
      const cls = ["player"];
      if ((state.phase === "playing" || state.phase === "raise") && turn === seat) cls.push("active");
      if (state.out[seat]) cls.push("out");
      const flagText = flags > 0 ? `旗 ${flags}` : "无旗";
      const initial = B.SEAT_NAMES[seat].slice(0, 1);
      return `<div class="${cls.join(" ")}">
        <div class="pavatar" style="background:${B.SEAT_COLORS[seat]}">${initial}</div>
        <div class="pinfo">
          <div class="pname">${playerName(seat)} <span style="color:#64748b;font-weight:400">${roleLabel(seat)}</span></div>
          <div class="meta">${state.out[seat] ? "已出局" : `${flagText} · 司令 ${cmds} · 子 ${own.length}`}</div>
        </div>
      </div>`;
    }).join("");

    renderSeatAi();

    logEl.innerHTML = (state.log || []).slice(-14).map((line) => {
      const t = String(line);
      // 战术卡单独上色：对局记录里一眼能看出"这一步不是走子，是打牌"
      const cls = t.startsWith("【战术·DEV") ? ' class="lg-dev"'
        : t.startsWith("【战术·被动") ? ' class="lg-passive"'
          : t.startsWith("【战术") ? ' class="lg-card"' : "";
      return `<div${cls}>${t}</div>`;
    }).join("");
    logEl.scrollTop = logEl.scrollHeight;

    renderDomains();
    renderAdvice();
    renderBattleStats();

    btnStart.disabled = replayMode || state.phase !== "setup";
    btnAuto.disabled = replayMode || state.phase !== "setup";
    if (btnFormation) btnFormation.disabled = replayMode || state.phase !== "setup";
    btnCheat.disabled = replayMode || state.phase !== "setup" || state.mode !== "chaos";
    btnCheat.title = state.mode === "standard" ? "一般军棋不支持作弊选子" : "";
    btnSave.disabled = replayMode;
    btnLoad.disabled = replayMode;
    btnReplay.textContent = replayMode ? "退出复盘" : "复盘";
    btnReplay.disabled = !replayMode && (!state.recordHistory || (state.historyFrames || []).length < 2 || state.phase === "setup");
    replayBar.classList.toggle("hidden", !replayMode);
    if (replayInfo) replayInfo.textContent = replayMode ? `${replayIndex + 1} / ${replayFrames.length}` : "";
    if (btnReplayPrev) btnReplayPrev.disabled = !replayMode || replayIndex <= 0;
    if (btnReplayNext) btnReplayNext.disabled = !replayMode || replayIndex >= replayFrames.length - 1;
    if (btnReplayAll) btnReplayAll.textContent = replayHiddenIds.size ? "全部明牌" : "全部暗牌";
    if (btnSaveReplay) btnSaveReplay.disabled = !replayMode;
    if (btnResult) btnResult.disabled = !state || state.moveCount === 0;

    // 一局结束自动弹一次战果
    if (!replayMode && state.phase === "over" && !resultShown) {
      resultShown = true;
      showResult();
      // 一般模式下记一笔：南方用的哪套阵、赢了没有（formation_log.js，内部保证每局只记一次）。
      // 必须从复盘帧取初始布局：天命暗牌让开局那些子的 type 是占位的（实际会全是工兵），
      // 只有复盘里 buildReplayFaceMap 还原出来的才是真值。
      try {
        if (state.mode === "standard" && window.JunqiFormationLog) {
          const frames = currentReplayFrames();
          const faceMap = frames ? buildReplayFaceMap(frames) : null;
          window.JunqiFormationLog.record(state, "south", { frames: frames, faceMap: faceMap });
        }
      } catch (err) { /* 记账失败不影响对局 */ }
    }
  }

  // ---------- 回合 ----------
  function checkHumanTurn() {
    if (!state || state.phase !== "playing" || !isHumanTurn()) return false;
    if (G.allLegalMoves(state, state.turn).length > 0) return false;
    G.noMoves(state, state.turn);
    playSound("nomove");
    render();
    if (state.phase === "playing") scheduleAI();
    return true;
  }

  function afterHumanMove() {
    selected = null;
    legal = [];
    hoverPos = null;
    render();
    if (state.phase === "over" || state.phase === "raise") return;
    if (isHumanTurn()) { checkHumanTurn(); return; }
    scheduleAI();
  }

  function scheduleAI() {
    clearTimeout(aiTimer);
    if (replayMode || !state || state.phase !== "playing" || isHumanTurn()) return;
    // 外援座位：不跑本地 AI，等桥后面那个人交子
    if (isAgentSeat(state.turn)) {
      aiTimer = setTimeout(agentStep, 260);
      return;
    }
    aiTimer = setTimeout(aiStep, 520);
  }

  // 外援的一手：把「北方视角」交给本地桥后面那个 agent；超时/离线就本地 AI 代走
  function agentStep() {
    if (!state || state.phase !== "playing" || isHumanTurn()) return;
    const seat = state.turn;
    if (!isAgentSeat(seat)) { aiStep(); return; }
    if (state.out[seat] || !inPlay(seat)) {
      const ord = state.seats || G.TURN_ORDER;
      state.turn = ord[(ord.indexOf(seat) + 1) % ord.length];
      render();
      scheduleAI();
      return;
    }
    const agent = window.JunqiAgent;
    if (!agent || !agent.enabled) { aiStep(); return; }
    const st = state;
    agentThinking = true;
    agentSince = Date.now();
    updatePanel();
    agent.takeTurn(st, seat).then((move) => {
      agentThinking = false;
      if (state !== st) return;                 // 期间开了新局 / 读档 / 进复盘
      if (!move) { aiStep(); return; }          // 超时或桥掉线：本地 AI 代走
      const res = G.applyMove(st, seat, move.from, move.to);
      if (!res.ok) {
        st.log.push("外援走子失败：" + res.message);
        aiStep();
        return;
      }
      playResultSound(res);
      hoverPos = null;
      render();
      if (res.pendingRaise) return;
      if (st.phase !== "over" && !checkHumanTurn()) scheduleAI();
    }).catch(() => {
      agentThinking = false;
      if (state === st) aiStep();
    });
  }

  function aiStep() {
    if (!state || state.phase !== "playing" || isHumanTurn()) return;
    const seat = state.turn;
    if (state.out[seat] || !inPlay(seat)) {
      const ord = state.seats || G.TURN_ORDER;
      state.turn = ord[(ord.indexOf(seat) + 1) % ord.length];
      render();
      scheduleAI();
      return;
    }
    let move = null;
    try {
      const profile = (state.aiProfiles && state.aiProfiles[seat]) || "";
      if (profile === "zero" && window.JunqiAI0) {
        // 零代：2007《四国争霸》逆向复刻，只算一步（不搜索，几十毫秒）
        move = window.JunqiAI0.choose(state, seat, { budgetMs: 5000, level: zeroLevel });
      } else if (profile === "bc" && window.JunqiBCAI) {
        // 二代：BC 克隆（bc_ai.js）。注意它**不吃 budgetMs** —— 固定成本约 26~34ms/步，
        // 给它 1500ms 它也只用这么点。之前这里缺席，于是选「二代」实际落进了
        // 下面的 JunqiAI.choose → PROFILES["bc"] 未定义 → fallback 成「一代·林」。
        move = window.JunqiBCAI.choose(state, seat);
      } else if (window.JunqiAI) {
        move = window.JunqiAI.choose(state, seat, { budgetMs: 5000 });
      }
    } catch (err) {
      // 不要静默吞异常：一旦吞掉就会退到 game.js 的兜底走子（启发式很粗），
      // 线上「AI 钻进已出局玩家的空大本营」正是这么来的，而日志里一个字都看不到。
      console.warn("[AI] choose 抛错，退回兜底走子：", err && err.message);
      if (!window.__aiErrCount) window.__aiErrCount = {};
      const k = (err && err.message) || "unknown";
      window.__aiErrCount[k] = (window.__aiErrCount[k] || 0) + 1;
      move = null;
    }
    if (!move) move = G.aiChoose(state, seat);
    if (!move) {
      G.noMoves(state, seat);
      playSound("nomove");
      render();
      if (state.phase === "playing") scheduleAI();
      return;
    }
    const res = G.applyMove(state, seat, move.from, move.to);
    if (!res.ok) {
      state.log.push("AI 走子失败：" + res.message);
      G.noMoves(state, seat);
    } else {
      playResultSound(res);
    }
    hoverPos = null;
    render();
    if (res.pendingRaise) return;
    if (state.phase !== "over") {
      if (!checkHumanTurn()) scheduleAI();
    }
  }

  // ---------- 交互 ----------
  function handlePlay(pos) {
    inspectPos = pos;               // 零代参谋：点任何棋子都能看它的可能军衔
    if (autoSouth) return;          // 南方托管时不接受手动走子
    if (state.phase === "raise") {
      const raiseSeat = state.pendingRaise ? state.pendingRaise.seat : null;
      if (raiseSeat && isHumanSeat(raiseSeat)) {
        const targets = currentRaiseTargets();
        if (targets.includes(pos) && G.raiseFlag(state, raiseSeat, pos)) {
          playResultSound({ sound: null });
          selected = null; legal = []; hoverPos = null;
          render();
          if (state.phase === "playing" && !checkHumanTurn()) scheduleAI();
        }
      }
      return;
    }
    // 顺序很重要：**先判"这一下是不是走子/吃子"，再判"是不是在挑卡牌目标"**。
    // 反过来写就会出事——吃子的目标格上一定站着一枚敌子，
    // 被 DEV 的选目标逻辑抢走之后，玩家就永远吃不了子（真实踩过的坑）。
    // 正在为一张卡选目标：这一下点击归卡牌用，不解释成走子
    if (armed) { handleArmedClick(pos); return; }

    if (state.phase !== "playing" || !isHumanTurn()) return;
    const seat = state.turn;

    if (selected && legal.includes(pos)) {
      const res = G.applyMove(state, seat, selected, pos);
      if (res.ok) {
        playResultSound(res);
        hoverPos = null;
        if (res.pendingRaise) { selected = null; legal = []; render(); return; }
        afterHumanMove();
      } else {
        playSound("nomove");
        state.log.push(res.message);
        render();
      }
      return;
    }

    const p = G.pieceAt(state, pos);
    if (p && p.owner === seat) {
      selected = pos;
      hoverPos = null;
      legal = G.legalTargets(state, seat, pos);
      playSound("select");
    } else {
      selected = null;
      hoverPos = null;
      legal = [];
    }
    render();
  }

  function handleSetup(pos) {
    const seat = setupSeat;
    if (selected === null) {
      const p = G.pieceAt(state, pos);
      if (p && p.owner === seat) { selected = pos; hoverPos = null; render(); playSound("select"); }
      return;
    }
    if (pos === selected) { selected = null; hoverPos = null; render(); return; }
    const ok = G.swapSetup(state, seat, selected, pos);
    if (ok) {
      selected = null;
      hoverPos = null;
      playSound("move");
      render();
    } else {
      const p = G.pieceAt(state, pos);
      if (p && p.owner === seat) { selected = pos; hoverPos = null; render(); }
      else { selected = null; hoverPos = null; render(); playSound("nomove"); }
    }
  }

  function onBoardClick(ev) {
    const el = ev.target.closest("[data-pos]");
    if (!el) return;
    hideAdvTip();
    const pos = el.getAttribute("data-pos");
    if (replayMode) {
      const piece = G.pieceAt(state, pos);
      if (!piece) return;
      if (replayHiddenIds.has(piece.id)) replayHiddenIds.delete(piece.id);
      else replayHiddenIds.add(piece.id);
      playSound("select");
      render();
      return;
    }
    if (state.phase === "setup" && sandboxMode) sandboxPlace(pos);
    else if (state.phase === "setup") handleSetup(pos);
    else handlePlay(pos);
  }

  function onBoardHover(ev) {
    const hovered = ev.target.closest("[data-pos]");
    showAdvTip(hovered ? hovered.getAttribute("data-pos") : null, ev);   // 零代参谋：悬浮看军衔
    if (replayMode || !state || state.phase !== "playing" || !isHumanTurn()) return;
    const el = hovered;
    const pos = el ? el.getAttribute("data-pos") : null;
    let next = null;
    if (pos && selected && legal.includes(pos)) next = pos;
    if (next === hoverPos) return;
    hoverPos = next;
    renderArrows();
  }

  function clearHover() {
    hideAdvTip();
    if (hoverPos !== null) {
      hoverPos = null;
      renderArrows();
    }
  }

  // ---------- 新局/按钮 ----------

  // ---------- 零代参谋 ----------
  // 只在"轮到你"的时候算：把零代的 12 维信念、每步分数、推荐走法摊开给你看。
  const ADVICE_KEY = "junqi.advice.v1";
  const ZERO_LEVEL_KEY = "junqi.zeroLevel.v1";
  let adviceOn = true;
  try { const v = localStorage.getItem(ZERO_LEVEL_KEY); if (v) zeroLevel = v; } catch (err) { /* ignore */ }
  if (zeroLevelSel) {
    zeroLevelSel.value = zeroLevel;
    zeroLevelSel.addEventListener("change", () => {
      zeroLevel = zeroLevelSel.value;
      try { localStorage.setItem(ZERO_LEVEL_KEY, zeroLevel); } catch (err) { /* ignore */ }
      if (window.JunqiAI0 && window.JunqiAI0.setLevel) window.JunqiAI0.setLevel(zeroLevel);
      adviceKey = "";
      tipCacheKey = "";
      seatAiKey = "";          // 让「每家 AI 种类」里零代那一行跟着显示新等级
      render();
    });
    if (window.JunqiAI0 && window.JunqiAI0.setLevel) window.JunqiAI0.setLevel(zeroLevel);
  }
  let adviceData = null;
  let adviceKey = "";
  let adv3 = null;            // 三引擎参谋：{ gen0, gen1, gen2, ms }
  let adv3Key = "";
  let inspectPos = null;
  try { adviceOn = localStorage.getItem(ADVICE_KEY) !== "0"; } catch (err) { /* ignore */ }
  if (chkAdvice) {
    chkAdvice.checked = adviceOn;
    chkAdvice.addEventListener("change", () => {
      adviceOn = !!chkAdvice.checked;
      try { localStorage.setItem(ADVICE_KEY, adviceOn ? "1" : "0"); } catch (err) { /* ignore */ }
      adviceKey = "";
      render();
    });
  }

  const SEAT_CHAR = { north: "北", east: "东", south: "南", west: "西" };
  function posName(pos) {
    if (!pos) return "—";
    const parts = String(pos).split("-");
    if (parts.length < 3) return String(pos);
    return SEAT_CHAR[parts[0]] + parts[1] + "-" + parts[2];
  }

  function typeName(t) {
    const info = B.PIECE_INFO[t];
    return info ? info.name : String(t);
  }

  function hideAdvTip() {
    if (advTip) advTip.classList.add("hidden");
  }

  function topOfMap(map, n) {
    const list = [];
    if (!map) return list;
    for (const [t, p] of map) if (p > 0.004) list.push([t, p]);
    list.sort((a, b) => b[1] - a[1]);
    return list.slice(0, n || 3);
  }

  // 三家的信念都按「战况/走子条数」缓存，同一手内反复悬浮不重算
  let tipCacheKey = "";
  let tipCache = null;
  function tipData() {
    const key = `${state.moveCount}|${(state.battles || []).length}|${(state.moveTape || []).length}`;
    if (key === tipCacheKey && tipCache) return tipCache;
    const seat = HUMAN;
    const out = { gen0: null, one: null, domain: null };
    try {
      out.gen0 = window.JunqiAI0.buildBelief(state, seat);
    } catch (err) { /* ignore */ }
    const J = window.JunqiAI;
    if (J && J._internals && J._internals.inferDomains) {
      try {
        const doms = J._internals.inferDomains(state, seat);
        out.domain = doms;
        if (J._internals.beliefRowsView) {
          try {
            out.one = J._internals.beliefRowsView(state, seat, doms);
          } catch (err) { out.one = null; }
        }
      } catch (err) { /* ignore */ }
    }
    tipCacheKey = key;
    tipCache = out;
    return out;
  }

  function tipRow(tag, entries, extraCls) {
    if (!entries || !entries.length) return "";
    const chips = entries.map(([t, pv]) =>
      `<span class="tip-chip ${extraCls || ""} ${pv < 0.08 ? "low" : ""}">${typeName(t)} ${Math.round(pv * 100)}%</span>`).join("");
    return `<div class="tip-row"><span class="tip-tag">${tag}</span><span class="tip-chips">${chips}</span></div>`;
  }

  // 档位化的那版：大/旅/小/炸/雷/旗。
  // 一屏「连长12% 排长12% 工兵14%」既不能指导决策，也会让人误以为分得很细；
  // 真正能用的判断只有三档 + 三个特殊。收敛到具体军衔（≥85%）时才写名字。
  function tipTierRow(tag, entries, extraCls) {
    if (!entries || !entries.length) return "";
    const dist = {};
    for (const [t, pv] of entries) dist[t] = (dist[t] || 0) + pv;
    const bk = bucketize(dist);
    const top = TIER_ORDER.map((k) => [k, bk[k] || 0])
      .filter(([, v]) => v >= 0.06)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    if (!top.length) return "";
    const best = entries[0];
    const chips = (best && best[1] >= 0.85)
      ? `<span class="tip-chip">${typeName(best[0])} ${Math.round(best[1] * 100)}%<b class="fix">确定</b></span>`
      : top.map(([k, v]) => `<span class="tip-chip ${extraCls || ""} ${v < 0.08 ? "low" : ""}">${TIER_LABEL[k]} ${Math.round(v * 100)}%</span>`).join("");
    return `<div class="tip-row"><span class="tip-tag">${tag}</span><span class="tip-chips">${chips}</span></div>`;
  }

  function showAdvTip(pos, ev) {
    if (!advTip) return;
    if (!adviceOn || replayMode || !state || state.phase !== "playing" || !pos) { hideAdvTip(); return; }
    const piece = G.pieceAt(state, pos);
    if (!piece) { hideAdvTip(); return; }

    // 同一颗子只重建一次内容，避免鼠标移动时闪烁
    if (advTip.dataset.pos === pos && !advTip.classList.contains("hidden")) {
      advTip.style.left = `${Math.max(8, Math.min(ev.clientX + 16, window.innerWidth - advTip.offsetWidth - 8))}px`;
      advTip.style.top = `${Math.max(8, Math.min(ev.clientY + 16, window.innerHeight - advTip.offsetHeight - 8))}px`;
      return;
    }
    advTip.dataset.pos = pos;

    const seat = HUMAN;
    const TYPE_ORDER = window.JunqiAI0 ? window.JunqiAI0.CONST.TYPE_ORDER : [];
    const known = piece.owner === seat || G.visibleTo(state, seat, piece);
    let html = `<div class="tip-title">${posName(pos)} · ${piece.owner === seat ? "我方" : (known ? "已亮明" : "暗子")}</div>`;

    if (known) {
      html += `<div class="tip-chips"><span class="tip-chip">${typeName(piece.type)}</span></div>`;
    } else {
      const d = tipData();
      const rows = [];

      // ① 零代：计数先验 + 战况等级上下界
      const g0 = d.gen0 ? d.gen0.get(pos) : null;
      if (g0) {
        const list = [];
        for (let i = 0; i < 12; i += 1) if (g0[i] > 0.004) list.push([TYPE_ORDER[i], g0[i]]);
        list.sort((a, b) => b[1] - a[1]);
        rows.push(tipTierRow("零代", list));
      }

      // ② 一代：身份域 + 阵法先验 + IPF 后验
      const one = d.one ? d.one.get(piece.id) : null;
      const oneAll = topOfMap(one, 12);      // 要给全 12 类才能正确聚档，不能先截 3 条
      if (oneAll.length) rows.push(tipTierRow("一代", oneAll));

      // ③ 二代没有猜子头，只继承一代的身份域，这里如实显示「域里有几种」
      const dom = d.domain ? d.domain.get(piece.id) : null;
      if (dom && dom.size) {
        if (dom.size <= 4) {
          const w = 1 / dom.size;
          rows.push(tipTierRow("二代", [...dom].map((t) => [t, w]), "dim"));
        } else {
          rows.push(`<div class="tip-row"><span class="tip-tag">二代</span><span class="tip-chips"><span class="tip-chip dim">身份域 ${dom.size} 种</span></span></div>`);
        }
      }

      html += rows.join("") || `<div class="tip-note">没有可用信息</div>`;
      html += `<div class="tip-note">零代=计数先验+战况上下界 · 一代=身份域后验（含吃子行为/同区配额）· 二代=只继承身份域<br>档位：大=司军师，旅=旅长，小=团营连排工</div>`;
    }

    advTip.innerHTML = html;
    advTip.classList.remove("hidden");

    const pad = 16;
    const w = advTip.offsetWidth;
    const h = advTip.offsetHeight;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    advTip.style.left = `${Math.max(8, x)}px`;
    advTip.style.top = `${Math.max(8, y)}px`;
  }

  function adviceSeat() {
    if (!state || state.phase !== "playing" || replayMode) return null;
    if (!adviceOn || !window.JunqiAI0 || !window.JunqiAI0.analyze) return null;
    return isHumanTurn() ? state.turn : null;
  }

  function rankChips(piece, seat, belief) {
    if (!piece) return "";
    if (piece.owner === seat) return `<span class="adv-rank">${typeName(piece.type)} · 我方</span>`;
    if (G.visibleTo(state, seat, piece)) return `<span class="adv-rank">${typeName(piece.type)} · 已亮明</span>`;
    const probs = belief ? belief.get(piece.position) : null;
    if (!probs) return `<span class="adv-note">—</span>`;
    const order = window.JunqiAI0.CONST.TYPE_ORDER;
    const list = [];
    for (let i = 0; i < 12; i += 1) if (probs[i] >= 0.02) list.push([i, probs[i]]);
    list.sort((a, b) => b[1] - a[1]);
    return list.slice(0, 6)
      .map(([i, pv]) => `<span class="adv-rank ${pv < 0.08 ? "low" : ""}">${typeName(order[i])} ${Math.round(pv * 100)}%</span>`)
      .join("") || `<span class="adv-note">—</span>`;
  }

  // ---------- 三引擎参谋（2026-11-03） ----------
  // 同一个局面，三个引擎各给「推荐走法 + 猜子」，并排摊开对比：
  //   零代：2007 公式（12 维概率 × 相克 × 权重 + 1 层试走）
  //   一代：公开碰子约束 + 暗子抽样 + 3~4 层 α-β（走法分是搜索结果，不是启发式）
  //   二代：BC 网络 policy × 一代 evaluate × value 三路加权；猜子来自它抽到的世界众数
  // 三个引擎的分数量纲不同，**不要横向比分值**，只看「它们是否同意这一步」。
  function engineData(seat) {
    const key = `${state.moveCount}|${seat}|${state.pieces.filter((p) => p.position).length}|${(state.battles || []).length}`;
    if (key === adv3Key && adv3) return adv3;
    const out = { gen0: null, gen1: null, gen2: null, ms: { gen0: 0, gen1: 0, gen2: 0 } };
    let t = Date.now();
    try {
      if (window.JunqiAI0 && window.JunqiAI0.analyze) {
        out.gen0 = window.JunqiAI0.analyze(state, seat, { budgetMs: 450, level: zeroLevel });
      }
    } catch (err) { out.gen0 = null; }
    out.ms.gen0 = Date.now() - t;
    t = Date.now();
    try {
      out.gen1 = (window.JunqiAI && window.JunqiAI.analyze)
        ? window.JunqiAI.analyze(state, seat, { budgetMs: 260 }) : null;
    } catch (err) { out.gen1 = null; }
    out.ms.gen1 = Date.now() - t;
    t = Date.now();
    try {
      out.gen2 = (window.JunqiBCAI && window.JunqiBCAI.analyze)
        ? window.JunqiBCAI.analyze(state, seat) : null;
    } catch (err) { out.gen2 = null; }
    out.ms.gen2 = Date.now() - t;
    adv3Key = key;
    adv3 = out;
    return out;
  }

  // 猜子按「档位」显示（2026-11-03）：大(司/军/师) · 旅 · 小(团以下) · 雷 · 旗 · 炸。
  // 具体军衔只在**收敛**时给：整条分布只剩一个类型（或该类型 ≥90%）才写「司令 92% 确定」，
  // 否则写档位概率 —— 因为 10 类各 10% 的分布里，写「连长 14%」是噪声，写「小 73%」才是信息。
  const TIER_OF = {
    commander: "big", army: "big", division: "big",
    brigade: "brig",
    regiment: "small", battalion: "small", company: "small", platoon: "small", engineer: "small",
    bomb: "bomb", mine: "mine", flag: "flag",
  };
  const TIER_LABEL = { big: "大", brig: "旅", small: "小", bomb: "炸", mine: "雷", flag: "旗" };
  const TIER_ORDER = ["flag", "mine", "bomb", "big", "brig", "small"];

  function bucketize(dist) {
    const out = {};
    for (const k of TIER_ORDER) out[k] = 0;
    for (const t of Object.keys(dist || {})) {
      const k = TIER_OF[t];
      if (!k) continue;
      out[k] += dist[t] || 0;
    }
    return out;
  }

  // 零代的 belief 是 12 维数组，转成「类型 → 概率」再走同一套
  function gen0Guesses(an, seat) {
    const out = [];
    if (!an || !an.belief || !window.JunqiAI0) return out;
    const order = window.JunqiAI0.CONST.TYPE_ORDER;
    for (const p of state.pieces) {
      if (!p.position || p.owner === seat) continue;
      if (G.visibleTo(state, seat, p)) continue;
      const probs = an.belief.get(p.position);
      if (!probs) continue;
      const dist = {};
      for (let i = 0; i < 12; i += 1) if (probs[i] > 0.001) dist[order[i]] = probs[i];
      out.push({ pos: p.position, dist });
    }
    return out;
  }

  /**
   * 统一的猜子过滤（三家共用）：
   *  ① 没有交火 ⇒ 一条不列（这时全是先验）
   *  ② 硬约束：旗只在大本营、雷只在后两排、炸不在一线；动过的子不可能是旗/雷
   *  ③ 证据门槛：最强的那个**档位**要比该格先验高出 12 个百分点，且 ≥30%
   *  ④ 同格去重、每家最多 5 条
   */
  // 证据账本（2026-11-03 用户口径）：
  //   「杀意感知只是一条经验规则，还要配合其他经验；从信息论就知道四国军棋不可能有
  //    100% 准确率的试探，肯定要多个方法综合取交/并集。」
  // 所以每个猜测先让各条经验单独投票（它支持哪个档），再拿结果与最终档位求交：
  // 硬约束锁死（域里只剩 ≤2 类）算「证据充分」；否则要求 ≥2 条同向经验，单条不定罪。
  const BIG_TYPES = ["commander", "army", "division"];
  const RANK_UI = { engineer: 1, platoon: 2, company: 3, battalion: 4, regiment: 5, brigade: 6, division: 7, army: 8, commander: 9 };

  function guessEvidence(p, g, topK, priorBk) {
    const ev = [];
    const I = window.JunqiAI && window.JunqiAI._internals;
    const mine = humanSeats();
    const live = Object.keys(g.dist || {}).filter((t) => (g.dist[t] || 0) > 0.002);
    // 「锁」按**档位**判，不按具体类型数：域里只剩司/军/师三类，档位其实已经定死了（大），
    // 按类型数判会把这种最硬的结论漏成「没证据」。
    const liveTiers = new Set(live.map((t) => TIER_OF[t]).filter(Boolean));
    if (liveTiers.size === 1) {
      ev.push({ k: "锁", tier: topK, note: `硬约束把范围锁在「${TIER_LABEL[topK]}」这一档` });
    } else if (live.length <= 2) {
      ev.push({ k: "锁", tier: topK, note: `硬约束只剩 ${live.length} 类` });
    }
    // 杀意感知：它吃过我方的子，吃的是什么档决定了这条证据有多硬
    let best = null;
    for (const b of (state.battles || [])) {
      if (b.attacker !== p.id || b.outcome !== "attacker") continue;
      const d = state.pieces.find((q) => q.id === b.defender);
      if (!d || !mine.includes(d.owner)) continue;
      const rk = RANK_UI[d.type] || 0;
      if (best === null || rk > best) best = rk;
    }
    if (best !== null) {
      if (best >= 4) ev.push({ k: "吃", tier: "big", note: "吃过我方营长以上，人类这个档位基本只上大子" });
      else if (best >= 3) ev.push({ k: "吃", tier: "big", note: "吃过我方连长，人类更倾向用大子稳稳拿下" });
      else ev.push({ k: "吃", tier: "big", note: "吃过我方小子（弱证据）", weak: true });
    }
    // 同区：开局同区已经有明大子 ⇒ 这个子更可能是小子（配额/格对条件）
    if (I && I.zoneOfPos && I.initPosOf) {
      try {
        const z = I.zoneOfPos(I.initPosOf(state, p));
        if (z) {
          let big = 0;
          for (const q of state.pieces) {
            if (q.owner !== p.owner || q === p) continue;
            if (I.zoneOfPos(I.initPosOf(state, q)) !== z) continue;
            // 死子也算：亮明过的司令阵亡了，这个区的名额照样是花掉的
            const known = q.revealed || (q.position && G.visibleTo(state, HUMAN, q));
            if (known && BIG_TYPES.includes(q.type)) big += 1;
          }
          if (big > 0) ev.push({ k: "区", tier: "small", note: `开局同区有 ${big} 个明大子，本子大子率下调` });
        }
      } catch (err) { /* 不影响主流程 */ }
    }
    // 位置先验（人类 30×12 表）
    if (priorBk) {
      let pk = null;
      for (const k of TIER_ORDER) if (!pk || (priorBk[k] || 0) > (priorBk[pk] || 0)) pk = k;
      if (pk && (priorBk[pk] || 0) >= 0.22) {
        ev.push({ k: "位", tier: pk, note: `该格经验先验 ${TIER_LABEL[pk]} ${Math.round(priorBk[pk] * 100)}%` });
      }
    }
    // 阵法库后验
    if (I && I.formationPriorRow) {
      try {
        const row = I.formationPriorRow(state, p.owner, p.id);
        if (row && row.size) {
          const o = {};
          for (const [t, v] of row) o[t] = v;
          const b2 = bucketize(o);
          let pk = null;
          for (const k of TIER_ORDER) if (!pk || (b2[k] || 0) > (b2[pk] || 0)) pk = k;
          if (pk && (b2[pk] || 0) >= 0.5) ev.push({ k: "阵", tier: pk, note: `兼容阵法里 ${TIER_LABEL[pk]} 占 ${Math.round(b2[pk] * 100)}%` });
        }
      } catch (err) { /* 不影响主流程 */ }
    }
    return ev;
  }

  function filterGuesses(list, cap) {
    if (!(state.battles && state.battles.length)) return [];
    const I = window.JunqiAI && window.JunqiAI._internals;
    const moved = new Set();
    for (const t of (state.moveTape || [])) if (t && t.piece) moved.add(t.piece);
    const byPos = new Map();
    for (const p of state.pieces) if (p.position) byPos.set(p.position, p);
    const out = [];
    for (const g of (list || [])) {
      const p = byPos.get(g.pos);
      const node = B.BOARD.byId.get(g.pos);
      if (!p || !node || !g.dist) continue;
      const bk = bucketize(g.dist);
      let topK = null;
      for (const k of TIER_ORDER) if (!topK || bk[k] > bk[topK]) topK = k;
      if (!topK) continue;
      // ② 硬约束（对最可能的那个**具体类型**判，档位里可能混着合法的）
      const typesInTop = Object.keys(g.dist).filter((t) => TIER_OF[t] === topK).sort((a, b) => g.dist[b] - g.dist[a]);
      const head = typesInTop[0];
      if (head === "flag" && node.kind !== "hq") continue;
      if (head === "mine" && node.row < 4) continue;
      if (head === "bomb" && node.row <= 0) continue;
      if ((head === "flag" || head === "mine") && (moved.has(p.id) || p.moved)) continue;
      // ③ 证据门槛：档位后验 vs 该格档位先验
      let priorBk = null;
      try {
        const row = (I && I.posPriorRow) ? I.posPriorRow(p, state.moveCount) : null;
        if (row) { const o = {}; for (const [t, v] of row) o[t] = v; priorBk = bucketize(o); }
      } catch (err) { priorBk = null; }
      const pTop = bk[topK] || 0;
      if (pTop < 0.30) continue;
      if (priorBk && pTop < (priorBk[topK] || 0) + 0.12) continue;
      // 多源证据：硬约束锁死算充分，否则要 ≥2 条经验同向（单条只能记进标题，不能当结论）
      const ev = guessEvidence(p, g, topK, priorBk);
      const locked = ev.some((e) => e.k === "锁");
      const same = ev.filter((e) => e.tier === topK && !e.weak).length;
      // 单条经验不定罪；但「一条硬经验 + 后验已经很集中」也算数，否则中盘会把
      // 「域只剩司/军/师 + 该格本就有 42% 大子率」这种正经结论也一起滤掉。
      if (!locked && same < 2 && !(same >= 1 && pTop >= 0.6)) continue;
      // 收敛判定：整条分布只剩一个类型，或该类型 ≥90%
      let exact = null;
      const list2 = Object.keys(g.dist).sort((a, b) => g.dist[b] - g.dist[a]);
      if (list2.length === 1 && g.dist[list2[0]] >= 0.85) exact = { type: list2[0], p: g.dist[list2[0]] };
      else if (list2.length && g.dist[list2[0]] >= 0.9) exact = { type: list2[0], p: g.dist[list2[0]] };
      out.push({ pos: g.pos, bk, top: pTop, exact, ev });
    }
    out.sort((a, b) => b.top - a.top);
    const seen = new Set();
    const uniq = [];
    for (const g of out) {
      if (seen.has(g.pos)) continue;
      seen.add(g.pos);
      uniq.push(g);
    }
    return uniq.slice(0, cap || 5);
  }

  function fmtScore(v) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1);
  }

  function engineBlock(title, tag, color, moves, guesses, emptyHint) {
    const head = `<div class="adv-eng-head"><span class="adv-eng-dot" style="background:${color}"></span>`
      + `<span class="adv-eng-name">${title}</span><span class="adv-eng-tag">${tag}</span></div>`;
    const body = (moves && moves.length)
      ? moves.map((r, i) => `
      <div class="adv-row${i === 0 ? " best" : ""}" data-from="${r.from}" data-to="${r.to}">
        <span class="mv">${i === 0 ? "★ " : (i + 1) + ". "}${r.pc ? `<span class="pc">${r.pc}</span>` : ""}${posName(r.from)} → ${posName(r.to)}${r.note || ""}</span>
        <span class="sc">${fmtScore(r.score)}</span>
      </div>`).join("")
      : `<div class="adv-note">${emptyHint || "没算出推荐走法"}</div>`;
    const chipOf = (g) => {
      // 证据角标：锁=硬约束锁死，吃=杀意感知，区=同区配额，位=位置先验，阵=阵法库
      const evMark = (gg) => {
        if (!gg.ev || !gg.ev.length) return "";
        const ks = gg.ev.map((e) => e.k).join("·");
        const tip = gg.ev.map((e) => `${e.k}：${e.note}`).join("；");
        return `<b class="ev" title="${tip}">${ks}</b>`;
      };
      // 收敛到单一军衔才写具体名字，否则只给档位（大/旅/小…）
      if (g.exact) {
        return `<span class="adv-rank" data-pos="${g.pos}">${posName(g.pos)} ${typeName(g.exact.type)} ${Math.round(g.exact.p * 100)}%<b class="fix">确定</b>${evMark(g)}</span>`;
      }
      const arr = TIER_ORDER.map((k) => [k, g.bk[k] || 0])
        .filter(([, v]) => v >= 0.08)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      const body = arr.map(([k, v]) => `${TIER_LABEL[k]}${Math.round(v * 100)}`).join(" ");
      return `<span class="adv-rank" data-pos="${g.pos}">${posName(g.pos)} ${body}${evMark(g)}</span>`;
    };
    const chips = (guesses && guesses.length)
      ? `<div class="adv-list-inline">${guesses.map(chipOf).join("")}</div>`
      : `<div class="adv-note">暂无情报（眼下只到先验，还没打出来的信息）</div>`;
    return `<div class="adv-engine">${head}${body}${chips}</div>`;
  }

  function renderAdvice() {
    if (!adviceBox) return;
    const seat = adviceSeat();
    if (!seat) {
      adv3 = null;
      adviceKey = "";
      adviceData = null;
      adviceBox.innerHTML = state && state.phase === "playing"
        ? `<div class="adv-note">等待轮到你…（三家参谋只在你的回合算）</div>`
        : `<div class="adv-note">开局后这里并排给出「零代 / 一代 / 二代」的推荐走法与猜子。</div>`;
      return;
    }

    const data = engineData(seat);
    adviceData = data.gen0;                 // 兼容：悬浮框与旧逻辑仍读零代
    adviceKey = adv3Key;
    renderArrows();
    try { tipData(); } catch (err) { /* 预热悬浮框用的信念 */ }

    // 每一行都要说清「哪枚子在走、目标有没有子」——否则只看到坐标，会以为它在乱动
    const rowMeta = (from, to) => {
      const a = G.pieceAt(state, from);
      const d = G.pieceAt(state, to);
      let cap = "";
      if (d) cap = G.visibleTo(state, seat, d) ? ` ⚔${typeName(d.type)}` : " ⚔暗";
      return { pc: a ? (FALLEN_CH[a.type] || "") : "", cap };
    };

    // 零代：带「吃谁 / 猜是谁」标注（它本来就把这条信息写在 move 上）
    const g0 = ((data.gen0 && data.gen0.moves) || []).slice(0, 3).map((r) => {
      let note = "";
      if (r.target) note = ` ⚔${typeName(r.target)}`;
      else if (r.targetGuess) {
        note = ` ⚔≈${typeName(r.targetGuess.type)}`
          + (r.targetGuess.tied > 1 ? `等${r.targetGuess.tied}种` : "")
          + ` ${Math.round(r.targetGuess.p * 100)}%`;
      } else if (r.targetHidden) note = " ⚔暗子";
      const meta = rowMeta(r.from, r.to);
      return { from: r.from, to: r.to, score: r.score, pc: meta.pc, note: note || meta.cap };
    });
    const g1 = ((data.gen1 && data.gen1.moves) || []).slice(0, 3).map((r) => {
      const meta = rowMeta(r.from, r.to);
      return { from: r.from, to: r.to, score: r.score, pc: meta.pc, note: meta.cap };
    });
    const g2 = ((data.gen2 && data.gen2.moves) || []).slice(0, 3).map((r) => {
      const meta = rowMeta(r.from, r.to);
      return {
        from: r.from, to: r.to, score: r.score, pc: meta.pc,
        note: r.eatsFlag ? " 🚩扛旗" : (r.freeCapture ? " ✓白吃" : meta.cap),
      };
    });

    const blocks = [
      engineBlock("零代", `${data.ms.gen0}ms · 公式打分`, "#ffd166", g0, filterGuesses(gen0Guesses(data.gen0, seat))),
      engineBlock("一代", `${data.ms.gen1}ms · ${(data.gen1 && data.gen1.profile) || "搜索"}`, "#6ee7ff", g1,
        filterGuesses((data.gen1 && data.gen1.guesses) || []), "搜索没跑起来（预算太短或无可走）"),
      engineBlock("二代", `${data.ms.gen2}ms · 网络${data.gen2 && data.gen2.worlds ? ` · ${data.gen2.worlds} 世界` : ""}`,
        "#c084fc", g2, filterGuesses((data.gen2 && data.gen2.guesses) || []), "权重没加载或无可走"),
    ].join("");

    // 三个引擎是否同意同一手
    const k0 = g0[0] ? `${g0[0].from}>${g0[0].to}` : null;
    const k1 = g1[0] ? `${g1[0].from}>${g1[0].to}` : null;
    const k2 = g2[0] ? `${g2[0].from}>${g2[0].to}` : null;
    const agree = [k0, k1, k2].filter(Boolean);
    const allSame = agree.length >= 2 && agree.every((k) => k === agree[0]);
    const agreeText = !agree.length ? "—"
      : allSame ? `<b class="ok">三家一致</b>`
        : `${k0 && k1 && k0 === k1 ? "零代=一代 " : ""}${k0 && k2 && k0 === k2 ? "零代=二代 " : ""}${k1 && k2 && k1 === k2 ? "一代=二代 " : ""}`.trim() || "三家都不同";

    let pieceBlock = "";
    const ins = inspectPos ? G.pieceAt(state, inspectPos) : null;
    if (ins) {
      pieceBlock = `<div class="adv-sub">查看棋子 ${posName(ins.position)} <span class="adv-piece">${ins.owner === seat ? "（我方）" : "（敌方）"}</span></div>
        <div class="adv-list-inline">${rankChips(ins, seat, data.gen0 && data.gen0.belief)}</div>`;
    }

    adviceBox.innerHTML = `
      <div class="adv-title">三引擎参谋 <span class="adv-seat-note">第 ${state.moveCount} 手 · ${agreeText}</span></div>
      ${blocks}
      ${pieceBlock}
      <div class="adv-note">分数量纲各自不同（零代=公式分、一代=搜索值、二代=z 分加权），<b>只比「选了哪一手」，不要比分值</b>。点任一行可直接选中那步；点猜子可锁定那颗子。</div>`;

    adviceBox.querySelectorAll(".adv-row[data-from]").forEach((el) => {
      el.addEventListener("click", () => {
        if (!state || state.phase !== "playing" || !isHumanTurn()) return;
        selected = el.getAttribute("data-from");
        hoverPos = el.getAttribute("data-to");
        legal = G.legalTargets(state, state.turn, selected);
        render();
      });
    });
    adviceBox.querySelectorAll(".adv-rank[data-pos]").forEach((el) => {
      el.addEventListener("click", () => {
        inspectPos = el.getAttribute("data-pos");
        render();
      });
    });
  }

  function renderDomains() {
    if (!domains) return;
    const piece = selected && state ? G.pieceAt(state, selected) : null;
    if (!piece || !isHumanSeat(piece.owner) || !(state.latentSeats && state.latentSeats[piece.owner])) {
      domains.classList.add("hidden");
      domains.innerHTML = "";
      return;
    }
    const order = ["engineer", "platoon", "company", "battalion", "regiment", "brigade", "division", "army", "commander", "bomb"];
    const types = (piece.latent ? G.possibleTypesFor(state, piece) : [piece.type])
      .slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const names = types.map((t) => B.PIECE_INFO[t].name);
    const chips = names.map((n) => `<span class="dom-chip">${n}</span>`).join("");
    domains.innerHTML = `<div class="dom-title">${piece.latent ? "可能身份" : "身份"}</div>
      <div class="dom-list">${chips || "<span class='dom-chip'>—</span>"}</div>
      <div class="dom-note">棋盘上显示其中最小的身份；实际身份在作战时自动选取。</div>`;
    domains.classList.remove("hidden");
  }

  // ==================== 沙盘：自定义局面 → 四家对弈 ====================
  // 用途：摆一个特定局面（残局/战术试验），然后让四家 AI 直接下，观察它们的处理。
  // 复用现有的 setup 阶段（G.startGame 只校验 phase==="setup"，不要求摆满 25 子），
  // 所以不需要新的游戏阶段，只要在摆子期间接管棋盘点击即可。
  let sandboxMode = false;      // 正在摆子
  let sandboxMatch = false;     // 当前这局是沙盘开的：四家全归 AI，不等人
  let sandboxTakeover = false;  // 这一局是「从复盘接管」来的：局面已经下到中盘，不走开局套阵
  let sandboxSeat = "south";
  let sandboxPick = null;
  const SB_ORDER = ["commander", "army", "division", "brigade", "regiment", "battalion", "company", "platoon", "engineer", "bomb", "mine", "flag"];
  const SB_NAME = { commander: "司令", army: "军长", division: "师长", brigade: "旅长", regiment: "团长", battalion: "营长", company: "连长", platoon: "排长", engineer: "工兵", bomb: "炸弹", mine: "地雷", flag: "军旗" };

  function sandboxSay(msg) { if (sandboxHintEl) sandboxHintEl.textContent = msg; }
  function sandboxOwn(seat) { return state ? state.pieces.filter((p) => p.owner === seat) : []; }

  function enterSandbox() {
    clearTimeout(aiTimer);
    replayMode = false;
    if (!state || state.phase !== "setup" || !sandboxMode) {
      // 开一局最普通的规则，然后把四家的子全部从棋盘上拿下来
      state = G.newGame({ human: HUMAN, mode: "standard", humanSeats: [], infoMode: "normal", latentSeats: [], history: false, agentSeats: [] });
      for (const p of state.pieces) p.position = null;
      state.phase = "setup";
      state.log = [];
      assignAIProfiles(state);
    }
    sandboxMode = true;
    sandboxMatch = true;
    sandboxSeat = HUMAN || "south";
    sandboxPick = null;
    selected = null; legal = []; hoverPos = null;
    sandboxTakeover = false;
    if (sandboxEl) sandboxEl.classList.remove("hidden");
    if (btnSandboxFill) btnSandboxFill.classList.remove("hidden");
    if (btnSandboxClear) btnSandboxClear.classList.remove("hidden");
    sandboxSay("点兵种 → 点棋盘空格放置；点已放好的子取回");
    renderSandbox();
    render();
  }

  function exitSandbox() {
    sandboxMode = false;
    sandboxMatch = false;
    sandboxTakeover = false;
    sandboxPick = null;
    if (sandboxEl) sandboxEl.classList.add("hidden");
    newGame();
  }

  function renderSandbox() {
    if (!sandboxMode || !state || !sandboxSeatsEl) return;
    sandboxSeatsEl.innerHTML = "";
    for (const seat of B.SEATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sandbox-seat" + (seat === sandboxSeat ? " on" : "");
      const color = B.SEAT_COLORS[seat];
      b.style.color = color;
      if (seat === sandboxSeat) b.style.background = color;
      b.textContent = B.SEAT_NAMES[seat].slice(0, 2);
      b.addEventListener("click", () => { sandboxSeat = seat; sandboxPick = null; renderSandbox(); });
      sandboxSeatsEl.appendChild(b);
    }
    // 棋子池：只列「还没放上棋盘」的，数量归零的置灰
    const own = sandboxOwn(sandboxSeat);
    // 接管模式下，这一家里「接管时就已经阵亡」的子不能复活 —— 不进池子，也不计入分母
    const pool = sandboxTakeover ? own.filter((p) => !p._deadAtTakeover) : own;
    const cnt = {};
    for (const p of pool) if (!p.position) cnt[p.type] = (cnt[p.type] || 0) + 1;
    const placed = pool.filter((p) => p.position).length;
    sandboxPoolEl.innerHTML = "";
    const color = B.SEAT_COLORS[sandboxSeat];
    for (const type of SB_ORDER) {
      const n = cnt[type] || 0;
      const chip = document.createElement("div");
      chip.className = "sandbox-chip" + (sandboxPick === type ? " picked" : "") + (n ? "" : " dead");
      chip.innerHTML = `<span class="dot" style="background:${color}"></span><span>${SB_NAME[type]}</span><span class="n">${n}</span>`;
      if (n) chip.addEventListener("click", () => { sandboxPick = (sandboxPick === type ? null : type); renderSandbox(); });
      sandboxPoolEl.appendChild(chip);
    }
    const tip = document.createElement("div");
    tip.className = "sandbox-empty";
    const dead = sandboxTakeover ? own.filter((p) => p._deadAtTakeover).length : 0;
    tip.textContent = `${B.SEAT_NAMES[sandboxSeat]} 已放 ${placed} / ${pool.length}`
      + (dead ? `（另有 ${dead} 枚在接管前已阵亡，不可复活）` : "");
    sandboxPoolEl.appendChild(tip);
  }

  function sandboxPlace(pos) {
    if (!state || state.phase !== "setup") return;
    const node = B.BOARD.byId.get(pos);
    if (!node) return;
    const cur = G.pieceAt(state, pos);
    if (cur) {
      if (cur.owner !== sandboxSeat) { sandboxSay(`${B.SEAT_NAMES[cur.owner]}的子 —— 先切到那一家再取`); return; }
      cur.position = null;
      playSound("select");
      renderSandbox(); render();
      sandboxSay(`已取回 ${SB_NAME[cur.type]}`);
      return;
    }
    if (!sandboxPick) { sandboxSay("先在上面选一个兵种"); return; }
    if (node.kind === "camp") { sandboxSay("行营不能放子（开局布阵规则）"); return; }
    const p = state.pieces.find((x) => x.owner === sandboxSeat && x.type === sandboxPick
      && !x.position && !(sandboxTakeover && x._deadAtTakeover));
    if (!p) { sandboxSay(`${SB_NAME[sandboxPick]} 已经放完了`); return; }
    p.position = pos;
    playSound("move");
    renderSandbox(); render();
  }

  function sandboxAutoFill() {
    if (!sandboxMode || !state) return;
    const seat = sandboxSeat;
    const own = sandboxOwn(seat);
    for (const p of own) p.position = null;
    const cells = B.BOARD.nodes.filter((n) => n.seat === seat && n.kind !== "camp").map((n) => n.id);
    const takeFrom = (arr) => { const i = Math.floor(Math.random() * arr.length); return arr.splice(i, 1)[0]; };
    const drop = (id) => { const k = cells.indexOf(id); if (k >= 0) cells.splice(k, 1); };
    // 旗 → 大本营
    const hqs = B.hqCells(seat).slice();
    const flag = own.find((p) => p.type === "flag");
    if (flag && hqs.length) { const h = takeFrom(hqs); flag.position = h; drop(h); }
    // 雷 → 后两排
    for (const p of own.filter((x) => x.type === "mine")) {
      const back = cells.filter((id) => { const n = B.BOARD.byId.get(id); return n && n.row >= 4; });
      const from = back.length ? back : cells;
      if (!from.length) break;
      const id = takeFrom(from);
      p.position = id;
      drop(id);
    }
    // 其余 → 剩余空格
    for (const p of own) {
      if (p.position) continue;
      if (!cells.length) break;
      p.position = takeFrom(cells);
    }
    renderSandbox(); render();
    sandboxSay("已按「旗在大本营、雷在后两排」随机填满本方");
  }

  function sandboxClearSeat() {
    if (!sandboxMode || !state) return;
    for (const p of sandboxOwn(sandboxSeat)) p.position = null;
    renderSandbox(); render();
    sandboxSay("已清空本方");
  }

  function sandboxStart() {
    if (!sandboxMode || !state) return;
    // 接管模式：这一帧本来就是合法对局，不需要校验布阵、也不能调 G.startGame
    // （那个函数会把 turn 重置成 south，把刚接管的轮次弄丢）。
    if (sandboxTakeover) {
      state.phase = "playing";
      sandboxMode = false;
      sandboxMatch = true;            // 四家仍是 AI，不等人类
      sandboxTakeover = false;
      sandboxPick = null;
      if (sandboxEl) sandboxEl.classList.add("hidden");
      if (btnSandboxFill) btnSandboxFill.classList.remove("hidden");
      if (btnSandboxClear) btnSandboxClear.classList.remove("hidden");
      playSound("start");
      render();
      if (!isHumanTurn()) scheduleAI();
      return;
    }
    const problems = [];
    for (const seat of B.SEATS) {
      const flag = state.pieces.find((p) => p.owner === seat && p.type === "flag" && p.position);
      if (!flag) { problems.push(`${B.SEAT_NAMES[seat]} 没有军旗`); continue; }
      const n = B.BOARD.byId.get(flag.position);
      if (!n || n.kind !== "hq") problems.push(`${B.SEAT_NAMES[seat]} 的军旗不在大本营`);
    }
    if (problems.length) { sandboxSay("还不能开始：" + problems.join("；")); return; }
    // 沙盘局也要能复盘/被接管：打开 history，G.startGame 会自己压入第 0 帧
    state.recordHistory = true;
    state.historyFrames = [];
    // 先保持 sandboxMode=true 调 startGame，让它跳过 applyOpenings（否则沙盘布局会被阵法覆盖）
    startGame();
    sandboxMode = false;
    sandboxPick = null;
    if (sandboxEl) sandboxEl.classList.add("hidden");
    render();
  }

  function newGame() {
    clearTimeout(aiTimer);
    quizCtx = null;                        // 换局时把没答完的战地问答关掉
    if (dlcQuizEl) dlcQuizEl.classList.add("hidden");
    sandboxMode = false;
    sandboxMatch = false;
    sandboxTakeover = false;
    if (sandboxEl) sandboxEl.classList.add("hidden");
    replayMode = false;
    replayLive = null;
    replayFrames = [];
    replayIndex = 0;
    replayFaceMap = new Map();
    replayHiddenIds = new Set();
    replayView = "south";
    const mode = modeSelect ? modeSelect.value : "chaos";
    // 双人对局：只有南（人）和北（AI），东西两个象限空着。棋盘上的队伍关系要临时改判，
    // 这件事在 G.newGame({seats}) 里做（见 game.js / board.js setTeams）。
    // 双人对局暂封印（2026-11-06）：入口 #duelWrap 已加 hidden（见 index.html 注释与 日志 §六十一）。
    // 封印的不是这里的调度（那部分已修好并有 tools/duel_smoke.js 兜底），
    // 而是 ai.js 的 ALLY_OF 静态映射 —— 双人下北方 AI 会把人类当队友，既不进攻也不防守。
    const duel = !!(chkDuel && chkDuel.checked && !duelSealed());
    duelMode = duel;
    // 双座（它执东+西）＝你控南北，本局必须双明；但不改用户的下拉偏好
    viewMode = duel ? "normal" : (agentSeats.length >= 2 ? "double" : normalizeViewMode(viewModePref));
    setupSeat = HUMAN;
    // 双明：一人控南北两家，南北同队互明；全明：四家全明
    const infoMode = viewMode === "full" ? "all" : (viewMode === "double" ? "team" : "normal");
    const seatsToPlay = duel ? [HUMAN] : humanSeats();
    autoSouth = !!(chkAiSouth && chkAiSouth.checked) && viewMode !== "double";
    // 天命暗牌按勾选的座位走，任何信息模式（常规/双明/全明）都能用
    const latentSeats = readLatentSeats();
    pieceMarks.clear();
    hideMarkMenu();
    resultShown = false;
    for (const s of Object.keys(agentLayoutApplied)) delete agentLayoutApplied[s];
    agentThinking = false;
    state = G.newGame({
      human: HUMAN, mode, humanSeats: seatsToPlay, infoMode, latentSeats, history: true,
      agentSeats: duel ? [] : agentSeats.slice(),
      seats: duel ? ["south", "north"] : undefined,
    });
    assignAIProfiles(state);
    // 自适应世界数/深度默认开（2026-11-05，102 局验证：撞未知子赢 +2.8pp、2.0σ、输率持平）。
    // 只在页面里开，node 侧的探针不设它 —— 这样离线 A/B 仍然能拿"没开"当对照。
    state.adaptFor = { north: true, east: true, south: true, west: true };
    selected = null;
    legal = [];
    hoverPos = null;
    render();
    // 外援：打开布阵窗口，让他挑阵法（他不动就保持自动布阵的结果）
    if (agentSeats.length && window.JunqiAgent && window.JunqiAgent.enabled) {
      window.JunqiAgent.openSetup(state);
    }
  }

  function startGame() {
    autoSaveKey = null;
    if (!state || state.phase !== "setup") return;
    if (!sandboxMode && state.aiProfiles && window.JunqiAI && window.JunqiAI.applyOpenings) {
      // 外援自己挑过阵：别让 AI 的开局阵法把他铺好的覆盖掉
      const saved = {};
      for (const seat of agentSeats) { saved[seat] = state.aiProfiles[seat]; delete state.aiProfiles[seat]; }
      try { window.JunqiAI.applyOpenings(state); } catch (err) { /* fallback to random setup */ }
      for (const seat of agentSeats) {
        if (saved[seat]) state.aiProfiles[seat] = saved[seat];
        if (!agentLayoutApplied[seat] && saved[seat] && window.JunqiAI.applyOpening) {
          try { window.JunqiAI.applyOpening(state, seat, saved[seat]); } catch (err) { /* 保持随机阵 */ }
        }
      }
    }
    if (window.JunqiAgent) window.JunqiAgent.closeSetup();
    G.startGame(state);
    dlcInitNow();
    selected = null;
    legal = [];
    hoverPos = null;
    playSound("start");
    render();
    if (!checkHumanTurn() && state.phase === "playing" && !isHumanTurn()) scheduleAI();
  }


  // ---------- DLC 卡牌（?dlc=1 才启用） ----------
  const DLCX = window.JunqiDLC;
  const dlcPanelEl = document.getElementById("dlcPanel");
  const dlcHandEl = document.getElementById("dlcHand");
  const dlcCountEl = document.getElementById("dlcCount");
  const dlcMeritEl = document.getElementById("dlcMerit");
  const dlcConfirmEl = document.getElementById("dlcConfirm");
  const dlcDraftEl = document.getElementById("dlcDraft");
  const dlcPickRowEl = document.getElementById("dlcPickRow");
  let dlcShownOffer = "";

  // ---------- 用卡前的战地问答（答对越多等级越高） ----------
  const QUIZ = window.JunqiQuiz || null;
  const dlcQuizEl = document.getElementById("dlcQuiz");
  const quizSubEl = document.getElementById("quizSub");
  const quizStepEl = document.getElementById("quizStep");
  const quizTierEl = document.getElementById("quizTier");
  const quizQEl = document.getElementById("quizQ");
  const quizOptsEl = document.getElementById("quizOpts");
  const quizFbEl = document.getElementById("quizFb");
  const quizNextEl = document.getElementById("quizNext");
  const quizGiveUpEl = document.getElementById("quizGiveUp");
  const chkQuizEl = document.getElementById("chkQuiz");
  let quizOn = !!(chkQuizEl && chkQuizEl.checked);
  let quizCtx = null;   // { cardId, name, base, qs, idx, correct, answered, finished, onDone }
  if (chkQuizEl) chkQuizEl.addEventListener("change", () => { quizOn = !!chkQuizEl.checked; });

  // DEV 调试时不该被答题拦住 —— 那时是用来看卡效果的
  function quizAvailable() { return !!(QUIZ && QUIZ.size() >= QUIZ.PER_USE && quizOn && !devOn()); }

  function beginQuiz(cardId, name, base, onDone) {
    // Ⅲ 级卡已经满级，答题没有任何收益，直接放行（别拿无意义的两题烦人）
    if (!quizAvailable() || (base || 1) >= 3) { onDone(base); return; }
    // 同一局里不重复问同一道题（问遍整库再重来）
    const used = (state.dlc && state.dlc.quizUsed) || [];
    const qs = QUIZ.draw(QUIZ.PER_USE, null, used);
    if (state.dlc) state.dlc.quizUsed = used.concat(qs.map((q) => q.id)).slice(-400);
    quizCtx = { cardId, name, base, qs, idx: 0, correct: 0, answered: false, finished: false, onDone };
    if (dlcQuizEl) dlcQuizEl.classList.remove("hidden");
    renderQuiz();
  }

  function closeQuiz() {
    quizCtx = null;
    if (dlcQuizEl) dlcQuizEl.classList.add("hidden");
  }

  function cancelQuiz(note) {
    if (!quizCtx) return;
    closeQuiz();
    if (note) dlcNote(note);
    render();
  }

  function renderQuiz() {
    const ctx = quizCtx;
    if (!ctx || !quizQEl) return;
    const q = ctx.qs[ctx.idx];
    const lv = QUIZ.level(ctx.base, ctx.correct);
    quizSubEl.textContent = "「" + ctx.name + "」用前答 2 题：答对 1 题升 1 级，答错不扣牌。";
    quizStepEl.textContent = "第 " + (ctx.idx + 1) + " / " + ctx.qs.length + " 题";
    quizTierEl.textContent = "当前 " + QUIZ.ROMAN[lv - 1] + " 级 · 已答对 " + ctx.correct + " 题";
    quizQEl.textContent = q.q;
    quizOptsEl.innerHTML = "";
    q.o.forEach((text, i) => {
      const b = document.createElement("button");
      b.innerHTML = "<b>" + "ABC"[i] + ".</b> " + text;
      b.onclick = () => answerQuiz(i);
      quizOptsEl.appendChild(b);
    });
    quizFbEl.classList.add("hidden");
    quizFbEl.innerHTML = "";
    quizNextEl.classList.add("hidden");
    quizGiveUpEl.textContent = "不用这张卡（Esc）";
    ctx.answered = false;
    ctx.finished = false;
  }

  function answerQuiz(choice) {
    const ctx = quizCtx;
    if (!ctx || ctx.answered) return;
    const q = ctx.qs[ctx.idx];
    const ok = QUIZ.check(q, choice);
    ctx.answered = true;
    if (ok) ctx.correct += 1;
    Array.prototype.forEach.call(quizOptsEl.children, (b, i) => {
      b.disabled = true;
      if (i === q.a) b.classList.add("right");
      else if (i === choice) b.classList.add("wrong");
    });
    quizFbEl.innerHTML = (ok ? '<span class="ok">✓ 答对了</span>' : '<span class="no">✗ 答错了</span>')
      + "　正确答案：<b>" + q.o[q.a] + "</b>"
      + (q.kind ? "（" + q.kind + "）" : "")
      + (q.sec ? "　依据：" + q.sec : "");
    quizFbEl.classList.remove("hidden");
    const lv = QUIZ.level(ctx.base, ctx.correct);
    quizTierEl.textContent = "当前 " + QUIZ.ROMAN[lv - 1] + " 级 · 已答对 " + ctx.correct + " 题";
    quizNextEl.textContent = ctx.idx >= ctx.qs.length - 1 ? "看结果" : "下一题";
    quizNextEl.classList.remove("hidden");
  }

  function quizNext() {
    const ctx = quizCtx;
    if (!ctx) return;
    if (ctx.finished) {
      const lv = QUIZ.level(ctx.base, ctx.correct);
      const done = ctx.onDone;
      closeQuiz();
      done(lv);
      return;
    }
    if (ctx.idx < ctx.qs.length - 1) { ctx.idx += 1; renderQuiz(); return; }
    // 收尾页：这次按几级结算
    const lv = QUIZ.level(ctx.base, ctx.correct);
    ctx.finished = true;
    quizStepEl.textContent = "结果";
    quizTierEl.textContent = "答对 " + ctx.correct + " / " + ctx.qs.length + " 题";
    quizQEl.innerHTML = "<b>「" + ctx.name + "」按 <span class='ok'>" + QUIZ.ROMAN[lv - 1] + " 级</span> 生效</b>"
      + "<br><span style=\"opacity:.7\">" + QUIZ.upgradeText(ctx.base, ctx.correct) + "；答错也照常打出，只是等级低一点。</span>";
    quizOptsEl.innerHTML = "";
    quizFbEl.classList.add("hidden");
    quizNextEl.textContent = "用这张卡";
    quizNextEl.classList.remove("hidden");
    quizGiveUpEl.textContent = "算了（不用这张卡）";
  }

  if (quizNextEl) quizNextEl.addEventListener("click", quizNext);
  if (quizGiveUpEl) quizGiveUpEl.addEventListener("click", () => cancelQuiz("「" + (quizCtx ? quizCtx.name : "这张卡") + "」这次不用了"));


  const chkDlcEl = document.getElementById("chkDlc");
  if (chkDlcEl) {
    // 默认勾选就默认开启（分享版把 DLC 设成默认打开，靠这一句生效）
    if (chkDlcEl.checked) window.__DLC_ON__ = true;
    if (DLCX && DLCX.enabled && DLCX.enabled()) chkDlcEl.checked = true;
    chkDlcEl.addEventListener("change", () => {
      window.__DLC_ON__ = !!chkDlcEl.checked;
      if (chkDlcEl.checked && DLCX) {
        if (DLCX.wrap) DLCX.wrap();
        dlcInitNow();
      }
      render();
    });
  }
  function dlcOn() { return !!(DLCX && DLCX.enabled && DLCX.enabled()); }
  function dlcSeat() { return (state && state.human && state.human !== "none") ? state.human : HUMAN; }
  function dlcInitNow() {
    if (!dlcOn() || !state) return;
    // wrap 是幂等的：无论从勾选框、URL 参数还是默认勾选开启，都要保证 AI 出牌被挂上
    try { if (DLCX.wrap) DLCX.wrap(); } catch (e) { /* 忽略 */ }
    try { DLCX.init(state, { aiPlays: true }); } catch (e) { /* 不打断对局 */ }
  }

  function renderDLC() {
    if (!dlcPanelEl) return;
    if (!dlcOn() || !state || !state.dlc || !state.dlc.on) { dlcPanelEl.classList.add("hidden"); return; }
    dlcPanelEl.classList.remove("hidden");

    const seat = dlcSeat();
    const hand = (state.dlc.hands && state.dlc.hands[seat]) || [];
    if (dlcMeritEl) dlcMeritEl.textContent = String((state.dlc.merit && state.dlc.merit[seat]) || 0);
    if (dlcCountEl) dlcCountEl.textContent = devOn() ? (hand.length + " 张") : (hand.length + "/4");

    // 手牌
    if (dlcHandEl) {
      dlcHandEl.innerHTML = "";
      if (!hand.length) dlcHandEl.innerHTML = '<div class="d" style="opacity:.5">（暂无手牌）</div>';
      hand.forEach((h) => {
        const c = DLCX.cardOf(h.id);
        if (!c) return;
        const el = document.createElement("div");
        el.className = "dlc-card";
        const setupOnly = c.when === "setup";
        let desc = { effect: "", full: c.name };
        try { desc = DLCX.describeCard(h.id, h.tier) || desc; } catch (e) { /* 忽略 */ }
        const compH = DLCX.cardComplexity ? DLCX.cardComplexity(h.id) : { level: 0, label: "简单" };
        el.innerHTML = '<div class="t"><span>' + c.name + '</span><span class="tr">' + "ⅠⅡⅢ"[h.tier - 1] + ' 级</span></div>'
          + '<div class="d">' + c.id + ' · ' + c.book + ' · ' + c.tag
          + ' · <span class="cx cx' + compH.level + '">' + compH.label + '</span>'
          + (setupOnly ? ' · 布阵阶段生效' : '') + '</div>'
          + '<div class="e">' + desc.effect + '</div>';
        el.title = desc.full + "（点一下使用）";
        el.onclick = setupOnly ? null : () => armCard(h.id);
        if (setupOnly) el.style.opacity = ".55";
        if (armed && armed.cardId === h.id) el.className = "dlc-card armed";
        dlcHandEl.appendChild(el);
      });
    }

    // 已经生效的被动战术（抽到即生效，不进手牌，但得让人看得见）
    const pasEl = document.getElementById("dlcPassive");
    if (pasEl) {
      const list = (state.dlc.passiveTaken && state.dlc.passiveTaken[seat]) || [];
      if (!list.length) {
        pasEl.classList.add("hidden");
      } else {
        pasEl.classList.remove("hidden");
        pasEl.innerHTML = "已生效：" + list.map((x) => {
          const c = DLCX.cardOf(x.id);
          return c ? '<span class="tag">' + c.name + "</span>" : "";
        }).join("、");
      }
    }

    // 正在选目标时给一句提示
    if (dlcConfirmEl) {
      if (armed) {
        const a = armed;
        const done = armedPicks(a).length;
        const where = a.step === 1 ? "目标" : "落点";
        const lvTag = (a.tier || 1) > 1 ? "「" + ["Ⅰ", "Ⅱ", "Ⅲ"][Math.min(2, (a.tier || 1) - 1)] + " 级」" : "";
        dlcConfirmEl.innerHTML = '<div><b>' + a.name + lvTag + '</b>：请在棋盘上点' + where
          + '（' + done + "/" + a.need + '，绿格为可选；再点已选的格子可取消）</div>'
          + '<div style="opacity:.6;margin-top:4px">点这张卡本身或按 Esc 放弃</div>';
        dlcConfirmEl.classList.remove("hidden");
      } else if (!dlcShownOffer) {
        dlcConfirmEl.classList.add("hidden");
        dlcConfirmEl.innerHTML = "";
      }
    }

    // 三选一
    const offer = state.dlc.offers && state.dlc.offers[seat];
    if (offer && !offer.taken && state.phase === "playing") {
      const key = offer.reason + "@" + (offer.three || []).map((x) => x.id).join(",");
      if (key !== dlcShownOffer) {
        dlcShownOffer = key;
        dlcShowDraft(offer);
      }
    } else if (dlcDraftEl) {
      dlcDraftEl.classList.add("hidden");
      dlcShownOffer = "";
    }
  }

  function dlcShowDraft(offer) {
    if (!dlcDraftEl || !dlcPickRowEl) return;
    dlcPickRowEl.innerHTML = "";
    (offer.three || []).forEach((x) => {
      const c = DLCX.cardOf(x.id);
      if (!c) return;
      const el = document.createElement("div");
      el.className = "pc";
      let desc = { effect: "", full: c.name };
      try { desc = DLCX.describeCard(x.id, x.tier) || desc; } catch (e) { /* 文案失败不影响选牌 */ }
      const compD = DLCX.cardComplexity ? DLCX.cardComplexity(x.id) : { level: 0, label: "简单", why: [] };
      el.innerHTML = '<div class="id">' + c.id + ' · ' + c.book + '</div>'
        + '<div class="nm">' + c.name + '</div>'
        + '<div class="tr">' + "ⅠⅡⅢ"[x.tier - 1] + ' 级'
        + ' <span class="cx cx' + compD.level + '">' + compD.label + '</span></div>'
        + '<div class="tag">' + c.tag + '</div>'
        + '<div class="ef">' + desc.effect + '</div>';
      el.title = desc.full;
      el.onclick = () => {
        DLCX.take(state, dlcSeat(), x.id);
        dlcDraftEl.classList.add("hidden");
        dlcShownOffer = "";
        render();
      };
      dlcPickRowEl.appendChild(el);
    });
    // 兜底：三张都渲染不出来时（卡被移除 / id 对不上），这个弹窗会永久挡住棋盘。
    // 遇到就当作已放弃，直接放行，绝不能让"选牌"把整局卡死。
    if (!dlcPickRowEl.children.length) {
      try { DLCX.take(state, dlcSeat(), (offer.three[0] || {}).id); } catch (e) { /* 忽略 */ }
      offer.taken = offer.taken || "skip";
      dlcDraftEl.classList.add("hidden");
      state.log.push("【战术】三选一没有可选项，已自动跳过。");
      return;
    }
    dlcDraftEl.classList.remove("hidden");
  }

  // ---------- 手牌使用：点卡 →（主动卡）点目标 → 生效 ----------
  // 设计：DEV 只是"把卡塞进手牌"的开关，不参与棋盘点击；
  // 手牌只在**自己的回合**能点；被动卡点了立刻生效；主动卡点了进入选目标状态。
  let armed = null;   // { cardId, name, tier, seat, step, picks, picks2, cands, cands2, need }
  const NO_PICK_KINDS = ["none", "allOwn", "allEnemy", "peekSpread"];

  function dlcHandEntry(seat, cardId) {
    const hand = (state.dlc && state.dlc.hands && state.dlc.hands[seat]) || [];
    return hand.find((h) => h.id === cardId) || null;
  }

  function dlcNote(text) {
    if (!state) return;
    if (!Array.isArray(state.log)) state.log = [];
    state.log.push("【战术】" + text);
    state.log = state.log.slice(-200);
  }

  function cardUseBlocker() {
    if (!state || state.phase !== "playing") return "现在不在对局中";
    if (!isHumanTurn()) return "只能在自己的回合使用战术卡";
    return null;
  }

  function candPositions(binds) {
    const out = [];
    for (const b of binds || []) {
      if (b.target && b.target.position) out.push(b.target.position);
      if (b.cells) for (const c of b.cells) out.push(c);
    }
    return out;
  }

  // 这张卡这一手要选几个目标（count 为 0/缺省视作"全部"）
  // 与 dlc.js 的 specOf 对齐：Ⅲ 级可能换选择器（数量 1→3、范围 enemyHazard→enemyHazardAll），
  // UI 若还按 Ⅰ 级的选择器算「要选几个」，答完题也只会让你点 1 个 —— 看起来就像定级没生效。
  function specOfCard(card, tierLv, which) {
    const by = which === 2 ? card.sel2ByTier : card.selectByTier;
    const i = Math.min(2, Math.max(0, (tierLv || 1) - 1));
    if (by && by[i]) return by[i];
    return which === 2 ? card.sel2 : card.select;
  }

  function needOf(card, tierLv, which) {
    const sel = specOfCard(card, tierLv, which) || {};
    const tier = (card.tiers && card.tiers[Math.min(2, (tierLv || 1) - 1)]) || {};
    let n = sel.count;
    if (typeof n === "string" && n.charAt(0) === "$") n = tier[n.slice(1)];
    if (n === 0 || n == null) return 0;
    const num = Number(n);
    return Number.isFinite(num) && num > 0 ? num : 0;
  }

  // 点手牌里的卡：被动立即生效；主动先答题定级，再进入"选目标"
  function armCard(cardId) {
    if (armed && armed.cardId === cardId) { cancelArm(); return; }
    if (quizCtx) return;                       // 答题没结束前不许再点牌
    const block = cardUseBlocker();
    if (block) { dlcNote(block); render(); return; }
    const seat = dlcSeat();
    const entry = dlcHandEntry(seat, cardId);
    const c = DLCX.cardOf(cardId);
    if (!entry || !c) return;
    const tier = entry.tier || 1;

    if (c.when === "passive") {
      let r = null;
      try { r = DLCX.usePassive(state, seat, cardId); } catch (e) { r = { ok: false, msg: e.message }; }
      finishCard(r);
      return;
    }

    // 主动卡：先答 2 题，按答对数决定这次按几级结算（DEV 或关掉「答题定级」时用手牌等级）
    beginQuiz(cardId, c.name, tier, (lv) => proceedArm(cardId, c, lv, seat));
  }

  function proceedArm(cardId, c, tier, seat) {
    const kind = (specOfCard(c, tier, 1) || {}).kind || "none";
    if (NO_PICK_KINDS.indexOf(kind) >= 0) {          // 全场/无目标：点了就用
      executeCard(cardId, tier, null, null);
      return;
    }
    let lv = tier;
    let cands = [];
    const bindAt = (k) => {
      try { return DLCX.bindingsFor(state, seat, cardId, 1, [], k, true) || []; } catch (e) { return []; }
    };
    cands = bindAt(lv);
    // Ⅲ 级的目标条件往往更严（例如"敌方军长以上"），可能一个都选不出来。
    // 这时退到"能打出的最高等级"，别让玩家白答两题还什么都不能用。
    if (!cands.length && lv > 1) {
      for (let k = lv - 1; k >= 1; k -= 1) {
        const cb = bindAt(k);
        if (cb.length) {
          cands = cb;
          dlcNote("「" + c.name + "」" + ["Ⅰ", "Ⅱ", "Ⅲ"][lv - 1] + " 级现在没有符合条件的目标，改按 "
            + ["Ⅰ", "Ⅱ", "Ⅲ"][k - 1] + " 级打出");
          lv = k;
          break;
        }
      }
    }
    if (!cands.length) { dlcNote("「" + c.name + "」现在没有可选的目标"); render(); return; }

    const want = needOf(c, lv);
    const need = want > 0 ? Math.min(want, cands.length) : cands.length;
    armed = { cardId, name: c.name, tier: lv, seat, step: 1, picks: [], picks2: [], cands, cands2: null, need };
    selected = null;
    legal = candPositions(cands);
    hoverPos = null;
    playSound("select");
    render();
  }

  function cancelArm() {
    if (!armed) return;
    armed = null;
    legal = [];
    hoverPos = null;
    render();
  }

  // 已选的数量（第 2 步单独算）
  function armedPicks(a) { return a.step === 1 ? a.picks : a.picks2; }

  function handleArmedClick(pos) {
    const a = armed;
    const list = a.step === 1 ? a.cands : (a.cands2 || []);
    const hit = list.find((b) => (b.target && b.target.position === pos)
      || (b.cells && b.cells.indexOf(pos) >= 0));
    if (!hit) {
      dlcNote("这里不是「" + a.name + "」能选的目标（再点一次卡片可放弃）");
      render();
      return;
    }
    const picks = armedPicks(a);
    const at = picks.indexOf(hit);
    if (at >= 0) { picks.splice(at, 1); render(); return; }   // 再点一次取消这一枚
    picks.push(hit);
    if (picks.length < a.need) { render(); return; }
    advanceArm();
  }

  // 收满目标：有第二选择器就进第二步，否则直接执行
  function advanceArm() {
    const a = armed;
    const c = DLCX.cardOf(a.cardId);
    if (a.step === 1 && c && specOfCard(c, a.tier, 2)) {
      let c2 = [];
      try { c2 = DLCX.bindingsFor(state, a.seat, a.cardId, 2, a.picks, a.tier, true) || []; } catch (e) { c2 = []; }
      if (c2.length) {
        a.step = 2;
        a.cands2 = c2;
        a.picks2 = [];
        const w2 = needOf(c, a.tier, 2);
        a.need = w2 > 0 ? Math.min(w2, c2.length) : c2.length;
        legal = candPositions(c2);
        render();
        return;
      }
      // 没得选就用系统默认落点
    }
    executeCard(a.cardId, a.tier, a.picks, a.picks2 && a.picks2.length ? a.picks2 : null);
  }

  function executeCard(cardId, tier, forced1, forced2) {
    const seat = dlcSeat();
    let r = null;
    // 第 8 个参数是"这次按几级结算"：答题定出来的等级要压过手牌上写的等级
    try { r = DLCX.play(state, seat, cardId, tier, forced1, false, forced2, tier); } catch (e) { r = { ok: false, msg: e.message }; }
    finishCard(r);
  }

  function finishCard(r) {
    armed = null;
    selected = null;
    legal = [];
    hoverPos = null;
    if (dlcConfirmEl) { dlcConfirmEl.classList.add("hidden"); dlcConfirmEl.innerHTML = ""; }
    if (r && r.ok) {
      playSound("capture");            // 日志由 DLC 自己写（带等级与目标）
    } else {
      state.log.push("【战术】打不出：" + ((r && r.msg) || "未知原因"));
    }
    render();
    // 卡生效后立刻回到正常对局：轮到 AI 就继续走，轮到自己但没子可动就自动跳过
    if (state.phase === "playing") {
      if (isHumanTurn()) checkHumanTurn();
      else scheduleAI();
    }
  }

  // ---------- 开发者模式：随时取任意卡生效 ----------
  const devPanelEl = document.getElementById("devPanel");
  const devListEl = document.getElementById("devList");
  const devSearchEl = document.getElementById("devSearch");
  const devBookEl = document.getElementById("devBook");
  const devComplexEl = document.getElementById("devComplex");
  const devSummaryEl = document.getElementById("devSummary");
  const devSeatEl = document.getElementById("devSeat");
  const devTiersEl = document.getElementById("devTiers");
  const devStatusEl = document.getElementById("devStatus");
  const devStatusNEl = document.getElementById("devStatusN");
  const devLogEl = document.getElementById("devLog");
  const chkDevEl = document.getElementById("chkDev");
  let devTier = 1;
  let devSnap = null;          // 每次 DEV 执行前的局面快照
  const devLogLines = [];

  function devOn() { return !!window.__DEV_ON__ && !!(DLCX && DLCX.devPlay); }

  function devLog(cls, text) {
    devLogLines.push({ cls, text });
    if (devLogLines.length > 60) devLogLines.shift();
    if (devLogEl) {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      devLogEl.appendChild(d);
      while (devLogEl.children.length > 60) devLogEl.removeChild(devLogEl.firstChild);
      devLogEl.scrollTop = devLogEl.scrollHeight;
    }
  }

  function devSeat() {
    return (devSeatEl && devSeatEl.value) || dlcSeat();
  }

  function devRenderList() {
    if (!devListEl || !devOn() || !DLCX.allCards) return;
    const q = (devSearchEl && devSearchEl.value || "").trim().toLowerCase();
    const book = (devBookEl && devBookEl.value) || "";
    const cx = (devComplexEl && devComplexEl.value) || "";
    // 全库难度分布：让"简单/复杂各有多少"一眼可见
    if (devSummaryEl && DLCX.cardComplexity) {
      const all = DLCX.allCards();
      const n = [0, 0, 0];
      for (const c of all) n[DLCX.cardComplexity(c.id).level] += 1;
      devSummaryEl.innerHTML = "共 <b>" + all.length + "</b> 张："
        + '<span class="cx cx0">简单 ' + n[0] + "</span> "
        + '<span class="cx cx1">普通 ' + n[1] + "</span> "
        + '<span class="cx cx2">复杂 ' + n[2] + "</span>";
    }
    const cards = DLCX.allCards().filter((c) => {
      if (book && c.book !== book) return false;
      if (cx !== "" && DLCX.cardComplexity && DLCX.cardComplexity(c.id).level !== Number(cx)) return false;
      if (!q) return true;
      const hint = (c.ai && c.ai.hint) || "";
      return (c.id + c.name + (c.tag || "") + hint).toLowerCase().includes(q);
    });
    devListEl.innerHTML = "";
    for (const c of cards) {
      const el = document.createElement("div");
      el.className = "dev-card";
      const tag = c.when === "passive" ? '<span class="p">被动</span>' : "";
      let desc = { full: c.name, effect: "" };
      try { desc = DLCX.describeCard(c.id, devTier) || desc; } catch (e) { /* 忽略 */ }
      const comp = DLCX.cardComplexity ? DLCX.cardComplexity(c.id) : { level: 0, label: "简单", why: [] };
      el.innerHTML = '<div class="l">' + c.id + " " + c.name
        + '<span class="cx cx' + comp.level + '">' + comp.label + "</span></div>"
        + '<div class="r"><span class="k">' + c.tag + "</span> " + tag + "</div>"
        + '<div class="ef">' + (desc.effect || "") + "</div>";
      if (comp.why && comp.why.length) el.title += "\n难度：" + comp.why.join("、");
      el.title = c.id + " " + desc.full + "\n" + (c.book || "") + " · " + (c.when === "passive" ? "被动" : "主动");
      el.onclick = () => devExec(c);
      devListEl.appendChild(el);
    }
    if (!cards.length) devListEl.innerHTML = '<div class="dev-card" style="opacity:.5">没有匹配的卡</div>';
  }

  // state 里有两类结构 JSON 存不下：hqCaptured / domain 是 Set，repCounts 是 Map。
  // 直接 JSON.stringify 会变成 {}，回滚后第一次走子就崩在 repCounts.get is not a function。
  function devSnapSave() {
    try {
      devSnap = JSON.stringify(state, (k, v) => {
        if (v instanceof Set) return { __set: [...v] };
        if (v instanceof Map) return { __map: [...v] };
        return v;
      });
    } catch (e) { devSnap = null; }
  }

  function devSnapRestore() {
    if (!devSnap) return false;
    let obj = null;
    try {
      obj = JSON.parse(devSnap, (k, v) => {
        if (v && v.__set) return new Set(v.__set);
        if (v && v.__map) return new Map(v.__map);
        return v;
      });
    } catch (e) { return false; }
    // 保留 state 的对象引用（其它闭包都指着它），只替换内容
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, obj);
    return true;
  }

  // DEV 列表点一下 = 加进手牌（被动卡没有目标，直接生效）
  function devExec(card) {
    if (!state || !state.dlc || !state.dlc.on) { devLog("no", "✗ 先开启 DLC"); return; }
    if (state.phase !== "playing") {
      devLog("no", "✗ 现在是对局外（" + (state.phase || "未开局") + "），开局后再试");
      return;
    }
    const seat = devSeat();
    devSnapSave();
    let r = null;
    try { r = DLCX.devGive(state, seat, card.id, devTier); } catch (e) { r = { ok: false, msg: e.message }; }
    if (r && r.ok) {
      devLog("ok", "＋ " + card.id + " " + card.name + " " + "ⅠⅡⅢ"[devTier - 1] + " 级 已加入手牌"
        + (r.passive ? "（被动卡，点一下生效）" : "（点卡片使用）"));
      render();
    } else {
      devLog("no", "✗ " + card.id + " " + card.name + "：" + ((r && r.msg) || "未知原因"));
    }
  }

  // DEV 列表点一下 = 加进手牌（被动卡没有目标，直接生效）
  function devExec(card) {
    if (!state || !state.dlc || !state.dlc.on) { devLog("no", "✗ 先开启 DLC"); return; }
    if (state.phase !== "playing") {
      devLog("no", "✗ 现在是对局外（" + (state.phase || "未开局") + "），开局后再试");
      return;
    }
    const seat = devSeat();
    devSnapSave();
    let r = null;
    try { r = DLCX.devGive(state, seat, card.id, devTier); } catch (e) { r = { ok: false, msg: e.message }; }
    if (r && r.ok) {
      devLog("ok", "＋ " + card.id + " " + card.name + " " + "ⅠⅡⅢ"[devTier - 1] + " 级 已加入手牌"
        + (r.passive ? "（被动卡，点一下生效）" : "（点卡片使用）"));
      render();
    } else {
      devLog("no", "✗ " + card.id + " " + card.name + "：" + ((r && r.msg) || "未知原因"));
    }
  }

  function devRenderStatus() {
    if (!devStatusEl || !devOn() || !state) return;
    const list = (DLCX.statusList && DLCX.statusList(state)) || [];
    if (devStatusNEl) devStatusNEl.textContent = String(list.length);
    devStatusEl.innerHTML = "";
    if (!list.length) {
      devStatusEl.innerHTML = '<div style="opacity:.45">（无）</div>';
      return;
    }
    for (const st of list) {
      const d = document.createElement("div");
      d.innerHTML = st.key + " · " + st.who
        + (st.until != null ? ' <span class="u">' + st.until + '手</span>' : "") + st.val;
      devStatusEl.appendChild(d);
    }
  }

  function devRender() {
    if (!devPanelEl) return;
    if (!devOn() || !state) { devPanelEl.classList.add("hidden"); return; }
    devPanelEl.classList.remove("hidden");
    devRenderStatus();
  }

  function devToggle(on) {
    window.__DEV_ON__ = !!on;
    if (chkDevEl && chkDevEl.checked !== !!on) chkDevEl.checked = !!on;
    if (on) {
      // 开发模式默认把 DLC 一起打开
      if (chkDlcEl && !chkDlcEl.checked) { chkDlcEl.checked = true; chkDlcEl.dispatchEvent(new Event("change")); }
      devRenderList();
      devRender();
    } else if (devPanelEl) {
      devPanelEl.classList.add("hidden");
    }
  }

  // 卷筛选下拉
  if (devBookEl && DLCX && DLCX.allCards) {
    const books = [...new Set(DLCX.allCards().map((c) => c.book))];
    for (const b of books) {
      const o = document.createElement("option");
      o.value = b; o.textContent = b;
      devBookEl.appendChild(o);
    }
  }
  if (chkDevEl) {
    chkDevEl.addEventListener("change", () => devToggle(chkDevEl.checked));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "F2") { e.preventDefault(); devToggle(!window.__DEV_ON__); }
    if (e.key === "Escape" && quizCtx) { e.preventDefault(); cancelQuiz("答题没做完，这张卡先不打了"); return; }
    if (e.key === "Escape" && armed) { e.preventDefault(); cancelArm(); }
  });
  if (devSearchEl) devSearchEl.addEventListener("input", devRenderList);
  if (devBookEl) devBookEl.addEventListener("change", devRenderList);
  if (devComplexEl) devComplexEl.addEventListener("change", devRenderList);
  if (devTiersEl) {
    devTiersEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-tier]");
      if (!btn) return;
      devTier = Number(btn.dataset.tier);
      [...devTiersEl.children].forEach((b) => b.classList.toggle("on", b === btn));
      devRenderList();
    });
  }
  const devCloseEl = document.getElementById("devClose");
  if (devCloseEl) devCloseEl.onclick = () => devToggle(false);
  const devMeritEl = document.getElementById("devMerit");
  if (devMeritEl) devMeritEl.onclick = () => {
    if (!state || !state.dlc) return;
    const seat = devSeat();
    state.dlc.merit = state.dlc.merit || {};
    state.dlc.merit[seat] = (state.dlc.merit[seat] || 0) + 30;
    devLog("ok", "军功：" + seat + " +30 → " + state.dlc.merit[seat]);
    render();
  };
  const devUndoEl = document.getElementById("devUndo");
  if (devUndoEl) devUndoEl.onclick = () => {
    if (!state) return;
    if (devSnapRestore()) {
      devLog("ok", "↶ 已回滚到上一次 DEV 执行前");
      render();
    } else {
      devLog("no", "✗ 没有可回滚的快照");
    }
  };
  const devClearStEl = document.getElementById("devClearSt");
  if (devClearStEl) devClearStEl.onclick = () => {
    if (!state) return;
    const n = DLCX.clearStatuses(state);
    devLog("ok", "清空持续状态 " + n + " 条");
    render();
  };
  // 也支持 ?dev=1 直接进开发者模式
  if (typeof location !== "undefined" && /[?&]dev=1/.test(location.search || "")) {
    devToggle(true);
  }

  const devClearLogEl = document.getElementById("devClearLog");
  if (devClearLogEl) devClearLogEl.onclick = () => {
    devLogLines.length = 0;
    if (devLogEl) devLogEl.innerHTML = "";
  };

  // ---------- 作弊选子 ----------
  const cheatCounts = {};
  function resetCheat() {
    for (const type of Object.keys(B.PIECE_INFO)) cheatCounts[type] = 0;
    renderCheat();
  }
  function cheatTotalCount() {
    return Object.values(cheatCounts).reduce((a, b) => a + b, 0);
  }
  function renderCheat() {
    const order = ["flag", "commander", "army", "division", "brigade", "regiment", "battalion", "company", "platoon", "engineer", "mine", "bomb"];
    cheatList.innerHTML = order.map((type) => {
      const info = B.PIECE_INFO[type];
      const max = info.count * 4;
      const n = cheatCounts[type] || 0;
      return `<div class="cheat-row">
        <span class="cname">${info.name}</span>
        <span class="cavail">${n}/${max}</span>
        <button type="button" data-type="${type}" data-delta="-1" ${n <= 0 ? "disabled" : ""}>−</button>
        <span class="cnum">${n}</span>
        <button type="button" data-type="${type}" data-delta="1" ${n >= max ? "disabled" : ""}>+</button>
      </div>`;
    }).join("");
    const total = cheatTotalCount();
    cheatTotal.textContent = total < 25 ? `${total} / 25 · 不足随机补满` : `${total} / 25`;
    cheatConfirm.disabled = total > 25;
  }
  function openCheat() {
    if (!state || state.phase !== "setup" || state.mode !== "chaos") return;
    resetCheat();
    cheatModal.classList.remove("hidden");
  }
  function closeCheat() {
    cheatModal.classList.add("hidden");
  }

  cheatList.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-type]");
    if (!btn) return;
    const type = btn.getAttribute("data-type");
    const delta = Number(btn.getAttribute("data-delta"));
    const info = B.PIECE_INFO[type];
    const max = info.count * 4;
    const next = Math.max(0, Math.min(max, (cheatCounts[type] || 0) + delta));
    if (delta > 0 && cheatTotalCount() >= 25 && next > (cheatCounts[type] || 0)) return;
    cheatCounts[type] = next;
    renderCheat();
  });
  cheatCancel.addEventListener("click", closeCheat);
  cheatConfirm.addEventListener("click", () => {
    if (cheatTotalCount() > 25) return;
    const types = [];
    for (const [type, n] of Object.entries(cheatCounts)) {
      for (let i = 0; i < n; i += 1) types.push(type);
    }
    try {
      state = G.newCheatGame(types, {
        latentSeats: readLatentSeats(),
        humanSeats: humanSeats(),
        agentSeats: agentSeats.slice(),
        infoMode: viewMode === "full" ? "all" : (viewMode === "double" ? "team" : "normal"),
        history: true,
      });
      assignAIProfiles(state);
      selected = null; legal = []; hoverPos = null;
      closeCheat();
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  function buildReplayFaceMap(frames) {
    const map = new Map();
    const first = frames[0];
    const cheating = !!(first && ((first.latentSeats && Object.values(first.latentSeats).some(Boolean))
      || (first.pieces || []).some((p) => p.latent)));
    const recs = new Map();
    for (const frame of frames) {
      for (const p of frame.pieces || []) {
        if (p.owner !== HUMAN) { map.set(p.id, p.type); continue; }
        const rec = recs.get(p.id) || { id: p.id, pos: p.position, type: p.type, actual: null, fixed: null };
        if (p.position) rec.pos = p.position;
        rec.type = p.type;
        if (p.actualType) rec.actual = p.actualType;
        if (!p.latent && p.type) rec.fixed = p.type;
        recs.set(p.id, rec);
      }
    }

    if (!cheating) {
      for (const rec of recs.values()) map.set(rec.id, rec.actual || rec.fixed || rec.type);
      return map;
    }

    const pool = G.armyTypes();
    const assigned = new Map();
    const take = (rec, type) => {
      const i = pool.indexOf(type);
      if (i < 0) return false;
      pool.splice(i, 1);
      assigned.set(rec.id, type);
      return true;
    };
    const canPlaceAt = (type, pos) => !pos || G.canPlace(type, HUMAN, pos, { allowMineRow3: true });
    const pick = (rec, prefs) => {
      for (const type of prefs) {
        if (!pool.includes(type) || !canPlaceAt(type, rec.pos)) continue;
        take(rec, type);
        return true;
      }
      return false;
    };

    // 先保留军旗/地雷、最后实际身份
    for (const rec of recs.values()) if (rec.fixed === "flag" || rec.fixed === "mine") take(rec, rec.fixed);
    for (const rec of recs.values()) if (!assigned.has(rec.id) && rec.actual) take(rec, rec.actual);
    for (const rec of recs.values()) if (!assigned.has(rec.id) && rec.fixed) take(rec, rec.fixed);

    const hqIds = B.hqCells(HUMAN);
    const hqRecs = [...recs.values()].filter((r) => !assigned.has(r.id) && r.pos && hqIds.includes(r.pos));
    const flagAssigned = [...assigned.values()].includes("flag");
    if (!flagAssigned && pool.includes("flag") && hqRecs.length) take(hqRecs[0], "flag");
    for (const rec of hqRecs) {
      if (assigned.has(rec.id)) continue;
      pick(rec, ["mine", "platoon", "company", "engineer", "battalion", "regiment", "brigade", "division", "army", "commander"]);
    }

    const rowOf = (rec) => {
      if (!rec.pos) return 99;
      const node = B.BOARD.byId.get(rec.pos);
      return node ? node.row : 99;
    };
    const unassigned = [...recs.values()].filter((r) => !assigned.has(r.id)).sort((a, b) => rowOf(a) - rowOf(b));
    for (const rec of unassigned) {
      const row = rowOf(rec);
      const prefs = row === 0
        ? ["engineer", "platoon", "company", "battalion", "regiment", "brigade", "division", "army", "commander"]
        : row >= 4
          ? ["mine", "engineer", "platoon", "company", "battalion", "regiment", "brigade", "division", "army", "commander"]
          : ["company", "platoon", "engineer", "battalion", "regiment", "brigade", "division", "army", "commander", "bomb"];
      if (pick(rec, prefs)) continue;
      const any = pool.find((type) => canPlaceAt(type, rec.pos));
      if (any) { take(rec, any); continue; }
      if (pool.length) take(rec, pool[0]);
    }

    for (const rec of recs.values()) {
      map.set(rec.id, assigned.get(rec.id) || rec.actual || rec.type);
    }
    return map;
  }

  function applyReplayFaces(snapshot) {
    for (const p of snapshot.pieces || []) {
      p.replayType = replayFaceMap.get(p.id) || p.actualType || p.type;
    }
    return snapshot;
  }

  // ---------- 存盘 / 读档 / 复盘 ----------
  function saveGame() {
    if (!state || replayMode) return;
    const payload = {
      v: 1,
      savedAt: Date.now(),
      state: G.serializeState(state),
      history: (state.historyFrames || []).slice(),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      state.log.push("已存盘（本机浏览器）。");
      render();
    } catch (err) {
      try {
        payload.history = [];
        localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
        state.log.push("已存当前局面；复盘记录过长，未写入存档。");
        render();
      } catch (err2) {
        alert("存盘失败：浏览器存储不可用或空间不足。");
      }
    }
  }

  function setReplayView(view) {
    if (!replayMode || !(view in VIEW_ANGLE)) return;
    replayView = view;
    playSound("select");
    render();
  }

  function toggleReplaySide(side) {
    if (!replayMode) return;
    const own = state.pieces.filter((p) => p.owner === side && p.position);
    if (!own.length) return;
    const allHidden = own.every((p) => replayHiddenIds.has(p.id));
    for (const p of own) {
      if (allHidden) replayHiddenIds.delete(p.id);
      else replayHiddenIds.add(p.id);
    }
    playSound("select");
    render();
  }

  // ---------- 复盘：保存到文件 + 本机复盘库 ----------
  function currentReplayFrames() {
    if (replayMode && replayFrames.length) return replayFrames;
    const live = (state && state.historyFrames) || [];
    return live.length >= 2 ? live.slice() : null;
  }

  function replayFileName(frames) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const mode = (frames[0] && frames[0].mode) === "standard" ? "一般军棋" : "乱战四国";
    return `军棋复盘-${mode}-${stamp}-${frames.length}帧.json`;
  }

  function readReplayLib() {
    try {
      const raw = localStorage.getItem(REPLAY_LIB_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) { return []; }
  }

  function writeReplayLib(lib) {
    try {
      localStorage.setItem(REPLAY_LIB_KEY, JSON.stringify(lib));
      return true;
    } catch (err) {
      return false;
    }
  }

  // 旧版单槽存档迁移进复盘库（只做一次）
  function migrateOldReplaySlot() {
    let raw = null;
    try { raw = localStorage.getItem(REPLAY_KEY); } catch (err) { return; }
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      const frames = obj && Array.isArray(obj.frames) ? obj.frames : null;
      if (frames && frames.length >= 2) {
        const lib = readReplayLib();
        if (!lib.some((x) => x.savedAt === obj.savedAt)) {
          lib.unshift({
            id: String(obj.savedAt || Date.now()),
            name: "旧存档复盘-" + frames.length + "帧",
            savedAt: obj.savedAt || Date.now(),
            count: frames.length,
            frames,
          });
          writeReplayLib(lib.slice(0, REPLAY_LIB_MAX));
        }
      }
    } catch (err) { /* ignore */ }
    try { localStorage.removeItem(REPLAY_KEY); } catch (err) { /* ignore */ }
  }

  function saveReplay() {
    const frames = currentReplayFrames();
    if (!frames) {
      alert("还没有可保存的复盘：先下几步再试。");
      return;
    }
    const name = replayFileName(frames);
    const payload = { v: 2, kind: "junqi-replay", savedAt: Date.now(), name, frames };

    // 1) 下载成文件（总是可用）
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      alert("导出复盘文件失败：" + err.message);
    }

    // 2) 尽量在本机复盘库留一份（最多 3 份；空间不足就只保留文件）
    const lib = readReplayLib();
    lib.unshift({ id: String(payload.savedAt), name, savedAt: payload.savedAt, count: frames.length, frames });
    while (lib.length > REPLAY_LIB_MAX) lib.pop();
    const kept = writeReplayLib(lib);
    if (state && state.log) {
      state.log.push(`复盘已保存：${name}` + (kept ? "（本机库 + 文件）" : "（仅文件，本机库空间不足）"));
    }
    if (state) render();
  }

  // 一局下完自动在本机复盘库留一份，命名用「模式 + 对局时间」，不用每次手动点保存。
  // 手动「保存复盘」仍然会额外导出一个 json 文件。
  function autoSaveReplay() {
    if (!state || state.phase !== "over") return;
    const frames = currentReplayFrames();
    if (!frames || frames.length < 2) return;
    const name = replayFileName(frames);
    const key = `${name}|${state.winner || "draw"}`;
    if (autoSaveKey === key) return;
    autoSaveKey = key;
    const lib = readReplayLib();
    if (lib.some((x) => x.name === name)) return;
    lib.unshift({ id: String(Date.now()), name, savedAt: Date.now(), count: frames.length, frames });
    while (lib.length > REPLAY_LIB_MAX) lib.pop();
    const kept = writeReplayLib(lib);
    if (state.log) {
      state.log.push(kept ? `本局复盘已存入本机库：${name}` : "本机复盘库空间不足，未能自动保存");
      state.log = state.log.slice(-200);
    }
  }

  function openReplayLibrary() {
    if (!replayModal) return;
    renderReplayList();
    replayModal.classList.remove("hidden");
  }

  function closeReplayLibrary() {
    if (replayModal) replayModal.classList.add("hidden");
  }

  // ---------- 阵法库 ----------
  function readFormLib() {
    try {
      const raw = localStorage.getItem(FORM_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) { return []; }
  }

  function writeFormLib(lib) {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(lib));
      return true;
    } catch (err) { return false; }
  }

  function currentLayout(seat) {
    const out = [];
    for (const p of state.pieces) {
      if (p.owner === seat && p.position) out.push({ pos: p.position, type: p.type });
    }
    return out;
  }

  // 把布局应用到某座位：先校验「兵种多重集」一致，再清空重排
  function applyLayout(seat, layout) {
    const pieces = state.pieces.filter((p) => p.owner === seat && p.position);
    if (!pieces.length || !layout || layout.length !== pieces.length) return false;
    const need = {};
    for (const it of layout) need[it.type] = (need[it.type] || 0) + 1;
    for (const p of pieces) {
      need[p.type] = (need[p.type] || 0) - 1;
      if (need[p.type] < 0) return false;
    }
    for (const k of Object.keys(need)) if (need[k] !== 0) return false;
    for (const p of pieces) p.position = null;
    const pool = {};
    for (const p of pieces) (pool[p.type] = pool[p.type] || []).push(p);
    for (const it of layout) {
      const arr = pool[it.type];
      if (!arr || !arr.length) return false;
      arr.pop().position = it.pos;
    }
    return true;
  }

  // 内置阵法（formations.js + formations_extra.js）转成「格子 → 兵种」，按当前座位的格子顺序铺开
  const OPEN_CELLS = (() => {
    const out = [];
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        if (B.CAMP_CELLS.has(`${r},${c}`)) continue;
        out.push([r, c]);
      }
    }
    return out;
  })();

  function bookItemLayout(book, seat) {
    const cells = OPEN_CELLS.map(([r, c]) => `${seat}-${r}-${c}`);
    if (book.layout.length !== cells.length) return null;
    return book.layout.map((t, i) => ({ pos: cells[i], type: t }));
  }

  function renderBookList(filter) {
    const box = document.getElementById("formationBook");
    if (!box) return;
    box.innerHTML = "";
    if (!state || state.mode !== "standard") {
      const tip = document.createElement("div");
      tip.className = "replay-empty";
      tip.textContent = "内置阵法是标准 25 子布局，只在「一般军棋」模式下能载入。";
      box.appendChild(tip);
      return;
    }
    const book = window.JUNQI_FORMATIONS || [];
    const kw = (filter || "").trim();
    const list = kw ? book.filter((x) => (x.name || "").includes(kw)) : book;
    const head = document.createElement("div");
    head.className = "replay-empty";
    head.textContent = `内置阵法 ${list.length} 套（本机火山军棋 VBTFILES 导出）${kw ? `，含「${kw}」` : ""}`;
    box.appendChild(head);
    for (const item of list) {
      const layout = bookItemLayout(item, setupSeat);
      if (!layout) continue;
      const row = document.createElement("div");
      row.className = "replay-item";
      const main = document.createElement("div");
      main.className = "ri-main";
      const nm = document.createElement("div");
      nm.className = "ri-name";
      nm.textContent = item.name || "内置阵法";
      const meta = document.createElement("div");
      meta.className = "ri-meta";
      meta.textContent = (item.source || "内置") + (item.tags && item.tags.length ? ` · ${item.tags.join("/")}` : "");
      main.appendChild(nm);
      main.appendChild(meta);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "载入";
      btn.addEventListener("click", () => loadFormation({ name: item.name, mode: "standard", layout }));
      row.appendChild(main);
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function renderFormList() {
    if (!formationList) return;
    const search = document.getElementById("formationSearch");
    renderBookList(search ? search.value : "");
    formationList.innerHTML = "";
    const lib = readFormLib();
    if (!lib.length) {
      const empty = document.createElement("div");
      empty.className = "replay-empty";
      empty.textContent = "还没有保存的阵法。摆好阵型后点下面的「保存当前阵法」。";
      formationList.appendChild(empty);
      return;
    }
    for (const item of lib) {
      const row = document.createElement("div");
      row.className = "replay-item";
      const main = document.createElement("div");
      main.className = "ri-main";
      const nm = document.createElement("div");
      nm.className = "ri-name";
      nm.textContent = item.name || "未命名阵法";
      const meta = document.createElement("div");
      meta.className = "ri-meta";
      const when = item.savedAt ? new Date(item.savedAt).toLocaleString() : "—";
      const mode = item.mode === "standard" ? "一般军棋" : "乱战四国";
      meta.textContent = `${when} · ${mode} · ${(item.layout || []).length} 子`;
      main.appendChild(nm);
      main.appendChild(meta);
      const btnLoad = document.createElement("button");
      btnLoad.type = "button";
      btnLoad.textContent = "载入";
      btnLoad.addEventListener("click", () => loadFormation(item));
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "ri-del";
      btnDel.textContent = "删除";
      btnDel.addEventListener("click", () => {
        writeFormLib(readFormLib().filter((x) => x.id !== item.id));
        renderFormList();
      });
      row.appendChild(main);
      row.appendChild(btnLoad);
      row.appendChild(btnDel);
      formationList.appendChild(row);
    }
  }

  function openFormationLibrary() {
    if (!state || state.phase !== "setup") { alert("只能在布阵阶段管理阵法。"); return; }
    renderFormList();
    if (formationModal) formationModal.classList.remove("hidden");
  }

  function closeFormationLibrary() {
    if (formationModal) formationModal.classList.add("hidden");
  }

  function saveFormation() {
    if (!state || state.phase !== "setup") return;
    const layout = currentLayout(setupSeat);
    if (!layout.length) { alert("当前没有可保存的棋子。"); return; }
    const lib = readFormLib();
    const def = `阵法-${B.SEAT_NAMES[setupSeat].slice(0, 1)}-${lib.length + 1}`;
    let name = def;
    try {
      const ans = window.prompt("给这个阵法起个名字：", def);
      if (ans === null) return;
      if (ans.trim()) name = ans.trim().slice(0, 24);
    } catch (err) { /* prompt 不可用则用默认名 */ }
    lib.unshift({
      id: String(Date.now()),
      name,
      mode: state.mode,
      seat: setupSeat,
      savedAt: Date.now(),
      layout,
    });
    if (!writeFormLib(lib)) { alert("本机存储空间不足，阵法未能保存。请删掉一些旧阵法或复盘。"); return; }
    renderFormList();
    playSound("select");
  }

  function loadFormation(item) {
    if (!state || state.phase !== "setup") { alert("只能在布阵阶段载入阵法。"); return; }
    if (item.mode !== state.mode) {
      alert(`这个阵法是在「${item.mode === "standard" ? "一般军棋" : "乱战四国"}」下保存的，当前模式不同，无法载入。`);
      return;
    }
    if (!applyLayout(setupSeat, item.layout)) {
      alert("兵种配置与当前模式不一致，无法载入。");
      return;
    }
    selected = null;
    hoverPos = null;
    closeFormationLibrary();
    playSound("select");
    render();
  }

  function renderReplayList() {
    if (!replayList) return;
    replayList.innerHTML = "";
    const lib = readReplayLib();
    if (!lib.length) {
      const empty = document.createElement("div");
      empty.className = "replay-empty";
      empty.textContent = "本机还没有复盘。下完一局后点「复盘」→「保存复盘」会导出文件并在这里留一份，也可以用下面的「从文件载入」。";
      replayList.appendChild(empty);
      return;
    }
    for (const item of lib) {
      const row = document.createElement("div");
      row.className = "replay-item";
      const main = document.createElement("div");
      main.className = "ri-main";
      const nm = document.createElement("div");
      nm.className = "ri-name";
      nm.textContent = item.name || "未命名复盘";
      const meta = document.createElement("div");
      meta.className = "ri-meta";
      const when = item.savedAt ? new Date(item.savedAt).toLocaleString() : "—";
      meta.textContent = `${when} · ${item.count || (item.frames || []).length} 帧`;
      main.appendChild(nm);
      main.appendChild(meta);

      const btnLoad = document.createElement("button");
      btnLoad.type = "button";
      btnLoad.textContent = "载入";
      btnLoad.addEventListener("click", () => {
        closeReplayLibrary();
        loadReplayFrames(item.frames);
      });

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "ri-del";
      btnDel.textContent = "删除";
      btnDel.addEventListener("click", () => {
        const next = readReplayLib().filter((x) => x.id !== item.id);
        writeReplayLib(next);
        renderReplayList();
      });

      row.appendChild(main);
      row.appendChild(btnLoad);
      row.appendChild(btnDel);
      replayList.appendChild(row);
    }
  }

  function loadReplayFrames(frames) {
    if (!frames || frames.length < 2) {
      alert("复盘存档没有有效帧。");
      return;
    }
    if (!replayMode) replayLive = state;
    clearTimeout(aiTimer);
    replayFrames = frames;
    replayFaceMap = buildReplayFaceMap(frames);
    replayHiddenIds = new Set();
    replayView = "south";
    replayIndex = 0;
    replayMode = true;
    state = G.deserializeState(frames[0]);
    syncViewFromState(state);
    applyReplayFaces(state);
    state.recordHistory = true;
    selected = null;
    legal = [];
    hoverPos = null;
    playSound("select");
    render();
  }

  function loadReplay() {
    migrateOldReplaySlot();
    openReplayLibrary();
  }

  function loadGame() {
    if (replayMode) return;
    let raw = null;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (err) { /* ignore */ }
    if (!raw) {
      alert("没有找到存档。");
      return;
    }
    let obj = null;
    try { obj = JSON.parse(raw); } catch (err) { alert("存档损坏，无法读取。"); return; }
    if (!obj || !obj.state) { alert("存档格式不正确。"); return; }
    let loaded = null;
    try { loaded = G.deserializeState(obj.state); } catch (err) { alert("存档恢复失败：" + err.message); return; }
    loaded.recordHistory = true;
    loaded.historyFrames = Array.isArray(obj.history) ? obj.history : [];
    state = loaded;
    syncViewFromState(loaded);
    const savedAgents = (loaded.agentSeats || []).filter((s) => B.SEATS.includes(s));
    if (savedAgents.length && savedAgents.join(",") !== agentSeats.join(",")) {
      agentSeats = savedAgents;
      persistAgentMode(agentSeats);
      if (window.JunqiAgent && !window.JunqiAgent.enabled) window.JunqiAgent.enable(agentSeats, { bridge: agentBridgeUrl() });
    }
    resultShown = false;
    replayMode = false;
    replayLive = null;
    replayFrames = [];
    replayIndex = 0;
    replayFaceMap = new Map();
    replayHiddenIds = new Set();
    replayView = "south";
    selected = null;
    legal = [];
    hoverPos = null;
    clearTimeout(aiTimer);
    state.log.push("已读档。");
    render();
    if (state.phase === "playing" && !isHumanTurn()) scheduleAI();
  }

  function showReplayFrame(index) {
    if (!replayMode || !replayFrames.length) return;
    const nextIndex = Math.max(0, Math.min(replayFrames.length - 1, index));
    if (nextIndex === replayIndex && state) return;
    replayIndex = nextIndex;
    state = G.deserializeState(replayFrames[replayIndex]);
    applyReplayFaces(state);
    state.recordHistory = true;
    selected = null;
    legal = [];
    hoverPos = null;
    playReplaySound(state);
    render();
  }

  function enterReplay() {
    if (!state || replayMode) return;
    const frames = (state.historyFrames || []).slice();
    if (frames.length < 2) {
      alert("还没有可复盘的走子记录。先下几步再试。");
      return;
    }
    clearTimeout(aiTimer);
    replayLive = state;
    replayFrames = frames;
    replayFaceMap = buildReplayFaceMap(frames);
    replayHiddenIds = new Set();
    replayView = "south";
    replayIndex = 0;
    replayMode = true;
    state = G.deserializeState(frames[0]);
    syncViewFromState(state);
    applyReplayFaces(state);
    state.recordHistory = true;
    selected = null;
    legal = [];
    hoverPos = null;
    playSound("select");
    render();
  }

  function exitReplay() {
    if (!replayMode) return;
    state = replayLive;
    replayLive = null;
    replayFrames = [];
    replayIndex = 0;
    replayFaceMap = new Map();
    replayHiddenIds = new Set();
    replayView = "south";
    replayMode = false;
    selected = null;
    legal = [];
    hoverPos = null;
    render();
    if (state && state.phase === "playing" && !isHumanTurn()) scheduleAI();
  }

  // ---------- 复盘 → 沙盘接管 ----------
  // 复盘只能看，沙盘能改。接管把两者接起来：停在任意一帧，把这一帧变成**可编辑的真实局面**，
  // 摆完子让四家 AI 从这一手接着下 —— 用来问「如果这里我换个子，AI 会怎么处理」。
  function takeoverReplay() {
    if (!replayMode || !replayFrames.length) return;
    clearTimeout(aiTimer);
    const snap = G.deserializeState(replayFrames[replayIndex]);
    if (!snap) { alert("这一帧读不出来，换个位置再试。"); return; }

    // ① 恢复真实兵种：复盘为隐藏身份写过 replayType，接管后要看真牌
    for (const p of snap.pieces) { delete p.replayType; delete p.actualType; }
    // ② 标记「接管时已阵亡」的子：它们不该回到棋子池里被重新摆上棋盘
    for (const p of snap.pieces) p._deadAtTakeover = !p.position;
    // ③ 原局里的人位由 AI 接手；缺 aiProfiles 的座位补「一代自适应」
    if (!snap.aiProfiles) snap.aiProfiles = {};
    for (const seat of B.SEATS) if (!snap.aiProfiles[seat]) snap.aiProfiles[seat] = "dyn";
    if (!snap.aiStyle) snap.aiStyle = "mixed";
    snap.recordHistory = true;
    if (!Array.isArray(snap.log)) snap.log = [];
    snap.log.push(`从复盘第 ${replayIndex} 帧接管（第 ${snap.moveCount} 手）。`);

    // ④ 退出复盘
    replayMode = false;
    replayLive = null;
    replayFrames = [];
    replayIndex = 0;
    replayFaceMap = new Map();
    replayHiddenIds = new Set();
    replayView = "south";

    state = snap;
    state.phase = "setup";          // 借 setup 阶段做编辑：棋盘点击会走 sandboxPlace
    sandboxMode = true;
    sandboxMatch = true;
    sandboxTakeover = true;
    sandboxPick = null;
    sandboxSeat = state.turn || HUMAN || "south";
    selected = null; legal = []; hoverPos = null;
    if (sandboxEl) sandboxEl.classList.remove("hidden");
    if (btnSandboxFill) btnSandboxFill.classList.add("hidden");     // 接管时不能一键重排：会毁掉局面
    if (btnSandboxClear) btnSandboxClear.classList.add("hidden");
    sandboxSay(`已接管第 ${state.moveCount} 手：可摆子，摆好点「开始对弈」让四家 AI 接着下`);
    renderSandbox();
    render();
  }

  // ---------- 事件 ----------
  svg.addEventListener("click", onBoardClick);
  svg.addEventListener("mousemove", onBoardHover);
  svg.addEventListener("mouseleave", clearHover);
  btnNew.addEventListener("click", newGame);
  if (btnSandbox) btnSandbox.addEventListener("click", enterSandbox);
  if (btnSandboxFill) btnSandboxFill.addEventListener("click", sandboxAutoFill);
  if (btnSandboxClear) btnSandboxClear.addEventListener("click", sandboxClearSeat);
  if (btnSandboxStart) btnSandboxStart.addEventListener("click", sandboxStart);
  if (btnSandboxExit) btnSandboxExit.addEventListener("click", exitSandbox);
  if (btnTakeover) btnTakeover.addEventListener("click", takeoverReplay);
  btnStart.addEventListener("click", startGame);
  btnSave.addEventListener("click", saveGame);
  btnLoad.addEventListener("click", loadGame);
  btnReplay.addEventListener("click", () => { if (replayMode) exitReplay(); else enterReplay(); });
  btnReplayPrev.addEventListener("click", () => showReplayFrame(replayIndex - 1));
  btnReplayNext.addEventListener("click", () => showReplayFrame(replayIndex + 1));
  btnReplayExit.addEventListener("click", exitReplay);
  btnSaveReplay.addEventListener("click", saveReplay);
  btnLoadReplay.addEventListener("click", loadReplay);
  btnReplayAll.addEventListener("click", () => {
    if (!replayMode) return;
    if (replayHiddenIds.size) replayHiddenIds.clear();
    else for (const p of state.pieces) if (p.position) replayHiddenIds.add(p.id);
    playSound("select");
    render();
  });
  document.querySelectorAll(".replay-view").forEach((el) => {
    el.addEventListener("click", () => setReplayView(el.dataset.view));
  });
  document.querySelectorAll(".replay-side").forEach((el) => {
    el.addEventListener("click", () => toggleReplaySide(el.dataset.side));
  });
  document.addEventListener("keydown", (ev) => {
    if (!replayMode) return;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); showReplayFrame(replayIndex - 1); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); showReplayFrame(replayIndex + 1); }
  });
  btnAuto.addEventListener("click", () => {
    if (!state || state.phase !== "setup") return;
    G.autoArrange(state, setupSeat);
    selected = null; hoverPos = null;
    playSound("move");
    render();
  });
  btnCheat.addEventListener("click", openCheat);
  modeSelect.addEventListener("change", () => { newGame(); });
  if (chkDuel) chkDuel.addEventListener("change", () => { newGame(); });
  if (viewSelect) viewSelect.addEventListener("change", () => {
    viewModePref = normalizeViewMode(viewSelect.value);   // 记住用户自己选的，别被双座模式带跑
    newGame();
  });
  if (setupSeatSel) setupSeatSel.addEventListener("change", () => {
    if (!state || state.phase !== "setup") return;
    setupSeat = setupSeatSel.value === "north" ? "north" : HUMAN;
    selected = null;
    hoverPos = null;
    playSound("select");
    render();
  });
  aiStyle.addEventListener("change", () => { newGame(); });
  for (const el of chkLatentSeats) el.addEventListener("change", () => { newGame(); });
  if (chkAiSouth) chkAiSouth.addEventListener("change", () => { newGame(); });
  svg.addEventListener("contextmenu", (ev) => {
    if (replayMode || !state || state.phase === "over") return;
    const el = ev.target.closest("[data-pos]");
    if (!el) { hideMarkMenu(); return; }
    const piece = G.pieceAt(state, el.getAttribute("data-pos"));
    if (!piece || G.visibleTo(state, HUMAN, piece)) { hideMarkMenu(); return; }
    ev.preventDefault();
    showMarkMenu(piece, ev.clientX, ev.clientY);
  });
  document.addEventListener("click", (ev) => {
    if (markMenu && !markMenu.classList.contains("hidden") && !markMenu.contains(ev.target)) hideMarkMenu();
  });
  if (btnFormation) btnFormation.addEventListener("click", openFormationLibrary);
  const formationSearch = document.getElementById("formationSearch");
  if (formationSearch) {
    formationSearch.addEventListener("input", () => renderBookList(formationSearch.value));
  }
  if (formationSave) formationSave.addEventListener("click", saveFormation);
  if (formationClose) formationClose.addEventListener("click", closeFormationLibrary);
  const btnExportForm = document.getElementById("resultExportForm");
  if (btnExportForm) btnExportForm.addEventListener("click", () => {
    if (!window.JunqiFormationLog) return;
    const ok = window.JunqiFormationLog.download("阵法战绩.json");
    if (!ok) alert("导出失败：这个环境不支持下载");
  });

  if (btnResult) btnResult.addEventListener("click", showResult);
  if (resultClose) resultClose.addEventListener("click", closeResult);
  if (replayImport) replayImport.addEventListener("click", () => replayFile && replayFile.click());
  if (replayModalClose) replayModalClose.addEventListener("click", closeReplayLibrary);
  if (replayFile) replayFile.addEventListener("change", () => {
    const file = replayFile.files && replayFile.files[0];
    replayFile.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj = null;
      try { obj = JSON.parse(String(reader.result)); } catch (err) { alert("复盘文件不是合法 JSON。"); return; }
      const frames = obj && Array.isArray(obj.frames) ? obj.frames : null;
      if (!frames || frames.length < 2) { alert("这个文件里没有有效复盘帧。"); return; }
      closeReplayLibrary();
      loadReplayFrames(frames);
    };
    reader.readAsText(file);
  });
  chkDoubleFlag.addEventListener("change", () => {
    if (!state || state.phase !== "setup") return;
    if (!G.setDoubleFlag(state, setupSeat, chkDoubleFlag.checked)) {
      chkDoubleFlag.checked = !chkDoubleFlag.checked;
      return;
    }
    selected = null; legal = []; hoverPos = null;
    playSound("move");
    render();
  });

  // ---------- 外援接入 ----------
  // 页面只负责：把「该座位看得见的局面」发出去、把命令收回来。
  // 对面坐的是谁、怎么想，都在 junqi-chaos\bridge.js 那一侧。
  let agentWired = false;
  function initAgent() {
    const agent = window.JunqiAgent;
    if (!agent || !agentSeats.length) return;
    if (!agentWired) {
      agentWired = true;
      agent.setSetupHandler((seat, layout) => {
        if (!state || state.phase !== "setup" || !isAgentSeat(seat)) return false;
        const ok = applyLayout(seat, layout);
        if (ok) {
          agentLayoutApplied[seat] = true;
          selected = null;
          hoverPos = null;
          playSound("move");
          render();
        }
        return ok;
      });
      agent.onSay((text) => {
        if (!state) return;
        state.log.push(`队友：${text}`);
        playSound("select");
        render();
      });
      agent.onStatus(() => { if (!replayMode) updatePanel(); });
    }
    const ready = agent.enabled ? Promise.resolve(true) : agent.enable(agentSeats, { bridge: agentBridgeUrl() });
    ready.then(() => {
      if (state && state.phase === "setup") agent.openSetup(state);
      updatePanel();
    });
  }

  buildStatic();
  viewModePref = normalizeViewMode(viewSelect ? viewSelect.value : "normal");
  newGame();
  initAgent();
  // 外援思考时每秒钟刷一次计时，让人知道牌桌没卡住
  setInterval(() => {
    if (agentThinking && state && state.phase === "playing" && !replayMode) updatePanel();
  }, 1000);

  window.__junqi = {
    get state() { return state; },
    get agentSeats() { return agentSeats.slice(); },
    get agentSeat() { return agentSeats[0] || null; },
    get viewMode() { return viewMode; },
    setSeatRole,
    get agent() { return window.JunqiAgent || null; },
    // 战地问答的当前会话（调试/自动化测试用：能拿到题目与正确答案）
    get quiz() { return quizCtx; },
    get armed() { return armed; },
    // 测试用：某张卡在某一级"要选几个目标"（Ⅲ 级可能和 Ⅰ 级不同）
    needOf(id, lv, which) { const c = DLCX.cardOf(id); return c ? needOf(c, lv, which) : -1; },
    quizAnswer(choice) { answerQuiz(choice); },
    quizNext() { quizNext(); },
    newGame, startGame,
    setDuelSeal(v) { duelSeal = !!v; },
    // 沙盘（自定义局面 → 四家对弈），供 tools/sandbox_smoke.js 调用
    enterSandbox, exitSandbox, sandboxStart, sandboxAutoFill, sandboxClearSeat,
    takeoverReplay, enterReplay, exitReplay, showReplayFrame,
    showResult, closeResult, renderResult,   // 战报：测试要检查"战术卡"那一块
    get sandboxTakeover() { return sandboxTakeover; },
    get replayMode() { return replayMode; },
    get sandboxMode() { return sandboxMode; },
    get sandboxSeat() { return sandboxSeat; },
    get sandboxPick() { return sandboxPick; },
    setSandboxSeat(seat) { sandboxSeat = seat; sandboxPick = null; renderSandbox(); },
    pickSandboxType(type) { sandboxPick = type; renderSandbox(); },
    sandboxPlace,
    marks: pieceMarks,
    // 调试用：把棋盘上所有文字节点摊平（测试里用来断言「棋背没有感叹号」之类）
    texts() {
      const out = [];
      const walk = (n) => {
        if (!n) return;
        if (n.textContent) out.push(n.textContent);
        for (const c of n.children || []) walk(c);
      };
      walk(svg);
      return out;
    },
    load(s) { state = s; selected = null; legal = []; hoverPos = null; render(); },
    click(pos) {
      const el = svg.querySelector('[data-pos="' + pos + '"]');
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    },
  };
})();
