/*
 * dlc.js — DLC 运行时（选择器 / 出牌 / 抽取 / tick / AI）
 * 只做编排，不做效果；效果全在 dlc_atoms.js。
 */
(function (global) {
  "use strict";
  const G = global.JunqiGame;
  const B = global.JunqiBoard;
  const S = global.JunqiDLCStatus;
  const A = global.JunqiDLCAttoms;
  const C = global.JunqiDLCCards;
  const INFO = (B && B.PIECE_INFO) || {};
  const SEATS = ["south", "west", "north", "east"];
  const HUMAN = "south";

  let opts = { humanOnly: false, aiPlays: true, verbose: false };

  function enabled() {
    if (global.__DLC_ON__ === true) return true;
    if (typeof location !== "undefined" && location.search) {
      return /[?&]dlc=1/.test(location.search);
    }
    return false;
  }

  function isAlive(state, seat) {
    return state && !state.out[seat];
  }

  function enemies(state, seat) {
    return SEATS.filter((s) => B.teamOf(s) !== B.teamOf(seat));
  }

  function ownAlive(state, seat) {
    return state.pieces.filter((p) => p.owner === seat && p.position && p.type !== "decoy");
  }

  function rankOf(type) {
    return (INFO[type] && INFO[type].rank) || 0;
  }
  // 只按"看得见的东西"排序：没亮明的子一律当 0，避免 AI / 玩家从候选顺序里偷看
  function publicRank(p) {
    if (!p) return 0;
    if (!p.revealed) return 0;
    return rankOf(p.type);
  }

  function emptyCells(state) {
    const used = new Set(state.pieces.filter((p) => p.position).map((p) => p.position));
    return B.BOARD.nodes.filter((n) => n.kind !== "camp" && !used.has(n.id)).map((n) => n.id);
  }

  function nearEnemyHq(state, cell, seat) {
    const hqs = enemies(state, seat).flatMap((s) => B.hqCells(s));
    const node = B.BOARD.byId.get(cell);
    if (!node) return 99;
    let best = 99;
    for (const hq of hqs) {
      const h = B.BOARD.byId.get(hq);
      if (!h) continue;
      best = Math.min(best, Math.abs(h.x - node.x) + Math.abs(h.y - node.y));
    }
    return best;
  }

  // ---------------- 选择器 ----------------
  let bindingsRef = null;
  function pick(state, seat, spec) {
    // 无目标卡必须返回一个空绑定：否则 play() 里的 for 循环一次都不跑，
    // 卡"打出去了"但一个原子都没执行（夜战/无线电静默/控盘 全中过这个坑）
    if (!spec || spec.kind === "none") return [{}];
    const n = typeof spec.count === "number" ? spec.count : 1;
    const f = spec.filter || {};
    const foes = enemies(state, seat);
    const inFoe = (p) => foes.includes(p.owner);

    switch (spec.kind) {
      case "allOwn": {
        const pool = ownAlive(state, seat).filter((p) => p.type !== "flag");
        return pool.slice(0, n === 0 ? pool.length : n).map((p) => ({ target: p }));
      }
      case "allEnemy": {
        const pool = state.pieces.filter((p) => p.position && inFoe(p) && p.type !== "flag");
        return pool.slice(0, n === 0 ? pool.length : n).map((p) => ({ target: p }));
      }
      case "enemyLowestRank": {
        const pool = state.pieces
          .filter((p2) => p2.position && inFoe(p2) && p2.type !== "flag" && p2.type !== "mine")
          .sort((a, b) => rankOf(a.type) - rankOf(b.type));
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "enemyInCamp": {
        const pool = state.pieces.filter((p2) => {
          if (!p2.position || !inFoe(p2)) return false;
          const nd = B.BOARD.byId.get(p2.position);
          return nd && nd.kind === "camp";
        });
        pool.sort((a, b) => rankOf(b.type) - rankOf(a.type));
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "enemySnipe": {
        // 冷枪：铁路上、没打过仗的敌子，且从你某个子沿同一条直线看过去没有阻挡
        const rail = (id) => (B.BOARD.railNeighbors.get(id) || []).length > 0;
        const mine = state.pieces.filter((p2) => p2.owner === seat && p2.position);
        const nodeOf = (p2) => B.BOARD.byId.get(p2.position);
        const clearLine = (me, foe) => {
          const a = nodeOf(me);
          const b = nodeOf(foe);
          if (!a || !b) return false;
          const sameCol = a.x === b.x;
          const sameRow = a.y === b.y;
          if (!sameCol && !sameRow) return false;
          const between = state.pieces.filter((p2) => {
            if (!p2.position || p2.position === me.position || p2.position === foe.position) return false;
            const c = B.BOARD.byId.get(p2.position);
            if (!c) return false;
            if (sameCol) return c.x === a.x && Math.min(a.y, b.y) < c.y && c.y < Math.max(a.y, b.y);
            return c.y === a.y && Math.min(a.x, b.x) < c.x && c.x < Math.max(a.x, b.x);
          });
          return between.length === 0;
        };
        const pool = state.pieces.filter((p2) => p2.position && inFoe(p2)
          && !p2.hasFought && p2.type !== "flag" && rail(p2.position));
        const shootable = pool.filter((t) => mine.some((m) => clearLine(m, t)));
        return shootable.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "enemyCampEmpty": {
        // 潜伏：敌方半场里空着的行营
        const used = new Set(state.pieces.filter((p2) => p2.position).map((p2) => p2.position));
        const cells = B.BOARD.nodes
          .filter((x2) => x2.seat && x2.seat !== seat && B.teamOf(x2.seat) !== B.teamOf(seat)
            && x2.kind === "camp" && !used.has(x2.id))
          .map((x2) => x2.id);
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "enemySnipe": return num("枚") + "铁路上没打过仗的敌子";
      case "enemyCampEmpty": return "敌方空着的行营";
      case "enemyHazard": {
        // 炸弹随便拔；地雷必须先被看见（不能靠"我知道这里有雷"来偷看）
        const pool = state.pieces.filter((p2) => p2.position && inFoe(p2)
          && (p2.type === "bomb" || (p2.type === "mine" && p2.revealed)));
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "ownHqPiece": {
        const pool = state.pieces.filter((p2) => {
          if (p2.owner !== seat || !p2.position) return false;
          const nd = B.BOARD.byId.get(p2.position);
          return nd && nd.kind === "hq";
        });
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "allyHqPiece": {
        const mate = SEATS.find((s2) => B.teamOf(s2) === B.teamOf(seat) && s2 !== seat);
        if (!mate) return [];
        const pool = state.pieces.filter((p2) => {
          if (p2.owner !== mate || !p2.position) return false;
          const nd = B.BOARD.byId.get(p2.position);
          return nd && nd.kind === "hq";
        });
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "enemyBomb": {
        const pool = state.pieces.filter((p2) => p2.position && inFoe(p2) && p2.type === "bomb");
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "enemyFought": {
        const pool = state.pieces.filter((p2) => p2.position && inFoe(p2) && p2.hasFought && p2.type !== "flag");
        pool.sort((a, b) => publicRank(b) - publicRank(a));
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "ownMine": {
        const pool = state.pieces.filter((p2) => p2.owner === seat && p2.position && p2.type === "mine");
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "ownEngineer": {
        const pool = state.pieces.filter((p2) => p2.owner === seat && p2.position && p2.type === "engineer");
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "ownLowest": {
        const pool = ownAlive(state, seat).filter((p2) => p2.type !== "flag" && p2.type !== "mine")
          .sort((a, b) => rankOf(a.type) - rankOf(b.type));
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "allyPiece": {
        const mate = SEATS.find((s2) => B.teamOf(s2) === B.teamOf(seat) && s2 !== seat);
        if (!mate) return [];
        const pool = state.pieces.filter((p2) => p2.owner === mate && p2.position && p2.type !== "flag");
        return pool.slice(0, n).map((p2) => ({ target: p2 }));
      }
      case "rowCells": {
        // 取一条横排的空格（楚河汉界/坚壁清野）
        const row = (spec.row != null) ? spec.row : 5;
        const cells = B.BOARD.nodes.filter((x2) => x2.row === row && x2.kind !== "camp"
          && !state.pieces.some((p2) => p2.position === x2.id)).map((x2) => x2.id);
        return cells.slice(0, n === 0 ? cells.length : n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "nearCells": {
        const ref = spec.refPiece || (bindingsRef && bindingsRef[0] && bindingsRef[0].target);
        if (!ref || !ref.position) return [];
        const range = Math.max(1, spec.range || 2);
        const seen = new Set([ref.position]);
        let frontier = [ref.position];
        for (let step = 0; step < range; step += 1) {
          const next = [];
          for (const cur of frontier) {
            const nbs = (B.BOARD.neighbors.get(cur) || []).concat(B.BOARD.railNeighbors.get(cur) || []);
            for (const nb of nbs) {
              if (seen.has(nb)) continue;
              seen.add(nb);
              next.push(nb);
            }
          }
          frontier = next;
        }
        const used = new Set(state.pieces.filter((p2) => p2.position).map((p2) => p2.position));
        const cells = [...seen].filter((c) => c !== ref.position && !used.has(c));
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "ownFlag": {
        const f = state.pieces.find((p2) => p2.owner === seat && p2.position && p2.type === "flag");
        return f ? [{ target: f }] : [];
      }
      case "centerCells": {
        const cells = B.BOARD.nodes.filter((x2) => x2.seat === null
          && !state.pieces.some((p2) => p2.position === x2.id)).map((x2) => x2.id);
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "ownPiece": {
        let pool = ownAlive(state, seat).filter((p) => p.type !== "flag" && p.type !== "mine");
        if (f.rankMin) pool = pool.filter((p) => rankOf(p.type) >= f.rankMin);
        if (f.rankMax) pool = pool.filter((p) => rankOf(p.type) <= f.rankMax);
        pool.sort((a, b) => rankOf(b.type) - rankOf(a.type));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "ownPair": {
        const pool = ownAlive(state, seat).filter((p) => p.type !== "flag" && p.type !== "mine");
        if (pool.length < 2) return [];
        pool.sort((a, b) => rankOf(b.type) - rankOf(a.type));
        const out = [];
        for (let i = 0; i < n && i < pool.length; i += 1) {
          const hi = pool[i];
          const lo = pool[pool.length - 1 - i];
          if (hi === lo) break;
          out.push({ a: hi, b: lo });
        }
        return out;
      }
      case "ownBackCells": {
        const used = new Set(state.pieces.filter((p) => p.position).map((p) => p.position));
        const cells = B.BOARD.nodes
          .filter((x) => x.seat === seat && x.row >= 4 && x.kind !== "camp" && !used.has(x.id))
          .map((x) => x.id)
          .sort((x, y) => nearEnemyHq(state, x, seat) - nearEnemyHq(state, y, seat));
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "ownLowBack": {
        const pool = state.pieces
          .filter((p) => p.owner === seat && p.position && rankOf(p.type) <= 3 && rankOf(p.type) >= 2)
          .filter((p) => { const n2 = B.BOARD.byId.get(p.position); return n2 && n2.row >= 4; })
          .sort((a, b) => rankOf(a.type) - rankOf(b.type));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "ownFrontCells": {
        // 己方靠中央的两排（row 0/1）——地雷原本永远去不了的地方
        const used = new Set(state.pieces.filter((p2) => p2.position).map((p2) => p2.position));
        const cells = B.BOARD.nodes
          .filter((x2) => x2.seat === seat && x2.row <= 1 && x2.kind !== "camp" && x2.kind !== "hq" && !used.has(x2.id))
          .map((x2) => x2.id);
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "ownAnyEmpty": {
        const used = new Set(state.pieces.filter((p) => p.position).map((p) => p.position));
        const cells = B.BOARD.nodes
          .filter((x) => x.seat === seat && x.kind !== "camp" && !used.has(x.id))
          .map((x) => x.id);
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "ownHqCell": {
        const used = new Set(state.pieces.filter((p) => p.position).map((p) => p.position));
        const cells = B.hqCells(seat).filter((c) => !used.has(c));
        return cells.slice(0, 1).map((c) => ({ cells: [c], n: 1 }));
      }
      case "enemyPiece": {
        let pool = state.pieces.filter((p) => p.position && inFoe(p));
        if (f.rankMin) pool = pool.filter((p) => !p.revealed || rankOf(p.type) >= f.rankMin);
        if (f.rankMax) pool = pool.filter((p) => !p.revealed || rankOf(p.type) <= f.rankMax);
        if (f.unfought) pool = pool.filter((p) => !p.hasFought);
        if (f.revealedOnly) pool = pool.filter((p) => p.revealed);
        pool.sort((a, b) => publicRank(b) - publicRank(a));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "enemyHighestRank": {
        // 只有亮明的子才算"最高军衔"，暗子无从得知
        const pool = state.pieces
          .filter((p) => p.position && inFoe(p) && p.type !== "flag" && p.type !== "mine" && p.revealed)
          .sort((a, b) => publicRank(b) - publicRank(a));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "enemyAdjacent": {
        const own = ownAlive(state, seat);
        const ring = new Set();
        for (const p of own) {
          for (const nb of (B.BOARD.neighbors.get(p.position) || [])) ring.add(nb);
        }
        let pool = state.pieces.filter((p) => p.position && inFoe(p) && ring.has(p.position));
        if (f.rankMax) pool = pool.filter((p) => !p.revealed || rankOf(p.type) <= f.rankMax);
        pool.sort((a, b) => publicRank(b) - publicRank(a));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "enemyOnRail": {
        let pool = state.pieces.filter((p) => p.position && inFoe(p) && (B.BOARD.railNeighbors.get(p.position) || []).length);
        if (f.unfought) pool = pool.filter((p) => !p.hasFought);
        pool.sort((a, b) => publicRank(b) - publicRank(a));
        return pool.slice(0, n).map((p) => ({ target: p }));
      }
      case "cell": {
        const cells = emptyCells(state).sort((x, y) => nearEnemyHq(state, x, seat) - nearEnemyHq(state, y, seat));
        return cells.slice(0, n).map((c) => ({ cells: [c], n: 1 }));
      }
      case "peekSpread": {
        const out = [];
        for (const foe of foes) {
          const pool = state.pieces.filter((p) => p.owner === foe && p.position);
          if (pool.length) out.push({ pool: pool.slice(0, 1), n: 1 });
          if (out.length >= n) break;
        }
        return out;
      }
      case "peekArea": {
        const range = typeof spec.range === "number" ? spec.range : 1;
        const center = B.BOARD.nodes.filter((n2) => n2.seat === null);
        const pool = center.length ? [center[Math.floor(center.length / 2)]] : [];
        const out = [];
        for (const c of pool) {
          const near = [];
          for (const nd of B.BOARD.nodes) {
            if (Math.abs(nd.x - c.x) + Math.abs(nd.y - c.y) <= range && nd.kind !== "camp") near.push(nd.id);
          }
          const pieces = state.pieces.filter((p) => p.position && near.includes(p.position));
          out.push({ pool: pieces, n: pieces.length });
        }
        return out;
      }
      case "peekSpecial": {
        const pool = state.pieces.filter((p) => p.position && inFoe(p) && (p.type === "mine" || p.type === "bomb"));
        return [{ pool, n: pool.length }];
      }
      default:
        return [];
    }
  }

  // ---------------- 出牌 ----------------
  function resolveParam(v, tier) {
    if (typeof v === "string" && v.charAt(0) === "$") return tier[v.slice(1)];
    return v;
  }


  // 某个选择器现在能选什么（which=1 主选择器，2 副选择器）。
  // UI 的"点卡 → 点目标"就靠它把可选格/可选子摊出来，和 play() 用的是同一套 pick。
  function bindingsFor(state, seat, cardId, which, picks, tierLv, wide) {
    const card = C.BY_ID[cardId];
    if (!card || !state.dlc || !state.dlc.on) return [];
    const hand = state.dlc.hands[seat] || [];
    const entry = hand.find((h) => h.id === cardId);
    const tier = card.tiers[Math.min(2, ((entry && entry.tier) || tierLv || 1) - 1)] || {};
    const src = which === 2 ? card.sel2 : card.select;
    if (!src || (which === 1 && src.kind === "none")) return [];
    const spec = JSON.parse(JSON.stringify(src));
    if (typeof spec.count === "string") spec.count = tier[spec.count.slice(1)];
    if (typeof spec.range === "string") spec.range = tier[spec.range.slice(1)];
    if (which === 2) {
      if (spec.range === undefined && card.range != null) spec.range = card.range;
      spec.refPiece = picks && picks[0] && picks[0].target;
    }
    // wide：把"能选几枚"放开，把**所有可选目标**都摊出来给玩家点，
    // 否则点卡后只有系统自己挑的那一枚是绿的，玩家换不了目标
    if (wide) spec.count = 99;
    A.bind(state);
    try { return pick(state, seat, spec) || []; } catch (e) { return []; }
  }

  // 手牌里的被动卡：点一下就用掉（从手牌移除并生效）
  function usePassiveFromHand(state, seat, cardId) {
    if (!state || !state.dlc || !state.dlc.on) return { ok: false, msg: "先开启 DLC" };
    const card = C.BY_ID[cardId];
    if (!card) return { ok: false, msg: "没有这张卡" };
    if (card.when !== "passive") return { ok: false, msg: "这张卡不是被动，要选目标" };
    const hand = state.dlc.hands[seat] || [];
    const idx = hand.findIndex((h) => h.id === cardId);
    if (idx < 0) return { ok: false, msg: "手上没有" };
    const tier = hand[idx].tier || 1;
    hand.splice(idx, 1);
    const effects = applyPassive(state, seat, card, tier, cardId, {});
    if (!state.dlc.passiveTaken) state.dlc.passiveTaken = {};
    if (!state.dlc.passiveTaken[seat]) state.dlc.passiveTaken[seat] = [];
    state.dlc.passiveTaken[seat].push({ id: cardId, tier });
    state.dlc.played = state.dlc.played || [];
    state.dlc.played.push({ seat, id: cardId, tier, turn: state.moveCount, effects, passive: true });
    return { ok: true, card, effects, passive: true };
  }

  function play(state, seat, cardId, tierLv, forced, direct, forced2) {
    if (!state.dlc || !state.dlc.on) return { ok: false, msg: "DLC 未开启" };
    const card = C.BY_ID[cardId];
    if (!card) return { ok: false, msg: "没有这张卡" };
    const hand = state.dlc.hands[seat] || [];
    const idx = hand.findIndex((h) => h.id === cardId);
    if (idx < 0 && !direct) return { ok: false, msg: "手上没有" };
    if (card.when === "setup") return { ok: false, msg: "配比卡在布阵阶段生效，对局中打不出" };
    if (card.when === "passive") return { ok: false, msg: "被动卡持有即生效，不用打" };
    const entry = idx >= 0 ? hand[idx] : { id: cardId, tier: tierLv || 1 };
    const tier = card.tiers[Math.min(2, (entry.tier || tierLv || 1) - 1)];
    const used = Object.assign({}, tier === undefined ? {} : {});
    // 展开 $params
    const t = {};
    for (const k of Object.keys(tier || {})) t[k] = tier[k];

    A.bind(state);

    // 代价
    if (card.cost) {
      const costCtx = { seat, params: card.cost, n: card.cost.count || 1 };
      const op = A.ATOMS[card.cost.op];
      if (op) op.apply(state, costCtx);
    }

    // 选择目标
    const spec = JSON.parse(JSON.stringify(card.select || { kind: "none" }));
    if (typeof spec.count === "string") spec.count = t[spec.count.slice(1)];
    if (typeof spec.range === "string") spec.range = t[spec.range.slice(1)];
    let bindings = pick(state, seat, spec);
    if (forced && forced.length) bindings = forced;
    bindingsRef = bindings;

    // 第二选择器：给 RELOCATE / SWAP_POS 提供落点或对手
    let sel2Binds = [];
    if (card.sel2) {
      const s2 = JSON.parse(JSON.stringify(card.sel2));
      if (typeof s2.count === "string") s2.count = t[s2.count.slice(1)];
      if (s2.range === undefined && card.range != null) s2.range = card.range;
      s2.refPiece = bindings[0] && bindings[0].target;
      sel2Binds = pick(state, seat, s2);
      if (forced2 && forced2.length) sel2Binds = forced2;
    }

    // 跑原子
    const effects = [];
    for (const bind of bindings) {
      const ctx = {
        seat,
        target: bind.target || null,
        targets: bind.pool || [],
        a: bind.a || null,
        b: bind.b || null,
        cells: bind.cells || [],
        n: bind.n || 1,
        pool: bind.pool || [],
        turns: t.duration || t.turns || null,
        params: t,
        card,
      };
      const b2 = sel2Binds[Math.min(effects.length === -1 ? 0 : 0, sel2Binds.length - 1)] || sel2Binds[0];
      if (b2) {
        if (b2.cells) ctx.cells = b2.cells;
        if (b2.target && !ctx.b) ctx.b = b2.target;
      }
      for (const atom of card.atoms) {
        const op = A.ATOMS[atom.op];
        if (!op) continue;
        const local = Object.assign({}, ctx);
        if (atom.cond) local.cond = atom.cond;
        if (atom.op === "SPAWN") {
          local.params = { type: atom.type };
          if (atom.replace) {
            local.replaceTarget = ctx.target;
            if (!ctx.target) continue;
            local.cells = [];
            local.n = 1;
          } else {
            local.cells = ctx.cells;
            local.n = ctx.cells.length;
            if (!local.cells.length) continue;
          }
        }
        if (atom.op === "DELAY") {
          local.turns = atom.turns || 3;
          local.params = { then: { type: "tradeArea" } };
        }
        if (atom.op === "ADD_MERIT") local.n = resolveParam(atom.n, t) || 0;
        if (atom.op === "DRAW_CARD") local.n = atom.n || 1;
        if (atom.op === "REVIVE" && atom.repeat) {
          const times = resolveParam(atom.repeat, t) || 1;
          for (let k = 0; k < times; k += 1) op.apply(state, local);
          continue;
        }
        if (atom.op === "EFF_RANK") {
          A.ATOMS.EFF_RANK.apply(state, Object.assign({}, local, { turns: t.duration || 2 }));
          continue;
        }
        if (atom.op === "MARK") {
          S.add(state, { key: atom.key, target: (ctx.target && ctx.target.id) || null, until: t.duration || null });
          continue;
        }
        if (atom.op === "FREEZE" && atom.self) {
          // 冻结自己全体 1 回合（临阵磨枪）
          const own = ownAlive(state, seat);
          A.ATOMS.FREEZE.apply(state, Object.assign({}, local, { targets: own, turns: atom.turns || 1 }));
          continue;
        }
        if (atom.op === "RANK_SET" && atom.delta) {
          const cur = A.rankOf(ctx.target ? ctx.target.type : "platoon");
          const d = resolveParam(atom.delta, t);
          local.params = { rank: Math.max(1, Math.min(9, cur + d)) };
        }
        if (atom.op === "REVEAL") local.turns = atom.turns || 0;
        if (atom.op === "FORCE_TRADE" && ctx.target) local.b = ctx.target;
        if (atom.op === "FORCE_TRADE" && !local.a && ctx.target) local.a = ctx.target;
        const res = op.apply(state, local);
        if (res && res.length) effects.push(...res);
      }
    }

    // 用完即弃（开发者模式不扣手牌）
    if (idx >= 0) hand.splice(idx, 1);
    state.dlc.played = state.dlc.played || [];
    state.dlc.played.push({ seat, id: cardId, tier: entry.tier || 1, turn: state.moveCount, effects });
    A.log(state, "play", { seat, id: cardId, tier: entry.tier || 1, n: effects.length });
    noteCardUse(state, seat, card, entry.tier || tierLv || 1, {
      targets: describePlayTargets(state, seat, bindings),
      dev: !!direct,
    });
    if (opts.verbose && typeof console !== "undefined") {
      console.log(`[DLC] ${seat} 打出 ${cardId} ${card.name}（${effects.length} 个效果）`);
    }
    return { ok: true, card, effects };
  }

  // ---------------- 抽取 ----------------
  function rollTier(state) {
    const m = state.moveCount;
    const r = Math.random();
    if (m < 10) return 1;
    if (m < 60) return r < 0.5 ? 1 : 2;
    if (r < 0.3) return 1;
    if (r < 0.8) return 2;
    return 3;
  }

  function deal(state, reason) {
    if (!state.dlc || !state.dlc.on) return null;
    const alive = SEATS.filter((s) => isAlive(state, s));
    // 阶段池：配比卡只在开局（还没人走过）能抽到，之后抽到就是废卡
    const opening = !state.moveCount;
    const pool = C.CARDS.filter((c) => opening || c.when !== "setup").map((c) => c.id);
    // 洗牌
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let cursor = 0;
    const offers = {};
    for (const s of alive) {
      const three = [];
      for (let k = 0; k < 3 && cursor < pool.length; k += 1) {
        three.push({ id: pool[cursor], tier: rollTier(state) });
        cursor += 1;
      }
      offers[s] = three;
      if (!state.dlc.offers) state.dlc.offers = {};
      state.dlc.offers[s] = { three, reason };
    }
    state.dlc.dealAt = state.moveCount;
    return offers;
  }

  // 被动卡"持有即生效"：抽出 onTake 的原子逐个跑
  function applyPassive(state, seat, card, tierLv, cardId, opts) {
    if (!card || !card.onTake) return [];
    A.bind(state);
    const tier = card.tiers[Math.min(2, (tierLv || 1) - 1)] || {};
    const ctx = { seat, params: tier, turns: tier.duration || null, target: null, n: tier.count || 1 };
    const out = [];
    for (const atom of card.onTake) {
      const op = A.ATOMS[atom.op];
      if (!op) continue;
      // 注意：atom 的字段必须摊到 ctx 顶层——TEAM_MARK / MARK 读的是 ctx.key，
      // 只放进 params 会让所有被动卡挂上 key=undefined 的状态（静默失效）
      const res = op.apply(state, Object.assign({}, ctx, atom,
        { params: Object.assign({ team: "self" }, atom, tier) }));
      if (res && res.length) out.push(...res);
    }
    A.log(state, "passive", { seat, card: cardId || card.id, tier: tierLv || 1 });
    noteCardUse(state, seat, card, tierLv || 1, { passive: true, dev: !!(opts && opts.dev) });
    return out;
  }


  // AI 不会"点"卡，所以被动卡一到手就替它用掉。
  // 玩家那边仍然是抽到进手牌、自己决定什么时候点。
  function autoUsePassives(state, seat) {
    if (!state || !state.dlc || !state.dlc.on) return 0;
    const hand = (state.dlc.hands && state.dlc.hands[seat]) || [];
    let n = 0;
    for (let i = hand.length - 1; i >= 0; i -= 1) {
      const c = C.BY_ID[hand[i].id];
      if (!c || c.when !== "passive") continue;
      const r = usePassiveFromHand(state, seat, hand[i].id);
      if (r && r.ok) n += 1;
    }
    return n;
  }

  function take(state, seat, cardId) {
    const offer = state.dlc.offers && state.dlc.offers[seat];
    if (!offer) return null;
    const slot = offer.three.find((x) => x.id === cardId) || offer.three[0];
    if (!slot) return null;
    if (!state.dlc.hands[seat]) state.dlc.hands[seat] = [];
    offer.taken = cardId;
    const card = C.BY_ID[slot.id];

    // 所有卡都先进手牌（被动也一样），由玩家点一下才生效。
    // AI 那边不用点：aiTakeOffer / afterMove 会替它立刻用掉（见 autoUsePassives）。
    if (state.dlc.hands[seat].length >= 4) state.dlc.hands[seat].shift();
    state.dlc.hands[seat].push({ id: slot.id, tier: slot.tier });
    return slot;
  }

  // ---------------- tick / 到期 ----------------
  function tick(state) {
    if (!state.dlc || !state.dlc.on) return;
    A.bind(state);
    // 调虎离山：到点还没动，就把它推走
    for (const mv of (state.dlc.statuses || []).filter((x) => x.key === "mustMove")) {
      const p = state.pieces.find((x) => x.id === mv.target);
      if (!p || !p.position || p.moved) continue;
      if (mv.until == null || mv.until <= 1) {
        const nbs = (B.BOARD.neighbors.get(p.position) || []).filter(
          (c) => !state.pieces.some((x) => x.position === c)
        );
        if (nbs.length) {
          p.position = nbs[Math.floor(Math.random() * nbs.length)];
          A.log(state, "push", { piece: p.id });
        }
      }
    }
    S.tick(state, (st, status) => {
      // 兼容旧存档：老版本的三板斧状态带 until，靠到期转换；
      // 新版本按"战斗次数"扣，onBattle 里处理，这里是兜底
      if (status.key === "sanbanfu" && status.target) {
        const p = state.pieces.find((x) => x.id === status.target);
        if (p && p.position) {
          S.clear(state, "rankOverride", p.id);
          S.add(state, { key: "rankOverride", target: p.id, until: null, value: { rank: 5 } });
          p.revealed = true;
          p.revealedTo = "all";
          A.log(state, "expire", { piece: p.id, to: "regiment" });
        }
      }
    });
    // 封格 / 断路衰减
    if (state.dlc.blocks) {
      for (const k of Object.keys(state.dlc.blocks)) {
        state.dlc.blocks[k] -= 1;
        if (state.dlc.blocks[k] <= 0) delete state.dlc.blocks[k];
      }
    }
    // 延时爆炸
    if (state.dlc.pending && state.dlc.pending.length) {
      const keep = [];
      for (const p of state.dlc.pending) {
        if (state.moveCount >= p.at) {
          const cells = p.cells || [];
          for (const c of cells) {
            const ring = [c].concat(B.BOARD.neighbors.get(c) || []);
            const victims = state.pieces.filter((x) => x.position && ring.includes(x.position) && x.owner !== p.seat && B.teamOf(x.owner) !== B.teamOf(p.seat));
            for (const v of victims) A.kill(state, v, p.seat);
            if (victims.length) A.log(state, "boom", { cell: c, n: victims.length });
          }
        } else keep.push(p);
      }
      state.dlc.pending = keep;
    }
  }

  // ---------------- AI ----------------
  // 敌方离我方大本营多近（0 = 无威胁）
  function threatLevel(state, seat) {
    const hqs = B.hqCells(seat);
    let n = 0;
    for (const p of state.pieces) {
      if (!p.position || B.teamOf(p.owner) === B.teamOf(seat)) continue;
      const nd = B.BOARD.byId.get(p.position);
      if (!nd) continue;
      for (const hq of hqs) {
        const h = B.BOARD.byId.get(hq);
        if (!h) continue;
        if (Math.abs(h.x - nd.x) + Math.abs(h.y - nd.y) <= 2) { n += 1; break; }
      }
    }
    return n;
  }

  // 我方还有几个空格（"生"类卡能不能用）
  function ownEmpty(state, seat) {
    const used = new Set(state.pieces.filter((p) => p.position).map((p) => p.position));
    return B.BOARD.nodes.filter((n) => n.seat === seat && n.kind !== "camp" && !used.has(n.id)).length;
  }

  // 我方子旁边有没有"没亮"的敌子（"窥"类卡值不值）
  function unknownNeighbors(state, seat) {
    let n = 0;
    for (const p of state.pieces) {
      if (p.owner !== seat || !p.position || p.revealed) continue;
      for (const nb of (B.BOARD.neighbors.get(p.position) || [])) {
        const q = state.pieces.find((x) => x.position === nb);
        if (q && B.teamOf(q.owner) !== B.teamOf(seat) && !q.revealed) { n += 1; break; }
      }
    }
    return n;
  }

  // 纯预测（无副作用，不调 resolveBattle，避免 REDIRECT 之类改局面）
  function predict(state, att, def, inHq, mode) {
    if (!def) return "move";
    // 三板斧：这几场必胜
    if (S.get(state, "sanbanfu", att.id)) return "attacker";
    if (S.get(state, "sanbanfu", def.id)) return "defender";
    if (def.type === "flag") return att.type === "bomb" ? "both" : "attacker";
    if (inHq) return att.type === "bomb" ? "both" : "attacker";
    if (att.type === "bomb" || def.type === "bomb") return "both";
    if (def.type === "mine") return att.type === "engineer" ? "attacker" : (mode === "standard" ? "defender" : "both");
    const a = A.effRank(att);
    const d = A.effRank(def);
    return a === d ? "both" : (a > d ? "attacker" : "defender");
  }

  const TAG_BONUS = {
    "窥": 4, "守": 3, "生": 2, "兑": 4, "冻": 5, "移": 3,
    "变": 4, "诱": 5, "反": 2, "背": 3, "欺": 4, "堵": 4, "夺": 4, "诅咒": 1, "—": 0,
  };

  // 卡"本身"值多少 —— 不看当前有没有目标（选牌用这个：抽到时没目标，不代表以后没有）
  function cardValue(state, seat, entry) {
    const card = C.BY_ID[entry.id];
    if (!card) return -99;
    if (card.when !== "play") return -99;          // 配比/被动不该被"打出"
    const tier = card.tiers[Math.min(2, (entry.tier || 1) - 1)] || {};
    let s = 0;
    for (const atom of card.atoms) {
      const op = A.ATOMS[atom.op];
      if (!op || !op.project) continue;
      s += op.project(state, { seat, params: tier, turns: tier.duration || 2, target: null, n: tier.count || 1 });
    }
    s += TAG_BONUS[card.tag] || 0;
    // 局势修正
    if (card.tag === "守") s += threatLevel(state, seat) * 4;
    if (card.tag === "窥") s += unknownNeighbors(state, seat) * 2;
    if (card.tag === "生") s += Math.min(3, ownEmpty(state, seat)) * 2;
    if (card.tag === "冻") s += 2;
    const bigOwn = state.pieces.filter((p) => p.owner === seat && p.position && A.effRank(p) >= 7).length;
    if (bigOwn && card.atoms.some((a) => a.op === "IGNORE_RANK" || a.op === "EFF_RANK")) s += 6;
    if (card.cost) s -= 6;                          // 有代价的先扣
    if (state.dlc.merit && state.dlc.merit[seat] > 30) s += 1;
    return s;
  }

  // 出牌评分 = 卡本身价值 + "现在这一刻有没有用"
  function scoreCard(state, seat, entry) {
    const card = C.BY_ID[entry.id];
    if (!card || card.when !== "play") return -99;
    let binds = [];
    try { binds = candidates(state, seat, entry.id) || []; } catch (e) { binds = []; }
    const needTarget = card.select && card.select.kind !== "none";
    if (needTarget && !binds.length) return -99;
    return cardValue(state, seat, entry);
  }


  // ---------------- 卡面文案：从数据自动生成，不用手写 135 份 ----------------
  const SELECT_TEXT = {
    none: "",
    ownPiece: "己方棋子", ownPair: "己方两枚", ownLowest: "己方最小子",
    ownMine: "己方地雷", ownEngineer: "己方工兵", ownFlag: "己方军旗",
    ownHqCell: "己方大本营", ownAnyEmpty: "己方空格", ownFrontCells: "己方前两排空格",
    ownBackCells: "己方后两排空格", ownLowBack: "己方后两排小子",
    allOwn: "己方全体", allEnemy: "敌方全体",
    enemyPiece: "敌方棋子", enemyHighestRank: "敌方已明牌的最大子", enemyLowestRank: "敌方最小子",
    enemyAdjacent: "相邻敌子", enemyOnRail: "铁路上敌子", enemyInCamp: "行营内敌子",
    enemyBomb: "敌方炸弹", enemyFought: "战斗过的敌子",
    allyPiece: "盟友棋子",
    cell: "格子", rowCells: "一整排空地", centerCells: "中央空位", nearCells: "附近空位",
    peekSpread: "家各看一枚暗子", peekArea: "指定敌子及相邻四格", peekSpecial: "特殊位置的子",
  };

  const OP_TEXT = {
    PEEK: "查看", REVEAL: "明牌", CONCEAL: "隐藏身份", FAKE_TYPE: "伪装显示",
    RANK_MOD: "战力修正", RANK_SET: "改战力", EFF_RANK: "降战力",
    FORCE_TRADE: "强制同归于尽", NO_LOSS: "本次不死", IGNORE_RANK: "无视军衔必吃",
    MUTE_BOMB: "使炸弹失效", UNTARGETABLE: "不可被攻击",
    CHANGE_OWNER: "转为我方", SPAWN: "生成一子", REVIVE: "复活", REMOVE: "直接移除",
    DESTROY_RANDOM: "随机牺牲", SWAP_TYPE: "互换兵种", CLONE_TYPE: "复制兵种",
    BLOCK_CELL: "封锁格子", BLOCK_EDGE: "断路", UNBLOCK: "解除所有断路",
    ADD_MERIT: "军功", DRAW_CARD: "摸牌", DELAY: "延迟引爆",
    FREEZE: "冻结", MARK: "打标记", RELOCATE: "转移位置", SWAP_POS: "互换位置",
    NEGATE_SKILL: "封禁技能", GRANT_CHARGE: "技能次数 +1", REDIRECT: "互换攻守位置",
    ANON_MOVE: "移动不留痕",
    DEFEAT_RETREAT: "战败退回", GUARD_HQ: "大本营内判平兑", AS_MINE: "临时视为地雷",
    NIGHT: "全场明牌失效", FORCE_MOVE: "强制移动", BLAST: "范围爆破",
    TEAM_MARK: "全军获得效果",
  };


  // 一个原子 → 一句人话。参数从 tier 展开，缺省值按原子实现的默认值补。

  // 选择器 → 一句完整的目标短语（量词、单位都在这里定，别在外面拼）
  function selectPhrase(kind, n, spec) {
    const num = (k) => (n > 1 ? n + " " + k : "");
    switch (kind) {
      case "none": return "";
      case "peekSpread": return "四家各看 " + n + " 枚暗子";
      case "peekArea": return "指定敌子及相邻四格";
      case "peekSpecial": return "特殊位置的子";
      case "rowCells": return "同一排的 " + n + " 格空地";
      case "cell": return (n > 1 ? n + " 格" : "") + "指定格子";
      case "centerCells": return (n > 1 ? n + " 格" : "") + "中央空位";
      case "nearCells": return "附近空位";
      case "ownAnyEmpty": return "己方空格";
      case "ownFrontCells": return "己方前两排空地";
      case "ownBackCells": return "己方后两排空地";
      case "ownHqCell": return "己方大本营";
      case "allOwn": return "己方全体";
      case "allEnemy": return "敌方全体";
      case "ownPair": return "己方两枚";
      case "ownLowest": return "己方最小的一枚";
      case "ownLowBack": return num("枚") + "己方后两排的小子";
      case "ownHqPiece": return num("枚") + "己方大本营里的守军";
      case "allyHqPiece": return "盟友大本营里的守军";
      case "enemySnipe": return num("枚") + "铁路上没打过仗的敌子";
      case "enemyCampEmpty": return "敌方空着的行营";
      case "enemyHazard": return num("枚") + "敌方已探明的炸弹或地雷";
      case "enemyBomb": return num("枚") + "敌方炸弹";
      case "enemyOnRail": return num("枚") + "铁路上的敌子";
      case "enemyInCamp": return num("枚") + "行营里的敌子";
      case "enemyHighestRank": return "敌方已明牌的最大子";
      case "enemyLowestRank": return "敌方最小的一枚";
      case "ownMine": return num("枚") + "己方地雷";
      case "ownEngineer": return num("枚") + "己方工兵";
      case "ownFlag": return "己方军旗";
      case "allyPiece": return num("枚") + "盟友的棋子";
      default: {
        const base = SELECT_TEXT[kind];
        if (!base) return kind || "";
        const f = (spec && spec.filter) || {};
        const rn = (r) => {
          const t = A.RANK2TYPE && A.RANK2TYPE[r];
          return (t && INFO[t] && INFO[t].name) || (r + " 级");
        };
        let qual = "";
        if (f.rankMin && f.rankMax && f.rankMin === f.rankMax) qual = rn(f.rankMin);
        else if (f.rankMin && f.rankMax) qual = rn(f.rankMin) + "~" + rn(f.rankMax);
        else if (f.rankMin) qual = rn(f.rankMin) + "及以上";
        else if (f.rankMax) qual = rn(f.rankMax) + "及以下";
        if (qual && /棋子|敌子/.test(base)) return num("枚") + base.replace("棋子", qual).replace("敌子", qual + "敌子");
        return num("枚") + base;
      }
    }
  }

  function atomText(a, tier, card, nTargets) {
    const pv = (v, d) => {
      if (typeof v === "string" && v.startsWith("$")) {
        const x = tier[v.slice(1)];
        return x == null ? d : x;
      }
      return v == null ? d : v;
    };
    const turn = pv(a.turns, tier.duration != null ? tier.duration : null);
    const rankName = (r) => {
      const tn = A.RANK2TYPE && A.RANK2TYPE[r];
      return (tn && INFO[tn] && INFO[tn].name) || (r + " 级");
    };
    // 时长统一说成"（N 个回合）"/"（永久）"，放在句尾做括注；"回合" = 该座位的一次行动
    const durNote = (t) => (t ? "（" + (t === 1 ? "本回合" : t + " 个回合") + "）" : "");
    const durPrefix = (t) => (t ? (t === 1 ? "本回合内，" : t + " 个回合内，") : "");
    const teamWord = (a.team === "enemy") ? "敌方" : (a.team === "self" ? "己方" : "全场");

    switch (a.op) {
      case "RANK_MOD": {
        const d = pv(a.delta, 1);
        return "战力 " + (d >= 0 ? "+" : "") + d + " 级" + (turn ? durNote(turn) : "（永久）");
      }
      case "RANK_SET": {
        if (tier.rank != null) {
          return "战力改为" + rankName(tier.rank)
            + (a.cond === "lowCount" ? "（存活 ≤" + (tier.n || 2) + " 子时才生效）" : "");
        }
        if (a.delta != null) {
          const d = pv(a.delta, 1);
          return "战力 " + (d >= 0 ? "+" : "") + d + " 级" + (turn ? durNote(turn) : "（永久）");
        }
        return "战力改为" + rankName(pv(a.rank, 1)) + (turn ? durNote(turn) : "（永久）");
      }
      case "EFF_RANK":
        return "战力" + (a.params && a.params.rank ? ("降为 " + rankName(a.params.rank)) : "降低")
          + (turn ? durNote(turn) : "（永久）");
      case "NO_LOSS": {
        const u = (a.params && a.params.uses) || pv(a.uses, 1);
        return "本场战斗不会阵亡（" + u + " 次）";
      }
      case "IGNORE_RANK":
        if (turn === 1) return "本回合攻击无视军衔，谁都吃得下";
        return "攻击无视军衔，谁都吃得下" + durNote(turn);
      case "MUTE_BOMB":
        return teamWord + "炸弹有效但炸不死你的子" + durNote(turn);
      case "UNTARGETABLE":
        return durPrefix(turn) + "谁都打不到它";
      case "FREEZE": {
        const f = pv(a.turns, 1);
        if (f >= 90) return (a.self ? "己方全体" : "") + "从此不能再移动";
        return (a.self ? "己方全体" : "") + "冻结 " + (f === 1 ? "1 个回合" : f + " 个回合");
      }
      case "BLOCK_CELL":
        return durPrefix(turn) + "这些格子谁都走不进去";
      case "BLOCK_EDGE":
        return "切断这段铁路 " + (turn || 2) + " 个回合，双方都过不去";
      case "UNBLOCK":
        return "解除所有断路";
      case "ADD_MERIT":
        return "军功 +" + pv(a.n, 0);
      case "DRAW_CARD":
        return "抽 " + pv(a.n, 1) + " 张卡";
      case "DELAY":
        const d = pv(a.turns, 3); return (d === 1 ? "本回合结束时" : d + " 个回合后") + "引爆这一片";
      case "FORCE_MOVE": {
        const d = turn || 1;
        return (d === 1 ? "本回合" : d + " 个回合内") + "必须移动，否则被推到随机空格";
      }
      case "SPAWN": {
        const nm = (INFO[a.type] && INFO[a.type].name) || a.type;
        const n = card && card.tiers ? null : null;
        return (a.replace ? "就地变成" + nm : "生成" + nm);
      }
      case "REVIVE": {
        const r = pv(a.repeat, 1);
        return "复活 " + (r > 1 ? r + " 枚" : "1 枚") + "已阵亡的子";
      }
      case "DESTROY_RANDOM": {
        const c = (a.count || 1);
        const rm = a.filter && a.filter.rankMax ? ("（" + rankName(a.filter.rankMax) + "及以下）") : "";
        return "随机牺牲 " + c + " 枚己方子" + rm;
      }
      case "MARK": {
        const kv = {
          mineProof: "地雷加固（工兵撞上也同归于尽）",
          pierce: "本次攻击必胜",
          anon: "移动不留痕",
          sanbanfu: "到期军衔定为团长",
          growRank: "它每主动吃掉 1 个敌人就升 1 级（封顶军长）",
          decayRank: "它每个回合掉 1 级，直到变回工兵",
        };
        return kv[a.key] || ("打标记 " + a.key);
      }
      case "NEGATE_SKILL":
        { const sn = turn || 2; return "敌方 " + sn + " 个回合内不能用技能"; }
      case "GUARD_HQ":
        return durPrefix(turn) + "大本营内被攻一律判平兑";
      case "AS_MINE":
        return "这枚子按地雷结算" + durNote(pv(a.turns, 1));
      case "NIGHT":
        { const dn = turn || 10; return "所有明牌失效 " + dn + " 个回合（战斗中也不公布兵种）"; }
      case "REDIRECT":
        return "被吃时改为与攻击方互换位置";
      case "DEFEAT_RETREAT": {
        const u = (a.params && a.params.uses) || pv(a.uses, 1);
        return "战败时退回原位（" + u + " 次）";
      }
      case "REVEAL":
        return turn ? ("明牌，持续 " + turn + " 个回合") : "永久明牌";
      case "CONCEAL":
        return "重新变暗" + durNote(turn);
      case "FAKE_TYPE":
        return "对外显示成" + (((INFO[a.type] || {}).name) || "别的兵种") + durNote(turn);
      case "SWAP_TYPE":
        return "互换兵种";
      case "CLONE_TYPE":
        return "复制成同一兵种";
      case "CHANGE_OWNER":
        return "转为我方";
      case "REMOVE":
        return "直接移除";
      case "FORCE_TRADE":
        return "强制同归于尽";
      case "SWAP_POS":
        return "互换位置";
      case "RELOCATE": {
        const to = card && card.sel2 ? selectPhrase(card.sel2.kind, 1, card.sel2) : "指定空格";
        return "转移位置到" + (to || "指定空格");
      }
      case "BLAST":
        return "本格及相邻 4 格的敌子全部消灭";
      case "TEAM_MARK":
        return "全军获得效果";
      case "SANBANFU": {
        const u = tier.uses != null ? tier.uses : 3;
        return "接下来 " + u + " 场战斗必胜、不会阵亡；打完第 " + u + " 场后永久变成团长";
      }
      case "DISCARD_CARD":
        return "随机弃掉你手里 1 张战术卡";
      case "FOE_RANK": {
        const d = tier.delta != null ? tier.delta : -1;
        return "敌方全军攻击 " + d + " 级";
      }
      case "DUEL_EVEN":
        return "本回合它被攻击时改判平兑（谁撞谁一起死）";
      case "COND_RANK": {
        const d = tier.delta != null ? tier.delta : 1;
        const n = tier.n;
        const conds = {
          nine: "从中央九宫出发时",
          backRow: "打后两排没动过的子时",
          leaderDead: "你的司令阵亡后",
          attackHq: "攻大本营时",
          lowCount: "存活 ≤" + (n || 10) + " 子时",
          closerToHq: "打比我更靠近大本营的敌人时",
          crowd: "目标周围有 ≥" + (n || 3) + " 枚子时",
          adjAlly: "与盟友的子相邻时",
          defendHome: "在己方半场防守时",
          fromCamp: "从行营出击时",
          still: "守的是整局没动过的子时",
          lostBig: "己方已损失师长以上之后",
        };
        return "全军攻击 " + (d >= 0 ? "+" : "") + d + " 级（" + (conds[tier.cond] || tier.cond) + "）";
      }
      case "PEEK":
        return "查看 " + (nTargets || 1) + " 枚子的身份";
      default:
        return OP_TEXT[a.op] || a.op;
    }
  }

  function describeCard(cardId, tierLv) {
    const card = C.BY_ID[cardId];
    if (!card) return { effect: "", target: "", full: cardId };
    const tier = (card.tiers && card.tiers[Math.min(2, (tierLv || 1) - 1)]) || {};

    // 被动卡：直接从 onTake 读
    if (card.when === "passive") {
      const parts = (card.onTake || []).map((a) => {
        const t = OP_TEXT[a.op] || a.op;
        if (a.op === "TEAM_MARK") {
          const kv = { meritKill: "吃子得军功", bombSmall: "炸弹炸小子不消失",
            overreach: "小子撞大子判平兑", tianji: "小子打大子判平兑",
            revealOnKill: "击杀者明牌", chargeOnLoss: "被吃攒次数",
            scoutReward: "你的排长被吃时军功 +10",
            meritPerTurn: "全局第 60 步之后，每个回合军功 +" + (a.n || 2),
            yongguan: "吃掉 3 枚军长或司令后，工兵以外最小的一枚变成军长",
            growRank: "它每主动吃掉 1 个敌人就升 1 级（封顶军长）",
            decayRank: "它每个回合掉 1 级，直到变回工兵",
            vengeance: "你的子被吃后，下一回合全军攻击 +1" };
          if (a.key === "meritKill") return "每吃掉 1 枚敌子，军功 +" + (a.n || 8);
          if (a.key === "scoutReward") return "你的排长被吃时军功 +" + (a.n || 10);
          return kv[a.key] || "全军增益";
        }
        if (a.op === "GUARD_HQ") return "大本营内被攻一律平兑";
        return t;
      });
      const text = "持有即生效：" + parts.join("；");
      return { effect: text, target: "我方全军", full: card.name + "\n" + text };
    }

    // 主动卡：目标 + 效果
    const spec = Object.assign({}, card.select || {});
    let n = spec.count;
    if (typeof n === "string" && n.startsWith("$")) n = tier[n.slice(1)];
    const target = selectPhrase(spec.kind, typeof n === "number" ? n : 1, spec);

    const eff = [];
    const nTargets = (typeof n === "number" && n > 0) ? n : 1;
    for (const a of (card.atoms || [])) eff.push(atomText(a, tier, card, nTargets));

    // 代价也写出来，否则玩家不知道为什么这张卡亏
    let cost = "";
    if (card.cost && card.cost.op) {
      const c = card.cost;
      if (c.op === "DESTROY_RANDOM") cost = "代价：随机牺牲 " + (c.count || 1) + " 枚己方小子";
      else cost = "代价：" + (OP_TEXT[c.op] || c.op);
    }
    const effect = eff.filter(Boolean).join("；");
    const head = target ? ("对" + (/^\d/.test(target) ? " " : "") + target + "：" + effect) : effect;
    const text = cost ? (head + "；" + cost) : head;
    return {
      effect: text,
      target,
      cost,
      full: card.name + "\n" + text + (card.ai && card.ai.hint ? "\n提示：" + card.ai.hint : ""),
    };
  }

  // ---------------- 选牌（三选一）专用评分 ----------------
  // 出牌看"现在打出去值多少"，选牌看"这张卡进手牌以后值多少"。两者必须分开：
  // 被动卡在 scoreCard 里是 -99（不该被打出），选牌时却应该是最优先的。
  const PASSIVE_VALUE = {
    guardHq: 12, meritKill: 10, bombSmall: 13, overreach: 11,
    tianji: 9, revealOnKill: 7, chargeOnLoss: 6,
  };

  function opsOf(card) {
    const set = new Set();
    for (const a of (card.atoms || [])) set.add(a.op);
    for (const a of (card.onTake || [])) set.add(a.op);
    return set;
  }

  // 手牌协同：这张卡跟已有的牌配不配
  function synergy(state, seat, entry) {
    const card = C.BY_ID[entry.id];
    const hand = (state.dlc.hands && state.dlc.hands[seat]) || [];
    if (!card || !hand.length) return 0;

    const tags = new Set();
    let same = 0;
    let hasPierce = false;
    for (const h of hand) {
      const c = C.BY_ID[h.id];
      if (!c) continue;
      tags.add(c.tag);
      if (c.tag === card.tag) same += 1;
      if ((c.atoms || []).some((a) => a.op === "IGNORE_RANK")) hasPierce = true;
    }
    const myOps = opsOf(card);
    let s = 0;

    // ① 同类递减：同一条路别走三遍（封顶 -6，不至于把好卡压死）
    s -= Math.min(6, same * 2);

    // ② 控 + 兑：先把人定住，再从容换掉
    const hasControl = tags.has("冻") || tags.has("堵");
    if (hasControl && (myOps.has("FORCE_TRADE") || myOps.has("IGNORE_RANK") || myOps.has("REMOVE"))) s += 4;

    // ③ 窥 + 点杀：看得见才打得准
    const hasInfo = tags.has("窥");
    if (hasInfo && (myOps.has("REMOVE") || myOps.has("FORCE_TRADE") || myOps.has("CHANGE_OWNER"))) s += 3;

    // ④ 守 + 反：挨打才有得反
    const hasGuard = tags.has("守") || tags.has("背");
    if (hasGuard && (myOps.has("DEFEAT_RETREAT") || myOps.has("REDIRECT"))) s += 3;

    // ⑤ 补短板：一张信息牌都没有时，窥最值钱
    if (card.tag === "窥" && !hasInfo) s += 3;

    // ⑥ 保险件不囤第二张
    if (hasPierce && myOps.has("IGNORE_RANK")) s -= 5;

    // ⑦ 手牌满了，边际价值下降
    if (hand.length >= 4) s -= 4;

    return s;
  }

  function scorePick(state, seat, entry) {
    const card = C.BY_ID[entry.id];
    if (!card) return -99;

    if (card.when === "passive") {
      let s = 9;
      for (const atom of (card.onTake || [])) s += PASSIVE_VALUE[atom.key] || 6;
      // 已经挂着的团队状态不叠第二次
      if (S && state.dlc.statuses) {
        const dup = (card.onTake || []).some((a) => S.has(state, a.key, undefined, seat));
        if (dup) s = 2;
      }
      return s + synergy(state, seat, entry);
    }

    const base = cardValue(state, seat, entry);
    if (base <= -50) return base;   // 被动 / 阶段不对
    return base + synergy(state, seat, entry);
  }

  function aiChooseCard(state, seat) {
    const hand = (state.dlc.hands && state.dlc.hands[seat]) || [];
    if (!hand.length) return null;
    let best = null;
    let bestS = 6; // 阈值：太差的卡不用
    for (const h of hand) {
      const s = scoreCard(state, seat, h);
      if (s > bestS) { bestS = s; best = h; }
    }
    return best;
  }

  function aiTakeOffer(state, seat) {
    const offer = state.dlc.offers && state.dlc.offers[seat];
    if (!offer) return;
    const scored = offer.three.map((x) => ({ x, s: scorePick(state, seat, x) }));
    scored.sort((a, b) => b.s - a.s);
    take(state, seat, scored[0].x.id);
    autoUsePassives(state, seat);
  }

  // ---------------- 初始化 / 钩子 ----------------
  function init(state, o) {
    if (!state) return;
    if (o) opts = Object.assign(opts, o);
    if (!state.dlc) state.dlc = {};
    state.dlc.on = true;
    state.dlc.hands = state.dlc.hands || {};
    state.dlc.merit = state.dlc.merit || {};
    state.dlc.statuses = state.dlc.statuses || [];
    state.dlc.dead = state.dlc.dead || [];
    state.dlc.played = state.dlc.played || [];
    state.dlc.log = state.dlc.log || [];
    for (const s of SEATS) {
      if (!state.dlc.hands[s]) state.dlc.hands[s] = [];
      if (!state.dlc.merit[s]) state.dlc.merit[s] = 0;
    }
    A.bind(state);
    state.dlc.milestones = { 50: false, 100: false };
    deal(state, "opening");
    for (const s2 of SEATS) {
      if (s2 !== HUMAN && state.dlc.offers && state.dlc.offers[s2]) aiTakeOffer(state, s2);
    }
    return state.dlc;
  }

  function ensure(state) {
    if (!state || !state.dlc || !state.dlc.on) return false;
    A.bind(state);
    if (!state.dlc.milestones) state.dlc.milestones = { 50: false, 100: false };
    return true;
  }

  function afterMove(state, seat) {
    try { meritTick(state, seat); } catch (e) { /* 不影响主流程 */ }
    try { decayTick(state, seat); } catch (e) { /* 不影响主流程 */ }
    if (!ensure(state)) return;
    tick(state);
    const m = state.moveCount;
    for (const need of [50, 100]) {
      if (m >= need && !state.dlc.milestones[need]) {
        state.dlc.milestones[need] = true;
        deal(state, "turn" + need);
        for (const s of SEATS) if (isAlive(state, s) && !isHuman(state, s)) aiTakeOffer(state, s);
      }
    }
    if (opts.aiPlays && !isHuman(state, seat) && isAlive(state, seat)) {
      // 被动卡不占 AI 的手牌：抽到就用，避免它"攒着不用"
      autoUsePassives(state, seat);
      const pickCard = aiChooseCard(state, seat);
      if (pickCard) {
        const sc = scoreCard(state, seat, pickCard);
        // 高分必打；中分看时机；残局别留牌
        const late = state.moveCount >= 100;
        if (sc >= 16 || (sc >= 9 && Math.random() < 0.35) || (late && sc >= 6)) {
          play(state, seat, pickCard.id);
        }
      }
    }
  }

  // 只有 state.human 指定的那个座位才算"人"；演示/自走时 state.human="none"，四家都是 AI
  function isHuman(state, seat) {
    return !!(state && state.human && state.human === seat);
  }

  /**
   * 出招前的"组合技"：只有在打不过/平兑亏的情况下才先出卡。
   * 只认已知信息（def.revealed），不读暗子真实身份。
   */
  function beforeMove(state, seat, from, to) {
    if (!ensure(state)) return null;
    if (!opts.aiPlays || isHuman(state, seat)) return null;
    const att = state.pieces.find((p) => p.position === from);
    const def = state.pieces.find((p) => p.position === to);
    if (!att || !def) return null;
    if (!def || def.type === "flag") return null;
    const hand = state.dlc.hands[seat] || [];
    if (!hand.length) return null;

    const known = def.revealed ? def.type : null;
    const inHq = B.BOARD.byId.get(to) && B.BOARD.byId.get(to).kind === "hq";
    const atkRank = A.effRank(att);

    if (known) {
      // 已知对面是谁：打不过才补救
      const out = predict(state, att, def, inHq, state.mode);
      if (out === "attacker") return null;
      if (atkRank < 5) return null;                // 小子换命不值
    } else {
      // 对面是暗子：不偷看，只按"我方这枚子值不值得保"来决定
      // 师长及以上撞暗子，挂个硬吃当保险（35% 概率，避免每次都烧牌）
      if (atkRank < 6) return null;
      if (Math.random() > 0.5) return null;
    }

    // ① 硬吃类：给自己挂 IGNORE_RANK
    for (const h of hand) {
      const card = C.BY_ID[h.id];
      if (!card || card.when !== "play") continue;
      if (!card.atoms.some((a) => a.op === "IGNORE_RANK")) continue;
      const r = play(state, seat, h.id, h.tier, [{ target: att }]);
      if (r && r.ok) {
        state.dlc.combos = (state.dlc.combos || 0) + 1;
        A.log(state, "combo", { seat, card: h.id, kind: "pierce" });
        return { card: h.id, combo: "pierce" };
      }
    }
    // ② 缴械类：把对方打成工兵
    for (const h of hand) {
      const card = C.BY_ID[h.id];
      if (!card || card.when !== "play") continue;
      if (!card.atoms.some((a) => a.op === "EFF_RANK")) continue;
      const r = play(state, seat, h.id, h.tier, [{ target: def }]);
      if (r && r.ok) {
        state.dlc.combos = (state.dlc.combos || 0) + 1;
        A.log(state, "combo", { seat, card: h.id, kind: "disarm" });
        return { card: h.id, combo: "disarm" };
      }
    }
    return null;
  }

  // 包一层 applyMove：不改 game.js，出问题直接关开关
  function wrap() {
    if (!G || G.__dlcWrapped) return;
    const orig = G.applyMove;
    G.applyMove = function (state, seat, from, to) {
      if (state && state.dlc && state.dlc.on) {
        A.bind(state);
        try { beforeMove(state, seat, from, to); } catch (e) { /* 组合技失败不影响走子 */ }
      }
      const res = orig.apply(this, arguments);
      if (res && res.ok && state && state.dlc && state.dlc.on) afterMove(state, seat);
      return res;
    };
    G.__dlcWrapped = true;
  }

  // 给 UI 用：算出这张卡会作用到谁（不打出去）
  function candidates(state, seat, cardId) {
    const card = C.BY_ID[cardId];
    if (!card) return [];
    const hand = (state.dlc.hands[seat] || []);
    const entry = hand.find((h) => h.id === cardId);
    const tier = card.tiers[Math.min(2, ((entry && entry.tier) || 1) - 1)] || {};
    const spec = JSON.parse(JSON.stringify(card.select || { kind: "none" }));
    if (typeof spec.count === "string") spec.count = tier[spec.count.slice(1)];
    if (typeof spec.range === "string") spec.range = tier[spec.range.slice(1)];
    A.bind(state);
    return pick(state, seat, spec);
  }


  // ---------------- 对局记录：卡牌使用 ----------------
  // 一张卡"打出去"要留两笔账：
  //   ① state.log     —— 给人看的，复盘每一帧都带着它，所以复盘里看得见这手牌
  //   ② state.cardLog —— 给程序用的，战报统计直接读它，不用去解析那行文本
  // 两笔都不能少。少了①，复盘不知道有人用技能；少了②，战报只能正则抠字符串。
  // 日志是公开的（四家看同一份），所以只能写"已经公开"的兵种。
  // 现有日志的写法也从不说兵种（走子只报格子），这里保持一致：
  // 没明牌的子一律只说到"谁的子"，避免从技能记录里反推身份。
  function targetLabel(state, p, seat) {
    if (!p) return "?";
    const at = p.position ? (B.cellLabel ? B.cellLabel(p.position) : p.position) : "场外";
    if (p.revealed === true || p.revealedTo === "all") {
      return ((INFO[p.type] && INFO[p.type].name) || p.type) + "@" + at;
    }
    if (p.owner === seat) return "自己的一枚子@" + at;
    if (p.owner && B.teamOf(p.owner) === B.teamOf(seat)) return "盟友的一枚子@" + at;
    return "敌方暗子@" + at;
  }

  function describePlayTargets(state, seat, bindings) {
    const out = [];
    for (const b of (bindings || [])) {
      if (!b) continue;
      if (b.target) out.push(targetLabel(state, b.target, seat));
      if (b.cells && b.cells.length) {
        for (const c of b.cells) out.push((B.cellLabel ? B.cellLabel(c) : c) + " 空格");
      }
      if (b.a && b.b) out.push(targetLabel(state, b.a, seat) + " ↔ " + targetLabel(state, b.b, seat));
    }
    return out;
  }

  function noteCardUse(state, seat, card, tierLv, info) {
    if (!state || !card) return "";
    info = info || {};
    const tierStr = "ⅠⅡⅢ"[Math.min(2, Math.max(0, (tierLv || 1) - 1))];
    const seatName = (B.SEAT_NAMES && B.SEAT_NAMES[seat]) || seat;
    const tg = (info.targets || []).filter(Boolean);
    const head = info.passive
      ? (info.dev ? "【战术·被动·DEV】" : "【战术·被动】")
      : (info.dev ? "【战术·DEV】" : "【战术】");
    const text = info.passive
      ? head + seatName + " 获得「" + card.name + "」" + tierStr + "（持有即生效）"
      : head + seatName + " 打出「" + card.name + "」" + tierStr
        + (tg.length ? " → " + tg.join("、") : "（全场）");

    if (!Array.isArray(state.cardLog)) state.cardLog = [];
    state.cardLog.push({
      turn: state.moveCount || 0, seat, cardId: card.id, name: card.name,
      tier: tierLv || 1, passive: !!info.passive, dev: !!info.dev, targets: tg,
    });
    if (state.cardLog.length > 300) state.cardLog.splice(0, state.cardLog.length - 300);

    if (!Array.isArray(state.log)) state.log = [];
    state.log.push(text);
    if (state.log.length > 200) state.log = state.log.slice(-200);
    return text;
  }

  function describeBind(state, bind) {
    const out = [];
    if (bind.target) {
      const p = bind.target;
      const nm = INFO[p.type] ? INFO[p.type].name : p.type;
      out.push((B.cellLabel ? B.cellLabel(p.position) : p.position) + " " + (p.owner ? nm : "?"));
    }
    if (bind.cells && bind.cells.length) {
      for (const c of bind.cells) out.push((B.cellLabel ? B.cellLabel(c) : c) + " 空格");
    }
    if (bind.a && bind.b) {
      const na = INFO[bind.a.type] ? INFO[bind.a.type].name : bind.a.type;
      const nb = INFO[bind.b.type] ? INFO[bind.b.type].name : bind.b.type;
      out.push(na + " ↔ " + nb);
    }
    return out.join("、") || "（无目标）";
  }

  // 降级：这枚子每个回合掉一级，掉到工兵为止
  function decayTick(state, seat) {
    if (!state.dlc || !state.dlc.on) return;
    // MARK 挂的状态没有 team 字段，按棋子归属判断是谁的回合
    for (const dk of (state.dlc.statuses || []).filter((x) => x.key === "decayRank")) {
      const p = state.pieces.find((x) => x.id === dk.target);
      if (!p || !p.position || p.owner !== seat) continue;
      const cur = S.get(state, "rankOverride", p.id);
      const r = (cur && cur.value && cur.value.rank) || 8;
      if (r <= 1) { S.clear(state, "decayRank", p.id); continue; }
      S.clear(state, "rankOverride", p.id);
      S.add(state, { key: "rankOverride", target: p.id, until: null, value: { rank: r - 1 } });
      A.log(state, "decay", { piece: p.id, rank: r - 1 });
    }
  }

  // 盘棋：对局过了 60 手，每回合给军功
  function meritTick(state, seat) {
    if (!state.dlc || !state.dlc.on) return;
    const st = S.get(state, "meritPerTurn", undefined, seat);
    if (!st) return;
    if ((state.moveCount || 0) < 60) return;
    const n = (st.value && st.value.n) || 2;
    state.dlc.merit = state.dlc.merit || {};
    state.dlc.merit[seat] = (state.dlc.merit[seat] || 0) + n;
  }

  // 一场战斗结束：三板斧扣一次，打完第 N 场永久变团长
  function onBattle(state, attacker, defender, outcome) {
    if (!state.dlc || !state.dlc.on) return;
    for (const p of [attacker, defender]) {
      if (!p) continue;
      const st = S.get(state, "sanbanfu", p.id);
      if (!st) continue;
      st.value = st.value || {};
      st.value.left = Math.max(0, (st.value.left || 0) - 1);
      if (st.value.left > 0) {
        A.log(state, "sanbanfu", { piece: p.id, left: st.value.left });
        continue;
      }
      // 三场打完：永久团长（用战力覆盖，不改 type，避免 25 子账对不上）
      S.clear(state, "sanbanfu", p.id);
      S.clear(state, "rankOverride", p.id);
      S.add(state, { key: "rankOverride", target: p.id, until: null, value: { rank: 5 } });
      p.revealed = true;
      p.revealedTo = "all";
      A.log(state, "sanbanfuDone", { piece: p.id, rank: 5 });
      if (Array.isArray(state.log)) {
        const nm = (INFO[p.type] && INFO[p.type].name) || p.type;
        const seatName = (B.SEAT_NAMES && B.SEAT_NAMES[p.owner]) || p.owner;
        state.log.push("【战术】" + seatName + " 的三板斧用完了，" + nm + " 变成团长（" + (B.cellLabel ? B.cellLabel(p.position) : p.position) + "）。");
        state.log = state.log.slice(-200);
      }
    }
  }

  // 阵亡时触发的被动（因粮于敌 / 笑里藏刀 / 晋级 / 勇冠三军）
  // killer 是"动手吃人的那枚棋子"，可能是 null（同归于尽、炸弹、地雷）
  function onDeath(state, victim, bySeat, killer) {
    if (!state.dlc || !state.dlc.on) return;
    if (bySeat && S.has(state, "meritKill", undefined, bySeat)) {
      const m = S.get(state, "meritKill", undefined, bySeat);
      const n = (m && m.value && m.value.n) || 8;
      state.dlc.merit[bySeat] = (state.dlc.merit[bySeat] || 0) + n;
    }
    if (bySeat && S.has(state, "revealOnKill", undefined, bySeat) && victim) {
      victim.revealed = true;
      victim.revealedTo = "all";
    }
    if (victim && victim.owner && S.has(state, "chargeOnLoss", undefined, victim.owner)) {
      state.dlc.bonusCharge = (state.dlc.bonusCharge || 0) + 1;
    }
    // 后发制人：己方子被吃之后，下一个回合全军攻击 +1
    if (victim && victim.owner && S.get(state, "vengeance", undefined, victim.owner)) {
      const vg = S.get(state, "vengeance", undefined, victim.owner);
      const dv = (vg.value && vg.value.n) || 1;
      S.add(state, { key: "condRank", team: victim.owner, until: 1, value: { delta: dv, cond: "always" } });
    }

    // 晋级：这枚子每主动吃 1 个敌人，战力 +1 级（封顶军长 = 8）
    if (killer && A.rankOf) {
      const grow = S.get(state, "growRank", killer.id);
      if (grow) {
        const cur = A.effRank(killer);
        if (cur < 8) {
          const nb = S.get(state, "rankBonus", killer.id);
          const base = (nb && nb.value && nb.value.n) || 0;
          S.clear(state, "rankBonus", killer.id);
          S.add(state, { key: "rankBonus", target: killer.id, until: null, value: { n: base + 1 } });
          A.log(state, "grow", { piece: killer.id, rank: cur + 1 });
        }
      }
    }

    // 勇冠三军：吃掉 3 枚军长/司令之后，工兵以外最小的一枚变成军长
    if (killer && bySeat && victim && A.rankOf && A.rankOf(victim.type) >= 8) {
      const yg = S.get(state, "yongguan", undefined, bySeat);
      if (yg) {
        state.dlc.killBig = state.dlc.killBig || {};
        const n = (state.dlc.killBig[bySeat] || 0) + 1;
        state.dlc.killBig[bySeat] = n;
        if (n === 3) {
          const pool = state.pieces
            .filter((p) => p.owner === bySeat && p.position && p.type !== "flag"
              && p.type !== "mine" && p.type !== "engineer")
            .sort((a, b) => A.effRank(a) - A.effRank(b));
          if (pool[0]) {
            S.add(state, { key: "rankOverride", target: pool[0].id, until: null, value: { rank: 8 } });
            S.add(state, { key: "revealed", target: pool[0].id, until: null });
            pool[0].revealed = true;
            pool[0].revealedTo = "all";
            A.log(state, "yongguan", { piece: pool[0].id });
          }
        }
      }
    }

    // 探路石：你的排长被吃时给军功（消耗型，记在状态里）
    if (victim && victim.owner && A.rankOf && A.rankOf(victim.type) === 2) {
      const sc = S.get(state, "scoutReward", undefined, victim.owner);
      if (sc) {
        const gain = (sc.value && sc.value.n) || 10;
        state.dlc.merit = state.dlc.merit || {};
        state.dlc.merit[victim.owner] = (state.dlc.merit[victim.owner] || 0) + gain;
      }
    }

    // 卧薪尝胆这类"每损失一枚大子 +1 级"要记账
    if (victim && victim.owner) {
      const r = A.rankOf ? A.rankOf(victim.type) : 0;
      if (r >= 7) {
        state.dlc.lostBig = state.dlc.lostBig || {};
        state.dlc.lostBig[victim.owner] = (state.dlc.lostBig[victim.owner] || 0) + 1;
      }
    }
  }


  // ---------------- 卡牌复杂度 ----------------
  // 判据只算"用起来要几步、要想几件事"，不评价强弱。
  // 全部从卡数据推出来，不手写标签（135 张手写一次，改一次就全烂）。
  // 分层：简单 = 点一下就懂；普通 = 要选目标/有代价；复杂 = 两步选目标或改规则。
  const COND_OPS = {
    COND_RANK: 1, FOE_RANK: 1, DUEL_EVEN: 1, NIGHT: 1, NEGATE_SKILL: 1,
    DISCARD_CARD: 1, REDIRECT: 1, DEFEAT_RETREAT: 1, AS_MINE: 1, FORCE_MOVE: 1,
  };
  const RULE_OPS = {
    CHANGE_OWNER: 1, SPAWN: 1, REVIVE: 1, BLAST: 1, SWAP_POS: 1, SWAP_TYPE: 1,
    CLONE_TYPE: 1, RANK_SET: 1, EFF_RANK: 1, RELOCATE: 1, DELAY: 1, BLOCK_EDGE: 1,
  };
  const CELL_KINDS = {
    cell: 1, rowCells: 1, centerCells: 1, nearCells: 1, ownAnyEmpty: 1,
    ownFrontCells: 1, ownBackCells: 1, ownHqCell: 1, enemyCampEmpty: 1,
  };

  function cardComplexity(cardId) {
    const card = C.BY_ID[cardId];
    if (!card) return { score: 0, level: 0, label: "简单", why: [] };
    const atoms = (card.atoms || []).concat(card.onTake || []);
    const ops = atoms.map((a) => a.op);
    const why = [];
    let s = 0;

    if (card.when === "passive") {
      s = atoms.length <= 1 ? 0 : 1;
      if (atoms.length > 1) why.push("多重被动");
    } else {
      s = 1;
      if (card.sel2) { s += 2; why.push("要选两次目标"); }
      if (card.select && CELL_KINDS[card.select.kind]) { s += 1; why.push("要选格子"); }
      if (card.cost) { s += 1; why.push("自带代价"); }
      if (ops.some((op) => COND_OPS[op])) { s += 1; why.push("要看局面条件"); }
      if (ops.some((op) => RULE_OPS[op])) { s += 1; why.push("效果改局面"); }
      if (atoms.length >= 5) { s += 1; why.push("效果很多"); }
    }
    const level = s <= 1 ? 0 : (s <= 3 ? 1 : 2);
    return { score: s, level, label: ["简单", "普通", "复杂"][level], why };
  }

  // ---------------- 开发者模式 ----------------
  function allCards() { return C.CARDS; }

  // 开发者模式：把卡塞进手牌（被动卡没有目标，抽到即生效）
  function devGive(state, seat, cardId, tierLv) {
    if (!state || !state.dlc || !state.dlc.on) return { ok: false, msg: "先开启 DLC" };
    const card = C.BY_ID[cardId];
    if (!card) return { ok: false, msg: "没有这张卡" };
    const tier = tierLv || 1;
    // 全部进手牌：被动卡也先拿着，点一下才生效（和主动卡同一套操作）
    if (!state.dlc.hands[seat]) state.dlc.hands[seat] = [];
    state.dlc.hands[seat].push({ id: cardId, tier, dev: true });
    return { ok: true, card, added: true, passive: card.when === "passive" };
  }

  // 这枚子能不能被这张卡作用（DEV 点名目标时用，防止"冷枪打自己人"这种误操作）
  function canTarget(state, seat, cardId, piece) {
    if (!piece) return false;
    const card = C.BY_ID[cardId];
    if (!card) return false;
    if (!card.select || card.select.kind === "none") return true;   // 无目标卡不挑人
    const hand = (state.dlc.hands && state.dlc.hands[seat]) || [];
    const entry = hand.find((h) => h.id === cardId);
    const tier = card.tiers[Math.min(2, ((entry && entry.tier) || 1) - 1)] || {};
    const spec = JSON.parse(JSON.stringify(card.select));
    if (typeof spec.count === "string") spec.count = tier[spec.count.slice(1)];
    if (typeof spec.range === "string") spec.range = tier[spec.range.slice(1)];
    // 判断"能不能选中它"和"这次能选几枚"是两件事：候选只给前 N 个，
    // 所以这里把张数放开再求一次，否则永远只认系统自己挑的那一枚
    spec.count = 99;
    A.bind(state);
    let binds = [];
    try { binds = pick(state, seat, spec) || []; } catch (e) { return false; }
    return binds.some((b) => (b.target && b.target.id === piece.id)
      || (b.cells && piece.position && b.cells.indexOf(piece.position) >= 0)
      || (b.a && b.a.id === piece.id) || (b.b && b.b.id === piece.id));
  }

  function devPlay(state, seat, cardId, tierLv, forced) {
    if (!state || !state.dlc || !state.dlc.on) return { ok: false, msg: "先开启 DLC" };
    const card = C.BY_ID[cardId];
    if (!card) return { ok: false, msg: "没有这张卡" };
    const tier = tierLv || 1;
    if (forced && forced.length && forced[0] && forced[0].target && !canTarget(state, seat, cardId, forced[0].target)) {
      const names = (candidates(state, seat, cardId) || [])
        .map((b) => describeBind(state, b)).filter(Boolean).slice(0, 3).join("、");
      return { ok: false, msg: "这张卡不能作用在它身上" + (names ? "（可选：" + names + "）" : "（当前没有可选目标）") };
    }
    if (forced && forced.length && forced[0] && forced[0].target && !canTarget(state, seat, cardId, forced[0].target)) {
      const names = (candidates(state, seat, cardId) || [])
        .map((b) => describeBind(state, b)).filter(Boolean).slice(0, 3).join("、");
      return { ok: false, msg: "这张卡不能作用在它身上" + (names ? "（可选：" + names + "）" : "（当前没有可选目标）") };
    }
    if (card.when === "passive") {
      const effects = applyPassive(state, seat, card, tier, cardId, { dev: true });
      state.dlc.played = state.dlc.played || [];
      state.dlc.played.push({ seat, id: cardId, tier, turn: state.moveCount, effects, dev: true });
      return { ok: true, card, effects, passive: true };
    }
    const r = play(state, seat, cardId, tier, forced, true);
    if (r && r.ok) r.dev = true;
    return r;
  }

  // 当前挂着的持续状态，转成人能读的列表
  function statusList(state) {
    const out = [];
    if (!state || !state.dlc || !state.dlc.statuses) return out;
    const nameOf = (id) => {
      const p = state.pieces.find((x) => x.id === id);
      if (!p) return id;
      const nm = (INFO[p.type] && INFO[p.type].name) || p.type;
      const cell = p.position || "?";
      return nm + "@" + cell;
    };
    for (const st of state.dlc.statuses) {
      const who = st.team ? ("[" + st.team + "]")
        : (st.target ? nameOf(st.target) : "全场");
      let val = "";
      if (st.value && st.value.n != null) val = " n=" + st.value.n;
      if (st.value && st.value.rank != null) val = " rank=" + st.value.rank;
      if (st.value && st.value.uses != null) val = " 剩" + st.value.uses + "次";
      out.push({ key: st.key, who, until: st.until, val, raw: st });
    }
    return out;
  }

  function clearStatuses(state) {
    if (!state || !state.dlc) return 0;
    const n = (state.dlc.statuses || []).length;
    state.dlc.statuses = [];
    if (state.dlc.edges) state.dlc.edges = {};
    if (state.dlc.blocks) state.dlc.blocks = {};
    return n;
  }

  // 重置某家的"已生效被动"，方便反复测试
  function clearPassive(state, seat) {
    if (!state || !state.dlc || !state.dlc.passiveTaken) return 0;
    const n = (state.dlc.passiveTaken[seat] || []).length;
    state.dlc.passiveTaken[seat] = [];
    return n;
  }

  const API = {
    enabled, init, ensure, play, deal, take, tick, afterMove, wrap, onDeath, onBattle,
    allCards, devGive, devPlay, canTarget, bindingsFor, usePassive: usePassiveFromHand,
    statusList, clearStatuses, clearPassive, applyPassive,
    candidates, describeBind, beforeMove, predict, scoreCard, cardValue, scorePick, synergy, threatLevel,
    describeCard, noteCardUse, targetLabel, describePlayTargets, cardComplexity, autoUsePassives,
    pick, aiChooseCard, aiTakeOffer, scoreCard,
    battleOverride: A.battleOverride,
    status: S,
    cardOf: (id) => C.BY_ID[id],
  };
  global.JunqiDLC = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined" && enabled()) wrap();
})(typeof window !== "undefined" ? window : globalThis);
