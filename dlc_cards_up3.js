/*
 * dlc_cards_up3.js — Ⅲ 级加强（只改 Ⅲ 级，Ⅰ/Ⅱ 级保持原样）
 *
 * 为什么单独一个文件：137 张卡的 Ⅲ 级改动集中在「数值 / 目标数 / 追加一个原子」，
 * 塞回 dlc_cards.js 会把原始定义搅乱。这里按 id 覆盖，一眼看得出"加强版改了什么"，
 * 不加载本文件即回到旧数值（整体可回滚）。
 *
 * 字段：
 *   t3      合并进 tiers[2]（Ⅲ 级参数）
 *   sel     整体替换选择器（需要多枚/全体/换筛选条件时）
 *   sel2    整体替换第二选择器
 *   atoms   整体替换原子链
 *   onTake  被动卡「持有即生效」的参数（被动卡恒生效，所以直接写强化版）
 *   costPick 代价改成"自选一枚"，值 = 可牺牲的筛选条件
 */
(function (global) {
  "use strict";
  const C = global.JunqiDLCCards;
  if (!C || !C.BY_ID) return;

  const UP = {};

  // ================= 卷一 战技（H01/H02/H06/H08/H12/H13/H14 由设计者手填，这里不动） =================
  UP.H03 = { sel: { kind: "enemyPiece", count: 3 }, atoms: [{ op: "REMOVE" }] };
  UP.H04 = { t3: { targets: 4 }, sel: { kind: "ownBackCells", count: 4 } };
  UP.H05 = { t3: { targets: 2 }, sel: { kind: "ownPiece", count: 2 },
             atoms: [{ op: "RELOCATE" }, { op: "DUEL_EVEN", turns: 2 }] };
  UP.H07 = { t3: { targets: 3 }, sel: { kind: "enemyAdjacent", count: 3 } };
  UP.H09 = { t3: { rank: 9, n: 6 }, sel: { kind: "ownLowest", count: 3 } };
  UP.H10 = { t3: { uses: 5, keep: true } };
  UP.H11 = { onTake: [{ op: "TEAM_MARK", key: "yongguan", n: 2 }] };
  UP.H15 = { t3: { count: 2 }, sel: { kind: "ownPiece", count: 2 }, atoms: [{ op: "BLAST", ring: 8 }] };
  UP.H16 = { t3: { count: 3 }, sel: { kind: "enemyPiece", count: 3 } };
  UP.H17 = { t3: { count: 3 }, costPick: { rankMax: 4 } };
  UP.H18 = { sel: { kind: "enemyHazardAll", count: 0 } };
  UP.H19 = { t3: { duration: 6, count: 2 }, sel: { kind: "cell", count: 2 },
             atoms: [{ op: "BLOCK_EDGE", turns: "$duration" }, { op: "FREEZE", turns: 2 }] };
  UP.H20 = { atoms: [{ op: "UNBLOCK" }, { op: "CLEAR_FROZEN" }, { op: "RANK_MOD", delta: 2, turns: 1 }] };
  UP.H21 = { t3: { count: 4 }, sel: { kind: "ownPiece", count: 4 },
             atoms: [{ op: "SWAP_POS" }, { op: "IGNORE_RANK", turns: 1 }] };
  UP.H22 = { t3: { count: 3 }, sel: { kind: "ownPiece", count: 3 },
             atoms: [{ op: "RELOCATE" }, { op: "ANON_MOVE", turns: 1 }] };
  UP.H23 = { t3: { duration: 5 }, sel: { kind: "ownPiece", count: 3 },
             atoms: [{ op: "UNTARGETABLE", turns: "$duration" }, { op: "RANK_MOD", delta: 2 }] };
  UP.H24 = { t3: { count: 5, duration: 3 }, atoms: [{ op: "DUEL_EVEN", turns: "$duration" }] };
  UP.H25 = { t3: { targets: 4 }, atoms: [{ op: "PEEK" }, { op: "REVEAL", turns: 0 }] };
  UP.H26 = { onTake: [{ op: "TEAM_MARK", key: "overreach", n: 1 }] };

  // ================= 卷二 孙子（13） =================
  UP.S1 = { t3: { targets: 3 }, atoms: [{ op: "PEEK" }, { op: "REVEAL", turns: 0 }] };
  UP.S2 = { onTake: [{ op: "TEAM_MARK", key: "meritKill", n: 20 }] };
  UP.S3 = { t3: { duration: 5 }, sel: { kind: "enemyPiece", filter: { rankMin: 8 }, count: 3 } };
  UP.S4 = { onTake: [{ op: "GUARD_HQ", team: "self" }] };
  UP.S5 = { t3: { count: 3 }, sel: { kind: "ownPiece", count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "IGNORE_RANK", turns: 1 }] };
  UP.S6 = { t3: { count: 3 }, sel: { kind: "ownPiece", count: 3 },
            atoms: [{ op: "ANON_MOVE", turns: 1 }, { op: "RELOCATE" }, { op: "DUEL_EVEN", turns: 1 }] };
  UP.S7 = { t3: { count: 3 }, sel: { kind: "ownPiece", count: 3 }, sel2: { kind: "anyEmpty", count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "ANON_MOVE", turns: 1 }] };
  UP.S8 = { t3: { count: 3 }, sel: { kind: "enemyInCamp", count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "FREEZE", turns: 2 }] };
  UP.S9 = { sel: { kind: "enemyFought", count: 0 }, atoms: [{ op: "PEEK" }, { op: "REVEAL", turns: 0 }] };
  UP.S10 = { t3: { delta: 4 } };
  UP.S11 = { t3: { delta: 4, n: 16 } };
  UP.S12 = { sel: { kind: "enemyHighestRank", count: 3 },
             atoms: [{ op: "RANK_SET", delta: -3 }, { op: "REVEAL", turns: 0 }] };
  UP.S13 = { t3: { range: 2 }, sel: { kind: "peekArea", count: 1, range: 2 },
             atoms: [{ op: "PEEK" }, { op: "REVEAL", turns: 0 }] };

  // ================= 卷三 三十六计（29） =================
  UP.T1 = { t3: { count: 3 }, sel: { kind: "ownMine", count: 3 }, sel2: { kind: "ownFrontCells", count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "MARK", key: "mineProof" }] };
  UP.T2 = { t3: { duration: 4 }, sel: { kind: "enemyHighestRank", count: 3 },
            atoms: [{ op: "FREEZE", turns: "$duration" }, { op: "REVEAL", turns: 0 }] };
  UP.T3 = { t3: { delta: 4 } };
  UP.T4 = { t3: { count: 3 }, costPick: { rankMax: 4 } };
  UP.T5 = { t3: { count: 3 }, atoms: [{ op: "ANON_MOVE", turns: 1 }, { op: "RELOCATE" }, { op: "DUEL_EVEN", turns: 1 }] };
  UP.T6 = { t3: { count: 3 }, sel2: { kind: "enemyEmpty", count: 3 }, atoms: [{ op: "RELOCATE" }, { op: "ANON_MOVE", turns: 1 }] };
  UP.T7 = { onTake: [{ op: "TEAM_MARK", key: "revealOnKill", n: 1 }, { op: "TEAM_MARK", key: "punishKiller", n: 2 }] };
  UP.T8 = { t3: { count: 3 }, sel: { kind: "ownPiece", filter: { rankMin: 6 }, count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "RANK_MOD", delta: 1 }] };
  UP.T9 = { sel: { kind: "enemyAdjacent", count: 3 },
            atoms: [{ op: "ADD_MERIT", n: 15 }, { op: "REVEAL", turns: 0 }, { op: "RANK_SET", delta: -1 }] };
  UP.T10 = { t3: { targets: 5 }, atoms: [{ op: "REVEAL", turns: 0 }, { op: "FREEZE", turns: 2 }] };
  UP.T11 = { t3: { count: 5 }, atoms: [{ op: "REVIVE", repeat: "$count", bonus: 1 }] };
  UP.T12 = { sel: { kind: "enemyHighestRank", count: 3 }, atoms: [{ op: "FORCE_MOVE", turns: 0 }, { op: "FREEZE", turns: 1 }] };
  UP.T13 = { t3: { count: 3 } };
  UP.T14 = { sel: { kind: "enemyHazardAll", count: 0 } };
  UP.T15 = { t3: { delta: 4 } };
  UP.T16 = { t3: { count: 3 }, atoms: [{ op: "SWAP_POS" }, { op: "UNTARGETABLE", turns: 1 }] };
  UP.T17 = { t3: { duration: 8, targets: 5 }, sel: { kind: "rowCells", count: 5 } };
  UP.T18 = { t3: { delta: 4 } };
  UP.T19 = { t3: { count: 3 }, sel2: { kind: "anyEmpty", count: 3 }, atoms: [{ op: "RELOCATE" }, { op: "ANON_MOVE", turns: 1 }] };
  UP.T20 = { t3: { count: 3 }, sel2: { kind: "enemyAdjacent", count: 1 } };
  UP.T21 = { t3: { duration: 6 }, sel: { kind: "enemyPiece", filter: { rankMin: 8 }, count: 3 } };
  UP.T22 = { t3: { duration: 5 }, sel: { kind: "ownPiece", count: 3 },
             atoms: [{ op: "UNTARGETABLE", turns: "$duration" }, { op: "RANK_MOD", delta: 1 }] };
  UP.T23 = { t3: { duration: 5 }, sel: { kind: "enemyOnRail", count: 3 } };
  UP.T24 = { t3: { duration: 3 }, sel: { kind: "enemyInCamp", count: 3 },
             atoms: [{ op: "FREEZE", turns: 99 }, { op: "BLOCK_CELL", turns: 2 }] };
  UP.T25 = { onTake: [{ op: "GUARD_HQ", team: "self" }] };
  UP.T26 = { t3: { duration: 4 }, sel: { kind: "enemyHighestRank", count: 3 },
             atoms: [{ op: "FREEZE", turns: "$duration" }, { op: "REVEAL", turns: 0 }] };
  UP.T27 = { t3: { targets: 5 }, costPick: { rankMax: 4 } };
  UP.T28 = { t3: { count: 2 }, atoms: [{ op: "GRANT_CHARGE", n: 2 }, { op: "DRAW_CARD", n: 1 }] };
  UP.T29 = { t3: { count: 5 }, sel: { kind: "ownPiece", count: 5 }, sel2: { kind: "ownBackCells", count: 5 },
             atoms: [{ op: "RELOCATE" }, { op: "UNTARGETABLE", turns: 1 }] };

  // ================= 卷四 典故（D4/D5 由设计者手填） =================
  UP.D1 = { t3: { delta: 4, n: 10 } };
  UP.D2 = { t3: { delta: 2, count: 3 }, sel: { kind: "ownPiece", count: 3 }, costPick: { rankMax: 4 } };
  UP.D3 = { onTake: [{ op: "TEAM_MARK", key: "chargeOnLoss", n: 2 }] };
  UP.D6 = { t3: { delta: 4 } };
  UP.D7 = { onTake: [{ op: "TEAM_MARK", key: "tianji", n: 1 }] };
  UP.D8 = { t3: { count: 3 }, sel: { kind: "enemyPiece", filter: { revealedOnly: true }, count: 3 },
            atoms: [{ op: "RELOCATE" }, { op: "FREEZE", turns: 2 }] };
  UP.D9 = { t3: { targets: 5 }, sel: { kind: "ownBackRank", count: 5 } };
  UP.D10 = { t3: { targets: 5 }, sel: { kind: "enemyPiece", count: 5 }, atoms: [{ op: "FREEZE", turns: 4 }] };
  UP.D11 = { sel: { kind: "allOwn", count: 0 }, atoms: [{ op: "IGNORE_RANK", turns: 1 }, { op: "TEAM_MARK", key: "pierce", n: 1, turns: 1 }] };
  UP.D12 = { t3: { delta: -3 }, atoms: [{ op: "FOE_RANK", delta: -3 }] };
  UP.D13 = { t3: { targets: 5, duration: 5 }, sel: { kind: "rowCells", count: 5 },
             atoms: [{ op: "BLOCK_CELL", turns: "$duration" }, { op: "FREEZE", turns: 3 }] };
  UP.D14 = { t3: { count: 3 }, sel: { kind: "ownPiece", count: 3 } };
  UP.D15 = { t3: { count: 3 }, sel2: { kind: "anyEmpty", count: 3 } };
  UP.D16 = { onTake: [{ op: "TEAM_MARK", key: "vengeance", n: 3 }] };
  UP.D17 = { t3: { count: 3 }, atoms: [{ op: "SPAWN", type: "division" }] };
  UP.D18 = { t3: { n: 80 }, atoms: [{ op: "DISCARD_CARD" }, { op: "ADD_MERIT", n: 80 }, { op: "DRAW_CARD", n: 1 }] };
  UP.D19 = { t3: { targets: 5, duration: 4 }, sel: { kind: "rowCells", count: 5 } };
  UP.D20 = { t3: { delta: 4 } };
  UP.D21 = { t3: { duration: 4 }, sel: { kind: "enemyPiece", count: 3 } };
  UP.D22 = { t3: { n: 100 }, atoms: [{ op: "FREEZE", self: true, turns: 1 }, { op: "ADD_MERIT", n: 100 }, { op: "DRAW_CARD", n: 2 }] };
  // Ⅲ 级：每回合空降 1 枚，且至少是师长；不设回合上限，一直掉到本局结束
  UP.D23 = { t3: { duration: 0, per: 1, minRank: 7, inf: true } };
  UP.D24 = { t3: { count: 99 }, atoms: [{ op: "RANK_REROLL" }] };

  // ================= 卷五 棋理（23） =================
  UP.Q1 = { t3: { count: 5 }, sel2: { kind: "centerCells", count: 5 } };
  UP.Q2 = { onTake: [{ op: "TEAM_MARK", key: "bombSmall", n: 1 }] };
  UP.Q3 = { t3: { duration: 99 }, sel: { kind: "ownPiece", filter: { rankMax: 4 }, count: 2 } };
  UP.Q4 = { t3: { duration: 5 }, sel: { kind: "ownPiece", filter: { rankMax: 5 }, count: 3 },
            atoms: [{ op: "FAKE_TYPE", type: "bomb", turns: "$duration" }, { op: "DUEL_EVEN", turns: "$duration" }] };
  UP.Q5 = { t3: { delta: 4 } };
  UP.Q6 = { t3: { duration: 5 }, sel: { kind: "enemyOnRail", count: 3 } };
  UP.Q7 = { t3: { targets: 3 }, sel: { kind: "enemyPiece", count: 3 }, atoms: [{ op: "FREEZE", turns: 3 }] };
  UP.Q8 = { t3: { count: 5, duration: 2 }, atoms: [{ op: "DUEL_EVEN", turns: "$duration" }] };
  UP.Q9 = { t3: { count: 3 }, atoms: [{ op: "RELOCATE" }, { op: "UNTARGETABLE", turns: 1 }] };
  UP.Q10 = { t3: { targets: 5 }, sel: { kind: "ownBackRank", count: 5 } };
  UP.Q11 = { sel: { kind: "ownMine", count: 0 }, atoms: [{ op: "MARK", key: "mineProof" }, { op: "DUEL_EVEN", turns: 99 }] };
  UP.Q12 = { t3: { count: 3 }, sel: { kind: "ownPiece", filter: { rankMin: 6 }, count: 3 }, sel2: { kind: "enemyEmpty", count: 3 } };
  UP.Q13 = { t3: { delta: 5 } };
  UP.Q14 = { t3: { delta: 4 }, atoms: [{ op: "COND_RANK" }, { op: "DRAW_CARD", n: 1 }], keepCond: true };
  UP.Q15 = { t3: { delta: 5 } };
  UP.Q16 = { t3: { delta: 4 } };
  UP.Q17 = { t3: { targets: 3, duration: 2 }, sel: { kind: "cell", count: 3 }, atoms: [{ op: "DELAY", turns: 2, ring: 8 }] };
  UP.Q18 = { onTake: [{ op: "TEAM_MARK", key: "meritPerTurn", n: 5, from: 30 }] };
  UP.Q19 = { t3: { targets: 3 }, sel: { kind: "enemyPiece", count: 3 }, atoms: [{ op: "FREEZE", turns: 3 }] };
  UP.Q20 = { t3: { count: 5 }, sel: { kind: "ownPiece", count: 5 }, atoms: [{ op: "DEFEAT_RETREAT", uses: 2 }] };
  UP.Q21 = { t3: { count: 3 }, sel: { kind: "ownPiece", filter: { rankMin: 5, rankMax: 7 }, count: 3 },
             atoms: [{ op: "FAKE_TYPE", type: "engineer", turns: 2 }, { op: "RELOCATE" }] };
  UP.Q22 = { t3: { duration: 5 }, sel: { kind: "ownBackRank", count: 3 } };
  UP.Q23 = { onTake: [{ op: "TEAM_MARK", key: "scoutReward", n: 25 }, { op: "TEAM_MARK", key: "punishKiller", n: 1 }] };

  // ================= 卷六 奇想（10） =================
  UP.R1 = { t3: { duration: 99 }, atoms: [{ op: "NIGHT", turns: "$duration" }] };
  UP.R2 = { t3: { duration: 6 }, sel: { kind: "ownPiece", count: 3 } };
  UP.R3 = { t3: { duration: 8 }, atoms: [{ op: "NEGATE_SKILL", team: "enemy", turns: "$duration" }, { op: "DRAW_CARD", n: 1 }] };
  UP.R4 = { t3: { count: 3 }, sel: { kind: "ownHqPiece", count: 3 }, sel2: { kind: "ownPiece", count: 3 } };
  UP.R5 = { t3: { duration: 6 }, sel: { kind: "ownPiece", count: 3 } };
  UP.R6 = { sel: { kind: "ownFlag", count: 1 }, sel2: { kind: "ownAnyEmpty", count: 1 } };
  UP.R7 = { t3: { delta: 3 }, atoms: [{ op: "RANK_MOD", delta: "$delta" }, { op: "TEAM_MARK", key: "pierce", n: 1, turns: 1 }] };
  UP.R8 = { t3: { duration: 10, handCap: 1 }, atoms: [{ op: "NEGATE_SKILL", team: "enemy", turns: "$duration", handCap: 1 }] };
  UP.R9 = { t3: { count: 5 }, sel2: { kind: "enemyEmpty", count: 5 }, atoms: [{ op: "RELOCATE" }, { op: "ANON_MOVE", turns: 1 }] };
  UP.R10 = { t3: { count: 3 }, sel: { kind: "enemyEmpty", count: 3 }, atoms: [{ op: "SPAWN", type: "regiment" }] };

  // ================= 卷七 简术（12） =================
  UP.J1 = { t3: { targets: 6 }, sel: { kind: "enemyPiece", count: 6 } };
  UP.J2 = { sel: { kind: "enemyFought", count: 0 } };
  UP.J3 = { t3: { targets: 3 }, sel: { kind: "allOwn", count: 0, filter: { rankMax: 7, exclude: ["flag", "bomb", "mine"] } } };
  UP.J4 = { t3: { targets: 3 }, sel: { kind: "ownPiece", count: 3 } };
  UP.J5 = { t3: { targets: 2 }, sel: { kind: "enemyHighestRank", revealedOnly: true, count: 2 } };
  UP.J6 = { t3: { count: 3 }, sel: { kind: "allyPiece", count: 3 } };
  UP.J7 = { t3: { count: 1 }, sel: { kind: "enemyPiece", count: 1 }, sel2: { kind: "ownAnyEmpty", count: 1 },
            atoms: [{ op: "RELOCATE" }] };
  UP.J8 = { t3: { count: 3 }, atoms: [{ op: "PEEK" }, { op: "REVEAL", turns: 0 }] };
  UP.J9 = { t3: { count: 5 }, sel: { kind: "ownPiece", count: 5 } };
  UP.J10 = { sel: { kind: "allOwn", count: 0 }, atoms: [{ op: "IGNORE_RANK", turns: 1 }, { op: "TEAM_MARK", key: "pierce", n: 1, turns: 1 }] };
  UP.J11 = { t3: { duration: 5 }, sel: { kind: "enemyPiece", filter: { rankMin: 8 }, count: 3 }, atoms: [{ op: "EFF_RANK", rank: 1, turns: "$duration" }, { op: "REVEAL", turns: 0 }] };
  UP.J12 = { t3: { count: 2 }, atoms: [{ op: "DRAW_CARD", n: 2 }], costPick: { rankMax: 4 } };

  // ================= 应用 =================
  let n = 0;
  for (const id of Object.keys(UP)) {
    const card = C.BY_ID[id];
    if (!card) continue;
    const u = UP[id];
    if (u.t3 && card.tiers && card.tiers[2]) Object.assign(card.tiers[2], u.t3);
    // 选择器只改 Ⅲ 级：Ⅰ/Ⅱ 级保持原样（dlc.js 的 specOf 会按等级取）
    if (u.sel) {
      card.selectByTier = card.selectByTier || [card.select, card.select, card.select];
      card.selectByTier[2] = u.sel;
    }
    if (u.sel2) {
      card.sel2ByTier = card.sel2ByTier || [card.sel2, card.sel2, card.sel2];
      card.sel2ByTier[2] = u.sel2;
    }
    if (u.atoms) card.atoms = u.atoms;
    if (u.onTake) card.onTake = u.onTake;
    if (u.costPick) card.costPick = u.costPick;
    n += 1;
  }
  C.UP3 = UP;
  C.UP3_COUNT = n;
})(typeof window !== "undefined" ? window : globalThis);
