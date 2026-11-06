/*
 * 四国军棋 · 二代陪玩（行为克隆，可见视角）
 *
 * 纯 JS 前向，同步推理 —— 之所以不用 ONNX/ORT：游戏是双击 index.html 用 file:// 打开的，
 * fetch(.onnx) 会被 CORS 拦、WASM 运行时又要走 CDN。内嵌权重 + 手写前向最稳。
 *
 * 接入方式（不改 game.js / ai.js 逻辑，只做观察与路由）：
 *   · 包一层 G.applyMove 观察所有走子，复刻训练时的可见性跟踪（碰子双方明牌 / 动过标记）
 *   · 包一层 JunqiAI.choose：当 state.aiStyle === "bc" 时走本模型，否则原样交给一代 ai.js
 *   · 任何异常自动回退一代，不会卡住对局
 *
 * 与训练端的一致性：编码、通道顺序、坐标系、座次映射与 training/jgs_bc.py 的
 * make_input_vis 逐元素一致（Node 侧已验证差异为 0）。
 */
(function (root) {
  "use strict";

  const B = root.JunqiBoard;
  const G = root.JunqiGame;
  if (!B || !G) return;

  const N = 17;
  const NC = N * N;
  // 29 = 25 基础 + 4 时序（上一手 from/to、上上手 from/to）
  // 时序通道让模型知道「刚刚发生了什么」，这是配合与响应的前提
  // 29 = 25 基础 + 4 时序；31 = 再加 2 个「可吃未吃」（上一手/上上手本来能吃却没吃的格子）。
  // 具体用几路，由权重 meta.in_ch 决定，老权重（29）照样能跑。
  let N_CH = 29;
  const EMPTY = 48;

  const PIECE_VALUE = {
    flag: 2, mine: 3, bomb: 4, commander: 5, army: 6, division: 7,
    brigade: 8, regiment: 9, battalion: 10, company: 11, platoon: 12, engineer: 13,
  };
  // JGS 的 E/S/W/N ↔ 本项目 east/north/west/south
  const SEAT_ACTOR = { east: 0, north: 1, west: 2, south: 3 };

  const revealed = new Set();   // piece.id 公开明牌
  const moved = new Set();      // piece.id 动过
  const recentMoves = [];       // 最近两手 [{from,to}]，最新在前；编码进 25-28 通道
  const skipPlanes = [];        // 最近两手「可吃未吃」的格子，最新在前；编码进 29-30 通道

  let W = null;                 // name -> Float32Array
  let loadFailed = false;

  // ---------------- 权重 ----------------
  function ensureWeights() {
    if (W) return true;
    if (loadFailed) return false;
    const p = root.JUNQI_BC_WEIGHTS;
    if (!p || !p.b64) return false;
    try {
      const bin = root.atob(p.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const all = new Float32Array(bytes.buffer);
      if (p.meta && p.meta.in_ch) N_CH = p.meta.in_ch;
      W = {};
      for (let i = 0; i < p.meta.tensors.length; i += 1) {
        const t = p.meta.tensors[i];
        W[t.name] = all.subarray(t.offset, t.offset + t.count);
      }
      root.JUNQI_BC_WEIGHTS.b64 = null;   // 释放那 27MB 字符串
      return true;
    } catch (err) {
      loadFailed = true;
      console.error("[BC] 权重解码失败", err);
      return false;
    }
  }

  // ---------------- 前向 ----------------
  const EPS = 1e-5;

  function convBNReLU(inp, inC, outC, wName, bName, bn) {
    const Wc = W[wName], Wb = W[bName];
    const g = W[bn[0]], be = W[bn[1]], mu = W[bn[2]], va = W[bn[3]];
    const out = new Float32Array(outC * NC);
    for (let oc = 0; oc < outC; oc += 1) {
      const oBase = oc * NC;
      const scale = g[oc] / Math.sqrt(va[oc] + EPS);
      const shift = (Wb[oc] - mu[oc]) * scale + be[oc];
      out.fill(shift, oBase, oBase + NC);
      const wBase = oc * inC * 9;
      for (let ic = 0; ic < inC; ic += 1) {
        const iBase = ic * NC;
        const wIc = wBase + ic * 9;
        for (let ky = 0; ky < 3; ky += 1) {
          for (let kx = 0; kx < 3; kx += 1) {
            const w = Wc[wIc + ky * 3 + kx] * scale;
            if (w === 0) continue;
            const x0 = kx === 0 ? 1 : 0;
            const x1 = kx === 2 ? N - 1 : N;
            for (let y = 0; y < N; y += 1) {
              const sy = y + ky - 1;
              if (sy < 0 || sy >= N) continue;
              const sRow = iBase + sy * N;
              const dRow = oBase + y * N;
              const off = kx - 1;
              for (let x = x0; x < x1; x += 1) out[dRow + x] += w * inp[sRow + x + off];
            }
          }
        }
      }
      for (let i = oBase; i < oBase + NC; i += 1) if (out[i] < 0) out[i] = 0;
    }
    return out;
  }

  function linear(inp, inN, outN, wName, bName, relu) {
    const Wl = W[wName], bl = W[bName];
    const out = new Float32Array(outN);
    for (let o = 0; o < outN; o += 1) {
      let s = bl[o];
      const base = o * inN;
      for (let i = 0; i < inN; i += 1) s += Wl[base + i] * inp[i];
      out[o] = relu && s < 0 ? 0 : s;
    }
    return out;
  }

  function encode(x) {
    const h1 = convBNReLU(x, N_CH, 32, "body.0.weight", "body.0.bias",
      ["body.1.weight", "body.1.bias", "body.1.running_mean", "body.1.running_var"]);
    const h2 = convBNReLU(h1, 32, 48, "body.3.weight", "body.3.bias",
      ["body.4.weight", "body.4.bias", "body.4.running_mean", "body.4.running_var"]);
    const h3 = convBNReLU(h2, 48, 64, "body.6.weight", "body.6.bias",
      ["body.7.weight", "body.7.bias", "body.7.running_mean", "body.7.running_var"]);
    const h = linear(h3, 64 * NC, 256, "fc.1.weight", "fc.1.bias", true);
    const fl = linear(h, 256, 289, "from_head.weight", "from_head.bias", false);
    // value_head 一直在权重里（训练时 jgs_bc 的 `values` 标签训的就是它），
    // 但推理端从没读过 —— 等于训练成果只用了策略那一半。这里补上：
    // 输出是「当前 seat 视角的最终胜负」，正 = 我方有利，量纲约 [-1, 1]。
    const v = linear(h, 256, 1, "value_head.weight", "value_head.bias", false)[0];
    return { h3: h3, h: h, fromLogits: fl, value: v };
  }

  function toLogits(h3, h, fromIdx) {
    const pe = W["pos_emb.weight"];
    const inp = new Float32Array(256 + 64 + 32);
    inp.set(h, 0);
    for (let oc = 0; oc < 64; oc += 1) inp[256 + oc] = h3[oc * NC + fromIdx];
    for (let k = 0; k < 32; k += 1) inp[320 + k] = pe[fromIdx * 32 + k];
    const mid = linear(inp, 352, 256, "to_head.0.weight", "to_head.0.bias", true);
    return linear(mid, 256, 289, "to_head.2.weight", "to_head.2.bias", false);
  }

  // ---------------- 可见视角编码 ----------------
  // 【坐标系】训练侧 jgs_bc.py 直接把 JGS 原始 17×17 塞进网络：中央九点落在
  // (6+2c, 6+2r)（与四家第 0/2/4 列对齐，间距 2）。board.js 的逻辑坐标为了让
  // 曼哈顿距离 == 相邻，把中央挤成 (7+c, 7+r)（间距 1）。直接用 y*17+x 会让
  // 中央 9 格的 rank/owner 通道和 from/to logits 全部错位一格 —— 推理看到的
  // 中央区域和训练时不是同一个地方。这里显式换算回 JGS 坐标。
  function cellIndex(position) {
    const node = B.BOARD.byId.get(position);
    if (!node) return -1;
    if (node.seat === null) return (6 + 2 * node.row) * N + (6 + 2 * node.col);
    return node.y * N + node.x;
  }

  // 这一手「本来可以吃、但没吃」的格子：用走子前的合法目标 ∩ 敌方占位，减掉真正吃的那个
  function skippedCapturePlane(state, seat, from, to) {
    const plane = new Uint8Array(NC);
    let targets = [];
    try { targets = G.legalTargets(state, seat, from) || []; } catch (err) { return plane; }
    for (const cell of targets) {
      if (cell === to) continue;
      const p = G.pieceAt(state, cell);
      if (!p || p.owner === seat) continue;
      if (B.teamOf(p.owner) === B.teamOf(seat)) continue;
      const ci = cellIndex(cell);
      if (ci >= 0) plane[ci] = 1;
    }
    return plane;
  }

  function buildInput(state, seat) {
    const actor = SEAT_ACTOR[seat];
    const x = new Float32Array(N_CH * NC);
    const rank = new Int8Array(NC).fill(-1);
    const owner = new Int8Array(NC).fill(-1);
    const hidMoved = new Uint8Array(NC);

    for (let i = 0; i < state.pieces.length; i += 1) {
      const p = state.pieces[i];
      if (!p.position) continue;
      const idx = cellIndex(p.position);
      if (idx < 0) continue;
      const v = PIECE_VALUE[p.type];
      if (v === undefined) continue;
      owner[idx] = SEAT_ACTOR[p.owner];
      if (p.owner === seat || revealed.has(p.id)) rank[idx] = v - 2;
      else if (moved.has(p.id)) hidMoved[idx] = 1;
    }

    for (let i = 0; i < NC; i += 1) {
      const o = owner[i];
      if (o < 0) continue;
      if (rank[i] >= 0) {
        x[rank[i] * NC + i] = 1;
        x[(12 + o) * NC + i] = 1;
      } else {
        x[(16 + o) * NC + i] = 1;
        if (hidMoved[i]) x[20 * NC + i] = 1;
      }
    }
    x.fill(1, (21 + actor) * NC, (21 + actor) * NC + NC);

    // 25-28 时序通道：上一手 from/to、上上手 from/to
    // 与 training/bc_player.js、training/jgs_bc.py 的 make_input_vis 同口径。
    for (let k = 0; k < 2; k += 1) {
      const mv = recentMoves[k];
      if (!mv) continue;
      const fi = cellIndex(mv.from);
      const ti = cellIndex(mv.to);
      if (fi >= 0) x[(25 + k * 2) * NC + fi] = 1;
      if (ti >= 0) x[(26 + k * 2) * NC + ti] = 1;
    }
    if (N_CH > 29 && skipPlanes[0]) {
      for (let k = 0; k < 2; k += 1) {
        const pl = skipPlanes[k];
        if (!pl) continue;
        const base = (29 + k) * NC;
        for (let i = 0; i < NC; i += 1) if (pl[i]) x[base + i] = 1;
      }
    }
    // 29-31 全局特征：双方存活子数 / 差。
    // 对齐 training/jgs_bc.py 的 make_input_vis 末尾那 3 路（N_FTR_CH=3）。
    // 加它的原因：没有全局标量时，网络要自己从 12 个兵种平面里学「求和」，
    // 实测 value 头 AUC 只有 0.65、开局段 0.42（比随机还差）。
    // 存活子数是四国里**完全公开**的信息，所以训练/推理两侧能精确对齐，不存在偷看。
    if (N_CH >= 32) {
      const base = N_CH - 3;
      let myCnt = 0;
      let foeCnt = 0;
      for (const p of state.pieces) {
        if (!p.position) continue;
        if ((SEAT_ACTOR[p.owner] % 2) === (actor % 2)) myCnt += 1;
        else foeCnt += 1;
      }
      const mc = myCnt / 50;
      const fc = foeCnt / 50;
      x.fill(mc, base * NC, (base + 1) * NC);
      x.fill(fc, (base + 1) * NC, (base + 2) * NC);
      x.fill(mc - fc, (base + 2) * NC, (base + 3) * NC);
    }
    return x;
  }

  // 规则层：借用一代的子力记忆（每个座位各一份），把「已知打不过还去撞」的走法删掉。
  // 这不是融合策略——网络打分完全不变，只是在它给出的合法走法里剪掉必亏的撞击。
  function memoryOf(state, seat) {
    const AI = root.JunqiAI;
    if (!AI || !AI._internals || !AI._internals.rankMemory) return null;
    try { return AI._internals.rankMemory(state, seat); } catch (err) { return null; }
  }

  // 浏览器里没有 process：直接写 process.env.X 会抛 ReferenceError，
  // 而 ui.js 的 try/catch 会把它吞掉、退到 game.js 的兜底走子（那里的启发式很粗）。
  // 线上「北家钻进已出局玩家空大本营」就是这么来的：二代整个 choose 抛错 → 兜底乱走。
  const ENV = (typeof process !== "undefined" && process.env) ? process.env : {};

  // 不许往「没有旗的大本营」里钻：
  //   ① 对方已被扛旗出局（另一个营必然是空的）
  //   ② 空的大本营（旗只在大本营，空着就是没旗）
  //   ③ 已经看得见对方的旗在另一个大本营
  // 这三类都是纯浪费——乱战里进敌方大本营的子再也动不了。
  function dropUselessHq(state, seat, moves) {
    const myTeam = B.teamOf(seat);
    const out = state.out || {};
    const knownFlag = new Set();
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (p.type !== "flag") continue;
      if (B.teamOf(p.owner) === myTeam) continue;
      let vis = false;
      try { vis = G.visibleTo(state, seat, p); } catch (err) { vis = false; }
      if (vis) knownFlag.add(p.owner);
    }
    const safe = moves.filter((m) => {
      const node = B.BOARD.byId.get(m.to);
      if (!node || node.kind !== "hq" || !node.seat) return true;
      if (node.seat === seat || B.teamOf(node.seat) === myTeam) return true;
      if (out[node.seat] === true || (out.has && out.has(node.seat))) return false;
      const piece = G.pieceAt(state, m.to);
      if (!piece) return false;
      if (piece.type === "flag") return true;
      if (knownFlag.has(node.seat)) return false;
      return true;
    });
    return safe.length ? safe : moves;
  }

  // 不许「原地打转」：同一枚子最近 4 次落点里已经到过的格子，不再去。
  // 二代是纯 argmax 策略（没有搜索），而人类棋谱里「四手内回到同一格」占 14.9%——
  // 网络把这个习惯直接学了下来，自己下就变成 23.5%（一代有硬过滤，只有 1.0%）。
  // 这是可观测的硬指标，先用规则压住，再谈换训练数据。
  function dropBacktrack(state, seat, moves) {
    // 默认关：实测硬过滤会把「来回摆」压到 0.4%，但同时让攻击率 27.7%→20.3%、
    // 推进 0.78→0.64、最长无战斗 29→60 手——只是把摆棋换了个地方，反而更糟。
    // 留着开关（JJ_BC_BACKTRACK=1）便于以后配合搜索复测。
    if (ENV.JJ_BC_BACKTRACK !== "1") return moves;
    const tape = state.moveTape || [];
    const recent = new Map();          // pieceId -> 最近落点
    for (let i = tape.length - 1; i >= 0; i -= 1) {
      const t = tape[i];
      const arr = recent.get(t.piece);
      if (!arr) recent.set(t.piece, [t.to]);
      else if (arr.length < 4) arr.push(t.to);
    }
    const keep = moves.filter((m) => {
      const a = G.pieceAt(state, m.from);
      if (!a) return true;
      const arr = recent.get(a.id);
      if (!arr) return true;
      return arr.indexOf(m.to) < 0;
    });
    return keep.length ? keep : moves;
  }

  function dropKnownSuicide(state, seat, moves) {
    const AI = root.JunqiAI;
    if (!AI || !AI._internals || !AI._internals.isKnownSuicide) return moves;
    const mem = memoryOf(state, seat);
    if (!mem) return moves;
    const safe = moves.filter((m) => {
      try { return !AI._internals.isKnownSuicide(state, seat, m, mem, null); } catch (err) { return true; }
    });
    return safe.length ? safe : moves;      // 全被剪掉就退回原表，宁可照原样走
  }

  // ---------------- 雷区防护 + 工兵保存（2026-11-03） ----------------
  // 二代的 policy 是纯「像人一样走」，网络里没有「这格可能是雷」的概念，
  // 实测撞雷 5.3 次/百手（一代 3.4），而工兵挖雷 0 次 —— 雷区等于不存在。
  // 这两条是**规则补丁**（不改网络意愿，只把明显送死的候选删掉）：
  //   ① 隐藏 + 从开局没动过 + row>=4 的敌子 = 疑似雷：司/军/师/炸 不去踩（敌营除外，那是扛旗）
  //   ② 前 55 手不让工兵从后场飞到一线（它是唯一的挖雷工具，前期飞上去就废了）
  const MINE_GUARD = ENV.JJ_BC_MINE !== "0";
  const ENG_HOLD = ENV.JJ_BC_HOLD !== undefined ? Number(ENV.JJ_BC_HOLD) : 55;
  const BIG_ATT = { commander: 1, army: 1, division: 1, bomb: 1 };

  function everMoved(state, piece) {
    const tape = state.moveTape || [];
    for (let i = tape.length - 1; i >= 0; i -= 1) if (tape[i].piece === piece.id) return true;
    return false;
  }

  // 工兵打未知子的盈亏平衡：赚 75（雷 35+40）、亏 48 ⇒ 盈亏点 0.39，阈值放 0.35
  const ENG_PM = ENV.JJ_BC_ENG_PM !== undefined ? Number(ENV.JJ_BC_ENG_PM) : 0.35;

  function flagKnown(state, seat) {
    for (const p of state.pieces) {
      if (p.type !== "flag" || !p.position) continue;
      if (B.teamOf(p.owner) === B.teamOf(seat)) continue;
      try { if (G.visibleTo(state, seat, p)) return true; } catch (err) { /* ignore */ }
    }
    return false;
  }

  // 目标可能是雷的概率：借一代的信念行（bc 自己没有信念头）
  function mineProbOf(state, seat, d) {
    try {
      if (G.visibleTo(state, seat, d)) return d.type === "mine" ? 1 : 0;
    } catch (err) { /* ignore */ }
    try {
      const I = AI._internals;
      const doms = I.inferDomains(state, seat);
      const rows = I.beliefRowsView(state, seat, doms);
      const row = rows && rows.get(d.id);
      if (row && row.get) return row.get("mine") || 0;
    } catch (err) { /* ignore */ }
    return 0;
  }

  function dropMineAndEarlyEngineer(state, seat, moves) {
    if (!MINE_GUARD && !(ENG_HOLD > 0)) return moves;
    const ply = state.moveCount || 0;
    const keep = [];
    for (const m of moves) {
      const a = G.pieceAt(state, m.from);
      if (!a) { keep.push(m); continue; }
      const d = G.pieceAt(state, m.to);
      const nd = B.BOARD.byId.get(m.to);
      // ① 疑似雷：大子/炸弹不去踩
      if (MINE_GUARD && d && d.owner !== seat && nd && nd.seat && nd.row >= 4
          && nd.kind !== "hq" && !G.visibleTo(state, seat, d) && !everMoved(state, d)
          && BIG_ATT[a.type]) {
        continue;
      }
      // ② 工兵前期别飞（自家半场）
      if (ENG_HOLD > 0 && a.type === "engineer" && ply < ENG_HOLD) {
        const nf = B.BOARD.byId.get(m.from);
        if (nd && nf && nd.seat === a.owner && nf.seat === a.owner && nd.row <= 1 && nf.row >= 2) continue;
        // ③ 也别飞过河去撞未知子：工兵打任何普通子都是自己死，只有打雷是赚的。
        //    实测（4 局前 55 手）二代有 22 次这种攻击，撞死 13 次，目标里只有 8/22 是雷。
        const enemyLand = !!(nd && nd.seat && B.teamOf(nd.seat) !== B.teamOf(a.owner));
        if (enemyLand) {
          if (nd.kind !== "hq" && !flagKnown(state, seat)) {
            const pm = d ? mineProbOf(state, seat, d) : 0;
            // 空手飞进敌境 pm=0；攻击未知子看 P(雷)；明子不是雷就是白死
            if (!d || pm < ENG_PM) continue;
          }
        }
      }
      keep.push(m);
    }
    return keep.length ? keep : moves;
  }

  // ---------------- 任务 B：浅搜索重排 ----------------
  // 纯 argmax 的策略看不见「这一步走完毫无进展」，于是把人类的犹豫学成了磨蹭。
  // 这里在最上层加一层 1-ply 检查：先用 policy 挑 K 个候选，再借一代的启发式
  // evaluate（在一代自己用的 world 表示上做 simulate，不碰真实 state）给它们重排。
  // 与规则补丁的区别：它不改愿望，只是在若干个「网络本来也想走」的动作里挑更划算的。
  // 网络 value 在最终打分里的权重。默认 0（关闭）：老权重的 value AUC 只有 0.59，
  // 比子力账 0.73 差一截，加进去只会捣乱。加了全局通道的新权重是 0.687，
  // 和子力账/子数差融合后 0.750（纯子力账 0.727），这时才值得开。
  const SEARCH_W_VAL = ENV.JJ_BC_VAL ? Number(ENV.JJ_BC_VAL) : 0;
  // 候选数/层数（2026-11-05 晚）：原来 K 是硬编码 5、层数硬编码 1 层 evaluate。
  // 一代是 28 候选 × 深度 3~4，二代是 5 候选 × 深度 1 —— 差距主要在这里，不在世界数
  // （一代自适应 10 个世界，二代 12 个，已经持平）。
  // JJ_BC_K / JJ_BC_DEPTH 提出来只为可测，默认值与原来完全一致。
  const SEARCH_K = ENV.JJ_BC_K ? Number(ENV.JJ_BC_K) : 5;
  const SEARCH_DEPTH = ENV.JJ_BC_DEPTH ? Math.max(1, Number(ENV.JJ_BC_DEPTH)) : 1;
  // 深层搜索才需要预算；深度 1 时给一个永不到期的 deadline，行为与原来逐位一致。
  const SEARCH_BUDGET = ENV.JJ_BC_BUDGET ? Number(ENV.JJ_BC_BUDGET) : 400;
  // 世界数：3 太少 —— 5 个候选的分数全靠少数几次抽样，噪声会压过真正的好坏。
  // 实测（日志 §二十）提到「worlds=3 时同一候选的分数方差 ≈ 候选之间的真实差异」，
  // 提到 12 之后均值才稳定。用户口径：「把世界遍历取分数」= 多抽 + 去重 + 取均值。
  const SEARCH_WORLDS = ENV.JJ_BC_WORLDS ? Number(ENV.JJ_BC_WORLDS) : 12;
  const WORLD_TRIES = SEARCH_WORLDS * 4;   // 去重后可能抽不满，给 4 倍尝试上限
  const SEARCH_CLAMP = 5000;     // 单个世界里的极端分（终局 ±1e6）截断后再平均
  const SEARCH_W_POL = 0.6;      // 网络意愿的权重
  const SEARCH_W_EVAL = 0.4;     // 一层 evaluate 的权重
  const SEARCH_BONUS_FREE = 0.6; // 「白吃」的额外加分（z 分数单位）
  const _nodePos = new Map();    // cell id -> 一代 world 里的扁平下标
  (function initNodePos() {
    try { B.BOARD.nodes.forEach((n, i) => _nodePos.set(n.id, i)); } catch (err) { /* 忽略 */ }
  })();

  // 默认开：40 局对局实测，旧权重（人类 BC）叠加它之后
  //   胜率 7.5%→12.5%、不败率 57.5%→62.5%，两者都过了 §6.3 的线；
  //   16 局行为指标同时改善：攻击率 24.6%→30.1%、推进 0.66→0.93、无战斗 5.5→3.8。
  // 代价：22.1ms/步 → 25.2ms/步（离 150ms 上限还很远）。
  // 想回到纯 argmax 用 JJ_BC_SEARCH=0。
  function searchOn() {
    return !(ENV.JJ_BC_SEARCH === "0" || ENV.JJ_BC_SEARCH === "off");
  }

  function zscores(vals) {
    const n = vals.length;
    if (!n) return vals;
    let mean = 0;
    for (const v of vals) mean += v;
    mean /= n;
    let varc = 0;
    for (const v of vals) varc += (v - mean) * (v - mean);
    const sd = Math.sqrt(varc / n);
    if (!(sd > 1e-9)) return vals.map(() => 0);
    return vals.map((v) => (v - mean) / sd);
  }

  function evalProfile(state, seat) {
    const AI = root.JunqiAI;
    const P = (AI && AI.PROFILES) || {};
    const want = (state && state.aiProfiles && state.aiProfiles[seat]) || "forest";
    return P[want] ? want : (P.forest ? "forest" : undefined);
  }

  // 返回 {from, to, row, tv} 或 null（任何环节不成就退回 argmax，绝不让游戏卡住）
  function pickBySearch(state, seat, legal, fw, sink) {
    const AI = root.JunqiAI;
    if (!AI || !AI._internals || !AI._internals.buildWorld) { why("nointernals"); return null; }
    if (!_nodePos.size) { why("nonodepos"); return null; }
    // 按座位可覆盖（同局 A/B 用）：state.bcDepth[seat] / state.bcK[seat]。
    // 必须在使用之前声明 —— 上一版放到下面，KK 进了 TDZ，每手都抛 ReferenceError
    // 被 catch 吞成"退回 argmax"，看起来像"搜索层不起作用"。
    const DEPTH = (state.bcDepth && state.bcDepth[seat]) || SEARCH_DEPTH;
    const KK = (state.bcK && state.bcK[seat]) || SEARCH_K;
    // 深度 1 保持原样（无预算、无置换表）；深度 ≥2 才走一代的 alpha-beta。
    const deadline = Date.now() + (DEPTH > 1 ? SEARCH_BUDGET : 1e9);
    const tt = DEPTH > 1 ? new Map() : null;
    const fl = fw.fromLogits;

    // 1) policy 最高的 K 个起点
    const seen = new Set();
    const heads = [];
    for (let i = 0; i < legal.length; i += 1) {
      const f = legal[i].from;
      if (seen.has(f)) continue;
      seen.add(f);
      const ci = cellIndex(f);
      if (ci < 0) continue;
      heads.push({ from: f, row: ci, pol: fl[ci] });
    }
    if (heads.length < 2) { why("fewheads"); return null; }
    heads.sort((a, b) => b.pol - a.pol);
    const top = heads.slice(0, KK);

    // 2) 每个起点取它自己 policy 最高的落点，组成 K 个候选动作
    const cands = [];
    for (const h of top) {
      const tl = toLogits(fw.h3, fw.h, h.row);
      let bt = null;
      let btc = -1;
      let btv = -Infinity;
      for (let i = 0; i < legal.length; i += 1) {
        const m = legal[i];
        if (m.from !== h.from) continue;
        const ci = cellIndex(m.to);
        if (ci >= 0 && tl[ci] > btv) { btv = tl[ci]; bt = m.to; btc = ci; }
      }
      if (bt === null) continue;
      cands.push({ from: h.from, to: bt, row: h.row, toCell: btc,
                   pol: h.pol + btv, evalScore: null, freeCapture: false, eatsFlag: false });
    }
    if (cands.length < 2) { why("fewcands"); return null; }

    // 3) 在一代的 world 表示上跑一层 evaluate（不给真实 state 动刀）
    //    暗子只呈现为「某个抽样兵种」，所以抽 SEARCH_WORLDS 次取平均，把抽样噪声压下去
    const prof = evalProfile(state, seat);
    const used = new Set();
    for (const c of cands) { c.sum = 0; c.nw = 0; c.freeVotes = 0; c.flagVotes = 0; }
    // 「遍历」世界：抽到 SEARCH_WORLDS 个**互不相同**的补全为止。
    // 不去重的话，身份域窄时（比如中盘只剩 3~4 种可能）会反复抽到同一个世界，
    // 12 次抽样实际只有 3 种信息，等于白算。
    const seenWorlds = new Set();
    let worlds = 0;
    for (let attempt = 0; attempt < WORLD_TRIES && worlds < SEARCH_WORLDS; attempt += 1) {
      let world;
      try {
        world = AI._internals.buildWorld(state, seat);
      } catch (err) {
        break;
      }
      if (!world) continue;
      // 世界指纹：只取暗子的「类型 + 位置」，公开信息在所有世界里都一样
      let sig = "";
      for (const p of world.pieces) if (p.pos >= 0) sig += (p.type || "?")[0] + p.pos + ",";
      if (seenWorlds.has(sig)) continue;
      seenWorlds.add(sig);
      worlds += 1;
      const byPos = new Map();
      for (const p of world.pieces) if (p.pos >= 0) byPos.set(p.pos, p);
      // 二代的「猜子」= 它自己抽到的世界长什么样。没有信念头，这就是它唯一的依据。
      if (sink && sink.track) {
        for (const p of world.pieces) {
          if (p.pos < 0) continue;
          const node = B.BOARD.nodes[p.pos];
          if (!node) continue;
          if (!sink.track.has(node.id)) continue;
          let m = sink.votes.get(node.id);
          if (!m) { m = new Map(); sink.votes.set(node.id, m); }
          m.set(p.type, (m.get(p.type) || 0) + 1);
        }
      }
      for (const c of cands) {
        const ap = _nodePos.get(c.from);
        const dp = _nodePos.get(c.to);
        if (ap === undefined || dp === undefined) continue;
        const attacker = byPos.get(ap);
        const defender = byPos.get(dp);
        if (!attacker) continue;
        let child;
        try {
          child = AI._internals.simulate(world, { attacker: attacker, defender: defender, dst: dp });
        } catch (err2) {
          continue;
        }
        let sc;
        if (DEPTH > 1) {
          try {
            sc = AI._internals.search(child, DEPTH - 1, -Infinity, Infinity, deadline, seat, 1, tt, prof, false);
          } catch (err3) { sc = null; }   // 超时/异常就当这个世界没算出来，不影响其它世界
        } else {
          sc = AI._internals.evaluate(child, seat, prof);
        }
        if (sc === null || sc === undefined) continue;
        c.sum += Math.max(-SEARCH_CLAMP, Math.min(SEARCH_CLAMP, sc));
        c.nw += 1;
        used.add(c);
        // 战术判定：吃掉之后自己还在不在 / 对方还在不在
        let aliveA = false;
        let aliveD = false;
        for (const p of child.pieces) {
          if (p.id === attacker.id) aliveA = true;
          if (defender && p.id === defender.id) aliveD = true;
        }
        if (defender && defender.type === "flag" && !aliveD) c.flagVotes += 1;
        else if (defender && aliveA && !aliveD) c.freeVotes += 1;
      }
    }
    for (const c of cands) {
      if (c.nw > 0) c.evalScore = c.sum / c.nw;
      const half = (c.nw || worlds) / 2;
      c.eatsFlag = c.flagVotes > half;
      c.freeCapture = c.freeVotes > half;
    }

    // 3.5) 网络 value：把这一步走完之后局面的胜负预测也算进来。
    // 状态克隆走 serialize/deserialize（实测 0.07ms/次），不碰真实 state。
    if (SEARCH_W_VAL > 0) {
      for (const c of cands) {
        c.value = 0;
        try {
          const nx = G.deserializeState(G.serializeState(state));
          if (!nx) continue;
          nx.turn = seat;
          const r = G.applyMove(nx, seat, c.from, c.to);
          if (r && r.ok) c.value = encode(buildInput(nx, seat)).value;
        } catch (err) { /* 算不出来就当中性 */ }
      }
    }

    const usable = cands.filter((c) => c.nw > 0);
    if (usable.length < 2) { why(worlds ? "nouseful" : "noworlds"); return null; }

    // 扛旗一手是终局，任何犹豫都没意义
    for (const c of usable) if (c.eatsFlag) return { from: c.from, to: c.to, row: c.row, tv: 0 };

    // 4) policy 与 evaluate 各自标准化后加权（量纲不可比，直接相加会被 evaluate 吞掉）
    const zPol = zscores(usable.map((c) => c.pol));
    const zEv = zscores(usable.map((c) => c.evalScore));
    const zVal = SEARCH_W_VAL > 0 ? zscores(usable.map((c) => c.value || 0)) : null;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < usable.length; i += 1) {
      const c = usable[i];
      let s = SEARCH_W_POL * zPol[i] + SEARCH_W_EVAL * zEv[i];
      if (zVal) s += SEARCH_W_VAL * zVal[i];
      if (c.freeCapture) s += SEARCH_BONUS_FREE;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) return null;
    if (sink) {
      sink.list = usable.map((c, i) => ({
        from: c.from, to: c.to, pol: c.pol, evalScore: c.evalScore, value: c.value || 0,
        score: SEARCH_W_POL * zPol[i] + SEARCH_W_EVAL * zEv[i] + (zVal ? SEARCH_W_VAL * zVal[i] : 0)
          + (c.freeCapture ? SEARCH_BONUS_FREE : 0),
        eatsFlag: !!c.eatsFlag, freeCapture: !!c.freeCapture,
      })).sort((a, b) => b.score - a.score);
      sink.worlds = worlds;
    }
    return { from: best.from, to: best.to, row: best.row, tv: 0 };
  }

  // ---------------- 界面参谋：推荐走法 + 猜子 ----------------
  /**
   * 二代的「参谋」视图（2026-11-03）。
   * - 推荐走法：pickBySearch 里那 K 个候选的真实打分（policy / evaluate / value 三路加权），
   *   不是另算一套，所以点哪一行就等于「二代真会走那一步」。
   * - 猜子：它没有信念头，唯一的依据是 buildWorld 抽到的世界；这里把抽样众数摊开。
   * 不改动 choose，也不写全局状态。
   */
  function analyze(state, seat) {
    if (!ensureWeights()) return null;
    let legal = G.allLegalMoves(state, seat);
    if (!legal.length) return null;
    legal = dropKnownSuicide(state, seat, legal);
    legal = dropBacktrack(state, seat, legal);
    if (ENV.JJ_NO_HQ_FIX !== "1") legal = dropUselessHq(state, seat, legal);
    legal = dropMineAndEarlyEngineer(state, seat, legal);

    // 需要猜的格子：敌方（非同队）暗子
    const track = new Set();
    try {
      for (const p of state.pieces) {
        if (!p.position || p.owner === seat) continue;
        if (B.teamOf(p.owner) === B.teamOf(seat)) continue;
        if (G.visibleTo(state, seat, p)) continue;
        track.add(p.position);
      }
    } catch (err) { /* ignore */ }

    const sink = { list: [], votes: new Map(), track, worlds: 0 };
    let picked = null;
    let fw = null;
    try {
      fw = encode(buildInput(state, seat));
      picked = pickBySearch(state, seat, legal, fw, sink);
    } catch (err) { picked = null; }

    // 浅搜索没跑起来时退回 policy argmax，至少给一个推荐
    if (!picked && fw) {
      const fl = fw.fromLogits;
      let bf = null, bv = -Infinity;
      for (const m of legal) {
        const ci = cellIndex(m.from);
        if (ci < 0) continue;
        if (fl[ci] > bv) { bv = fl[ci]; bf = m.from; }
      }
      if (bf) {
        const tl = toLogits(fw.h3, fw.h, cellIndex(bf));
        let bt = null, btv = -Infinity;
        for (const m of legal) {
          if (m.from !== bf) continue;
          const ci = cellIndex(m.to);
          if (ci >= 0 && tl[ci] > btv) { btv = tl[ci]; bt = m.to; }
        }
        if (bt) picked = { from: bf, to: bt };
      }
    }

    // 猜子：优先用一代那张 25×12 连续后验 —— buildWorld / rootPrior 走子时吃的就是它。
    // 原来用 12 个世界的**众数**，既带采样方差，又被配额约束挤偏，UI 上等于
    // 「扔骰子扔出来的一个确切结论」。改成边缘分布后，面板才如实反映模型在犹豫什么。
    let rows = null, idByPos = null;
    try {
      const I = AI && AI._internals;
      if (I && I.inferDomains && I.beliefRowsView) {
        const doms = I.inferDomains(state, seat);
        rows = I.beliefRowsView(state, seat, doms);
        idByPos = new Map();
        for (const p of state.pieces) if (p.position) idByPos.set(p.position, p.id);
      }
    } catch (err) { rows = null; }

    const guesses = [];
    const seen = new Set();
    if (rows && idByPos) {
      for (const pos of track) {
        const id = idByPos.get(pos);
        const row = id ? rows.get(id) : null;
        if (!row || !row.size) continue;
        const dist = {};
        let bv = -1, bi = null;
        for (const [t, w] of row) {
          if (!(w > 0)) continue;
          dist[t] = w;
          if (w > bv) { bv = w; bi = t; }
        }
        if (!bi) continue;
        guesses.push({ pos, type: bi, p: bv, dist });
        seen.add(pos);
      }
    }
    // 信念行拿不到的格子（不该有，兜底）退回世界众数
    for (const [pos, m] of sink.votes) {
      if (seen.has(pos)) continue;
      let tot = 0, bi = null, bv = -1;
      for (const [t, n] of m) { tot += n; if (n > bv) { bv = n; bi = t; } }
      if (!tot || !bi) continue;
      const dist = {};
      for (const [t, n] of m) dist[t] = n / tot;
      guesses.push({ pos, type: bi, p: bv / tot, dist });
    }
    guesses.sort((a, b) => b.p - a.p);

    let value = 0;
    try { value = fw ? fw.value : 0; } catch (err) { value = 0; }

    return {
      best: picked ? { from: picked.from, to: picked.to } : null,
      moves: (sink.list || []).slice(0, 6),
      guesses: guesses.slice(0, 8),
      worlds: sink.worlds, value, engine: "gen2",
    };
  }

  // ---------------- 决策 ----------------
  function choose(state, seat) {
    if (!ensureWeights()) return null;
    let legal = G.allLegalMoves(state, seat);
    if (!legal.length) return null;
    legal = dropKnownSuicide(state, seat, legal);
    legal = dropBacktrack(state, seat, legal);
    if (ENV.JJ_NO_HQ_FIX !== "1") legal = dropUselessHq(state, seat, legal);
    legal = dropMineAndEarlyEngineer(state, seat, legal);

    const t0 = (root.performance && performance.now) ? performance.now() : Date.now();
    const x = buildInput(state, seat);
    const fw = encode(x);
    const fl = fw.fromLogits;

    let bestFrom = null;
    let bestRow = -1;
    let bestTo = null;

    // 优先走一层浅搜索；它依赖 ai.js 的 internals，任何环节不成都会退回下面的 argmax
    if (searchOn()) {
      let picked = null;
      try { picked = pickBySearch(state, seat, legal, fw); } catch (err) {
        picked = null;
        stats.err = String(err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err).slice(0, 200);
        why("throw");
      }
      if (picked) { bestFrom = picked.from; bestRow = picked.row; bestTo = picked.to; stats.search += 1; }
      else stats.bail += 1;
    }

    if (bestFrom === null) {
      // 合法起点里取分数最高者
      let bestV = -Infinity;
      for (let i = 0; i < legal.length; i += 1) {
        const f = legal[i].from;
        if (f === bestFrom) continue;
        const ci = cellIndex(f);
        if (ci < 0) continue;
        if (fl[ci] > bestV) { bestV = fl[ci]; bestFrom = f; bestRow = ci; }
      }
      if (bestFrom === null) return null;

      // 以选中的起点为条件，在它的合法落点里取 top-1
      const tl = toLogits(fw.h3, fw.h, bestRow);
      let bestTV = -Infinity;
      for (let i = 0; i < legal.length; i += 1) {
        const m = legal[i];
        if (m.from !== bestFrom) continue;
        const ci = cellIndex(m.to);
        if (ci >= 0 && tl[ci] > bestTV) { bestTV = tl[ci]; bestTo = m.to; }
      }
    }
    if (bestTo === null) return null;

    const dt = ((root.performance && performance.now) ? performance.now() : Date.now()) - t0;
    stats.moves += 1;
    stats.ms += dt;
    if (dt > stats.maxMs) stats.maxMs = dt;
    return { from: bestFrom, to: bestTo };
  }

  // search = 真正由浅搜索定下的步数；bail = 搜索层给不出 ≥2 个可用候选、退回纯 argmax 的步数。
  // 后者很关键：如果 bail 占比高，「扩层数」只作用在一小部分棋上。
  const stats = { moves: 0, ms: 0, maxMs: 0, fallback: 0, search: 0, bail: 0, why: {} };
  function why(k) { stats.why[k] = (stats.why[k] || 0) + 1; }

  // ---------------- 接入 ----------------
  function install() {
    const AI = root.JunqiAI;
    if (!AI || !G) return false;
    if (AI.__bcPatched) return true;

    // 1) 观察走子（ui.js 直接调 G.applyMove，所以包一层；只观察不改行为）
    const origApply = G.applyMove;
    G.applyMove = function (state, seat, from, to) {
      const mover = G.pieceAt(state, from);
      const def = G.pieceAt(state, to);
      const plane = (N_CH > 29 && mover) ? skippedCapturePlane(state, seat, from, to) : null;
      const res = origApply.apply(this, arguments);
      if (res && res.ok && mover) {
        if (def && def.id !== mover.id) { revealed.add(mover.id); revealed.add(def.id); }
        moved.add(mover.id);
        // 时序：任何一方走子都要记（模型要判断「刚才谁动了什么」）
        recentMoves.unshift({ from: from, to: to });
        if (recentMoves.length > 2) recentMoves.pop();
        if (plane) { skipPlanes.unshift(plane); if (skipPlanes.length > 2) skipPlanes.pop(); }
      }
      return res;
    };

    // 2) 新局清空可见性
    const origNew = G.newGame;
    G.newGame = function () {
      revealed.clear();
      moved.clear();
      recentMoves.length = 0;
      skipPlanes.length = 0;
      const st = origNew.apply(this, arguments);
      // 读档/读复盘会绕过 newGame；这里只尽力回溯一手（上上手无法恢复）
      if (st && st.lastMove) recentMoves[0] = { from: st.lastMove.from, to: st.lastMove.to };
      return st;
    };

    // 3) 路由：style 为 bc 时走本模型，其余原样交给一代
    const origChoose = AI.choose;
    AI.choose = function (state, seat, opts) {
      const seatIsBC = !!(state && state.aiProfiles && state.aiProfiles[seat] === "bc");
      if (state && (state.aiStyle === "bc" || seatIsBC)) {
        try {
          const mv = choose(state, seat);
          if (mv) return mv;
        } catch (err) {
          stats.fallback += 1;
          console.warn("[BC] 推理异常，回退一代 AI：", err);
        }
      }
      return origChoose.call(this, state, seat, opts);
    };

    AI.__bcPatched = true;
    return true;
  }

  const API = {
    install: install,
    choose: choose,
    analyze: analyze,
    buildInput: buildInput,
    encode: encode,
    toLogits: toLogits,
    // 局面价值：当前 seat 视角的最终胜负预测（正 = 我方有利）
    valueOf: function (state, seat) {
      if (!ensureWeights()) return 0;
      try { return encode(buildInput(state, seat)).value; } catch (err) { return 0; }
    },
    cellIndex: cellIndex,
    ready: function () { return ensureWeights(); },
    stats: stats,
    revealed: revealed,
    moved: moved,
    recentMoves: recentMoves,
    skipPlanes: skipPlanes,
    nCh: function () { return N_CH; },
  };

  install();
  // 兜底：若此刻 ai.js 尚未就绪（脚本顺序变动等），稍后重试几次
  if (!root.JunqiAI || !root.JunqiAI.__bcPatched) {
    let tries = 0;
    const retry = function () {
      if (install() || tries >= 20) return;
      tries += 1;
      if (root.setTimeout) root.setTimeout(retry, 50);
    };
    if (root.setTimeout) root.setTimeout(retry, 0);
  }
  root.JunqiBCAI = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
