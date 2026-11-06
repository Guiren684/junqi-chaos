/*
 * 乱战四国 · 外援座位代理（浏览器侧）
 *
 * 两种用法：
 *   单座：轮到外援座位 → 组一份「该座位看得见的局面」→ POST /api/page/turn
 *   双座（双明）：外援同时控两家（比如东+西），轮到哪家就交给它哪家
 *
 *   页面长轮询 /api/page/cmd 取命令 → move 落子 / say 说话 / setup 布阵
 *   页面每走一手都 POST /api/page/event →「实时监听」：不用等它回合也能看牌桌
 *   超时（默认 120s）→ 交回本地 AI 代走，绝不卡住牌桌
 *
 * 公平性：视图只用 game.js 的 visibleTo 过滤，暗子连 type 字段都不发出去。
 *
 * 用法：<script src="agent.js"></script>，页面 URL 带 ?agent=north 或 ?agent=east,west
 */
(function (global) {
  "use strict";

  const SEATS = ["north", "east", "south", "west"];
  const DEFAULTS = {
    bridge: "http://127.0.0.1:17842",
    seats: ["north"],
    thinkMs: 120000,   // 我一手最多想多久，超时交给本地 AI
    waitMs: 15000,     // 页面长轮询的挂起时长
  };

  function normalizeSeats(input) {
    const raw = Array.isArray(input) ? input : String(input || "").split(/[,+\s]+/);
    const out = [];
    for (const item of raw) {
      const s = String(item || "").trim().toLowerCase();
      if (SEATS.includes(s) && !out.includes(s)) out.push(s);
    }
    return out.length ? out : DEFAULTS.seats.slice();
  }

  const A = {
    enabled: false,
    seats: DEFAULTS.seats.slice(),
    bridge: DEFAULTS.bridge,
    thinkMs: DEFAULTS.thinkMs,
    waitMs: DEFAULTS.waitMs,
    epoch: 0,
    cursor: 0,
    turnSeq: 0,
    pending: null,      // { seq, resolve, deadlineAt, legal }
    timer: null,
    pumping: false,
    setupOpen: false,
    online: false,
    lastError: null,
    lastAck: null,
    lastWatchPly: -1,
    lastWatchAt: 0,
    setupHandler: null,
    onSay: null,
    onStatus: null,
    stats: { turns: 0, timeouts: 0, moves: 0, errors: 0, events: 0 },
  };

  const G = () => global.JunqiGame;

  function logStatus(text) {
    if (typeof A.onStatus === "function") { try { A.onStatus(text); } catch (err) { /* 忽略 */ } }
  }

  async function req(method, pathname, body, timeoutMs) {
    const url = A.bridge.replace(/\/+$/, "") + pathname;
    const init = { method, signal: AbortSignal.timeout(timeoutMs || 5000), headers: {} };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const txt = await res.text();
    let data = {};
    try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ------------------------------------------------------------ 视图

  function buildView(state, seats) {
    const game = G();
    const mine = seats && seats.length ? seats : A.seats;
    const primary = mine[0];
    const isMine = (owner) => mine.includes(owner);
    const cells = {};
    const you = { pieces: [], flags: 0, commanders: 0, alive: 0 };

    for (const p of state.pieces) {
      if (!p.position) continue;
      if (isMine(p.owner)) {
        // 天命暗牌：身份是延迟的，把「可能身份」一起带上，不然等于瞎猜
        const possible = p.latent ? game.possibleTypesFor(state, p) : undefined;
        cells[p.position] = { seat: p.owner, type: p.type, moved: !!p.moved };
        you.pieces.push({
          at: p.position, seat: p.owner, type: p.type, moved: !!p.moved,
          latent: !!p.latent, possible,
        });
        you.alive += 1;
        if (p.type === "flag") you.flags += 1;
        if (p.type === "commander") you.commanders += 1;
      } else {
        // 双明下队友的子由 visibleTo 正常放行；暗子只给「这格有谁的子」
        const visible = game.visibleTo(state, primary, p);
        cells[p.position] = visible ? { seat: p.owner, type: p.type, known: true } : { seat: p.owner };
      }
    }

    const mover = mine.includes(state.turn) ? state.turn : null;
    const legal = mover ? game.allLegalMoves(state, mover).map((m) => ({ from: m.from, to: m.to })) : [];

    // 走子磁带是公开信息；但 battles 里带 attType，敌方攻我时会泄漏敌方兵种，必须削掉
    const tape = (state.moveTape || []).slice(-40).map((m) => ({
      seat: m.seat, from: m.from, to: m.to, out: m.out, eng: !!m.eng,
    }));
    const battles = (state.battles || []).slice(-30).map((b) => (isMine(b.attSeat)
      ? { outcome: b.outcome, inHq: !!b.inHq, attSeat: b.attSeat, attType: b.attType }
      : { outcome: b.outcome, inHq: !!b.inHq, attSeat: b.attSeat }));

    return {
      seat: primary,
      seats: mine.slice(),
      mode: state.mode,
      infoMode: state.infoMode,
      phase: state.phase,
      turn: state.turn,
      ply: state.moveCount,
      noCapture: state.noCapture,
      out: Object.assign({}, state.out),
      cells,
      you,
      legal,
      tape,
      battles,
      stats: JSON.parse(JSON.stringify(state.stats || {})),
      log: (state.log || []).slice(-40),
    };
  }

  // 参谋：直接用页面里的强 AI 算一手（它本身只读公开信息，不偷看）
  function safeCandidates(state, seat) {
    const out = [];
    const ai = global.JunqiAI;
    if (ai && typeof ai.choose === "function") {
      try {
        const mv = ai.choose(state, seat, { budgetMs: 1200 });
        if (mv && mv.from && mv.to) out.push({ from: mv.from, to: mv.to, by: "pimc" });
      } catch (err) { /* 超时/异常就算了 */ }
    }
    try {
      const g = G().aiChoose(state, seat);
      if (g && !out.some((m) => m.from === g.from && m.to === g.to)) out.push({ from: g.from, to: g.to, by: "greedy" });
    } catch (err) { /* ignore */ }
    return out;
  }

  // ------------------------------------------------------------ 命令轮询

  async function finish(result) {
    const pending = A.pending;
    if (!pending) return;
    A.pending = null;
    if (A.timer) { clearTimeout(A.timer); A.timer = null; }
    const timeout = !!(result && result.timeout);
    const ok = !!(result && result.from);
    if (ok) A.stats.moves += 1;
    if (timeout) A.stats.timeouts += 1;
    try {
      await req("POST", "/api/page/ack", {
        seq: pending.seq,
        ok,
        timeout,
        error: (result && result.error) || null,
      }, 2500);
      A.lastAck = { seq: pending.seq, ok, timeout, at: Date.now() };
    } catch (err) {
      A.lastAck = { seq: pending.seq, ok, error: String(err && err.message || err), at: Date.now() };
    }
    logStatus(ok ? "已落子" : (timeout ? "超时，本地 AI 代走" : "放弃这一手"));
    pending.resolve(ok ? { from: result.from, to: result.to } : null);
  }

  function handleCmd(cmd) {
    if (!cmd || !cmd.cmd) return;
    if (cmd.cmd === "move") {
      const pending = A.pending;
      if (!pending || Number(cmd.turnSeq) !== pending.seq) return;   // 过期的命令，丢掉
      const hit = (pending.legal || []).some((m) => m.from === cmd.from && m.to === cmd.to);
      if (!hit) { finish({ error: `不合法：${cmd.from}→${cmd.to}` }); return; }
      finish({ from: cmd.from, to: cmd.to });
      return;
    }
    if (cmd.cmd === "say") {
      if (typeof A.onSay === "function") { try { A.onSay(String(cmd.text || "")); } catch (err) { /* 忽略 */ } }
      return;
    }
    if (cmd.cmd === "setup") {
      if (!A.setupOpen || typeof A.setupHandler !== "function") return;
      const layout = (cmd.layout || []).map((it) => ({ pos: it.at || it.pos, type: it.type }));
      let ok = false;
      try { ok = A.setupHandler(cmd.seat || A.seats[0], layout) !== false; } catch (err) { ok = false; }
      logStatus(ok ? "布阵已应用" : "布阵被拒绝（兵种对不上或已开局）");
      return;
    }
  }

  async function pump() {
    if (A.pumping || !A.enabled) return;
    A.pumping = true;
    while (A.enabled) {
      try {
        const r = await req("GET", `/api/page/cmd?after=${A.cursor}&wait=${A.waitMs}`, undefined, A.waitMs + 8000);
        A.online = true;
        A.lastError = null;
        if (Array.isArray(r.cmds) && r.cmds.length) {
          A.cursor = Number(r.cursor || A.cursor);
          for (const c of r.cmds) handleCmd(c);
        }
      } catch (err) {
        A.online = false;
        A.lastError = String(err && err.message || err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    A.pumping = false;
  }

  // ------------------------------------------------------------ 实时监听

  // 每走一手推一条事件；桥那边 /api/watch 就能长轮询看直播
  function watch(state) {
    if (!A.enabled || !state) return false;
    const ply = state.moveCount || 0;
    if (ply === A.lastWatchPly && state.phase === A.lastWatchPhase) return false;
    A.lastWatchPly = ply;
    A.lastWatchPhase = state.phase;
    A.lastWatchAt = Date.now();
    const view = buildView(state, A.seats);
    const lm = state.lastMove;
    const move = lm ? { seat: lm.seat, from: lm.from, to: lm.to, out: state.lastSound || "move" } : null;
    req("POST", "/api/page/event", {
      // 这一手是谁走的（不是「下一手轮到谁」）
      ply, seat: (lm && lm.seat) || state.turn, phase: state.phase, move, view, seats: A.seats,
    }, 4000).then(() => { A.stats.events += 1; }).catch(() => { /* 直播丢了不影响下棋 */ });
    return true;
  }

  // ------------------------------------------------------------ 对外接口

  async function hello(state, seats) {
    const body = {
      seat: seats[0],
      seats,
      mode: state ? state.mode : "standard",
      phase: state ? state.phase : "idle",
      ply: state ? state.moveCount : 0,
      user: "page",
    };
    const r = await req("POST", "/api/page/hello", body, 4000);
    A.epoch = Number(r.epoch || 0);
    A.cursor = 0;
    A.online = true;
    return r;
  }

  async function enable(seats, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    A.seats = normalizeSeats(seats);
    A.bridge = cfg.bridge || DEFAULTS.bridge;
    A.thinkMs = Number(cfg.thinkMs || DEFAULTS.thinkMs);
    A.waitMs = Number(cfg.waitMs || DEFAULTS.waitMs);
    A.enabled = true;
    logStatus("连接本地桥…");
    try {
      await hello(null, A.seats);
      logStatus(`外援已连接（我控${A.seats.join("+")}）`);
    } catch (err) {
      A.online = false;
      A.lastError = String(err && err.message || err);
      logStatus("连不上本地桥，暂时由本地 AI 代下");
    }
    pump();
    return A.enabled;
  }

  function disable() {
    A.enabled = false;
    A.setupOpen = false;
    if (A.timer) { clearTimeout(A.timer); A.timer = null; }
    if (A.pending) {
      const p = A.pending;
      A.pending = null;
      p.resolve(null);
    }
    logStatus("外援已断开，本地 AI 接管");
  }

  async function takeTurn(state, seat, opts) {
    const cfg = opts || {};
    if (!A.enabled || !A.seats.includes(seat)) return null;
    if (!state || state.phase !== "playing") return null;
    if (A.pending) {
      if (A.timer) { clearTimeout(A.timer); A.timer = null; }
      const stale = A.pending;
      A.pending = null;
      stale.resolve(null);
    }   // 上一手残留

    const seq = (A.turnSeq += 1);
    const view = buildView(state, A.seats);
    const candidates = safeCandidates(state, seat);
    const deadlineAt = Date.now() + A.thinkMs;
    const promise = new Promise((resolve) => {
      A.pending = { seq, resolve, deadlineAt, legal: view.legal, seat };
    });
    A.timer = setTimeout(() => finish({ timeout: true }), A.thinkMs);
    A.stats.turns += 1;

    try {
      await req("POST", "/api/page/turn", {
        seq, epoch: A.epoch, seat, seats: A.seats, ply: state.moveCount, phase: state.phase,
        view, legal: view.legal, candidates, deadlineAt,
      }, 5000);
      A.online = true;
      logStatus(`第 ${state.moveCount} 手（${seat}）：已交给外援思考`);
      pump();
    } catch (err) {
      A.online = false;
      A.lastError = String(err && err.message || err);
      A.stats.errors += 1;
      finish({ error: A.lastError });
      // 桥重启过 / 页面换过 epoch：重新握手一次，下一手就能接上
      if (/过期|epoch|409/i.test(A.lastError)) { hello(state, A.seats).catch(() => {}); }
      return null;
    }

    if (typeof cfg.onView === "function") {
      try { cfg.onView(view, candidates); } catch (err) { /* 忽略 */ }
    }
    return promise;
  }

  function openSetup(state) {
    if (!A.enabled) return false;
    const game = G();
    const seats = {};
    for (const seat of A.seats) {
      seats[seat] = {
        hand: state.pieces.filter((p) => p.owner === seat).map((p) => p.type),
        cells: game.ownCells(seat),
      };
    }
    const cells = game.ownCells(A.seats[0]);
    const book = (global.JUNQI_FORMATIONS || [])
      .filter((f) => f && Array.isArray(f.layout) && f.layout.length === cells.length)
      .map((f) => ({ name: f.name, tags: f.tags || [], layout: f.layout }));
    A.setupOpen = true;
    req("POST", "/api/page/setup", { seats, formations: book }, 8000)
      .then(() => logStatus(`布阵窗口已打开（${A.seats.join("+")}，${book.length} 套阵法）`))
      .catch((err) => {
        A.online = false;
        A.lastError = String(err && err.message || err);
        logStatus("布阵窗口没打开（桥不在线），先用默认阵");
      });
    return true;
  }

  function closeSetup() { A.setupOpen = false; }

  function say(text) {
    if (!A.enabled || !text) return Promise.resolve(false);
    return req("POST", "/api/say", { text: String(text).slice(0, 200) }, 3000)
      .then(() => true).catch(() => false);
  }

  function status() {
    return {
      enabled: A.enabled, online: A.online, seats: A.seats.slice(), seat: A.seats[0],
      bridge: A.bridge, waiting: !!A.pending,
      deadlineAt: A.pending ? A.pending.deadlineAt : null,
      lastError: A.lastError, setupOpen: A.setupOpen, lastAck: A.lastAck,
      watchPly: A.lastWatchPly, stats: Object.assign({}, A.stats),
    };
  }

  const API = {
    get enabled() { return A.enabled; },
    get seat() { return A.seats[0]; },
    get seats() { return A.seats.slice(); },
    get online() { return A.online; },
    config: A,
    enable, disable, takeTurn, openSetup, closeSetup, say, status, buildView, hello, watch,
    setSetupHandler(fn) { A.setupHandler = fn; },
    onSay(fn) { A.onSay = fn; },
    onStatus(fn) { A.onStatus = fn; },
  };

  global.JunqiAgent = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
