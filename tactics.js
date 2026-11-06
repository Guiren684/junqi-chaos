/*
 * 战术 DLC（2026-11-06）
 *
 * ============================ 双急所（dual）============================
 *
 * 用户口径（11-06 两次订正，这里是**领会之后**的统一版本）：
 *
 *   双急所的本质不是「某种固定招式」，而是**两路同时压同一面大本营**：
 *   被攻方一步只能堵一处，所以只要两路里有一路能进，就赢。
 *   「手段」随信息而变化，这正是它灵活的地方：
 *
 *   | 旗旁那一格是什么 | 谁能上          | 形态                  |
 *   |---|---|---|
 *   | 未知 / 可能是雷   | 只有工兵（吃雷）| 派工兵去挖（双飞）     |
 *   | 已经确认是雷      | 工兵直接吃      | 还是工兵，但不必赌     |
 *   | 空                | **任何子**      | 双急所（不一定是工兵） |
 *   | 已确认是旗        | 任何子，直接闯  | 扛旗                   |
 *
 *   所以代码里**不写「挖雷战术」和「空门战术」两套**，只写一件事：
 *   找出「那面很可能是旗的大本营」以及它旁边的**可用通路（lane）**，
 *   每条 lane 标注它是什么（mine / empty），再按 lane 的性质决定谁能走。
 *   两家各认领一条不同的 lane —— 这就是「双」。
 *
 * ---- 回合顺序决定了分工，不需要任何协商协议 ----
 *   回合：南 → 西 → 北 → 东。设我方＝东：
 *     上家＝北（靶子）、下家＝南（上家的对家，会来救）、对家＝西（搭档）。
 *   我方压第一路（t）→ 南来救（t+1）→ 西补第二路（t+2）→ 北反吃（t+3）→
 *   我方（t+4，唯一能出手的一手：挡南）→ 南（t+5，正是要挡的人）。
 *   也就是：**「我方挡下家」不是设计选择，是回合表算出来的唯一时机。**
 *
 * ---- 与旧写法的区别 ----
 * 旧写法（「先识别三角雷，再派单」）不可行：只能钉死单雷位（砍 39~64% 兼容阵），
 * 多雷位联合识别精度不够，派单会经常派错。现在只依赖三件**公开或可估**的事：
 *   ① 我方的子能不能一步走到某个旗旁格；
 *   ② 那格多大概率是雷（信念行）/ 是不是空的（看得见）；
 *   ③ 压上去之后敌方有几个人能一步回吃（＝「有没有拦截」）。
 */
(function (root) {
  "use strict";
  const G = root.JunqiGame;
  const B = root.JunqiBoard;
  if (!G || !B) return;

  const ENV = (typeof process !== "undefined" && process.env) ? process.env : {};
  const NUM = (k, d) => { const v = Number(ENV[k]); return Number.isFinite(v) ? v : d; };

  const ORDER = G.TURN_ORDER || ["south", "west", "north", "east"];

  const ON        = NUM("JJ_DUAL", 1) > 0;
  const K_DIG     = NUM("JJ_DUAL_DIG", 170);     // 工兵吃旗旁雷（一路）
  const K_RUSH    = NUM("JJ_RUSH_STEP", 150);    // 占住旗旁空门（一路，任何子）
  const K_TAKE    = NUM("JJ_RUSH_TAKE", 420);    // 直接闯大本营（按「那里是旗」的信念折算）
  const K_KILL    = NUM("JJ_DUAL_KILL", 130);    // 吃掉能威胁搭档那一手的下家子
  const K_BLOCK   = NUM("JJ_DUAL_BLOCK", 60);    // 堵住下家奔袭的铁路线
  const TTL       = NUM("JJ_DUAL_TTL", 12);      // 计划存活手数
  const MINE_P    = NUM("JJ_DUAL_MINE_P", 0.35); // 判「这格是雷」的门槛（与 ENG_PM 对齐）
  const FLAG_P    = NUM("JJ_RUSH_FLAG_P", 0.35); // 判「这面大本营是旗」的门槛
  const MAX_INT   = NUM("JJ_DUAL_MAXINT", 0);    // 允许的最大「即时回吃者」数量（0=严格无拦截）
  // 第三路（用户 11-06 第三次订正，也是**最本质**的一条）：
  // 双急所 = **同时制造两个「敌方必须应」的威胁**，让被攻方和它的对家不可能同时救。
  // 「两路攻旗」只是它的一个实例；另一个同样常见的实例是
  //   **一家攻旗上、一家炸弹抓令子** —— 敌方一手只能挡一处，另一处就得吃亏。
  // 实现上不写死任何一种组合，只写「威胁」这一层：
  //   谁刚做出一件敌方必须应的事 → 记到黑板；搭档只要做出**另一种**威胁，就成立「双」。
  // 第四层：**预备态**（2026-11-06）。动机来自代码事实，不是直觉：
  // evaluate 是团队账、树按回合交替、`simulate` 吃旗会把那一家整队摘掉 ——
  // 所以「兑现」（搭档扛旗）在 depth 3~4 里是**看得见**的暴利。
  // 真正看不见的是「准备」：把子往敌旗区送，在 4 层视野里纯粹是亏分。
  // 于是引擎永远在"临门一脚"时才想起要有人在那儿，而那时人不在（实测 fly=0 / guard=0）。
  // 这一层只做一件事：计划未成立时，给"朝目标旗区靠近"的位移一点分，并**不让先到的人乱走**。
  const K_PREP    = NUM("JJ_PREP_K", 90);        // 靠近目标旗区
  const K_HOLD    = NUM("JJ_PREP_HOLD", 70);     // 已经到位就别乱走（防止反复横跳）
  const PREP_TTL  = NUM("JJ_PREP_TTL", 14);      // 预备态寿命（手）
  const PREP_ROW  = NUM("JJ_PREP_ROW", 3);       // 目标象限 row>=3 算「旗区」
  const K_FORK    = NUM("JJ_FORK", 200);         // 搭档替我制造第二威胁
  const FORK_TTL  = NUM("JJ_FORK_TTL", 6);       // 威胁的有效手数（对手一轮之内）

  const STATS = { plans: 0, dig: 0, step: 0, take: 0, fly: 0, guard: 0,
    expire: 0, clean: 0, twoLane: 0, fork: 0, forkPick: 0,
    prepStart: 0, prepStep: 0, prepBoth: 0, holdOut: 0 };

  // ---------- 座位关系 ----------
  const iOf = (seat) => ORDER.indexOf(seat);
  const upOf   = (seat) => ORDER[(iOf(seat) + ORDER.length - 1) % ORDER.length]; // 上家
  const nextOf = (seat) => ORDER[(iOf(seat) + 1) % ORDER.length];                // 下家
  const mateOf = (seat) => ORDER[(iOf(seat) + 2) % ORDER.length];                // 对家

  const teamOf = (seat) => B.teamOf(seat);
  const ally = (a, b) => B.teamOf(a) === B.teamOf(b);
  const cellSeat = (cell) => String(cell).split("-")[0];
  const rowOf = (cell) => Number(String(cell).split("-")[1]);

  function bbOf(state, team) {
    state.bb = state.bb || {};
    return state.bb[team] || (state.bb[team] = {});
  }

  /**
   * 生成「某个座位」的合法着法。
   * G.allLegalMoves 里有 `state.turn !== seat ⇒ 空表` 的守卫，而战术项要在**我方回合**里
   * 推演敌方的选择，所以必须临时把 turn 借过去再还回来。
   * （第一版没借 turn，interceptCount 永远返回 0，「有没有拦截」形同不存在。）
   */
  function movesFor(state, s) {
    if (!s || (state.out && state.out[s])) return [];
    const t = state.turn;
    try {
      state.turn = s;
      return G.allLegalMoves(state, s);
    } catch (err) {
      return [];
    } finally {
      state.turn = t;
    }
  }

  const probOf = (rows, pid, type) => {
    if (!rows) return 0;
    const row = rows.get(pid);
    if (!row) return 0;
    const v = row.get ? row.get(type) : row[type];
    return Number(v) || 0;
  };

  /** 旗旁格：大本营格的邻居，且属于靶子自己象限 */
  function guardCells(target) {
    const hqs = B.hqCells(target);
    const out = [];
    for (const hq of hqs) {
      for (const c of (B.BOARD.neighbors.get(hq) || [])) {
        if (cellSeat(c) !== target) continue;
        if (hqs.indexOf(c) >= 0) continue;
        if (out.indexOf(c) < 0) out.push(c);
      }
    }
    return out;
  }

  /**
   * 找到「很可能是旗的大本营」+ 它旁边的**可用通路**。
   * lane 的 kind 决定谁能走：mine 只有工兵、empty 谁都能。
   */
  function findTargets(state, seat, rows, forced) {
    const target = forced || upOf(seat);
    if (!target || (state.out && state.out[target])) return [];
    const out = [];
    STATS.ftCall = (STATS.ftCall || 0) + 1;
    for (const hq of B.hqCells(target)) {
      const p = G.pieceAt(state, hq);
      if (!p || p.owner !== target) continue;          // 空大本营进去就出不来，不算目标
      let pf;
      if (p.type === "flag") pf = 1;                   // 已经明牌
      else if (G.visibleTo(state, seat, p)) pf = 0;     // 看得见且不是旗 ⇒ 这面不是旗
      else pf = probOf(rows, p.id, "flag");
      if (pf < FLAG_P) { STATS.ftNoFlag = (STATS.ftNoFlag || 0) + 1; continue; }
      const lanes = [];
      for (const c of guardCells(target)) {
        if ((B.BOARD.neighbors.get(hq) || []).indexOf(c) < 0) continue;   // 只取这面旗旁的
        const q = G.pieceAt(state, c);
        if (!q) { lanes.push({ cell: c, kind: "empty", p: 1 }); continue; }
        if (q.owner !== target) continue;              // 有别的子挡着，不算通路
        const pm = q.type === "mine" ? 1 : probOf(rows, q.id, "mine");
        if (pm >= MINE_P) lanes.push({ cell: c, kind: "mine", p: pm, id: q.id });
      }
      if (!lanes.length) { STATS.ftNoLane = (STATS.ftNoLane || 0) + 1; continue; }
      out.push({ target, hq, pf, lanes });
    }
    out.sort((a, b) => b.pf - a.pf);
    return out;
  }

  /** 走这条路的那一手能不能赢（mine 只有工兵能吃，empty 谁都能进） */
  function laneOk(lane, mover) {
    if (!mover) return false;
    if (lane.kind === "empty") return mover.type !== "flag" && mover.type !== "mine";
    return mover.type === "engineer";                  // 唯一能吃雷的兵种
  }

  function laneValue(lane, plan) {
    const w = Math.max(0.5, plan.pf || 0.5);
    return (lane.kind === "mine" ? K_DIG : K_RUSH) * w;
  }

  /**
   * 「有没有拦截」——这一路压上去之后，敌方有几个人能一步回吃那一格。
   *
   * 不能拿现在的盘面去数：现在那格上摆的是靶子自己的雷，而靶子和它的对家是**同一队**，
   * 对家根本不能攻击自家雷 —— 拿现在数永远得到 0，等于「任何局面都判定没人防守」。
   * 正确做法是把局面临时改成**压上去之后的样子**再数。
   */
  function interceptCount(state, plan, lane, seat) {
    const target = plan.target;
    const mine = state.pieces.filter((p) => p.owner === seat && p.position);
    const crit = (lane.kind === "mine") ? ((p) => p.type === "engineer") : ((p) => p.type !== "flag" && p.type !== "mine");
    const cand = mine.find(crit);
    if (!cand) return 99;
    const from = cand.position;
    const def = (lane.kind === "mine" && lane.id) ? state.pieces.find((p) => p.id === lane.id) : null;
    const defPos = def ? def.position : null;
    const turn0 = state.turn;
    try {
      cand.position = lane.cell;
      if (def) def.position = null;
      let n = 0;
      for (const s of [target, mateOf(target)]) {
        if (!s || (state.out && state.out[s])) continue;
        state.turn = s;
        for (const m of G.allLegalMoves(state, s)) if (m.to === lane.cell) n += 1;
      }
      return n;
    } finally {
      cand.position = from;
      if (def) def.position = defPos;
      state.turn = turn0;
    }
  }

  const RANK_BIG = { commander: 9, army: 8, division: 7 };

  /**
   * 这一手算不算「敌方必须应」的威胁。返回 {kind, v} 或 null。
   * 只认三种（都要在**下一手内**兑现，否则不叫急所）：
   *   bomb —— 炸弹去吃一个「很可能是令子（司/军/师）」的目标：敌方的核心子力被点名
   *   eat  —— 白吃一个值钱的子（信念上胜率够高）
   * 旗那一路不在这里算：它由 plan（lane / take）单独给分，但打上 kind = flag 记进黑板。
   */
  function threatOf(state, seat, move, rows) {
    const def = G.pieceAt(state, move.to);
    if (!def || def.owner === seat || ally(def.owner, seat)) return null;
    const mover = G.pieceAt(state, move.from);
    if (!mover) return null;
    const r = rows ? rows.get(def.id) : null;
    const pBig = r ? ((r.get ? r.get("commander") : 0) || 0) + ((r.get ? r.get("army") : 0) || 0) + ((r.get ? r.get("division") : 0) || 0) : 0;
    if (mover.type === "bomb" && pBig >= 0.35) return { kind: "bomb", v: 120 * pBig };
    const pWin = r ? 1 - (((r.get ? r.get("commander") : 0) || 0) + ((r.get ? r.get("army") : 0) || 0)
      + ((r.get ? r.get("division") : 0) || 0) + ((r.get ? r.get("brigade") : 0) || 0)) : 0;
    if (pWin >= 0.6 && (RANK_BIG[def.type] || 0) >= 7) return { kind: "eat", v: 60 };
    return null;
  }

  /** 搭档刚做出来的威胁（黑板上的，未过期） */
  function mateThreat(state, seat) {
    const bb = bbOf(state, teamOf(seat));
    const t = bb.threat;
    if (!t) return null;
    if ((state.moveCount || 0) - t.at > FORK_TTL) { bb.threat = null; return null; }
    if (t.seat === seat) return null;              // 自己刚做的，不算「双」
    return t;
  }

  /** 搭档的那一手在哪（判断「另一路」和「挡谁」） */
  function mateActor(state, plan) {
    let best = null;
    for (const p of state.pieces) {
      if (!p.position || p.owner !== plan.flyer) continue;
      if (cellSeat(p.position) !== plan.target) continue;
      const r = rowOf(p.position);
      if (r < 2) continue;
      if (!best || r > best.r) best = { id: p.id, cell: p.position, r };
    }
    return best;
  }

  /** mid 是否落在 from→to 的直线铁路中间（用于「挡路」） */
  function betweenRail(from, to, mid) {
    if (from === to || mid === from || mid === to) return false;
    const lines = (B.BOARD && B.BOARD.straightRailLines) || [];
    for (const line of lines) {
      const a = line.indexOf(from);
      const b = line.indexOf(to);
      if (a < 0 || b < 0) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const m = line.indexOf(mid);
      if (m > lo && m < hi) return true;
    }
    return false;
  }

  // ---------- 阶段 ----------
  //   lane     —— 我这一手压一路（mine 用工兵、empty 任何子），或直接闯旗格
  //   laneMate —— 搭档压另一路
  //   guard    —— 搭档已经站上旗旁，我负责挡住下家
  function prepare(state, seat, legal, rows) {
    if (!ON) return null;
    if (state.dualOff && state.dualOff[seat]) return null;
    if (state.out && state.out[seat]) return null;
    const mate = mateOf(seat);
    if (!mate || mate === seat) return null;

    // ---- 共享大脑的边界（2026-11-06）----
    // 黑板是按**队**存的，但「同一队」不等于「同一个大脑」：
    // 玩家那一局里，东西是一个大脑（互明 + 共享意图），南北是两个独立大脑。
    // 如果只按队共享，南北也会读到对方的意图 —— 那不是配合，那是作弊。
    // state.cmdSeats 指定哪些座位归同一个大脑；不给就退回「四家共用一个黑板」的旧行为。
    const inCmd = !state.cmdSeats || state.cmdSeats.indexOf(seat) >= 0;
    if (!inCmd) {
      // 不在共享大脑里：只做**单座**能做的事（自己看得见的旗门），不读也不写黑板
      const solo = findTargets(state, seat, rows);
      for (const t of solo) {
        const usable = t.lanes.filter((ln) => legal.some((m) => m.to === ln.cell && laneOk(ln, G.pieceAt(state, m.from))));
        const canTake = legal.some((m) => m.to === t.hq);
        if (!usable.length && !canTake) continue;
        const plan = {
          target: t.target, hq: t.hq, pf: t.pf, lanes: t.lanes.slice(),
          lane: usable.length ? usable[0].cell : null,
          digger: seat, flyer: null, at: state.moveCount || 0,
        };
        return { kind: "lane", plan, seat, rows, solo: true };
      }
      return null;
    }

    const bb = bbOf(state, teamOf(seat));
    let plan = bb.dual || null;

    if (plan) {
      const stale = (state.moveCount || 0) - plan.at > TTL;
      const flagGone = !state.pieces.some((p) => p.type === "flag" && p.owner === plan.target && p.position);
      const hqEmpty = !G.pieceAt(state, plan.hq);
      if (stale || flagGone || hqEmpty || (state.out && state.out[plan.target])) {
        bb.dual = null; plan = null; STATS.expire += 1;
      }
    }

    if (plan) {
      if (plan.digger === seat) {
        const act = mateActor(state, plan);
        // 搭档已经贴到旗旁 ⇒ 轮到我去挡（回合表算出来的唯一时机）
        if (act && (state.moveCount || 0) - plan.at >= 2) return { kind: "guard", plan, seat, rows };
        return { kind: "lane", plan, seat, rows };
      }
      if (plan.flyer === seat) return { kind: "laneMate", plan, seat, rows };
      return null;
    }

    // 搭档已经做出一个「必应威胁」⇒ 我只要做另一种威胁，就成立「双急所」
    const mt = mateThreat(state, seat);
    if (mt) return { kind: "fork", plan: null, seat, mate: mt, rows };

    // 建计划：只有「发起方」能建（避免两家抢着建、互相覆盖）
    const cands = findTargets(state, seat, rows);
    for (const t of cands) {
      const usable = t.lanes.filter((ln) => legal.some((m) => m.to === ln.cell && laneOk(ln, G.pieceAt(state, m.from))));
      const canTake = legal.some((m) => m.to === t.hq);
      if (!usable.length && !canTake) continue;
      // 敌方已经有人能一步回吃 ⇒ 这一路不赌；但若还有别的路能走，就换那条
      const good = usable.filter((ln) => interceptCount(state, t, ln, seat) <= MAX_INT);
      if (!good.length && !canTake) continue;
      const pick = good[0] || usable[0];
      plan = {
        target: t.target, hq: t.hq, pf: t.pf,
        lanes: t.lanes.slice(), lane: pick ? pick.cell : null,
        digger: seat, flyer: mate, at: state.moveCount || 0,
      };
      bb.dual = plan;
      STATS.plans += 1;
      if (t.lanes.length >= 2) STATS.twoLane += 1;
      if (good.length && interceptCount(state, t, pick, seat) === 0) STATS.clean += 1;
      return { kind: "lane", plan, seat, rows };
    }

    // 没有「立刻能兑现」的机会 ⇒ 进预备态：把子往目标旗区送。
    // 这是整个 DLC 从"摆设"变成"能跑"的关键 —— 实测 fly=0/guard=0 的根因就是
    // 兑现窗口出现时，两家都没有人在旗区。
    const pt = prepTarget(state, seat, rows);
    if (pt && !inZone(state, seat, pt.target)) {
      return { kind: "prep", plan: pt, seat, rows };
    }
    return null;
  }

  function nodeXY(cell) {
    const n = B.BOARD.byId.get(cell);
    return n ? { x: n.x, y: n.y } : null;
  }
  /** 到某个格子的曼哈顿距离（够用：只比大小，不做路径规划） */
  /** lane 有两种写法（对象 {cell,kind} 与纯字符串），这里统一取 id ——
   *  2026-11-06 踩过：把对象直接传给 distTo，byId.get 拿不到 → 恒返回 99，
   *  于是「搭档就位」永远判 false，闸门把双飞全掐掉了。 */
  const cellId = (c) => (c && typeof c === "object") ? c.cell : c;

  function distTo(cell, hq) {
    const a = nodeXY(cell), b = nodeXY(hq);
    if (!a || !b) return 99;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  /** 某个座位有没有子踩在 target 的旗区（row>=PREP_ROW） */
  function inZone(state, seat, target) {
    for (const p of state.pieces) {
      if (!p.position || p.owner !== seat) continue;
      if (cellSeat(p.position) !== target) continue;
      if (rowOf(p.position) >= PREP_ROW) return true;
    }
    return false;
  }

  /**
   * 预备态：读黑板（有就用，没有就自己立一个）。
   * 黑板里只放「打哪面旗」，谁去准备由**回合表**决定（轮到谁谁去），不需要派单协议。
   */
  function prepTarget(state, seat, rows) {
    if (!ON) return null;
    if (state.usePrep === false) return null;
    if (state.prepOff && state.prepOff[seat]) return null;   // 可按座位关（A/B 用）
    const inCmd = !state.cmdSeats || state.cmdSeats.indexOf(seat) >= 0;
    const bb = bbOf(state, teamOf(seat));
    let t = bb.prep || null;
    if (t) {
      const stale = (state.moveCount || 0) - t.at > PREP_TTL;
      const gone = (state.out && state.out[t.target]) || !G.pieceAt(state, t.hq);
      if (stale || gone) { bb.prep = null; t = null; }
    }
    if (!t) {
      const cands = findTargets(state, seat, rows, null);
      if (!cands.length) return null;
      const pick = cands[0];
      // 记住「可走通路」的位置：预备态的真正目标是**站到 lane 旁边**（下一手能上），
      // 不是"离大本营近"。第一版按到 hq 的曼哈顿距离算，结果人在旗区里却永远差一步，
      // 这也是 plans 一直上不去的原因（实测 ftCall=273、计划仍只有 1 次）。
      t = { target: pick.target, hq: pick.hq, pf: pick.pf, at: state.moveCount || 0, by: seat,
            lanes: pick.lanes.map((l) => l.cell) };
      if (inCmd) bb.prep = t;
      STATS.prepStart += 1;
    }
    return t;
  }

  /**
   * 接近某条通路的信用（不是"落上去"，是"走过去"）。
   * 为什么必须有：计划一旦成立，搭档就进 laneMate 阶段，而那一阶段原来**只奖励落上去**。
   * 人不在附近 ⇒ 一分不给 ⇒ 计划干等 14 手然后过期（实测 plans=2 而 fly 仍为 0）。
   * 加上这一层，计划才能把第二个人"拉"过来。
   */
  function approachCredit(state, seat, move, plan, ratio) {
    const lanes = plan.lanes && plan.lanes.length ? plan.lanes : (plan.hq ? [plan.hq] : []);
    if (!lanes.length) return 0;
    const target = plan.target;
    if (cellSeat(move.to) !== target) return 0;
    const dOf = (cell) => {
      let m = 99;
      for (const c of lanes) { const d = distTo(cell, cellId(c)); if (d < m) m = d; }
      return m;
    };
    const d0 = dOf(move.from), d1 = dOf(move.to);
    if (!(d1 < d0) || d1 > 2) return 0;              // 只认“two moves 之内”的靠近，别把人送进敌境深处
    if (d1 === 0) return 0;                          // 站上去了，交给 lane 分支算
    const w = Math.max(0.4, plan.pf || 0.5);
    return K_PREP * w * (ratio || 0.6) * (d1 === 1 ? 1 : 0.7);
  }

  /**
   * 搭档「就位」了吗：它有子已经在 lane 上，或离某条 lane 只有 1 步。
   * 这是「双」的硬条件 —— 一个人先上叫单飞，必然被反吃；
   * 实测就是这样：dig 一直在发生、fly 一直是 0，因为发起方见到机会就自己先动手了。
   */
  function mateReady(state, plan, mateSeat) {
    const mate = mateSeat || plan.flyer;
    if (!mate) return false;
    const lanes = plan.lanes && plan.lanes.length ? plan.lanes : [];
    if (!lanes.length) return false;
    for (const p of state.pieces) {
      if (!p.position || p.owner !== mate) continue;
      for (const c of lanes) if (distTo(p.position, cellId(c)) <= 1) return true;
    }
    return false;
  }

  /** 这一手把子往目标旗区送，值多少分；把已到位的子拽走，扣分 */
  function prepBonus(state, seat, move, plan) {
    const mover = G.pieceAt(state, move.from);
    if (!mover) return 0;
    const target = plan.target;
    const lanes = plan.lanes && plan.lanes.length ? plan.lanes : [plan.hq];
    // 到「最近的一条通路」还有几步：1 = 下一手就能上（预备到位），2 = 还差一手
    const dOf = (cell) => {
      let m = 99;
      for (const c of lanes) { const d = distTo(cell, cellId(c)); if (d < m) m = d; }
      return m;
    };
    const d0 = dOf(move.from), d1 = dOf(move.to);
    if (cellSeat(move.to) === target && d1 < d0) {
      const w = Math.max(0.4, plan.pf || 0.5);
      // 分档：到位（1 步可上）给满，逼近（2 步）给七成，其它按距离递减
      let k = d1 <= 1 ? 1.0 : (d1 === 2 ? 0.7 : 0.4);
      if (mover.type === "engineer" && plan.lanes && plan.lanes.length) k *= 1.15;  // 雷路只有工兵能上
      return K_PREP * w * k;
    }
    // ② 驻留：这一手把**已经在旗区**的子拉出去了，而搭档还没到 ⇒ 扣分（防反复横跳）
    if (cellSeat(move.from) === target && rowOf(move.from) >= PREP_ROW) {
      if (cellSeat(move.to) !== target || rowOf(move.to) < PREP_ROW) {
        if (!inZone(state, plan.flyer || mateOf(seat), target)) {
          return -K_HOLD * Math.max(0.4, plan.pf || 0.5);
        }
      }
    }
    return 0;
  }

  /** 挡下家：吃掉能吃到搭档那一手的子，或堵住它的铁路 */
  function guardBonus(state, seat, move, plan) {
    const act = mateActor(state, plan);
    if (!act) return 0;
    const down = nextOf(seat);
    if (!down) return 0;
    const threats = movesFor(state, down).filter((m) => m.to === act.cell);
    if (!threats.length) return 0;
    let v = 0;
    const at = G.pieceAt(state, move.to);
    if (at && at.owner === down) {
      const n = threats.filter((t) => t.from === move.to).length;
      if (n) v = K_KILL * Math.min(2, n);
    }
    for (const t of threats) {
      if (betweenRail(t.from, act.cell, move.to)) v = Math.max(v, K_BLOCK);
    }
    return v;
  }

  /** 这一手值多少分（权重 1.0，直接进最终分数，不走 prior 的 0.01 折算） */
  function bonus(state, seat, move, ph) {
    if (!ph) return 0;
    const plan = ph.plan;
    if (ph.kind === "prep") return prepBonus(state, seat, move, plan);
    if (ph.kind === "guard") return guardBonus(state, seat, move, plan);
    if (ph.kind === "fork") {
      const t = threatOf(state, seat, move, ph.rows);
      if (!t) return 0;
      if (t.kind === ph.mate.kind) return 0;       // 同样的威胁不算「双」（敌人一处就能解）
      return K_FORK * (0.6 + 0.4 * Math.min(1, t.v / 120));
    }

    // ① 直接闯大本营：吃到旗就赢了，量级远高于任何局面分；按「那里是旗」的信念折算
    if (move.to === plan.hq) return K_TAKE * Math.max(0.35, plan.pf || 0.35);

    // ② 压一路：mine 只有工兵能上、empty 谁都能上
    const lane = plan.lanes.find((ln) => ln.cell === move.to);
    if (!lane) {
      // 落不上去：如果是在往这条通路靠近，给一半信用（把搭档拉过来）
      // 搭档的接近信用给满（ratio=1.0）：0.5 时约 22 分，压不过局面分的常态差（10~30），
      // 于是"计划成立了，但搭档永远走不过来"。发起方仍只给 0.5（它已经能上，不必再远行）。
      return (ph.kind === "laneMate") ? approachCredit(state, seat, move, plan, 1.0)
        : (ph.kind === "lane" ? approachCredit(state, seat, move, plan, 0.35) : 0);
    }
    const mover = G.pieceAt(state, move.from);
    if (!laneOk(lane, mover)) return 0;
    // 「双」的闸：搭档还没就位时，发起方自己先上等于单飞（送死）。
    // 这里不给满额，只给三成，把机会留给「先等搭档、再一起上」。
    if (ph.kind === "lane" && !mateReady(state, plan)) {
      return laneValue(lane, plan) * 0.3;
    }
    // 搭档已经站在这条路上 ⇒ 我去占同一条没意义（「双」必须两路）
    const act = mateActor(state, plan);
    if (act && act.cell === lane.cell) return 0;
    return laneValue(lane, plan);
  }

  /** 选定这一手之后记账（判断这条战术到底有没有被真正执行） */
  function commit(state, seat, move, ph) {
    if (!ph || !move) return;
    const plan = ph.plan;
    // 预备态只记行为账（不写威胁黑板，那属于"已兑现"的语义）
    if (ph.kind === "prep") {
      const v = prepBonus(state, seat, move, plan);
      if (v > 0) STATS.prepStep += 1;
      else if (v < 0) STATS.holdOut += 1;
      return;
    }
    // 把「我这一手做出来的必应威胁」记到黑板，供搭档下一步接着做第二种。
    // 注意：只有归同一个大脑的座位才写 —— 否则「南北两个独立 AI」会互相读到意图，
    // 那不是配合，是作弊（对照组的 fork 计数也会变成假的）。
    const inCmd = !state.cmdSeats || state.cmdSeats.indexOf(seat) >= 0;
    if (ph.rows && inCmd) {
      const t = threatOf(state, seat, move, ph.rows);
      const bb = bbOf(state, teamOf(seat));
      if (t) bb.threat = { kind: t.kind, at: state.moveCount || 0, seat };
      else if (bb.threat && bb.threat.seat === seat) bb.threat = null;
      if (ph.kind === "fork") STATS.forkPick += 1;
      if (plan && (move.to === plan.hq || plan.lanes.some((ln) => ln.cell === move.to))) {
        bb.threat = { kind: "flag", at: state.moveCount || 0, seat };   // 攻旗上：同样是必应
        STATS.fork += 1;
      }
    }
    if (!plan) return;
    if (ph.kind === "guard") { if (guardBonus(state, seat, move, plan) > 0) STATS.guard += 1; return; }
    if (move.to === plan.hq) { STATS.take += 1; return; }
    const lane = plan.lanes.find((ln) => ln.cell === move.to);
    if (!lane) return;
    if (lane.kind === "mine") STATS.dig += 1; else STATS.step += 1;
    if (ph.kind === "laneMate") STATS.fly += 1;
  }

  const API = {
    ON, STATS, prepare, bonus, commit,
    guardCells, upOf, nextOf, mateOf, findTargets, laneOk, movesFor, mateActor,
    prepTarget, prepBonus, inZone, distTo, mateReady, approachCredit,
    _setPlan(state, team, plan) { bbOf(state, team).dual = plan; },
    _getPlan(state, team) { return bbOf(state, team).dual || null; },
  };
  root.JunqiTactics = API;
})(typeof window !== "undefined" ? window : globalThis);
