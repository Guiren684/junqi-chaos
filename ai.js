/*
 * Strong PIMC / alpha-beta advisor for 乱战四国.
 *
 * The search architecture (belief sampling, selective alpha-beta, move ordering
 * and the material table) is adapted from BitByBitG/siguo-junqi's MIT-licensed
 * bots/engine/search.js:
 *   https://github.com/BitByBitG/siguo-junqi
 * Copyright (c) 2026 BitByBitG, MIT License.
 * This file is an independent adaptation to the rules/data model of this game.
 */
(function (root) {
  "use strict";
  const G = root.JunqiGame;
  const B = root.JunqiBoard;
  if (!G || !B) return;

  const N = B.BOARD.nodes;
  const IDX = new Map(N.map((n, i) => [n.id, i]));
  const ROADS = N.map((n) => B.BOARD.neighbors.get(n.id).map((id) => IDX.get(id)));
  const RAILS = N.map((n) => B.BOARD.railNeighbors.get(n.id).map((id) => IDX.get(id)));
  const LINES = B.BOARD.straightRailLines.map((line) => line.map((id) => IDX.get(id)));
  const THROUGH = N.map((_, i) => LINES.filter((line) => line.includes(i)));
  const TYPES = Object.keys(B.PIECE_INFO);
  const VALUES = {
    flag: 16000, mine: 35, bomb: 65, engineer: 48, platoon: 18, company: 24,
    battalion: 32, regiment: 43, brigade: 57, division: 75, army: 100, commander: 135,
  };
  // 令子：某方存活的最大可动棋子（40..32）。炸弹/地雷/军旗不计候选。
  // 依据（军棋理论/94-令子理论.md）：先失令子的一方胜率仅 33%（双方未失 49.5%）；
  // 40 有 54.3% 死于与对方 40 互撞、39 有 38.9%——「不知道对方令子在哪」是最大成本。
  const DOM_RANK = {
    commander: 40, army: 39, division: 38, brigade: 37, regiment: 36,
    battalion: 35, company: 34, platoon: 33, engineer: 32,
  };
  const DOMINANT_GAP = 12;          // 每级令子差的估值：低于一个连长(24)，避免与子力项重复计算
  // BLIND_CLASH_PENALTY 已停用（实测无效，见 rootPrior 注释）；保留常量便于复测
  const BLIND_CLASH_PENALTY = 160;

  // 守旗位：大本营正前方（同列底二线 row4）。
  // 行营在 row3(col1/col3)，下来到 row4(col1/col3) 再一步就进大本营，
  // 所以占住 row4 同列，行营里的敌子就下不来。详见 REPORT_PLAY 附录三。
  const GUARD_BONUS = 30;      // 缺位扣分（不是有子加分）——后者会把后场子锁死在原地
  const GUARD_IDX = {};
  for (const _seat of B.SEATS) {
    GUARD_IDX[_seat] = B.hqCells(_seat).map((hq) => {
      const col = hq.split("-")[2];
      return IDX.get(_seat + "-4-" + col);
    }).filter((x) => x !== undefined);
  }

  // 「令子直取」的落点：与大本营的两个入口同时相邻的角格（比如北家的 (6,1)）。
  // 站在这里，守方必须同时看住两个入口，是最省步数的破旗点。
  // 依据：军棋理论 01/90「破角不一定要先飞工兵，36/37 可以直接试」。
  const BASE_CORNERS = {};
  for (const _seat of B.SEATS) {
    const set = new Set();
    for (const hq of B.hqCells(_seat)) {
      const mouth = B.BOARD.neighbors.get(hq) || [];
      const cnt = new Map();
      for (const m of mouth) {
        for (const nb of B.BOARD.neighbors.get(m) || []) {
          if (nb === hq) continue;
          cnt.set(nb, (cnt.get(nb) || 0) + 1);
        }
      }
      for (const [cell, c] of cnt) if (c >= 2) set.add(cell);
    }
    BASE_CORNERS[_seat] = new Set([...set].map((id) => IDX.get(id)).filter((x) => x !== undefined));
  }
  const CORNER_BONUS = 18;        // 估值里的加成（营地是 5~9，铁路 4，所以这个量级只算「偏好」）

  const PROFILES = {
    wind: { label: "风", material: 1.00, flagAttack: 1.30, flagDefense: 0.65, camp: 5, rail: 4.0, hqPenalty: 0.10, risk: 0.28, attack: 1.30, bomb: 1.10, mine: 0.85, lambda: 0 },
    forest: { label: "林", material: 1.00, flagAttack: 1.00, flagDefense: 1.20, camp: 7, rail: 2.0, hqPenalty: 0.15, risk: 0.12, attack: 1.00, bomb: 1.00, mine: 1.00, lambda: 0 },
    fire: { label: "火", material: 1.02, flagAttack: 1.40, flagDefense: 0.60, camp: 4, rail: 3.0, hqPenalty: 0.10, risk: 0.32, attack: 1.50, bomb: 1.35, mine: 0.80, lambda: 0 },
    mountain: { label: "山", material: 1.00, flagAttack: 0.70, flagDefense: 1.50, camp: 9, rail: 1.0, hqPenalty: 0.20, risk: 0.08, attack: 0.80, bomb: 1.00, mine: 1.30, lambda: 0 },
  };
  const OPENING_CELLS = (() => {
    const cells = [];
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 5; c += 1) {
        if (B.CAMP_CELLS.has(`${r},${c}`)) continue;
        cells.push([r, c]);
      }
    }
    return cells;
  })();
  const TIMEOUT = {};
  const SEAT_INDEX = new Map(B.SEATS.map((s, i) => [s, i]));
  const TYPE_INDEX = new Map(TYPES.map((t, i) => [t, i]));
  // Zobrist table for the transposition table. Small collision risk is accepted;
  // the search is an advisor and the final move is revalidated by applyMove.
  const Z = new Uint32Array(N.length * TYPES.length * 4);
  for (let i = 0; i < Z.length; i += 1) Z[i] = (Math.random() * 0xffffffff) >>> 0;
  const TURN_Z = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) TURN_Z[i] = (Math.random() * 0xffffffff) >>> 0;
  const ally = (a, b) => B.teamOf(a) === B.teamOf(b);
  const dist = (a, b) => Math.abs(N[a].x - N[b].x) + Math.abs(N[a].y - N[b].y);

  function hashState(state) {
    let h = TURN_Z[SEAT_INDEX.get(state.turn) || 0];
    for (const p of state.pieces) {
      const ti = TYPE_INDEX.get(p.type);
      if (ti === undefined || p.pos < 0) continue;
      const si = SEAT_INDEX.get(p.owner) || 0;
      h ^= Z[(p.pos * TYPES.length + ti) * 4 + si];
    }
    return h >>> 0;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function standardPool() {
    const pool = {};
    for (const t of G.armyTypes()) pool[t] = (pool[t] || 0) + 1;
    return pool;
  }

  function allowedAt(type, pos) {
    if (pos < 0) return true;
    const n = N[pos];
    if (type === "flag") return n.kind === "hq";
    if (type === "mine") return n.row >= 4;
    if (type === "bomb") return n.row > 0;
    return true;
  }

  function initialDomain(p) {
    return new Set(TYPES.filter((t) => {
      if (!allowedAt(t, p.pos)) return false;
      if (p.moved && B.PIECE_INFO[t].immobile) return false;
      return true;
    }));
  }

  // 死子的初域：不能再用 allowedAt(-1)=true 兜成 12 类全集，
  // 否则死子会重新长出「地雷/军旗」，把已经锁死的独苗和雷旗抽屉全部冲垮，
  // 还会在同池 IPF 里偷走活子的雷/旗配额。
  //
  // 关键是不能拿 death_pos 直接当出生格（第 1 排的炸弹走到第 0 排战死，
  // 会被「第 0 排不能摆炸弹」误杀）。所以先区分动过 / 没动过：
  //   动过   → 用 moveTape 里**第一次移动的 from** 当出生格，且必不是雷/旗
  //   没动过 → death_pos 就是出生格（一步没动就死，位置不会变）
  function deadDomain(state, piece, tape, ownerAlive) {
    const set = new Set(TYPES);
    let firstFrom = null, deathPos = -1, everMoved = !!piece.moved, engineerOnly = false;
    for (const m of tape) {
      if (m.piece === piece.id) {
        everMoved = true;
        if (firstFrom === null) firstFrom = m.from;
        if (m.eng) engineerOnly = true;
        // 攻方战死：它当时站在 from 上
        if (m.out === "defender" || m.out === "both") deathPos = m.from;
      }
      if (m.cap === piece.id) deathPos = m.to;   // 守方战死：它站在 to 上
    }
    if (engineerOnly) return new Set(["engineer"]);   // 走过弯铁，只能是工兵

    if (!ownerAlive) {
      // 该家已灭：军旗可能已经没了，不做额外排除（保守）
    } else {
      set.delete("flag");   // 还在场上 ⇒ 它不可能是军旗（旗被挖即灭）
    }
    if (everMoved) {
      set.delete("mine");
      set.delete("flag");
      if (firstFrom !== null) {
        const n = N[firstFrom];
        if (n && n.row === 0) set.delete("bomb");
      }
      // moveTape 被截断、拿不到首动 from 时，不排除炸弹（宁可少锁，不可误杀）
    } else {
      if (deathPos >= 0) {
        const n = N[deathPos];
        if (n) {
          if (n.kind !== "hq") set.delete("flag");
          if (n.row < 4) set.delete("mine");
          if (n.row === 0) set.delete("bomb");
        }
      }
    }
    if (!set.size) for (const t of TYPES) set.add(t);   // 兜底
    return set;
  }

  /** 己方天命暗牌子的身份域（不是己方 / 没开暗牌 / 没有域 ⇒ null）。 */
  function ownLatentDomain(state, seat, piece) {
    if (_ENV.JJ_LATENT_OWN === "0") return null;
    if (!piece || piece.owner !== seat || !piece.latent) return null;
    // 同局 A/B：只关某一家的修正（镜面对照用，双方都开暗牌，只差「会不会玩」）
    if (state.latentOwnOff && state.latentOwnOff[piece.owner]) return null;
    if (!state.latentSeats || !state.latentSeats[piece.owner]) return null;
    if (!piece.domain || !piece.domain.size) return null;
    return new Set(piece.domain);
  }

  /**
   * 「这个子真的确定是工兵吗？」
   * 天命暗牌下棋盘上 24 枚全显示工兵（域里最小的那个），
   * 凡是按 `type === "engineer"` 触发的启发式（早期飞子禁令、挖雷期望、工兵保存）
   * 都必须先过这一关，否则每枚棋子都会被当成工兵 —— 整队会被禁令锁死。
   */
  function isRealEngineer(state, seat, p) {
    if (!p || p.type !== "engineer") return false;
    return !ownLatentDomain(state, seat, p);
  }

  // Public battle outcomes constrain hidden identities; no hidden type is read.
  function inferDomains(state, seat, memParam) {
    const mem = memParam || rankMemory(state, seat);
    const all = state.pieces.map((p) => ({
      id: p.id, owner: p.owner, pos: p.position ? IDX.get(p.position) : -1,
      moved: !!p.moved, known: G.visibleTo(state, seat, p), type: p.type || null,
    }));
    const domains = new Map();
    const tape = state.moveTape || [];
    const aliveOwner = new Set();
    for (const p of state.pieces) if (p.position) aliveOwner.add(p.owner);
    for (let i = 0; i < all.length; i += 1) {
      const ent = all[i];
      // 天命暗牌：己方 latent 子的 `type` 只是「域里最小的那个」（开局 24 枚全是工兵），
      // 拿它当已知身份会得出「我全队都是工兵」——搜索就是这么被废掉的。
      // 这里改成用游戏维护的身份域（game.js::buildLatentDomain），那才是真的已知信息。
      const latDom = ownLatentDomain(state, seat, state.pieces[i]);
      if (latDom) { domains.set(ent.id, latDom); continue; }
      if (ent.known && ent.type) { domains.set(ent.id, new Set([ent.type])); continue; }
      if (ent.pos >= 0) { domains.set(ent.id, initialDomain(ent)); continue; }
      // 阵亡子：位置没了，必须靠 moveTape 重建初域，否则会退回 12 类全集
      domains.set(ent.id, deadDomain(state, state.pieces[i], tape, aliveOwner.has(ent.owner)));
    }
    const battles = state.battles || [];
    for (let pass = 0; pass < 24; pass += 1) {
      let changed = false;
      for (const b of battles) {
        const a = all.find((p) => p.id === b.attacker);
        const d = all.find((p) => p.id === b.defender);
        if (!d) continue;
        const dd = domains.get(d.id);
        if (!dd) continue;
        // 攻方可能已被吃（撞死）。注意：即便 piece 还在数组里，它的 position 已是 null，
        // visibleTo 会返回 false，域退回初始的 10 种 —— 所以不能只看 a 是否存在。
        // 若那一手是我方/队友的子，类型是公开信息，直接用它反推守方等级：
        // 这正是「我的团长撞死 → 对方至少是旅长」。
        let da = null;
        if (b.attType && b.attSeat && ally(b.attSeat, seat)) {
          da = new Set([b.attType]);
        } else if (a) {
          da = domains.get(a.id);
        }
        if (!da) continue;
        const fits = (t, u) => battleOutcome(t, u, !!b.inHq, state.mode) === b.outcome;
        const nextA = new Set([...da].filter((t) => [...dd].some((u) => fits(t, u))));
        const nextD = new Set([...dd].filter((u) => [...nextA].some((t) => fits(t, u))));
        if (nextA.size && nextA.size < da.size) { domains.set(a.id, nextA); changed = true; }
        if (nextD.size && nextD.size < dd.size) { domains.set(d.id, nextD); changed = true; }
      }
      if (!changed) break;
    }
    // ---- 冲突检测 + 贪心松弛（2026-11-06）----
    // 原来这里只有一个兜底：域空了就退回 initialDomain。问题是「约束互相打架、但谁也不空」
    // 的情况**完全没有信号** —— 域被静静留着，可能过窄（漏掉真正的类型）也可能过宽（白猜）。
    // 现在逐场战斗检查「攻守两边的域里是否还存在一对能复现该战果的类型」，
    // 复现不了就算一次冲突，并在这两个子上按时间顺序重放约束（能保留几条保留几条），
    // 只丢掉那条对不上的。冲突数进 DOM_STATS.conflict，可在看板上直接发现回归。
    function relaxOne(id) {
      const ent = all.find((e) => e.id === id);
      if (!ent) return null;
      const base = ent.pos >= 0
        ? initialDomain(ent)
        : deadDomain(state, state.pieces.find((q) => q.id === id), tape, aliveOwner.has(ent.owner));
      if (!base || !base.size) return null;
      let keep = base;
      for (const b of battles) {
        const isA = b.attacker === id;
        if (!isA && b.defender !== id) continue;
        const oth = domains.get(isA ? b.defender : b.attacker);
        if (!oth || !oth.size) continue;
        const next = new Set([...keep].filter((t) => [...oth].some((u) =>
          battleOutcome(isA ? t : u, isA ? u : t, !!b.inHq, state.mode) === b.outcome)));
        if (next.size) keep = next;      // 对不上就跳过这一条，别把域清空
      }
      return keep;
    }
    for (const b of battles) {
      const da = domains.get(b.attacker);
      const dd = domains.get(b.defender);
      if (!da || !dd || !da.size || !dd.size) continue;
      let ok = false;
      for (const t of da) {
        for (const u of dd) {
          if (battleOutcome(t, u, !!b.inHq, state.mode) === b.outcome) { ok = true; break; }
        }
        if (ok) break;
      }
      if (ok) continue;
      DOM_STATS.conflict += 1;
      const na = relaxOne(b.attacker);
      const nd = relaxOne(b.defender);
      if (na && na.size) domains.set(b.attacker, na);
      if (nd && nd.size) domains.set(b.defender, nd);
    }
    for (const p of all) {
      if (domains.get(p.id)?.size) continue;
      DOM_STATS.emptyDomain += 1;        // 兜底也要有计数，否则又是一次静默退化
      domains.set(p.id, initialDomain(p));
    }
    // 记忆里那些战报推不出来的独立信号（动过⇒不是雷、曲折铁路⇒工兵）在这里补齐
    applyMemory(domains, all, mem, state);
    return domains;
  }

  // ==================== 敌方子力记忆（每个座位独享） ====================
  // 口径（2026-10-29 用户订正）：
  //   lo 只取「被它吃掉的最大那枚子的等级 + 1」，**不累加**。
  //   吃过 38 又吃过 36 ⇒ lo = 39，36 那一条对 lo 没有任何贡献（取 max 自然覆盖）。
  // 证据只用本座位看得见的东西：自己的子、已亮明的子、公开的走子与战况。
  // 队友的子在本视角里是暗的（normal 模式），所以「共享给队友」在数据上不成立；
  // 每个 seat 各算一份、各用一份，最后只落在 state.aiMemory[seat] 供调试查看。
  const RANK_NUM = {
    commander: 40, army: 39, division: 38, brigade: 37, regiment: 36,
    battalion: 35, company: 34, platoon: 33, engineer: 32,
  };
  // 兵力账：领先/落后如何改变风险偏好。
  //   adv = clamp(净差 / FORCE_EDGE_SCALE, -1, 1)，1 = 我方明显占优。
  //   领先时「换子」是好事 → 风险代价下调；落后时经不起对换 → 风险代价上调。
  //   FORCE_TRADE_K：领先时对「吃掉对方这枚子」额外加权多少（乘上该子的期望价值）。
  const _ENV = (typeof process !== "undefined" && process.env) ? process.env : {};
  const _num = (k, def) => (_ENV[k] !== undefined ? Number(_ENV[k]) : def);
  const FORCE_ON = _ENV.JJ_FORCE !== "0";
  // 25×12 全生命周期信念矩阵：默认开，JJ_MATRIX=0 退回旧算法（便于 A/B）
  const MATRIX_ON = _ENV.JJ_MATRIX !== "0";
  // 战果乘子（查表版）。实测与 inferDomains 高度冗余（域推理已经在用 battles 做
  // 更强的硬约束），16 组同局面配对只把绝对误差从 9.54 压到 9.26，噪声级别，
  // 所以默认关。JJ_FATE=1 打开，留给后续接网络版残差时再评估。
  const FATE_ON = _ENV.JJ_FATE === "1";
  // 轨迹乘子（进营/跨度/首发手）。离线信号很强（工兵×0.19、司令×2.31、炸弹×2.36），
  // 但接进 25×12 后测不出净增益：IPF 强制列配额，会把「多数子共享同一档位」的
  // 共同乘子整体归一掉，只有行间相对差异能留存。16 组样本的噪声（±3）远大于
  // 这个效应（±0.2），所以默认关，等更大样本或网络版残差再评估。
  const TRACK_ON = _ENV.JJ_TRACK === "1";
  // 配额消元（硬锁）：默认开。IPF 对整行/整列乘常数不变，只有零元与交叉比能留存，
  // 所以真正能提升的是「把配额吃满」——K=1 独苗、列侧 Hall、雷旗抽屉，链式传导。
  const QUOTA_ON = _ENV.JJ_QUOTA !== "0";
  // 世界采样是否用 25×12 矩阵当下验。实测（270 个未知子、每次 10 世界）：
  //   只阵法先验 + DFS 19.4% 命中 / 0.23ms；矩阵 + LAP 20.0% / 2.42ms（首次算矩阵贵，
  //   摊销后约 0.5ms）。差 0.6pp 落在噪声内（SE≈2.6pp），但成本实打实 ×2~10，
  //   所以默认关，等 1000+ 样本再判。JJ_WORLD_MX=1 打开。
  const WORLD_MATRIX = _ENV.JJ_WORLD_MX === "1";
  // 世界采样用 LAP（全局指派）替代 DFS 顺序贪心。实测同为矩阵下：DFS 21.3% / 3.52ms，
  // LAP 22.9% / 3.02ms —— 方向对但样本不足，且只在 WORLD_MATRIX 打开时才有意义。
  const WORLD_LAP = _ENV.JJ_LAP !== "0";
  // LAP 结果按局面缓存 + 局部对换采样。基础指派只跟局面有关、与噪声无关，
  // 整步解一次即可；每次采样从基础解出发做若干合法对换（配额天然守恒）。
  const LAP_BASE = _ENV.JJ_LAP_BASE !== "0";
  const LAP_SWAPS = _num("JJ_LAP_SWAPS", 40);
  // 按边缘独立抽样（不强制精确配额）：配额只在期望上满足。
  // 用途是验证「精确配额把分布抽尖了」这个假设。
  const LAP_MARG = _ENV.JJ_LAP_MARG === "1";
  // 诊断用：世界采样直接返回真值盘面（开天眼）。用来量「不知道对手是什么」
  // 到底改变了多少决策 —— 这是 ISMCTS 值不值得做的 go/no-go 指标。
  const ORACLE = _ENV.JJ_ORACLE === "1";
  // 半开天眼：对手在搜索树里不该看见我方暗牌。
  // 做法是「置换而非重采」——对手知道我们剩哪些兵种（数得出来），但不知道哪枚是哪枚，
  // 所以把我方被隐藏的子的兵种在它们之间随机置换。这样既不改变双方子力总数，
  // 又恰好剥掉「对手总能精准避开大子 / 用炸弹拦截司令」这种透视能力。
  // 默认**开**：搜索树里的对手只应看到它自己的 25 子，不该看穿我方暗牌。
  // 关掉它（JJ_MASK_OPP=0）时 search 不做 applyView，树里的敌人是全知的 ——
  // 它会精准避开我方大子、用炸弹专挑令子，我方进攻估值系统性偏低，
  // 而且**所有欺骗类战术（诱饵/假炸弹/装小子）全部失效**。
  // 2026-11-03 实测：同一套战术在开天眼环境下 30% vs 35%（测成负），
  // 关天眼后 60 局 46.7% vs 28.3%（+18.4pp）。这是最贵的一课。
  const MASK_OPP = _ENV.JJ_MASK_OPP !== "0";
  // 行营退路：贴着空行营 = 有一步安全格可退（行营里的子不能被吃）。
  // 实战直觉是「师军驻营口，打完缩回营里」，大子贴营的价值远高于小子贴营。
  // 系数按子力线性缩放（values/100），所以司令 +1.35×系数、团长 +0.43×系数。
  const CAMP_ESC = _num("JJ_CAMP_ESC", 0);
  // 攻击风险的地板系数。RISK_K=1 是旧行为（Math.max(6*attack, ev)，负期望被抹平）；
  // 0 允许把分数压到 0；负数允许「期望亏本」的攻击真的拿到负分、掉出候选池。
  // 背景：一代对零代的自死率 42.8% vs 零代 29.8%，而零代用的是**纯期望**（允许负值）。
  const RISK_K = _num("JJ_RISK_K", 1);
  // 疑似雷阈值：中雷概率高于它就不再给「攻击地板分」。
  // 地雷只在后两排且从不移动，「隐藏 + 没动过 + row>=4」就是唯一入口；
  // 地板分会把负期望抹平，等于鼓励拿大子换雷（实测大子撞雷占大子阵亡 4 成）。
  const MINE_STOP = _num("JJ_MINE_STOP", 0.15);
  // 工兵保存：这么多手之前，不让工兵从后场主动飞到一线（它是唯一的挖雷工具）
  const ENG_HOLD = _num("JJ_ENG_HOLD", 55);

  // ============ 战术连招：挂炸 / 弃子跟炸 / 捕获延伸（2026-11-03）============
  // 用户口径（军棋经典战术）：「遇到第 2 个大子被吃，后面要跟炸弹，被吃就炸掉它」。
  // 拆成三件事，缺一件这套战术就打不出来：
  //   ① HVT 识别：把「已确认是师以上 / 已连吃 2 子」的敌子标成高价值目标；
  //   ② 排序层：炸弹贴靠 HVT、或贴炸护卫的诱饵挡子，在根节点就排到前面；
  //   ③ 搜索层：叶节点若停在「吃子」上，必须继续算反吃（quiescence）——
  //      没有这一步，搜索只看到「我送掉一个师长（−75）」，看不到「随后炸掉它的司令（+70）」，
  //      于是永远不敢把诱饵送出去。这是 horizon effect 的标准解法。
  // ⚠ 默认**关**。累计 100 局 A/B（各配置 20~40 局，gen1 vs gen0，45ms/手）：
  //     全关          32.5%（40 局）净 −379
  //     只炸弹兑现     35.0%（40 局）净 −1895      ← 胜率持平，净战损大幅恶化
  //     兑现+挂靠     25.0%（40 局）净 −1334
  //     全开          22.5%（40 局）净 −1713
  //   一致的方向：每加一条「该打炸弹」的启发式，换子变多、胜率不动或下降。
  //   原因是这些分数（34 / 110 / 26 量级）和 rootPrior 里的 EV 分（几十）不同量纲，
  //   加进去会挤掉本来更好的候选，而 search 自己已经算得对。
  //   实现与结论见 日志.md §十九；要复现请显式 JJ_TAC=1。
  // 默认**开**。关天眼（公平环境）下 60 局：全开 46.7% vs 全关 28.3%（+18.4pp），
  // 净战损 −1615 vs −2429，吃子比 0.88 vs 0.76 —— 三个指标同向。
  // 之前测成负，是因为对手开天眼，诱饵/装小子骗不了它（见 日志.md §十九）。
  const TACTIC_ON = _ENV.JJ_TAC !== "0";
  // 捕获延伸默认**关**：实测 6 组 A/B（各 20 局 45ms）——
  //   qsearch 单独开 35%→45%（+10pp，净战损 +539），但和 HVT 排序叠加后 55%→50%（净战损 +211→−600）。
  //   原因是它吃掉 26% 的采样世界（2.66→1.96 世界/手），而 HVT 排序已经把「找炸弹目标」
  //   这件事做掉了，qsearch 再抢时间只是降低采样保真度。留着 JJ_QS=1 可单独启用。
  const QS_ON = _ENV.JJ_QS === "1";
  const QS_MAX = _num("JJ_QS_MAX", 3);        // 捕获延伸的最大层数（弃子跟炸只需 3 层：送→吃→炸）
  const QS_WIDTH = _num("JJ_QS_W", 5);        // 每层最多算几手吃子
  const QS_MIN = _num("JJ_QS_MIN", 50);       // 只有这一口「金额」≥ 它才延伸（50 ≈ 旅长）
  const HVT_RANK = _num("JJ_HVT_RANK", 38);   // 下界 ≥ 38（师长）才算高价值目标
  const BOMB_PAY_RANK = _num("JJ_PAY_RANK", 39); // 下界 ≥ 39（军长）才值得主动拿炸去换
  const BOMB_HUNT_K = _num("JJ_HUNT", 1);     // 炸弹主动靠近 HVT 的权重
  // 「炸弹兑现」单独一条开关：人类 3,241 局里炸弹主动炸掉大子 8,812 次，
  // 比「大子被吃」的 6,544 次还多 —— 说明这才是主要用法（不是被吃才炸）。
  const BOMB_EAT_K = _num("JJ_EAT_K", 1);
  // 诱饵默认**开**（前提是 MASK_OPP 也开，否则对手全知、根本不吃诱饵）：
  // 关天眼 60 局里它是 +18.4pp 组合的一部分；开天眼时它单独是 −20pp（55%→35%）。
  const BAIT_K = _num("JJ_BAIT", 1);
  // 装小子：炸弹离出生格每远 1 格扣这么多分。
  // 人类高手会把炸弹摆在小子堆里不动，等敌方大子来扫荡时撞死 —— 静止的炸弹最像雷/小子。
  // 默认 3：只在 MASK_OPP 打开（对手看不见暗牌身份）时才有意义，
  // 关天眼 60 局里它和诱饵一起把胜率从 28.3% 抬到 46.7%。
  const BOMB_HOLD_K = _num("JJ_BOMB_HOLD", 3);

  // ===== 先予后取：给「已知打不过」的着法一次翻案机会（2026-11-03）=====
  // 现在 isKnownSuicide 是**硬砍**：只要认定「我这枚子等级 < 对方下界」，就把这步从候选里删掉。
  // 但军棋里大量好棋恰恰是弃子：拿团/旅去撞已知军长，撞死了不要紧，
  // 身后的炸弹下一手把军长炸掉 —— 一换一是赚的（团 43 + 炸 65 vs 军 100），
  // 至少也不亏；而「不敢撞」的代价是对方大子继续吃我三四个子。
  // 做法：被砍掉的着法里，凡是「撞完之后我方炸弹能一步吃回那个格子」的，
  // 不直接丢，而是用**深度 +2** 单独搜一遍，能超过当前最好着就用它。
  // ⚠ 默认**关**：两个种子各 100 局（共 200 局）合并，开 36.5% / 关 34.5%（+2.0pp，噪声内），
  //   净战损反而差 707。原因见下：`isKnownSuicide` 砍掉的是「已知对方更大」，
  //   这种撞击即使炸回来也是亏的（团43+炸65 换 军100 = 净亏 8），
  //   真正能赚的「先予后取」发生在**目标未知**时，那条路早就由 rootPrior 的 EV 覆盖了。
  //   代码保留，要复现用 JJ_VERIFY=1。
  // 收敛早停（2026-11-03）：budgetMs 一直是**硬等待**（while 循环跑到 deadline 为止，
  // 不管有没有算完）。用户口径：「5 秒是最多 5 秒，提前算完就落子」。
  // 判据：连续 JJ_EARLY 个采样世界的最好着不变 ⇒ 再抽也翻不了盘，收工。
  // 至少跑满 2 个世界才允许早停（前 2 个世界是浅深度 3，进到 4 才有比较意义）。
  // JJ_EARLY=0 关掉，回到「跑满预算」的旧行为。
  const EARLY_STOP = _num("JJ_EARLY", 6);
  // 决策稳定化（2026-11-03）：同一个局面连跑 6 次 choose，6 次里 3 次选营长、3 次选工兵，
  // 绝对分从 −45 摆到 +87 —— 因为「安静局面」里所有候选的均值差都小于采样噪声，
  // argmax 等于抽签。这里把「在噪声带内并列」的候选找出来，用 rootPrior（静态启发式）
  // 而不是噪声去定序。带内并列 = |mean_i − mean_best| ≤ JJ_STABLE × 标准误。
  // ⚠ 默认**关**（0）。同种子 100 局：全关 35.0% / 只开它 20.0%（净战损 −3539 → −5422）。
  //   机制上说得通：并列时改用 rootPrior 定序，而 rootPrior 里有 `max(ev, 6×attack×RISK_K)`
  //   这条「地板分」，等于在并列里系统性偏向进攻着法。要用请显式 JJ_STABLE=1.5。
  const STABLE_K = _num("JJ_STABLE", 0);
  const VERIFY_ON = _ENV.JJ_VERIFY === "1";
  // 防守侧捕获延伸：「敌方撞上来」也要能回本。
  // 「我主动撞」走的是根节点候选（verifyMoves），「敌方撞我」走的是搜索树里的对方节点，
  // 两条路径不同：前者靠 forceQs 传下来，后者必须在**对方吃我之后**才触发延伸。
  // 只延伸「敌方吃我方子」这一类，比全局 qsearch 便宜得多。
  // ⚠ 默认关：上面那 200 局是 VERIFY+QS_DEF 一起测的，合并结果无收益；
  //   而且它把采样世界从 2.66 拉到 1.77~3.54（q/主 0.11~0.53），代价是真的。
  //   单独开它用 JJ_QS_DEF=1。
  const QS_DEF = _num("JJ_QS_DEF", 0);
  const VERIFY_EXT = _num("JJ_VERIFY_EXT", 2);    // 多搜几层
  const VERIFY_MAX = _num("JJ_VERIFY_MAX", 3);    // 每步最多验证几个
  const VERIFY_STATS = { tried: 0, kept: 0, won: 0, dived: 0 };
  const EARLY_STATS = { stopped: 0 };
  const TAC_STATS = { qNodes: 0, qLeafCap: 0, hvt: 0, bombEat: 0, bombNear: 0, bait: 0, hold: 0 };
  // 等级 → 兵种（HVT 价值按「下界对应的最低兵种」算，宁可低估）
  const RANK_TYPE = {};
  for (const t of Object.keys(RANK_NUM)) RANK_TYPE[RANK_NUM[t]] = t;
  const _occVer = new Int32Array(N.length);
  let _occTick = 0;
  let MASK_VIEW = null, TRUTH_VIEW = null;
  // 净差换算成 adv 的刻度：260 分 ≈ 三分之一强的差距。刻度越小，领先/落后越容易推动下面那些旋钮。
  const FORCE_EDGE_SCALE = _num("JJ_F_EDGE", 120);
  // 令子风险的缩放：领先时敢换，落后时经不起换。
  const FORCE_RISK_K = _num("JJ_F_RISK", 0.30);
  // 军旗风险**不缩放**：丢旗就是输，跟子力差没有关系。
  // 第一版把这两项一起缩，A/B 24 局 0 胜 19 负——领先方放松了守旗，直接被扛旗。
  const FORCE_FLAG_K = _num("JJ_F_FLAG", 0.0);
  // 换子意愿：A/B 24 局 33.3% vs 45.8%，方向不利，默认关掉（保留开关便于复测）。
  const FORCE_TRADE_K = _num("JJ_F_TRADE", 0);
  // 「打弱的那家」：四国的胜负是扛旗，不是比谁子多，所以账的用法不是「调整胆子大小」，
  // 而是「把优势集中到已经虚弱的那一家」。剩余子力比对手平均少 40 分 → 打他更划算。
  // 权重按 A/B 定档（各 32~40 局）：6 → 18 是这一次唯一稳定的改动，18 的两档都是 ~48~50% vs 35%。
  const FORCE_WEAK_K = _num("JJ_F_WEAK", 18);
  const FORCE_STATS = { plies: 0, ahead: 0, behind: 0, even: 0, sumAdv: 0 };

  // ---- 动态风格：把风/林/火/山当成「局势阶段」来切换 ----
  //   开局（前 30 手）           → 林：全项基准 + 护旗 1.2，先探清对方布局
  //   adv > +0.45（明显占优）    → 火：attack 1.5 / flagAttack 1.4，压上去扩大
  //   adv < -0.45（明显落后）    → 山：flagDefense 1.5 / camp 9 / attack 0.8，收回来等对方犯错
  //   其余（均势）               → 风：rail 4.0 最会走铁路，用来打开局面
  //
  // 带滞回：进火/山的门槛是 0.45，退回中性的门槛是 0.25，避免在阈值附近来回抖。
  // 触发方式：state.aiProfiles[seat] === "dyn"（页面上选「自适应」）。默认不改任何现有行为。
  const STYLE_ON = _ENV.JJ_STYLE !== "0";
  const STYLE_OPEN_PLY = _num("JJ_STYLE_OPEN", 30);
  // 阈值是量出来的，不是拍的：对称的 ±0.45 会让「山」占到 44.8%、「火」只有 5.7%
  //（adv 分布偏负，中位 −0.06），dyn 整体比四风格轮换还保守，A/B 43.8%。
  // 改成 0.32 / −0.45 之后：火 ≈24%、山 ≈21%，A/B 56.3%。
  //
  // 2026-11-03 二次调整（用户口径：山压到 25% 以内、多进攻、提高观赏性）：
  //   实测「四家全 dyn」时山占 29.4%（兵力账零和，一家领先必有一家落后），
  //   所以把 LO 从 −0.55 推到 −0.75、HI 从 0.32 降到 0.28：山 ↓、火 ↑。
  //   注意这和单家 dyn 的分布不是一回事，见 日志.md §二十一。
  const STYLE_HI = _num("JJ_STYLE_HI", 0.28);
  const STYLE_LO = _num("JJ_STYLE_LO", -0.75);
  const STYLE_EXIT = _num("JJ_STYLE_EXIT", 0.25);
  const STYLE_STATS = { forest: 0, wind: 0, fire: 0, mountain: 0, switches: 0 };

  function pickStyle(state, seat, adv) {
    if (!state.styleNow) state.styleNow = {};
    const prev = state.styleNow[seat];
    const ply = state.moveCount || 0;
    let next;
    if (ply < STYLE_OPEN_PLY) next = "forest";
    else if (prev === "fire") {
      next = adv > STYLE_EXIT ? "fire" : (adv < STYLE_LO ? "mountain" : "wind");
    } else if (prev === "mountain") {
      next = adv < -STYLE_EXIT ? "mountain" : (adv > STYLE_HI ? "fire" : "wind");
    } else if (adv > STYLE_HI) next = "fire";
    else if (adv < STYLE_LO) next = "mountain";
    else next = "wind";
    if (prev && prev !== next) STYLE_STATS.switches += 1;
    STYLE_STATS[next] = (STYLE_STATS[next] || 0) + 1;
    state.styleNow[seat] = next;
    return next;
  }

  // 一个子的期望价值（我已知的就是真值，暗子按身份域 × 配额）
  function pieceExpect(fl, id) {
    if (!fl) return 0;
    const row = fl.probs && fl.probs.get(id);
    if (row) return rowValue(row);
    return 0;
  }

  // 一个「两步内丢旗且无法应对」的威胁值多少分。可用 JJ_FLAG_RISK 关掉做 A/B。
  // 260 → 185：beatsProb 修准之后（补上炸弹/同级，平均抬高 ~1.4 倍），
  // 同一个系数等于把惩罚放大 1.4 倍，实测会让 AI 明显转向保守（和棋 6%→25%）。
  // 系数按 1/1.4 同步下调，才能保住原来的「有效压力」。A/B 48 局：41.7% vs 37.5%。
  const FLAG_RISK_PENALTY = (typeof process !== "undefined" && process.env && process.env.JJ_FLAG_RISK !== undefined)
    ? Number(process.env.JJ_FLAG_RISK) : 185;
  const RANK_LOW = 32;
  const RANK_HIGH = 40;
  const CN_NAME = {
    flag: "军旗", commander: "司令", army: "军长", division: "师长", brigade: "旅长",
    regiment: "团长", battalion: "营长", company: "连长", platoon: "排长",
    engineer: "工兵", mine: "地雷", bomb: "炸弹",
  };

  function newRankMemory(seat) {
    return {
      seat,
      lo: new Map(),        // pieceId -> 32..40：已知下界（「至少是 X」）
      hi: new Map(),        // pieceId -> 32..40：已知上界
      exact: new Map(),     // pieceId -> type：完全确定
      flat: new Set(),      // 已证明是普通子（既非雷也非旗，可动）
      noBomb: new Set(),
      noMine: new Set(),
      moved: new Set(),
      loWhy: new Map(),     // pieceId -> 得出 lo 的那条证据（可审计）
      probe: new Map(),     // pieceId -> 0..1：用团/营试探换来的「大子」确认度
      probeWhy: new Map(),  // pieceId -> 那条试探证据（可审计）
      conflicts: [],
    };
  }

  function bumpLo(mem, id, rank, why) {
    const v = Math.min(RANK_HIGH, rank);
    const cur = mem.lo.get(id);
    if (cur === undefined || v > cur) { mem.lo.set(id, v); mem.loWhy.set(id, why); }
  }
  // 试探确认度：用「团/营撞上去被吃」换来的「这区有大子」的把握。
  // 口径来自人类棋谱实测（training/probe_contact_human.py，22 局 / 1,080 战斗对 / 59 次团营被吃）：
  //   团长被吃且守方**动过**（动过 ⇒ 不是雷）n=12：P(≥旅)=100%  P(≥师)=67%
  //   营长被吃且守方动过                        n=16：P(≥旅)=75%   P(≥师)=50%
  //   AI 自战里团营被吃有 38% 是雷（人类只有 8.5%），所以**必须先排除雷**再谈大子，
  //   否则这条证据会把雷错记成大子，白白占掉配额。
  // 返回 0..1 的「算 1 个大子」的权重；0 表示这条证据不足以计额。
  const PROBE_W = { regiment: 0.67, battalion: 0.50 };
  function probeWeight(mem, domains, id) {
    let w = (mem && mem.probe.get(id)) || 0;
    // 已经用别的证据确定是师以上，直接算满
    const fl = knownFloor(mem, domains, id);
    if (fl >= 38) w = Math.max(w, 1);
    else if (fl >= 37) w = Math.max(w, 0.5);   // 排除雷后 >= 旅，按半个名额
    return w;
  }
  function cutHi(mem, id, rank) {
    const v = Math.max(RANK_LOW, rank);
    const cur = mem.hi.get(id);
    if (cur === undefined || v < cur) {
      const lo = mem.lo.get(id);
      if (lo !== undefined && v < lo) { mem.conflicts.push({ id, lo, hi: v }); return; }
      mem.hi.set(id, v);
    }
  }

  // 某个座位在这一手里「确知」的一枚棋子的类型；不知道返回 null。
  // 自己的子全知（死活都知道）；别人只认已经亮明的；攻方若是本座位派的，用战报里的 attType。
  function knownTypeOf(state, seat, piece, battle, role) {
    if (!piece) return null;
    if (piece.owner === seat) return piece.type || null;
    if (piece.position && G.visibleTo(state, seat, piece)) return piece.type || null;
    if (role === "att" && battle && battle.attSeat === seat && battle.attType) return battle.attType;
    return null;
  }

  function rankMemory(state, seat) {
    const mem = newRankMemory(seat);
    const byId = new Map();
    for (const p of state.pieces) byId.set(p.id, p);
    const latentOwner = (p) => !!(state.latentSeats && state.latentSeats[p.owner]);

    // ① 公开走子
    for (const mv of state.moveTape || []) {
      const p = byId.get(mv.piece);
      if (!p || p.owner === seat) continue;
      mem.moved.add(mv.piece);
      mem.noMine.add(mv.piece);                 // 地雷不能动
      if (mv.eng && !latentOwner(p)) {          // 曲折铁路 ⇒ 工兵（确定）
        mem.exact.set(mv.piece, "engineer");
        mem.lo.set(mv.piece, RANK_LOW);
        mem.hi.set(mv.piece, RANK_LOW);
        mem.flat.add(mv.piece);
        mem.noBomb.add(mv.piece);
      }
    }

    // ② 战况：只有「一方已知、另一方未知」的战报才能推出等级
    for (const b of state.battles || []) {
      const A = byId.get(b.attacker);
      const D = byId.get(b.defender);
      if (!D || !A) continue;
      const out = b.outcome;
      if (out !== "attacker" && out !== "defender" && out !== "both") continue;
      const tA = knownTypeOf(state, seat, A, b, "att");
      const tD = knownTypeOf(state, seat, D, b, "def");
      // 天命暗牌：己方 latent 子的 type 只是「域里最小的那个」，用它抬下界会低估对方。
      // 系统优先让己方赢（赢不了才输），所以「我方子被吃」实际推出的是
      // **我方身份域的上确界 + 1**，而不是阵亡时那个身份 + 1。
      const ceilA = latentCeilOf(state, seat, A);
      const ceilD = latentCeilOf(state, seat, D);
      if (A.owner !== seat && !tA && tD) unknownAttacker(mem, b, A.id, tD, ceilD);
      else if (D.owner !== seat && !tD && tA) unknownDefender(mem, b, D.id, tA, state.mode, ceilA);
    }
    return mem;
  }

  /** 天命暗牌下，己方 latent 子的身份域上确界（没开暗牌 / 没有域 → 0，等于不生效）。 */
  function latentCeilOf(state, seat, piece) {
    if (_ENV.JJ_LATENT_CEIL === "0") return 0;      // 同局 A/B 用
    if (!piece || piece.owner !== seat) return 0;
    if (!state.latentSeats || !state.latentSeats[piece.owner]) return 0;
    const dom = piece.domain;
    if (!dom || !dom.size) return 0;
    let m = 0;
    for (const t of dom) m = Math.max(m, RANK_NUM[t] || 0);
    return m;
  }

  // 未知子 E 主动攻击了已知子 V（V 是我的子或已亮明子）。
  // 名字里不带「敌」：队友的子在我视角里通常也是暗的，同一条规则照样成立。
  function unknownAttacker(mem, b, EId, tV, ceil) {
    const rv = Math.max(RANK_NUM[tV] || 0, ceil || 0);
    if (b.inHq) return;                 // 进大本营一律赢，与等级无关
    if (b.outcome === "attacker") {
      if (!rv) return;                  // V 是雷/炸/旗：规则特殊，不产生等级信息
      bumpLo(mem, EId, rv + 1, `吃我${CN_NAME[tV]}`);
      mem.flat.add(EId); mem.noBomb.add(EId); mem.noMine.add(EId);   // 活着的攻方不是雷/炸
    } else if (b.outcome === "both") {
      if (!rv) return;
      // E 与 V 同级，或者 E 是炸弹（乱战里也可能是雷）
      bumpLo(mem, EId, rv, `与我${CN_NAME[tV]}同归于尽`);
      cutHi(mem, EId, rv);
    } else {
      if (!rv) return;
      cutHi(mem, EId, rv - 1);          // E 攻上来被打死 ⇒ 比我这个子小
      mem.flat.add(EId); mem.noBomb.add(EId); mem.noMine.add(EId);
    }
  }

  // 已知子 V 攻击了未知子 E
  // 注意 outcome 的口径：resolveBattle 的 "defender" 表示守方活、攻方死，
  // 也就是「我这枚子撞死了」——别按字面理解成「守方被吃」。
  function unknownDefender(mem, b, EId, tV, mode, ceil) {
    const rv = Math.max(RANK_NUM[tV] || 0, ceil || 0);
    if (b.inHq) return;
    if (b.outcome === "defender") {
      // 我的子撞死，E 活着 ⇒ E 比我大。
      // 但**一般军棋**里非工兵撞雷是「攻方死、雷保留」，所以 E 也可能是地雷——
      // 这一条只能推「要么是雷，要么比我大」，不能当成纯等级下界去砍身份域里的雷。
      if (!rv) return;
      if (tV === "engineer" && !ceil) return;   // 工兵撞不死普通子；但暗牌子只是"最小显示为工兵"，不能据此跳过
      bumpLo(mem, EId, rv + 1, `撞死我${CN_NAME[tV]}`);
      mem.noBomb.add(EId);                    // 炸弹会同归于尽，不会站着不动
      if (mode === "chaos") {                 // 乱战里撞雷双方都死，站住的不是雷
        mem.noMine.add(EId);
        mem.flat.add(EId);
      }
      // 试探记账：团/营撞上去被吃，且这个子已经证明不是雷（动过 / 已被排除），
      // 就记一条「这区有大子」的软证据。用户口径是「团营一级被吃就够」，
      // 但实测必须把雷剔掉：人类对局里团营被吃有 8.5% 是雷，AI 自战里是 38%。
      const pw = PROBE_W[tV];
      if (pw && (mem.noMine.has(EId) || mem.moved.has(EId) || mem.flat.has(EId))) {
        const cur = mem.probe.get(EId) || 0;
        if (pw > cur) {
          mem.probe.set(EId, pw);
          mem.probeWhy.set(EId, `${CN_NAME[tV]}试探被吃(已排除雷)`);
        }
      }
    } else if (b.outcome === "both") {
      if (!rv) return;
      bumpLo(mem, EId, rv, `与我${CN_NAME[tV]}同归于尽`);
      cutHi(mem, EId, rv);
    } else {
      // E 被我吃掉 ⇒ E 比我小
      if (!rv) return;
      if (tV === "engineer") {                // 工兵唯一能吃的是地雷
        mem.exact.set(EId, "mine");
        mem.noBomb.add(EId); mem.flat.delete(EId);
        return;
      }
      cutHi(mem, EId, rv - 1);
      mem.flat.add(EId); mem.noBomb.add(EId); mem.noMine.add(EId);
    }
  }

  // 把记忆并进身份域：只取交集，取不到非空就放弃（宁可回到宽域，也不制造错误窄域）
  function applyMemory(domains, all, mem, state) {
    let narrowed = 0;
    for (const p of all) {
      if (p.owner === mem.seat) continue;
      const d = domains.get(p.id);
      if (!d || !d.size) continue;
      const ex = mem.exact.get(p.id);
      if (ex && d.has(ex)) { domains.set(p.id, new Set([ex])); narrowed += 1; continue; }
      const lo = mem.lo.get(p.id);
      const hiSoft = !(state.latentSeats && state.latentSeats[p.owner]);
      const hi = mem.hi.get(p.id);
      const moved = mem.moved.has(p.id);
      const noBomb = mem.noBomb.has(p.id);
      const noMine = mem.noMine.has(p.id);
      if (lo === undefined && hi === undefined && !moved && !noBomb && !noMine) continue;
      const next = new Set();
      for (const t of d) {
        if (t === "bomb") { if (!noBomb) next.add(t); continue; }
        if (t === "mine") { if (!noMine && !moved) next.add(t); continue; }
        if (t === "flag") { if (!moved && lo === undefined && hi === undefined) next.add(t); continue; }
        const r = RANK_NUM[t];
        if (lo !== undefined && r < lo) continue;
        if (hi !== undefined && hiSoft && r > hi) continue;
        next.add(t);
      }
      if (next.size && next.size < d.size) { domains.set(p.id, next); narrowed += 1; }
    }
    return narrowed;
  }

  // 采样补全的身份域有时整体不可满足（例如记忆把 4 枚子都压成工兵，而工兵只有 3 枚），
  // DFS 会指数级回溯，实测能把一步棋拖到十几秒甚至更久（页面直接卡死）。
  // 给 DFS 一个节点预算：超了就放弃这一次采样，让上层重抽，绝不无限回溯。
  const ASSIGN = { nodes: 0, limit: 40000, aborted: 0 };

  // 世界采样会对同一局面反复采样（多个世界 × 多个 owner）。这里必须用**多槽**缓存：
  // 单槽会被 owner 循环（east→south→west）轮流冲掉，等于每个样本都重算三遍矩阵，
  // 实测单槽 2.7ms/世界、多槽 0.3ms/世界。
  const WMC = new WeakMap();          // state -> Map(key, {dom, v})
  function wcGet(state, key, dom) {
    const m = WMC.get(state);
    const e = m && m.get(key);
    return e && e.dom === dom ? e.v : undefined;
  }
  function wcSet(state, key, dom, v) {
    let m = WMC.get(state);
    if (!m) { m = new Map(); WMC.set(state, m); }
    if (m.size > 256) m.clear();
    m.set(key, { dom, v });
  }
  function beliefMatrixCached(state, seat, owner, domains, priorOf) {
    const key = "bm|" + seat + "|" + owner + "|"
      + (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1);
    const hit = wcGet(state, key, domains);
    if (hit !== undefined) return hit;
    const mx = beliefMatrix(state, seat, owner, domains, priorOf);
    wcSet(state, key, domains, mx);
    return mx;
  }

  // ---- 阵库联合后验（JOINT，2026-11-04）----
  // 现有先验是「逐格边缘」：每格一张 30×12 表，格子之间互不知道对方。
  // 但「r0c0 是司令」这件事会改写**整盘**其它格（同排大子率 14.9%→5.2%）——
  // 那是联合分布才有、边缘分布永远给不出来的信息。
  // 做法：拿已知硬证据（身份域）过滤 12,964 座人类阵库，把剩下的按每格边缘化；
  // 兼容集太小（nEff 低）时按比例收缩回边缘先验，避免小样本噪声。
  let JF = root.JUNQI_FORM_JOINT || null;
  if (!JF && typeof require === "function") {
    try { require("./formation_joint_data.js"); JF = root.JUNQI_FORM_JOINT || null; } catch (err) { JF = null; }
  }
  const JOINT_ON = (_ENV.JJ_JOINT || "") !== "0" && !!JF;
  // 参数是量出来的（留出评估，见 日志 §三十九）：
  //   EPS = 「与身份域冲突的阵型还留多少权重」。硬 0 会脆（EPS=0.0002 反而 +0.025），
  //         0.03~0.05 是一段平台（-0.09），再大就钝（0.12 只有 -0.08）。
  //   K   = 收缩强度（往逐格边缘先验拉）。实测 K=0 最好：EPS 本身已经提供平滑，
  //         再叠收缩等于把「联合比边缘多出来的那部分」又抹掉一遍（K=20 只剩 -0.036）。
  const JOINT_K = _num("JJ_JOINT_K", 0);
  const JOINT_EPS = _num("JJ_JOINT_EPS", 0.04);
  // 「明子」这条链路的第二步（用户 11-04 中午）：先用行为证据锁定大子，
  // 再把这层概率（而不是「可行 / 不可行」的 0-1 掩码）喂给阵库。
  // 关掉时退回老行为：域内 1、域外 EPS。
  const JOINT_SOFT = _ENV.JJ_JOINT_SOFT !== "0";
  const JOINT_SOFT_W = _num("JJ_JOINT_SOFT_W", 1);
  // 世界抽样（搜索）里用不用联合后验。**默认不用**（2026-11-04 实测）：
  // 把它喂进世界会收窄 PIMC 的抽样分布，AI 从「多种可能」变成「自以为知道」，
  // 撞未知子的胜率 57.2% → 52.5%（-7.0pp，3.5σ）、子力净收益 +6.3 → +4.7。
  // 从世界抽样里摘掉之后回到 57.2 vs 57.9（-0.7pp，噪声内），而信念/面板仍然更准。
  // 结论：**猜得准 ≠ 搜得对**，把更尖的分布直接塞给 PIMC 反而有害。
  // JJ_JOINT_SEARCH=1 可开回来（要配温度/混合才有意义，见 日志 §四十三）。
  const JOINT_SEARCH = _ENV.JJ_JOINT_SEARCH === "1";

  // ---- 显式期望评估（EVAL_EV，2026-11-04）----
  // 一手只抽 1~5 个世界时，「抽到什么算什么」是点估计，不是期望（日志 §四十四）。
  // 这里给每个世界里的子挂一个 `ev` = E[VALUES]（按信念行加权），评估的价值项一律用它，
  // 让「区间」以期望的形式进入分数，而不是靠抽样碰运气。
  // 世界的确定性只保留在「能不能走、能不能吃」上。
  const EVAL_EV = _ENV.JJ_EVAL_EV !== "0";
  const POS_ALL = _ENV.JJ_POS_ALL === "1";       // 对照用：无差别启用逐格位置先验  // 与域冲突的权重（不做硬 0：一条错推断不该毁全盘）
  const JOINT_STATS = { calls: 0, hits: 0, none: 0, nEff: 0, alpha: 0 };
  const JF_IDX = new Map((JF ? JF.types : []).map((t, i) => [t, i]));
  const JOINT_CELL = (() => {                    // (r*5+c) → open 里的下标
    const a = new Array(30).fill(-1);
    if (JF) JF.open.forEach((rc, i) => { a[rc[0] * 5 + rc[1]] = i; });
    return a;
  })();

  /**
   * 只含「硬域 + 行为似然」的证据行，**不含**位置先验与联合先验。
   * 用途：喂给 jointRows 当软证据 —— 这样「撞打过仗的子 ⇒ 它是大子」这条
   * 能顺着阵库反推到整盘，而不是只在它自己那一格生效。
   * 不含位置/联合先验是刻意的：否则「联合 → 行 → 联合」自指，越算越偏。
   */
  function evidenceRowsOnly(state, seat, owner, domains) {
    const m = new Map();
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      if (p.position && G.visibleTo(state, seat, p)) { m.set(p.id, new Map([[p.type, 1]])); continue; }
      const d = domains.get(p.id);
      if (!d || !d.size) continue;
      const u = 1 / d.size;
      const row = new Map();
      for (const t of d) row.set(t, u);
      m.set(p.id, row);
    }
    try { applyEatPrior(state, seat, m, domains); } catch (err) { /* 不影响主流程 */ }
    return m;
  }

  /**
   * 给某个座位的每枚暗子算出「阵库联合后验」那一行。
   * 证据只用硬约束（身份域）——软的似然表（EAT/DEFPRIOR 那一类）实测在这层会互相打架，
   * 而联合后验的价值恰恰在于「一条硬证据改写整盘」，不需要再叠软证据。
   * 返回 Map(pieceId → Map(type → 概率))；没有可用信息时返回 null。
   */
  function jointRows(state, seat, owner, domains) {
    if (!JOINT_ON || !domains) return null;
    if (state.jointOff && state.jointOff[seat]) return null;   // 同局 A/B：只关某一队
    if (state.newGuessOff && state.newGuessOff[seat]) return null;   // 整队退回旧猜子
    const baseKey = (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1);
    if (!state.__joint || state.__joint.key !== baseKey) state.__joint = { key: baseKey, m: new Map() };
    if (state.__joint.m.has(owner)) return state.__joint.m.get(owner);

    JOINT_STATS.calls += 1;
    const soft = JOINT_SOFT ? evidenceRowsOnly(state, seat, owner, domains) : null;
    const ev = new Array(25).fill(null);
    let evid = 0;
    let unknown = 0;
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      if (p.position && G.visibleTo(state, seat, p)) continue;   // 亮着的子不需要猜
      const ip = initPosOf(state, p);
      if (!ip) continue;
      const mm = /-(\d)-(\d)$/.exec(ip);
      if (!mm) continue;
      const ci = JOINT_CELL[(+mm[1]) * 5 + (+mm[2])];
      if (ci < 0) continue;
      unknown += 1;
      const d = domains.get(p.id);
      const row = new Float64Array(12).fill(JOINT_EPS);
      if (soft) {
        // 软证据：行为似然已经把「哪些类型更可能」算进去了，这里只把它压到 [EPS, 1] 区间
        const sr = soft.get(p.id);
        if (sr && sr.size) {
          let mx = 0;
          for (const [, w2] of sr) if (w2 > mx) mx = w2;
          if (mx > 0) {
            for (const [t, w2] of sr) {
              const ti = JF_IDX.get(t);
              if (ti === undefined) continue;
              row[ti] = Math.max(JOINT_EPS, Math.pow(w2 / mx, JOINT_SOFT_W));
            }
            evid += 1;
            ev[ci] = row;
            continue;
          }
        }
      }
      if (d && d.size) {
        for (const t of d) {
          const ti = JF_IDX.get(t);
          if (ti !== undefined) row[ti] = 1;
        }
        evid += 1;
      } else row.fill(1);
      ev[ci] = row;
    }
    if (!evid) { JOINT_STATS.none += 1; state.__joint.m.set(owner, null); return null; }

    // 留出评估：只允许用「另一半 gid」训练的计数，否则等于拿答案查答案
    //（replays_human 那 125 局本来就包含在 3,241 局阵库里）。
    const SP = _ENV.JJ_JOINT_SPLIT;
    const counts = (SP === "even" && JF.nE) ? JF.nE : (SP === "odd" && JF.nO) ? JF.nO : JF.n;
    const forms = JF.forms, nf = forms.length;
    const M = new Array(25);
    for (let c = 0; c < 25; c += 1) M[c] = new Float64Array(12);
    let sw = 0, sw2 = 0;
    for (let f = 0; f < nf; f += 1) {
      const str = forms[f];
      let w = counts[f];
      for (let c = 0; c < 25; c += 1) {
        const e = ev[c];
        if (!e) continue;
        const v = e[str.charCodeAt(c) - 48];
        if (v < 1) { w *= v; if (w === 0) break; }
      }
      if (w === 0) continue;
      sw += w; sw2 += w * w;
      for (let c = 0; c < 25; c += 1) M[c][str.charCodeAt(c) - 48] += w;
    }
    if (!(sw > 0)) { JOINT_STATS.none += 1; state.__joint.m.set(owner, null); return null; }

    const nEff = (sw * sw) / sw2;
    const alpha = nEff / (nEff + JOINT_K);
    JOINT_STATS.hits += 1;
    JOINT_STATS.nEff += nEff;
    JOINT_STATS.alpha += alpha;

    const post = new Array(25);
    for (let c = 0; c < 25; c += 1) {
      const row = new Float64Array(12);
      const base = JF.marg[c];
      for (let t = 0; t < 12; t += 1) {
        row[t] = alpha * (M[c][t] / sw) + (1 - alpha) * base[t];
      }
      post[c] = row;
    }

    const out = new Map();
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      if (p.position && G.visibleTo(state, seat, p)) continue;
      const ip = initPosOf(state, p);
      if (!ip) continue;
      const mm = /-(\d)-(\d)$/.exec(ip);
      if (!mm) continue;
      const ci = JOINT_CELL[(+mm[1]) * 5 + (+mm[2])];
      if (ci < 0) continue;
      const row = new Map();
      for (let t = 0; t < 12; t += 1) {
        const v = post[ci][t];
        if (v > 0) row.set(JF.types[t], v);
      }
      out.set(p.id, row);
    }
    state.__joint.m.set(owner, out);
    return out;
  }

  // 世界抽样的先验：位置先验 × 阵法先验 → 25×12 矩阵 → 每行的 log 分布。
  // 抽成独立函数，供 buildWorld 与诊断脚本共用（诊断要一个「参考后验」算 NLL）。
  function worldPriors(state, seat, owner, domains) {
    const byIdAll = new Map();
    for (const pc of state.pieces) byIdAll.set(pc.id, pc);
    const humanLike = !!(FP && FP.state === state && FP.owner === owner && FP.isCustom);
    const jrows = JOINT_SEARCH ? jointRows(state, seat, owner, domains) : null;
    const priorOf = (id) => {
      const pc = byIdAll.get(id);
      const jr = jrows ? jrows.get(id) : null;
      return mulPrior(
        mulPrior(
          // 有联合后验就不再用逐格位置先验：两套都是「分布」，乘在一起等于把位置算两遍
          jr || ((humanLike || POS_ALL) ? posPriorRow({ position: pc.position, __init: initPosOf(state, pc) }, state.moveCount) : null),
          formationPriorRow(state, owner, id),
        ),
        null,
      );
    };
    // 按座位开矩阵：默认 WORLD_MATRIX=false 时，世界抽样**根本没有任何先验**
    // （logPriors 为空 → assignTypes 退化成域内均匀），这是 §四十五 查出来的大事。
    const useMx = WORLD_MATRIX || !!(state.worldMxFor && state.worldMxFor[seat]);
    const mx = useMx ? beliefMatrixCached(state, seat, owner, domains, priorOf) : null;
    // logPriors 也缓存：25 行 × 12 类 = 300 次 Map 插入，每次采样重建是纯浪费。
    const tau = worldTau(state, seat);
    const ck = "wp|" + seat + "|" + owner + "|" + tau + "|"
      + (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1);
    const cached = wcGet(state, ck, domains);
    if (cached !== undefined) return cached;
    const logPriors = new Map();
    if (mx) {
      for (const [id, row] of mx.rows) {
        const lp = new Map();
        for (const [t, w] of row) lp.set(t, Math.log(Math.max(w, 1e-6)));
        logPriors.set(id, lp);
      }
    } else {
      // 矩阵关闭时必须回到原来的阵法先验路径。否则 logPriors 是空表，
      // assignTypes 的 weightedOrder 会退化成「均匀随机排序」，
      // 基线就不是「阵法先验 + DFS」而是「无先验 + DFS」，A/B 直接失去意义。
      for (const pc of state.pieces) {
        if (pc.owner !== owner) continue;
        const pr = formationPriorRow(state, owner, pc.id);
        if (!pr) continue;
        const lp = new Map();
        for (const [t, w] of pr) lp.set(t, FORM_A * Math.log(Math.max(w, 1e-4)));
        logPriors.set(pc.id, lp);
      }
    }
    // 温度：logP / τ。注意不要动缺省值（assignTypes 里的 -9 是「无先验」占位，
    // 除以 τ 会把它抬起来，等于凭空给无先验候选加权重）。
    if (tau !== 1) {
      for (const lp of logPriors.values()) {
        for (const [t, v] of lp) lp.set(t, v / tau);
      }
    }
    const out = { mx, logPriors };
    wcSet(state, ck, domains, out);
    return out;
  }

  // ==================== 线性指派采样（LAP） ====================
  // DFS 是「按候选数排序 → 顺序贪心 → 回溯」，强先验反而更容易把前面几行顶死、
  // 把后手逼进死路（实测把矩阵塞进 logPriors 后命中率 21.4%→15.4%、耗时 ×10）。
  // 这里改成全局指派：把 12 类按配额展开成 25 列，一次求最小代价完美匹配，
  // 配额天然守恒，且每行只受自己的分布影响，不会被前几行的选择挤歪。
  function hungarian(cost) {
    const n = cost.length;
    if (!n) return [];
    const u = new Array(n + 1).fill(0);
    const v = new Array(n + 1).fill(0);
    const p = new Array(n + 1).fill(0);
    const way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(n + 1).fill(Infinity);
      const used = new Array(n + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j += 1) {
          if (used[j]) continue;
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        if (!isFinite(delta)) return null;
        for (let j = 0; j <= n; j += 1) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else { minv[j] -= delta; }
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }
    const ans = new Array(n).fill(-1);
    for (let j = 1; j <= n; j += 1) if (p[j]) ans[p[j] - 1] = j - 1;
    return ans;
  }

  // 温度：1.0 = 严格按后验采样；越小越接近 MAP
  const LAP_TAU = _num("JJ_LAP_TAU", 0.5);
  const LAP_INF = 1e6;

  function assignTypesLAP(unknown, pool, domains, logPriors, noNoise) {
    // 把配额展开成列
    const cols = [];
    for (const t of TYPES) {
      for (let k = 0; k < (pool[t] || 0); k += 1) cols.push(t);
    }
    const n = unknown.length;
    if (!n || cols.length !== n) return null;      // 数量对不上说明域自相矛盾
    const gumbel = () => {
      const u = Math.max(Math.random(), 1e-12);
      return -Math.log(-Math.log(u));
    };
    const cost = [];
    for (let i = 0; i < n; i += 1) {
      const p = unknown[i];
      const d = domains.get(p.id);
      const lp = logPriors && logPriors.get(p.id);
      const row = new Array(n);
      for (let j = 0; j < n; j += 1) {
        const t = cols[j];
        if (!d || !d.has(t) || !allowedAt(t, p.pos)) { row[j] = LAP_INF; continue; }
        const logP = lp && lp.has(t) ? lp.get(t) : -Math.log(Math.max(d.size, 1));
        row[j] = noNoise ? -logP : (-logP - gumbel() / LAP_TAU);
      }
      cost.push(row);
    }
    const sol = hungarian(cost);
    if (!sol) return null;
    const chosen = new Map();
    for (let i = 0; i < n; i += 1) {
      const j = sol[i];
      if (j < 0 || cost[i][j] >= LAP_INF) return null;    // 有行被迫吃非法列
      chosen.set(unknown[i].id, cols[j]);
    }
    return chosen;
  }

  // 基础指派缓存：key 与 beliefMatrixCached 同口径（走子数 + 战报数 + 未知子数），
  // 并要求 domains 是同一个对象——搜索里同一层复用同一个 domains，命中率接近 100%。
  function lapBaseCached(state, seat, owner, unknown, pool, domains, logPriors) {
    const key = "lap|" + seat + "|" + owner + "|"
      + (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1) + "|" + unknown.length;
    const hit = wcGet(state, key, domains);
    if (hit !== undefined) return hit;
    const base = assignTypesLAP(unknown, pool, domains, logPriors, true);
    wcSet(state, key, domains, base);
    return base;
  }

  // 从基础解出发做 Metropolis 对换，目标分布 ∝ Π p_i(type_i)（在配额与域约束内）。
  // 对换不改兵种多重集 ⇒ 配额永远合法；每次只查两个域，代价接近 0。
  function swapSample(base, unknown, domains, logPriors, rounds) {
    const n = unknown.length;
    if (!n) return null;
    const ids = new Array(n);
    const ty = new Array(n);
    for (let i = 0; i < n; i += 1) {
      ids[i] = unknown[i].id;
      ty[i] = base.get(ids[i]);
      if (!ty[i]) return null;
    }
    const lpOf = (i, t) => {
      const lp = logPriors && logPriors.get(ids[i]);
      if (lp && lp.has(t)) return lp.get(t);
      const d = domains.get(ids[i]);
      return -Math.log(Math.max(d ? d.size : 1, 1));
    };
    const okAt = (i, t) => {
      const d = domains.get(ids[i]);
      return (!d || d.has(t)) && allowedAt(t, unknown[i].pos);
    };
    for (let r = 0; r < rounds; r += 1) {
      const i = (Math.random() * n) | 0;
      const j = (Math.random() * n) | 0;
      if (i === j || ty[i] === ty[j]) continue;
      if (!okAt(i, ty[j]) || !okAt(j, ty[i])) continue;
      const delta = (lpOf(i, ty[j]) + lpOf(j, ty[i])) - (lpOf(i, ty[i]) + lpOf(j, ty[j]));
      // 温度口径要和 LAP 一致：LAP 里 `-logP - g/τ` 等价于目标 ∝ p^τ（τ 小 = 更平），
      // Metropolis 要采同一个目标就得用 exp(τ·ΔE)，写成 exp(ΔE/τ) 方向正好反过来。
      if (delta >= 0 || Math.random() < Math.exp(LAP_TAU * delta)) {
        const t = ty[i]; ty[i] = ty[j]; ty[j] = t;
      }
    }
    const out = new Map();
    for (let i = 0; i < n; i += 1) out.set(ids[i], ty[i]);
    return out;
  }

  // 按行分布独立抽（Gumbel-max），完全不看配额。
  // 这样每个子的实际分布 = 它自己的边缘分布，不会被「抢配额」逼到其他兵种上。
  function assignTypesMarginal(unknown, domains, logPriors) {
    const out = new Map();
    for (const p of unknown) {
      const d = domains.get(p.id);
      const lp = logPriors && logPriors.get(p.id);
      const opts = [];
      if (d) for (const t of d) { if (allowedAt(t, p.pos)) opts.push(t); }
      if (!opts.length) return null;
      let best = null, bv = -Infinity;
      for (const t of opts) {
        const base = lp && lp.has(t) ? lp.get(t) : -Math.log(opts.length);
        const u = Math.max(Math.random(), 1e-12);
        const v = base - Math.log(-Math.log(u));
        if (v > bv) { bv = v; best = t; }
      }
      out.set(p.id, best);
    }
    return out;
  }

  function assignTypes(unknown, pool, domains, logPriors) {
    // 按先验权重给候选兵种排序（指数赛马：log w + Gumbel 噪声），
    // 这样抽样会偏向先验里更可能的兵种，又不会把低概率项排除掉，也不增加 DFS 分支数。
    const weightedOrder = (options, lp) => {
      if (!lp) { shuffle(options); return; }
      // 温度在 worldPriors 里已经把 logP 除以 τ 了（按座位可分），这里不再重复。
      const scored = options.map((t) => {
        // 标准 Gumbel 采样：-log(-log(U))。原来用的 -log(U) 是指数分布，
        // 排序效果近似但不是 Gumbel-Max，偏离后验更远。
        const u = Math.max(Math.random(), 1e-12);
        const g = -Math.log(-Math.log(u));
        return [t, (lp.has(t) ? lp.get(t) : -9) + g];
      });
      scored.sort((x, y) => y[1] - x[1]);
      for (let i = 0; i < options.length; i += 1) options[i] = scored[i][0];
    };
    const order = unknown.slice().sort((a, b) => {
      const da = TYPES.filter((t) => pool[t] > 0 && allowedAt(t, a.pos) && domains.get(a.id)?.has(t)).length;
      const db = TYPES.filter((t) => pool[t] > 0 && allowedAt(t, b.pos) && domains.get(b.id)?.has(t)).length;
      return da - db;
    });
    const chosen = new Map();
    ASSIGN.nodes = 0;
    let aborted = false;
    function dfs(i) {
      if (aborted) return false;
      ASSIGN.nodes += 1;
      if (ASSIGN.nodes > ASSIGN.limit) { aborted = true; return false; }
      if (i === order.length) return true;
      const p = order[i];
      const domain = domains.get(p.id);
      let options = TYPES.filter((t) => pool[t] > 0 && allowedAt(t, p.pos) && domain?.has(t));
      if (!options.length) options = TYPES.filter((t) => pool[t] > 0 && allowedAt(t, p.pos));
      weightedOrder(options, logPriors && logPriors.get(p.id));
      for (const t of options) {
        pool[t] -= 1;
        chosen.set(p.id, t);
        if (dfs(i + 1)) return true;
        chosen.delete(p.id);
        pool[t] += 1;
        if (aborted) return false;
      }
      return false;
    }
    const ok = dfs(0);
    if (!ok && aborted) ASSIGN.aborted += 1;
    return ok ? chosen : null;
  }

  /*
   * A sampled world is built without looking at hidden types. Own and revealed
   * pieces are fixed; every other piece is filled from the standard 25-piece
   * inventory subject to flag/mine/bomb placement. This deliberately avoids
   * leaking the real deal (including the 天命暗牌 cheat) into the search.
   */
  // ==================== 阵法库先验 ====================
  // 一般模式各家开局从 72 套阵法里抽一套（formations.js / applyOpenings），而每个暗子的
  // **初始位置**是公开信息（棋子摆在明处，只是军衔朝下）。两者一合就是一份强先验。
  // 实测（training/REPORT_GUESS.md §4）：加上它之后暗子 top1 0.298→0.382、
  // 炸弹 AUC 0.803→0.910、工兵 0.662→0.781，地雷不掉。
  //
  // 两条经验教训写死在这里，别踩回去：
  //   ① shuffleMineRow 每局把雷位随机打乱，所以**后排（row>=4）只能用整排的兵种构成**，
  //      逐格用会变成负相关（实测地雷 AUC 0.864→0.720）。
  //   ② 先验要回火（FORM_A）并留地板（FORM_EPS）：直接乘会让对数损失从 2.97 飙到 3.43，
  //      过度自信比不准更伤。
  // 默认关：信念精度确实变好（top1 0.303→0.396、炸弹 AUC 0.784→0.913），但棋力是中性甚至微负
  // （24~48 局 A/B 落在噪声内），而且 buildWorld 每步多花 0.31ms、要吃掉搜索深度。
  // 记分方式：JJ_FORM=1 打开。
  const FORM_ON = _ENV.JJ_FORM === "1";
  // beatsProb 是否改用信念分布（JJ_BEAT=0 退回「身份域内均匀计数」的旧口径）
  const BEAT_ON = _ENV.JJ_BEAT !== "0";
  // 吃暗子时用「身份域期望」打分，而不是一律当未知给常数。
  // 第 43 手实锤：东方身份域 = {commander}（100%），旧代码仍只给 +6×attack，
  // 加上后撤惩罚，「炸司令」在 76 个候选里排 69、进不了前 28 的候选池，搜索根本没看见它。
  const BELIEF_PRIOR = _ENV.JJ_BELIEF_PRIOR !== "0";

  // ---- 经验位置先验（从人类棋谱学出来的 P(兵种 | 该子所在格在主人坐标系里的位置)）----
  // 出处：逆向文档 §5.1 的 statfile 思路 + training/probe_pos_prior.py 的实测
  //（留出局 291 万暗子：top1 0.196→0.355、炸弹 AUC 0.82、地雷 0.86）。
  // 它和阵法先验互补：阵法先验要求对手也按那 72 套布阵，人类玩家不满足；这张表不挑对手。
  // 表本身只有 30×12 个数，查一次是常数开销，所以默认开。
  const POS_ON = _ENV.JJ_POS !== "0";
  if (!root.JUNQI_POS_PRIOR && typeof require === "function") {
    try { require("./pos_prior_data.js"); } catch (err) { /* 没有表就退回无先验 */ }
  }
  const POS_TABLE = root.JUNQI_POS_PRIOR || null;
  // 位置先验表的列序是「棋码序」（旗雷炸司军师旅团营连排工），
  // 而 ai.js 的 TYPES 是「战力序」（旗司军师旅团营连排工雷炸）。
  // 之前直接按索引对应，等于把地雷的概率贴给了司令、把工兵贴给了炸弹——
  // 位置先验一直是被打乱的。这里显式按棋码序列取。
  const POS_COLS = ["flag", "mine", "bomb", "commander", "army", "division",
    "brigade", "regiment", "battalion", "company", "platoon", "engineer"];
  let POS_TABLE_OPEN = root.JUNQI_POS_PRIOR_OPEN || null;
  if (!POS_TABLE_OPEN && typeof require === "function") {
    try { require("./pos_prior_open_data.js"); POS_TABLE_OPEN = root.JUNQI_POS_PRIOR_OPEN || null; } catch (e) { POS_TABLE_OPEN = null; }
  }
  // 开局多少手内用「开局专用表」做插值。0 = 完全不用（等价于旧行为）。
  // 全时期表在开局是系统性偏低的：大子早早就离开一线，P(大子|一线格) 被压到 22.0%，
  // 而开局那一帧真实是 29.2%。前 12 手按线性权重从开局表过渡到全时期表。
  const POS_OPEN_PLIES = _num("JJ_POS_OPEN_PLIES", 12);

  // 位置先验该用【初始格】，不是当前格。
  // 离线对照（training/probe_posprior_semantics.py，10 万枚子）：
  //   动过的子：查初始格 NLL 2.217 / top1 17.9%；查当前格 2.793 / 14.4%
  //   用开局表查当前格更糟：top1 只剩 2.6%（几乎是噪声）—— 语义完全错配。
  // 初始格从 moveTape 反推：该子第一次移动的 from 就是它开局站的地方；
  // 从没动过则当前位置就是初始位置。moveTape 被截断时退回当前格（宁可退回，不可乱猜）。
  const INITPOS = new WeakMap();          // state -> Map(pieceId, flatId)
  function initPosOf(state, piece) {
    if (!piece) return null;
    let m = INITPOS.get(state);
    if (!m) { m = new Map(); INITPOS.set(state, m); }
    const hit = m.get(piece.id);
    if (hit !== undefined) return hit;      // null 也是有效结果，用 has 区分更稳妥
    if (m.has(piece.id)) return null;
    // 阵亡子没有 position，但它在 moveTape 里至少要露过一次面：
    //   作为攻方（m.piece）→ 它第一次移动的 from；
    //   作为守方被杀（m.cap）→ 它当时站的 to。
    // 之前这里一句 `if (!piece.position) return null` 把死子全挡在外面，
    // 导致区域账本里「阵亡大子」恒为 0。
    const tape = state.moveTape || [];
    let p = piece.position || null;
    for (let i = 0; i < tape.length; i += 1) {
      const mv = tape[i];
      if (mv.piece === piece.id) { p = mv.from; break; }
      if (mv.cap === piece.id) { p = mv.to; break; }
    }
    m.set(piece.id, p);
    return p;
  }

  function posPriorRow(piece, moveCount) {
    if (!POS_ON || !POS_TABLE || !piece) return null;
    if (!piece.position) return null;
    // piece.__init 由调用方塞入（初始格）；没有就退回当前位置
    const at = piece.__init || piece.position;
    const idx = IDX.get(at);
    if (idx === undefined) return null;
    const node = N[idx];
    if (!node || node.row === undefined || node.col === undefined) return null;
    const k = node.row * 5 + node.col;
    const row = POS_TABLE[k];
    if (!row) return null;
    const open = (POS_TABLE_OPEN && POS_OPEN_PLIES > 0) ? POS_TABLE_OPEN[k] : null;
    const mc = moveCount === undefined ? 0 : moveCount;
    const w = (open && mc < POS_OPEN_PLIES) ? (1 - mc / POS_OPEN_PLIES) : 0;
    const m = new Map();
    let s = 0;
    for (let i = 0; i < POS_COLS.length; i += 1) {
      const v = open ? (row[i] * (1 - w) + open[i] * w) : row[i];
      if (v > 0) { m.set(POS_COLS[i], v); s += v; }
    }
    if (!(s > 0)) return null;
    for (const [t, v] of m) m.set(t, v / s);
    return m;
  }

  // 两个先验相乘（AND 语义）：任一先验没见过的兵种记为极小值，不要直接判 0
  function mulPrior(a, b) {
    if (!a) return b;
    if (!b) return a;
    const m = new Map();
    for (const [t, v] of a) {
      const w = b.get(t);
      m.set(t, v * (w === undefined ? 1e-3 : w));
    }
    return m;
  }
  const FORM_A = (_ENV.JJ_FORM_A !== undefined) ? Number(_ENV.JJ_FORM_A) : 0.5;
  const FORM_EPS = (_ENV.JJ_FORM_EPS !== undefined) ? Number(_ENV.JJ_FORM_EPS) : 0.01;
  const FORM_BOOK = root.JUNQI_FORMATIONS || [];
  const FORM_BACK_IDX = OPENING_CELLS.map(([r], i) => i).filter((i) => OPENING_CELLS[i][0] >= 4);
  const FORM_CELL2IDX = new Map(OPENING_CELLS.map(([r, c], i) => [`${r}-${c}`, i]));

  function originIndexOf(state, pieceId) {
    const org = state.__origin && state.__origin.get(pieceId);
    if (!org) return undefined;
    const m = /^[a-z]+-(\d+)-(\d+)$/.exec(org);
    return m ? FORM_CELL2IDX.get(`${m[1]}-${m[2]}`) : undefined;
  }

  // 开局那一下把 25 枚子的初始格记下来。只有在 moveTape 为空时记的才算数 ——
  // 中途接手（托管）记到的是半局局面，用它当初始格会全错。
  function snapshotOrigins(state) {
    if (state.__origin) return state.__origin;
    if (state.__originBad) return null;
    if (state.moveTape && state.moveTape.length) { state.__originBad = true; return null; }
    const m = new Map();
    for (const p of state.pieces) if (p.position) m.set(p.id, p.position);
    if (m.size < 20) { state.__originBad = true; return null; }
    state.__origin = m;
    return m;
  }

  // A/B 用：同一局里可以让某几家关掉新东西（state.guessOff[seat] = true）
  function guessOff(state, seat) {
    return !!(state && state.guessOff && state.guessOff[seat]);
  }

  // 按手缓存：buildWorld 在搜索里被调用成千上万次，每次都重算后验会把时间预算吃光
  // （实测 buildWorld 0.88ms → 1.44ms，35ms 预算下等于砍掉一截搜索深度，A/B 直接翻车）。
  let FP = { state: null, seat: null, owner: null, key: "", fit: null };

  function formationPosterior(state, seat, owner) {
    if (!FORM_ON || !FORM_BOOK.length) return null;
    if (guessOff(state, seat)) return null;
    const key = (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1);
    if (FP.state === state && FP.seat === seat && FP.owner === owner && FP.key === key) return FP.fit;
    let fit = null;
    let isCustom = false;
    if (snapshotOrigins(state)) {
      const cons = [];
      for (const p of state.pieces) {
        if (p.owner !== owner) continue;
        const i = originIndexOf(state, p.id);
        if (i === undefined) continue;
        // 明牌：现在看得见，或已经在碰撞里亮过（阵亡的子 position 为 null，
        // visibleTo 会返回 false，所以必须额外认 p.revealed）
        if (p.revealed || (p.position && G.visibleTo(state, seat, p))) cons.push([i, p.type]);
      }
      const strict = cons.length
        ? FORM_BOOK.filter((f) => cons.every(([i, t]) => f.layout[i] === t))
        : FORM_BOOK;
      // 明牌跟 72 套全矛盾 ⇒ 对手不是按阵法库布的（人类/自定义）。这时阵法先验无效，
      // 而「经验位置先验」（从人类棋谱学的那张 30×12 表）才有意义。
      isCustom = cons.length > 0 && strict.length === 0;
      fit = strict.length ? strict : FORM_BOOK;
    }
    // 顺手把 25 个格位的先验分布一次性算好（每手每家只算一次）
    const rows = new Map();
    if (fit && fit.length) {
      const backHist = new Map();
      let backDen = 0;
      for (const f of fit) {
        for (const j of FORM_BACK_IDX) {
          backHist.set(f.layout[j], (backHist.get(f.layout[j]) || 0) + 1);
          backDen += 1;
        }
      }
      const backRow = new Map();
      for (const [t, c] of backHist) backRow.set(t, c / backDen);
      for (const j of FORM_BACK_IDX) rows.set(j, backRow);      // 后排只用整排构成
      for (let i = 0; i < OPENING_CELLS.length; i += 1) {
        if (rows.has(i)) continue;
        const h = new Map();
        for (const f of fit) h.set(f.layout[i], (h.get(f.layout[i]) || 0) + 1);
        const row = new Map();
        for (const [t, c] of h) row.set(t, c / fit.length);
        rows.set(i, row);
      }
    }
    FP = { state: state, seat: seat, owner: owner, key: key, fit: fit, rows: rows, isCustom: isCustom };
    return fit;
  }

  // 该子在「兼容阵法」里的兵种分布（取自上面那次按手缓存）
  function formationPriorRow(state, owner, pieceId) {
    const i = originIndexOf(state, pieceId);
    if (i === undefined) return null;
    if (FP.state !== state || FP.owner !== owner) return null;
    return FP.rows ? (FP.rows.get(i) || null) : null;
  }

  // 信念分布 × 先验^FORM_A，再与支撑集上的均匀分布混一点地板
  function applyPrior(row, prior) {
    if (!prior || !row) return row;
    let s = 0;
    const out = new Map();
    for (const [t, w] of row) {
      const p = Math.pow(Math.max(prior.get(t) || 0, 1e-4), FORM_A);
      const v = w * p;
      out.set(t, v);
      s += v;
    }
    if (!(s > 0)) return row;
    const n = out.size || 1;
    for (const [t, v] of out) out.set(t, (1 - FORM_EPS) * (v / s) + FORM_EPS / n);
    return out;
  }

  // 真值盘面：结构与 buildWorld 输出一致，只是兵种取真实值。
  // 只用于诊断脚本，正常对局不会走到（JJ_ORACLE=1 才开）。
  function buildWorldTruth(state, seat) {
    const alive = state.pieces.filter((p) => p.position);
    if (!alive.length) return null;
    const activeSeats = B.SEATS.filter((s) => !state.out[s] && alive.some((p) => p.owner === s));
    if (!activeSeats.length) return null;
    const out = new Set(B.SEATS.filter((s) => state.out[s]));
    for (const s of B.SEATS) if (!activeSeats.includes(s)) out.add(s);
    const turn = activeSeats.includes(seat) ? seat : activeSeats[0];
    const world = {
      pieces: alive.map((p) => ({
        id: p.id, owner: p.owner, type: p.type,
        pos: IDX.get(p.position), moved: !!p.moved,
      })),
      activeSeats, out, turn, mode: state.mode,
      lastTarget: state.lastMove ? IDX.get(state.lastMove.to) : -1,
    };
    world.hash = hashState(world);
    return world;
  }

  function buildWorld(state, seat, knownDomains) {
    // 按座位开天眼：给「天眼到底能带来多少胜率」这种对照用（全局 ORACLE 只能四家全开）
    if (ORACLE || (state.oracleSeats && state.oracleSeats[seat])) return buildWorldTruth(state, seat);
    const domains = knownDomains || inferDomains(state, seat);
    const all = state.pieces.map((p) => {
      const lat = ownLatentDomain(state, seat, p);
      return {
        // 暗牌子：type 置空，让它和「敌方暗子」走同一条抽样路径
        //（否则世界会以为它是工兵，子力评估、工兵走法、兑子期望全是错的）
        id: p.id, owner: p.owner, type: lat ? null : (p.type || null),
        pos: p.position ? IDX.get(p.position) : -1,
        org: originIndexOf(state, p.id),      // 阵法先验用：这枚子开局在哪一格
        moved: !!p.moved,
        known: G.visibleTo(state, seat, p),
        latent: !!lat,
      };
    });
    for (const owner of B.SEATS) {
      const pool = standardPool();
      const own = all.filter((p) => p.owner === owner);
      for (const p of own) {
        if (!p.known || !p.type) continue;
        if (pool[p.type] > 0) pool[p.type] -= 1;
      }
      const unknown = own.filter((p) => !p.known || !p.type);
      if (!unknown.length) continue;
      // 抽样先验直接用 25×12 矩阵的行分布（含位置先验 × 阵法先验，并吃过配额消元
      // 与死子域重建）。旧版这里只塞了阵法先验，等于把推理成果丢在搜索门口。
      const wp = worldPriors(state, seat, owner, domains);
      const mxW = wp.mx;
      const logPriors = wp.logPriors;
      let assigned = null;
      if (LAP_MARG && mxW) {
        assigned = assignTypesMarginal(unknown, domains, logPriors);
      }
      if (!assigned && WORLD_LAP && mxW) {
        if (LAP_BASE) {
          const base = lapBaseCached(state, seat, owner, unknown, pool, domains, logPriors);
          if (base) assigned = swapSample(base, unknown, domains, logPriors, LAP_SWAPS);
        } else {
          assigned = assignTypesLAP(unknown, pool, domains, logPriors);
        }
      }
      if (!assigned) assigned = assignTypes(unknown, pool, domains, logPriors);
      if (!assigned) {
        // 域整体不可满足（记忆把某些配额顶死了，例如 4 枚子被压成工兵而工兵只有 3 枚）：
        // 放宽回初始域兜底，宁可这一次抽样粗一点，也不要整步没有世界可用
        const relaxed = new Map();
        for (const p of own) relaxed.set(p.id, initialDomain({ pos: p.pos, moved: p.moved }));
        assigned = assignTypes(unknown, pool, relaxed, logPriors);
        if (!assigned) return null;
      }
      for (const p of unknown) p.type = assigned.get(p.id);
      // 期望价值 E[VALUES]：优先用「这一步的信念行」（含 ①b / 联合后验 / 软证据），
      // 拿不到再退回世界先验 logPriors。**它跟世界抽样是两回事**：
      // 抽样可以保持均匀（矩阵关），而评估照样按分布算期望。
      if (EVAL_EV && !(state.evEvalOff && state.evEvalOff[seat])) {
        const src = state.__evRows || null;
        const lp = wp && wp.logPriors;
        for (const p of own) {
          const row = src ? src.get(p.id) : null;
          if (row && row.size) {
            let sum = 0, ws = 0;
            for (const [t, w] of row) {
              if (!(w > 0)) continue;
              sum += w * (VALUES[t] || 10);
              ws += w;
            }
            if (ws > 0) { p.ev = sum / ws; continue; }
          }
          const lrow = lp && lp.get(p.id);
          if (!lrow) continue;
          let sum = 0, ws = 0;
          for (const [t, lv] of lrow) {
            const w = Math.exp(lv);
            if (!(w > 0)) continue;
            sum += w * (VALUES[t] || 10);
            ws += w;
          }
          if (ws > 0) p.ev = sum / ws;
        }
      }
    }
    const alive = all.filter((p) => p.pos >= 0 && p.type);
    const activeSeats = B.SEATS.filter((s) => !state.out[s] && alive.some((p) => p.owner === s));
    if (!activeSeats.length) return null;
    const out = new Set(B.SEATS.filter((s) => state.out[s]));
    for (const s of B.SEATS) if (!activeSeats.includes(s)) out.add(s);
    const turn = activeSeats.includes(seat) ? seat : activeSeats[0];
    const world = {
      pieces: alive.map((p) => ({
        id: p.id, owner: p.owner, type: p.type, pos: p.pos, moved: p.moved,
        // 抽出来的 type 只用于「怎么走、值多少」；暗牌子临战还能改判身份，
        // 所以把 latent / domain 一起带进世界，交给 simulate 现算。
        latent: !!p.latent, domain: p.latent ? p.domain : null,
        ev: p.ev,
      })),
      activeSeats, out, turn, mode: state.mode,
      latentSeats: state.latentSeats || null,
      lastTarget: state.lastMove ? IDX.get(state.lastMove.to) : -1,
    };
    world.hash = hashState(world);
    return world;
  }

  function occupancy(state) {
    const board = new Array(N.length).fill(null);
    for (const p of state.pieces) board[p.pos] = p;
    return board;
  }

  function generateMoves(state) {
    const seat = state.turn;
    const board = occupancy(state);
    const moves = [];
    for (const p of state.pieces) {
      if (p.owner !== seat || B.PIECE_INFO[p.type].immobile) continue;
      if (N[p.pos].kind === "hq") continue;
      const dest = new Set();
      for (const j of ROADS[p.pos]) {
        const d = board[j];
        if (d) {
          if (!ally(seat, d.owner) && N[j].kind !== "camp") dest.add(j);
        } else {
          dest.add(j);
        }
      }
      if (p.type === "engineer") {
        const queue = [p.pos];
        const seen = new Set(queue);
        for (let head = 0; head < queue.length; head += 1) {
          for (const next of RAILS[queue[head]]) {
            if (seen.has(next)) continue;
            seen.add(next);
            const d = board[next];
            if (d) {
              if (!ally(seat, d.owner) && N[next].kind !== "camp") dest.add(next);
              continue;
            }
            dest.add(next);
            queue.push(next);
          }
        }
      } else {
        for (const line of THROUGH[p.pos]) {
          const at = line.indexOf(p.pos);
          for (const dir of [-1, 1]) {
            for (let j = at + dir; j >= 0 && j < line.length; j += dir) {
              const next = line[j];
              const d = board[next];
              if (d) {
                if (!ally(seat, d.owner) && N[next].kind !== "camp") dest.add(next);
                break;
              }
              dest.add(next);
            }
          }
        }
      }
      for (const dst of dest) {
        const d = board[dst];
        if (d && (ally(seat, d.owner) || N[dst].kind === "camp")) continue;
        moves.push({
          from: N[p.pos].id, to: N[dst].id, src: p.pos, dst,
          attacker: p, defender: d,
        });
      }
    }
    return moves;
  }

  // resolveBattle 只取决于 (攻方类型, 守方类型, 是否攻营, 模式)——乱战模式每步要算几十万次
  const BATTLE_MEMO = new Map();
  function battleOutcome(attType, defType, inHq, mode) {
    const k = attType + "|" + defType + "|" + (inHq ? 1 : 0) + "|" + mode;
    let v = BATTLE_MEMO.get(k);
    if (v === undefined) {
      v = G.resolveBattle({ type: attType }, { type: defType }, inHq, mode);
      BATTLE_MEMO.set(k, v);
    }
    return v;
  }

  // state.out 在真实局面里是对象、在世界里是 Set，统一判断
  function seatOut(state, seat) {
    if (!state || !state.out) return false;
    if (typeof state.out.has === "function") return state.out.has(seat);
    return !!state.out[seat];
  }

  // 防「一子在两点来回摆」：必须按**棋子**记最近走法。
  // 早先按座位记，同一座位中间走过别的子就会被覆盖，导致折返漏检。
  const lastMoveByPiece = new Map();   // pieceId -> { from, to, at }
  const pieceTrail = new Map();        // pieceId -> [{ pos, at }] 最近 8 次落点
  let lastSeenMoveCount = -1;
  function syncRecentMoves(state) {
    if (!state) return;
    if (state.moveCount < lastSeenMoveCount) {
      lastMoveByPiece.clear();
      pieceTrail.clear();
    }
    if (state.moveCount === lastSeenMoveCount) return;
    lastSeenMoveCount = state.moveCount;
    const lm = state.lastMove;
    if (!lm) return;
    const mv = G.pieceAt(state, lm.to);
    if (!mv) return;
    lastMoveByPiece.set(mv.id, { from: lm.from, to: lm.to, at: state.moveCount });
    const arr = pieceTrail.get(mv.id) || [];
    arr.push({ pos: lm.to, at: state.moveCount });
    while (arr.length > 8) arr.shift();
    pieceTrail.set(mv.id, arr);
  }

  // 这枚子刚走过去、现在原路走回来：纯空走、无战损，必然无意义
  function isBacktrack(state, move) {
    const a = G.pieceAt(state, move.from);
    if (!a) return false;
    const last = lastMoveByPiece.get(a.id);
    if (!last) return false;
    return last.from === move.to && last.to === move.from;
  }

  // 这枚子最近 8 步内到过目标格（小范围循环）
  function isRevisit(state, move) {
    const a = G.pieceAt(state, move.from);
    if (!a) return false;
    const arr = pieceTrail.get(a.id) || [];
    return arr.some((t) => t.pos === move.to && state.moveCount - t.at <= 8);
  }

  function nextTurn(state) {
    const start = G.TURN_ORDER.indexOf(state.turn);
    for (let i = 1; i <= G.TURN_ORDER.length; i += 1) {
      const s = G.TURN_ORDER[(start + i) % G.TURN_ORDER.length];
      if (state.out.has(s)) continue;
      if (state.pieces.some((p) => p.owner === s)) return s;
    }
    return state.turn;
  }

  // 天命暗牌：作战时**由系统按对手身份挑一个最优身份**（game.js::chooseLatentType 就是这么做的，
  // 它拿得到 enemyType）。搜索里如果还按"棋盘上显示的那个最小身份"结算，就会以为自己是工兵，
  // 于是不敢打、乱送 —— 这就是 AI 不会玩暗牌的根因。
  // 这里在世界内复刻一遍选型规则：能赢选最小能赢的，其次同尽（优先非炸弹），最后炸弹。
  function latentPickType(a, enemyType, inHq, mode) {
    if (!a || !a.latent || !a.domain || !a.domain.size) return a.type;
    let win = null, tie = null, tieBomb = null;
    for (const t of a.domain) {
      const o = battleOutcome(t, enemyType, inHq, mode);
      const r = RANK_NUM[t] || 0;
      if (o === "attacker") {
        if (!win || r < (RANK_NUM[win] || 0)) win = t;
      } else if (o === "both") {
        if (t === "bomb") { if (!tieBomb) tieBomb = t; }
        else if (!tie || r < (RANK_NUM[tie] || 0)) tie = t;
      }
    }
    return win || tie || tieBomb || a.type;
  }

  function simulate(state, move) {
    const a = Object.assign({}, move.attacker);
    const d = move.defender ? Object.assign({}, move.defender) : null;
    const inHq = state.mode === "chaos" && N[move.dst].kind === "hq" && N[move.dst].seat !== a.owner;
    // 我方（或队友）的暗牌子在这一战里会"变成"哪个身份，按游戏规则现算
    const latentPickOn = _ENV.JJ_LATENT_PICK !== "0";
    if (d && latentPickOn && a.latent && state.latentSeats && state.latentSeats[a.owner]) {
      const pick = latentPickType(a, d.type, inHq, state.mode);
      if (pick !== a.type) { a.type = pick; a.actualType = pick; a.latent = false; }
    }
    // 守方也是暗牌子时，它同样会「临战挑一个能赢/同尽的身份」（game.js 里攻方先选、守方后选）。
    // 漏了这条，搜索会以为自己的子只能被动挨打，防守价值被系统性低估。
    if (d && latentPickOn && d.latent && state.latentSeats && state.latentSeats[d.owner]) {
      const pick = latentPickType(d, a.type, inHq, state.mode);
      if (pick !== d.type) { d.type = pick; d.actualType = pick; d.latent = false; }
    }
    const outcome = d ? battleOutcome(a.type, d.type, inHq, state.mode) : "move";
    let out = new Set(state.out);
    let pieces = state.pieces.filter((p) => p !== move.attacker && p !== move.defender);
    if (d && d.type === "flag" && (outcome === "attacker" || outcome === "both")) {
      out.add(d.owner);
      pieces = pieces.filter((p) => p.owner !== d.owner);
    }
    if (outcome === "attacker" || outcome === "move") {
      a.pos = move.dst;
      pieces.push(a);
    } else if (outcome === "defender") {
      pieces.push(d);
    }
    const child = {
      pieces, out, mode: state.mode, lastTarget: move.dst,
      // 暗牌规则要一路传下去：子节点丢了 latentSeats，搜索就只在第 1 层会「临战选型」
      latentSeats: state.latentSeats || null,
      activeSeats: state.activeSeats, turn: nextTurn({ ...state, pieces, out }),
      // 这一步是不是「吃子」——捕获延伸只在吃子后触发，不然每个叶节点都要展开，节点数会炸。
      lastCapture: !!(d && outcome !== "move"),
      // 这一口的「金额」（攻守双方取大）：小子互换不需要延伸，评估本来就准；
      // 只有大额交换（旅以上）才值得停下来算反吃。QS_MIN 就是这条闸门。
      lastCapVal: d ? Math.max(VALUES[a.type] || 0, VALUES[d.type] || 0) : 0,
      // 这一口是谁吃的（用于区分「我撞它」和「它撞我」两条回本路径）
      lastCapBy: d ? a.owner : null,
    };
    child.hash = hashState(child);
    return child;
  }

  // 我方（含队友）里「敌人看不见」的那些子。敌人看得见的（已亮明）是公开信息，不置换。
  // 只依赖根局面，所以每次 choose 算一次就够。
  function hiddenIdsOf(state, seat) {
    const myTeam = B.teamOf(seat);
    const enemies = B.SEATS.filter((x) => B.teamOf(x) !== myTeam);
    const ids = [];
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (B.teamOf(p.owner) !== myTeam) continue;
      let seen = false;
      for (const e of enemies) {
        try { if (G.visibleTo(state, e, p)) { seen = true; break; } } catch (err) { seen = false; }
      }
      if (!seen) ids.push(p.id);
    }
    return ids;
  }

  // 每个世界重新洗一次：对手只知道我们剩哪些兵种（数得出来），不知道哪枚是哪枚。
  // 置换不改变双方子力总数，只剥掉「总能精准避开大子 / 用炸弹拦司令」这种透视。
  function makeMaskView(ids, truth) {
    if (!ids.length || !truth) return null;
    const types = ids.map((id) => truth.get(id));
    for (let i = types.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = types[i]; types[i] = types[j]; types[j] = t;
    }
    const view = new Map(truth);
    ids.forEach((id, i) => view.set(id, types[i]));
    return view;
  }

  // 就地套用视图（view 为 null 表示「按真值还原」），返回可还原的存档。
  // 敢就地改：搜索是深度优先、同步的，进节点套、出节点还原，同一时刻只有一个视图生效。
  // 必须重算 hash，否则同一局面在置换前后会撞进同一个置换表条目。
  function applyView(state, view, truth) {
    if (!truth) return null;
    const saved = [];
    let changed = false;
    for (const p of state.pieces) {
      if (!p.position) continue;
      const want = (view && view.has(p.id)) ? view.get(p.id) : truth.get(p.id);
      if (want === undefined || want === p.type) continue;
      saved.push([p, p.type]);
      p.type = want;
      changed = true;
    }
    if (!changed) return null;
    state.hash = hashState(state);
    return saved;
  }

  function restoreView(saved) {
    if (!saved) return;
    for (const [p, t] of saved) p.type = t;
  }

  function terminal(state, rootSeat) {
    const living = new Set(state.pieces.map((p) => p.owner));
    if (![...living].some((s) => ally(s, rootSeat))) return -1e6;
    if (![...living].some((s) => !ally(s, rootSeat))) return 1e6;
    return null;
  }

  function evaluate(state, rootSeat, profile) {
    const end = terminal(state, rootSeat);
    if (end !== null) return end;
    const P = profile || PROFILES.forest;
    if (CAMP_ESC) {
      _occTick += 1;
      for (const p of state.pieces) if (p.pos >= 0) _occVer[p.pos] = _occTick;
    }
    const flags = state.pieces.filter((p) => p.type === "flag");
    let score = 0;
    let domOwn = 0, domFoe = 0;      // 双方令子等级（存活的最大可动棋子）
    const guards = GUARD_IDX[rootSeat] || [];   // 己方两个守旗位
    let guardOwned = 0;
    for (const p of state.pieces) {
      const sign = ally(p.owner, rootSeat) ? 1 : -1;
      const dr = DOM_RANK[p.type] || 0;
      if (dr > 0) {
        if (sign > 0) { if (dr > domOwn) domOwn = dr; }
        else if (dr > domFoe) domFoe = dr;
      }
      const n = N[p.pos];
      const baseVal = (p.ev !== undefined && p.ev !== null) ? p.ev : (VALUES[p.type] || 10);
      let v = baseVal * P.material;
      if (p.type === "bomb") v *= P.bomb;
      else if (p.type === "mine") v *= P.mine;
      if (n.kind === "hq" && !B.PIECE_INFO[p.type].immobile) v *= P.hqPenalty;
      if (n.kind === "hq" && n.seat && n.seat !== p.owner) v *= 0.05;   // 敌方大本营：进去就再也动不了
      if (!B.PIECE_INFO[p.type].immobile && n.kind !== "hq") {
        if (n.kind === "camp") v += P.camp;
        if (CAMP_ESC) {
          let esc = 0;
          for (const nb of ROADS[p.pos]) {
            if (N[nb].kind === "camp" && _occVer[nb] !== _occTick) esc += 1;   // 空营才退得进去
          }
          if (esc) v += CAMP_ESC * esc * baseVal / 100;
        }
        if (RAILS[p.pos].length) v += P.rail * (p.type === "engineer" ? 1.5 : 0.5);
        const enemyFlags = flags.filter((f) => !ally(p.owner, f.owner));
        if (enemyFlags.length) {
          v += Math.max(0, 20 - Math.min(...enemyFlags.map((f) => dist(p.pos, f.pos)))) * P.flagAttack * 0.9;
        }
        const ownFlags = flags.filter((f) => ally(p.owner, f.owner));
        if (p.type !== "bomb" && ownFlags.some((f) => dist(p.pos, f.pos) <= 2)) v += P.flagDefense * 3;
      }
      // 守旗位：己方子站在大本营正前方，行营里的敌子就无法下来夺旗
      if (sign > 0 && guards.indexOf(p.pos) >= 0) guardOwned += 1;
      // 令子直取：我方 37+ 站在敌方大本营的角格上，等于一步掐住两个入口
      if (sign > 0 && (DOM_RANK[p.type] || 0) >= 37 && p.type !== "bomb") {
        for (const s2 of B.SEATS) {
          if (ally(s2, rootSeat)) continue;
          if (BASE_CORNERS[s2] && BASE_CORNERS[s2].has(p.pos)) { v += CORNER_BONUS; break; }
        }
      }
      score += sign * v;
    }
    // 守旗位缺位才扣分：开局两个位都有子 → 不扣，子可以自由调动；
    // 一旦空出来 → 扣分，促使补位。比「有子加分」温和，不会把后场钉死。
    score -= (guards.length - guardOwned) * GUARD_BONUS * P.flagDefense;
    // 令子差：控制权溢价。子力项已经算了「少了哪个子」，这一项算的是「还有没有令子」。
    score += (domOwn - domFoe) * DOMINANT_GAP;
    return score;
  }

  function orderMoves(moves, state, profile) {
    const P = profile || PROFILES.forest;
    const enemyFlags = state.pieces.filter((p) => p.type === "flag" && !ally(p.owner, state.turn));
    const targetDist = (pos) => enemyFlags.length
      ? Math.min(...enemyFlags.map((f) => dist(pos, f.pos))) : 0;
    return moves.map((move) => {
      let score = 0;
      const a = move.attacker, d = move.defender;
      if (d) {
        if (d.type === "flag") score += 1000000;
        const inHq = state.mode === "chaos" && N[move.dst].kind === "hq" && N[move.dst].seat !== a.owner;
        const outcome = battleOutcome(a.type, d.type, inHq, state.mode);
        if (outcome === "attacker") score += VALUES[d.type] * P.attack;
        else if (outcome === "both") score += (VALUES[d.type] - VALUES[a.type]) * P.attack;
        else score -= VALUES[a.type];
        score += 5 * P.attack;
      }
      if (enemyFlags.length) {
        const delta = targetDist(move.src) - targetDist(move.dst);
        score += 4 * P.flagAttack * delta;
        if (!d && delta < 0) score -= 4;          // 空走还往回缩，搜索里也不优先
      }
      if (N[move.dst].kind === "camp") score += P.camp * 0.7;
      if (N[move.dst].kind === "hq" && !(d && d.type === "flag")) {
        const hqSeat = N[move.dst].seat;
        if (hqSeat !== a.owner) {
          if (seatOut(state, hqSeat)) score -= 600;    // 该方已出局，进它的大本营纯属浪费步数
          else if (!d) score -= 500;                   // 空 hq 必然无旗，进去=废子
          else score -= VALUES[a.type] * P.hqPenalty * 4;
        }
      }
      return { move, score };
    }).sort((a, b) => b.score - a.score).map((x) => x.move);
  }

  const SEARCH_STATS = { nodes: 0, evals: 0, worlds: 0 };
  // 只生成吃子走法（qsearch 专用）。
  // 不用 generateMoves + filter：那个会枚举全盘所有走法（100+ 手）只为取 4~6 个吃子，
  // 实测叶层级这么干会让 qNodes 涨到主搜索的 2.5 倍，挤掉采样世界数。
  function generateCaptures(state) {
    const seat = state.turn;
    const board = occupancy(state);
    const moves = [];
    for (const p of state.pieces) {
      if (p.owner !== seat || B.PIECE_INFO[p.type].immobile) continue;
      if (N[p.pos].kind === "hq") continue;
      const dest = new Set();
      for (const j of ROADS[p.pos]) {
        const d = board[j];
        if (d && !ally(seat, d.owner) && N[j].kind !== "camp") dest.add(j);
      }
      if (p.type === "engineer") {
        const queue = [p.pos];
        const seen = new Set(queue);
        for (let head = 0; head < queue.length; head += 1) {
          for (const next of RAILS[queue[head]]) {
            if (seen.has(next)) continue;
            seen.add(next);
            const d = board[next];
            if (d) {
              if (!ally(seat, d.owner) && N[next].kind !== "camp") dest.add(next);
              continue;
            }
            queue.push(next);
          }
        }
      } else {
        for (const line of THROUGH[p.pos]) {
          const at = line.indexOf(p.pos);
          for (const dir of [-1, 1]) {
            for (let j = at + dir; j >= 0 && j < line.length; j += dir) {
              const next = line[j];
              const d = board[next];
              if (d) {
                if (!ally(seat, d.owner) && N[next].kind !== "camp") dest.add(next);
                break;
              }
            }
          }
        }
      }
      for (const dst of dest) {
        const d = board[dst];
        if (!d) continue;                    // 只留吃子
        moves.push({ from: N[p.pos].id, to: N[dst].id, src: p.pos, dst, attacker: p, defender: d });
      }
    }
    return moves;
  }

  // 吃子排序用「守方价值 − 攻方价值」，不走 orderMoves（那边每次都要重新捡军旗、算旗距）。
  // 关键：炸司令(135−65=70) 会排在吃小子(18−135=−117) 前面，
  // 所以「被吃就炸回去」这条一定进得了 qsearch 的宽度窗口。
  function capOrder(m) {
    if (m.defender.type === "flag") return 1e6;
    return (VALUES[m.defender.type] || 10) - (VALUES[m.attacker.type] || 10);
  }

  // 静态捕获延伸（quiescence）：叶节点如果刚发生吃子，不许停。
  // 只展开「吃子」这一种走法，宽度 QS_WIDTH、层数 QS_MAX，所以代价可控。
  // 少了它，「送一个师长 → 它吃 → 我炸」这条链在第 2 步就被 evaluate 截断，
  // 搜索只看到 −75，看不到后面的 +70，AI 就永远不敢把带炸的诱饵递上去。
  function qsearch(state, alpha, beta, deadline, rootSeat, ply, profile, depthLeft) {
    TAC_STATS.qNodes += 1;
    if (Date.now() >= deadline) throw TIMEOUT;
    const end = terminal(state, rootSeat);
    if (end !== null) return end + (end > 0 ? -ply : ply);
    const maximize = ally(rootSeat, state.turn);
    let best = evaluate(state, rootSeat, profile);
    if (maximize) {
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    } else {
      if (best <= alpha) return best;
      if (best < beta) beta = best;
    }
    if (depthLeft <= 0) return best;
    let caps = generateCaptures(state);
    if (!caps.length) return best;
    caps.sort((x, y) => capOrder(y) - capOrder(x));
    if (caps.length > QS_WIDTH) caps = caps.slice(0, QS_WIDTH);
    for (const mv of caps) {
      const sc = qsearch(simulate(state, mv), alpha, beta, deadline, rootSeat, ply + 1, profile, depthLeft - 1);
      if (maximize) {
        if (sc > best) best = sc;
        if (best > alpha) alpha = best;
      } else {
        if (sc < best) best = sc;
        if (best < beta) beta = best;
      }
      if (beta <= alpha) break;
    }
    return best;
  }

  // forceQs：只对「先予后取」的验证分支打开捕获延伸（见 choose 里的 verifyMoves）。
  // 为什么不干脆把深度 +2：全宽 +2 层是 64 倍节点，而且「后手回本」只可能通过吃子发生，
  // 用吃子链延伸既精准又不改变主搜索深度 —— 分数仍然可比，不会因为「搜得深所以分高」而误选。
  function search(state, depth, alpha, beta, deadline, rootSeat, ply, tt, profile, forceQs) {
    SEARCH_STATS.nodes += 1;
    // 轮到谁走，就用谁的信息视角：我方节点看真值，敌方节点看我方「置换后」的暗牌。
    // 不做这一步，树里的对手就是全知的——它会精准避开我们的司令、用炸弹专挑大子，
    // 于是我们对「进攻」的估值系统性偏低（strategy fusion）。
    const savedView = (MASK_OPP && TRUTH_VIEW)
      ? applyView(state, ally(rootSeat, state.turn) ? null : MASK_VIEW, TRUTH_VIEW)
      : null;
    try {
    if (Date.now() >= deadline) throw TIMEOUT;
    const end = terminal(state, rootSeat);
    if (end !== null) return end + (end > 0 ? -ply : ply);
    if (depth <= 0) {
      // 叶节点停在吃子上 = 交换还没算完，必须继续看反吃，否则「弃子跟炸」永远是负分。
      // 三条路都要能「看到回本」：
      //   ① QS_ON：全局开关（默认关，太贵）
      //   ② forceQs：「我主动撞」的验证分支
      //   ③ QS_DEF：这一口是**敌方**吃的（它撞上来），我也要能算「随后炸回」
      const enemyAte = QS_DEF && state.lastCapture
        && state.lastCapBy !== null && state.lastCapBy !== undefined
        && !ally(rootSeat, state.lastCapBy);
      if ((QS_ON || forceQs || enemyAte) && state.lastCapture
          && (forceQs || enemyAte || (state.lastCapVal || 0) >= QS_MIN)) {
        TAC_STATS.qLeafCap += 1;
        return qsearch(state, alpha, beta, deadline, rootSeat, ply, profile, QS_MAX);
      }
      return evaluate(state, rootSeat, profile);
    }
    const alphaOrig = alpha, betaOrig = beta;
    const cached = tt.get(state.hash);
    if (cached && cached.depth >= depth) {
      if (cached.flag === "exact") return cached.value;
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.value);
      else if (cached.flag === "upper") beta = Math.min(beta, cached.value);
      if (alpha >= beta) return cached.value;
    }
    let moves = generateMoves(state);
    if (!moves.length) {
      const out = new Set(state.out);
      out.add(state.turn);
      const pieces = state.pieces.filter((p) => p.owner !== state.turn);
      const next = { ...state, pieces, out, turn: nextTurn({ ...state, pieces, out }) };
      next.hash = hashState(next);
      return search(next, depth - 1, alpha, beta, deadline, rootSeat, ply + 1, tt, profile);
    }
    const maximize = ally(rootSeat, state.turn);
    const width = depth >= 3 ? 10 : 8;
    moves = orderMoves(moves, state, profile).slice(0, width);
    let best = maximize ? -Infinity : Infinity;
    for (const move of moves) {
      const score = search(simulate(state, move), depth - 1, alpha, beta, deadline, rootSeat, ply + 1, tt, profile, forceQs);
      if (maximize) {
        best = Math.max(best, score);
        alpha = Math.max(alpha, best);
      } else {
        best = Math.min(best, score);
        beta = Math.min(beta, best);
      }
      if (beta <= alpha) break;
    }
    if (tt.size > 120000) tt.clear();
    let flag = "exact";
    if (best <= alphaOrig) flag = "upper";
    else if (best >= betaOrig) flag = "lower";
    tt.set(state.hash, { depth, value: best, flag });
    return best;
    } finally {
      restoreView(savedView);
    }
  }

  // ---------- 军旗威胁 ----------
  // 旗被敌方一步可及 = 下一步就输。这类局面必须优先解围，
  // 除非明知道打不过/挡不住（用户口径：明确吃不过/炸不掉才走其他）。
  const FLAG_STATS = { threatened: 0, rescued: 0, helpless: 0, emptyHqAvoided: 0, riskBase: 0 };

  // 大本营**只在公路网上**（3 个邻居、铁路邻居 0），所以「一步能挖旗」等价于
  // 「敌方可动子占住了旗的某个公路邻居」——精确、O(1) 判定，不需要跑 legalTargets。
  // （注意 G.legalTargets 有 state.turn !== seat 就返回空的前置，本来就不能用来问对手的走法。）
  function flagThreats(state, seat) {
    const out = [];
    const myFlags = state.pieces.filter((p) => p.position && p.type === "flag" && ally(p.owner, seat));
    if (!myFlags.length) return out;
    for (let fi = 0; fi < myFlags.length; fi += 1) {
      const f = myFlags[fi];
      const nbrs = B.BOARD.neighbors.get(f.position);
      if (!nbrs || !nbrs.length) continue;
      const near = new Set(nbrs);
      for (let i = 0; i < state.pieces.length; i += 1) {
        const e = state.pieces[i];
        if (!e.position || ally(e.owner, seat)) continue;
        // ⚠ 原来这里直接读 e.type 判断「地雷/军旗不能动」——那是敌方真实兵种，
        //   等于 AI 明知道哪枚是雷、于是不把它算成威胁。要按真人环境算：
        //   只有**已亮明**的才按真值排除；暗子一律当威胁。
        //   标准模式下敌方的雷在自己半场，本来就不可能站在我旗的邻格，所以这样做不会误判。
        const seenE = G.visibleTo(state, seat, e);
        if (seenE) {
          const info = B.PIECE_INFO[e.type];
          if (info && info.immobile) continue;
        }
        if (near.has(e.position)) out.push({ flag: f, enemy: e });
      }
    }
    return out;
  }

  // 唯一有效的解围是「吃掉威胁者」（炸弹同归于尽也算）。
  // 站到旗边没有用：大本营有 3 个公路入口，堵一个挡不住。
  function isThreatRelief(state, seat, move, threats) {
    const a = G.pieceAt(state, move.from);
    if (!a) return false;
    for (let i = 0; i < threats.length; i += 1) {
      const t = threats[i];
      if (t.enemy.position !== move.to) continue;
      // 打威胁者：已知且打不过就不算解围（明确吃不过才走其他）
      if (!G.visibleTo(state, seat, t.enemy)) return true;
      const o = battleOutcome(a.type, t.enemy.type, false, state.mode);
      if (o === "attacker" || o === "both") return true;
    }
    return false;
  }

  // 走这一步离「敌方大本营」近了几个曼哈顿格（>0 表示推进）
  function advanceDelta(state, seat, move) {
    const to = B.BOARD.byId.get(move.to);
    const from = B.BOARD.byId.get(move.from);
    if (!to || !from) return { delta: 0 };
    const enemies = B.SEATS.filter((s) => s !== seat && !ally(s, seat) && !state.out[s]);
    let oldD = 99, newD = 99;
    for (const e of enemies) {
      for (const hq of B.hqCells(e)) {
        const n = B.BOARD.byId.get(hq);
        oldD = Math.min(oldD, Math.abs(from.x - n.x) + Math.abs(from.y - n.y));
        newD = Math.min(newD, Math.abs(to.x - n.x) + Math.abs(to.y - n.y));
      }
    }
    if (oldD >= 99) return { delta: 0 };
    return { oldD, newD, delta: oldD - newD };
  }

  // 等级（用于「已知对方更大就别撞」）——RANK_NUM 定义见文件上方的子力记忆模块。

  // 这个目标子的等级下界：记忆里的 lo，与身份域里的**最小**等级，取较大者。
  // 注意是 min 不是 max——域里最大那枚（常常是司令）跟"至少要多大"没有关系。
  function knownFloor(mem, domains, id) {
    let floor = (mem && mem.lo.get(id)) || 0;
    const dd = domains && domains.get(id);
    if (dd && dd.size && dd.size < 11) {
      let minR = 99;
      for (const t of dd) {
        const r = RANK_NUM[t] || 0;
        if (r && r < minR) minR = r;
      }
      if (minR < 99 && minR > floor) floor = minR;
    }
    return floor;
  }

  // 往「没有旗的大本营」里钻：对方已出局 / 营是空的 / 已知它的旗在另一个营
  function isUselessHqMove(state, seat, move) {
    const to = B.BOARD.byId.get(move.to);
    if (!to || to.kind !== "hq" || !to.seat) return false;
    if (to.seat === seat || ally(to.seat, seat)) return false;
    if (seatOut(state, to.seat)) return true;
    const d = G.pieceAt(state, move.to);
    if (!d) return true;
    if (d.type === "flag") return false;
    return state.pieces.some((p) => p.owner === to.seat && p.type === "flag"
      && p.position && G.visibleTo(state, seat, p));
  }

  // 工兵保存（跨河）：前 ENG_HOLD 手内，不许工兵「飞过河去敌人家后院」——
  // 除非 ① 这一手是吃子（有明确目标，比如已确认的雷）② 敌方军旗位置已知（去挖旗）。
  //
  // 为什么必须是**硬过滤**而不是扣分：rootPrior 的分数只按 0.01 折算进最终分，
  // 扣 18 相当于扣 0.18；而安静着法之间的差距本来就只有 1~7 分（实测）。
  // 也就是说，之前那条「自家半场 row≥2 → row≤1 扣 18」在量纲上根本改不动决策。
  const ENG_RAID = _num("JJ_ENG_RAID", 1);
  // 工兵打未知子要 P(雷) 够高才打：撞普通子必死（损失 48），撞雷赚 75（雷 35 + 附加值 40）。
  // 盈亏平衡点 48/(48+75) = 0.39，这里放到 0.35（略宽松，允许「像雷就打」）。
  const ENG_PM = _num("JJ_ENG_PM", 0.35);

  /** 目标可能是雷的概率（信念行优先，退回身份域比例） */
  function engineerMineProb(state, seat, d, domains) {
    let pm = 0;
    try {
      const rows = beliefRowsView(state, seat, domains);
      const row = rows && rows.get(d.id);
      if (row && row.get) pm = row.get("mine") || 0;
    } catch (err) { pm = 0; }
    if (!pm && domains) {
      const dom = domains.get(d.id);
      if (dom && dom.size) { let c = 0; for (const t of dom) if (t === "mine") c += 1; pm = c / dom.size; }
    }
    return pm;
  }

  function isEarlyEngineerRaid(state, seat, move, domains) {
    if (!ENG_RAID || !ENG_HOLD) return false;
    if ((state.moveCount || 0) >= ENG_HOLD) return false;
    if (state.engRaidOff && state.engRaidOff[seat]) return false;
    const a = G.pieceAt(state, move.from);
    if (!isRealEngineer(state, seat, a)) return false;
    const to = B.BOARD.byId.get(move.to);
    if (!to || !to.seat || to.seat === a.owner || ally(to.seat, a.owner)) return false;
    // 敌旗已明 ⇒ 工兵去挖旗是有意义的，整条规则让路
    for (const p of state.pieces) {
      if (p.type !== "flag" || !p.position) continue;
      if (ally(p.owner, seat)) continue;
      if (G.visibleTo(state, seat, p)) return false;
    }
    const d = G.pieceAt(state, move.to);
    if (!d) return true;                        // ① 空手飞进敌境：前期没有目的，拦
    if (ally(d.owner, seat)) return false;
    if (to.kind === "hq") return false;         // ② 敌方大本营：可能直接扛旗，放行
    // ③ 攻击型飞行：工兵打任何普通子（含对方工兵）都是自己死，只有打雷是赚的。
    //    实测前 55 手里 9 次这类攻击，目标真身：雷 3 / 军长 2 / 连长 2 / 工兵 1 / 旗 1，
    //    工兵阵亡率 56% —— 换成「P(雷) < 0.35 就别打」。
    return engineerMineProb(state, seat, d, domains) < ENG_PM;
  }

  // 已知必死的撞击：下界已经证明对方比我大（且不是「进大本营必胜」那种情况）
  function isKnownSuicide(state, seat, move, mem, domains) {
    const a = G.pieceAt(state, move.from);
    const d = G.pieceAt(state, move.to);
    if (!a || !d || d.owner === seat) return false;
    if (state.latentSeats && state.latentSeats[seat] && a.latent) return false;  // 天命暗牌的子临战才定身份
    const myR = RANK_NUM[a.type] || 0;
    if (!myR) return false;                                   // 炸弹/地雷不适用
    const to = B.BOARD.byId.get(move.to);
    if (state.mode === "chaos" && to && to.kind === "hq" && to.seat !== a.owner) return false;
    const floor = knownFloor(mem, domains, d.id);
    return !!floor && myR < floor;
  }

  // 「这一步撞上去之后，我方还有没有炸弹能立刻吃到那个格子」。
  // allMoves 是 choose 里已经生成好的全量合法走法（不额外生成，零成本）。
  function bombRecaptureAvailable(state, seat, allMoves, targetPos, attackerId) {
    // ① 炸弹已经能一步吃到那个格子（最强的情形）
    for (let i = 0; i < allMoves.length; i += 1) {
      const m = allMoves[i];
      if (m.to !== targetPos) continue;
      const a = G.pieceAt(state, m.from);
      if (!a || a.type !== "bomb" || a.id === attackerId) continue;
      return true;
    }
    // ② 或者炸弹就在 2 格以内 —— 「先撞死、下一手贴上去、再一手炸」也是成立的，
    //    只是慢一拍，能不能成由 search 的捕获延伸去判断，这里只做粗筛。
    //    （只判 1 步会把 97% 的弃子机会漏掉：实测 32 次已知打不过里只有 1 次达标。）
    const tIdx = IDX.get(targetPos);
    if (tIdx === undefined) return false;
    for (const p of state.pieces) {
      if (p.owner !== seat || p.type !== "bomb" || !p.position || p.id === attackerId) continue;
      const bi = IDX.get(p.position);
      if (bi !== undefined && dist(bi, tIdx) <= 2) return true;
    }
    return false;
  }

  // ==================== 军旗防线：两步威胁 ====================
  // 大本营只有 3 个入口（公路，没有铁路），旗只能在这三个入口被人踩到。
  // 「敌方一步能站上入口 + 我下一个回合杀不掉它」就等于两步之后丢旗。
  // 老的 flagThreats 只在敌方已经站在入口时才反应，而那时往往已经杀不掉了 ——
  // 实测 8 局丢旗的局面里，凶手都先在入口站了 2~4 手，AI 全程在做别的事。
  function canReachCell(board, piece, target) {
    if (piece.pos === target) return false;
    if (B.PIECE_INFO[piece.type].immobile) return false;
    if (ROADS[piece.pos].includes(target)) {
      const q = board[target];
      if (!q) return true;
      return !ally(piece.owner, q.owner) && N[target].kind !== "camp";
    }
    if (!RAILS[piece.pos].length || !RAILS[target].length) return false;
    if (piece.type === "engineer") {
      const seen = new Set([piece.pos]);
      const queue = [piece.pos];
      for (let i = 0; i < queue.length; i += 1) {
        for (const nx of RAILS[queue[i]]) {
          if (seen.has(nx)) continue;
          seen.add(nx);
          if (nx === target) return true;
          if (board[nx]) continue;
          queue.push(nx);
        }
      }
      return false;
    }
    for (const line of THROUGH[piece.pos]) {
      const at = line.indexOf(piece.pos);
      const bt = line.indexOf(target);
      if (bt < 0) continue;
      const step = bt > at ? 1 : -1;
      let clear = true;
      for (let i = at + step; i !== bt; i += step) {
        if (board[line[i]]) { clear = false; break; }
      }
      if (clear) return true;
    }
    return false;
  }

  // 敌方 E 站上入口后能活下来的概率：同归于尽和炸弹都不占位，所以只看「严格更大」的比例
  // 风险阈值：这两个数是照着「旧的、偏低估的」beatsProb 调出来的。
  // 把估计修准之后概率整体变高，等于悄悄改了阈值，所以留成可调的，便于重新标定。
  const FLAG_T = (_ENV.JJ_FLAG_T !== undefined) ? Number(_ENV.JJ_FLAG_T) : 0.5;
  const DOM_T = (_ENV.JJ_DOM_T !== undefined) ? Number(_ENV.JJ_DOM_T) : 0.22;

  // 每手只算一次的暗子信念表（身份域 × 配额 × IPF × 阵法先验），给 beatsProb 用。
  // key 用 moveTape/battles 的长度：一着之内它们不变，缓存命中；下一手自然失效。
  let BR = { state: null, seat: null, dom: null, key: "", rows: null };
  function beliefRows(state, seat, list, domains) {
    if (!domains) return null;
    if (!BEAT_ON || guessOff(state, seat)) return null;
    const key = (state.moveTape ? state.moveTape.length : -1) + "|"
      + (state.battles ? state.battles.length : -1);
    if (BR.state === state && BR.seat === seat && BR.dom === domains && BR.key === key) return BR.rows;
    const rows = new Map();
    const byOwner = new Map();
    const byId2 = new Map();
    for (const it of list) {
      if (!it.ref || !it.ref.position) continue;
      if (it.owner === seat) continue;                       // 自己的子不用猜
      if (G.visibleTo(state, seat, it.ref)) continue;        // 已亮明的也不用猜
      if (!byOwner.has(it.owner)) byOwner.set(it.owner, []);
      byOwner.get(it.owner).push({ id: it.id });
      byId2.set(it.id, it.ref);
    }
    for (const [owner, items] of byOwner) {
      const pool = seatPools(state, seat, owner);
      // 位置先验只在「对手不像在用阵法库」时生效：它的分布是人类的，
      // 套在阵法库布局上实测反而变差（对数损失 2.983→3.189、地雷 AUC 0.862→0.820）。
      const humanLike = !!(FP && FP.state === state && FP.owner === owner && FP.isCustom);
      const jrows = jointRows(state, seat, owner, domains);
      const priorOf = (id) => {
        const pc = byId2.get(id);
        const jr = jrows ? jrows.get(id) : null;
        return mulPrior(
          mulPrior(
            mulPrior(
              // 有联合后验就顶掉逐格位置先验（两套都是「分布」，乘一起等于位置算两遍）
              jr || ((humanLike || POS_ALL) ? posPriorRow({ position: pc.position, __init: initPosOf(state, pc) }, state.moveCount) : null),
              formationPriorRow(state, owner, id),
            ),
            fatePriorRow(state, pc),
          ),
          trackPriorRow(state, pc),
        );
      };
      let pr;
      if (MATRIX_ON) {
        // 25×12：配额里先扣掉阵亡子的期望，活暗子只分剩下的；
        // 先验在 matrix 内部乘进初始行、再 IPF，所以列配额不会被先验打破。
        const mx = beliefMatrix(state, seat, owner, domains, priorOf);
        pr = new Map();
        for (const it of items) {
          const r = mx && mx.rows.get(it.id);
          if (r) pr.set(it.id, r);
        }
        for (const [id, row] of pr) rows.set(id, row);
      } else {
        pr = beliefProbs(items, domains, pool);
        for (const [id, row] of pr) rows.set(id, applyPrior(row, priorOf(id)));
      }
      const fit = formationPosterior(state, seat, owner);
    }
    // 吃子方的行为似然：我方小子被试吃 ⇒ 那个子的军衔分布按人类的实际吃法重排
    try { applyEatPrior(state, seat, rows, domains); } catch (err) { /* 不影响主流程 */ }
    // 「A 去抓明子（贴上去但没吃）」—— 炸/装炸/大子/诱饵 对这条的反应不同（见 applyGrabPrior）
    try { applyGrabPrior(state, seat, rows); } catch (err) { /* 不影响主流程 */ }

  // 同区格对条件化：某个子被确认（或高概率）是大子 ⇒ 同区其它暗子的大子率按
    // 人类布阵的经验条件概率重算（见 build_zone_pair_table.js 的留出验证）
    try { applyZonePair(state, seat, rows, byId2, domains); } catch (err) { /* 不影响主流程 */ }
    // 分区软配额（旧口径，默认关）：把「某区已经确认过几个大子」条件化进剩余暗子的分布
    try { applyZoneSoft(state, seat, rows, byId2, domains); } catch (err) { /* 不影响主流程 */ }
    BR = { state: state, seat: seat, dom: domains, key: key, rows: rows };
    // 死前快照：每算一次就写回 piece，供 beliefMatrix 在子死后复用。
    // 只写活子行 —— 死子不在 byId2 里，所以天然不会再被覆盖，等于 freeze 在死前那一版。
    for (const [id, row] of rows) {
      const ref = byId2.get(id);
      if (!ref) continue;
      if (!ref.__brows) ref.__brows = {};
      ref.__brows[seat] = row;
    }
    return rows;
  }

  // 给离线测量用：直接拿到「本手这一版的暗子信念」（含阵法先验）
  function beliefRowsView(state, seat, domains) {
    return beliefRows(state, seat, flagView(state).list, domains || inferDomains(state, seat));
  }

  function beatsProb(domains, e, q, row) {
    if (!q) return 1;                                  // 空口：走进去就算数
    const rq = RANK_NUM[q.type] || 0;
    if (!rq) return 0;                                 // 守旗位上是雷/旗之流，另算
    if (row && row.size) {
      // P(守方 q 被拿掉) = P(e 是炸弹，同归于尽) + P(e 等级 ≥ q，同级也是同归于尽)。
      // 旧实现只数 r > rq，炸弹因为 RANK_NUM 为 undefined 被整类跳过 —— 实测低估 13.6pp。
      let p = 0;
      for (const [t, w] of row) {
        if (!w) continue;
        if (t === "bomb") { p += w; continue; }
        const rt = RANK_NUM[t] || 0;
        if (rt && rt >= rq) p += w;
      }
      return p;
    }
    const d = domains && domains.get(e.id);
    if (!d || !d.size) return 0.5;
    let win = 0, tot = 0;
    for (const t of d) {
      const r = RANK_NUM[t] || 0;
      if (!r) continue;
      tot += 1;
      if (r > rq) win += 1;
    }
    return tot ? win / tot : 0;
  }

  // 敌方站在入口时，我下一手能不能做掉它（炸弹，或者等级够）
  function canAnswer(state, seat, board, m, enemy, mem, domains, override) {
    const floor = knownFloor(mem, domains, enemy.id);
    for (const q of state.pieces) {
      if (q.owner !== seat || !q.position) continue;
      if (B.PIECE_INFO[q.type].immobile || q.type === "flag") continue;
      const pos = (override && q === override.mover) ? override.dst : IDX.get(q.position);
      if (pos === undefined) continue;
      if (!canReachCell(board, { pos, type: q.type, owner: q.owner }, m)) continue;
      if (q.type === "bomb") return true;
      if ((RANK_NUM[q.type] || 0) >= floor) return true;
    }
    return false;
  }

  // ==================== 兵力账：对局中 AI 自己的那一本 ====================
  // 依据 战果规则.md（讨论部分）：玩家赛后看到的是「军衔基准」的一张总账；
  // 对局中 AI 需要的是另一本实时账，口径必须分两半：
  //   · 自己的子   —— 我全知道，阵亡即精确扣分；
  //   · 敌方的子   —— 只看得见「少了几个」（子数公开），值多少钱必须靠猜。
  // 猜的来源就是身份域（inferDomains）：域里的可能兵种 × 该座位还没被认领的配额。
  // 绝不读暗子真实兵种（p.type 只在 visibleTo 为真时才允许用）。
  const FORCE_VALUE = {
    // 战果规则.md §2 的计分表，但要反过来用：那张表是「明牌以后」的定价，
    // 这里算的是「我还不知道它是什么」的期望值，所以雷/炸不能按固定高价算。
    flag: 100, commander: 40, army: 30, division: 20, brigade: 15,
    bomb: 12, mine: 10, regiment: 10, battalion: 8, company: 6, platoon: 4, engineer: 3,
  };
  const REL_BY_RANK = {};
  for (const _t of Object.keys(RANK_NUM)) REL_BY_RANK[RANK_NUM[_t]] = _t;
  // 标准局每家的兵种配额（公开信息）。乱战每家发到什么都不同，所以那边不套配额。
  const STANDARD_POOL = {
    commander: 1, army: 1, division: 2, brigade: 2, regiment: 2, battalion: 2,
    company: 3, platoon: 3, engineer: 3, bomb: 2, mine: 3, flag: 1,
  };

  // 该座位还剩多少兵种配额：总配额 − 我已经确认（亮明）的同类子。
  // 暗子不扣——它们才是要被分配的对象。
  function seatPools(state, viewer, owner) {
    if (state.mode !== "standard") return null;
    const pools = Object.assign({}, STANDARD_POOL);
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      const certain = p.position ? G.visibleTo(state, viewer, p) : !!p.revealed;
      if (!certain) continue;
      const t = p.type;
      if (pools[t] !== undefined) pools[t] -= 1;
    }
    for (const t of Object.keys(pools)) if (pools[t] < 0) pools[t] = 0;
    return pools;
  }

  // 每个暗子的兵种分布：身份域 × 该座位剩余配额，再用 IPF 校准到「配额守恒」。
  //
  // 只按域均匀或只按域×配额都不行——域之间是独立的，但整副牌只有 1 个司令、1 面旗。
  // 实测未校准时，50 枚暗子的期望值总和只有真实值的 79%（军旗只在 2 个大本营格可放，
  // 均匀摊给每个子就只剩 0.08 的质量），于是「开局双方应该持平」变成「我领先 158 分」。
  // 校准后 Σ期望 = 该座位剩余子力的真实总值，判断才不会系统性偏向自己。
  function beliefProbs(list, domains, pool) {
    // 配额全为 0（四家全明 / 残局把敌人都认全了）时不能当「没有配额」用：
    // 那样 IPF 会把每个兵种的概率都清成 0，最后连「敌方最强是谁」都算不出来（返回 0）。
    if (pool) {
      let total = 0;
      for (const t of Object.keys(pool)) total += pool[t] || 0;
      if (total <= 1e-9) pool = null;
    }
    const probs = new Map();
    for (const it of list) {
      const d = domains.get(it.id);
      const row = new Map();
      probs.set(it.id, row);
      if (!d || !d.size) continue;
      let den = 0;
      for (const t of d) {
        const w = pool ? (pool[t] || 0) : 1;
        if (w > 0) { row.set(t, w); den += w; }
      }
      if (!den) { for (const t of d) { row.set(t, 1); den += 1; } }
      for (const [t, w] of row) row.set(t, w / den);
    }
    if (!pool) return probs;
    const renormalize = (row) => {
      let sum = 0;
      for (const [, v] of row) sum += v;
      if (sum > 1e-9) for (const [t, v] of row) row.set(t, v / sum);
    };
    for (let iter = 0; iter < 6; iter += 1) {
      const mass = {};
      for (const [, row] of probs) for (const [t, v] of row) mass[t] = (mass[t] || 0) + v;
      let moved = 0;
      for (const t of Object.keys(mass)) {
        const need = pool[t] || 0;
        const have = mass[t] || 0;
        if (have <= 1e-9) continue;
        if (need <= 1e-9) {
          for (const [, row] of probs) if (row.has(t)) { row.set(t, 0); renormalize(row); }
          moved += 1;
          continue;
        }
        const k = need / have;
        if (Math.abs(k - 1) < 2e-3) continue;
        moved += 1;
        for (const [, row] of probs) if (row.has(t)) row.set(t, row.get(t) * k);
        for (const [, row] of probs) renormalize(row);
      }
      if (!moved) break;
    }
    return probs;
  }

  function rowValue(row) {
    let v = 0;
    for (const [t, p] of row) v += p * (FORCE_VALUE[t] || 0);
    return v;
  }

  // ==================== 25×12 全生命周期矩阵 ====================
  // 每方固定 25 行（= 25 枚棋子），行 id 用 piece.id，**阵亡不删行**。
  //
  // 旧结构的问题是：seatPools 只扣「已经亮明」的子，阵亡但身份未知的子照样占着
  // 配额，于是活子被分到超额 —— 敌方子力期望系统性虚高。而 beliefRows 只给活子
  // 建行，子一死，「它当时是什么」这条推理链就断了。
  //
  // 现在：死子行保留（优先用死前最后一次算出的分布 p.__brows[seat]），先把它的
  // 期望从总配额里扣掉，剩下的才给活暗子做 IPF。这样 25 行的列和 = 该方总构成，
  // 配额守恒和死子链一次闭环。
  // ==================== 区域大子账本 ====================
  // 用户的经验：底营（下排）非旗侧的 7 格通常只放 1 个大子，确定 A 之后其余都是小子，
  // 于是后期可以用团/旅放心去吃。实测（training/probe_zone_quota.py，25,928 家·区域）：
  //   上排营 ≤1 个大子只有 31~45%（均值 1.5~1.85）  → 上限取 2
  //   下排营 非旗侧 ≤1 个占 80.6%（均值 0.89）      → 上限取 1
  // 所以这不是硬约束（20% 会有第 2 个），只在评估层做软化：配额用完时把「大子」权重压到
  // ZONE_SOFT。不走 IPF，避免被列归一化吃掉。
  // 实测有害，默认关（JJ_ZONE=1 打开）。一代 vs 零代 30 局：
  //   开 8胜1负21和（26.7%，净战损 −1669，撞死率 45.4%）
  //   关 14胜1负15和（46.7%，净战损 −854，撞死率 43.1%）
  // 原因：belief 的大子概率本身 top1 只有 47%，用它判断「区域配额用完」会频繁误判；
  // 一旦误判成「这里没有大子了」，AI 就敢用团/旅去吃，正好撞上那 18~30% 的第 2 个大子。
  // 80% 的先验不能用来放松进攻 —— 失误代价是撞死一个大子，期望上是负的。
  const ZONE_ON = _ENV.JJ_ZONE === "1";
  const ZONE_SOFT = _num("JJ_ZONE_SOFT", 0.2);
  // 试探的信息价值系数。默认 0 = 与旧行为完全一致（评估函数不给试探付钱）。
  // 背景：人类棋谱实测「团长试探」值 1.45 bit，而旧 evaluate 里这一项恒为 0，
  // 所以 AI 从不主动去试——它只会「有把握才吃」，永远停在 47% 的把握上限。
  // 换算：团长值 43 分，撞死白亏 43；一次试探把「这区还有没有大子」砍掉 1.45 bit，
  // 后面几十手都靠这条，所以给 10~20 分的量级是合理的，具体由 A/B 定。
  const PROBE_K = _num("JJ_PROBE", 0);
  // 剩余名额低于这个值才软化（0.5 ≈ 该区域基本已经被大子占满）
  const ZONE_MARGIN = _num("JJ_ZONE_MARGIN", 0.5);
  const ZCAP = [2, 2, 1, 1];                 // 角营 (1,1)/(1,3)/(3,1)/(3,3)
  const CORNER_ZONES = [[1, 1], [1, 3], [3, 1], [3, 3]];
  const BIG_T = new Set(["commander", "army", "division"]);

  function zoneOfNode(node) {
    if (!node || node.row === undefined) return -1;
    for (let i = 0; i < 4; i += 1) {
      const [r0, c0] = CORNER_ZONES[i];
      if (Math.abs(node.row - r0) <= 1 && Math.abs(node.col - c0) <= 1
          && !(node.row === r0 && node.col === c0)) return i;
    }
    return -1;
  }

  const ZLEDGER = new WeakMap();             // state -> Map(key, ledger)
  // 「确定的大子」只能用**战斗证据**（knownFloor）判断，不能用 belief 的概率期望。
  // 用期望的版本实测有害：belief 的 top1 只有 47%，期望一贴近上限就放松，
  // 结果在还没真正确认 A 的时候就敢吃了，正好撞上第 2 个大子。
  // 用户的原话是「团营一级试探，A 确定下来了」—— 前提是「确定」。
  const BIG_FLOOR = 38;                      // RANK_NUM: 师38 军39 司40
  function zoneLedger(state, seat, owner, domains, mem) {
    let m = ZLEDGER.get(state);
    if (!m) { m = new Map(); ZLEDGER.set(state, m); }
    // 缓存键要含 probe 的规模：probe 只增不改 lo 的时候 lo.size 不变，
    // 早先只用 lo.size 当键，会拿到「试探之前」的旧账。
    const key = seat + "|" + owner + "|" + (mem && mem.lo ? mem.lo.size : 0)
      + "|" + (mem && mem.probe ? mem.probe.size : 0);
    const hit = m.get(key);
    if (hit) return hit;
    const z = [{ e: 0, d: 0, a: 0 }, { e: 0, d: 0, a: 0 }, { e: 0, d: 0, a: 0 }, { e: 0, d: 0, a: 0 }];
    const of = new Map();
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      // 开局格：动过的从 moveTape 反推，没动过就是当前位置 —— 每枚子按 id 独立追踪
      const ip = initPosOf(state, p) || p.position;
      if (!ip) continue;
      const idx2 = IDX.get(ip);
      if (idx2 === undefined) continue;
      const zi = zoneOfNode(N[idx2]);
      if (zi < 0) continue;
      of.set(p.id, zi);
      // 战斗证据（加权）：师/军/司 被吃 ⇒ 1 个大子；旅 ⇒ 0.5；
      // 团/营试探被吃且已排除雷 ⇒ 0.67 / 0.5（见 probeWeight 的实测表）
      const w = probeWeight(mem, domains, p.id);
      if (!p.position) { if (w > 0) z[zi].d += w; }   // 阵亡且被证据确定
      else { z[zi].a += 1; if (w > 0) z[zi].e += w; } // 存活且被证据确定
    }
    const out = { z, of };
    m.set(key, out);
    return out;
  }

  // 该目标子所在开局区域「还容得下大子吗」。容得下 → 1，用完 → ZONE_SOFT
  const ZONE_STATS = { calls: 0, soft: 0, usedHalf: 0 };
  function zoneSoftOf(state, seat, d, domains, rows, mem) {
    if (!ZONE_ON || !d) return 1;
    const lg = zoneLedger(state, seat, d.owner, domains, mem);
    const zi = lg.of.get(d.id);
    if (zi === undefined) return 1;
    ZONE_STATS.calls += 1;
    const zz = lg.z[zi];
    const used = zz.e + zz.d;
    // 上限会被证据「更新」：真的撞出第 2 个大子，就说明这区上限不止 1，
    // 用它实际的已确认数当新上限，而不是继续认为「超了」。
    // used 现在是加权值（旅 0.5 / 团营试探 0.67,0.5），向上取整再比。
    const capEff = Math.max(ZCAP[zi], Math.ceil(used - 1e-9));
    // 必须先确认过至少「半个大子」，才谈得上「名额用完」。用 used 而不是 e：
    // 撞死的那一个同样占掉名额——用户的口径是「撞上第 2 个大子就说明这区确实有 2 个，
    // 剩下 5 个是小子」，所以上限跟着证据上调（capEff），而不是继续认定「超了」。
    if (used < 0.5) return 1;
    const soft = (capEff - used) <= ZONE_MARGIN;
    if (soft) ZONE_STATS.soft += 1;
    if (used > 0 && used < 1) ZONE_STATS.usedHalf += 1;
    return soft ? ZONE_SOFT : 1;
  }

  // ==================== 配额消元（硬锁） ====================
  // IPF 对「整行乘常数」「整列乘常数」完全不变（Scaling Invariance），
  // 能留存下来的只有零元拓扑和交叉比。所以软乘子基本无效（§9.7/§9.8 实测），
  // 真正有收益的是把配额吃满，直接改零元：
  //   (a) 某类型配额已耗尽 ⇒ 其余行的该列置 0
  //   (b) K=1 独苗 ⇒ 该行确定，配额 -1
  //   (c) 列侧 Hall：某类型剩余配额 == 还能是它的行数 ⇒ 这些行必为它
  //   (d) {地雷,军旗} 抽屉：域含雷/旗的行数 == 雷旗剩余配额 ⇒ 这些行只能是雷旗
  // 链式迭代到不动点（实测 2~3 轮收敛）。
  function quotaPropagate(state, seat, owner, domains, ac3On) {
    // 实测零增量：inferDomains 的 24 轮已经是双向 AC-3（同一个 battleOutcome 真值表、
    // 攻守互收紧、跨座位），这里再跑一遍是完全重复的。默认关，留着供调试。
    const useAC3 = ac3On === true;
    const ids = [];
    let pool0 = null;
    for (const p of state.pieces) if (p.owner === owner) ids.push(p.id);
    if (!ids.length) return null;
    const dom = new Map();
    for (const id of ids) {
      const d = domains.get(id);
      dom.set(id, d && d.size ? new Set(d) : new Set(TYPES));
    }
    pool0 = Object.assign({}, STANDARD_POOL);
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      const certain = p.position ? G.visibleTo(state, seat, p) : !!p.revealed;
      if (certain) pool0[p.type] = (pool0[p.type] || 0) - 1;
    }
    for (const t of Object.keys(pool0)) if (pool0[t] < 0) pool0[t] = 0;

    const ownerOf = new Map();
    for (const p of state.pieces) ownerOf.set(p.id, p.owner);
    const battles = state.battles || [];
    const locked = new Map();
    const dbg = { colZero: 0, k1: 0, hallCol: 0, k2: 0, mineFlag: 0 };
    let changed = true, guard = 0, locks = 0;
    while (changed && guard < 10) {
      changed = false;
      guard += 1;
      // (0) 跨座战报 AC-3：和配额消元交替跑。
      //     inferDomains 里已经做过 24 轮同样的双向收紧，但那是在配额消元之前；
      //     这里再跑一遍，是为了吃「配额消元刚刚造出来的零元」——
      //     比如某家 2 颗炸弹被锁在别处，它其余子的炸弹列归零后，
      //     回看第 18 手那场同尽，另一方的域就能立刻对齐。
      for (const b of (useAC3 ? battles : [])) {
        const aMine = ownerOf.get(b.attacker) === owner;
        const dMine = ownerOf.get(b.defender) === owner;
        if (!aMine && !dMine) continue;
        const da = aMine ? dom.get(b.attacker) : domains.get(b.attacker);
        const dd = dMine ? dom.get(b.defender) : domains.get(b.defender);
        if (!da || !dd || !da.size || !dd.size) continue;
        if (aMine && da.size > 1) {
          for (const t of [...da]) {
            let ok = false;
            for (const u of dd) {
              if (battleOutcome(t, u, !!b.inHq, state.mode) === b.outcome) { ok = true; break; }
            }
            if (!ok) { da.delete(t); changed = true; }
          }
        }
        if (dMine && dd.size > 1) {
          for (const u of [...dd]) {
            let ok = false;
            for (const t of da) {
              if (battleOutcome(t, u, !!b.inHq, state.mode) === b.outcome) { ok = true; break; }
            }
            if (!ok) { dd.delete(u); changed = true; }
          }
        }
      }
      for (const [, d] of dom) if (!d.size) for (const t of TYPES) d.add(t);   // 兜底
      // (a) 配额耗尽 ⇒ 删列
      for (const [id, d] of dom) {
        if (locked.has(id)) continue;
        for (const t of [...d]) {
          if ((pool0[t] || 0) <= 0) { d.delete(t); changed = true; dbg.colZero += 1; }
        }
        if (!d.size) for (const t of TYPES) d.add(t);   // 兜底，避免死锁
      }
      // (b) K=1 独苗
      for (const [id, d] of dom) {
        if (locked.has(id) || d.size !== 1) continue;
        const t = [...d][0];
        locked.set(id, t);
        locks += 1;
        dbg.k1 += 1;
        pool0[t] = (pool0[t] || 0) - 1;
        changed = true;
      }
      // (c) 列侧 Hall
      for (const t of TYPES) {
        const left = pool0[t] || 0;
        if (left <= 0 || left > 4) continue;
        const cand = [];
        for (const [id, d] of dom) if (!locked.has(id) && d.has(t)) cand.push(id);
        if (cand.length && cand.length === left) {
          for (const id of cand) { dom.set(id, new Set([t])); changed = true; dbg.hallCol += 1; }
        }
      }
      // (c2) 行侧 K=2 二元抽屉：两行的域都 ⊆ {a,b} 且 q_a+q_b == 2
      //      ⇒ 这两行吃掉 a、b 的全部配额，其余行的 a/b 列置 0
      const groups = new Map();
      for (const [id, d] of dom) {
        if (locked.has(id) || d.size < 2 || d.size > 2) continue;
        const key = [...d].sort().join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(id);
      }
      for (const [key, gids] of groups) {
        const ts = key.split("|");
        const avail = ts.reduce((acc, t) => acc + (pool0[t] || 0), 0);
        if (gids.length === avail && avail > 0) {
          for (const [id2, d2] of dom) {
            if (locked.has(id2) || gids.indexOf(id2) >= 0) continue;
            for (const t of ts) if (d2.has(t)) { d2.delete(t); changed = true; dbg.k2 += 1; }
          }
        }
      }
      // (d) 雷旗抽屉
      const mf = (pool0.mine || 0) + (pool0.flag || 0);
      if (mf > 0) {
        const cand = [];
        for (const [id, d] of dom) if (!locked.has(id) && (d.has("mine") || d.has("flag"))) cand.push(id);
        if (cand.length === mf) {
          for (const id of cand) {
            const d = dom.get(id);
            if (d.size <= 2) continue;
            const nd = new Set();
            if (d.has("mine")) nd.add("mine");
            if (d.has("flag")) nd.add("flag");
            if (nd.size) { dom.set(id, nd); changed = true; dbg.mineFlag += 1; }
          }
        }
      }
    }
    return { domains: dom, pool: pool0, locks, locked: locked.size, dbg };
  }

  // ==================== 分区大子配额（ZONEQ · 2026-11-03） ====================
  // 把 25 个开局格切成 5 个互斥的 5 格抽屉（左右按列、前后以 row2 为界）：
  //   LF/RF 前翼(col0-1/3-4, row0-2)  LB/RB 底翼(同列, row3-5)   MID 中轴(col2, row0-5)
  // 实测（12,964 座人类布阵，见 training/FORMATION_CLASSES.md）：
  //   前翼 ≤2 大子 覆盖 95.2% / 95.4%；底翼 ≤1 覆盖 94.9% / 95.3%；中轴 ≤2 覆盖 99.6%
  // 用途：某区「已确认的大子」吃满配额后，同区其它暗子的 司/军/师 三列**硬清零**，
  //      不是把概率调低 —— 只有硬排除才能影响候选集（isKnownSuicide 那一层）。
  const ZONEQ_ON = _ENV.JJ_ZQ === "1";
  const ZONE_CAP = { LF: 2, RF: 2, LB: 1, RB: 1, MID: 2 };
  const ZONE_BIG = ["commander", "army", "division"];
  const ZONEQ_STATS = { calls: 0, cutPieces: 0, rollbacks: 0, zonesFull: 0, usedHist: {} };

  /** "north-2-1" → LF/RF/LB/RB/MID */
  function zoneOfPos(pos) {
    if (!pos) return null;
    const parts = String(pos).split("-");
    const r = Number(parts[1]);
    const c = Number(parts[2]);
    if (!(r >= 0 && c >= 0)) return null;
    if (c <= 1) return r <= 2 ? "LF" : "LB";
    if (c >= 3) return r <= 2 ? "RF" : "RB";
    return "MID";
  }

  /** 已经能确定真身的子：亮明 / revealed / 死前快照唯一 / 域坍缩到唯一 */
  function zoneKnownType(state, seat, piece, dom) {
    if (piece.position && G.visibleTo(state, seat, piece)) return piece.type;
    if (piece.revealed) return piece.type;
    const snap = piece.__brows && piece.__brows[seat];
    if (snap instanceof Map && snap.size === 1) return [...snap.keys()][0];
    const d = dom && dom.get(piece.id);
    if (d && d.size === 1) return [...d][0];
    return null;
  }

  /**
   * 按开局归属分区扣配额。返回新的 domains Map（没有改动就返回 null）。
   * 熔断：任一暗子被砍成空集 ⇒ 整个分区回退（约 4.6% 的极端布阵会撞上）。
   */
  // ---- 分区软配额（ZONE_SOFT，2026-11-03）----
  // 依据 12,964 份人类布阵的五区大子均值：LF 1.36 / RF 1.29 / LB 0.38 / RB 0.40 / MID 0.57。
  // 条件化：已知某区已经用掉 u 个大子 ⇒ 该区剩余期望 = max(0, mean − u)，
  // 于是把该区其余暗子的「大子列」按 (mean−u)/mean 缩放再归一。
  // 这和 ZONEQ 的硬上限不同：硬上限只在「吃满 cap」时动手（实测 60~100 手只触发 1.6~6.9%），
  // 软配额**每次确认一个就动**，所以「东家司令死在左上营 ⇒ 该区其余子大子概率下降」这种
  // 条件化才真的体现在数字上。
  const ZONE_MEAN = { LF: 1.36, RF: 1.29, LB: 0.38, RB: 0.40, MID: 0.57 };
  // 条件缩放系数：E[该区剩余大子 | 已知 u 个] / E[大子数]，直接由 12,964 份人类布阵的
  // 计数分布算出（不是 (mean−u)/mean —— 那个是泊松近似，对这个「≤2 占 95%」的窄分布会杀过头）：
  //   LF P(0..3)=10/48/36/5   ⇒ u=1 时剩余期望 0.52，scale 0.38
  const ZONE_SCALE = { LF: [0.379, 0.087, 0.007], RF: [0.371, 0.099, 0.026], MID: [0.301, 0.089, 0], LB: [0.412, 0.083, 0], RB: [0.352, 0.115, 0.093] };
  // ⚠ 默认**关**：实测在「被它改过」的 102 个暗子上，大子/非大子 log loss 0.3511 → 0.3929（更差）。
  //   原因是选择偏差：能被确认「域里全是 ≥师」的子，本身就偏向大子密集的区，
  //   同区相关性压过了配额约束。要用请 JJ_ZQ_SOFT=1。
  const ZQ_SOFT_ON = _num("JJ_ZQ_SOFT", 0);
  const ZONE_SOFT_MIN = _num("JJ_ZQ_MIN", 0.06);

  function applyZoneSoft(state, seat, rows, byId2, domains) {
    if (!ZQ_SOFT_ON) return;
    if (state && state.zoneSoftOff && state.zoneSoftOff[seat]) return;
    if (!rows || !rows.size) return;
    const used = new Map();          // owner|zone -> 已确认大子数
    const hidden = new Map();        // owner|zone -> [棋子 id]
    for (const p of state.pieces) {
      const z = zoneOfPos(initPosOf(state, p));
      if (!z) continue;
      const key = p.owner + "|" + z;
      const kt = zoneKnownType(state, seat, p, domains);
      if (kt) {
        if (ZONE_BIG.indexOf(kt) >= 0) used.set(key, (used.get(key) || 0) + 1);
        continue;
      }
      // 死子/暗子的「下界」也是信息：吃过我方军长 ⇒ 至少军长；它死在这个区，
      // 说明这个区的配额已经花掉一个 ≥师 的大子。实战里死子能确定**具体兵种**的只有 7%，
      // 但「下界 ≥ 师」能覆盖到的情况多得多 —— 这正是用户要的「司令死了，同区其他子大子率降低」。
      // ⚠ 不能直接用 knownFloor：炸弹没有军衔，域 {炸弹, 师长} 的 minRank 也是 38，
      //   会被误判成「确定 ≥师」。要求**域里每一类都 ≥ 师**才算数。
      const dd = domains && domains.get(p.id);
      let pureBig = false;
      if (dd && dd.size) {
        pureBig = true;
        let any = false;
        for (const t of dd) {
          if (t === "bomb" || t === "mine" || t === "flag") { pureBig = false; break; }
          if ((RANK_NUM[t] || 0) >= 38) any = true;      // 38 = 师长
          else { pureBig = false; break; }
        }
        pureBig = pureBig && any;
      }
      if (pureBig) {
        used.set(key, (used.get(key) || 0) + 1);
      } else if (p.position && rows.has(p.id)) {
        if (!hidden.has(key)) hidden.set(key, []);
        hidden.get(key).push(p.id);
      }
    }
    for (const [key, ids] of hidden) {
      const z = key.split("|")[1];
      const tab = ZONE_SCALE[z];
      const u = used.get(key) || 0;
      if (!tab || u <= 0) continue;               // 没确认过东西，先验不动
      const raw = tab[Math.min(3, u) - 1];
      const scale = Math.max(ZONE_SOFT_MIN, Math.min(1, raw === undefined ? 1 : raw));
      if (scale >= 0.999) continue;
      for (const id of ids) {
        const row = rows.get(id);
        if (!row || !row.size) continue;
        let sum = 0;
        const next = new Map();
        for (const [t, w] of row) {
          const v = (ZONE_BIG.indexOf(t) >= 0) ? w * scale : w;
          if (v > 0) { next.set(t, v); sum += v; }
        }
        if (!(sum > 0)) continue;
        for (const [t, v] of next) next.set(t, v / sum);
        rows.set(id, next);
      }
    }
  }

  // ---- 吃子方的行为似然（EAT，2026-11-03）----
  // 表由 training/build_eat_table.js 从 125 局人类棋谱的 3,074 次「攻方独活」学出：
  //   P(攻方类型 | 守方类型)，只对「我方自己的子被吃」生效（队友的子在我视角里是暗的）。
  // 为什么必须补这一层：inferDomains 只给硬约束「攻方 > 守方」。我方排长被吃，
  // 攻方域是 {连,营,团,旅,师,军,司}，七类均分 ⇒ 大子概率 43%？不对，是"域内均分"，
  // 而 beliefMatrix 的配额分配会把它摊成 ~16%。可是人类实际的吃法是「要吃就用大子稳稳
  // 拿下」：守方=排长时攻方 45.3% 是司/军/师、65.0% ≥ 旅，连长只占 9%。
  // 这条似然就是把这个 3~5 倍的倾斜量灌进信念行 —— 用户说的「不用旅长也能试出大子」。
  let EAT_TABLE = root.JUNQI_EAT_TABLE || null;
  if (!EAT_TABLE && typeof require === "function") {
    try { EAT_TABLE = require("./training/out/eat_rank_table.json"); } catch (err) { EAT_TABLE = null; }
  }
  const EAT_ON = _ENV.JJ_EAT !== "0";
  const EAT_K = _num("JJ_EAT_K", 1);       // 似然指数：1 = 直接当似然，0.5 = 温和版
  const EAT_STATS = { calls: 0, cut: 0, any: 0 };
  // ①b：守方**不是我方**（敌方互撞 / 我方队友被打）时，把 EAT 表按守方的信念行边缘化，
  // 再去重排攻方。这是用户 11-04 提的那条「主动去吃打过仗的子 ⇒ 露大子」的可用形态：
  // 实战里「看得见的明子」只有 4.1%（本规则打完不亮牌），但「打过仗 ⇒ 身份被摸过」占 29%，
  // 那批守方的行很尖，边缘化之后表才有锐度。
  // 默认开：留出评估 12 类 -0.008、大子 Brier -0.0025（后期 -6.4%），见 日志 §四十
  const EAT_ANY = _ENV.JJ_EAT_ANY !== "0";
  const EAT_ANY_K = _num("JJ_EAT_ANY_K", 0.6);
  // 只对「守方之前打过仗」的交战生效（用户原始直觉）；默认全开，可用 1 收窄
  const EAT_ANY_FOUGHT = _ENV.JJ_EAT_ANY_FOUGHT === "1";
  // 表是人类的，默认只对真人座位生效（EAT/ZPAIR 的老规矩）。但 AI 自对弈的统计里
  // 「撞打过的子 ⇒ 大子 56.2% vs 撞全新 41.3%」这条关系同样成立，所以留了个总开。
  const EAT_ANY_AI = _ENV.JJ_EAT_ANY_AI === "1";

  // 这两张表都是从**人类**行为学的（人类布阵 / 人类吃子）。对手是 AI 时套上去就是错的先验：
  // AI 自对弈里的吃子习惯和人类差得远（它会用小子硬撞），实测大子 log loss 反而 +0.013。
  // 所以按座位判：有 aiProfiles / agentSeats 标记的座位不套，真人座位才套。
  // JJ_HUMAN_OPP=0 可强制全开（离线评估这两张表本身时用）。
  function humanOpp(state, owner) {
    if (_ENV.JJ_HUMAN_OPP === "0") return true;
    if (state.aiProfiles && state.aiProfiles[owner]) return false;
    if (state.agentSeats && state.agentSeats.indexOf(owner) >= 0) return false;
    return true;
  }

  // 双向战报似然：① 我方守死 ⇒ 猜攻方（EAT 表）② 我方攻死 ⇒ 猜守方（BATTLE 表）
  // ② 是 11-04 补的：rules 剪完枝剩下几档怎么分，现在按位置先验×配额摊（等于假设均匀），
  // 但人类实战明显偏「刚好大一级」—— 我旅撞死，守方 59% 是师；我团撞死，37% 旅 33% 师。
  // 这条方向过去完全没被利用（EAT 只管反方向）。
  let BATTLE_TABLE = root.JUNQI_BATTLE_TABLE || null;
  if (!BATTLE_TABLE && typeof require === "function") {
    try { BATTLE_TABLE = require("./training/out/battle_rank_table.json"); } catch (err) { BATTLE_TABLE = null; }
  }
  // ⚠ 默认**关**：实测在人类棋谱上 12 类 log loss 2.0830 → 2.0924（+0.0093，更差），
  //   大子 log loss 也 +0.0017，top1 持平。原因见 日志.md §三十三：
  //   这张表统计的是「所有我方撞死事件」的守方分布，而这类事件大多发生在前线，
  //   分布里已经含了位置效应；我们的 row 里本来就有 30×12 的位置先验，等于算了两遍。
  //   要复现：JJ_DEFPRIOR=1
  const DEFPRIOR_ON = _ENV.JJ_DEFPRIOR === "1";
  const DEFPRIOR_K = _num("JJ_DEFPRIOR_K", 1);
  const BATTLE_STATS = { calls: 0, cut: 0 };

  /** 每家 25 子的军衔边际（只算 9 档军衔，合计 19/25，归一化到 1）。 */
  const RANK_MARGINAL = (() => {
    const base = { commander: 1, army: 1, division: 2, brigade: 2, regiment: 2, battalion: 2, company: 3, platoon: 3, engineer: 3 };
    let s = 0;
    for (const k of Object.keys(base)) s += base[k];
    const out = {};
    for (const k of Object.keys(base)) out[k] = base[k] / s;
    return out;
  })();

  /**
   * 把 row 按经验表重新加权。
   * useLR=true 时用**似然比** tbl[t]/prior[t] 而不是 tbl[t] 本身 ——
   * row 里已经含了边际先验（位置 × 配额），再乘一次绝对概率等于把边际算两遍，
   * 会把分布过度推向「常见的档位」（第一版就这么错了：log loss 反而 +0.010）。
   */
  function reweightRow(row, tbl, k, useLR) {
    const prior = useLR ? RANK_MARGINAL : null;
    let z = 0;
    for (const [t] of row) {
      if (!tbl[t]) continue;
      z += prior ? tbl[t] / (prior[t] || 1) : tbl[t];
    }
    if (!(z > 0)) return null;
    let sum = 0;
    const next = new Map();
    for (const [t, w] of row) {
      if (!tbl[t]) continue;
      const q = (prior ? tbl[t] / (prior[t] || 1) : tbl[t]) / z;
      if (!(q > 0)) continue;
      const v = w * Math.pow(q, k);
      if (v > 0) { next.set(t, v); sum += v; }
    }
    if (!(sum > 0) || next.size < 2) return null;
    for (const [t, v] of next) next.set(t, v / sum);
    return next;
  }

  // ---- 「A 去抓明子」= 一条被浪费掉的证据（GRAB，2026-11-05）----
  // 用户口径：明子 = **打过仗的子**（不是身份已确认的子）。判断大子除了「大子吃明子」，
  // 还有「拿子 A 去抓明子」这一路，而它至少有四种解释：
  //   ① A 是炸        —— 炸什么都敢碰，会去抓                     → 权重中高
  //   ② A 在装炸      —— 大子为了伪装，反而不轻易抓                → 「大」这一档要打折
  //   ③ A 是大子      —— 抓比自己小的明子是划算的                  → 权重高
  //   ④ A 是小子诱吃  —— 背后有大子接应，故意贴上去钓你           → 权重中（且需 decoy 条件）
  // 判据只用公开信息：A 这一手落在哪、落点的邻域里有没有「我打过仗的子」。
  // 注意与 EAT 分工：已经吃掉的走法归 EAT 表管，这里只管「贴上去但没吃」。
  const GRAB_ON = _ENV.JJ_GRAB !== "0";
  const GRAB_STATS = { fire: 0, decoy: 0, none: 0 };

  function applyGrabPrior(state, seat, rows) {
    if (!GRAB_ON || !rows) return;
    if (state.grabOff && state.grabOff[seat]) return;
    const tape = state.moveTape || [];
    const last = tape[tape.length - 1];
    if (!last) { GRAB_STATS.r_notape = (GRAB_STATS.r_notape || 0) + 1; return; }
    if (last.cap) { GRAB_STATS.r_cap = (GRAB_STATS.r_cap || 0) + 1; return; }
    if (last.seat === seat) { GRAB_STATS.r_own = (GRAB_STATS.r_own || 0) + 1; return; }
    if (!last.to) { GRAB_STATS.r_noto = (GRAB_STATS.r_noto || 0) + 1; return; }
    const row = rows.get(last.piece);
    if (!row || !row.size) { GRAB_STATS.r_norow = (GRAB_STATS.r_norow || 0) + 1; return; }
    const nb = ((root.JunqiBoard && root.JunqiBoard.BOARD && root.JunqiBoard.BOARD.neighbors) || new Map()) || {};
    const battles = state.battles || [];
    const fought = (id) => battles.some((b) => b.attacker === id || b.defender === id);
    // 「抓」= 下一手就能开打（敌方不避让的话）：A 的新位置一步能打到我的明子。
    // 不是"贴上去" —— 贴上去只是邻里接触，能打到才是威胁。
    const fv = flagView(state);
    const mover = { pos: IDX.get(last.to), type: "regiment" };
    let B = null;
    let otherUnknown = false;
    for (const p of state.pieces) {
      if (!p.position || p.owner !== seat) continue;
      if (p.type === "mine" || p.type === "flag") continue;
      if (!fought(p.id)) continue;
      if (!canReachCell(fv.board, mover, IDX.get(p.position))) continue;
      // 多个目标时取最大的那个（威胁谁都算抓）
      if (!B || (RANK_NUM[p.type] || 0) > (RANK_NUM[B.type] || 0)) B = p;
    }
    for (const cid of (nb.get(last.to) || [])) {
      const q = G.pieceAt(state, cid);
      if (!q || !q.position) continue;
      if (ally(q.owner, seat) || q.owner === seat) continue;
      if (!G.visibleTo(state, seat, q)) otherUnknown = true;   // 旁边有未知敌子 ⇒ 可能是接应的大子
    }
    if (!B) { GRAB_STATS.none += 1; return; }
    const rb = RANK_NUM[B.type] || 0;
    let sum = 0;
    for (const t of row.keys()) {
      let L;
      if (t === "bomb") L = 0.75;
      else if (t === "mine" || t === "flag") L = 0.1;     // 雷/旗不会主动去抓
      else {
        const ra = RANK_NUM[t] || 0;
        if (ra > rb) L = 0.7;                             // 能赢才抓；0.7 而不是 1：装炸的大子会忍住
        else if (ra === rb) L = 0.45;
        else L = otherUnknown ? 0.5 : 0.18;               // 打不过还贴上去：诱饵 or 送死
      }
      row.set(t, (row.get(t) || 0) * L);
      sum += row.get(t);
    }
    if (!(sum > 0)) return;
    for (const t of row.keys()) row.set(t, row.get(t) / sum);
    GRAB_STATS.fire += 1;
    if (otherUnknown) GRAB_STATS.decoy += 1;
  }
  function applyEatPrior(state, seat, rows, domains) {
    if (!rows) return;
    if ((!EAT_ON || !EAT_TABLE || !EAT_TABLE.table) && (!DEFPRIOR_ON || !BATTLE_TABLE)) return;
    if (!state.battles || !state.battles.length) return;
    EAT_STATS.calls += 1;
    BATTLE_STATS.calls += 1;
    let byId = null;
    for (const b of state.battles) {
      if (!byId) {
        byId = new Map();
        for (const p of state.pieces) byId.set(p.id, p);
      }
      // ①b 守方不是我方：用守方的信念行把 EAT 表边缘化，重排攻方的身份
      if (b.outcome === "attacker" && EAT_ANY && EAT_TABLE && EAT_TABLE.table
        && !(state.newGuessOff && state.newGuessOff[seat])) {
        const dd = byId.get(b.defender), aa = byId.get(b.attacker);
        if (EAT_ANY_FOUGHT && !(state.battles || []).some((x) => x !== b
          && (x.attacker === b.defender || x.defender === b.defender))) continue;
        if (dd && aa && dd.owner !== seat && aa.owner !== seat) {
          // 闸门看的是**攻方**：表描述的是「攻击者怎么选子」，不是守方
          if ((humanOpp(state, aa.owner) || EAT_ANY_AI)
            && !(state.eatAnyOff && state.eatAnyOff[aa.owner])) {
            const arow = rows.get(aa.id);
            // 守方刚被吃掉，通常已经不在活子表里：退回它死前的快照（beliefRows 会写回 piece），
            // 都没有就放弃这一条（拿不到守方分布，似然无从边缘化）。
            const drow = rows.get(dd.id)
              || (dd.__brows && dd.__brows[seat])
              || ((dd.type && G.visibleTo(state, seat, dd)) ? new Map([[dd.type, 1]]) : null);
            if (arow && arow.size && drow && drow.size) {
              const tbl = Object.create(null);   // 注意：reweightRow 用 tbl[t] 下标访问
              let sum = 0;
              for (const [dt, pd] of drow) {
                const et = EAT_TABLE.table[dt];
                if (!et) continue;
                for (const t of TYPES) {
                  const v = (et[t] || 0) * pd;
                  if (!(v > 0)) continue;
                  tbl[t] = (tbl[t] || 0) + v;
                  sum += v;
                }
              }
              if (sum > 0) {
                const next = reweightRow(arow, tbl, EAT_ANY_K, true);
                if (next) { rows.set(aa.id, next); EAT_STATS.any += 1; }
              }
            }
          }
        }
      }
      // ① 我方守死：对方是攻方 → 猜攻方（它吃过我方的子）
      if (b.outcome === "attacker") {
        if (!EAT_ON || !EAT_TABLE || !EAT_TABLE.table) continue;
        const dd = byId.get(b.defender), aa = byId.get(b.attacker);
        if (!dd || !aa) continue;
        if (dd.owner !== seat) continue;             // 必须是自己的子，我才确定它的军衔
        if (aa.owner === seat) continue;
        if (!humanOpp(state, aa.owner)) continue;    // 表是人类的，别套到 AI 头上
        const row = rows.get(aa.id);
        if (!row || !row.size) continue;
        const tbl = EAT_TABLE.table[dd.type];
        if (!tbl) continue;
        const next = reweightRow(row, tbl, EAT_K);
        if (!next) continue;
        rows.set(aa.id, next);
        EAT_STATS.cut += 1;
        continue;
      }
      // ② 我方攻死：对方是守方 → 猜守方（它站在那里没动，把我方的子吃了）
      if (b.outcome !== "defender") continue;        // both 是同级或炸弹，两边都不带等级信息
      if (!DEFPRIOR_ON || !BATTLE_TABLE || !BATTLE_TABLE.defGivenAtt) continue;
      if (b.attSeat !== seat) continue;              // 必须是我方主动撞的，我才确定攻方军衔
      const dd = byId.get(b.defender);
      if (!dd || dd.owner === seat) continue;
      if (!humanOpp(state, dd.owner)) continue;
      const row = rows.get(dd.id);
      if (!row || !row.size) continue;
      const attType = b.attType;                     // 我方攻方，公开信息
      const tbl = attType && BATTLE_TABLE.defGivenAtt[attType];
      if (!tbl) continue;
      const next = reweightRow(row, tbl, DEFPRIOR_K, true);
      if (!next) continue;
      rows.set(dd.id, next);
      BATTLE_STATS.cut += 1;
    }
  }

  // ---- 同区格对条件化（ZPAIR，2026-11-03）----
  // 表由 training/build_zone_pair_table.js 从 12,964 份人类布阵学出：
  //   prior[cell]      = P(该开局格是大子)          —— 位置先验，r0c0 这种角位是 46%
  //   cond["a|b"]      = P(b 大 | a 大)，只存同区格对（五区口径，每区 6 格）
  // 留出法（按 gid 奇偶切训练/测试）：log loss 0.3092 → 0.2970，Brier 0.0951 → 0.0908。
  //
  // 为什么不用区均配额（旧的 ZQ_SOFT）：区均把「角位 46%」和「边位 13%」摊成一个数，
  // 一确认大子就整区乘 0.38，等于把 r0c0 的军长位也打成 17%，校准反而变差
  // （实测 log loss 0.3511 → 0.3929，ZQ_SOFT 因此默认关）。格对表天然区分了这两种格。
  //
  // 支持「软证据」：A 不必是确定的大子。若 A 只有 pa=0.45 是大子（比如它刚吃掉我方排长，
  // 见 training/probe_eat_rank.js），就按 P(B)=pa·P(B|A)+(1−pa)·P(B|¬A) 混合，
  // 不会像硬配额那样一次性把同区全打成小子。
  let ZPAIR = root.JUNQI_ZONE_PAIR || null;
  if (!ZPAIR && typeof require === "function") {
    try { ZPAIR = require("./training/out/zone_pair_table.json"); } catch (err) { ZPAIR = null; }
  }
  const ZPAIR_ON = _ENV.JJ_ZPAIR !== "0";
  const ZPAIR_STATS = { calls: 0, cut: 0, lrSum: 0 };

  /** "west-2-4" → 2*5+4（行在前列在后）。非法返回 -1。 */
  function cellIdxOf(pos) {
    if (!pos) return -1;
    const a = String(pos).split("-");
    const r = Number(a[1]), c = Number(a[2]);
    if (!(r >= 0 && r < 6 && c >= 0 && c < 5)) return -1;
    return r * 5 + c;
  }

  /** 这个子此刻「是大子」的后验概率：确定 = 1，有信念行 = 行内大子质量，只剩域 = 域内均分。 */
  function bigProbOf(state, seat, p, domains, rows) {
    const t = zoneKnownType(state, seat, p, domains);
    if (t) return ZONE_BIG.indexOf(t) >= 0 ? 1 : 0;
    const row = rows && rows.get(p.id);
    if (row && row.size) {
      let s = 0;
      for (const [k, w] of row) if (ZONE_BIG.indexOf(k) >= 0) s += w;
      return s;
    }
    const d = domains && domains.get(p.id);
    if (d && d.size) {
      let n = 0;
      for (const k of d) {
        if (k === "bomb" || k === "mine" || k === "flag") continue;
        if ((RANK_NUM[k] || 0) >= 38) n += 1;
      }
      return n / d.size;
    }
    return 0;
  }

  function applyZonePair(state, seat, rows, byId2, domains) {
    if (!ZPAIR_ON || !ZPAIR || !ZPAIR.cond || !rows || !rows.size) return;
    const prior = ZPAIR.prior, cond = ZPAIR.cond;
    ZPAIR_STATS.calls += 1;
    const byOwner = new Map();
    for (const p of state.pieces) {
      if (p.owner === seat) continue;
      const cell = cellIdxOf(initPosOf(state, p));
      if (cell < 0) continue;
      if (!byOwner.has(p.owner)) byOwner.set(p.owner, []);
      byOwner.get(p.owner).push({ id: p.id, cell, p });
    }
    for (const [, list] of byOwner) {
      for (const B of list) {
        const row = rows.get(B.id);
        if (!row || !row.size) continue;
        if (!humanOpp(state, B.p.owner)) continue;   // 同上：只对真人座位生效
        let cur = 0;
        for (const [k, w] of row) if (ZONE_BIG.indexOf(k) >= 0) cur += w;
        if (!(cur > 0.002) || cur > 0.85) continue;   // 已几乎锁成大子的别再动，避免把硬证据翻掉
        let lr = 1, usedA = 0;
        for (const A of list) {
          if (A.id === B.id) continue;
          const rec = cond[A.cell + "|" + B.cell];
          if (!rec) continue;                            // 表里只存同区对 ⇒ 异区自动跳过
          const pB = prior[B.cell], pA0 = prior[A.cell];
          if (!(pB > 0.004)) continue;
          const pa = bigProbOf(state, seat, A.p, domains, rows);
          if (pa <= 0.02) continue;
          // P(B 大 | A 不是大) 由边际恒等式反解：P(B)=pA·P(B|A)+(1−pA)·P(B|¬A)
          const pbNotA = Math.max(0.002, (pB - pA0 * rec.p) / Math.max(1e-6, 1 - pA0));
          const target = pa * rec.p + (1 - pa) * pbNotA;
          if (!(target > 0)) continue;
          lr *= target / pB;
          usedA += 1;
        }
        if (!usedA) continue;
        // 多个占位子时叠乘会过冲（同一份配额被重复计），用几何阻尼
        if (usedA > 1) lr = Math.pow(lr, 1 / Math.sqrt(usedA));
        lr = Math.min(6, Math.max(0.05, lr));
        if (Math.abs(lr - 1) < 0.02) continue;
        let sum = 0;
        const next = new Map();
        for (const [k, w] of row) {
          const v = ZONE_BIG.indexOf(k) >= 0 ? w * lr : w;
          if (v > 0) { next.set(k, v); sum += v; }
        }
        if (!(sum > 0) || next.size < 2) continue;
        for (const [k, v] of next) next.set(k, v / sum);
        rows.set(B.id, next);
        ZPAIR_STATS.cut += 1;
        ZPAIR_STATS.lrSum += lr;
      }
    }
  }

  function zoneQuota(state, seat, owner, domains) {
    if (!domains) return null;
    const zones = new Map();          // zone -> { used, hidden: [id] }
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      const z = zoneOfPos(initPosOf(state, p));
      if (!z) continue;
      let rec = zones.get(z);
      if (!rec) { rec = { used: 0, hidden: [] }; zones.set(z, rec); }
      const kt = zoneKnownType(state, seat, p, domains);
      if (kt) { if (ZONE_BIG.indexOf(kt) >= 0) rec.used += 1; }
      else if (p.position) rec.hidden.push(p.id);
    }
    ZONEQ_STATS.calls += 1;
    let out = null;
    for (const [z, rec] of zones) {
      const cap = ZONE_CAP[z];
      const hk = z + ":" + Math.min(rec.used, 3);
      ZONEQ_STATS.usedHist[hk] = (ZONEQ_STATS.usedHist[hk] || 0) + 1;
      if (cap === undefined || rec.used < cap || !rec.hidden.length) continue;
      const clones = new Map();
      let bad = false;
      for (const id of rec.hidden) {
        const d = domains.get(id);
        if (!d) continue;
        const nd = new Set(d);
        for (const t of ZONE_BIG) nd.delete(t);
        if (!nd.size) { bad = true; break; }
        if (nd.size !== d.size) clones.set(id, nd);
      }
      if (bad) { ZONEQ_STATS.rollbacks += 1; continue; }
      if (!clones.size) continue;
      if (!out) out = new Map(domains);
      for (const [id, nd] of clones) out.set(id, nd);
      ZONEQ_STATS.zonesFull += 1;
      ZONEQ_STATS.cutPieces += clones.size;
    }
    return out;
  }

  // ==================== 轨迹乘子（查表） ====================
  // 表来自 training/build_track_table.py，分母是「已动子空间的 21 枚可动子」。
  // 这块空间 inferDomains 的掩码全是 1（已动 ⇒ 排除雷旗；未拐弯 ⇒ 不锁工兵），
  // 所以进营习惯、铁路跨度、首发手数这些战术习惯是**正交信号**，不会被硬约束吃掉。
  let TRACK_TABLE = root.JUNQI_TRACK_TABLE || null;
  if (!TRACK_TABLE && typeof require === "function") {
    try { TRACK_TABLE = require("./training/out/track_table.json"); } catch (err) { TRACK_TABLE = null; }
  }
  const CAMP_IDS = new Set();
  for (const n of B.BOARD.nodes) if (n.kind === "camp") CAMP_IDS.add(n.id);
  // 用 JGS 坐标算跨度：board.js 把中央九格挤成 7/8/9，直接量会偏大
  const jx = (n) => (n.seat === null ? 6 + 2 * n.col : n.x);
  const jy = (n) => (n.seat === null ? 6 + 2 * n.row : n.y);

  function trackStats(state, piece) {
    const tape = state.moveTape;
    if (!tape || !tape.length || !piece) return null;
    let first = -1, camps = 0, maxSpan = 0, longs = 0, moves = 0;
    const base = Math.max(0, (state.moveCount || tape.length) - tape.length);
    for (let i = 0; i < tape.length; i += 1) {
      const m = tape[i];
      if (m.piece !== piece.id) continue;
      moves += 1;
      if (first < 0) first = base + i + 1;
      if (CAMP_IDS.has(m.to)) camps += 1;
      const a = B.BOARD.byId.get(m.from);
      const b = B.BOARD.byId.get(m.to);
      if (!a || !b) continue;
      const span = Math.abs(jx(a) - jx(b)) + Math.abs(jy(a) - jy(b));
      if (span > maxSpan) maxSpan = span;
      if (span >= 2) longs += 1;
    }
    if (!moves) return null;
    return { first, camps, maxSpan, longs };
  }

  function trackPriorRow(state, piece) {
    if (!TRACK_ON || !TRACK_TABLE || !piece) return null;
    const st = trackStats(state, piece);
    if (!st) return null;                       // 没动过的子，表不覆盖
    const M = TRACK_TABLE.mult;
    const keys = [];
    if (st.camps === 0) keys.push("camp_0");
    else if (st.camps === 1) keys.push("camp_1");
    else keys.push("camp_2p");
    if (st.maxSpan <= 1) keys.push("span_1");
    else if (st.maxSpan <= 3) keys.push("span_23");
    else keys.push("span_4p");
    if (st.longs === 0) keys.push("lm_0");
    else if (st.longs === 1) keys.push("lm_1");
    else keys.push("lm_2p");
    if (st.first <= 8) keys.push("first_le8");
    else if (st.first <= 23) keys.push("first_9_23");
    else keys.push("first_ge24");
    const out = new Map();
    for (const t of TYPES) {
      let w = 1;
      let hit = 0;
      for (const k of keys) {
        const row = M[k];
        if (!row || row[t] === undefined) continue;
        w *= row[t];
        hit += 1;
      }
      // 四个维度是独立统计的，直接连乘会过度自信，开 hit 次方收回均值
      out.set(t, hit ? Math.min(9, Math.max(0.15, Math.pow(w, 2 / hit))) : 1);
    }
    return out;
  }

  // ==================== 战果乘子（查表） ====================
  // 表来自 training/build_fate_table.py：P(兵种|战果) / P(兵种)。
  // 死亡类事件是**一次性终态**（触发即出局），只有 act_win / pas_win 能累积。
  let FATE_TABLE = root.JUNQI_FATE_TABLE || null;
  if (!FATE_TABLE && typeof require === "function") {
    try { FATE_TABLE = require("./training/out/fate_table.json"); } catch (err) { FATE_TABLE = null; }
  }

  function fateState(state, piece) {
    if (!FATE_TABLE || !piece) return null;
    const b = state.battles;
    if (!b || !b.length) return "quiet";
    let aw = 0, pw = 0, died = null;
    for (const x of b) {
      if (x.attacker === piece.id) {
        if (x.outcome === "attacker") aw += 1;
        else if (x.outcome === "both") died = "act_trade";
        else died = "act_die";
      } else if (x.defender === piece.id) {
        if (x.outcome === "defender") pw += 1;
        else if (x.outcome === "both") died = "pas_trade";
        else died = "pas_die";
      }
    }
    if (died) return died;
    if (aw >= 2) return "act_win_2p";
    if (aw === 1) return "act_win_1";
    if (pw >= 2) return "pas_win_2p";
    if (pw === 1) return "pas_win_1";
    return "quiet";
  }

  function fatePriorRow(state, piece) {
    if (!FATE_ON || !FATE_TABLE || !piece) return null;
    const k = fateState(state, piece);
    const m = k && FATE_TABLE.mult[k];
    if (!m) return null;
    // applyPrior 会再开 FORM_A(0.5) 次方，这里先开方抵消，让乘子以原始强度生效
    const out = new Map();
    for (const t of TYPES) out.set(t, Math.sqrt(m[t] === undefined ? 1 : m[t]));
    return out;
  }

  // 行归一 + 列配额同时约束。beliefProbs 里的迭代逻辑抽出来，供矩阵复用。
  function ipfFit(pairs, pool, iters) {
    if (!pool) return;
    const renorm = (row) => {
      let s = 0;
      for (const [, v] of row) s += v;
      if (s > 1e-9) for (const [t, v] of row) row.set(t, v / s);
    };
    for (const [, row] of pairs) renorm(row);
    for (let it = 0; it < (iters || 6); it += 1) {
      const mass = {};
      for (const [, row] of pairs) for (const [t, v] of row) mass[t] = (mass[t] || 0) + v;
      let moved = 0;
      for (const t of Object.keys(mass)) {
        const need = pool[t] || 0;
        const have = mass[t] || 0;
        if (have <= 1e-9) continue;
        if (need <= 1e-9) {
          for (const [, row] of pairs) if (row.has(t)) { row.set(t, 0); renorm(row); }
          moved += 1;
          continue;
        }
        const k = need / have;
        if (Math.abs(k - 1) < 5e-4) continue;
        moved += 1;
        for (const [, row] of pairs) if (row.has(t)) row.set(t, row.get(t) * k);
        for (const [, row] of pairs) renorm(row);
      }
      if (!moved) break;
    }
  }

  // priorOf(id) 可选：阵法/位置先验。**必须先乘进初始行再 IPF**，
  // 否则先验会破坏列配额（实测司令列和 1.18 / 1）。
  function beliefMatrix(state, seat, owner, domains, priorOf, fateOn, trackOn, quotaOn, quotaAc3, zoneOn) {
    if (!domains) return null;
    const useFate = fateOn === undefined ? FATE_ON : fateOn;
    const useTrack = trackOn === undefined ? TRACK_ON : trackOn;
    const useQuota = quotaOn === undefined ? QUOTA_ON : quotaOn;
    let dom = domains;
    let qInfo = null;
    if (useQuota) {
      qInfo = quotaPropagate(state, seat, owner, domains, quotaAc3);
      if (qInfo) dom = qInfo.domains;
    }
    // 分区大子配额：在全局配额之后再砍一刀（硬排除同区的司/军/师）
    if (zoneOn === undefined ? ZONEQ_ON : zoneOn) {
      const zq = zoneQuota(state, seat, owner, dom);
      if (zq) dom = zq;
    }
    const pool = Object.assign({}, STANDARD_POOL);
    const rows = new Map();        // id -> Map(type, w)
    const aliveIds = [];
    let deadN = 0;
    for (const p of state.pieces) {
      if (p.owner !== owner) continue;
      if (p.position && G.visibleTo(state, seat, p)) {
        pool[p.type] = (pool[p.type] || 0) - 1;    // 亮着的活子：确定
        rows.set(p.id, new Map([[p.type, 1]]));
        continue;
      }
      if (p.position) { aliveIds.push(p.id); continue; }
      // ---- 死子 ----
      deadN += 1;
      let d = null;
      if (p.revealed) d = new Map([[p.type, 1]]);
      else if (p.__brows && p.__brows[seat] instanceof Map && p.__brows[seat].size) {
        d = p.__brows[seat];      // 死前快照（必须是 Map：存档走 JSON 会把 Map 变成 {}）
      }
      if (!d) {
        // 没有快照（这一版之前的死亡、或不是 AI 自己下的局）：退回「该子当时的域
        // × 当前剩余配额」的均匀估计。死子的域在 inferDomains 里通常是空的
        // （position=null 拿不到格位约束），那就用全集。
        const pd = dom.get(p.id);
        const ds = (pd && pd.size) ? pd : new Set(TYPES);
        const fm0 = useFate ? fatePriorRow(state, p) : null;
        const tm0 = useTrack ? trackPriorRow(state, p) : null;
        const fm = (fm0 || tm0) ? (() => {
          const m = new Map();
          for (const t of TYPES) m.set(t, (fm0 ? (fm0.get(t) || 1) : 1) * (tm0 ? (tm0.get(t) || 1) : 1));
          return m;
        })() : null;
        d = new Map();
        let s = 0;
        for (const t of ds) {
          let w = pool[t] || 0;
          if (fm) w *= (fm.get(t) || 1);
          if (w > 0) { d.set(t, w); s += w; }
        }
        if (!s) { for (const t of ds) { d.set(t, 1); s += 1; } }
        for (const [t, v] of d) d.set(t, v / s);
      }
      rows.set(p.id, d);
      for (const [t, w] of d) pool[t] = (pool[t] || 0) - w;
    }
    for (const t of Object.keys(pool)) if (pool[t] < 0) pool[t] = 0;

    if (aliveIds.length) {
      const pairs = [];
      for (const id of aliveIds) {
        const d = dom.get(id);
        if (!d || !d.size) continue;
        const u = 1 / d.size;
        let row = new Map();
        for (const t of d) row.set(t, u);
        const pr = priorOf ? priorOf(id) : null;
        if (pr) row = applyPrior(row, pr);
        pairs.push([id, row]);
      }
      ipfFit(pairs, pool, 14);
      for (const [id, row] of pairs) rows.set(id, row);
    }
    return { rows, pool, deadN, aliveN: aliveIds.length, locks: qInfo ? qInfo.locks : 0 };
  }

  // 敌方现存最强等级：从 40 往下扫，取「至少有一枚是这样的概率」过半的最高档。
  function estTopRank(list, probs) {
    let top = 0;
    for (let r = 40; r >= 32; r -= 1) {
      const type = REL_BY_RANK[r];
      if (!type) continue;
      let miss = 1;
      for (const it of list) {
        const row = probs.get(it.id);
        if (!row) continue;
        miss *= (1 - (row.get(type) || 0));
      }
      if (1 - miss >= 0.5) { top = r; break; }
    }
    return top;
  }

  // 阵亡那一刻还有一条便宜的证据：它是怎么死的。
  // 「被我的团长吃掉」⇒ 它当时 ≤ 团长，不是司令；「与我同归于尽」⇒ 同级或是炸。
  // 快照是死前记的，没含这条约束，所以结算前先用战报把它过滤一遍。
  function refineRow(state, seat, id, row) {
    const battles = state.battles || [];
    for (let i = battles.length - 1; i >= 0; i -= 1) {
      const b = battles[i];
      if (b.attacker !== id && b.defender !== id) continue;
      const isDef = b.defender === id;
      const oppId = isDef ? b.attacker : b.defender;
      let oppType = null;
      if (isDef && b.attType && b.attSeat && ally(b.attSeat, seat)) oppType = b.attType;
      if (!oppType) {
        const opp = state.pieces.find((p) => p.id === oppId);
        if (opp && opp.position && G.visibleTo(state, seat, opp)) oppType = opp.type;
      }
      if (!oppType) continue;
      const inHq = !!b.inHq;
      let sum = 0;
      for (const t of Object.keys(row)) {
        const ok = isDef
          ? battleOutcome(oppType, t, inHq, state.mode) === b.outcome
          : battleOutcome(t, oppType, inHq, state.mode) === b.outcome;
        if (ok) sum += row[t]; else row[t] = 0;
      }
      if (sum > 1e-9) for (const t of Object.keys(row)) row[t] /= sum;
      return row;
    }
    return row;
  }

  // 主函数：某一座位此刻的兵力账。
  //   me    我这边的子（类型全知道，精确）
  //   mate  对家（四暗里我看不见它的牌，同样要估）
  //   foes  两个敌人（只数得出死了几个，值多少钱靠猜）
  //
  // 顺序很关键：先用「上一轮记下的兵种分布」把新阵亡的子从配额里扣掉，再重新算活着的子。
  // 不扣的话配额永远是满的——死掉 10 枚以后，剩下 15 枚仍被算成 369 分，
  // 敌方剩余子力就系统性虚高（实测净差被低估 40 分以上）。
  function forceLedger(state, seat, mem, domains) {
    const dv = domains || inferDomains(state, seat, mem);
    if (!state.aiForce) state.aiForce = {};
    let book = state.aiForce[seat];
    if (!book || !book.rows) {
      book = { rows: {}, spent: {}, acc: {}, paid: {} };
      state.aiForce[seat] = book;
    }

    // ---- 1) 每个「我看不见牌」的座位：基础配额 + 在场子清单 ----
    const base = new Map();
    const aliveList = {};
    const deadCount = {};
    for (const p of state.pieces) {
      if (p.owner === seat) continue;
      if (!base.has(p.owner)) {
        base.set(p.owner, seatPools(state, seat, p.owner));
        aliveList[p.owner] = [];
        deadCount[p.owner] = 0;
      }
      if (p.position) aliveList[p.owner].push({ id: p.id, owner: p.owner });
      else deadCount[p.owner] += 1;
    }
    // 阵亡数一律用「25 − 在盘上」算，不用数 position 为空的子：
    // 一家被扛旗后 eliminate() 会把剩下的子直接从数组里删掉，数不出来但确实是没了。
    for (const s2 of Object.keys(aliveList)) {
      deadCount[s2] = state.mode === "standard"
        ? Math.max(0, 25 - aliveList[s2].length)
        : Math.max(deadCount[s2], 25 - aliveList[s2].length);
    }

    // ---- 2) 用「已经花掉的配额」修正 ----
    const poolsWith = (spent) => {
      const out = new Map();
      for (const [s2, b] of base) {
        if (!b) { out.set(s2, null); continue; }
        const sp = (spent && spent[s2]) || {};
        const p = {};
        for (const t of Object.keys(b)) p[t] = Math.max(0, b[t] - (sp[t] || 0));
        out.set(s2, p);
      }
      return out;
    };

    // ---- 3) 结算新阵亡：按它死之前我记下的分布，扣配额 + 记价值 ----
    for (const s2 of Object.keys(aliveList)) {
      const prev = book.paid[s2] || 0;
      if (deadCount[s2] <= prev) continue;
      let rowsLeft = book.rows;
      const gains = [];
      // 上一轮还在、现在不在的 id = 新阵亡的
      for (const id of Object.keys(rowsLeft)) {
        if (gains.length >= deadCount[s2] - prev) break;
        if (state.pieces.some((q) => q.id === id && q.position)) continue;
        gains.push(refineRow(state, seat, id, rowsLeft[id]));
      }
      if (!book.spent[s2]) book.spent[s2] = {};
      if (!book.acc[s2]) book.acc[s2] = 0;
      for (const row of gains) {
        let v = 0;
        for (const t of Object.keys(row)) {
          book.spent[s2][t] = (book.spent[s2][t] || 0) + row[t];
          v += row[t] * (FORCE_VALUE[t] || 0);
        }
        book.acc[s2] += v;
      }
      const lack = deadCount[s2] - prev - gains.length;
      if (lack > 0) {
        // 快照里找不到（一次死太多、刚载入存档、或被扛旗后整家被清场）：
        // 按「这个座位还剩多少没能认领的配额」的平均单价结算，并把配额一次性扣完，
        // 否则被清场那家的子会凭空留在配额里，敌方剩余子力又被算高。
        const b = base.get(s2);
        let cnt = 0, val = 0;
        if (b) {
          const sp = book.spent[s2] || {};
          for (const t of Object.keys(b)) {
            const left = Math.max(0, b[t] - (sp[t] || 0));
            cnt += left;
            val += left * (FORCE_VALUE[t] || 0);
            book.spent[s2][t] = b[t];
          }
        }
        const unit = cnt > 0 ? val / cnt : 0;
        book.acc[s2] += unit * lack;
      }
      book.paid[s2] = deadCount[s2];
    }

    // ---- 4) 用修正后的配额算「活着的暗子」 ----
    const pools = poolsWith(book.spent);
    const probs = new Map();
    for (const s2 of Object.keys(aliveList)) {
      const pr = beliefProbs(aliveList[s2], dv, pools.get(s2));
      for (const [id, row] of pr) probs.set(id, row);
    }

    // ---- 5) 记账 ----
    const blank = () => ({ alive: 0, value: 0, dead: 0, deadValue: 0, top: 0, flagAlive: false });
    const me = blank();
    const mate = ALLY_OF[seat] ? blank() : null;
    const foes = {};
    for (const p of state.pieces) {
      const own = p.owner === seat;
      const friendly = own || ally(p.owner, seat);
      const bag = own ? me : (friendly ? mate : (foes[p.owner] || (foes[p.owner] = blank())));
      if (!bag) continue;
      if (!p.position) {
        bag.dead += 1;
        if (own || p.revealed) bag.deadValue += FORCE_VALUE[p.type] || 0;
        continue;                                   // 敌方的由上面 book.acc 补
      }
      bag.alive += 1;
      if (own || G.visibleTo(state, seat, p)) {
        bag.value += FORCE_VALUE[p.type] || 0;
        const r = RANK_NUM[p.type] || 0;
        if (r > bag.top) bag.top = r;
        if (p.type === "flag") bag.flagAlive = true;
      } else {
        const row = probs.get(p.id);
        bag.value += row ? rowValue(row) : 0;
      }
    }
    if (mate) {
      mate.deadValue = book.acc[ALLY_OF[seat]] || 0;
      mate.top = estTopRank(aliveList[ALLY_OF[seat]] || [], probs);
    }
    for (const s2 of Object.keys(foes)) {
      foes[s2].deadValue = book.acc[s2] || 0;
      foes[s2].top = estTopRank(aliveList[s2] || [], probs);
    }

    // ---- 6) 刷新快照（下一轮结算用） ----
    const rows = {};
    for (const s2 of Object.keys(aliveList)) {
      for (const it of aliveList[s2]) {
        const row = probs.get(it.id);
        if (!row) continue;
        const obj = {};
        for (const [t, v] of row) obj[t] = v;
        rows[it.id] = obj;
      }
    }
    book.rows = rows;

    let foeValue = 0, foeDead = 0, foeTop = 0;
    for (const s2 of Object.keys(foes)) {
      foeValue += foes[s2].value;
      foeDead += foes[s2].deadValue;
      if (foes[s2].top > foeTop) foeTop = foes[s2].top;
    }
    const myTeamValue = me.value + (mate ? mate.value : 0);
    return {
      me, mate, foes, foeValue, foeDead, foeTop, pools, probs,
      teamValue: myTeamValue,
      edge: myTeamValue - foeValue,                                    // 盘面净差（正 = 我方占优）
      trade: foeDead - (me.deadValue + (mate ? mate.deadValue : 0)),    // 交换比
      topGap: Math.max(me.top, mate ? mate.top : 0) - foeTop,
    };
  }

  // 给「人看」的兵力账：一行字说清现在谁强谁弱、换子赚不赚。
  // 只读公开信息 + 身份域，所以拿去展示不会泄露暗子（四暗里它本来就只是估计）。
  function forceReport(state, seat) {
    const mem = rankMemory(state, seat);
    const fl = forceLedger(state, seat, mem, inferDomains(state, seat, mem));
    const sgn = (v) => (v > 0 ? "+" : "") + v.toFixed(0);
    const foes = Object.keys(fl.foes);
    const foeTxt = foes.map((s2) => {
      const f = fl.foes[s2];
      return `${s2} 存 ${f.value.toFixed(0)}（${f.alive} 枚，估最强 ${f.top || "?"}）`;
    }).join("；");
    const verdict = fl.edge > 80 ? "我方明显占优" : (fl.edge < -80 ? "我方明显吃亏"
      : (Math.abs(fl.edge) <= 30 ? "均势" : (fl.edge > 0 ? "略优" : "略亏")));
    return {
      结论: verdict,
      盘面净差: sgn(fl.edge),
      交换比: sgn(fl.trade),
      我方: { 存: Math.round(fl.me.value), 损: Math.round(fl.me.deadValue), 最强: fl.me.top },
      对家: fl.mate ? { 存: Math.round(fl.mate.value), 损: Math.round(fl.mate.deadValue), 最强: fl.mate.top } : null,
      敌方: Object.fromEntries(foes.map((s2) => [s2, {
        存: Math.round(fl.foes[s2].value), 损: Math.round(fl.foes[s2].deadValue),
        阵亡数: fl.foes[s2].dead, 估最强: fl.foes[s2].top,
      }])),
      一句话: `${verdict}（净差 ${sgn(fl.edge)}，交换 ${sgn(fl.trade)}）；${foeTxt}`,
    };
  }

  // 「两步内丢旗」的威胁数；0 表示安全。override 用来评估「走完这一步之后」的局面。
  // 注意：真实局面的棋子是 position(字符串)，抽样的世界是 pos(编号)，这里统一转成编号。
  function flagView(state) {
    const list = [];
    const board = new Array(N.length).fill(null);
    for (const p of state.pieces) {
      if (!p.position) continue;
      const pos = IDX.get(p.position);
      if (pos === undefined) continue;
      const item = { ref: p, pos, type: p.type, owner: p.owner, id: p.id };
      list.push(item);
      board[pos] = item;
    }
    return { list, board };
  }

  function flagRisk(state, seat, mem, domains, override) {
    const flag = state.pieces.find((p) => p.owner === seat && p.type === "flag" && p.position);
    if (!flag) return 0;
    const F = IDX.get(flag.position);
    if (F === undefined) return 0;
    const mouths = ROADS[F];
    if (!mouths || !mouths.length) return 0;
    const { list, board } = flagView(state);
    const rows = BEAT_ON ? beliefRows(state, seat, list, domains) : null;
    if (override) {
      board[override.src] = null;
      board[override.dst] = override.mover;
    }
    let risk = 0;
    for (const e of list) {
      if (ally(e.owner, seat)) continue;
      // 同上：不能拿敌方真实兵种判断「它不能动」。只有已亮明的才排除，
      // 暗子交给 beatsProb（走身份域 + 地雷概率）自己压低。
      if (G.visibleTo(state, seat, e.ref) && B.PIECE_INFO[e.type] && B.PIECE_INFO[e.type].immobile) continue;
      if (override && e.ref === override.mover) continue;
      let best = 0;
      for (const m of mouths) {
        if (!canReachCell(board, e, m)) continue;
        const holder = board[m];
        // 守方若是看不见的子（敌方的），不能拿它的真实兵种来算，退回旧口径
        const hk = !holder || !holder.ref || G.visibleTo(state, seat, holder.ref);
        const pBeat = beatsProb(domains, e, holder && holder.ref,
          hk ? (rows && rows.get(e.id)) : null);
        if (pBeat < FLAG_T) continue;
        if (canAnswer(state, seat, board, m, e, mem, domains, override)) continue;
        if (pBeat > best) best = pBeat;
      }
      risk += best;
    }
    return risk;
  }

  // ==================== 敌方令子的处置 ====================
  // 军棋理论 94：先失令子一方胜率只有 33%。对敌方令子的正解不是躲，而是
  // ①出炸（炸换司令是大赚）②等级够就吃 ③把炸摆到饵子后面，等它来撞（骗）。
  // 这里只做「已知下界 ≥39」的明牌令子，未知的不猜。
  const DOM_BOMB_BONUS = 200;
  const DOM_KILL_BONUS = 120;
  const DOM_BAIT_BONUS = 70;

  function enemyDominants(state, seat, mem, domains) {
    const out = [];
    if (!mem) return out;
    for (const p of state.pieces) {
      if (!p.position || ally(p.owner, seat)) continue;
      const floor = knownFloor(mem, domains, p.id);
      if (floor >= 39) out.push({ id: p.id, floor, pos: IDX.get(p.position) });
    }
    return out;
  }

  function dominantScore(state, seat, move, doms) {
    if (!doms || !doms.length) return 0;
    const a = G.pieceAt(state, move.from);
    const d = G.pieceAt(state, move.to);
    if (!a) return 0;
    const dst = IDX.get(move.to);
    if (dst === undefined) return 0;
    let sc = 0;
    if (d) {
      const hit = doms.find((x) => x.id === d.id);
      if (hit) {
        if (a.type === "bomb") sc += DOM_BOMB_BONUS;                  // 出炸：一炸换令子
        else if ((RANK_NUM[a.type] || 0) > hit.floor) sc += DOM_KILL_BONUS;
      }
    }
    // 骗：炸贴近我方饵子（连~师），饵子又正好挨着敌方令子 —— 它来吃，就撞炸
    if (a.type === "bomb" && !d) {
      for (const p of state.pieces) {
        if (p.owner !== seat || !p.position || p.id === a.id) continue;
        const r = RANK_NUM[p.type] || 0;
        if (r < 34 || r > 38) continue;
        const pp = IDX.get(p.position);
        if (pp === undefined || !ROADS[dst].includes(pp)) continue;
        if (!doms.some((x) => x.pos !== undefined && ROADS[pp].includes(x.pos))) continue;
        sc += DOM_BAIT_BONUS;
        break;
      }
    }
    return sc;
  }

  // 回合顺序：打上家，不打（或少打）下家。
  // 依据军棋理论 01 §15「打进攻最好打上家，别打下家」——打完上家他这一轮已经走过了，
  // 中间还隔着我和对家，他反应不过来；打下家他会立刻回手。
  // 四暗 3313 局实测（training/probe_coop4.py）：胜方打上家率比负方高 2.7pp（t=14），
  // 而一代 AI 现在恰好反着来（打下家 19.1% > 打上家 16.9%）。可用 JJ_TEMPO=0 关掉做 A/B。
  const TURN_NEXT = { south: "west", west: "north", north: "east", east: "south" };
  const TURN_PREV = { west: "south", north: "west", east: "north", south: "east" };
  const TEMPO_UP = (typeof process !== "undefined" && process.env && process.env.JJ_TEMPO !== undefined)
    ? Number(process.env.JJ_TEMPO) : 6;
  const TEMPO_DOWN = TEMPO_UP > 0 ? -TEMPO_UP * 0.8 : 0;

  // ==================== 配合三项：拆火 / 接应 / 轮换守家 ====================
  // 共同前提见 97 附录 G：判据是「这一步的价值是否取决于对家的局面」。
  // 权重都可用环境变量关掉做 A/B：JJ_DOM_RISK / JJ_RELAY / JJ_HOME。
  const ALLY_OF = { south: "north", north: "south", east: "west", west: "east" };
  const NUM = (env, def) => (typeof process !== "undefined" && process.env
    && process.env[env] !== undefined) ? Number(process.env[env]) : def;
  const DOM_RISK_PENALTY = NUM("JJ_DOM_RISK", 157);   // 「两步内丢令子」值多少分（220→157，同上按 1/1.4 重标）
  // 威胁项按子力加权 + 覆盖到旅长/团长（2026-11-05）。**默认关**：104 局实测为负
  // （撞未知子赢 58.33% vs 60.37%，-2.05pp / z=-1.51；输 +1.87pp；净子力 5.40 vs 6.10；
  //  8 进程 2 正 6 负，两个指标同向）。机制是"少换子、多让路"——把旅长/团长也纳入躲避，
  //  AI 会为了保子放弃交换，丢的是进攻节奏。JJ_DOM_VAL=1 可开回来。
  const DOM_VAL_ON = _ENV.JJ_DOM_VAL === "1";
  // 深度上限跨手记忆（2026-11-05 晚）。JJ_CEIL=0 退回「每手从 D_CAP 重新探边」做 A/B。
  const CEIL_MEM = _ENV.JJ_CEIL !== "0";
  const MATE_FLAG_PENALTY = NUM("JJ_MATE_FLAG", 120); // 「对家两步内丢旗」值多少分（轮换守家）
  const RELAY_BONUS = NUM("JJ_RELAY", 10);            // 接应：落点贴着对家上一手落点
  const HOME_BONUS = NUM("JJ_HOME", 12);              // 轮换守家：补对家的后场（实测几乎不触发）
  const DISTRACT_BONUS = NUM("JJ_DISTRACT", 14);      // 牵制：对家刚被吃，我去找他麻烦

  const DOM_STATS = { riskBase: 0, withRisk: 0, reduced: 0, same: 0, worse: 0,
                      relay: 0, home: 0, chosen: 0, chosenReduced: 0, chosenWorse: 0, distract: 0,
                      // 身份域健康度：conflict = 域与某场战果对不上（约束打架）；
                      // emptyDomain = 域被推空后退回 initialDomain（信息丢失）
                      conflict: 0, emptyDomain: 0 };

  function cellRow(id) {                     // "south-4-1" -> 4（行营等无座位前缀的返回 -1）
    const m = /^[a-z]+-(\d+)-(\d+)$/.exec(id || "");
    return m ? Number(m[1]) : -1;
  }
  function cellSeat(id) {
    const m = /^([a-z]+)-\d+-\d+$/.exec(id || "");
    return m ? m[1] : null;
  }

  // 我方/对家的高价值子（师以上）被敌方「一步能碰到且可能吃得掉」= 令子风险
  function domRisk(state, seat, mem, domains, override) {
    const friend = ALLY_OF[seat] ? [seat, ALLY_OF[seat]] : [seat];
    const dval = state.domValOn ? !!state.domValOn[seat] : DOM_VAL_ON;
    const { list, board } = flagView(state);
    const rows = BEAT_ON ? beliefRows(state, seat, list, domains) : null;
    if (override) {
      board[override.src] = null;
      board[override.dst] = override.mover;
    }
    let risk = 0;
    for (const v of list) {
      if (friend.indexOf(v.owner) < 0) continue;
      const myR = RANK_NUM[v.type] || 0;
      // 覆盖范围（2026-11-05）：原来只看 myR>=38，即司令/军长/师长三枚。
      // 但旅长值 50、团长值 38 —— 一枚旅长是三枚连长，被大子白吃一样是塌方，
      // 却完全不在威胁评估里（`domRisk` 是我方子被吃风险进入**空走决策**的唯一通路）。
      // 降到 myR>=36（团长）纳入旅长/团长。JJ_DOM_VAL=0 退回旧口径做 A/B。
      if (myR < (dval ? 36 : 38)) continue;
      if (override && v.ref === override.mover) continue;
      // 权重按子力：原来司令和师长都乘同一个 DOM_RISK_PENALTY，等于「丢司令」和「丢师长」一样疼。
      // 改成 VALUES 归一（司令=1.0 保持原档位，军长 0.85、师长 0.70、旅长 0.50、团长 0.38）。
      // 注意这不是单纯加重防守：军长/师长是**减**权，旅长/团长是新增，是重新分配不是加码。
      const wSelf = dval ? (VALUES[v.type] || 60) / 100 : 1;
      let best = 0;
      for (const e of list) {
        if (friend.indexOf(e.owner) >= 0) continue;
        // 同上：暗子不能按真实兵种排除（否则等于看穿「哪枚是雷」）。
        if (G.visibleTo(state, seat, e.ref) && B.PIECE_INFO[e.type] && B.PIECE_INFO[e.type].immobile) continue;
        if (override && e.ref === override.mover) continue;
        if (!canReachCell(board, e, v.pos)) continue;
        // 令子是队友的子时我同样看不见，不能用它的真实兵种算，退回旧口径
        const vk = G.visibleTo(state, seat, v.ref);
        const pBeat = beatsProb(domains, e, v.ref, vk ? (rows && rows.get(e.id)) : null);
        // 未知子「是炸」的概率：炸碰到令子是必换，且我方还反吃不了。
        // 旧实现是 1/|身份域|（域内均匀），同样换成信念分布里的值
        let pBomb = 0;
        const rowE = rows && rows.get(e.id);
        if (rowE) pBomb = rowE.get("bomb") || 0;
        else {
          const dd = domains && domains.get(e.id);
          if (dd && dd.size) pBomb = dd.has("bomb") ? 1 / dd.size : 0;
          else if (!e.type) pBomb = 0.08;
        }
        const threat = Math.max(pBeat, pBomb * 1.6);
        if (threat < DOM_T) continue;
        if (threat > best) best = threat;
      }
      risk += best * wSelf;
    }
    return risk;
  }

  // ==================== 协同（COOP，2026-11-05）====================
  // 用户口径（11-05 深夜，复盘第 32 手的漏着）：「南方子插到西方腹地、下一步就能到军旗旁边，
  // 西方处理不了，东方应该用团长去吃掉它」。
  //
  // 原来引擎里**没有任何协同项**：唯一与对家有关的是 relayBonus（贴着对家上一手的落点，
  // 10 分），而它只进 rootPrior，rootPrior 进最终分数要乘 0.01 —— 实际 0.1 分，等于没有。
  // 这里补的是「敌人钻进对家后院」这一条，因为它是**公开信息**（只看位置，不看兵种），
  // 不涉及任何只有自己知道的真值。
  //
  // 权重设计：对家后两排（HQ/军旗所在行，row>=4）被侵入 = 最紧急（1.0）；
  // 中间两排 0.6；前沿 0.35。吃掉侵入者给 COOP_KILL，占住它向纵深推进的格子给 COOP_BLOCK。
  const COOP_ON = _num("JJ_COOP", 1) > 0;
  const COOP_KILL = _num("JJ_COOP_KILL", 190);
  const COOP_BLOCK = _num("JJ_COOP_BLOCK", 45);
  const COOP_STATS = { candidates: 0, kill: 0, block: 0 };

  // 触发率实测：任何「进入对家地界」的敌子都算侵入者时，62% 的步数都会触发 —— 太宽。
  // 前沿档压到 0.2（基本只当提示），重点放在对家后两排（军旗/雷区所在行）。
  function coopWeight(row) {
    if (row >= 4) return 1;        // 对家后两排：军旗/雷区
    if (row >= 2) return 0.55;
    if (row >= 0) return 0.2;
    return 0;
  }

  /**
   * 对家后院的侵入者。纯位置信息（公开），不看兵种。
   * 返回 { kill: Map(pieceId → 权重), block: Map(cellId → 权重) }：
   *   kill  = 直接吃掉侵入者值多少
   *   block = 占住「与侵入者相邻」的格子值多少（挡路/逼它回头）
   */
  function coopIntruders(state, seat) {
    const mate = ALLY_OF[seat];
    if (!mate) return null;
    const kill = new Map();
    const block = new Map();
    const nb = (B.BOARD && B.BOARD.neighbors) || {};
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (ally(p.owner, seat) || p.owner === seat) continue;
      if (cellSeat(p.position) !== mate) continue;
      const w = coopWeight(cellRow(p.position));
      if (!(w > 0)) continue;
      kill.set(p.id, w);
      for (const cid of (nb[p.position] || [])) {
        if (cellSeat(cid) !== mate) continue;      // 封堵本身也要落在对家地界里才有意义
        const cur = block.get(cid) || 0;
        const v = COOP_BLOCK * w;
        if (v > cur) block.set(cid, v);
      }
    }
    if (!kill.size && !block.size) return null;
    return { kill: kill, block: block };
  }

  /**
   * 我方这一手能不能打得过那个侵入者（按守方的信念行算）。
   * 返回 clamp(P(赢) − P(输), 0, 1)。不要只看"能不能走到"：
   * 排长跑去撞一个八成是司令的子，那不叫救援，叫送。
   */
  function coopOdds(row, myType) {
    if (!row) return 0.5;                       // 没有信念就当中性
    const myR = RANK_NUM[myType] || 0;
    if (!myR) return 0.5;                       // 工兵/炸/雷不走军衔比较
    let win = 0, lose = 0;
    for (const [t, p] of row) {
      if (t === "bomb") continue;               // 炸：双方都死，不改善也不恶化
      if (t === "mine") { lose += p; continue; }
      if (t === "flag") { win += p; continue; }
      const r = RANK_NUM[t] || 0;
      if (r < myR) win += p; else if (r > myR) lose += p;
    }
    const d = win - lose;
    return d > 1 ? 1 : (d < 0 ? 0 : d);
  }

  /** 这一手对「对家告急」值多少分（直接进最终分数，不走 prior 的 0.01 折算）。 */
  function coopBonus(state, seat, move, intr, rows) {
    if (!COOP_ON || !intr) return 0;
    if (state.coopOff && state.coopOff[seat]) return 0;
    let best = 0;
    const at = G.pieceAt(state, move.to);
    if (at && intr.kill.has(at.id)) {
      const w = intr.kill.get(at.id);
      const mover = G.pieceAt(state, move.from);
      const odds = mover ? coopOdds(rows && rows.get(at.id), mover.type) : 0.5;
      // 0.35 保底：就算打不过，把路挡住/换掉也常是必要的；打不过时不给满额
      best = COOP_KILL * w * (0.35 + 0.65 * odds);
    }
    const b = intr.block.get(move.to) || 0;
    if (b > best) best = b;
    return best;
  }

  // 接应：对家上一手刚落在某处，我这一手贴上去（同一路形成二连击）
  function relayBonus(state, seat, move) {
    if (!RELAY_BONUS) return 0;
    const mate = ALLY_OF[seat];
    const tape = state.moveTape || [];
    for (let i = tape.length - 1; i >= 0; i -= 1) {
      const t = tape[i];
      if (t.seat !== mate) continue;
      const to = IDX.get(move.to);
      const prev = IDX.get(t.to);
      if (to === undefined || prev === undefined) return 0;
      if (ROADS[prev] && ROADS[prev].indexOf(to) >= 0) return RELAY_BONUS;
      if (RAILS[prev] && RAILS[prev].indexOf(to) >= 0) return RELAY_BONUS * 0.6;
      return 0;
    }
    return 0;
  }

  // 牵制：敌人刚吃掉对家的子，我这一手就去找他麻烦（理论 01 四10「敌人打对家，你就打他」）
  function distractBonus(state, seat, move, profile) {
    if (!DISTRACT_BONUS) return 0;
    const mate = ALLY_OF[seat];
    if (!mate) return 0;
    const battles = state.battles || [];
    for (let i = battles.length - 1; i >= Math.max(0, battles.length - 4); i -= 1) {
      const b = battles[i];
      const atk = state.pieces.find((p) => p.id === b.attacker);
      const def = state.pieces.find((p) => p.id === b.defender);
      if (!atk || !def) continue;
      const mateLost = (def.owner === mate && b.outcome === "attacker")
        || (atk.owner === mate && b.outcome === "defender");
      if (!mateLost) continue;
      const enemySeat = atk.owner === mate ? def.owner : atk.owner;
      const d = G.pieceAt(state, move.to);
      if (d && d.owner === enemySeat) return DISTRACT_BONUS;
      return 0;
    }
    return 0;
  }

  // 夹击（双急所的配合版）：对家最近在压哪一家，我这一手也压同一家。
  // 依据（用户 2026-11-03 复盘第 3 手）：南方第 1 手打东家，北家司令直接从 north-0-4
  // 压到 east-0-0 —— 东家两面受敌，只能应一边。这不是「接应」（贴对家上一手落点），
  // 而是「同一个敌人被两路同时施压」，所以单独一项。
  // 信息条件：完全具备 —— 只用公开的走子记录与落点归属，不需要知道队友的军衔。
  // ⚠ 默认 0：同局对照 40 对（一队开一队关、隔局交换）开夹击 17 : 关 21，
  //   胜率 44.7%（38 局决出胜负，二项标准差约 8%）—— 数据不支持，先关着。
  //   要复测：JJ_PINCER=12 node training/probe_pincer_ab.js 60 30
  const PINCER_BONUS = NUM("JJ_PINCER", 0);
  function pincerBonus(state, seat, move) {
    if (!PINCER_BONUS) return 0;
    if (state.pincerOff && state.pincerOff[seat]) return 0;   // 同局 A/B 用：只关某一队
    const mate = ALLY_OF[seat];
    if (!mate) return 0;
    // 1) 对家最近 3 手压的是哪家：优先看它打了谁，其次看它落点在哪家地盘
    let foe = null;
    const battles = state.battles || [];
    for (let i = battles.length - 1; i >= Math.max(0, battles.length - 5); i -= 1) {
      const b = battles[i];
      const atk = state.pieces.find((p) => p.id === b.attacker);
      const def = state.pieces.find((p) => p.id === b.defender);
      if (atk && atk.owner === mate && def && def.owner !== mate && !ally(def.owner, seat)) {
        foe = def.owner;
        break;
      }
    }
    if (!foe) {
      const tape = state.moveTape || [];
      for (let i = tape.length - 1, n = 0; i >= 0 && n < 6; i -= 1, n += 1) {
        const t = tape[i];
        if (t.seat !== mate) continue;
        const s2 = cellSeat(t.to);
        if (s2 && s2 !== mate && !ally(s2, seat)) { foe = s2; break; }
      }
    }
    if (!foe) return 0;
    // 2) 我这一手是不是也压同一家：吃它的子 > 踏进它的地盘
    const d = G.pieceAt(state, move.to);
    if (d && d.owner === foe) return PINCER_BONUS * 1.6;
    if (cellSeat(move.to) === foe) return PINCER_BONUS;
    return 0;
  }

  // 轮换守家：对家主力出去了、他后场很空，我往他后场补一手
  function homeCoverBonus(state, seat, move) {
    if (!HOME_BONUS) return 0;
    const mate = ALLY_OF[seat];
    if (!mate) return 0;
    if (cellSeat(move.to) !== mate) return 0;          // 只有走进对家地盘才算
    if (cellRow(move.to) < 3) return 0;                // 后三排（大本营那一侧）
    let mine = 0, hisBack = 0;
    for (const p of state.pieces) {
      if (!p.position) continue;
      if (cellSeat(p.position) !== mate) continue;
      if (p.owner === mate && cellRow(p.position) >= 3) hisBack += 1;   // 他自己后三排还剩几个
      else if (p.owner === seat) mine += 1;                            // 我已经在他那边几个
    }
    // 他后场空了（≤2 枚）而我在那边也不多 → 补一手有价值
    if (hisBack > 2 || mine >= 2) return 0;
    return HOME_BONUS;
  }

  // ---- 工兵试探：只飞「像雷的」，别乱飞 ----
  // 工兵的规则是反的：唯一能赢的是地雷，撞任何普通子（含炸弹）都是自己死。
  // 但 resolveBattle(a, null) 对暗子返回 "move"（当移子），于是现在整个评分链
  // 把「工兵飞过去撞一个不认识的子」当成零成本 —— 这就是乱飞的根源。
  // 这里按 P(那格是雷) 算期望收益，把"白给"的代价补回来。
  const ENG_SWEEP = _num("JJ_ENG_SWEEP", 1);
  function engineerSweepBonus(state, seat, move, domains) {
    if (!ENG_SWEEP) return 0;
    if (state.engOff && state.engOff[seat]) return 0;      // 按座位关，便于同局 A/B
    const a = G.pieceAt(state, move.from);
    if (!isRealEngineer(state, seat, a)) return 0;
    const d = G.pieceAt(state, move.to);
    if (!d || ally(d.owner, seat)) return 0;
    if (G.visibleTo(state, seat, d)) return 0;            // 明子走正常评分
    const fi = IDX.get(move.from);
    const ti = IDX.get(move.to);
    if (fi === undefined || ti === undefined) return 0;
    if (!RAILS[fi] || !RAILS[fi].length || !RAILS[ti] || !RAILS[ti].length) return 0;
    if (Math.abs(N[fi].x - N[ti].x) + Math.abs(N[fi].y - N[ti].y) < 2) return 0;   // 只约束「飞」

    let pm = 0;
    try {
      const rows = beliefRowsView(state, seat, domains);
      const row = rows && rows.get(d.id);
      if (row && row.get) pm = row.get("mine") || 0;
    } catch (err) { pm = 0; }
    if (!pm) {
      const dom = domains && domains.get(d.id);
      if (dom && dom.size) {
        let c = 0;
        for (const t of dom) if (t === "mine") c += 1;
        pm = c / dom.size;
      }
    }
    const gain = VALUES.mine + _num("JJ_ENG_GAIN", 40);     // 挖掉一枚雷
    const loss = VALUES.engineer;                          // 工兵白死
    return pm * gain - (1 - pm) * loss;
  }

  // ---- 敌方令子的「集合级」候选 ----
  // 逐子问「这枚是不是司令」→ 12 类 top1 只有 30%；
  // 换成集合级问「这几枚里哪一枚是令子」→ 实测 44.6%（随机基线 7.8%，5.7 倍）。
  // 关键：用 P(司+军+师) 之和而不是单个 P(司令)。令子是动态的，司令死了军长就顶上，
  // 盯死单一身份反而抓不住（20 局实测 44.6% vs 34.4%）。
  function dominantCandidates(state, seat, k) {
    const top = k || 3;
    const out = [];
    let domains;
    let rows;
    try {
      domains = inferDomains(state, seat);
      rows = beliefRowsView(state, seat, domains);
    } catch (err) {
      return out;
    }
    for (const owner of B.SEATS) {
      if (ally(owner, seat)) continue;
      const cand = [];
      for (const p of state.pieces) {
        if (p.owner !== owner || !p.position) continue;
        const known = G.visibleTo(state, seat, p);
        const r = DOM_RANK[p.type] || 0;
        if (known) {
          cand.push({ id: p.id, position: p.position, p: r >= 38 ? 1 : 0, known: true, type: p.type });
          continue;
        }
        const row = rows && rows.get(p.id);
        let s = 0;
        if (row) {
          for (const t of ["commander", "army", "division"]) s += row.get(t) || 0;
        }
        cand.push({ id: p.id, position: p.position, p: s, known: false, type: null });
      }
      cand.sort((a, b) => b.p - a.p);
      out.push({ owner: owner, top: cand.slice(0, top) });
    }
    return out;
  }

  /**
   * 高价值目标（HVT）：值得专门派炸弹去换的敌子。
   *
   * 判据（宁保守勿浪费，炸弹只有 2 枚）：
   *   ① 子力记忆推出来的等级下界 ≥ HVT_RANK（师长）——吃过我方大子才知道，硬信息；
   *   ② 或本局已经连吃 ≥ 2 子 —— 连吃本身就是「它不小」的证据，而且已经赚了。
   *
   * 为什么只在根节点算：这是 PIMC 引擎，树里的敌人是 buildWorld 抽出来的**具体兵种**，
   * 根本不需要「猜它多大」；HVT 只在「根节点排序 + 硬过滤」这一层才有意义。
   */
  function hvtTargets(state, seat, mem, domains) {
    if (!TACTIC_ON) return null;
    const kills = new Map();
    for (const b of state.battles || []) {
      if (b.outcome !== "attacker" || !b.attacker) continue;
      kills.set(b.attacker, (kills.get(b.attacker) || 0) + 1);
    }
    const out = new Map();
    for (const p of state.pieces) {
      if (!p.position || ally(p.owner, seat)) continue;
      const nk = kills.get(p.id) || 0;
      const floor = knownFloor(mem, domains, p.id) || 0;
      let rank = floor;
      if (nk >= 2 && rank < HVT_RANK) rank = HVT_RANK;
      if (rank < HVT_RANK) continue;
      const vt = RANK_TYPE[rank];
      // ⚠ 真实局面的 piece 只有 position（格 id），pos（索引）只存在于 buildWorld 的世界里。
      //   这里算一次索引存进 HVT，后面 rootPrior 直接用，省得每次都 IDX.get。
      const posIdx = IDX.get(p.position);
      if (posIdx === undefined) continue;
      out.set(p.id, {
        rank,
        value: (vt && VALUES[vt]) || VALUES.division,
        kills: nk,
        pos: posIdx,
      });
    }
    if (out.size) TAC_STATS.hvt += out.size;
    return out;
  }

  /**
   * 风险厌恶系数 λ。0 = 线性期望（旧行为）。
   * 优先级：同局按座位关（state.cvarOff）> 同局按座位设值（state.cvarFor）>
   *        全局环境变量（JJ_LAMBDA，扫参用）> 风格自带的 lambda。
   */
  const _LAMBDA_G = _num("JJ_LAMBDA", NaN);
  // 地板语义：默认 max（旧行为）。add 是修好分辨力的版本，见下面 floored 的注释。
  const FLOOR_ADD = _ENV.JJ_FLOOR === "add";
  // 世界抽样的温度（P0-2a）。1 = 原样，>1 压平（保多样性），<1 更尖。
  const _TAU_G = Math.max(0.2, _num("JJ_WORLD_TAU", 1));
  /**
   * 世界抽样的温度（P0-2a）：等价于按 p^(1/τ) 抽样。
   * τ=1 原样；τ>1 压平（保多样性）；τ<1 更尖。
   * 为什么要它：矩阵一开就掉 12pp（§四十五 ③），根因是「4~5 个样本代表不了尖分布」，
   * 压平让样本重新覆盖「其实也可能是别的」，才可能把先验用起来。
   */
  function worldTau(state, seat) {
    if (state.worldTauOff && state.worldTauOff[seat]) return 1;
    if (state.worldTauFor && state.worldTauFor[seat] !== undefined) {
      const v = state.worldTauFor[seat];
      if (typeof v === "number" && isFinite(v) && v > 0) return Math.max(0.2, v);
    }
    return _TAU_G;
  }
  const _KAPPA_G = _num("JJ_CVAR", 0);        // 下行惩罚强度：0 = 线性期望
  /** 下行风险系数 κ。同局可按座位覆盖（state.cvarK[seat]）。 */
  function KAPPA(state, seat) {
    if (state.cvarKOff && state.cvarKOff[seat]) return 0;
    if (state.cvarK && state.cvarK[seat] !== undefined) {
      const v = state.cvarK[seat];
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return _KAPPA_G;
  }
  function lambdaOf(state, seat, P) {
    if (state.cvarOff && state.cvarOff[seat]) return 0;
    if (state.cvarFor && state.cvarFor[seat] !== undefined) {
      const v = state.cvarFor[seat];
      if (typeof v === "number" && isFinite(v)) return v;
    }
    if (isFinite(_LAMBDA_G)) return _LAMBDA_G;
    return (P && typeof P.lambda === "number") ? P.lambda : 0;
  }

  /**
   * 局面的「不确定性」：所有未知敌子的平均标准化熵（0 = 全确定，1 = 12 类均匀）。
   * 用途：高熵 → 多抽几个世界浅搜（平均掉误差）；低熵 → 少抽几个深搜（结论可靠）。
   * 这是"确定的多搜几层"的量化入口 —— 在时间预算固定时，深度由"每个世界分到多少时间"决定，
   * 所以控制了世界数就控制了深度。
   */
  const ENT_MAX = Math.log(12);
  function uncertaintyOf(state, seat, rows) {
    if (!rows || !rows.size) return 0.8;          // 没有信念行 = 什么都不知道
    let sum = 0, n = 0;
    for (const [id, row] of rows) {
      const p = state.pieces.find((x) => x.id === id);
      if (!p || p.owner === seat || !p.position) continue;
      if (G.visibleTo(state, seat, p)) continue;   // 亮着的子不算
      let h = 0;
      for (const [, w] of row) if (w > 0) h -= w * Math.log(w);
      sum += h / ENT_MAX;
      n += 1;
    }
    return n ? Math.max(0, Math.min(1, sum / n)) : 0.8;
  }
  const ADAPT_STATS = { calls: 0, unc: 0, n: 0, depth: 0, rounds: 0, timedOut: 0 };

  function rootPrior(state, seat, move, profile, domains, mem, fl, rows, hvt) {
    const P = profile || PROFILES.forest;
    let score = 0;
    const d = G.pieceAt(state, move.to);
    const to = B.BOARD.byId.get(move.to);
    const from = B.BOARD.byId.get(move.from);
    const a = G.pieceAt(state, move.from);
    if (!a) return -Infinity;
    // 已知下界：撞过的子要记住，别再拿小一号的子去送（用户口径：吃了我 38 ⇒ 至少 39）
    if (d && d.owner !== seat) {
      const myR = RANK_NUM[a.type] || 0;
      const floorR = knownFloor(mem, domains, d.id);
      const mutable = state.latentSeats && state.latentSeats[seat] && a.latent;
      if (!mutable && myR && floorR && myR < floorR) return -900;   // 必死撞击，劝退
      if (!mutable && myR && floorR && myR > floorR && mem && mem.noMine.has(d.id)) {
        // 已知是大子又吃得掉：肉票，给一点额外吸引力（下界越高越值钱）。
        // 只在「已排除地雷」时给——否则这条会鼓励去啃雷。
        score += Math.max(0, floorR - 34) * 8;
      }
    }
    // 僵局加压：越久没发生战斗，进攻/推进的收益越大，逼 AI 主动求战
    const urgency = 1 + Math.min(2, (state.noCapture || 0) / 15);
    if (d) {
      if (G.visibleTo(state, seat, d)) {
        const inHq = state.mode === "chaos" && to.kind === "hq" && to.seat !== a.owner;
        const outcome = battleOutcome(a.type, d.type, inHq, state.mode);
        if (outcome === "attacker") score += ((VALUES[d.type] || 10) + (d.type === "flag" ? 100000 : 0)) * urgency;
        else if (outcome === "both") score += ((VALUES[d.type] || 10) - (VALUES[a.type] || 10)) * urgency;
        else score -= VALUES[a.type] || 10;
      } else {
        // 【已回退】曾在此对「令子撞真实未知子」罚 BLIND_CLASH_PENALTY，
        // 实测 20 局 40 互撞 0.50→0.50（无改善）而对局步数 +45%（更磨），
        // 说明互撞不发生在 rootPrior 的选择层，而在搜索世界的抽样层。详见 94 篇 §八。
        //
        // 2026-11-01：这里原来是个常数 +6×attack，**等于把「100% 确定是司令」和
        // 「完全不知道」当成同一件事**。改成按身份域（beliefRows）求期望：
        // 逐兵种算「吃/换/被吃」的收益再按概率加权，这才是「知道多少就用多少」。
        const row = BELIEF_PRIOR && rows ? rows.get(d.id) : null;
        if (row && row.size) {
          const inHqB = state.mode === "chaos" && to.kind === "hq" && to.seat !== a.owner;
          const vA = VALUES[a.type] || 10;
          let ev = 0;            // 线性期望（λ=0 时就是它）
          let evFlag = 0;        // 打旗：单独走线性，避免被风险折算压掉
          const payoffs = [];    // [p, R]：给风险效用用
          // 区域大子配额用完后，把「大子」的权重压下去再重新归一 ——
          // 这是「敢不敢用团/旅去吃」的直接依据。
          const zs = zoneSoftOf(state, seat, d, domains, rows, mem);
          let znorm = 0;
          if (zs !== 1) {
            for (const [t, pr] of row) znorm += (BIG_T.has(t) ? pr * zs : pr);
            if (!(znorm > 0)) znorm = 1;
          }
          for (const [t, pr0] of row) {
            if (!pr0) continue;
            const pr = zs !== 1 ? (BIG_T.has(t) ? pr0 * zs : pr0) / znorm : pr0;
            if (!pr) continue;
            if (t === "flag") { ev += pr * 100000; evFlag += pr * 100000; continue; }
            const outB = battleOutcome(a.type, t, inHqB, state.mode);
            if (outB === "attacker") { const g = VALUES[t] || 10; ev += pr * g; payoffs.push([pr, g]); }
            else if (outB === "both") { const g = (VALUES[t] || 10) - vA; ev += pr * g; payoffs.push([pr, g]); }
            else { ev -= pr * vA; payoffs.push([pr, -vA]); }
          }
          // 风险处理，两套并存（P0-1，见 任务书.md）：
          //   ① CVAR 下行惩罚（默认 0 = 关）：U = E[R] + κ·Σ_{R<0} p·R
          //      —— 只放大亏损那一支，正期望的高方差不动。这是军棋要的形状：
          //      「撞对能吃军长」的长尾不该被罚，该罚的是「六成赔司令」。
          //   ② LAMBDA 指数效用（默认 0）：U_λ = (1/λ)ln E[e^{λR}]，对称罚方差。
          //      实测 λ=-0.5 让撞子总数减 11%、输率反而 +1.6pp（20.8→22.4）——
          //      因为它把「撞对大子」的正长尾一起压了，等于劝人龟缩。留作对照。
          const lam = lambdaOf(state, seat, P);
          const kap = KAPPA(state, seat);
          let evUsed = ev;
          if (kap !== 0 && payoffs.length > 1) {
            let loss = 0;                       // 恒 ≤ 0
            for (const [pr, R] of payoffs) if (R < 0) loss += pr * R;
            // kap<0 是「乐观偏差」：把亏损那一支的权减轻。理论上等价于 OVERCONF，
            // 但实测这引擎只是「撞得少」，不是「挑得准」，所以要反过来试。
            evUsed = ev + kap * loss;
          } else if (lam !== 0 && payoffs.length > 1) {
            evUsed = 0;      // 下面用 evUsed 承载「非打旗部分」的效用值
            const wSum = payoffs.reduce((acc, x) => acc + x[0], 0);
            if (wSum > 0) {
              const SCALE = 100;                     // 司令价 → 1，让 λ·r 落在 O(1)
              let mx = -Infinity;
              for (const [, R] of payoffs) { const r = Math.min(3, R / SCALE); if (r > mx) mx = r; }
              let acc = 0;
              for (const [pr, R] of payoffs) {
                const r = Math.min(3, R / SCALE);
                acc += (pr / wSum) * Math.exp(lam * (r - mx));
              }
              if (acc > 0) evUsed = SCALE * (mx + Math.log(acc) / lam);
            }
            evUsed += evFlag;   // 打旗不折算
          }
          // 地板 = 6×attack×RISK_K。
          // RISK_K=1 → Math.max(6*attack, ev)，和旧行为完全一致（负期望被抹平）；
          // 调小 → 允许「期望亏本」的攻击被压分。旧值 1 会让连长打未知子
          // 永远拿 +6×attack（哪怕 ev=−20），这是自死率 42.8% 的直接来源。
          // 保底也得跟着 λ 走。风险厌恶的含义就是「少给冒险保底」：
          // 不减这一项的话，效用值被压到 -30 也会被 6×attack 抬回 +6，λ 等于白设
          //（第一次跑就是这样，撞子比例只从 29.2% 掉到 27.7%）。
          const floorK = lam < 0 ? Math.max(0.2, 1 + lam) : 1;
          const floorV = 6 * P.attack * RISK_K * floorK;
          const pMine = row.get("mine") || 0;
          // 地板有两种语义：
          //   max —— Math.max(ev, 6×attack)。旧行为，但它把**所有**撞未知子的分数
          //          压成同一个常数：实测 6 个候选走法 λ=0 全是 -22.8/-24.0/-26.8…
          //          一旦 ev 低于地板就都变成 +6，等于「撞谁」完全没分辨力。
          //          这也是自死率 42.8% 的来源，而且让任何风险项都失效（Δ 恒等于地板差）。
          //   add —— ev + 6×attack。保留 ev 的差异，同时给「敢撞」一个整体偏好。
          const addMode = FLOOR_ADD || kap !== 0 || lam !== 0
            || !!(state.floorAddFor && state.floorAddFor[seat]);
          const floored = pMine > MINE_STOP ? evUsed
            : (addMode ? evUsed + floorV : Math.max(evUsed, floorV));
          score += floored * urgency;
          // 试探的信息奖励：用团/营去撞「未知 + 开局区域还没确认过大子」的子。
          // 这块的期望本身常常是负的（撞死亏一个团），但换来的是整局的判断力。
          // 旧版这里恒为 0，所以 AI 只会打有把握的仗，永远不会去把「不知道」变成「知道」。
          // 前排两角回报高（人类棋谱 96.6% 是旅以上），后排两角只有 55.6% 且 1/3 是雷，
          // 所以后排只给 0.6 的权重 —— 不是不测，是不优先。
          if (PROBE_K > 0 && (a.type === "regiment" || a.type === "battalion")) {
            const lgz = zoneLedger(state, seat, d.owner, domains, mem);
            const zi2 = lgz.of.get(d.id);
            if (zi2 !== undefined) {
              const zz2 = lgz.z[zi2];
              const used2 = zz2.e + zz2.d;
              if (used2 < 1) {
                const pMine = row.get("mine") || 0;
                const front = CORNER_ZONES[zi2][0] <= 1 ? 1 : 0.6;
                score += PROBE_K * (1 - Math.min(1, used2))
                  * (1 - pMine) * front * urgency;
              }
            }
          }
        } else {
          score += 6 * P.attack * urgency;
        }
      }
    }
    // ---------- 战术连招：挂炸 / 弃子跟炸 ----------
    // 三档，从「已经能兑现」到「提前布势」：
    //   ① 炸弹直接炸 HVT —— 兑现；
    //   ② 炸弹贴到 HVT 的邻格 —— 下一手能炸，同时它吃我邻子也在射程内；
    //   ③ 非炸大子贴到 HVT 邻格、且我方炸弹就贴着这个落点 —— 这就是「贴身挂炸弹」：
    //      敌吃诱饵 → 它停在落点上 → 炸弹一口炸掉。真正的弃子跟炸。
    if (to && (hvt || BOMB_HOLD_K > 0)) {
      const aIsBomb = a.type === "bomb";
      const tgt = (d && d.owner !== seat && !ally(d.owner, seat) && hvt) ? hvt.get(d.id) : null;
      const srcIdx0 = IDX.get(move.from);
      const dstIdx0 = IDX.get(move.to);
      if (tgt && aIsBomb) {
        // ① 兑现。净收益 = 敌子价值 − 炸弹价值：司+135−65=+70，军+35，师+10。
        //    rank<军长时打折——拿炸弹换一个师长只是打平，会浪费掉后期唯一的翻盘工具。
        const gain = tgt.value - VALUES.bomb;
        const base = tgt.rank >= BOMB_PAY_RANK ? (gain * 2 + 40) : gain * 0.8;
        score += BOMB_EAT_K * (base + (tgt.kills >= 2 ? 30 : 0));   // 连环杀手多给一点
        TAC_STATS.bombEat += 1;
      } else if (!d && srcIdx0 !== undefined && dstIdx0 !== undefined) {
        // 到最近 HVT 的距离（走之前 / 走之后）
        let d0 = 99, d1 = 99;
        if (hvt) {
          for (const t of hvt.values()) {
            const b0 = dist(srcIdx0, t.pos);
            const b1 = dist(dstIdx0, t.pos);
            if (b0 < d0) d0 = b0;
            if (b1 < d1) d1 = b1;
          }
        }
        if (aIsBomb) {
          if (d0 < 99) {
            // ② 炸弹挂上去。实战里炸弹是从第 2 排一步步挪到 HVT 邻格的，
            //    不是一步跳过去——所以必须给「每一步缩短距离」的梯度，
            //    否则 AI 的炸弹永远待在后场不动（实测：只给「一步到位」加分时 0 次触发）。
            if (d1 < d0) {
              score += (d1 === 1 ? 34 : 9) * BOMB_HUNT_K;
              if (d1 === 1) TAC_STATS.bombNear += 1;
            } else if (d1 > d0) {
              score -= 3 * BOMB_HUNT_K;            // 越走越远，反向惩罚
            }
          }
          if (BOMB_HOLD_K > 0) {
            // ③ 装小子：炸弹离出生格越远，越容易被识破（一枚从后场奔袭的子，谁都猜是炸）。
            //    留在小子堆里不动，人类的大子才敢来撞 —— 撞上就是 65 换 135。
            const ip = initPosOf(state, a);
            const ipIdx = ip ? IDX.get(ip) : undefined;
            if (ipIdx !== undefined) {
              const dd = dist(ipIdx, dstIdx0);
              if (dd > 0) {
                score -= dd * BOMB_HOLD_K;
                TAC_STATS.hold += 1;
              }
            }
          }
        } else if (d1 === 1 && (RANK_NUM[a.type] || 0) >= 36) {
          // ④ 诱饵：团以上非炸子贴到 HVT 邻格，且我方炸弹在 1~2 步内能赶到落点。
          //    ⚠ MASK_OPP 关闭时树里的对手是全知的，它知道那不是炸弹 → 诱饵不会被吃，
          //    这一条等于白送一个子的位形。默认值因此设为 0，只在开 MASK_OPP 时才有意义。
          let bombD = 99;
          for (const p of state.pieces) {
            if (p.owner !== seat || p.type !== "bomb" || !p.position || p.id === a.id) continue;
            const bi = IDX.get(p.position);
            if (bi === undefined) continue;
            const dd = dist(bi, dstIdx0);
            if (dd < bombD) bombD = dd;
          }
          if (bombD === 1) { score += 26 * BAIT_K; TAC_STATS.bait += 1; }
          else if (bombD === 2) { score += 12 * BAIT_K; TAC_STATS.bait += 1; }
        }
      }
    }
    // 工兵保存：前期不让它从后场飞到一线（AI 的「工兵乱飞」就是这条缺的）
    if (ENG_HOLD > 0 && isRealEngineer(state, seat, a) && (state.moveCount || 0) < ENG_HOLD) {
      if (to && from && to.seat === a.owner && from.seat === a.owner && to.row <= 1 && from.row >= 2) {
        score -= 18 * urgency;
      }
    }
    // 回合顺序偏好（只在打敌方子时生效，且不下手打「下家」）
    if (d && d.owner !== seat && !ally(d.owner, seat) && TEMPO_UP) {
      if (d.owner === TURN_PREV[seat]) score += TEMPO_UP;
      else if (d.owner === TURN_NEXT[seat]) score += TEMPO_DOWN;
    }
    // 打弱的那家：敌方剩余子力越少越优先（先把一家打残出局，局面就变 2 打 1）
    if (d && d.owner !== seat && !ally(d.owner, seat) && fl && FORCE_WEAK_K) {
      const enemies = Object.keys(fl.foes);
      if (enemies.length >= 2) {
        const avg = enemies.reduce((acc, s2) => acc + fl.foes[s2].value, 0) / enemies.length;
        const mineFoe = fl.foes[d.owner];
        if (mineFoe) score += FORCE_WEAK_K * Math.max(-1.5, Math.min(1.5, (avg - mineFoe.value) / 40));
      }
    }
    // 换子意愿：账上领先时，等价交换是我方赚（把局面简化）；落后时反过来。
    // 暗子的价值用「身份域 × 配额」的期望，明子用真值。
    if (d && d.owner !== seat && !ally(d.owner, seat) && fl) {
      const evD = pieceExpect(fl, d.id) || (FORCE_VALUE[d.type] || 0);
      const evA = FORCE_VALUE[a.type] || 0;
      const even = 1 - Math.min(1, Math.abs(evD - evA) / 30);   // 越接近等价交换，权重越高
      const adv = Math.max(-1, Math.min(1, fl.edge / FORCE_EDGE_SCALE));
      score += FORCE_TRADE_K * adv * evD * even;
    }
    // 配合两项（接应 / 轮换守家）：小权重偏好，不改硬规则
    score += relayBonus(state, seat, move);
    score += pincerBonus(state, seat, move);
    score += homeCoverBonus(state, seat, move);
    score += distractBonus(state, seat, move, P);
    score += engineerSweepBonus(state, seat, move, domains);
    if (to.kind === "camp" && from.kind !== "camp") score += P.camp * 0.7;
    // 令子直取角格：37+ 主动往敌方大本营角上压
    if ((RANK_NUM[a.type] || 0) >= 37 && !d) {
      const dst = IDX.get(move.to);
      if (dst !== undefined) {
        for (const s2 of B.SEATS) {
          if (ally(s2, seat)) continue;
          if (BASE_CORNERS[s2] && BASE_CORNERS[s2].has(dst)) { score += CORNER_BONUS; break; }
        }
      }
    }

    // 大本营：进去就再也动不了，必须先判断值不值。
    // 关键一条：**军旗必定占一个 hq 且永不移动**，所以「空着的大本营」必然没有旗，
    // 走进去等于永久废掉一枚子、零收益 —— 这正是「已知敌方旗所在后别再打另一个大本营」。
    if (to.kind === "hq" && to.seat && to.seat !== a.owner) {
      if (seatOut(state, to.seat)) {
        score -= 600;                                  // 该方已出局，进去纯属浪费步数
      } else if (d && d.type === "flag") {
        score += 100000;                               // 就是旗
      } else if (!d) {
        score -= 400;                                  // 空 hq：必然无旗
      } else if (d && d.type !== "flag") {
        score += 4;                                    // 有子且未知：可能是旗/雷，保留吸引力
      }
    }
    // 「后方跟着炸就别急着躲」：用户口径——师长遇军长/司令，如果炸就在后面，
    // 不一定要跑，让它来吃再炸（理论 12 的「用炸靠装」）。这里对「逃跑」这一步扣分。
    if (!d && from) {
      const myR = RANK_NUM[a.type] || 0;
      if (myR >= 34 && myR <= 38) {
        const fromIdx = IDX.get(move.from);
        const adjFoe = state.pieces.find((p) => {
          if (!p.position || ally(p.owner, seat)) return false;
          const pi = IDX.get(p.position);
          return pi !== undefined && fromIdx !== undefined && ROADS[fromIdx].includes(pi)
            && knownFloor(mem, domains, p.id) > myR;
        });
        if (adjFoe) {
          const bombBehind = state.pieces.some((p) => {
            if (p.owner !== seat || p.type !== "bomb" || !p.position || p.id === a.id) return false;
            const bi = IDX.get(p.position);
            return bi !== undefined && fromIdx !== undefined
              && (ROADS[fromIdx].includes(bi) || ROADS[bi].includes(fromIdx));
          });
          if (bombBehind) score -= 40;
        }
      }
    }
    const { oldD, newD, delta } = advanceDelta(state, seat, move);
    if (oldD < 99) score += delta * 4 * P.flagAttack * urgency;
    // 不接触的走法：按「是否向敌方推进」给分。原地磨与后退要明显吃亏，
    // 否则 AI 会一直在自己半场来回倒腾，最后磨成和棋。
    if (!d && oldD < 99) {
      if (newD < oldD) score += 3 * P.flagAttack * urgency;
      else if (newD > oldD) score -= 4;
      else score -= 1.2;
    }
    return score;
  }

  // 阵法书一共只有几十套，雷位组合更少，每局容易雷同。
  // 布阵完成后把地雷在后排随机换个位置（只和同排的非军旗子交换，不碰大本营）。
  function shuffleMineRow(state, seat) {
    const own = state.pieces.filter((p) => p.owner === seat && p.position);
    const mines = own.filter((p) => p.type === "mine");
    if (mines.length < 2) return;
    const minRow = mines.length >= 8 ? 3 : 4;
    const hqSet = new Set(B.hqCells(seat));
    const candidates = own.filter((p) => p.type !== "flag" && p.type !== "mine"
      && B.BOARD.byId.get(p.position).row >= minRow
      && !hqSet.has(p.position));
    for (const m of mines) {
      if (hqSet.has(m.position)) continue;         // 阵法把雷放在大本营就保留
      if (!candidates.length) break;
      const j = Math.floor(Math.random() * candidates.length);
      const o = candidates[j];
      candidates.splice(j, 1);
      const mp = m.position;
      m.position = o.position;
      o.position = mp;
    }
  }

  function applyOpening(state, seat, profileName) {
    if (!state || state.phase !== "setup") return false;
    const book = root.JUNQI_FORMATIONS || [];
    if (!book.length) return false;
    const own = state.pieces.filter((p) => p.owner === seat && p.position);
    if (own.length !== 25) return false;
    const counts = {};
    for (const p of own) counts[p.type] = (counts[p.type] || 0) + 1;
    const byType = {};
    for (const p of own) {
      byType[p.type] ||= [];
      byType[p.type].push(p);
    }
    // 阵法从全库随机挑（72 套），风格只影响走法风格，不再限制布阵
    const pool = shuffle(book.slice());
    for (const formation of pool) {
      const need = {};
      for (const t of formation.layout) need[t] = (need[t] || 0) + 1;
      let ok = true;
      for (const t of Object.keys(need)) if (need[t] !== (counts[t] || 0)) { ok = false; break; }
      if (!ok) continue;
      const used = {};
      let valid = true;
      const cells = OPENING_CELLS.map(([r, c]) => `${seat}-${r}-${c}`);
      const placed = [];
      for (let i = 0; i < cells.length; i += 1) {
        const t = formation.layout[i];
        const list = byType[t] || [];
        const idx = used[t] || 0;
        if (!list[idx]) { valid = false; break; }
        placed.push([list[idx], cells[i]]);
        used[t] = idx + 1;
      }
      if (!valid) continue;
      for (const [p, pos] of placed) p.position = pos;
      // 记下这套阵：雷位马上要被 shuffleMineRow 打乱，之后就没法靠比对认出来了
      if (!state.openingUsed) state.openingUsed = {};
      state.openingUsed[seat] = { name: formation.name || "未知", index: book.indexOf(formation) };
      shuffleMineRow(state, seat);       // 雷位每局随机，避免天天一样的布阵
      return true;
    }
    return false;
  }

  function applyOpenings(state) {
    if (!state) return 0;
    let n = 0;
    for (const seat of B.SEATS) {
      if (state.aiProfiles && state.aiProfiles[seat]) {
        if (applyOpening(state, seat, state.aiProfiles[seat])) n += 1;
      }
    }
    return n;
  }

  function choose(state, seat, opts = {}) {
    const budget = Math.max(50, opts.budgetMs || 1500);
    const deadline = Date.now() + budget;
    let actual = G.allLegalMoves(state, seat);
    if (!actual.length) return null;
    // 调试用：opts.trace 传一个 "from>to"，记录它逐道过滤器是死是活
    const TR = opts.trace ? [] : null;
    const mark = (tag, arr) => { if (TR) TR.push({ tag, n: arr.length, has: arr.some((m) => `${m.from}>${m.to}` === opts.trace) }); };
    mark("legal", actual);
    const wanted = opts.profile || (state.aiProfiles && state.aiProfiles[seat]) || "forest";
    // 每个座位自己一份子力记忆，只在本座位决策时构建、只喂给本座位
    const mem = rankMemory(state, seat);
    if (!state.aiMemory) state.aiMemory = {};
    state.aiMemory[seat] = mem;                 // 仅供调试/审计，不参与共享
    const domains = inferDomains(state, seat, mem);
    // 兵力账：只看公开信息 + 身份域，实时算一次，喂给下面的风险惩罚与换子偏好。
    const forceOff = FORCE_ON && !(state.forceOff && state.forceOff[seat]);
    const FL = forceOff ? forceLedger(state, seat, mem, domains) : null;
    const adv = FL ? Math.max(-1, Math.min(1, FL.edge / FORCE_EDGE_SCALE)) : 0;
    // 风格在这里才定：动态风格要看 adv，而 adv 依赖兵力账
    const profileName = (wanted === "dyn" && STYLE_ON) ? pickStyle(state, seat, adv) : wanted;
    const profile = PROFILES[profileName] || PROFILES.forest;
    let riskScale = 1, flagScale = 1;
    if (FL) {
      riskScale = 1 - FORCE_RISK_K * adv;
      flagScale = 1 - FORCE_FLAG_K * adv;
      FORCE_STATS.plies += 1;
      FORCE_STATS.sumAdv += adv;
      if (adv > 0.34) FORCE_STATS.ahead += 1;
      else if (adv < -0.34) FORCE_STATS.behind += 1;
      else FORCE_STATS.even += 1;
    }
    syncRecentMoves(state);
    // 硬性剔除「刚走过去又原路走回来」：这种走法永远不产生战损，纯粹消耗步数。
    // 只有它是唯一选择时才保留，避免无子可走。
    const noBack = actual.filter((m) => !isBacktrack(state, m));
    if (noBack.length) actual = noBack;
    mark("noBack", actual);

    // 军旗受威胁：能解围就必须解（否则下一步丢旗直接输）。
    // 优先级高于僵局推进——旗要丢了还去推前线是自杀。
    const threats = flagThreats(state, seat);
    let rescued = false;
    if (threats.length) {
      FLAG_STATS.threatened += 1;
      const relief = actual.filter((m) => isThreatRelief(state, seat, m, threats));
      // 「明确吃不过 / 炸不掉」不算解围：拿已知更小的子去撞威胁者，撞完旗照样丢。
      // 这条把「必须解围」收窄成「能解围就必须解」，否则会为救旗送掉一枚子还救不了。
      const usable = relief.filter((m) => !isKnownSuicide(state, seat, m, mem, domains));
      if (usable.length) {
        actual = usable;
        rescued = true;
        FLAG_STATS.rescued += 1;
      } else {
        FLAG_STATS.helpless += 1;          // 明确吃不过/挡不住，只能走其他
      }
    }
    mark("flagThreats", actual);

    // 僵局（久无战损）时强制推进：只要还有推进或开打的走法，就不再允许「原地磨」。
    // 门槛 >= 3 是留余地，避免被逼到只能送子。解围局面不做推进过滤。
    if (!rescued && (state.noCapture || 0) >= 24) {
      const push = actual.filter((m) => G.pieceAt(state, m.to) || advanceDelta(state, seat, m).delta > 0);
      if (push.length >= 3) actual = push;
    }
    mark("stalematePush", actual);

    // 已知下界硬约束：先验里给 -900 只是个软分（进 search 后权重只有 1%），
    // 真正管住「别再撞已知更大的子」必须在这里删掉候选。
    // 已知下界硬约束：先验里给 -900 只是个软分（进 search 后权重只有 1%），
    // 真正管住「别再撞已知更大的子」必须在这里删掉候选。
    // 但「先予后取」：删掉的着法里，凡是撞完之后我方炸弹能一步吃回那个格子的，
    // 留一份做深度验证（下面搜的时候给它开捕获延伸），能赢就用它。
    let verifyMoves = [];
    const healthy = actual.filter((m) => !isKnownSuicide(state, seat, m, mem, domains));
    if (healthy.length) {
      if (VERIFY_ON && VERIFY_MAX > 0) {
        const allMoves = actual;                       // 此刻还是全量走法，直接用，不额外生成
        for (const m of allMoves) {
          if (verifyMoves.length >= VERIFY_MAX) break;
          if (!isKnownSuicide(state, seat, m, mem, domains)) continue;
          const a = G.pieceAt(state, m.from);
          const d = G.pieceAt(state, m.to);
          if (!a || !d) continue;
          VERIFY_STATS.tried += 1;
          if (!bombRecaptureAvailable(state, seat, allMoves, m.to, a.id)) continue;
          verifyMoves.push(m);
        }
        VERIFY_STATS.kept += verifyMoves.length;
      }
      actual = healthy;
    }
    mark("knownSuicide", actual);
    // 不去没有旗的大本营（进去的子再也动不了，纯浪费）
    const hqOk = actual.filter((m) => !isUselessHqMove(state, seat, m));
    if (hqOk.length) actual = hqOk;
    mark("uselessHq", actual);
    // 工兵别提前飞过河（见 isEarlyEngineerRaid 的注释：扣分改不动，只能删候选）
    const raidOk = actual.filter((m) => !isEarlyEngineerRaid(state, seat, m, domains));
    if (raidOk.length) actual = raidOk;
    mark("engRaid", actual);

    // 身份域信念（每次 choose 只算一次，内部按 moveTape/battles 缓存）
    let brow = null;
    if (BELIEF_PRIOR && !(state.bpOff && state.bpOff[seat])) {
      try { brow = beliefRowsView(state, seat, domains); } catch (err) { brow = null; }
    }
    state.__evRows = brow || null;      // 给 buildWorld 算期望价值用（不含抽样）
    // 战术连招：先把「值得用炸弹换的敌子」标出来（只算一次，喂给根节点排序）
    const hvt = hvtTargets(state, seat, mem, domains);
    const priors = actual.map((m) => {
      let sc = rootPrior(state, seat, m, profile, domains, mem, FL, brow, hvt) + Math.random() * 0.6;
      // 8 步内回到走过的空格：小循环，重罚（量级远大于局面分，接近硬排除）
      if (isRevisit(state, m) && !G.pieceAt(state, m.to)) sc -= 1500;
      return { m, score: sc };
    }).sort((a, b) => b.score - a.score);
    const candidates = priors.slice(0, 28).map((x) => x.m);
    for (const { m } of priors) {
      if (!candidates.some((c) => c.from === m.from)) candidates.push(m);
    }
    // 验证候选追加到末尾（它们被硬过滤剔除过，不在 priors 里）
    const verifySet = new Set();
    for (const m of verifyMoves) {
      const k = `${m.from}>${m.to}`;
      verifySet.add(k);
      if (!candidates.some((c) => `${c.from}>${c.to}` === k)) candidates.push(m);
    }
    const priorOf = new Map(priors.map((x) => [`${x.m.from}>${x.m.to}`, x.score]));
    // 军旗防线：按「走完这一步之后还剩几个两步内丢旗的威胁」扣分。
    // 这个量只跟真实局面 + 子力记忆有关，不受抽样世界影响，所以放在根节点统一扣。
    const riskBase = flagRisk(state, seat, mem, domains, null);
    if (riskBase > 0) FLAG_STATS.riskBase += 1;
    const doms = enemyDominants(state, seat, mem, domains);
    const domOf = new Map();
    for (const c of candidates) domOf.set(`${c.from}>${c.to}`, dominantScore(state, seat, c, doms));
    // 信念行：协同与战术项共用一份（懒算，只有真要用才付代价）
    let sharedRows = null;
    const rowsOnce = () => {
      if (sharedRows === null) {
        try { sharedRows = beliefRows(state, seat, flagView(state).list, domains) || false; }
        catch (err) { sharedRows = false; }
      }
      return sharedRows || null;
    };
    // 协同：对家后院被侵入时，我这一手能救多少（直接进最终分数，权重 1.0）
    const coopIntr = (COOP_ON && !(state.coopOff && state.coopOff[seat])) ? coopIntruders(state, seat) : null;
    const coopOf = new Map();
    if (coopIntr) {
      const crows = rowsOnce();
      for (const c of candidates) {
        const v = coopBonus(state, seat, c, coopIntr, crows);
        if (v > 0) { coopOf.set(`${c.from}>${c.to}`, v); COOP_STATS.candidates += 1; }
      }
    }
    // ---- 战术 DLC（tactics.js，2026-11-06）：权重 1.0，直接进最终分数 ----
    // 第一件是双飞：我方挖上家旗上雷 → 对家飞兵 → 我方挡下家。
    // 它必须**自己把着法塞进候选池**：双飞的挖掘手常常先验很低（挖旗上雷这一步
    // 静态上"没有任何收益"），如果只等 rootPrior 选中它，就永远不会发生。
    const TACT = root.JunqiTactics;
    let tacticPhase = null;
    const tacticOf = new Map();
    if (TACT && TACT.ON) {
      try {
        tacticPhase = TACT.prepare(state, seat, actual, rowsOnce());
        if (tacticPhase) {
          for (const c of candidates) {
            const v = TACT.bonus(state, seat, c, tacticPhase);
            if (v > 0) tacticOf.set(`${c.from}>${c.to}`, v);
          }
          for (const m of actual) {
            const key = `${m.from}>${m.to}`;
            if (tacticOf.has(key)) continue;
            const v = TACT.bonus(state, seat, m, tacticPhase);
            if (v <= 0) continue;
            tacticOf.set(key, v);
            if (!candidates.some((c) => `${c.from}>${c.to}` === key)) candidates.push(m);
          }
        }
      } catch (err) { tacticPhase = null; }
    }
    const riskOf = new Map();
    const mateFlagOf = new Map();
    const domRiskOf = new Map();
    const domRiskBase = domRisk(state, seat, mem, domains, null);
    if (domRiskBase > 0) DOM_STATS.riskBase += 1;
    for (const c of candidates) {
      const mover = G.pieceAt(state, c.from);
      if (!mover) { riskOf.set(`${c.from}>${c.to}`, 0); domRiskOf.set(`${c.from}>${c.to}`, 0); continue; }
      const ov = { src: IDX.get(c.from), dst: IDX.get(c.to), mover };
      riskOf.set(`${c.from}>${c.to}`, flagRisk(state, seat, mem, domains, ov));
      domRiskOf.set(`${c.from}>${c.to}`, domRisk(state, seat, mem, domains, ov));
    }
    let chosenKey = null;
    let stableKey = null, stableRounds = 0;
    const stats = candidates.map(() => ({ sum: 0, sq: 0, n: 0 }));
    // ---- 软截断（Successive Halving，2026-11-05）----
    // 目的：把算力从"28 个候选雨露均沾"改成"核心几个候选多看世界"。
    // ⚠ 不做硬截断：Gemini 原方案是「4 个世界挑 Top4」，而我们自己测出
    //   「世界数 4 → 10 带 +2.8pp」，说明 4 个世界的估计显著更差 —— 拿它做不可逆的
    //   砍人决定，砍掉的会是"方差大但期望高"的动作（正是那些敢撞才有收益的）。
    // 所以：8 个世界后才开始砍、保留 40%（不是 14%）、落选者只是停止加样（已得样本仍计入）、
    //       每 4 个世界重排一次（分数回升可复活）。
    const HALVE_AT = _num("JJ_HALVE", 0);                       // 0 = 关
    const HALVE_KEEP = Math.max(0.2, _num("JJ_HKEEP", 0.4));
    const HALVE_EVERY = Math.max(1, _num("JJ_HSTEP", 4));
    const halveOn = HALVE_AT > 0;
    const halveKeepN = Math.max(4, Math.ceil(candidates.length * HALVE_KEEP));
    let active = candidates.map((_, i) => i);
    const tt = new Map();
    let samples = 0;
    let buildFails = 0;
    let best = candidates[0];
    let chosenScore = -Infinity;        // best 对应的最终分（噪声带定序要用）
    // 久无战损时变得敢于冒险，避免双方都缩在后场磨到和棋
    const stalemate = Math.min(1, (state.noCapture || 0) / 40);
    const riskNow = profile.risk * (1 - 0.7 * stalemate);

    const maskIds = MASK_OPP ? hiddenIdsOf(state, seat) : [];
    // ---- 自适应世界数与深度（P0-2b，2026-11-05）----
    // 用户口径：「多搜几个世界（10 个以上），确定的多搜几层，不确定的少搜几层」。
    // 时间预算固定时，深度 = 每个世界分到多少时间，所以**控制世界数就控制了深度**：
    //   熵高 → N 大 → 每个世界时间少 → 浅搜（但平均掉更多不确定性）
    //   熵低 → N 小 → 每个世界时间多 → 深搜（结论可靠，值得往下算）
    const _WM = _num("JJ_WMAX", 0);              // 环境变量：全局开（快检用）
    const W_MIN = _num("JJ_WMIN", 6);
    // state.adaptFor[seat] 可以给数值，表示这一家的目标世界数上限（同局 A/B 用）
    const _seatW = (state.adaptFor && typeof state.adaptFor[seat] === "number") ? state.adaptFor[seat] : 0;
    const W_MAX = _WM > 0 ? _WM : (_seatW > 0 ? _seatW : 16);
    const D_CAP = Math.max(2, _num("JJ_DCAP", 0) || 6);
    // 按座位开（同局 A/B 用）：state.adaptFor[seat] = true
    const adaptive = _WM > 0 || !!(state.adaptFor && state.adaptFor[seat]);
    const unc = adaptive ? uncertaintyOf(state, seat, brow) : 0;
    // 每轮至少 12ms 才可能搜完（28 候选 × 深度 2 的实测下限），否则压缩世界数
    const capByBudget = Math.max(1, Math.floor(budget / 12));
    const worldN = adaptive
      ? Math.max(1, Math.min(capByBudget, Math.round(W_MIN + (W_MAX - W_MIN) * unc)))
      : 0;
    // 起点一律 2：从低处往上爬（哈希表/置换表会积累，爬得很快），
    // 从高处往下跌会连续超时——第一次跑时 30 手触发了 184 次超时重试，几乎全是这么浪费的。
    //
    // 2026-11-05 试过「深度跨手记忆」（state.depthMemo[seat] 从上一手跑完的深度起跳），
    // 结论：无效，已回退。5000ms 下超时次数 158/162 → 235/240，每手仍然是「爬到超时边界」，
    // 因为 spent<span*0.35 那条规则在每手都会把它再推上去一次——超时是探边机制本身，
    // 不是「每手重新踩雷」。它只把深度均值从 3.67 抬到 4.32、世界数从 10.6 压到 9.8，
    // 是一个未经验证的「深度换世界」取舍，收益不明，不值得留在出厂路径里。
    let depthAdj = adaptive ? 2 : 0;
    let round = 0, guard = 0, carryWorld = null;
    // 深度上限：超时一次就把"这个局面能做到几层"记住，别每两轮再试一次。
    // 否则 depthAdj 会在 3/4 之间来回震荡（3000ms 下 30 手仍触发 96 次超时）。
    //
    // 2026-11-05 晚：上限**跨手记住**（state.ceilMemo[seat]）。上一版记错成「起始深度」，
    // 结果每手仍从 2 往上爬到超时，超时反而变多（235/240）；这一版起始仍是 2（头几轮便宜、
    // 置换表积累快），只把上限钉在上一手学到的位置——探边只交一次学费，不是每手都交。
    // 局面便宜的时候 spent<span*0.15 那条规则仍会把上限放回去，所以不会永久锁死。
    const ceilOn = CEIL_MEM && !(state.ceilOff && state.ceilOff[seat]);
    const ceilMemo = ceilOn ? ((state.ceilMemo && state.ceilMemo[seat]) || 0) : 0;
    let depthCeil = Math.min(D_CAP, ceilMemo > 0 ? ceilMemo : D_CAP);
    let depthOk = 0;                                  // 本手跑完整轮的最高深度
    let cheapAtCeil = false;                          // 在上限处仍然很空（下一手可放宽一层）
    if (adaptive) { ADAPT_STATS.calls += 1; ADAPT_STATS.unc += unc; ADAPT_STATS.n += worldN; }
    while (Date.now() < deadline - 20) {
      if (adaptive && (round >= worldN || guard >= worldN * 3)) break;
      guard += 1;
      // 每轮自己的 deadline：剩余时间 / 剩余轮数。前面几轮快，后面的就能多分到。
      const nowT = Date.now();
      const subDeadline = adaptive
        ? Math.min(deadline - 20, nowT + Math.max(3, (deadline - 20 - nowT) / Math.max(1, worldN - round)))
        : deadline;
      let world;
      if (carryWorld) { world = carryWorld; carryWorld = null; }
      else { SEARCH_STATS.worlds += 1; world = buildWorld(state, seat, domains); }
      if (MASK_OPP && world) {
        TRUTH_VIEW = new Map();
        for (const p of world.pieces) {
          if (B.teamOf(p.owner) === B.teamOf(seat)) TRUTH_VIEW.set(p.id, p.type);
        }
        MASK_VIEW = makeMaskView(maskIds, TRUTH_VIEW);
      }
      if (!world) {
        // 这次的身份域凑不出可行补全（DFS 预算用尽）：换随机序重抽几次，不要整步放弃
        buildFails += 1;
        if (buildFails <= 6) continue;
        break;
      }
      const depth = adaptive ? depthAdj : (samples < 2 ? 3 : 4);
      const scores = new Array(candidates.length).fill(null);
      // 重排：到点就把 active 换成"当前分数前 40%"，注意候选池是全量（落选者可复活）
      if (halveOn && round >= HALVE_AT && (round - HALVE_AT) % HALVE_EVERY === 0) {
        const ranked = candidates.map((c, i) => {
          const st = stats[i];
          if (!st.n) return { i, sc: -Infinity };
          const mean = st.sum / st.n;
          const spread = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean));
          return { i, sc: mean - riskNow * spread };
        }).sort((a, b) => b.sc - a.sc);
        active = ranked.slice(0, halveKeepN).map((x) => x.i);
      }
      let timedOut = false;
      try {
        for (const ai of active) {
          if (Date.now() >= subDeadline) throw TIMEOUT;
          const c = candidates[ai];
          const src = IDX.get(c.from), dst = IDX.get(c.to);
          const attacker = world.pieces.find((p) => p.pos === src);
          if (!attacker) { scores[ai] = -1e7; continue; }
          const defender = world.pieces.find((p) => p.pos === dst) || null;
          const move = {
            from: c.from, to: c.to, src, dst,
            attacker, defender,
          };
          const key = `${c.from}>${c.to}`;
          const risk = riskOf.get(key) || 0;
          const drisk = domRiskOf.get(key) || 0;
          if (domRiskBase > 0) {
            DOM_STATS.withRisk += 1;
            if (drisk < domRiskBase - 1e-9) DOM_STATS.reduced += 1;
            else if (drisk > domRiskBase + 1e-9) DOM_STATS.worse += 1;
            else DOM_STATS.same += 1;
          }
          const fq = verifySet.has(key);
          if (fq) VERIFY_STATS.dived += 1;
          scores[ai] = search(simulate(world, move), depth - 1, -Infinity, Infinity, adaptive ? subDeadline : deadline, seat, 1, tt, profile, fq)
            - risk * FLAG_RISK_PENALTY * flagScale - drisk * DOM_RISK_PENALTY * riskScale
            + (domOf.get(key) || 0);
        }
      } catch (err) {
        if (err !== TIMEOUT) throw err;
        timedOut = true;
      }
      const incomplete = active.some((ai) => scores[ai] === null);
      if (timedOut || incomplete) {
        if (adaptive) {
          ADAPT_STATS.timedOut += 1;
          if (depthAdj > 2) { depthAdj -= 1; depthCeil = depthAdj; carryWorld = world; continue; }   // 降一层，同一世界重来
        }
        break;   // 已经是最浅还超时：预算撑不起这一轮，收工
      }
      samples += 1;
      round += 1;
      ADAPT_STATS.depth = (ADAPT_STATS.depth || 0) + depthAdj;
      if (adaptive && depthAdj > depthOk) depthOk = depthAdj;
      if (adaptive) {
        // 这一轮用掉的时间占分配多少：富余就加深，吃满就保持（超时会走上面的降深分支）
        // 门槛要严：0.6 会让它每两轮就试一次更深的、然后超时降回来（实测 30 手触发 176 次）。
        // 0.35 意味着「这一轮只花掉分配时间的 1/3」，下一轮才有把握加深。
        const spent = Date.now() - nowT;
        const span = Math.max(1, subDeadline - nowT);
        if (spent < span * 0.35 && depthAdj < depthCeil) depthAdj += 1;
        // 上限来自跨手记忆时，本手内不再自行放宽（否则等于没记，又会爬上去撞超时）；
        // 放宽改由「上一手在这个上限处还很空」在收尾时决定，一手只判定一次。
        else if (spent < span * 0.15 && depthCeil < D_CAP && !ceilMemo) depthCeil += 1;
        else if (depthAdj >= depthCeil && spent < span * 0.2) cheapAtCeil = true;
      }
      let bestScore = -Infinity;
      for (const i of active) {
        const c = candidates[i];
        const st = stats[i];
        st.sum += scores[i];
        st.sq += scores[i] * scores[i];
        st.n += 1;
        const mean = st.sum / st.n;
        const spread = Math.sqrt(Math.max(0, st.sq / st.n - mean * mean));
        let score = mean - riskNow * spread + (priorOf.get(`${c.from}>${c.to}`) || 0) * 0.01
          + (coopOf.get(`${c.from}>${c.to}`) || 0) + (tacticOf.get(`${c.from}>${c.to}`) || 0);
        if (isRevisit(state, c) && !G.pieceAt(state, c.to)) score -= 2000;   // 别在原地来回摆
        // 记下「标准误」：噪声带用它判断哪些候选其实是并列的
        stats[i].se = st.n ? Math.max(0.5, spread / Math.sqrt(st.n)) : 0;
        stats[i].meanNow = mean;
        if (score > bestScore) { bestScore = score; chosenScore = score; best = c; chosenKey = `${c.from}>${c.to}`; }
      }
      // 收敛早停：最好着连续 N 个世界不变就收工，让 budgetMs 变成真正意义上的「上限」。
      // 注意它是「世界数」的天花板：EARLY=6 时实测每手只跑 10 个世界就停，
      // 再想多看世界必须先把它关掉（state.earlyOff 按座位）。
      if (EARLY_STOP > 0 && samples >= 2 && !(state.earlyOff && state.earlyOff[seat])) {
        if (chosenKey !== null && chosenKey === stableKey) stableRounds += 1;
        else { stableRounds = 0; stableKey = chosenKey; }
        if (stableRounds >= EARLY_STOP) { EARLY_STATS.stopped += 1; break; }
      }
    }

    // 深度上限回写（跨手记忆）：这一手真正跑完的最高深度就是下一手的上限；
    // 如果在本手上限处仍然只花掉 20% 的时间，说明这个局面还能更深，放宽一层。
    if (adaptive && ceilOn) {
      state.ceilMemo = state.ceilMemo || {};
      let next = depthOk > 0 ? depthOk : Math.max(2, depthCeil - 1);
      if (cheapAtCeil && next < D_CAP) { next += 1; ADAPT_STATS.relax = (ADAPT_STATS.relax || 0) + 1; }
      if (ceilMemo > 0 && next >= ceilMemo) ADAPT_STATS.held = (ADAPT_STATS.held || 0) + 1;
      state.ceilMemo[seat] = Math.max(2, Math.min(D_CAP, next));
    }

    // 噪声带内定序：bestScore ± K×标准误 之内的候选其实分不出高下，
    // 这时按 rootPrior 挑（静态启发式是确定性的），别让采样噪声决定走哪步。
    // 噪声带宽度：可按座位覆盖（state.stableK[seat]），供同局 A/B 用。
    // STABLE_K=0（默认）等于这一步整个关掉 —— 于是"统计上分不开"的候选直接交给采样噪声。
    const kStable = (state.stableK && state.stableK[seat] !== undefined) ? state.stableK[seat] : STABLE_K;
    if (kStable > 0 && best && samples >= 2) {
      const bi = candidates.indexOf(best);
      const seB = (bi >= 0 && stats[bi].se) || 0;
      const band = kStable * Math.sqrt(seB * seB + seB * seB);
      let tieBest = best;
      let tiePrior = priorOf.get(`${best.from}>${best.to}`) || 0;
      let tieKey = `${best.from}>${best.to}`;
      candidates.forEach((c, i) => {
        const st2 = stats[i];
        if (!st2.n) return;
        const mean = st2.meanNow;
        const key2 = `${c.from}>${c.to}`;
        const finalI = mean - riskNow * Math.sqrt(Math.max(0, st2.sq / st2.n - mean * mean))
          + (priorOf.get(key2) || 0) * 0.01 + (coopOf.get(key2) || 0) + (tacticOf.get(key2) || 0)
          - (isRevisit(state, c) && !G.pieceAt(state, c.to) ? 2000 : 0);
        if (finalI < chosenScore - band) return;
        const pr = priorOf.get(key2) || 0;
        // 先验也相等时按坐标定序：否则「两枚炸弹抢同两个行营」这类完全等价的选择
        // 每次都由随机顺序决定，表面上就是「同一局面每步都换主意」
        if (pr > tiePrior + 1e-9 || (Math.abs(pr - tiePrior) <= 1e-9 && key2 < tieKey)) {
          tiePrior = pr; tieBest = c; tieKey = key2;
        }
      });
      if (tieBest !== best) { best = tieBest; chosenKey = `${best.from}>${best.to}`; }
    }

    if (best) {
      if (tacticPhase && TACT) { try { TACT.commit(state, seat, best, tacticPhase); } catch (err) { /* 统计而已 */ } }
      if (relayBonus(state, seat, best) > 0) DOM_STATS.relay += 1;
      if (homeCoverBonus(state, seat, best) > 0) DOM_STATS.home += 1;
      if (distractBonus(state, seat, best, null) > 0) DOM_STATS.distract += 1;
    }
    if (domRiskBase > 0 && chosenKey) {
      const dr = domRiskOf.get(chosenKey);
      if (dr !== undefined) {
        DOM_STATS.chosen += 1;
        if (dr < domRiskBase - 1e-9) DOM_STATS.chosenReduced += 1;
        else if (dr > domRiskBase + 1e-9) DOM_STATS.chosenWorse += 1;
      }
    }

    // 调试用：opts.explain 时把每个候选的分项摊开，便于事后归因「为什么没走那一步」
    if (opts.explain) {
      const rows = candidates.map((c, i) => {
        const st = stats[i];
        const mean = st.n ? st.sum / st.n : NaN;
        const spread = st.n ? Math.sqrt(Math.max(0, st.sq / st.n - mean * mean)) : NaN;
        const key = `${c.from}>${c.to}`;
        return {
          move: key, n: st.n, mean, spread,
          prior: priorOf.get(key) || 0,
          risk: riskOf.get(key) || 0,
          domRisk: domRiskOf.get(key) || 0,
          coop: coopOf.get(key) || 0,
          tactic: tacticOf.get(key) || 0,
          final: st.n ? mean - riskNow * spread + (priorOf.get(key) || 0) * 0.01
            + (coopOf.get(key) || 0) + (tacticOf.get(key) || 0) : NaN,
        };
      }).sort((x, y) => y.final - x.final);
      root.__trace = TR;
      root.__priors = priors.map((x) => ({ move: `${x.m.from}>${x.m.to}`, score: x.score }));
      const payload = {
        seat, samples, adv, profile: profileName,
        noCapture: state.noCapture || 0,
        candidates: candidates.length,
        rows,
      };
      root.__explain = payload;
      // opts.explain 传对象时顺便回填：analyze() 用它，避免多个引擎共用 __explain 互相覆盖
      if (typeof opts.explain === "object") Object.assign(opts.explain, payload);
    }

    if (!samples) {
      // 兜底：一层 AI 的走法也要过一遍同样的规则（不许折返、不许已知必死撞击、必须在过滤后的集合里），
      // 否则「搜索没跑起来」这一步会把前面所有约束全部绕过去。
      try {
        const fallback = G.aiChoose(state, seat);
        const inActual = fallback && actual.some((m) => m.from === fallback.from && m.to === fallback.to);
        if (inActual && !isKnownSuicide(state, seat, fallback, mem, domains)) {
          return { from: fallback.from, to: fallback.to };
        }
      } catch (err) { /* ignore */ }
      return { from: best.from, to: best.to };
    }
    return { from: best.from, to: best.to };
  }

  /**
   * 界面参谋（2026-11-03）：返回「一代」的推荐走法 + 对敌暗子的猜测。
   * 走法来自 choose 的真实打分链（同一套过滤 + 同样的搜索），只是把候选分项摊开；
   * 猜子来自 beliefRowsView（IPF 后验），与实战里 rootPrior 用的是同一张表。
   * 注意：它**会**占用预算，budgetMs 建议 200~500（不参与正式走子）。
   */
  function analyze(state, seat, opts = {}) {
    const budget = Math.max(60, opts.budgetMs || 350);
    const box = {};
    let best = null;
    try {
      best = choose(state, seat, { budgetMs: budget, explain: box, profile: opts.profile });
    } catch (err) { best = null; }
    const rows = (box.rows || []).slice(0, 6).map((r) => {
      const parts = String(r.move).split(">");
      return {
        from: parts[0], to: parts[1],
        score: r.final, mean: r.mean, spread: r.spread, prior: r.prior,
      };
    });
    // 猜子：敌方未亮明子，取后验 top2
    const guesses = [];
    try {
      const doms = inferDomains(state, seat);
      const rows2 = beliefRowsView(state, seat, doms);
      if (rows2) {
        // ⚠ beliefRows 的 key 是**棋子 id**（不是格 id）。按 position 取会一条都取不到。
        const byId = new Map();
        for (const p of state.pieces) if (p.position) byId.set(p.id, p);
        for (const [pid, row] of rows2) {
          const p = byId.get(pid);
          if (!p || p.owner === seat) continue;
          if (G.visibleTo(state, seat, p)) continue;
          if (!row || !row.size) continue;
          const list = [];
          let tot = 0;
          for (const [t, w] of row) { if (w > 0) { list.push([t, w]); tot += w; } }
          if (!tot) continue;
          list.sort((a, b) => b[1] - a[1]);
          const top = list[0];
          const pr = top[1] / tot;
          const dist = {};
          for (const [t, w] of list) dist[t] = w / tot;
          // 面板按「档位」显示（大/旅/小/雷/旗/炸），所以整条分布要出来，不能只给 top1
          if (dist[top[0]] >= 0.2) guesses.push({ pos: p.position, type: top[0], p: dist[top[0]], dist });
        }
        guesses.sort((a, b) => b.p - a.p);
      }
    } catch (err) { /* 猜子失败不影响走法 */ }
    return {
      best, moves: rows, guesses: guesses.slice(0, 8),
      profile: box.profile || null, samples: box.samples || 0,
      adv: box.adv || 0, engine: "gen1",
    };
  }

  const API = {
    choose, analyze, applyOpening, applyOpenings, PROFILES, forceReport,
    _internals: { buildWorld, generateMoves, simulate, evaluate, search, inferDomains, PROFILES,
      flagThreats, isThreatRelief, FLAG_STATS, rankMemory, RANK_NUM, isKnownSuicide, knownFloor, ASSIGN,
      flagRisk, canReachCell, beatsProb, enemyDominants, dominantScore, BASE_CORNERS,
      isUselessHqMove, applyZoneSoft, ZQ_SOFT_ON, ZONE_MEAN, applyZonePair, ZPAIR_ON, ZPAIR_STATS, cellIdxOf, bigProbOf, applyEatPrior, lambdaOf, KAPPA, rootPrior, FLOOR_ADD, worldTau, uncertaintyOf, ADAPT_STATS, COOP_STATS, coopBonus, coopIntruders, coopWeight, root, GRAB_STATS, applyGrabPrior, ENT_MAX, EAT_ANY, jointRows, evidenceRowsOnly, JOINT_SOFT, JOINT_ON, JOINT_STATS, isRealEngineer, ownLatentDomain, EAT_ON, EAT_K, EAT_STATS, DEFPRIOR_ON, DEFPRIOR_K, BATTLE_STATS, isEarlyEngineerRaid, engineerMineProb, ENG_RAID, ENG_PM, domRisk, relayBonus, pincerBonus, PINCER_BONUS, homeCoverBonus, distractBonus,
      beliefRows, beliefRowsView, formationPosterior, formationPriorRow,
      CAMP_ESC, RISK_K, MINE_STOP, ENG_HOLD, TACTIC_ON, QS_ON, QS_MAX, QS_WIDTH, HVT_RANK, BOMB_PAY_RANK, BOMB_EAT_K, BOMB_HOLD_K, TAC_STATS, QS_DEF, EARLY_STOP, STABLE_K, EARLY_STATS, VERIFY_ON, VERIFY_EXT, VERIFY_MAX, VERIFY_STATS, bombRecaptureAvailable, hvtTargets, qsearch, generateCaptures, QS_MIN, initPosOf, ZONEQ_ON, ZONE_CAP, zoneOfPos, zoneQuota, ZONEQ_STATS, ZONE_ON, ZONE_SOFT, ZONE_MARGIN, ZCAP, zoneOfNode, zoneLedger, zoneSoftOf, ZONE_STATS, PROBE_K, probeWeight, PROBE_W, POS_OPEN_PLIES, POS_COLS, posPriorRow, SEARCH_STATS, buildWorldTruth, ORACLE, MASK_OPP, hiddenIdsOf, makeMaskView, applyView, restoreView, beliefMatrix, MATRIX_ON, FATE_ON, TRACK_ON, QUOTA_ON, WORLD_MATRIX, WORLD_LAP, LAP_BASE, LAP_SWAPS, LAP_MARG, assignTypesLAP, assignTypesMarginal, swapSample, worldPriors, lapBaseCached, quotaPropagate, fatePriorRow, fateState, trackPriorRow, trackStats, seatPools, ipfFit, applyPrior, mulPrior, TYPES,
      DOM_STATS, ALLY_OF, forceLedger, beliefProbs, rowValue, FORCE_VALUE, STANDARD_POOL,
      REL_BY_RANK, pieceExpect, FORCE_STATS, FORCE_EDGE_SCALE, forceReport, refineRow,
      STYLE_STATS, pickStyle, dominantCandidates },
  };
  root.JunqiAI = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
