/*
 * 人类走法先验（2026-11-06）—— 第 3.0 版的第一个「信息类」尝试
 *
 * 与之前五次失败的共同点/不同点
 * ----------------------------
 * 前五条（威胁加权、噪声带、G1 疑似炸、进营/逗留、预留格）都是**行为规则**：
 * 人写一条口诀 → 引擎照做。五次全负，规律是「我们的 AI 没有人类的坏习惯」。
 *
 * 这一条不是规则，是从 3241 局人类棋谱里**学出来的走法分布**：
 *   P(走法 | 局面) ∝ exp(w · f(走法))
 * 权重由条件 logit 在 657,517 个决策点 / 3529 万个候选着法上拟合（按局 8:1:1 划分）。
 * 它给出的不是「该不该这么走」，而是「人在这类局面上有多常这么走」。
 *
 * 用法（只作为根节点的一个加分项，权重默认 0 = 关闭）
 * --------------------------------------------------
 *   score = w · f  （f 见下，全部是**当时可见**的信息）
 *   加到根节点候选分上：K × score / norm
 * AI 的评估与搜索完全不变，先验只在「评估分接近」时起作用（K 小）或在噪声带内定序。
 *
 * 特征（84 维，必须与 training/train_policy_prior.py 的 NAMES 一一对应）
 * --------------------------------------------------------------------
 *   兵种(10) × 落点属性(空/已明/未知) 是主要交互项；
 *   其余是走法几何（一步/铁路/工兵、距离、前进/横移/后撤）、
 *   起点带（后两排/前两排/中段/中央）、落点象限、行营、动过没有、手数阶段。
 *
 * 两个必须守住的坑
 * ----------------
 * ① 训练数据是全明牌复盘。目标子的身份**只有公开明牌时**才准用（visibleTo），
 *    否则必须当「未知敌子」——否则离线指标虚高、上线即废。
 * ② 中央九格在训练数据里是 JGS 坐标（6+2c, 6+2r），board.js 里是（7+c, 7+r）。
 *    所有表一律按 **node id** 建索引，禁止用 y*17+x 互查。
 */
(function (root) {
  "use strict";

  const G = root.JunqiGame;
  const B = root.JunqiBoard;
  const D = root.HUMAN_PRIOR_DATA;
  if (!G || !B || !D) return;

  const ENV = (typeof process !== "undefined" && process.env) ? process.env : {};
  const NUM = (k, d) => { const v = Number(ENV[k]); return Number.isFinite(v) ? v : d; };

  const ON = NUM("JJ_HP", 0) > 0;              // 默认关：不参与走子
  const K = NUM("JJ_HP_K", 20);                // 加分上限（分），乘 score/norm
  const STATS = { calls: 0, scored: 0, skipped: 0, sumAbs: 0 };

  const W = D.w;
  const NF = W.length;
  const SP = D.sp, SEAT = D.seat, ROW = D.row, CAMP = D.camp, RAIL = D.rail, PROG = D.prog;
  const NORM = Number(D.norm) > 0 ? Number(D.norm) : 1;
  const N = 129;

  const SLOT = new Map();
  D.ids.forEach((id, i) => SLOT.set(id, i));
  const SEAT_IDX = new Map();
  (B.SEATS || ["north", "east", "south", "west"]).forEach((s, i) => SEAT_IDX.set(s, i));

  // 兵种 → 训练用的数值（2 旗 / 3 雷 / 4 炸 / 5 司令 / 6 军长 / 7 师长 / 8 旅 / 9 团 / 10 营 / 11 连 / 12 排 / 13 工兵）
  const V_OF = {
    flag: 2, mine: 3, bomb: 4, commander: 5, army: 6, division: 7,
    brigade: 8, regiment: 9, battalion: 10, company: 11, platoon: 12, engineer: 13,
  };

  const X = new Float64Array(NF);              // 复用的特征缓冲

  /**
   * 纯特征（不碰 state）：供 score() 与一致性测试共用。
   *   sf/st     起点/落点 slot（0..128）
   *   v         移动子数值（4..13）
   *   dstKind   0 空 / 1 已明敌子 / 2 未知敌子
   *   ktv       已明敌子的数值（dstKind!=1 时忽略）
   *   moved     这枚子是否动过
   *   ply       当前手数
   *   si        座次下标 0..3
   */
  function featRaw(sf, st, v, dstKind, ktv, moved, ply, si) {
    X.fill(0);
    const empty = dstKind === 0 ? 1 : 0;
    const known = dstKind === 1 ? 1 : 0;
    const unknown = dstKind === 2 ? 1 : 0;

    X[10] = empty; X[11] = known; X[12] = unknown;
    if (known) {
      if (ktv >= 5 && ktv <= 7) X[13] = 1;      // 大子：司令/军长/师长
      if (ktv >= 8) X[14] = 1;                  // 小子：旅以下
      if (ktv === 4) X[15] = 1;
      if (ktv === 3) X[16] = 1;
      if (ktv === 2) X[17] = 1;
    }

    const dd = SP[sf * N + st];
    const adj = dd === 1;
    const eng = !adj && v === 13;
    const rail = !adj && !eng && RAIL[sf] === 1 && RAIL[st] === 1;
    if (adj) X[18] = 1;
    else if (rail) X[19] = 1;
    else if (eng) X[20] = 1;
    if (dd === 1) X[21] = 1; else if (dd === 2) X[22] = 1; else if (dd === 3) X[23] = 1;
    else if (dd >= 4 && dd <= 6) X[24] = 1; else if (dd >= 7) X[25] = 1;

    // 方向：整数前向轴（北上=+y / 南下=−y / 西进=+x / 东进=−x）
    const pf = PROG[si * N + sf], pt = PROG[si * N + st];
    const fwd = pt > pf, bwd = pt < pf;
    if (fwd) X[26] = 1; else if (bwd) X[28] = 1; else X[27] = 1;

    const sseat = SEAT[sf], srow = ROW[sf];
    if (sseat >= 0) {
      if (srow >= 4) X[29] = 1; else if (srow <= 1) X[30] = 1; else X[31] = 1;
    } else X[32] = 1;

    const tseat = SEAT[st];
    if (tseat >= 0 && tseat === si) X[33] = 1;
    else if (tseat >= 0 && tseat !== si) X[34] = 1;
    else X[35] = 1;
    if (tseat >= 0 && tseat !== si && ROW[st] >= 4) X[36] = 1;
    if (CAMP[st]) X[37] = 1;
    if (CAMP[sf]) X[38] = 1;
    if (moved) X[39] = 1;

    X[40 + (ply < 20 ? 0 : ply < 60 ? 1 : ply < 150 ? 2 : 3)] = 1;

    const vi = v - 4;
    X[vi] = 1;
    X[44 + vi] = empty;
    X[54 + vi] = known;
    X[64 + vi] = unknown;
    X[74 + vi] = fwd ? 1 : 0;

    let s = 0;
    for (let i = 0; i < NF; i += 1) s += X[i] * W[i];
    return s;
  }

  /**
   * 单个着法的先验分（未归一化的 w·f，可正可负）。
   * ctx: { movedSet: Set(pieceId), ply: number } —— 每次 choose 建一次即可。
   */
  function score(state, seat, from, to, ctx) {
    STATS.calls += 1;
    // 天命暗牌（latent）：连自己都不知道自己的兵种，先验不成立
    if (state.latentSeats && state.latentSeats[seat]) { STATS.skipped += 1; return 0; }
    const sf = SLOT.get(from), st = SLOT.get(to);
    if (sf === undefined || st === undefined) { STATS.skipped += 1; return 0; }
    const p = G.pieceAt(state, from);
    if (!p) { STATS.skipped += 1; return 0; }
    const v = V_OF[p.type];
    if (!v || v < 4) { STATS.skipped += 1; return 0; }

    const si = SEAT_IDX.get(seat);
    const d = G.pieceAt(state, to);
    let dstKind = 0, ktv = 0;
    if (d) {
      if (G.visibleTo(state, seat, d)) { dstKind = 1; ktv = V_OF[d.type] || 0; }
      else dstKind = 2;
    }
    const moved = !!(ctx && ctx.movedSet && ctx.movedSet.has(p.id));
    const s = featRaw(sf, st, v, dstKind, ktv, moved, (ctx && ctx.ply) || 0, si);
    STATS.scored += 1;
    STATS.sumAbs += Math.abs(s);
    return s;
  }

  /** 直接给根节点用的加分（分）。K=0 或未开启时恒为 0，不改变任何行为。 */
  function bonus(state, seat, from, to, ctx) {
    if (!ON || K === 0) return 0;
    return K * score(state, seat, from, to, ctx) / NORM;
  }

  /** 一次 choose 只建一次：动过的子 id 集合 + 手数 */
  function makeCtx(state) {
    const movedSet = new Set();
    const tape = state.moveTape || [];
    for (const m of tape) if (m && m.piece) movedSet.add(m.piece);
    return { movedSet, ply: tape.length };
  }

  root.JunqiHumanPrior = {
    ON, K, STATS, NF, NORM, makeCtx, score, bonus, featRaw,
    _x: () => X.slice(),
    names: D.names, res: D.res,
    _slot: (id) => SLOT.get(id),
  };
})(typeof window !== "undefined" ? window : globalThis);
