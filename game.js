/*
 * 乱战四国 · 规则/发牌/AI
 * 依赖 board.js（window.JunqiBoard / require("./board")）
 *
 * 规则要点：
 * - 100 枚棋子随机发 4 家，每家 25 枚（工兵不再移除）。
 * - 每人 25 个非行营格摆满；军旗进大本营、地雷后两排、炸弹不第一排；
 *   8 枚以上地雷可放倒数第 3 排。
 * - 0 旗 0 司令：两个大本营都被攻占才败；0 旗有司令：大本营被攻占且司令存活立即败，
 *   最后一个司令阵亡则选择一个大本营升旗；1 旗被攻占即败；2 旗分放两营则需攻下两营。
 * - 大本营中的棋子小于任何其他棋子，任何棋子都能攻占大本营（炸弹同归于尽）。
 * - 地雷：除工兵外，碰雷两子同归于尽。
 * - 对家棋子也不可见；只有己方棋子和已亮明的棋子可见。
 */
(function (global) {
  "use strict";
  const B = global.JunqiBoard || (typeof require !== "undefined" ? require("./board.js") : null);
  const { BOARD, PIECE_INFO, SEATS, teamOf, hqCells } = B;

  const TURN_ORDER = ["south", "west", "north", "east"];
  const ALL_NODES = BOARD.nodes.map((n) => n.id);
  const VALUE = {
    flag: 120, commander: 22, army: 17, division: 12, brigade: 9, regiment: 6.5,
    battalion: 5, company: 3.4, platoon: 2.4, engineer: 3.2, mine: 4.5, bomb: 6.5,
  };

  let seq = 0;
  function uid() { seq += 1; return `p${seq}`; }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function pieceAt(state, position) {
    return state.pieces.find((p) => p.position === position) || null;
  }
  function piecesOf(state, seat) {
    return state.pieces.filter((p) => p.owner === seat && p.position);
  }
  function isTeammate(a, b) { return teamOf(a) === teamOf(b); }
  function isEnemy(a, b) { return teamOf(a) !== teamOf(b); }

  // ---------- 发牌 ----------
  function armyTypes() {
    const list = [];
    for (const [type, info] of Object.entries(PIECE_INFO)) {
      for (let i = 0; i < info.count; i += 1) list.push(type);
    }
    return list; // 25
  }
  function fullPool() {
    const one = armyTypes();
    return [...one, ...one, ...one, ...one]; // 100
  }

  function handOk(hand) {
    return hand.includes("engineer") && hand.some((t) => PIECE_INFO[t].rank >= 7);
  }

  function dealRandom() {
    const pool = fullPool();
    for (let attempt = 0; attempt < 800; attempt += 1) {
      const p = shuffle(pool);
      const hands = [0, 1, 2, 3].map((i) => p.slice(i * 25, i * 25 + 25));
      if (hands.every(handOk)) return hands;
    }
    const p = shuffle(pool);
    return [0, 1, 2, 3].map((i) => p.slice(i * 25, i * 25 + 25));
  }

  // ---------- 布阵 ----------
  function ownCells(seat) {
    return BOARD.nodes.filter((n) => n.seat === seat && n.kind !== "camp").map((n) => n.id);
  }

  function canPlace(type, seat, cellId, opts = {}) {
    const node = BOARD.byId.get(cellId);
    if (!node || node.seat !== seat || node.kind === "camp") return false;
    if (type === "flag") return node.kind === "hq";
    if (type === "mine") return node.row >= (opts.allowMineRow3 ? 3 : 4);
    if (type === "bomb") return node.row > 0;
    return true;
  }

  // 摆满 25 格；opts.doubleFlag=true 时有 2+ 旗则双旗进两营
  function placeTypes(seat, typesIn, opts = {}) {
    const types = typesIn.slice();
    const flagCount = types.filter((t) => t === "flag").length;
    const keepFlags = Math.min(flagCount, opts.doubleFlag && flagCount >= 2 ? 2 : 1);
    let extra = flagCount - keepFlags;
    for (let i = 0; i < types.length && extra > 0; i += 1) {
      if (types[i] === "flag") { types[i] = "army"; extra -= 1; }
    }
    const flags = types.filter((t) => t === "flag").length;
    const mineCount = types.filter((t) => t === "mine").length;
    const allowRow3 = mineCount >= 8;

    const cells = ownCells(seat);
    const hqs = shuffle(hqCells(seat));
    const positions = new Map();
    const used = new Set();
    if (flags >= 2) {
      positions.set("flag#0", hqs[0]); positions.set("flag#1", hqs[1]);
      used.add(hqs[0]); used.add(hqs[1]);
    } else if (flags === 1) {
      positions.set("flag#0", hqs[0]); used.add(hqs[0]);
    }
    const free = () => cells.filter((c) => !used.has(c));
    const pick = (pool) => shuffle(pool)[0];

    for (let i = 0; i < mineCount; i += 1) {
      const strict = free().filter((c) => BOARD.byId.get(c).row >= (allowRow3 ? 3 : 4));
      const cell = pick(strict.length ? strict : free());
      positions.set(`mine#${i}`, cell); used.add(cell);
    }
    const bombCount = types.filter((t) => t === "bomb").length;
    for (let i = 0; i < bombCount; i += 1) {
      const strict = free().filter((c) => BOARD.byId.get(c).row > 0);
      const cell = pick(strict.length ? strict : free());
      positions.set(`bomb#${i}`, cell); used.add(cell);
    }

    const restCells = shuffle(free());
    let restIndex = 0;
    const counters = {};
    for (const type of types) {
      if (type === "flag" || type === "mine" || type === "bomb") continue;
      const index = counters[type] || 0;
      counters[type] = index + 1;
      positions.set(`${type}#${index}`, restCells[restIndex]);
      restIndex += 1;
    }

    const pieces = [];
    const usedKeys = new Set();
    for (const type of types) {
      let key;
      if (type === "flag") {
        key = usedKeys.has("flag#0") ? "flag#1" : "flag#0";
      } else {
        const idx = [...usedKeys].filter((k) => k.startsWith(type + "#")).length;
        key = `${type}#${idx}`;
      }
      usedKeys.add(key);
      const pos = positions.get(key);
      if (!pos) throw new Error("布阵失败: " + type + " " + key);
      pieces.push({
        id: uid(), owner: seat, type,
        position: pos, revealed: false, revealedTo: null,
      });
    }
    return pieces;
  }

  // ---------- 全员暗牌（作弊）：身份域 / 匹配 / 最小身份显示 ----------
  const LATENT_ORDER = ["engineer", "platoon", "company", "battalion", "regiment", "brigade", "division", "army", "commander", "bomb", "mine"];

  // 天命暗牌按座位开启：latentSeats / labelPools 在 makeState 里统一归一化
  function isLatentSeat(state, owner) {
    return !!(state && state.latentSeats && state.latentSeats[owner]);
  }
  function poolOf(state, owner) {
    if (!state.labelPools) state.labelPools = { north: [], east: [], south: [], west: [] };
    if (!state.labelPools[owner]) state.labelPools[owner] = [];
    return state.labelPools[owner];
  }
  function anyLatent(state) {
    return SEATS.some((s) => isLatentSeat(state, s));
  }

  function buildLatentDomain(state, piece) {
    const pool = poolOf(state, piece.owner);
    const types = [...new Set(pool)];
    const mineCount = pool.filter((t) => t === "mine").length;
    const minMineRow = mineCount >= 8 ? 3 : 4;
    const node = piece.position ? BOARD.byId.get(piece.position) : null;
    return new Set(types.filter((t) => {
      if (t === "flag") return false;
      if (t === "mine") {
        if (piece.moved || piece.hasFought) return false;
        return !!node && node.row >= minMineRow;
      }
      if (PIECE_INFO[t].rank < (piece.lowerBound || 0)) return false;
      if (t === "bomb" && (piece.startRow === 0 || piece.hasFought)) return false;
      if (piece.engineerOnly && t !== "engineer") return false;
      return true;
    }));
  }

  function matchLatent(pieces, labels) {
    if (pieces.length !== labels.length) return false;
    const match = new Array(labels.length).fill(-1);
    function dfs(pi, seen) {
      const dom = pieces[pi].domain || new Set();
      for (let j = 0; j < labels.length; j += 1) {
        if (seen[j] || !dom.has(labels[j])) continue;
        seen[j] = true;
        if (match[j] === -1 || dfs(match[j], seen)) { match[j] = pi; return true; }
      }
      return false;
    }
    for (let i = 0; i < pieces.length; i += 1) {
      if (!dfs(i, new Array(labels.length).fill(false))) return false;
    }
    return true;
  }

  function possibleTypesFor(state, piece) {
    if (!piece || !piece.latent || !piece.position) return piece ? [piece.type] : [];
    if (!piece.domain) piece.domain = buildLatentDomain(state, piece);
    const owner = piece.owner;
    const latent = state.pieces.filter((p) => p.latent && p.position && p.owner === owner);
    const others = latent.filter((p) => p !== piece);
    const pool = poolOf(state, owner);
    if (others.length !== pool.length - 1) return [piece.type];
    const out = [];
    for (const t of piece.domain) {
      const idx = pool.indexOf(t);
      if (idx < 0) continue;
      const labels = pool.slice();
      labels.splice(idx, 1);
      if (matchLatent(others, labels)) out.push(t);
    }
    return out.length ? out : [...piece.domain].slice(0, 1);
  }

  function minLatentType(types) {
    return types.slice().sort((a, b) => LATENT_ORDER.indexOf(a) - LATENT_ORDER.indexOf(b))[0];
  }

  function refreshLatentSeat(state, seat) {
    const latent = state.pieces.filter((p) => p.latent && p.position && p.owner === seat);
    const pool = poolOf(state, seat);
    if (pool.length !== latent.length) return;
    for (const p of latent) p.domain = buildLatentDomain(state, p);
    for (const p of latent) {
      const poss = possibleTypesFor(state, p);
      p.type = poss.length ? minLatentType(poss) : ([...p.domain][0] || p.type);
    }
  }

  function refreshLatent(state) {
    if (!state) return;
    for (const s of SEATS) if (isLatentSeat(state, s)) refreshLatentSeat(state, s);
  }

  function setupLatent(state) {
    for (const seat of SEATS) {
      if (!isLatentSeat(state, seat)) continue;
      const own = state.pieces.filter((p) => p.owner === seat && p.position);
      for (const p of own) {
        p.startRow = BOARD.byId.get(p.position).row;
        p.hasFought = false;
        p.engineerOnly = false;
        p.lowerBound = 0;
        p.actualType = null;
        p.moved = false;
        p.latent = false;
      }
      const latent = own.filter((p) => p.type !== "flag");
      for (const p of latent) p.latent = true;
      const pool = poolOf(state, seat);
      pool.length = 0;
      for (const p of latent) pool.push(p.type);
      refreshLatentSeat(state, seat);
    }
  }

  function takeLatentLabel(state, owner, type) {
    const pool = poolOf(state, owner);
    const i = pool.indexOf(type);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  }

  function fixLatent(state, piece, type) {
    if (!piece || !piece.latent) return;
    if (!takeLatentLabel(state, piece.owner, type)) return;
    piece.type = type;
    piece.actualType = type;
    piece.latent = false;
    piece.hasFought = true;
    refreshLatent(state);
  }

  function dropLatent(state, piece, type) {
    if (!piece || !piece.latent) return;
    if (!takeLatentLabel(state, piece.owner, type)) return;
    piece.position = null;
    piece.actualType = type;
    piece.latent = false;
    piece.hasFought = true;
    refreshLatent(state);
  }

  function moveRequiresEngineer(state, seat, from, to) {
    const piece = pieceAt(state, from);
    if (!piece || !piece.latent) return false;
    const old = piece.type;
    piece.type = "platoon";
    let normal = [];
    try { normal = legalTargets(state, seat, from); } finally { piece.type = old; }
    return !normal.includes(to);
  }

  function recordLatentWin(state, piece, ourType, enemyType, inHq) {
    piece.hasFought = true;
    piece.lowerBound = Math.max(piece.lowerBound || 0, PIECE_INFO[ourType].rank);
    if (ourType === "engineer" && enemyType === "mine") piece.engineerOnly = true;
    if (piece.revealed || piece.revealedTo || ourType === "mine") {
      fixLatent(state, piece, ourType);
      return;
    }
    refreshLatent(state);
  }

  function chooseLatentType(state, piece, enemyType, isAttacker, inHq) {
    const possible = possibleTypesFor(state, piece);
    const candidates = possible.filter((t) => {
      if (t === "mine" && isAttacker) return false;
      if (t === "bomb" && (piece.startRow === 0 || piece.hasFought)) return false;
      if (piece.engineerOnly && t !== "engineer") return false;
      return true;
    });
    if (!candidates.length) return piece.type;
    const scored = candidates.map((t) => {
      const outcome = isAttacker
        ? resolveBattle({ type: t }, { type: enemyType }, inHq, state.mode)
        : resolveBattle({ type: enemyType }, { type: t }, inHq, state.mode);
      const cat = outcome === (isAttacker ? "attacker" : "defender") ? "win"
        : outcome === "both" ? "tie" : "lose";
      return { t, cat, rank: PIECE_INFO[t].rank };
    });
    const order = (a, b) => (a.rank - b.rank) || (LATENT_ORDER.indexOf(a.t) - LATENT_ORDER.indexOf(b.t));
    const wins = scored.filter((s) => s.cat === "win").sort(order);
    if (wins.length) return wins[0].t;
    if (enemyType === "commander" && !piece.hasFought && piece.position) {
      const node = BOARD.byId.get(piece.position);
      const bombTie = scored.some((s) => s.cat === "tie" && s.t === "bomb");
      if (node && node.row > 0 && bombTie) return "bomb";
    }
    const ties = scored.filter((s) => s.cat === "tie" && s.t !== "bomb").sort(order);
    if (ties.length) return ties[0].t;
    if (scored.some((s) => s.cat === "tie" && s.t === "bomb")) return "bomb";
    const loses = scored.filter((s) => s.cat === "lose").sort(order);
    // 未被碰撞过的防守子被吃时，优先用除工兵外的最小合法身份，避免工兵被快速消耗
    if (!isAttacker && !piece.hasFought) {
      const nonEngineer = loses.filter((s) => s.t !== "engineer" && s.t !== "mine");
      if (nonEngineer.length) return nonEngineer[0].t;
    }
    return loses.length ? loses[0].t : piece.type;
  }

  // ---------- 战果统计 ----------
  // 只用于「对局结束后的战果展示」，与 AI 搜索用的 VALUES 是两套东西。
  // 计分规则见项目根目录 战果规则.md，改动这两个地方要同步。
  const SCORE_VALUE = {
    flag: 100, commander: 40, army: 30, division: 20, brigade: 15,
    regiment: 10, battalion: 8, company: 6, platoon: 4, engineer: 3,
    bomb: 12, mine: 10,
  };

  function makeStats() {
    const out = {};
    for (const s of SEATS) {
      out[s] = {
        kills: {}, killPieces: 0, killScore: 0,
        losses: {}, lossPieces: 0, lossScore: 0,
        moves: 0, flagsTaken: 0, flagLost: 0, survived: true, outAt: null,
      };
    }
    return out;
  }

  // 记录一次阵亡：victim 被 bySeat 消灭。同归于尽时双方各记一次。
  function recordDeath(state, victim, bySeat) {
    if (!state || !state.stats || !victim) return;
    const t = victim.actualType || victim.type || "unknown";
    const val = SCORE_VALUE[t] || 0;
    const isFlag = t === "flag";
    const k = state.stats[bySeat];
    if (k) {
      k.kills[t] = (k.kills[t] || 0) + 1;
      k.killPieces += 1;
      k.killScore += val;
      if (isFlag) k.flagsTaken += 1;
    }
    const l = state.stats[victim.owner];
    if (l) {
      l.losses[t] = (l.losses[t] || 0) + 1;
      l.lossPieces += 1;
      l.lossScore += val;
      if (isFlag) l.flagLost += 1;
    }
  }

  function makeState(pieces, opts = {}) {
    const state = {
      phase: "setup",
      pieces,
      mode: opts.mode === "standard" ? "standard" : "chaos",
      turn: "south",
      human: opts.human || "south",
      // 人控座位（双明模式下一人控南北两家；空数组＝没人控，纯观战/全外援）
      humanSeats: Array.isArray(opts.humanSeats) ? opts.humanSeats.slice() : [opts.human || "south"],
      // 外援座位：由页面外的代理来下（规则上当 AI 一样对待，只是不走本地 AI）
      agentSeats: (opts.agentSeats && opts.agentSeats.length) ? opts.agentSeats.slice() : [],
      infoMode: (opts.infoMode === "team" || opts.infoMode === "all") ? opts.infoMode : "normal",
      // 按队心智链：{ A:bool, B:bool }。null = 不启用（默认四暗）
      mindLink: (opts.mindLink && typeof opts.mindLink === "object")
        ? { A: !!opts.mindLink.A, B: !!opts.mindLink.B } : null,
      log: [],
      winner: null,
      seats: Array.isArray(opts.seats) && opts.seats.length >= 2 ? opts.seats.slice() : ["south", "west", "north", "east"],
      out: { north: false, east: false, south: false, west: false },
      hqCaptured: { north: new Set(), east: new Set(), south: new Set(), west: new Set() },
      initialFlags: {},
      raisedFlag: { north: null, east: null, south: null, west: null },
      pendingRaise: null,
      doubleFlag: { north: false, east: false, south: false, west: false },
      handTypes: opts.handTypes || {},
      handFlags: {},
      moveCount: 0,
      noCapture: 0,
      stats: makeStats(),
      outOrder: [],
      lastMove: null,
      lastSound: null,
      flagRevealSound: false,
      cheat: !!opts.cheat,
      latentHuman: !!opts.latent,
      labelPool: [],
      recordHistory: !!opts.history,
      historyFrames: [],
      battles: [],
      // 走子磁带：所有走子都是公开信息，AI 靠它判断「动过的子不是雷」、
      // 「曲折铁路只能是工兵」这类信号。最多留 200 手，够覆盖一局关键段。
      moveTape: [],
      aiStyle: opts.aiStyle || "mixed",
      aiProfiles: opts.aiProfiles || {},
    };
    // 双人模式：没上场的两家从开局就判为出局（回合与胜负都只看 state.seats）
    for (const s of ["south", "west", "north", "east"]) {
      if (state.seats.indexOf(s) < 0) state.out[s] = true;
    }
    // 天命暗牌：统一归一化成「按座位」的开关与标签池
    const homeSeat = opts.human || "south";
    state.latentSeats = opts.latentSeats
      ? Object.assign({ north: false, east: false, south: false, west: false }, opts.latentSeats)
      : { north: false, east: false, south: false, west: false };
    if (!opts.latentSeats && opts.latent) state.latentSeats[homeSeat] = true;
    state.latentHuman = !!state.latentSeats[homeSeat];
    state.labelPools = { north: [], east: [], south: [], west: [] };
    state.labelPool = state.labelPools[homeSeat];   // 兼容旧字段：同一数组，原地更新
    for (const seat of SEATS) {
      state.initialFlags[seat] = pieces.filter((p) => p.owner === seat && p.type === "flag" && p.position).length;
      const hand = state.handTypes[seat];
      state.handFlags[seat] = hand ? hand.filter((t) => t === "flag").length : state.initialFlags[seat];
    }
    state.log.push(opts.cheat
      ? `作弊发牌：自选 ${opts.cheatPicked || 0} 枚，其余在剩余棋子中随机补满 25 枚；剩下 75 枚随机分给三家。`
      : state.mode === "standard"
        ? "一般军棋：四家各 25 枚标准棋子，位置随机分布。"
        : "乱战发牌：100 枚棋子随机分成 4 组，每组 25 枚。");
    for (const seat of SEATS) {
      const flags = pieces.filter((p) => p.owner === seat && p.type === "flag").length;
      const cmds = pieces.filter((p) => p.owner === seat && p.type === "commander").length;
      state.log.push(`${B.SEAT_NAMES[seat]}：${flags} 面军旗 / ${cmds} 个司令。`);
    }
    return state;
  }

  // ---------- 存盘 / 复盘序列化 ----------
  function serializeState(state) {
    return {
      phase: state.phase,
      mode: state.mode,
      turn: state.turn,
      human: state.human,
      humanSeats: (state.humanSeats || [state.human]).slice(),
      agentSeats: (state.agentSeats || []).slice(),
      infoMode: state.infoMode || "normal",
      mindLink: state.mindLink ? Object.assign({}, state.mindLink) : null,
      log: (state.log || []).slice(),
      winner: state.winner,
      out: Object.assign({}, state.out),
      hqCaptured: Object.fromEntries(SEATS.map((s) => [s, [...(state.hqCaptured[s] || [])]])),
      initialFlags: Object.assign({}, state.initialFlags),
      raisedFlag: Object.assign({}, state.raisedFlag),
      pendingRaise: state.pendingRaise ? Object.assign({}, state.pendingRaise) : null,
      doubleFlag: Object.assign({}, state.doubleFlag),
      handTypes: Object.fromEntries(Object.entries(state.handTypes || {}).map(([k, v]) => [k, (v || []).slice()])),
      handFlags: Object.assign({}, state.handFlags),
      moveCount: state.moveCount,
      noCapture: state.noCapture,
      stats: JSON.parse(JSON.stringify(state.stats || {})),
      outOrder: (state.outOrder || []).slice(),
      lastMove: state.lastMove ? Object.assign({}, state.lastMove) : null,
      lastSound: state.lastSound,
      flagRevealSound: !!state.flagRevealSound,
      cheat: !!state.cheat,
      latentHuman: !!state.latentHuman,
      latentSeats: Object.assign({}, state.latentSeats),
      labelPool: (state.labelPool || []).slice(),
      labelPools: Object.fromEntries(SEATS.map((s) => [s, (state.labelPools && state.labelPools[s] ? state.labelPools[s] : []).slice()])),
      recordHistory: !!state.recordHistory,
      battles: (state.battles || []).map((b) => Object.assign({}, b)),
      moveTape: (state.moveTape || []).map((m) => Object.assign({}, m)),
      aiStyle: state.aiStyle || "mixed",
      aiProfiles: Object.assign({}, state.aiProfiles || {}),
      pieces: state.pieces.map((p) => {
        const out = Object.assign({}, p);
        if (p.domain) out.domain = [...p.domain];
        return out;
      }),
    };
  }

  function deserializeState(obj) {
    const state = {
      phase: obj.phase || "setup",
      mode: obj.mode === "standard" ? "standard" : "chaos",
      turn: obj.turn || "south",
      human: obj.human || "south",
      humanSeats: Array.isArray(obj.humanSeats) ? obj.humanSeats.slice() : [obj.human || "south"],
      agentSeats: (obj.agentSeats && obj.agentSeats.length) ? obj.agentSeats.slice() : [],
      infoMode: (obj.infoMode === "team" || obj.infoMode === "all") ? obj.infoMode : "normal",
      mindLink: (obj.mindLink && typeof obj.mindLink === "object")
        ? { A: !!obj.mindLink.A, B: !!obj.mindLink.B } : null,
      pieces: (obj.pieces || []).map((p) => {
        const q = Object.assign({}, p);
        if (p.domain) q.domain = new Set(p.domain);
        return q;
      }),
      log: Array.isArray(obj.log) ? obj.log.slice() : [],
      winner: obj.winner === undefined ? null : obj.winner,
      out: Object.assign({ north: false, east: false, south: false, west: false }, obj.out || {}),
      hqCaptured: {},
      initialFlags: Object.assign({ north: 0, east: 0, south: 0, west: 0 }, obj.initialFlags || {}),
      raisedFlag: Object.assign({ north: null, east: null, south: null, west: null }, obj.raisedFlag || {}),
      pendingRaise: obj.pendingRaise ? Object.assign({}, obj.pendingRaise) : null,
      doubleFlag: Object.assign({ north: false, east: false, south: false, west: false }, obj.doubleFlag || {}),
      handTypes: obj.handTypes || {},
      handFlags: Object.assign({ north: 0, east: 0, south: 0, west: 0 }, obj.handFlags || {}),
      moveCount: obj.moveCount || 0,
      noCapture: obj.noCapture || 0,
      stats: obj.stats && obj.stats.north ? obj.stats : makeStats(),
      outOrder: Array.isArray(obj.outOrder) ? obj.outOrder.slice() : [],
      lastMove: obj.lastMove ? Object.assign({}, obj.lastMove) : null,
      lastSound: obj.lastSound || null,
      flagRevealSound: !!obj.flagRevealSound,
      cheat: !!obj.cheat,
      latentHuman: !!obj.latentHuman,
      labelPool: Array.isArray(obj.labelPool) ? obj.labelPool.slice() : [],
      labelPools: obj.labelPools
        ? Object.fromEntries(SEATS.map((s) => [s, Array.isArray(obj.labelPools[s]) ? obj.labelPools[s].slice() : []]))
        : null,
      latentSeats: obj.latentSeats ? Object.assign({}, obj.latentSeats) : null,
      recordHistory: obj.recordHistory !== false,
      historyFrames: [],
      battles: Array.isArray(obj.battles) ? obj.battles.map((b) => Object.assign({}, b)) : [],
      moveTape: Array.isArray(obj.moveTape) ? obj.moveTape.map((m) => Object.assign({}, m)) : [],
      aiStyle: obj.aiStyle || "mixed",
      aiProfiles: Object.assign({}, obj.aiProfiles || {}),
    };
    state.repCounts = new Map();
    for (const seat of SEATS) state.hqCaptured[seat] = new Set((obj.hqCaptured && obj.hqCaptured[seat]) || []);
    // 兼容旧存档：只有 latentHuman + 单一 labelPool
    if (!state.latentSeats) {
      state.latentSeats = { north: false, east: false, south: false, west: false };
      if (state.latentHuman) state.latentSeats[state.human] = true;
    }
    if (!state.labelPools) {
      state.labelPools = { north: [], east: [], south: [], west: [] };
      state.labelPools[state.human] = (state.labelPool || []).slice();
    }
    for (const seat of SEATS) {
      if (!Array.isArray(state.labelPools[seat])) state.labelPools[seat] = [];
    }
    state.labelPool = state.labelPools[state.human];   // 兼容旧字段
    return state;
  }

  function pushHistory(state) {
    if (!state || !state.recordHistory) return;
    if (!Array.isArray(state.historyFrames)) state.historyFrames = [];
    state.historyFrames.push(serializeState(state));
  }

  function newGame(opts = {}) {
    // 双人模式：seats 只给两家（南 + 北），其余两家的象限空着。
    // 南北本是同队，所以必须临时改判队伍，否则「对家」会被当成队友（见 board.js setTeams）。
    const all = ["south", "west", "north", "east"];
    const order = (Array.isArray(opts.seats) && opts.seats.length >= 2)
      ? all.filter((s) => opts.seats.indexOf(s) >= 0)
      : all;
    const duel = order.length === 2;
    B.setTeams(duel ? { south: "A", north: "B", east: "X", west: "X" } : null);
    const mode = opts.mode === "standard" ? "standard" : "chaos";
    let pieces = [];
    let handTypes = {};
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        let hands;
        if (mode === "standard") {
          const army = armyTypes();
          hands = order.map(() => army.slice());
        } else {
          const full = dealRandom();
          hands = order.map((_, i) => full[i]);
        }
        pieces = [];
        handTypes = {};
        order.forEach((seat, i) => {
          handTypes[seat] = hands[i].slice();
          pieces.push(...placeTypes(seat, hands[i], { doubleFlag: false }));
        });
        break;
      } catch (err) { pieces = []; }
    }
    if (!pieces.length) throw new Error("发牌/布阵失败，请重试");
    return makeState(pieces, Object.assign({}, opts, { handTypes, mode }));
  }

  function newCheatGame(typesIn, opts = {}) {
    const picked = typesIn.slice();
    if (picked.length > 25) throw new Error("最多只能选 25 枚棋子");
    const pool = fullPool();
    const remain = pool.slice();
    for (const type of picked) {
      const i = remain.indexOf(type);
      if (i < 0) throw new Error("棋子数量不足: " + type);
      remain.splice(i, 1);
    }
    const shuffledRemain = shuffle(remain);
    const fillCount = 25 - picked.length;
    const humanHand = picked.concat(shuffledRemain.slice(0, fillCount));
    const rest = shuffledRemain.slice(fillCount);
    if (humanHand.length !== 25 || rest.length !== 75) throw new Error("剩余棋子数量异常");

    const others = ["north", "east", "west"];
    const pieces = [];
    const handTypes = { south: humanHand.slice(), north: [], east: [], west: [] };
    pieces.push(...placeTypes("south", humanHand, {}));
    others.forEach((seat, i) => {
      const hand = rest.slice(i * 25, i * 25 + 25);
      handTypes[seat] = hand.slice();
      pieces.push(...placeTypes(seat, hand, {}));
    });
    return makeState(pieces, {
      mode: "chaos", cheat: true, human: "south", handTypes, cheatPicked: picked.length,
      latent: !!opts.latent, latentSeats: opts.latentSeats, history: !!opts.history,
      humanSeats: opts.humanSeats, infoMode: opts.infoMode, agentSeats: opts.agentSeats,
    });
  }

  function startGame(state) {
    if (state.phase !== "setup") return false;
    if (anyLatent(state) && SEATS.some((s) => isLatentSeat(state, s) && poolOf(state, s).length === 0)) setupLatent(state);
    state.phase = "playing";
    state.turn = (state.seats && state.seats.length) ? state.seats[0] : "south";
    state.log.push("对局开始。");
    if (state.recordHistory) {
      state.historyFrames = [];
      pushHistory(state);
    }
    return true;
  }

  // ---------- 可见性 ----------
  // 只看得见自己的棋子，以及已亮明（公开或对友方亮明）的棋子；对家也不可见。
  function visibleTo(state, viewer, piece) {
    if (!piece || !piece.position) return false;
    if (piece.owner === viewer) return true;
    // 信息模式：team = 同队互相明牌（双明），all = 四家全明
    if (state && state.infoMode === "all") return true;
    if (state && state.infoMode === "team" && teamOf(piece.owner) === teamOf(viewer)) return true;
    // 单向心智链（2026-11-06）：只给「某一队」开队友互明。
    // 与 infoMode:"team" 的区别必须先说清：infoMode 是**全局规则**（双明，两边都明）；
    // mindLink 是按队授予的**能力**——战术 DLC 只给东西开，南北仍是四暗。
    // 所以用它做的胜率对照里混了两个东西：信息优势 + 配合优势，报数时必须分开写。
    if (state && state.mindLink && state.mindLink[teamOf(piece.owner)]
        && teamOf(piece.owner) === teamOf(viewer)) return true;
    if (piece.revealed) return true;
    if (piece.revealedTo && piece.revealedTo === teamOf(viewer)) return true;
    return false;
  }

  // ---------- 走法 ----------
  function isStraightRailPath(state, from, to) {
    for (const line of BOARD.straightRailLines) {
      const a = line.indexOf(from);
      const b = line.indexOf(to);
      if (a < 0 || b < 0 || a === b) continue;
      const lo = Math.min(a, b) + 1;
      const hi = Math.max(a, b);
      let clear = true;
      for (let i = lo; i < hi; i += 1) {
        if (pieceAt(state, line[i])) { clear = false; break; }
      }
      if (clear) return true;
    }
    return false;
  }

  function isEngineerRailPath(state, from, to) {
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const cur = queue.shift();
      for (const next of BOARD.railNeighbors.get(cur) || []) {
        if (seen.has(next)) continue;
        if (next === to) return true;
        if (pieceAt(state, next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  }

  // 这一步是不是「只能靠工兵的曲折铁路」走出来的：位移超过一格、又不是直线铁路，
  // 却能在铁路网里连通。除工兵外没有棋子能这么走，所以看到这种走法就等于明牌工兵。
  function isEngineerOnlyMove(state, from, to) {
    const a = BOARD.byId.get(from);
    const b = BOARD.byId.get(to);
    if (!a || !b) return false;
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1) return false;
    if (isStraightRailPath(state, from, to)) return false;
    return isEngineerRailPath(state, from, to);
  }

  function legalTargets(state, seat, from) {
    if (state.phase !== "playing" || state.turn !== seat) return [];
    const piece = pieceAt(state, from);
    if (!piece || piece.owner !== seat) return [];
    const node = BOARD.byId.get(from);
    if (!node) return [];
    if (PIECE_INFO[piece.type].immobile) return [];
    if (node.kind === "hq") return [];

    const targets = [];
    const fromRail = (BOARD.railNeighbors.get(from) || []).length > 0;
    for (const to of ALL_NODES) {
      if (to === from) continue;
      const target = BOARD.byId.get(to);
      const defender = pieceAt(state, to);
      if (defender && defender.owner === seat) continue;
      if (defender && isTeammate(defender.owner, seat)) continue;
      if (defender && target.kind === "camp") continue;

      const direct = (BOARD.neighbors.get(from) || []).includes(to);
      if (direct) { targets.push(to); continue; }
      if (!fromRail) continue;
      if (!(BOARD.railNeighbors.get(to) || []).length) continue;
      if (piece.type === "engineer" || piece.type === "missile") {
        if (isEngineerRailPath(state, from, to)) targets.push(to);
      } else if (isStraightRailPath(state, from, to)) {
        targets.push(to);
      }
    }
    return targets;
  }

  function allLegalMoves(state, seat) {
    const moves = [];
    for (const p of piecesOf(state, seat)) {
      if (PIECE_INFO[p.type].immobile) continue;
      if (BOARD.byId.get(p.position).kind === "hq") continue;
      for (const to of legalTargets(state, seat, p.position)) {
        moves.push({ from: p.position, to, piece: p });
      }
    }
    return moves;
  }

  // ---------- 战斗 ----------
  // 大本营中的棋子小于任何其他棋子：inHq=true 时攻击方必胜（炸弹同归于尽）。
  // 局面指纹：只取「谁在哪、是什么」，用于三次重复局面判和
  function positionKey(state) {
    const parts = [];
    for (const p of state.pieces) {
      if (!p.position) continue;
      parts.push(p.position + "|" + p.owner + "|" + p.type);
    }
    parts.sort();
    return parts.join(";");
  }

  function resolveBattle(attacker, defender, inHq = false, mode = "chaos") {
    if (!defender) return "move";
    if (defender.type === "flag") return attacker.type === "bomb" ? "both" : "attacker";
    if (inHq) return attacker.type === "bomb" ? "both" : "attacker";
    if (attacker.type === "bomb" || defender.type === "bomb") return "both";
    // 乱战：除工兵外，碰地雷两子同归于尽；一般军棋：非工兵撞雷，攻方死、雷保留
    if (defender.type === "mine") {
      if (attacker.type === "engineer") return "attacker";
      return mode === "standard" ? "defender" : "both";
    }
    const a = PIECE_INFO[attacker.type].rank;
    const d = PIECE_INFO[defender.type].rank;
    if (a === d) return "both";
    return a > d ? "attacker" : "defender";
  }

  function revealFlagsIfNoCommander(state, seat) {
    const cmds = state.pieces.filter((p) => p.owner === seat && p.type === "commander" && p.position);
    if (cmds.length === 0) {
      let any = false;
      state.pieces.filter((p) => p.owner === seat && p.type === "flag" && p.position)
        .forEach((f) => {
          if (!f.revealed) { f.revealed = true; any = true; }
        });
      if (any && state.phase === "playing") state.flagRevealSound = true;
      return any;
    }
    return false;
  }

  function killPiece(piece) {
    piece.position = null;
  }

  function countCommanders(state, seat) {
    return state.pieces.filter((p) => {
      if (p.owner !== seat || !p.position) return false;
      if (p.type === "commander") return true;
      if (p.latent && possibleTypesFor(state, p).includes("commander")) return true;
      return false;
    }).length;
  }
  function hasMobile(state, seat) {
    return state.pieces.some((p) => p.owner === seat && p.position
      && !PIECE_INFO[p.type].immobile
      && BOARD.byId.get(p.position).kind !== "hq");
  }

  function isDefeated(state, seat) {
    if (state.out[seat]) return true;
    const own = piecesOf(state, seat);
    const flags = own.filter((p) => p.type === "flag");
    const bothHq = hqCells(seat).every((id) => state.hqCaptured[seat].has(id));
    const cmds = own.filter((p) => p.type === "commander");

    if (state.initialFlags[seat] > 0 || state.raisedFlag[seat]) {
      if (flags.length === 0) return true;
    } else if (cmds.length > 0) {
      // 0 旗有司令：任一大本营被攻占立即败
      if (state.hqCaptured[seat].size > 0) return true;
    } else {
      // 0 旗 0 司令：两个大本营都被攻占才败
      if (bothHq) return true;
      if (state.pendingRaise && state.pendingRaise.seat === seat) return false;
    }
    if (!hasMobile(state, seat) && !(state.pendingRaise && state.pendingRaise.seat === seat)) return true;
    return false;
  }

  function eliminate(state, seat) {
    if (state.out[seat]) return;
    state.out[seat] = true;
    if (state.stats && state.stats[seat]) {
      state.stats[seat].survived = false;
      state.stats[seat].outAt = state.moveCount;
    }
    if (!Array.isArray(state.outOrder)) state.outOrder = [];
    state.outOrder.push({ seat, at: state.moveCount });
    for (const p of state.pieces) {
      if (p.owner === seat && p.position) {
        p.position = null;
        p.latent = false;
      }
    }
    if (isLatentSeat(state, seat)) { const lp = poolOf(state, seat); lp.length = 0; }
    if (state.pendingRaise && state.pendingRaise.seat === seat) state.pendingRaise = null;
    state.log.push(`${B.SEAT_NAMES[seat]} 出局。`);
  }

  function checkTeamWin(state) {
    const live = state.seats || SEATS;
    const aAlive = live.filter((s) => teamOf(s) === "A" && !state.out[s]);
    const bAlive = live.filter((s) => teamOf(s) === "B" && !state.out[s]);
    // 双人模式只有一个座位在一边，队伍文案会写成「A 队（南+北）」，所以按座位说
    const duel = !!(state.seats && state.seats.length === 2);
    if (aAlive.length === 0) {
      state.winner = "B"; state.phase = "over";
      state.log.push(duel ? `${B.SEAT_NAMES[bAlive[0]]}获胜。` : "B 队（东+西）获胜。");
      return true;
    }
    if (bAlive.length === 0) {
      state.winner = "A"; state.phase = "over";
      state.log.push(duel ? `${B.SEAT_NAMES[aAlive[0]]}获胜。` : "A 队（南+北）获胜。");
      return true;
    }
    return false;
  }

  function nextTurnAfter(state, seat) {
    const order = state.seats || TURN_ORDER;
    let next = order[(order.indexOf(seat) + 1) % order.length];
    for (let i = 0; i < 4 && state.out[next]; i += 1) {
      next = order[(order.indexOf(next) + 1) % order.length];
    }
    return next;
  }

  function raiseFlagAt(state, seat, hq) {
    const node = BOARD.byId.get(hq);
    if (!node || node.seat !== seat || node.kind !== "hq") return false;
    if (state.hqCaptured[seat].has(hq)) return false;
    const occupant = pieceAt(state, hq);
    if (occupant) {
      if (occupant.latent) dropLatent(state, occupant, occupant.type);
      else occupant.position = null;
      state.log.push(`${B.SEAT_NAMES[seat]} 升旗，移开大本营中的棋子。`);
    }
    const flag = {
      id: uid(), owner: seat, type: "flag", position: hq, revealed: true, revealedTo: null,
    };
    state.pieces.push(flag);
    state.initialFlags[seat] = 1;
    state.raisedFlag[seat] = hq;
    if (state.phase === "playing") state.flagRevealSound = true;
    state.log.push(`${B.SEAT_NAMES[seat]} 在 ${B.cellLabel(hq)} 升旗。`);
    return true;
  }

  function autoRaise(state, seat) {
    const hqs = hqCells(seat).filter((id) => !state.hqCaptured[seat].has(id));
    if (!hqs.length) return false;
    return raiseFlagAt(state, seat, hqs[Math.floor(Math.random() * hqs.length)]);
  }

  function applyMove(state, seat, from, to) {
    if (state.phase !== "playing") return { ok: false, message: "对局尚未开始" };
    if (state.turn !== seat) return { ok: false, message: "还没轮到你" };
    const targets = legalTargets(state, seat, from);
    if (!targets.includes(to)) return { ok: false, message: "这步不合法" };

    const attacker = pieceAt(state, from);
    const defender = pieceAt(state, to);
    const targetNode = BOARD.byId.get(to);
    if (defender && targetNode.kind === "camp") {
      return { ok: false, message: "行营中的棋子不会遭到攻击" };
    }
    const latentAttacker = !!(attacker && attacker.latent && isLatentSeat(state, attacker.owner));
    const latentDefender = !!(defender && defender.latent && isLatentSeat(state, defender.owner));
    const humanLatentAttacker = latentAttacker;
    if (humanLatentAttacker) attacker.moved = true;
    const inHq = state.mode === "chaos" && targetNode.kind === "hq" && targetNode.seat !== seat;
    let battleOutcome = null;
    if (latentAttacker && moveRequiresEngineer(state, seat, from, to)) {
      if (!poolOf(state, seat).includes("engineer")) return { ok: false, message: "这步只有工兵能走，但预备队没有工兵" };
      attacker.engineerOnly = true;
      attacker.domain = new Set(["engineer"]);
      refreshLatent(state);
    }
    if (defender && (latentAttacker || latentDefender)) {
      if (latentAttacker) {
        attacker.type = chooseLatentType(state, attacker, defender.type, true, inHq);
        attacker.actualType = attacker.type;
        attacker.hasFought = true;
      }
      if (latentDefender) {
        defender.type = chooseLatentType(state, defender, attacker.type, false, inHq);
        defender.actualType = defender.type;
        defender.hasFought = true;
      }
    }
    const aliveBefore = state.pieces.filter((p) => p.position).length;
    const cmdsBefore = {};
    for (const s of SEATS) cmdsBefore[s] = countCommanders(state, s);

    let message = "";
    let sound = "move";

    if (!defender) {
      attacker.position = to;
      if (targetNode.kind === "hq" && targetNode.seat !== seat) {
        state.hqCaptured[targetNode.seat].add(to);
        message = `${B.SEAT_NAMES[seat]} 进入 ${B.SEAT_NAMES[targetNode.seat]} 大本营。`;
        sound = "flag";
      } else {
        message = `${B.SEAT_NAMES[seat]} 走子 ${B.cellLabel(from)} → ${B.cellLabel(to)}。`;
      }
    } else {
      const outcome = resolveBattle(attacker, defender, inHq, state.mode);
      battleOutcome = outcome;
      if (!state.battles) state.battles = [];
      // attType/attSeat 用于「攻方已死」时反推守方等级：
      // 自己的子撞死时，类型是公开信息（我知道派了谁去），可以推出「对方至少是 X」。
      state.battles.push({
        attacker: attacker.id, defender: defender.id, outcome, inHq,
        attType: attacker.type, attSeat: attacker.owner,
      });
      // 除工兵主动出击外，不公开对方棋子的身份
      const isEngineerScout = attacker.type === "engineer" && outcome === "defender"
        && defender.type !== "mine" && defender.type !== "bomb";
      if (isEngineerScout) defender.revealedTo = teamOf(seat);

      if (defender.type === "flag") {
        recordDeath(state, defender, seat);
        killPiece(defender);
        state.hqCaptured[defender.owner].add(to);
        if (attacker.type === "bomb") { recordDeath(state, attacker, defender.owner); killPiece(attacker); }
        else attacker.position = to;
        message = `${B.SEAT_NAMES[seat]} 的棋子挖掉 ${B.SEAT_NAMES[defender.owner]} 的军旗！`;
        sound = "dead";
      } else if (outcome === "both") {
        recordDeath(state, attacker, defender.owner);
        recordDeath(state, defender, seat);
        killPiece(attacker); killPiece(defender);
        message = "双方棋子同归于尽。";
        sound = "equal";
      } else if (outcome === "attacker") {
        recordDeath(state, defender, seat);
        killPiece(defender);
        attacker.position = to;
        if (targetNode.kind === "hq") state.hqCaptured[targetNode.seat].add(to);
        message = `${B.SEAT_NAMES[seat]} 的棋子吃掉对方一个棋子。`;
        sound = "attack";
      } else {
        recordDeath(state, attacker, defender.owner);
        killPiece(attacker);
        if (isEngineerScout) {
          message = `${B.SEAT_NAMES[seat]} 的工兵侦察了 ${B.SEAT_NAMES[defender.owner]} 的一个棋子。`;
        } else {
          message = `对方棋子吃掉 ${B.SEAT_NAMES[seat]} 的一个棋子。`;
        }
        sound = "die";
      }
      if (defender.type === "commander") revealFlagsIfNoCommander(state, defender.owner);
      if (attacker.type === "commander") revealFlagsIfNoCommander(state, attacker.owner);
    }

    if (!defender && humanLatentAttacker) refreshLatent(state);
    if (defender && latentAttacker) {
      if (battleOutcome !== "attacker") {
        if (attacker.type === "commander") cmdsBefore[attacker.owner] = Math.max(cmdsBefore[attacker.owner] || 0, 1);
        dropLatent(state, attacker, attacker.type);
      } else {
        recordLatentWin(state, attacker, attacker.type, defender.type, inHq);
      }
    }
    if (defender && latentDefender) {
      if (battleOutcome !== "defender") {
        if (defender.type === "commander") cmdsBefore[defender.owner] = Math.max(cmdsBefore[defender.owner] || 0, 1);
        dropLatent(state, defender, defender.type);
      } else {
        recordLatentWin(state, defender, defender.type, attacker.type, inHq);
      }
    }
    if (latentAttacker && battleOutcome !== "attacker" && attacker.type === "commander") {
      revealFlagsIfNoCommander(state, attacker.owner);
    }
    if (latentDefender && battleOutcome !== "defender" && defender.type === "commander") {
      revealFlagsIfNoCommander(state, defender.owner);
    }

    const aliveAfter = state.pieces.filter((p) => p.position).length;
    if (aliveAfter < aliveBefore) state.noCapture = 0;
    else state.noCapture += 1;
    state.moveCount += 1;
    if (state.stats && state.stats[seat]) state.stats[seat].moves += 1;
    state.lastMove = { seat, from, to };
    // 走子磁带（公开信息）：谁把哪枚子从哪走到哪、撞出什么结果。
    // eng 标记「只有工兵能这么走」（曲折铁路），是敌方工兵的公开证据。
    if (!Array.isArray(state.moveTape)) state.moveTape = [];
    state.moveTape.push({
      seat, piece: attacker.id, from, to,
      cap: defender ? defender.id : null,
      out: battleOutcome || "move",
      eng: isEngineerOnlyMove(state, from, to),
    });
    if (state.moveTape.length > 200) state.moveTape.splice(0, state.moveTape.length - 200);
    state.lastSound = sound;
    state.log.push(message);
    state.log = state.log.slice(-200);

    // 出局判定
    for (const victim of SEATS) {
      if (!state.out[victim] && isDefeated(state, victim)) eliminate(state, victim);
    }
    if (checkTeamWin(state)) { pushHistory(state); return { ok: true, message, winner: state.winner, sound }; }

    // 最后一个司令阵亡且 0 旗：升旗
    for (const s of SEATS) {
      if (state.out[s]) continue;
      if (state.initialFlags[s] === 0 && !state.raisedFlag[s]
          && cmdsBefore[s] > 0 && countCommanders(state, s) === 0) {
        const bothHq = hqCells(s).every((id) => state.hqCaptured[s].has(id));
        if (bothHq || !hasMobile(state, s)) continue;
        if (state.pendingRaise) break;
        if (s === state.human) {
          state.phase = "raise";
          state.pendingRaise = { seat: s, nextTurn: nextTurnAfter(state, seat) };
          state.log.push(`${B.SEAT_NAMES[s]} 最后一个司令阵亡，需要选择大本营升旗。`);
          pushHistory(state);
          return { ok: true, message, pendingRaise: true, sound };
        }
        autoRaise(state, s);
      }
    }

    if (state.phase === "raise") { pushHistory(state); return { ok: true, message, pendingRaise: true, sound }; }

    // 三次重复局面：AI 容易互相对摆，直接判和，避免白耗几百步
    const repKey = positionKey(state);
    if (!state.repCounts) state.repCounts = new Map();
    const repN = (state.repCounts.get(repKey) || 0) + 1;
    state.repCounts.set(repKey, repN);
    if (state.repCounts.size > 600) state.repCounts.clear();
    if (repN >= 3) {
      state.phase = "over";
      state.winner = null;
      state.log.push("同一局面重复出现三次，判和。");
      pushHistory(state);
      return { ok: true, message, draw: true, sound };
    }

    if (state.noCapture >= 60 || state.moveCount >= 1200) {
      state.phase = "over";
      state.winner = null;
      state.log.push("长时间无战损，判和。");
      pushHistory(state);
      return { ok: true, message, draw: true, sound };
    }

    state.turn = nextTurnAfter(state, seat);
    pushHistory(state);
    return { ok: true, message, sound };
  }

  function raiseFlag(state, seat, hq) {
    if (state.phase !== "raise" || !state.pendingRaise || state.pendingRaise.seat !== seat) return false;
    if (!raiseFlagAt(state, seat, hq)) return false;
    const next = state.pendingRaise.nextTurn;
    state.pendingRaise = null;
    state.phase = "playing";
    state.turn = next;
    if (isDefeated(state, seat)) {
      eliminate(state, seat);
      if (!checkTeamWin(state)) state.turn = nextTurnAfter(state, seat);
    }
    pushHistory(state);
    return true;
  }

  function noMoves(state, seat) {
    if (state.phase !== "playing") return false;
    eliminate(state, seat);
    if (checkTeamWin(state)) { pushHistory(state); return true; }
    state.turn = nextTurnAfter(state, seat);
    pushHistory(state);
    return true;
  }

  // ---------- 布阵辅助 ----------
  function swapSetup(state, seat, a, b) {
    if (state.phase !== "setup") return false;
    const pa = pieceAt(state, a);
    if (!pa || pa.owner !== seat) return false;
    const pb = pieceAt(state, b);
    if (pb && pb.owner !== seat) return false;
    const mineCount = state.pieces.filter((p) => p.owner === seat && p.position && p.type === "mine").length;
    const opts = { allowMineRow3: mineCount >= 8 };
    if (!canPlace(pa.type, seat, b, opts)) return false;
    if (pb && !canPlace(pb.type, seat, a, opts)) return false;
    pa.position = b;
    if (pb) pb.position = a;
    return true;
  }

  function autoArrange(state, seat, opts = {}) {
    if (state.phase !== "setup") return;
    const own = piecesOf(state, seat);
    const types = (state.handTypes[seat] || own.map((p) => p.type)).slice();
    const repl = placeTypes(seat, types, {
      doubleFlag: opts.doubleFlag !== undefined ? opts.doubleFlag : !!state.doubleFlag[seat],
    });
    state.pieces = state.pieces.filter((p) => p.owner !== seat).concat(repl);
    state.initialFlags[seat] = repl.filter((p) => p.type === "flag").length;
  }

  function setDoubleFlag(state, seat, value) {
    if (state.phase !== "setup") return false;
    const flagCount = state.handFlags[seat] || 0;
    if (value && flagCount < 2) return false;
    state.doubleFlag[seat] = !!value;
    autoArrange(state, seat, { doubleFlag: !!value });
    return true;
  }

  // ---------- AI ----------
  function unseenDistribution(state, seat) {
    const counts = new Map();
    let total = 0;
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (isTeammate(p.owner, seat)) continue;
      if (visibleTo(state, seat, p)) continue;
      counts.set(p.type, (counts.get(p.type) || 0) + 1);
      total += 1;
    }
    if (total === 0) {
      for (const [type, info] of Object.entries(PIECE_INFO)) counts.set(type, info.count);
      total = Object.values(PIECE_INFO).reduce((s, i) => s + i.count, 0);
    }
    return { counts, total };
  }

  function positionScore(state, seat, piece, from, to) {
    let score = 0;
    const enemies = SEATS.filter((s) => isEnemy(s, seat) && !state.out[s]);
    let oldD = Infinity, newD = Infinity;
    for (const e of enemies) {
      for (const hq of hqCells(e)) {
        const d = B.distancesTo(hq);
        oldD = Math.min(oldD, d.get(from) ?? 99);
        newD = Math.min(newD, d.get(to) ?? 99);
      }
    }
    if (isFinite(oldD) && isFinite(newD)) score += (oldD - newD) * 0.45;
    const node = BOARD.byId.get(to);
    if (node && node.kind === "camp") score += 0.8;
    if (node && node.kind === "hq") {
      if (node.seat !== piece.owner) {
        // 敌营只有在「营里确实有子」时才值得进：空营进去就再也动不了，
        // 该家已经出局更是毫无意义。一代有 isUselessHqMove、二代有 dropUselessHq，
        // 唯独这条兜底路径没有 —— AI 一旦抛错退到这里，就会把子白送进死营。
        const ownerOut = !!(state.out && state.out[node.seat]);
        if (ownerOut || !pieceAt(state, to)) score -= 12.0;
        else score += 2.0;
      } else {
        score -= 4.0;
      }
    }
    return score;
  }

  function scoreMove(state, seat, move) {
    const { from, to, piece } = move;
    const defender = pieceAt(state, to);
    const targetNode = BOARD.byId.get(to);
    const inHq = state.mode === "chaos" && !!targetNode && targetNode.kind === "hq" && targetNode.seat !== piece.owner;
    let score = positionScore(state, seat, piece, from, to);
    if (!defender) return score;

    if (visibleTo(state, seat, defender)) {
      const outcome = resolveBattle(piece, defender, inHq, state.mode);
      const dv = VALUE[defender.type] || 1;
      const av = VALUE[piece.type] || 1;
      if (outcome === "attacker") score += dv + (defender.type === "flag" ? 200 : 0);
      else if (outcome === "defender") score -= av;
      else score += dv - av;
      if (inHq) score += 4;
      return score;
    }

    const { counts, total } = unseenDistribution(state, seat);
    const av = VALUE[piece.type] || 1;
    let ev = 0;
    for (const [type, c] of counts) {
      const p = c / total;
      const outcome = resolveBattle(piece, { type }, inHq, state.mode);
      const dv = VALUE[type] || 1;
      if (outcome === "attacker") ev += p * (dv + (type === "flag" ? 200 : 0));
      else if (outcome === "defender") ev += p * (-av);
      else ev += p * (dv - av);
    }
    score += ev;
    if (inHq) score += 3;
    return score;
  }

  function aiChoose(state, seat) {
    const moves = allLegalMoves(state, seat);
    if (!moves.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const m of moves) {
      const s = scoreMove(state, seat, m) + Math.random() * 0.55;
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  function randomMove(state, seat) {
    const moves = allLegalMoves(state, seat);
    if (!moves.length) return null;
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const API = {
    TURN_ORDER, VALUE, shuffle, pieceAt, piecesOf, isTeammate, isEnemy,
    newGame, newCheatGame, startGame, dealRandom, placeTypes, canPlace, ownCells,
    visibleTo, legalTargets, allLegalMoves, applyMove, resolveBattle,
    isDefeated, aiChoose, randomMove, swapSetup, autoArrange, setDoubleFlag, raiseFlag,
    noMoves, revealFlagsIfNoCommander, armyTypes, fullPool,
    possibleTypesFor, serializeState, deserializeState, pushHistory,
  };
  global.JunqiGame = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
