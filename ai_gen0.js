/*
 * AI零代 · 《四国争霸》(2007) AI 逆向复刻
 * ============================================================================
 * 本文件按《AI算法说明.md》还原的算法实现，所有常量都来自对原程序内存镜像的
 * 逐字节提取（work/siguo_image.bin），不是估猜：
 *
 *   0x5A1DE4  子力权重表 W[12]   = 2000/50/130/220/170/90/70/50/40/30/20/40
 *   0x5A29A4  兵种相克掩码 12×12 ('1'=吃 '2'=被吃 '0'=同归/同级)
 *   0x49E478  黄金比例系数 0.618
 *   0x49E470  概率阈值 0.1
 *   0x49E75C  0.0 / 0x4A04CC 0.0 / 0x4A0800 0.0
 *   0x4A24B0  大鱼阈值 500.0（进入"必杀"分支）
 *   0x4A0328  阶段权重 6.0  → 第 60 手前
 *   0x4A0348  阶段权重 16.0 → 第 60 手后
 *   0x40C91C  12 维概率归一化到 100
 *
 * 原版决策流程（对应函数）：
 *   1. 生成全部合法着法            0x49F6FC / 0x49F4C8 / 0x498CC0
 *   2. 逐着法求"期望交换值"        0x49E368 Eval(pt, probs)
 *      我方身份也不确定时用双层期望 0x49E2F4 Eval2(probsA, probsB)
 *   3. 叠加阶段权重（6.0/16.0）     0x49FD0C
 *   4. 复制棋盘试走一步            0x4A035C MakeMove（0x55F0 = 100×0xDC 字节）
 *   5. 对四个座位分别重估          0x4A04D0 / 0x49E480
 *   6. 取"我方相对优势"最大的一步  0x49E768
 *
 * 与原版的差异（本工程没有对应数据）：
 *   - 原版信念先验来自 statfile（棋谱统计 [25][12][3][12]），这里退化成
 *     "该方每种兵还剩几枚" 的计数先验；这是 statfile 想逼近的东西。
 *   - 原版的"位置分"是黑盒（0x49FD0C 依赖大量内部表），这里用最小启发式替代：
 *     向中心推进 + 占行营，再乘阶段权重。
 *   - 不做递归搜索——原版本来就不做，只做 1 层试走。
 * ============================================================================
 */
(function (root) {
  "use strict";

  const G = root.JunqiGame;
  const B = root.JunqiBoard;
  const _ENV = (typeof process !== "undefined" && process.env) ? process.env : {};
  if (!G || !B) return;

  // ---- 兵种下标顺序与 2007 原版一致（flag,mine,bomb,commander,...）----
  const TYPE_ORDER = [
    "flag", "mine", "bomb", "commander", "army", "division",
    "brigade", "regiment", "battalion", "company", "platoon", "engineer",
  ];
  const TI = {};
  TYPE_ORDER.forEach((t, i) => { TI[t] = i; });

  const W = [2000, 50, 130, 220, 170, 90, 70, 50, 40, 30, 20, 40];

  // 0x5A29A4：12×16 字节，'1' 吃 / '2' 被吃 / '0' 同归或同级
  const MASK_TEXT = [
    "222222222222", "100111111111", "100000000000", "120011111111",
    "120201111111", "120220111111", "120222011111", "120222201111",
    "120222220111", "120222222011", "120222222201", "110222222220",
  ];
  const MASK = MASK_TEXT.map((row) => row.split("").map((c) => (c === "1" ? 1 : c === "2" ? -1 : 0)));

  const GOLDEN = 0.618;        // 0x49E478
  const PROB_EPS = 0.1;        // 0x49E470（概率阈值）
  const BIG_CAPTURE = 500.0;   // 0x4A24B0（大鱼阈值）
  const PHASE_AT = 60;         // self+0xA6350 手数阈值
  const K_EARLY = 6.0;         // 0x4A0328
  const K_LATE = 16.0;         // 0x4A0348
  const BIG_BONUS = 300.0;    // 命中"必杀"时的加分（原版是分支切换，这里退化成温和加分）

  // 调试开关：可在控制台改 AI0.tune 做 A/B（默认与原版一致：位置分和试走都开）
  const TUNE = { pos: false, sim: true, risk: true };   // 位置分实测反而变差，默认关（可用 AI0.tune.pos 开）

  // 原版有三个等级（[self+0x8A8]：0=初级 1=中级 2=高级），f.bat 启动默认高级。
  // 0x4A657F / 0x4A6790 两处 `cmp [ebx+0x8A8], 0/1` 决定要不要多算一层：
  //   初级 只做一步期望；中级 再加四家相对优势；高级 再算「对手下一手能吃什么」。
  const LEVEL = { basic: 0, mid: 1, high: 2 };
  let currentLevel = "high";
  const REFINE_K = 8;              // 高级：只对前 K 个候选做对手应手复算

  const FULL_COUNT = {
    flag: 1, mine: 3, bomb: 2, commander: 1, army: 1, division: 2,
    brigade: 2, regiment: 2, battalion: 2, company: 3, platoon: 3, engineer: 3,
  };

  // ---------------------------------------------------------------- 工具

  function movableSeats(state) {
    return B.SEATS.filter((s) => state.pieces.some((p) => p.owner === s && p.position));
  }

  function knownTo(state, seat, piece) {
    if (piece.owner === seat) return true;
    try {
      return !!G.visibleTo(state, seat, piece);
    } catch (err) {
      return !!piece.revealed;
    }
  }

  function teammateOf(seat, other) {
    try {
      return G.isTeammate(seat, other);
    } catch (err) {
      return seat === other;
    }
  }

  function nodeOf(pos) {
    return B.BOARD.byId.get(pos) || null;
  }

  // ---------------------------------------------------------------- 信念

  /*
   * 每格 12 维兵种概率（0..1，和=1）。
   * 原版内存里看到的是"归一化到 100"的百分比（0x40C91C），但代入 0x49E368 的
   * Eval 时用的是 0..1 的权重——否则 0x4A24B0 那个 500.0 的"大鱼阈值"没有意义
   * （任何 50% 的吃子都会 > 500）。这里按 Eval 的量纲取 0..1。
   * 先验用"剩余枚数"替代原版的 statfile 经验分布；
   * 再用两条公开规则排除：动过的子不是地雷/军旗；行营里不可能是军旗。
   */
  // 2007 原版靠「线索掩码」收缩概率。这里借用一代维护的等级上下界（rankMemory），
  // 把「它吃过我师长 ⇒ 至少军长」这类动态信息并进来 —— 否则会出现
  // 「西家用某子吃掉我方师长，界面还猜那子是连/排/兵」的荒谬结果。
  const RANK_NUM = {
    commander: 40, army: 39, division: 38, brigade: 37, regiment: 36,
    battalion: 35, company: 34, platoon: 33, engineer: 32,
  };

  function rankBounds(state, seat) {
    const J = root.JunqiAI;
    if (!J || !J._internals || !J._internals.rankMemory) return null;
    try {
      return J._internals.rankMemory(state, seat);
    } catch (err) {
      return null;
    }
  }

  // ---- 身份域：借一代的 AC-3 结果（2026-11-04）----
  // 零代原来只用「自己的计数先验 + 等级上下界」，等于完全不吃那 24 轮战报 AC-3 的红利：
  // 同一枚暗子，一代已经算出它不可能是雷/工兵，零代还在按频次给它摊 12 类。
  // 这里把一代的身份域当 0/1 掩码，乘到频次上再归一化 —— 纯频次统计立刻变锐利，
  // 面板上「零代和一代打架」也随之消失。
  // 只对真实局面生效：搜索里的 sim 世界已经替换过暗子身份，套域会算错。
  const G0_DOM = !(_ENV.JJ_G0_DOM === "0");
  let DOM_CACHE = { state: null, seat: null, key: "", map: null };
  function domainOf(state, seat) {
    const AI = root.JunqiAI;
    if (!AI || !AI._internals || !AI._internals.inferDomains) return null;
    const key = (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1) + "|" + (state.moveCount || 0);
    if (DOM_CACHE.state === state && DOM_CACHE.seat === seat && DOM_CACHE.key === key) return DOM_CACHE.map;
    let map = null;
    try { map = AI._internals.inferDomains(state, seat); } catch (err) { map = null; }
    DOM_CACHE = { state: state, seat: seat, key: key, map: map };
    return map;
  }

  function buildBelief(state, seat, useDomains) {
    const off = state.g0DomOff && state.g0DomOff[seat];   // 同局 A/B 用：只关某一队
    const doms = (useDomains && G0_DOM && !off) ? domainOf(state, seat) : null;
    const moved = new Set();
    for (const m of state.moveTape || []) if (m && m.piece) moved.add(m.piece);

    // 先统计每个座位"已经确定"的兵种（自己的 + 亮明的）
    const used = {};
    for (const s of B.SEATS) used[s] = {};
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (knownTo(state, seat, p) && p.type && used[p.owner]) {
        used[p.owner][p.type] = (used[p.owner][p.type] || 0) + 1;
      }
    }

    const belief = new Map(); // position -> Float64Array(12)
    const mem = rankBounds(state, seat);   // 战况/走子带来的等级上下界
    // 主动打过仗的子不可能是军旗/地雷（它们动不了）
    const fought = new Set();
    for (const b of state.battles || []) if (b && b.attacker) fought.add(b.attacker);
    for (const p of state.pieces) {
      if (!p.position || p.owner === seat) continue;
      const arr = new Float64Array(12);
      if (knownTo(state, seat, p)) {
        arr[TI[p.type] || 0] = 1;
        belief.set(p.position, arr);
        continue;
      }
      // 已经能确定兵种（比如曲折铁路 ⇒ 工兵）就直接定死
      const exact = mem && mem.exact ? mem.exact.get(p.id) : null;
      if (exact && TI[exact] !== undefined) {
        arr[TI[exact]] = 1;
        belief.set(p.position, arr);
        continue;
      }
      const lo = mem && mem.lo && mem.lo.has(p.id) ? mem.lo.get(p.id) : 32;
      const hi = mem && mem.hi && mem.hi.has(p.id) ? mem.hi.get(p.id) : 40;
      const noMine = !!(mem && mem.noMine && mem.noMine.has(p.id));
      const noBomb = !!(mem && mem.noBomb && mem.noBomb.has(p.id));
      const hasMoved = moved.has(p.id);
      const node = nodeOf(p.position);
      const dom = doms ? doms.get(p.id) : null;
      let total = 0;
      for (let i = 0; i < 12; i += 1) {
        const t = TYPE_ORDER[i];
        if (dom && dom.size && !dom.has(t)) continue;               // 一代的硬约束
        if (hasMoved && (t === "flag" || t === "mine")) continue;   // 不能动的子
        if (t === "mine" && (noMine || fought.has(p.id) || lo > 32)) continue;
        if (t === "bomb" && noBomb) continue;
        if (t === "flag" && (fought.has(p.id) || lo > 32)) continue;
        if (node && node.kind === "camp" && t === "flag") continue; // 军旗不进营
        const r = RANK_NUM[t];
        if (r !== undefined && (r < lo || r > hi)) continue;        // 等级上下界
        let cnt = FULL_COUNT[t] - (used[p.owner][t] || 0);
        if (cnt <= 0) cnt = 0.15;                                   // 留一线可能
        arr[i] = cnt;
        total += cnt;
      }
      if (total > 0) {
        for (let i = 0; i < 12; i += 1) arr[i] = arr[i] / total;
      } else {
        arr.fill(1 / 12);
      }
      belief.set(p.position, arr);
    }
    return belief;
  }

  // ---------------------------------------------------------------- 评分

  /*
   * 0x49E368：Eval(pt, probs)
   *   '1' → +prob*W[i]        （吃掉对方，按对方价值得利）
   *   '2' → -prob*W[pt]       （被对方吃掉，按自己价值受损）
   *   '0' → +prob*(W[i]-W[pt])（同归于尽，结算净差）
   */
  /*
   * 0x4A4850：给定「我方兵种 type」和「对方 12 维概率」，返回
   *   P(对方是打不过我的兵种) = Σ_{mask[type][i]=='1'} prob[i] / Σ prob[i]
   * 原版在 0x4A32D0 里把它乘进每条着法的分数（`fmul qword [ebp-0x18]`），
   * 也就是"吃这一手，胜算多大"的折扣因子。阈值常量 0x4A4900 = 1e-8。
   */
  function maskWinProb(typeIdx, probs) {
    const row = MASK_TEXT[typeIdx];
    if (!row || !probs) return 0;
    let total = 0;
    let hit = 0;
    for (let i = 0; i < 12; i += 1) {
      const p = probs[i];
      if (p <= 0) continue;
      total += p;
      if (row[i] === "1") hit += p;
    }
    return total > 1e-8 ? hit / total : 0;
  }

  /*
   * 0x4A4908：和 maskWinProb 逐字节同构，只把 '1' 换成 '2' ——
   *   P(对方是我打不过的兵种)
   * 原版在 0x4A32D0 的另外两条分支里用它当折扣（目标是自己人/连环走那一支）。
   * 阈值常量同 0x4A4900（1e-8 那一族）。
   */
  function maskLoseProb(typeIdx, probs) {
    const row = MASK_TEXT[typeIdx];
    if (!row || !probs) return 0;
    let total = 0;
    let hit = 0;
    for (let i = 0; i < 12; i += 1) {
      const p = probs[i];
      if (p <= 0) continue;
      total += p;
      if (row[i] === "2") hit += p;
    }
    return total > 1e-8 ? hit / total : 0;
  }

  function oneHot(type) {
    const arr = new Float64Array(12);
    const i = TI[type];
    if (i !== undefined) arr[i] = 1;
    return arr;
  }

  function evalCapture(myType, probs) {
    const pt = TI[myType];
    if (pt === undefined || !probs) return 0;
    const row = MASK[pt];
    const myVal = W[pt];
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
      const p = probs[i];
      if (p <= 0) continue;
      const code = row[i];
      if (code > 0) sum += p * W[i];
      else if (code < 0) sum -= p * myVal;
      else sum += p * (W[i] - myVal);
    }
    return sum;
  }

  /*
   * 0x49E2F4：Eval2(probsA, probsB) —— 我方身份也不确定时的双层期望
   *   = Σ probA[i] * Eval(i, probsB) / Σ probA[i]
   */
  function evalDouble(probsA, probsB) {
    if (!probsA || !probsB) return 0;
    let num = 0;
    let den = 0;
    for (let i = 0; i < 12; i += 1) {
      const a = probsA[i];
      if (a <= 0) continue;
      num += a * evalCapture(TYPE_ORDER[i], probsB);
      den += a;
    }
    return den > 0 ? num / den : 0;
  }

  // 某一方的"期望子力总值"，视角是 viewer（我们只知道自己+亮明的子）
  function materialOf(state, viewer, side, belief) {
    let sum = 0;
    for (const p of state.pieces) {
      if (!p.position || p.owner !== side) continue;
      if (knownTo(state, viewer, p)) {
        sum += W[TI[p.type]] || 0;
      } else {
        const b = belief ? belief.get(p.position) : null;
        if (b) {
          let v = 0;
          for (let i = 0; i < 12; i += 1) v += b[i] * W[i];
          sum += v;
        } else {
          sum += 60; // 未知子给个中位估值，避免爆 0
        }
      }
    }
    return sum;
  }

  /*
   * 我方相对优势 = 我方阵营期望子力 − 敌对阵营里最强的一家的期望子力
   * （对应 0x49E768 尾部那段 25×12 双层循环 + mine/theirs 比较）
   */
  function relativeAdvantage(state, seat, belief) {
    let mine = 0;
    let bestEnemy = 0;
    for (const s of B.SEATS) {
      if (!state.pieces.some((p) => p.owner === s && p.position)) continue;
      const v = materialOf(state, seat, s, belief);
      if (s === seat || teammateOf(seat, s)) mine += v;
      else bestEnemy = Math.max(bestEnemy, v);
    }
    return mine - bestEnemy;
  }

  // 位置分（替代原版黑盒 0x49FD0C 的最小启发式）
  const CENTER = { x: 8.5, y: 8.5 };
  function positionScore(fromPos, toPos) {
    const a = nodeOf(fromPos);
    const b = nodeOf(toPos);
    if (!a || !b) return 0;
    const d0 = Math.abs(a.x - CENTER.x) + Math.abs(a.y - CENTER.y);
    const d1 = Math.abs(b.x - CENTER.x) + Math.abs(b.y - CENTER.y);
    let s = (d0 - d1) * 0.8;                       // 向中心推进为正
    if (b.kind === "camp") s += 1.5;               // 占行营
    if (b.kind === "hq") s -= 2.0;                 // 往自家大本营钻要扣分
    return s;
  }

  /*
   * 高级档多算的一层：走完这一步，对手下一手能吃我（或队友）多少。
   * 原版证据：0x4A657F / 0x4A6790 两处 `cmp [ebx+0x8A8],0/1` 之后，
   * 高级档会把候选走法喂给 0x4C30F4 —— 那个函数内部再调 movegen /
   * 0x4A1E60 / 0x4A24B4 去算"某个玩家在这个局面里的最佳着法价值"。
   * 0x4C30F4 本身还没完整逆出来，这里先用同一套评估做一个"应手威胁"近似。
   */
  const ROOT_K = 24;     // 原版是每个候选都算应手；这里取前 24 个，兼顾速度和深度

  function quickCaptureScore(state, seat, move, belief) {
    const tgt = G.pieceAt(state, move.to);
    if (!tgt || tgt.owner === seat) return 0;
    const mover = G.pieceAt(state, move.from);
    if (!mover) return 0;
    return evalCapture(mover.type, belief.get(tgt.position));
  }

  // 我方走完一步后，敌方三家"下一手吃我"的期望收益，取最大
  function enemyReplyPenalty(state, seat, move) {
    let sim;
    try {
      sim = cloneState(state);
    } catch (err) {
      return 0;
    }
    const res = G.applyMove(sim, seat, move.from, move.to);
    if (!res || !res.ok) return 0;

    const belief = buildBelief(sim, seat);
    let worst = 0;
    for (const opp of B.SEATS) {
      if (opp === seat || teammateOf(seat, opp)) continue;
      if (sim.out && sim.out[opp]) continue;
      let moves = [];
      try {
        moves = G.allLegalMoves(sim, opp) || [];
      } catch (err) {
        continue;
      }
      // 敌方也只挑看着最赚的几手（原版是把全部着法打分排序后取第一）
      const cand = moves.map((m) => ({ m, v: quickCaptureScore(sim, opp, m, belief) }));
      cand.sort((a, b) => b.v - a.v);
      for (const it of cand.slice(0, 6)) {
        const m = it.m;
        const tgt = G.pieceAt(sim, m.to);
        if (!tgt) continue;
        if (tgt.owner !== seat && !teammateOf(seat, tgt.owner)) continue;
        const attacker = belief.get(m.from);
        if (!attacker) continue;
        // 原版 0x4A32D0：每条着法分数 = Eval × 折扣
        //   打得赢 → 乘胜算(0x4A4850)；打不赢 → 乘风险(0x4A4908)
        const tp = oneHot(tgt.type);
        let v = 0;
        for (let i = 0; i < 12; i += 1) {
          const a = attacker[i];
          if (a <= 0.005) continue;
          const e = evalCapture(TYPE_ORDER[i], tp);
          if (e === 0) continue;
          if (e > 0) {
            v += a * e * maskWinProb(i, tp);
          } else if (TUNE.risk) {
            v += a * e * maskLoseProb(i, tp);          // 输的一手：按"会输的概率"折算损失
          }
        }
        if (v > worst) worst = v;
      }
    }
    return worst;
  }

  function cloneState(state) {
    const clean = JSON.parse(JSON.stringify(G.serializeState(state)));
    return G.deserializeState(clean);
  }

  // ---------------------------------------------------------------- 决策

  /*
   * analyze() 是 choose() 的"把话说明白"版本：把所有候选着法逐条打分后返回，
   * 给界面上的「零代参谋」用。原版 0x49E768 本来就是"全部算完再取最大"，
   * 这里只是把中间结果留下来，公式一分没改。
   *
   * 返回 { seat, moves: [{from,to,type,target,capture,sim,pos,score,big}], best, belief, baseAdv, phaseK }
   */
  function analyze(state, seat, opts) {
    opts = opts || {};
    const deadline = Date.now() + Math.max(50, opts.budgetMs || 1200);
    const out = { seat, moves: [], best: null, belief: null, baseAdv: 0, phaseK: 0 };
    let moves = [];
    try {
      moves = G.allLegalMoves(state, seat) || [];
    } catch (err) {
      return out;
    }
    const belief = buildBelief(state, seat, true);   // 真实局面：吃一代的身份域
    out.belief = belief;
    if (!moves.length) return out;

    const baseAdv = relativeAdvantage(state, seat, belief);
    out.baseAdv = baseAdv;
    const phaseK = (state.moveCount || 0) > PHASE_AT ? K_LATE : K_EARLY;
    out.phaseK = phaseK;
    // 每枚棋子**自己**最近一手。原来这里用的是 state.lastMove（整盘最后一手），
    // 而四国军棋是轮流走，本座位决策时 lastMove 是上家/别家走的棋 —— 于是
    // 下面那条「别在原地来回摆」几乎永不成立。实测后果：零代司令在两个格之间
    // 连走 14 个来回（复盘 20261103-1804，北家 zero，帧 29~68）。
    // 改成一枚一查，与一代 isBacktrack 同口径（那边用 lastMoveByPiece.get(piece.id)）。
    const lastByPiece = new Map();
    for (const mv of state.moveTape || []) if (mv && mv.piece) lastByPiece.set(mv.piece, mv);

    for (const m of moves) {
      if (Date.now() > deadline && out.moves.length) break;
      const mover = G.pieceAt(state, m.from);
      if (!mover) continue;
      const target = G.pieceAt(state, m.to);
      const knownTarget = target && G.visibleTo(state, seat, target);
      // 暗子不暴露真实类型，只给零代自己的推测（最大后验 + 把握）
      let guess = null;
      if (target && !knownTarget) {
        const probs = belief.get(target.position);
        if (probs) {
          let bi = 0;
          let bv = -1;
          for (let i = 0; i < 12; i += 1) if (probs[i] > bv) { bv = probs[i]; bi = i; }
          // 并列第一有几个？并列多说明"没线索"，界面上要如实显示
          let tied = 0;
          for (let i = 0; i < 12; i += 1) if (Math.abs(probs[i] - bv) < 1e-6) tied += 1;
          if (bv > 0) guess = { type: TYPE_ORDER[bi], p: bv, tied };
        }
      }
      const row = {
        from: m.from, to: m.to, type: mover.type,
        target: knownTarget ? target.type : null,
        targetHidden: !!target && !knownTarget,
        targetGuess: guess,
        capture: 0, sim: 0, pos: 0, score: 0, big: false,
      };

      // ① 期望交换值（原版评分核心）
      if (target && target.owner !== seat) {
        row.capture = evalCapture(mover.type, belief.get(target.position));
        row.score += row.capture;
      }

      // ② 阶段权重下的位置分
      if (TUNE.pos) {
        row.pos = phaseK * positionScore(m.from, m.to) * ((W[TI[mover.type]] || 40) / 220);
        row.score += row.pos;
      }

      // ③ 1 层试走：复制棋盘、走一步、重新算相对优势
      if (TUNE.sim) {
        try {
          const sim = cloneState(state);
          const res = G.applyMove(sim, seat, m.from, m.to);
          if (res && res.ok) {
            row.sim = relativeAdvantage(sim, seat, belief) - baseAdv;
            row.score += row.sim;
            if (res.battle && res.battle.outcome === "attacker" && sim.out && !sim.out[seat]) {
              continue; // 走完自己出局 = 自杀，直接排除
            }
          }
        } catch (err) {
          // 试走失败就当没有这一步的收益
        }
      }

      // ④ 大鱼检测（对应 0x4A1F4C 的 Eval > 500 分支）
      if (row.score > BIG_CAPTURE) {
        row.big = true;
        row.score += BIG_BONUS;
      }

      // ⑤ 别在原地来回摆
      const lastMv = lastByPiece.get(mover.id);
      if (lastMv && lastMv.from === m.to && lastMv.to === m.from) row.score -= 150;

      out.moves.push(row);
    }

    out.moves.sort((a, b) => b.score - a.score);

    // 中级：只加"四家相对优势"（已经在 row.sim 里）；
    // 高级：再对前 K 个候选算一层"对手应手能吃我多少"，按扣分重排。
    const lv = LEVEL[opts.level || currentLevel] || 0;
    out.level = lv;
    if (lv >= LEVEL.high) {
      const k = Math.min(ROOT_K, out.moves.length);
      for (let i = 0; i < k; i += 1) {
        const row = out.moves[i];
        const pen = enemyReplyPenalty(state, seat, row);
        row.reply = pen;
        row.score -= pen * 0.7;          // 威胁打折：别被吓得不敢动
      }
      out.moves.sort((a, b) => b.score - a.score);
    }

    out.best = out.moves[0] || null;
    return out;
  }

  function choose(state, seat, opts) {
    let moves = [];
    try {
      moves = G.allLegalMoves(state, seat) || [];
    } catch (err) {
      return null;
    }
    if (!moves.length) return null;
    // 原版特判：只有一步就不要再想（0x49E768 里的 cnt==1 分支）
    if (moves.length === 1) return { from: moves[0].from, to: moves[0].to };
    const an = analyze(state, seat, opts);
    const b = an.best;
    if (b) return { from: b.from, to: b.to };
    return { from: moves[0].from, to: moves[0].to };
  }

  const API = {
    choose,
    analyze,
    buildBelief,
    evalCapture,
    evalDouble,
    maskWinProb,
    maskLoseProb,
    materialOf,
    relativeAdvantage,
    tune: TUNE,
    LEVEL,
    getLevel: () => currentLevel,
    setLevel: (name) => { if (LEVEL[name] !== undefined) currentLevel = name; return currentLevel; },
    CONST: { TYPE_ORDER, W, MASK_TEXT, GOLDEN, PROB_EPS, BIG_CAPTURE, PHASE_AT, K_EARLY, K_LATE },
  };

  root.JunqiAI0 = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
