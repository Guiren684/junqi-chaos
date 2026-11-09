/*
 * dlc_atoms.js — DLC 原子层
 * 每个原子只做一件事、只改一个字段，且不知道自己是哪张卡。
 * 接口：Atom.apply(state, ctx) -> Effect[]   ｜  Atom.project(state, ctx) -> number（干跑估值）
 *
 * ctx = { seat, target, targets, tier, params, card, n }
 */
(function (global) {
  "use strict";
  const G = global.JunqiGame;
  const B = global.JunqiBoard;
  const S = global.JunqiDLCStatus;
  const INFO = (B && B.PIECE_INFO) || {};
  const VALUE = (G && G.VALUE) || {};

  // 幻影不在标准 12 兵种里，注册一个 count:0 的条目，让 UI / AI / 文案都能取名字
  if (INFO && !INFO.decoy) {
    INFO.decoy = { name: "幻影", rank: 0, count: 0, immobile: true, dlc: true };
  }

  const RANK2TYPE = {
    1: "engineer", 2: "platoon", 3: "company", 4: "battalion", 5: "regiment",
    6: "brigade", 7: "division", 8: "army", 9: "commander",
  };
  function rankOf(type) {
    const info = INFO[type];
    if (!info) return 0;
    // 示形：只看显示兵种
    return info.rank;
  }
  function effRank(piece) {
    if (!piece) return 0;
    const ov = S.get(stateRef, "rankOverride", piece.id);
    if (ov && ov.value && ov.value.rank) return ov.value.rank;
    const base = rankOf(piece.displayType || piece.type);
    const mod = S.get(stateRef, "rankBonus", piece.id);
    const bonus = mod && mod.value && mod.value.n ? mod.value.n : 0;
    return Math.max(1, Math.min(9, base + bonus));
  }
  let stateRef = null;

  // ---------- 写入口（唯一的修改点） ----------
  function log(state, kind, payload) {
    if (!state.dlc) state.dlc = {};
    if (!Array.isArray(state.dlc.log)) state.dlc.log = [];
    state.dlc.log.push(Object.assign({ turn: state.moveCount, kind }, payload));
    if (state.dlc.log.length > 400) state.dlc.log.splice(0, state.dlc.log.length - 400);
  }

  function kill(state, piece, bySeat) {
    if (!piece || !piece.position) return;
    const type = piece.type;
    piece.position = null;
    piece.revealed = true;
    if (!Array.isArray(state.dlc.dead)) state.dlc.dead = [];
    state.dlc.dead.push({ id: piece.id, type, owner: piece.owner });
    const sv = VALUE[type] || 1;
    if (state.stats) {
      if (bySeat && state.stats[bySeat]) {
        const st = state.stats[bySeat];
        st.kills = st.kills || {};
        st.kills[type] = (st.kills[type] || 0) + 1;
        st.killPieces = (st.killPieces || 0) + 1;
      }
      if (state.stats[piece.owner]) {
        const so = state.stats[piece.owner];
        so.losses = so.losses || {};
        so.losses[type] = (so.losses[type] || 0) + 1;
        so.lossPieces = (so.lossPieces || 0) + 1;
      }
    }
    log(state, "death", { piece: piece.id, type, owner: piece.owner, by: bySeat || null, v: sv });
  }

  function spawn(state, type, cell, seat) {
    const id = "d" + (state.dlc.seq = (state.dlc.seq || 0) + 1);
    const piece = {
      id, owner: seat, type, position: cell,
      revealed: true, revealedTo: "all", latent: false, moved: false, hasFought: false,
      spawned: true, dlc: true,
    };
    if (type === "decoy") piece.decoy = true;
    state.pieces.push(piece);
    log(state, "spawn", { piece: id, type, cell, seat });
    return piece;
  }

  // ---------- 原子 ----------
  const ATOMS = {};

  ATOMS.PEEK = {
    apply(state, ctx) {
      const n = ctx.n || 1;
      const pool = ctx.pool || [];
      const seen = pool.slice(0, n).map((p) => ({ id: p.id, type: p.type, pos: p.position }));
      log(state, "peek", { seat: ctx.seat, seen });
      state.dlc.lastPeek = seen;
      return [{ op: "PEEK", seen }];
    },
    project(state, ctx) { return 6 * (ctx.n || 1); },
  };

  ATOMS.REVEAL = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      t.revealed = true;
      t.revealedTo = "all";
      t.hardRevealed = true;
      if (ctx.turns) S.add(state, { key: "revealTemp", target: t.id, until: ctx.turns });
      log(state, "reveal", { piece: t.id, type: t.type });
      return [{ op: "REVEAL", piece: t.id }];
    },
    project() { return 5; },
  };

  ATOMS.CONCEAL = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      t.revealed = false;
      t.revealedTo = null;
      log(state, "conceal", { piece: t.id });
      return [{ op: "CONCEAL", piece: t.id }];
    },
    project() { return 2; },
  };

  ATOMS.FAKE_TYPE = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      t.displayType = ctx.params.type;
      t.revealed = true;
      t.revealedTo = "all";
      S.add(state, { key: "fakeType", target: t.id, until: ctx.turns || null, value: { type: ctx.params.type } });
      log(state, "fake", { piece: t.id, as: ctx.params.type });
      return [{ op: "FAKE_TYPE", piece: t.id, as: ctx.params.type }];
    },
    project() { return 12; },
  };

  ATOMS.RANK_MOD = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "rankBonus", target: t.id, until: ctx.turns || null, value: { n: ctx.params.delta || 1 } });
      log(state, "rankmod", { piece: t.id, delta: ctx.params.delta || 1, until: ctx.turns });
      return [{ op: "RANK_MOD", piece: t.id, delta: ctx.params.delta || 1 }];
    },
    project(state, ctx) { return (ctx.params.delta || 1) * 4; },
  };

  ATOMS.RANK_SET = {
    apply(state, ctx) {
      // 带条件的改军衔（"孤胆"：只剩一兩枚子时才生效）
      if (ctx.cond && !condMet(state, ctx.cond, "atk", ctx.target, null, false, ctx.params || {})) {
        return [];
      }
      const t = ctx.target;
      if (!t) return [];
      const rank = Math.max(1, Math.min(9, ctx.params.rank));
      const newType = RANK2TYPE[rank];
      if (!newType || t.type === newType) return [];
      t.type = newType;
      t.revealed = true;
      t.revealedTo = "all";
      t.hardRevealed = true;
      log(state, "rankset", { piece: t.id, to: newType });
      return [{ op: "RANK_SET", piece: t.id, to: newType }];
    },
    project(state, ctx) { return (ctx.params.rank || 1) * 3; },
  };

  ATOMS.FORCE_TRADE = {
    apply(state, ctx) {
      const a = ctx.a || ctx.target;
      const b = ctx.b;
      if (!a || !b) return [];
      if (a === b) { kill(state, a, ctx.seat); return [{ op: "TRADE_SINGLE", a: a.id }]; }
      kill(state, a, ctx.seat);
      kill(state, b, b.owner);
      log(state, "trade", { a: a.id, b: b.id });
      return [{ op: "FORCE_TRADE", a: a.id, b: b.id }];
    },
    project(state, ctx) {
      const bv = VALUE[ctx.b && ctx.b.type] || 0;
      return bv * 2 - 2;
    },
  };

  ATOMS.NO_LOSS = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "immortal", target: t.id, until: ctx.turns || null, value: { uses: ctx.params.uses || 1 } });
      log(state, "immortal", { piece: t.id, until: ctx.turns });
      return [{ op: "NO_LOSS", piece: t.id }];
    },
    project() { return 15; },
  };

  ATOMS.IGNORE_RANK = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "pierce", target: t.id, until: ctx.turns || null, value: { uses: ctx.params.uses || 1 } });
      log(state, "pierce", { piece: t.id });
      return [{ op: "IGNORE_RANK", piece: t.id }];
    },
    project() { return 18; },
  };

  ATOMS.MUTE_BOMB = {
    apply(state, ctx) {
      const team = ctx.params.team || "enemy";
      const seat = ctx.seat;
      const targets = team === "enemy" ? teamSeats(state, seat).enemies : [seat];
      for (const s of targets) {
        S.add(state, { key: "bombMuted", team: s, until: ctx.turns || 2 });
      }
      log(state, "mutebomb", { by: seat, seats: targets, turns: ctx.turns });
      return [{ op: "MUTE_BOMB", seats: targets }];
    },
    project() { return 14; },
  };

  ATOMS.UNTARGETABLE = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "untouchable", target: t.id, until: ctx.turns || 3 });
      log(state, "untouchable", { piece: t.id });
      return [{ op: "UNTARGETABLE", piece: t.id }];
    },
    project() { return 12; },
  };

  ATOMS.CHANGE_OWNER = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      const from = t.owner;
      t.owner = ctx.params.toTeam || ctx.seat;
      t.revealed = true;
      t.revealedTo = "all";
      t.hasFought = true;
      log(state, "capture", { piece: t.id, from, to: t.owner, type: t.type });
      return [{ op: "CHANGE_OWNER", piece: t.id, from, to: t.owner }];
    },
    project(state, ctx) { return (VALUE[ctx.target && ctx.target.type] || 3) * 2; },
  };

  ATOMS.SPAWN = {
    apply(state, ctx) {
      const out = [];
      // 替换模式：把目标子就地换成新子（开局棋盘是满的，没有空格）
      if (ctx.replaceTarget && ctx.replaceTarget.position) {
        const cell = ctx.replaceTarget.position;
        kill(state, ctx.replaceTarget, null);
        const p = spawn(state, ctx.params.type, cell, ctx.seat);
        out.push({ op: "SPAWN", piece: p.id, cell, replaced: cell });
        return out;
      }
      const n = ctx.n || 1;
      const cells = ctx.cells || [];
      for (let i = 0; i < n && i < cells.length; i += 1) {
        const p = spawn(state, ctx.params.type, cells[i], ctx.seat);
        out.push({ op: "SPAWN", piece: p.id, cell: cells[i] });
      }
      return out;
    },
    project(state, ctx) { return 6 * (ctx.n || 1); },
  };

  ATOMS.REVIVE = {
    apply(state, ctx) {
      const dead = (state.dlc.dead || []).filter((d) => d.owner === ctx.seat);
      if (!dead.length) return [];
      const pick = dead[dead.length - 1];
      const cell = ctx.cells && ctx.cells[0];
      if (!cell) return [];
      const p = spawn(state, pick.type, cell, ctx.seat);
      state.dlc.dead = state.dlc.dead.filter((d) => d.id !== pick.id);
      log(state, "revive", { piece: p.id, type: pick.type });
      return [{ op: "REVIVE", piece: p.id }];
    },
    project() { return 10; },
  };

  ATOMS.REMOVE = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      kill(state, t, ctx.seat);
      return [{ op: "REMOVE", piece: t.id }];
    },
    project(state, ctx) { return (VALUE[ctx.target && ctx.target.type] || 3) * 1.5; },
  };

  ATOMS.DESTROY_RANDOM = {
    apply(state, ctx) {
      const f = ctx.params.filter || {};
      let pool = state.pieces.filter((p) => p.position && p.owner === ctx.seat && p.type !== "flag");
      if (f.rankMin) pool = pool.filter((p) => rankOf(p.type) >= f.rankMin);
      if (f.rankMax) pool = pool.filter((p) => rankOf(p.type) <= f.rankMax);
      const n = ctx.params.count || 1;
      const out = [];
      for (let i = 0; i < n && pool.length; i += 1) {
        const idx = Math.floor(Math.random() * pool.length);
        const victim = pool.splice(idx, 1)[0];
        kill(state, victim, null);
        out.push({ op: "DESTROY", piece: victim.id });
      }
      return out;
    },
    project() { return -4; },
  };

  ATOMS.SWAP_TYPE = {
    apply(state, ctx) {
      const a = ctx.a, b = ctx.b;
      if (!a || !b) return [];
      const ta = a.type, tb = b.type;
      a.type = tb; b.type = ta;
      a.revealed = true; b.revealed = true;
      a.revealedTo = "all"; b.revealedTo = "all";
      log(state, "swaptype", { a: a.id, b: b.id });
      return [{ op: "SWAP_TYPE", a: a.id, b: b.id }];
    },
    project() { return 6; },
  };

  ATOMS.CLONE_TYPE = {
    apply(state, ctx) {
      const src = ctx.a, dst = ctx.b;
      if (!src || !dst) return [];
      dst.type = src.type;
      dst.revealed = true;
      dst.revealedTo = "all";
      log(state, "clone", { src: src.id, dst: dst.id, type: src.type });
      return [{ op: "CLONE_TYPE", dst: dst.id, type: src.type }];
    },
    project(state, ctx) { return (VALUE[ctx.a && ctx.a.type] || 3) * 1.5; },
  };

  ATOMS.BLOCK_CELL = {
    apply(state, ctx) {
      // 没给格子就用目标所在格（"反客为主"：封住他脚下的行营）
      if ((!ctx.cells || !ctx.cells.length) && ctx.target && ctx.target.position) {
        ctx = Object.assign({}, ctx, { cells: [ctx.target.position] });
      }
      if (!state.dlc.blocks) state.dlc.blocks = {};
      for (const c of ctx.cells || []) state.dlc.blocks[c] = ctx.turns || 2;
      log(state, "block", { cells: ctx.cells, turns: ctx.turns });
      return [{ op: "BLOCK_CELL", cells: ctx.cells }];
    },
    project() { return 4; },
  };

  ATOMS.ADD_MERIT = {
    apply(state, ctx) {
      if (!state.dlc.merit) state.dlc.merit = {};
      state.dlc.merit[ctx.seat] = (state.dlc.merit[ctx.seat] || 0) + (ctx.n || 0);
      log(state, "merit", { seat: ctx.seat, n: ctx.n });
      return [{ op: "ADD_MERIT", n: ctx.n }];
    },
    project() { return 0; },
  };

  ATOMS.DRAW_CARD = {
    apply(state, ctx) {
      log(state, "drawcard", { seat: ctx.seat, n: ctx.n || 1 });
      return [{ op: "DRAW_CARD", n: ctx.n || 1 }];
    },
    project() { return 8; },
  };

  ATOMS.DELAY = {
    apply(state, ctx) {
      if (!state.dlc.pending) state.dlc.pending = [];
      const at = state.moveCount + (ctx.turns || 3);
      state.dlc.pending.push({ at, seat: ctx.seat, cells: ctx.cells, then: ctx.params.then });
      log(state, "delay", { at, cells: ctx.cells });
      return [{ op: "DELAY", at }];
    },
    project() { return 10; },
  };

  ATOMS.FREEZE = {
    apply(state, ctx) {
      const list = ctx.targets && ctx.targets.length ? ctx.targets : (ctx.target ? [ctx.target] : []);
      for (const t of list) S.add(state, { key: "frozen", target: t.id, until: ctx.turns || 1 });
      log(state, "freeze", { pieces: list.map((t) => t.id), turns: ctx.turns });
      return list.map((t) => ({ op: "FREEZE", piece: t.id }));
    },
    project() { return 5; },
  };


  ATOMS.EFF_RANK = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "rankOverride", target: t.id, until: ctx.turns || 2, value: { rank: ctx.params.rank || 1 } });
      log(state, "effrank", { piece: t.id, rank: ctx.params.rank, until: ctx.turns });
      return [{ op: "EFF_RANK", piece: t.id, rank: ctx.params.rank }];
    },
    project(state, ctx) { return 8; },
  };

  // 条件战力修正：挂一条"满足某个条件时 ±N 级"的团队状态
  // 削弱敌方：给对手整个团队挂 −N 级（"敌方攻势一次比一次弱"）
  ATOMS.FOE_RANK = {
    apply(state, ctx) {
      const foes = teamSeats(state, ctx.seat).enemies || [];
      const delta = (ctx.params && ctx.params.delta) || -1;
      for (const s2 of foes) {
        S.add(state, { key: "condRank", team: s2, until: ctx.turns || null,
          value: { delta, cond: "always" } });
      }
      log(state, "foerank", { seat: ctx.seat, foes, delta });
      return foes.map((s2) => ({ op: "FOE_RANK", team: s2, delta }));
    },
    project() { return 6; },
  };

  // 本场战斗强制平兑（"落步"：踩上来就一起死）
  ATOMS.DUEL_EVEN = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "evenFight", target: t.id, until: ctx.turns || 1 });
      return [{ op: "DUEL_EVEN", piece: t.id }];
    },
    project() { return 7; },
  };

  // 弃一张手牌（诅咒卡的代价）
  ATOMS.DISCARD_CARD = {
    apply(state, ctx) {
      const hand = (state.dlc && state.dlc.hands && state.dlc.hands[ctx.seat]) || [];
      if (!hand.length) return [];
      const i = Math.floor(Math.random() * hand.length);
      const gone = hand.splice(i, 1)[0];
      log(state, "discard", { seat: ctx.seat, id: gone.id });
      return [{ op: "DISCARD_CARD", id: gone.id, tier: gone.tier }];
    },
    project() { return -5; },
  };

  ATOMS.COND_RANK = {
    apply(state, ctx) {
      const v = { delta: (ctx.params && ctx.params.delta) || 1, cond: (ctx.params && ctx.params.cond) || "nine" };
      if (ctx.params && ctx.params.n != null) v.n = ctx.params.n;
      S.add(state, { key: "condRank", team: ctx.seat, until: ctx.turns || null, value: v });
      log(state, "condrank", { seat: ctx.seat, cond: v.cond, delta: v.delta });
      return [{ op: "COND_RANK", cond: v.cond, delta: v.delta }];
    },
    // 干跑按半个收益估：条件不一定满足
    project(state, ctx) { return Math.max(2, Math.round(((ctx.params && ctx.params.delta) || 1) * 3)); },
  };

  // 三板斧：接下来 N 场战斗必胜、不阵亡；打完第 N 场永久变成团长
  ATOMS.SANBANFU = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      const left = (ctx.params && ctx.params.uses) || 3;
      S.add(state, { key: "sanbanfu", target: t.id, until: null, value: { left } });
      log(state, "sanbanfu", { piece: t.id, left });
      return [{ op: "SANBANFU", piece: t.id, left }];
    },
    project() { return 16; },
  };

  ATOMS.TEAM_MARK = {
    apply(state, ctx) {
      // n 优先取 params（卡数据里写死的），其次 ctx.n；被动卡走 take()，两者都可能来自 tier
      const val = (ctx.params && ctx.params.n != null) ? ctx.params.n : (ctx.n || 0);
      S.add(state, { key: ctx.key, team: ctx.seat, until: null, value: { n: val } });
      return [{ op: "TEAM_MARK", key: ctx.key }];
    },
    project() { return 0; },
  };

  ATOMS.MARK = {
    apply(state, ctx) {
      const t = ctx.target;
      S.add(state, { key: ctx.key, target: t ? t.id : null, until: ctx.turns || null });
      return [{ op: "MARK", key: ctx.key }];
    },
    project() { return 0; },
  };


  // 移动不留痕：把 moved 标记抹掉，敌方无法从"这枚子动过"推断它不是雷
  ATOMS.ANON_MOVE = {
    apply(state, ctx) {
      const t = ctx.target || ctx.a;
      if (!t) return [];
      t.moved = false;
      return [{ op: "ANON_MOVE", piece: t.id }];
    },
    project() { return 4; },
  };

  ATOMS.RELOCATE = {
    apply(state, ctx) {
      const t = ctx.target || ctx.a;
      const cell = (ctx.cells && ctx.cells[0]) || ctx.cell;
      if (!t || !cell) return [];
      const from = t.position;
      t.position = cell;
      t.moved = true;
      log(state, "relocate", { piece: t.id, from, to: cell });
      return [{ op: "RELOCATE", piece: t.id, to: cell }];
    },
    project() { return 6; },
  };

  ATOMS.SWAP_POS = {
    apply(state, ctx) {
      const a = ctx.a, b = ctx.b;
      if (!a || !b || !a.position || !b.position) return [];
      const pa = a.position, pb = b.position;
      a.position = pb; b.position = pa;
      a.moved = true; b.moved = true;
      log(state, "swap", { a: a.id, b: b.id });
      return [{ op: "SWAP_POS", a: a.id, b: b.id }];
    },
    project() { return 5; },
  };

  ATOMS.BLOCK_EDGE = {
    apply(state, ctx) {
      if (!state.dlc.edges) state.dlc.edges = {};
      for (const e of (ctx.edges || [])) state.dlc.edges[e] = ctx.turns || 2;
      log(state, "blockedge", { edges: ctx.edges, turns: ctx.turns });
      return [{ op: "BLOCK_EDGE", edges: ctx.edges }];
    },
    project() { return 4; },
  };

  ATOMS.NEGATE_SKILL = {
    apply(state, ctx) {
      const seats = ctx.params.team === "self" ? [ctx.seat] : teamSeats(state, ctx.seat).enemies;
      for (const s of seats) S.add(state, { key: "silenced", team: s, until: ctx.turns || 2 });
      log(state, "silence", { seats, turns: ctx.turns });
      return [{ op: "NEGATE_SKILL", seats }];
    },
    project() { return 10; },
  };

  ATOMS.GRANT_CHARGE = {
    apply(state, ctx) {
      log(state, "charge", { seat: ctx.seat, n: ctx.n || 1 });
      return [{ op: "GRANT_CHARGE", n: ctx.n || 1 }];
    },
    project() { return 4; },
  };

  ATOMS.REDIRECT = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "redirect", target: t.id, until: ctx.turns || 99 });
      return [{ op: "REDIRECT", piece: t.id }];
    },
    project() { return 8; },
  };

  ATOMS.DEFEAT_RETREAT = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "retreat", target: t.id, until: null, value: { uses: ctx.params.uses || 1 } });
      return [{ op: "RETREAT", piece: t.id }];
    },
    project() { return 8; },
  };

  ATOMS.GUARD_HQ = {
    apply(state, ctx) {
      const seats = ctx.params.team === "self" ? [ctx.seat] : [ctx.seat];
      for (const s of seats) S.add(state, { key: "guardHq", team: s, until: ctx.turns || null });
      return [{ op: "GUARD_HQ" }];
    },
    project() { return 6; },
  };

  ATOMS.AS_MINE = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "asMine", target: t.id, until: ctx.turns || 1 });
      return [{ op: "AS_MINE", piece: t.id }];
    },
    project() { return 10; },
  };

  ATOMS.NIGHT = {
    apply(state, ctx) {
      const list = state.pieces.filter((p) => p.position && p.revealed);
      for (const p of list) { p.revealed = false; p.revealedTo = null; }
      S.add(state, { key: "night", team: null, until: ctx.turns || 10 });
      log(state, "night", { n: list.length });
      return [{ op: "NIGHT", n: list.length }];
    },
    project() { return 9; },
  };

  ATOMS.FORCE_MOVE = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t) return [];
      S.add(state, { key: "mustMove", target: t.id, until: ctx.turns || 2 });
      return [{ op: "FORCE_MOVE", piece: t.id }];
    },
    project() { return 5; },
  };


  ATOMS.BLAST = {
    apply(state, ctx) {
      const t = ctx.target;
      if (!t || !t.position) return [];
      const ring = [t.position].concat(B.BOARD.neighbors.get(t.position) || []);
      const out = [];
      for (const v of state.pieces) {
        if (!v.position || !ring.includes(v.position)) continue;
        if (v.owner === ctx.seat || B.teamOf(v.owner) === B.teamOf(ctx.seat)) continue;
        kill(state, v, ctx.seat);
        out.push({ op: "BLAST_KILL", piece: v.id });
      }
      kill(state, t, null);
      out.push({ op: "BLAST_SELF", piece: t.id });
      return out;
    },
    project() { return 16; },
  };

  ATOMS.UNBLOCK = {
    apply(state, ctx) {
      let n = 0;
      if (state.dlc.blocks) { for (const k of Object.keys(state.dlc.blocks)) { delete state.dlc.blocks[k]; n += 1; } }
      if (state.dlc.edges) { for (const k of Object.keys(state.dlc.edges)) { delete state.dlc.edges[k]; n += 1; } }
      return [{ op: "UNBLOCK", n }];
    },
    project() { return 3; },
  };

  // ---------- 阵营工具 ----------
  function teamSeats(state, seat) {
    const team = B.teamOf(seat);
    const mates = ["south", "north", "east", "west"].filter((s) => B.teamOf(s) === team);
    return {
      mates,
      enemies: ["south", "north", "east", "west"].filter((s) => B.teamOf(s) !== team),
    };
  }

  // ---------- 战斗接管 ----------
  // 只在有 DLC 状态影响时接管；否则返回 null，交回引擎原逻辑。
  function battleOverride(attacker, defender, inHq, mode) {
    const state = stateRef;
    if (!state || !state.dlc || !state.dlc.on) return null;
    if (!attacker || !defender) return null;

    const decoyHit = (defender.decoy || defender.type === "decoy") ? "both" : null;
    if (decoyHit) return decoyHit;

    // 三板斧：这几场战斗必胜且不阵亡——连炸弹、地雷、大本营平兑都压过去，
    // 所以放在所有修饰之前判定
    if (S.get(state, "sanbanfu", attacker.id)) return "attacker";
    if (S.get(state, "sanbanfu", defender.id)) return "defender";

    // 诈降：被吃时改为互换位置
    const redir = S.get(state, "redirect", defender.id);
    if (redir && attacker.position && defender.position) {
      const pa = attacker.position, pd = defender.position;
      attacker.position = pd; defender.position = pa;
      S.clear(state, "redirect", defender.id);
      log(state, "redirect", { a: attacker.id, b: defender.id });
      return "move";
    }
    // 活雷：本回合被当成地雷
    const asMine = S.get(state, "asMine", defender.id);
    if (asMine) {
      if (attacker.type === "engineer") return "attacker";
      return mode === "standard" ? "defender" : "both";
    }
    // 落步：这一步谁踩上来都是平兑
    if (S.get(state, "evenFight", defender.id) || S.get(state, "evenFight", attacker.id)) return "both";

    // 空城/据险：大本营内平兑
    if (inHq && S.get(state, "guardHq", undefined, defender.owner)) return "both";

    const atkMuted = S.get(state, "bombMuted", undefined, attacker.owner);
    const defMuted = S.get(state, "bombMuted", undefined, defender.owner);
    const atkImmortal = S.get(state, "immortal", attacker.id);
    const defImmortal = S.get(state, "immortal", defender.id);
    const atkPierce = S.get(state, "pierce", attacker.id);
    const anyRetreat = S.get(state, "retreat", attacker.id) || S.get(state, "retreat", defender.id);

    // 被动卡（持有即生效）
    const bombSmall = S.get(state, "bombSmall", undefined, attacker.owner);
    const overreach = S.get(state, "overreach", undefined, attacker.owner);
    const tianji = S.get(state, "tianji", undefined, attacker.owner);

    // 无任何修饰：交回引擎
    const atkRankMod = S.get(state, "rankBonus", attacker.id) || S.get(state, "rankOverride", attacker.id);
    const defRankMod = S.get(state, "rankBonus", defender.id) || S.get(state, "rankOverride", defender.id);
    const defMineProof = defender.type === "mine" && S.get(state, "mineProof", defender.id);
    // 只有"条件真的成立"才算有修饰；挂了牌但条件不满足时必须交回引擎，
    // 否则 DLC 会用自己的简化逻辑替引擎裁决，结果反而和原版不一致
    const anyCond = condBonus(state, attacker.owner, "atk", attacker, defender, inHq) !== 0
      || condBonus(state, defender.owner, "def", defender, attacker, inHq) !== 0;
    if (!atkMuted && !defMuted && !atkImmortal && !defImmortal && !atkPierce && !atkRankMod && !defRankMod
        && !bombSmall && !overreach && !tianji && !anyRetreat && !defMineProof && !anyCond) return null;

    // 空炸：炸弹炸到营长以下，炸弹不消失
    if (bombSmall && attacker.type === "bomb" && defender.type !== "bomb") {
      const dr = effRank(defender);
      if (dr <= 4) return "attacker";
    }
    // 越级克敌：营长及以下主动打军长/司令 → 平兑
    if (overreach && effRank(attacker) <= 4 && effRank(defender) >= 8) return "both";
    // 田忌赛马：小子打"战斗过"的大子 → 平兑
    if (tianji && effRank(attacker) <= 4 && defender.hasFought && effRank(defender) >= 6) return "both";

    // 炸弹失效：炸弹按普通子结算（必死），不产生同归于尽
    if (attacker.type === "bomb" && atkMuted) return "defender";
    if (defender.type === "bomb" && defMuted) return "attacker";

    // 战败退回
    const retreat = S.get(state, "retreat", attacker.id) || S.get(state, "retreat", defender.id);
    if (retreat) {
      if (retreat.value && retreat.value.uses > 0) retreat.value.uses -= 1;
      if (retreat.value && retreat.value.uses <= 0) S.clear(state, "retreat", retreat.target);
      return retreat.target === attacker.id ? "defender" : "attacker";
    }

    // 免死
    if (defImmortal && !atkPierce) return "defender";
    if (atkImmortal) return "attacker";

    // 必胜（对炸弹无效）
    if (atkPierce && defender.type !== "bomb") return "attacker";

    // 其余：按修正后的军衔比较
    if (defender.type === "flag") return attacker.type === "bomb" ? "both" : "attacker";
    if (inHq) return attacker.type === "bomb" ? "both" : "attacker";
    if (attacker.type === "bomb" || defender.type === "bomb") return "both";
    if (defender.type === "mine") {
      // 三角雷：这枚雷被加固过，工兵也一样同归于尽
      if (S.get(state, "mineProof", defender.id)) return "both";
      if (attacker.type === "engineer") return "attacker";
      return mode === "standard" ? "defender" : "both";
    }
    const ac = condBonus(state, attacker.owner, "atk", attacker, defender, inHq);
    const dc = condBonus(state, defender.owner, "def", defender, attacker, inHq);
    const a = effRank(attacker) + ac;
    const d = effRank(defender) + dc;
    if (a === d) return "both";
    return a > d ? "attacker" : "defender";
  }

  // ---------- 条件战力修正 ----------
  // 一张卡写"你的子占九宫时 +1 级"，不能简化成"全军永久 +1"——
  // 那就变成另一张卡了。这里把条件挂在状态上，结算时才求值。
  function condBonus(state, seat, side, self, foe, inHq) {
    let total = 0;
    for (const st of (state.dlc.statuses || [])) {
      if (st.key !== "condRank" || st.team !== seat) continue;
      const v = st.value || {};
      if (condMet(state, v.cond, side, self, foe, inHq, v)) total += (v.delta || 1);
    }
    return total;
  }

  function condMet(state, cond, side, self, foe, inHq, val) {
    const nodeOf = (p) => (p && p.position ? B.BOARD.byId.get(p.position) : null);
    switch (cond) {
      case "always":
        return true;
      case "fromCamp": {      // 从行营出发的攻击
        const cn = nodeOf(self);
        return side === "atk" && !!cn && cn.kind === "camp";
      }
      case "nine":            // 从中央公共区出发
        return side === "atk" && !!nodeOf(self) && nodeOf(self).seat === null;
      case "backRow":         // 打后两排没动过的子
        return side === "atk" && !!nodeOf(foe) && nodeOf(foe).row >= 4 && !foe.moved;
      case "leaderDead": {    // 自己这边司令已经阵亡
        const alive = state.pieces.some((p) => p.owner === seatOf(state, self, side) && p.position && p.type === "commander");
        return !alive;
      }
      case "attackHq":
        return side === "atk" && (!!inHq || (foe && foe.type === "flag"));
      case "lowCount": {      // 存活子数 ≤ n
        const owner = seatOf(state, self, side);
        const n = state.pieces.filter((p) => p.owner === owner && p.position && p.type !== "flag" && p.type !== "mine").length;
        return n <= (val.n || 10);
      }
      case "closerToHq": {    // 目标比我更靠近我方大本营
        const owner = seatOf(state, self, side);
        const hq = B.hqCells(owner)[0];
        const hn = B.BOARD.byId.get(hq);
        const sn = nodeOf(self), fn = nodeOf(foe);
        if (!hn || !sn || !fn) return false;
        const dist = (n) => Math.abs(n.x - hn.x) + Math.abs(n.y - hn.y);
        return dist(fn) < dist(sn);
      }
      case "crowd": {         // 目标周围棋子 ≥ n 枚
        const fn = nodeOf(foe);
        if (!fn) return false;
        const nb = B.BOARD.neighbors.get(foe.position) || [];
        const cnt = nb.filter((c) => state.pieces.some((p) => p.position === c)).length;
        return cnt >= (val.n || 3);
      }
      case "adjAlly": {       // 与盟友的子相邻
        const owner = seatOf(state, self, side);
        const mate = B.teamOf(owner) === null ? null
          : ["south", "north", "east", "west"].find((s) => B.teamOf(s) === B.teamOf(owner) && s !== owner);
        if (!mate || !self.position) return false;
        const nb = B.BOARD.neighbors.get(self.position) || [];
        return state.pieces.some((p) => p.owner === mate && p.position && nb.includes(p.position));
      }
      case "still":           // 这枚子整局没动过（"以逸待劳"）
        return side === "def" && !self.moved;
      case "lostBig": {       // 己方已损失 N 枚师长以上
        const owner = seatOf(state, self, side);
        const n = (state.dlc.lostBig && state.dlc.lostBig[owner]) || 0;
        return n >= (val.n || 1);
      }
      case "defendHome": {    // 在己方半场内防守
        const owner = seatOf(state, self, side);
        const nd = nodeOf(self);
        return side === "def" && !!nd && nd.seat === owner;
      }
      default:
        return false;
    }
  }

  function seatOf(state, piece, side) {
    return (piece && piece.owner) || null;
  }

  function bind(state) { stateRef = state; }

  const API = { ATOMS, effRank, battleOverride, bind, rankOf, RANK2TYPE, kill, spawn, log, teamSeats };
  global.JunqiDLCAttoms = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
