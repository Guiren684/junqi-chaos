// 一般模式下的「南方用了哪套阵法 + 这局赢了没有」记账。
//
// 为什么需要它：阵法先验（ai.js 的 formationPosterior）现在只能靠 72 套内置阵法，
// 但「哪套阵真的赢」我们没有任何实测。这个模块每局结束追加一条，攒够样本就能回答。
//
// 两个后端：
//   · 浏览器 —— 累积到 localStorage（键 junqi.southFormationLog.v1），download() 导出成 JSON 文件
//   · Node   —— 直接读写 JSON 文件（默认 training/out/south_formations.json）
//
// 用法（Node）：
//   const LOG = require("./formation_log.js");
//   LOG.record(state, "south");          // 每局结束调用一次
//   LOG.read();                          // 读全部记录
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JunqiFormationLog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  const LS_KEY = "junqi.southFormationLog.v1";
  const FORM_LIB_KEY = "junqi.formationLib.v1";
  const DEFAULT_FILE = "training/out/south_formations.json";
  const IS_NODE = (typeof process !== "undefined" && process.versions && process.versions.node
    && typeof require === "function" && typeof module !== "undefined");

  // ---------- 开局 25 格的标准顺序（6 行 × 5 列，跳过行营），与 ai.js 的 OPENING_CELLS 一致 ----------
  // 不去依赖 board.js：任一座位开局占的正好是这 25 格，按 (row, col) 排序即得同一顺序。
  function orderedCells(state, seat) {
    const out = [];
    for (const p of state.pieces) {
      if (p.owner !== seat || !p.position) continue;
      const m = /^([a-z]+)-(\d+)-(\d+)$/.exec(p.position);
      if (!m) continue;
      out.push({ r: Number(m[2]), c: Number(m[3]), type: p.type, pos: p.position });
    }
    out.sort((a, b) => (a.r - b.r) || (a.c - b.c));
    return out;
  }

  function readFormLib() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(FORM_LIB_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) { return []; }
  }

  // 认阵法：先跟 72 套内置比（前 4 排一致就算，因为 shuffleMineRow 会随机打乱后两排雷位），
  // 再跟本机阵法库比，都不中就是自定义。
  function identify(state, seat) {
    const cells = orderedCells(state, seat);
    if (!cells.length) return { formation: "—", kind: "未知", match: "—", index: -1 };
    const types = cells.map((x) => x.type);
    const front = cells.map((x, i) => (x.r < 4 ? i : -1)).filter((i) => i >= 0);

    const book = root.JUNQI_FORMATIONS || [];
    let bestName = null;
    let bestIdx = -1;
    let bestMatch = "";
    for (let k = 0; k < book.length; k += 1) {
      const lay = book[k].layout;
      if (!lay || lay.length !== types.length) continue;
      let same = 0;
      for (let i = 0; i < types.length; i += 1) if (lay[i] === types[i]) same += 1;
      if (same === types.length) {
        return { formation: book[k].name || `阵法${k + 1}`, kind: "内置", match: "全25格", index: k };
      }
      let frontSame = true;
      for (const i of front) if (lay[i] !== types[i]) { frontSame = false; break; }
      if (frontSame && !bestName) {
        bestName = book[k].name || `阵法${k + 1}`;
        bestIdx = k;
        bestMatch = "仅前四排（雷位随机过）";
      }
    }
    if (bestName) return { formation: bestName, kind: "内置", match: bestMatch, index: bestIdx };

    const map = new Map(cells.map((x) => [x.pos, x.type]));
    for (const item of readFormLib()) {
      const lay = item && item.layout;
      if (!Array.isArray(lay) || lay.length !== cells.length) continue;
      let ok = true;
      for (const it of lay) {
        if (map.get(it.pos) !== it.type) { ok = false; break; }
      }
      if (ok) return { formation: item.name || "本机阵法", kind: "本机阵法", match: "全25格", index: -1 };
    }
    return { formation: "自定义", kind: "自定义", match: "—", index: -1 };
  }

  const SEATS = ["east", "north", "west", "south"];
  function teamOf(seat) {
    return (seat === "south" || seat === "north") ? "A" : "B";
  }

  // ⚠️ 有「天命暗牌」时，开局那些暗子的 type 是占位的（实测全是工兵），
  // 靠开局局面认阵法会认错。真值只在**复盘帧**里（frame.pieces[].actualType / latent 撤掉之后），
  // ui.js 的 buildReplayFaceMap 已经把「棋子 id → 真实兵种」算好了，这里直接用它。
  //
  // frames[0] 是开局那一帧，position 就是初始站位 —— 阵法的定义本来就是「初始 25 格」。
  function identifyFromFrames(frames, seat, faceMap) {
    if (!frames || !frames.length) return null;
    const zero = frames[0];
    const cells = [];
    for (const p of zero.pieces || []) {
      if (p.owner !== seat || !p.position) continue;
      const m = /^([a-z]+)-(\d+)-(\d+)$/.exec(p.position);
      if (!m) continue;
      let t = faceMap && faceMap.get(p.id);
      if (!t) t = p.actualType || p.type;
      if (!t) return null;
      cells.push({ r: Number(m[2]), c: Number(m[3]), type: t, pos: p.position });
    }
    if (cells.length !== 25) return null;
    cells.sort((a, b) => (a.r - b.r) || (a.c - b.c));
    return matchLayout(cells.map((x) => x.type), cells.map((x) => x.r));
  }

  // 拿「按 OPEN_CELLS 顺序的类型数组」去比对：先 72 套内置（前 4 排一致即算，雷位被 shuffleMineRow 打过），
  // 再比本机阵法库（按位置），都不中算自定义
  function matchLayout(types, rows) {
    if (!types || types.length !== 25) return null;
    const book = root.JUNQI_FORMATIONS || [];
    const front = [];
    for (let i = 0; i < types.length; i += 1) if (rows[i] < 4) front.push(i);
    let bestName = null;
    let bestIdx = -1;
    for (let k = 0; k < book.length; k += 1) {
      const lay = book[k].layout;
      if (!lay || lay.length !== types.length) continue;
      let same = 0;
      for (let i = 0; i < types.length; i += 1) if (lay[i] === types[i]) same += 1;
      if (same === types.length) {
        return { formation: book[k].name || `阵法${k + 1}`, kind: "内置", match: "全25格", index: k };
      }
      let frontSame = true;
      for (const i of front) if (lay[i] !== types[i]) { frontSame = false; break; }
      if (frontSame && bestName === null) {
        bestName = book[k].name || `阵法${k + 1}`;
        bestIdx = k;
      }
    }
    if (bestName) return { formation: bestName, kind: "内置", match: "仅前四排（雷位随机过）", index: bestIdx };
    return { formation: "自定义", kind: "自定义", match: "—", index: -1 };
  }

  // 从局面里凑一条记录
  // 取某座位的阵法：复盘帧（最可信，含天命暗牌真值）> 布阵记录 > 活局面识别
  function metaOf(state, seat, opts) {
    if (opts && opts.frames) {
      const fromFrames = identifyFromFrames(opts.frames, seat, opts.faceMap);
      if (fromFrames) return fromFrames;
    }
    const cached = state.formationMeta && state.formationMeta[seat];
    if (cached) return cached;
    const used = state.openingUsed && state.openingUsed[seat];
    if (used) return { formation: used.name, kind: "内置", match: "布阵记录", index: used.index };
    if (!state.pieces.some((p) => p.owner === seat)) return { formation: "—", kind: "未知", match: "—", index: -1 };
    return identify(state, seat);
  }

  function build(state, seat, opts) {
    if (!state) return null;
    const me = seat || "south";
    const id = metaOf(state, me, opts) || { formation: "—", kind: "未知", match: "—", index: -1 };
    const all = {};
    for (const s of SEATS) {
      const m = metaOf(state, s, opts);
      if (m) all[s] = m.formation;
    }
    const w = state.winner || null;
    const myTeam = teamOf(me);
    return {
      time: new Date().toISOString(),
      mode: state.mode || "standard",
      seat: me,
      formation: id.formation,
      kind: id.kind,
      match: id.match,
      bookIndex: id.index,
      winner: w,
      team: myTeam,
      result: w ? (w === myTeam ? "胜" : "负") : "和",
      plies: state.moveCount || (state.moveTape ? state.moveTape.length : 0),
      allFormations: all,
    };
  }

  // ---------- 存储 ----------
  function read() {
    if (IS_NODE) {
      const fs = require("fs");
      const p = process.env.JJ_FORM_LOG || DEFAULT_FILE;
      try {
        const raw = fs.readFileSync(p, "utf8");
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (err) { return []; }
    }
    try {
      const raw = root.localStorage && root.localStorage.getItem(LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) { return []; }
  }

  function writeAll(arr) {
    if (IS_NODE) {
      const fs = require("fs");
      const path = require("path");
      const p = process.env.JJ_FORM_LOG || DEFAULT_FILE;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(arr, null, 1), "utf8");
      return true;
    }
    try {
      root.localStorage.setItem(LS_KEY, JSON.stringify(arr));
      return true;
    } catch (err) { return false; }
  }

  function record(state, seat, opts) {
    const row = build(state, seat, opts);
    if (!row) return null;
    if (state.__formLogged) return null;          // 同一局只记一次
    state.__formLogged = true;
    const arr = read();
    arr.push(row);
    writeAll(arr);
    return row;
  }

  // 汇总：每套阵法多少局、几胜几负
  function summary() {
    const arr = read();
    const m = new Map();
    for (const r of arr) {
      const k = r.formation;
      if (!m.has(k)) m.set(k, { formation: k, kind: r.kind, games: 0, win: 0, lose: 0, draw: 0 });
      const o = m.get(k);
      o.games += 1;
      if (r.result === "胜") o.win += 1;
      else if (r.result === "负") o.lose += 1;
      else o.draw += 1;
    }
    return Array.from(m.values())
      .map((o) => Object.assign(o, {
        winRate: o.games ? +(o.win / o.games * 100).toFixed(1) : 0,
      }))
      .sort((a, b) => b.games - a.games);
  }

  // 浏览器里导出成真正的 json 文件
  function download(name) {
    if (IS_NODE) return false;
    try {
      const blob = new Blob([JSON.stringify(read(), null, 1)], { type: "application/json" });
      const a = root.document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name || "south_formations.json";
      root.document.body.appendChild(a);
      a.click();
      root.document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return true;
    } catch (err) { return false; }
  }

  function clear() { return writeAll([]); }

  return { identify, identifyFromFrames, matchLayout, metaOf, build, record, read, summary, download, clear, orderedCells,
           get file() { return IS_NODE ? (process.env.JJ_FORM_LOG || DEFAULT_FILE) : LS_KEY; } };
});
