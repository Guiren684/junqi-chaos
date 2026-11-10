/*
 * dlc_cards.js — DLC 卡牌数据（137 张，纯数据无逻辑）
 * 字段：id / name / book / tag / axis / tiers / when / select / sel2 / atoms / cost
 *   axis  : targets | duration | count | range | value | cost
 *   tiers : Ⅰ / Ⅱ / Ⅲ，只改参数
 *   sel2  : 第二个选择器（给 RELOCATE / SWAP_POS 这类需要"从哪到哪"的卡提供落点）
 *   approx: true 表示语义做了近似（引擎暂不支持原效果），见 DLC-原子层.md 第十二节
 */
(function (global) {
  "use strict";
  const CARDS = [];

  function C(id, name, book, tag, axis, tiers, when, sel, atoms, extra) {
    const o = {
      id, name, book, tag, axis, tiers,
      when: when || "play",
      select: sel || { kind: "none", count: 0 },
      atoms: atoms || [],
    };
    if (extra) Object.assign(o, extra);
    CARDS.push(o);
    return o;
  }
  const T = (a, b, c) => [a, b, c];

  // ---------------- 卷二 孙子兵法（13） ----------------
  C("S1", "庙算", "孙子", "窥", "targets",
    T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "peekSpread", count: "$targets" }, [{ op: "PEEK" }]);
  C("S2", "因粮于敌", "孙子", "—", "value", T({ n: 8 }, { n: 12 }, { n: 16 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "meritKill", n: 8 }] });
  C("S3", "不战而屈", "孙子", "冻", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyPiece", filter: { rankMin: 7 }, count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("S4", "先为不可胜", "孙子", "守", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "GUARD_HQ", team: "self" }] });
  C("S5", "奇正", "孙子", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 } });
  C("S6", "虚实", "孙子", "诱", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "ANON_MOVE", turns: 1 }, { op: "RELOCATE" }],
    { sel2: { kind: "ownAnyEmpty", count: 1 }, approx: true });
  C("S7", "以迂为直", "孙子", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }],
    { sel2: { kind: "nearCells", count: 1, range: 2 } });
  C("S8", "君命不受", "孙子", "移", "count",
    T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "enemyInCamp", count: "$count" }, [{ op: "RELOCATE" }],
    { sel2: { kind: "nearCells", count: 1, range: 1 } });
  C("S9", "相敌", "孙子", "窥", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyFought", count: "$targets" }, [{ op: "PEEK" }]);
  C("S10", "据险", "孙子", "守", "value",
    T({ delta: 2, cond: "fromCamp" }, { delta: 2, cond: "fromCamp" }, { delta: 3, cond: "fromCamp" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("S11", "死地后生", "孙子", "背", "value",
    T({ delta: 1, cond: "lowCount", n: 10 }, { delta: 1, cond: "lowCount", n: 12 }, { delta: 2, cond: "lowCount", n: 14 }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("S12", "火攻·焚粮", "孙子", "变", "value", T({ rank: -1 }, { rank: -2 }, { rank: -3 }), "play",
    { kind: "enemyPiece", filter: { rankMin: 6 }, count: 1 }, [{ op: "RANK_SET", delta: "$rank" }, { op: "REVEAL", turns: 0 }]);
  C("S13", "用间", "孙子", "窥", "range", T({ range: 1 }, { range: 2 }, { range: 3 }), "play",
    { kind: "peekArea", count: 1, range: "$range" }, [{ op: "PEEK" }]);

  // ---------------- 卷三 三十六计（29） ----------------
  C("T1", "瞒天过海", "三十六计", "变", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownMine", count: "$count" }, [{ op: "RELOCATE" }],
    { sel2: { kind: "ownFrontCells", count: 1 },
      ai: { grade: "C", hint: "把一枚雷挪到敌方够不到的前排，逼他重新算雷区" } });
  C("T2", "围魏救赵", "三十六计", "反", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 2 }), "play",
    { kind: "enemyHighestRank", count: 1 }, [{ op: "FREEZE", turns: "$duration" }], { approx: true });
  C("T3", "以逸待劳", "三十六计", "守", "value",
    T({ delta: 1, cond: "still" }, { delta: 2, cond: "still" }, { delta: 2, cond: "still" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("T4", "趁火打劫", "三十六计", "反", "count",
    T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyAdjacent", count: "$count" }, [{ op: "REMOVE" }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMax: 4 }, count: 1 } });
  C("T5", "声东击西", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "ANON_MOVE", turns: 1 }, { op: "RELOCATE" }],
    { sel2: { kind: "ownAnyEmpty", count: 1 }, approx: true });
  C("T6", "暗度陈仓", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "nearCells", count: 1, range: 2 } });
  C("T7", "笑里藏刀", "三十六计", "反", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "revealOnKill" }] });
  C("T8", "李代桃僵", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", filter: { rankMin: 6 }, count: 1 }, [{ op: "RELOCATE" }],
    { sel2: { kind: "ownAnyEmpty", count: "$count" }, approx: true });
  C("T9", "顺手牵羊", "三十六计", "窥", "value", T({ n: 5 }, { n: 10 }, { n: 15 }), "play",
    { kind: "enemyAdjacent", count: 1 }, [{ op: "ADD_MERIT", n: "$n" }, { op: "REVEAL", turns: 0 }]);
  C("T10", "打草惊蛇", "三十六计", "窥", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "REVEAL", turns: 0 }]);
  C("T11", "借尸还魂", "三十六计", "生", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownHqCell", count: "$count" }, [{ op: "REVIVE", repeat: "$count" }]);
  C("T12", "调虎离山", "三十六计", "移", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyHighestRank", count: 1 }, [{ op: "FORCE_MOVE", turns: "$duration" }]);
  C("T13", "擒贼擒王", "三十六计", "兑", "count",
    T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyHighestRank", count: "$count" }, [{ op: "FORCE_TRADE" }]);
  C("T14", "釜底抽薪", "三十六计", "反", "count",
    T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyHazard", count: "$count" }, [{ op: "REMOVE" }]);
  C("T15", "混水摸鱼", "三十六计", "背", "value",
    T({ delta: 1, cond: "crowd", n: 3 }, { delta: 1, cond: "crowd", n: 3 }, { delta: 2, cond: "crowd", n: 2 }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("T16", "金蝉脱壳", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPair", count: "$count" }, [{ op: "SWAP_POS" }]);
  C("T17", "关门捉贼", "三十六计", "堵", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "cell", count: 1 }, [{ op: "BLOCK_CELL", turns: "$duration" }]);
  C("T18", "远交近攻", "三十六计", "背", "value",
    T({ delta: 1, cond: "closerToHq" }, { delta: 1, cond: "closerToHq" }, { delta: 2, cond: "closerToHq" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("T19", "假道伐虢", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "nearCells", count: 1, range: 2 } });
  C("T20", "偷梁换柱", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "SWAP_POS" }], { sel2: { kind: "allyPiece", count: 1 } });
  C("T21", "指桑骂槐", "三十六计", "冻", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 4 }), "play",
    { kind: "enemyPiece", filter: { rankMin: 8 }, count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("T22", "假痴不癫", "三十六计", "守", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "UNTARGETABLE", turns: "$duration" }]);
  C("T23", "上屋抽梯", "三十六计", "堵", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyOnRail", count: 1 }, [{ op: "FREEZE", turns: "$duration" }], { approx: true });
  C("T24", "反客为主", "三十六计", "堵", "duration",
    T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyInCamp", count: 1 }, [{ op: "BLOCK_CELL", turns: "$duration" }]);
  C("T25", "空城计", "三十六计", "守", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "GUARD_HQ", team: "self" }] });
  C("T26", "反间计", "三十六计", "冻", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyHighestRank", count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("T27", "苦肉计", "三十六计", "窥", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "REVEAL", turns: 0 }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMax: 3 }, count: 1 } });
  C("T28", "连环计", "三十六计", "—", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "none", count: "$count" }, [{ op: "GRANT_CHARGE", n: 1 }]);
  C("T29", "走为上", "三十六计", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 } });

  // ---------------- 卷四 历史典故（22） ----------------
  C("D1", "背水一战", "典故", "背", "value",
    T({ delta: 1, cond: "lowCount", n: 6 }, { delta: 1, cond: "lowCount", n: 8 }, { delta: 2, cond: "lowCount", n: 8 }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("D2", "破釜沉舟", "典故", "背", "value", T({ delta: 1 }, { delta: 1 }, { delta: 2 }), "play",
    { kind: "none", count: 0 }, [{ op: "RANK_MOD", delta: "$delta" }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMin: 3 }, count: 1 } });
  C("D3", "草船借箭", "典故", "反", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "passive",
    { kind: "none", count: "$count" }, [], { onTake: [{ op: "TEAM_MARK", key: "chargeOnLoss" }] });
  C("D4", "火烧赤壁", "典故", "变", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "RANK_SET", delta: -1 }, { op: "REVEAL", turns: 0 }]);
  C("D5", "七擒七纵", "典故", "夺", "targets",
    T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "enemyAdjacent", filter: { rankMax: 8 }, count: "$targets" },
    [{ op: "CHANGE_OWNER" }, { op: "REVEAL", turns: 0 }, { op: "FREEZE", turns: 99 }]);
  C("D6", "卧薪尝胆", "典故", "背", "value",
    T({ delta: 1, cond: "lostBig", n: 1 }, { delta: 1, cond: "lostBig", n: 1 }, { delta: 2, cond: "lostBig", n: 1 }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("D7", "田忌赛马", "典故", "反", "count", T({ count: 1 }, { count: 2 }, { count: 2 }), "passive",
    { kind: "none", count: "$count" }, [], { onTake: [{ op: "TEAM_MARK", key: "tianji" }] });
  C("D8", "完璧归赵", "典故", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 } });
  C("D9", "十面埋伏", "典故", "诱", "targets", T({ targets: 2 }, { targets: 3 }, { targets: 4 }), "play",
    { kind: "ownLowBack", count: "$targets" }, [{ op: "SPAWN", type: "decoy", replace: true }]);
  C("D10", "四面楚歌", "典故", "冻", "targets", T({ targets: 3 }, { targets: 4 }, { targets: 5 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "FREEZE", turns: 2 }]);
  C("D11", "一鼓作气", "典故", "背", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "IGNORE_RANK", turns: 1 }]);
  C("D12", "再衰三竭", "典故", "守", "value",
    T({ delta: -1 }, { delta: -1 }, { delta: -2 }), "play",
    { kind: "none", count: 0 }, [{ op: "FOE_RANK" }]);
  C("D13", "坚壁清野", "典故", "堵", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "rowCells", count: "$targets" }, [{ op: "BLOCK_CELL", turns: 3 }]);
  C("D14", "各个击破", "典故", "背", "value", T({ delta: 1 }, { delta: 1 }, { delta: 2 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "RANK_MOD", delta: "$delta" }]);
  C("D15", "先发制人", "典故", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "nearCells", count: 1, range: 2 } });
  C("D16", "后发制人", "典故", "反", "value",
    T({ delta: 1 }, { delta: 1 }, { delta: 2 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "vengeance" }] });
  C("D17", "中心开花", "典故", "生", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "centerCells", count: "$count" }, [{ op: "SPAWN", type: "regiment" }]);
  C("D18", "纸上谈兵", "典故", "诅咒", "value",
    T({ n: 25 }, { n: 35 }, { n: 45 }), "play",
    { kind: "none", count: 0 }, [{ op: "DISCARD_CARD" }, { op: "ADD_MERIT", n: "$n" }]);
  C("D19", "楚河汉界", "典故", "堵", "targets", T({ targets: 3 }, { targets: 4 }, { targets: 5 }), "play",
    { kind: "rowCells", count: "$targets" }, [{ op: "BLOCK_CELL", turns: 2 }]);
  C("D20", "一夫当关", "典故", "守", "value",
    T({ delta: 1, cond: "defendHome" }, { delta: 2, cond: "defendHome" }, { delta: 2, cond: "defendHome" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("D21", "二桃杀三士", "典故", "冻", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyPiece", count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("D22", "临阵磨枪", "典故", "诅咒", "value",
    T({ n: 35 }, { n: 40 }, { n: 50 }), "play",
    { kind: "none", count: 0 }, [{ op: "FREEZE", self: true, turns: 1 }, { op: "ADD_MERIT", n: "$n" }]);
  C("D23", "撒豆成兵", "典故", "生", "duration",
    T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "none", count: 0 }, [{ op: "BEAN_DROP", turns: "$duration" }]);
  C("D24", "宁有种乎", "典故", "变", "count",
    T({ count: 2 }, { count: 3 }, { count: 4 }), "play",
    { kind: "none", count: 0 }, [{ op: "RANK_REROLL" }]);

  // ---------------- 卷五 棋理（23） ----------------
  C("Q1", "双飞", "棋理", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownEngineer", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "centerCells", count: "$count" } });
  C("Q2", "空炸", "棋理", "兑", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "passive",
    { kind: "none", count: "$count" }, [], { onTake: [{ op: "TEAM_MARK", key: "bombSmall" }] });
  C("Q3", "假司令", "棋理", "欺", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "ownPiece", filter: { rankMax: 4 }, count: 1 }, [{ op: "FAKE_TYPE", type: "commander", turns: "$duration" }]);
  C("Q4", "假炸弹", "棋理", "欺", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "ownPiece", filter: { rankMax: 5 }, count: 1 }, [{ op: "FAKE_TYPE", type: "bomb", turns: "$duration" }]);
  C("Q5", "控盘", "棋理", "守", "value",
    T({ delta: 1, cond: "nine" }, { delta: 1, cond: "nine" }, { delta: 2, cond: "nine" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("Q6", "十字捉", "棋理", "冻", "duration", T({ duration: 1 }, { duration: 2 }, { duration: 3 }), "play",
    { kind: "enemyOnRail", count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("Q7", "一捉二", "棋理", "冻", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 2 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "FREEZE", turns: 1 }]);
  C("Q8", "落步", "棋理", "反", "count",
    T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "DUEL_EVEN" }]);
  C("Q9", "急所", "棋理", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 } });
  C("Q10", "乌龟阵", "棋理", "变", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "ownLowBack", count: "$targets" }, [{ op: "SPAWN", type: "mine", replace: true }],
    { ai: { grade: "B", hint: "把后两排的小子全改成雷，摆乌龟阵" } });
  C("Q11", "三角雷", "棋理", "变", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "ownMine", count: "$targets" }, [{ op: "MARK", key: "mineProof" }],
    { ai: { grade: "A", hint: "加固地雷：工兵撞上也得同归于尽" } });
  C("Q12", "推土机", "棋理", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", filter: { rankMin: 6 }, count: 1 }, [{ op: "RELOCATE" }],
    { sel2: { kind: "nearCells", count: "$count", range: 3 } });
  C("Q13", "啃", "棋理", "背", "value",
    T({ delta: 1, cond: "backRow" }, { delta: 1, cond: "backRow" }, { delta: 2, cond: "backRow" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("Q14", "令子", "棋理", "背", "value",
    T({ delta: 1, cond: "leaderDead" }, { delta: 1, cond: "leaderDead" }, { delta: 2, cond: "leaderDead" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("Q15", "抗旗", "棋理", "背", "value",
    T({ delta: 2, cond: "attackHq" }, { delta: 2, cond: "attackHq" }, { delta: 3, cond: "attackHq" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("Q16", "联手阵", "棋理", "守", "value",
    T({ delta: 1, cond: "adjAlly" }, { delta: 1, cond: "adjAlly" }, { delta: 2, cond: "adjAlly" }), "play",
    { kind: "none", count: 0 }, [{ op: "COND_RANK" }]);
  C("Q17", "定时", "棋理", "兑", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "cell", count: "$targets" }, [{ op: "DELAY", turns: 3 }]);
  C("Q18", "盘棋", "棋理", "背", "value",
    T({ n: 2 }, { n: 3 }, { n: 4 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "meritPerTurn", n: 2 }] });
  C("Q19", "封", "棋理", "冻", "duration", T({ duration: 1 }, { duration: 1 }, { duration: 2 }), "play",
    { kind: "enemyPiece", count: 1 }, [{ op: "FREEZE", turns: "$duration" }]);
  C("Q20", "逃", "棋理", "守", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "DEFEAT_RETREAT", uses: 1 }]);
  C("Q21", "假工兵", "棋理", "欺", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownPiece", filter: { rankMin: 5, rankMax: 7 }, count: 1 }, [{ op: "RELOCATE" }],
    { sel2: { kind: "nearCells", count: "$count", range: 3 } });
  C("Q22", "活雷", "棋理", "守", "duration", T({ duration: 1 }, { duration: 1 }, { duration: 2 }), "play",
    { kind: "ownLowBack", count: 1 }, [{ op: "AS_MINE", turns: "$duration" }]);
  C("Q23", "探路石", "棋理", "窥", "value",
    T({ n: 10 }, { n: 15 }, { n: 20 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "scoutReward" }] });

  // ---------------- 卷六 奇想（10） ----------------
  C("R1", "夜战", "奇想", "欺", "duration", T({ duration: 10 }, { duration: 10 }, { duration: 10 }), "play",
    { kind: "none", count: 0 }, [{ op: "NIGHT", turns: "$duration" }]);
  C("R2", "坑道", "奇想", "守", "duration",
    T({ duration: 2 }, { duration: 3 }, { duration: 4 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "UNTARGETABLE", turns: "$duration" }]);
  C("R3", "无线电静默", "奇想", "冻", "duration",
    T({ duration: 2 }, { duration: 3 }, { duration: 4 }), "play",
    { kind: "none", count: 0 }, [{ op: "NEGATE_SKILL", team: "enemy", turns: "$duration" }]);
  C("R4", "换家", "奇想", "移", "count",
    T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownHqPiece", count: "$count" }, [{ op: "SWAP_POS" }],
    { sel2: { kind: "allyHqPiece", count: 1 } });
  C("R5", "诈降", "奇想", "反", "duration", T({ duration: 3 }, { duration: 5 }, { duration: 9 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "REDIRECT", turns: "$duration" }]);
  C("R6", "军旗易位", "奇想", "移", "cost", T({ n: 1 }, { n: 1 }, { n: 1 }), "play",
    { kind: "ownFlag", count: 1 }, [{ op: "RELOCATE" }], { sel2: { kind: "ownHqCell", count: 1 } });
  C("R7", "士气", "奇想", "背", "value", T({ delta: 1 }, { delta: 1 }, { delta: 2 }), "play",
    { kind: "allOwn", count: 0 }, [{ op: "RANK_MOD", delta: "$delta" }]);
  C("R8", "断粮", "奇想", "堵", "duration",
    T({ duration: 3 }, { duration: 4 }, { duration: 6 }), "play",
    { kind: "none", count: 0 }, [{ op: "NEGATE_SKILL", team: "enemy", turns: "$duration" }]);
  C("R9", "侦察兵", "奇想", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownEngineer", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "nearCells", count: 1, range: 3 } });
  C("R10", "空投", "奇想", "生", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownAnyEmpty", count: "$count" }, [{ op: "SPAWN", type: "platoon" }]);

  // ---------------- 卷七 简术（12） ----------------
  C("J1", "侦察", "简术", "窥", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyPiece", count: "$targets" }, [{ op: "PEEK" }]);
  C("J2", "照面", "简术", "窥", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyFought", count: "$targets" }, [{ op: "REVEAL", turns: 0 }]);
  C("J3", "复制", "简术", "变", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "ownPair", count: "$targets" }, [{ op: "CLONE_TYPE" }]);
  C("J4", "换衔", "简术", "变", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "ownPair", count: "$targets" }, [{ op: "SWAP_TYPE" }]);
  C("J5", "夺衔", "简术", "生", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "enemyHighestRank", revealedOnly: true, count: "$targets" }, [{ op: "CHANGE_OWNER" }, { op: "REVEAL", turns: 0 }]);
  C("J6", "借兵", "简术", "移", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "allyPiece", count: "$count" }, [{ op: "CHANGE_OWNER" }, { op: "REVEAL", turns: 0 }], { approx: true });
  C("J7", "抽子", "简术", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 } });
  C("J8", "洞察", "简术", "窥", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "peekSpecial", count: "$count" }, [{ op: "PEEK" }]);
  C("J9", "提速", "简术", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "RELOCATE" }], { sel2: { kind: "ownAnyEmpty", count: 1 }, approx: true });
  C("J10", "硬吃", "简术", "兑", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "IGNORE_RANK", turns: 1 }]);
  C("J11", "缴械", "简术", "冻", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "enemyPiece", filter: { rankMin: 7 }, count: 1 }, [{ op: "EFF_RANK", rank: 1, turns: "$duration" }]);
  C("J12", "弃子", "简术", "—", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "none", count: "$count" }, [{ op: "DRAW_CARD", n: 1 }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMax: 4 }, count: 1 } });

  // ---------------- 卷一 英雄谱（26） ----------------
  // ---------------- 卷七 战技（26 张）—— 最早那批技能，卡名就是技能名 ----------------
  C("H01", "炸药包", "战技", "变", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "ownPiece", filter: { rankMin: 2, rankMax: 2 }, count: "$targets" },
    [{ op: "SPAWN", type: "bomb", replace: true }],
    { ai: { grade: "B", hint: "把排长变成炸弹，前排的排长变不了" } });
  C("H02", "堵枪眼", "战技", "堵", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 5 }), "play",
    { kind: "none", count: 0 }, [{ op: "MUTE_BOMB", team: "enemy", turns: "$duration" }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMax: 3 }, count: 1 },
      ai: { grade: "A", hint: "牺牲一个小子，换对面炸弹整场哑火" } });
  C("H03", "冷枪", "战技", "窥", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "enemySnipe", count: "$targets" }, [{ op: "REMOVE" }],
    { ai: { grade: "A", hint: "只能打铁路上没打过仗的敌子，且要有直线视野" } });
  C("H04", "假工事", "战技", "诱", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 3 }), "play",
    { kind: "ownLowBack", count: "$targets" }, [{ op: "SPAWN", type: "decoy", replace: true }],
    { ai: { grade: "B", hint: "把后两排的小子改成幻影，撞上来一起死" } });
  C("H05", "潜伏", "战技", "移", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "RELOCATE" }],
    { sel2: { kind: "enemyCampEmpty", count: 1 },
      ai: { grade: "A", hint: "把子塞进敌方空行营——行营里的子打不到" } });
  C("H06", "冲锋号", "战技", "生", "targets", T({ targets: 1 }, { targets: 2 }, { targets: 2 }), "play",
    { kind: "ownAnyEmpty", count: "$targets" }, [{ op: "SPAWN", type: "regiment" }],
    { ai: { grade: "B", hint: "需要己方半场有空位，中后期才有用" } });
  C("H07", "缴枪不杀", "战技", "夺", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "enemyAdjacent", filter: { rankMax: 8 }, count: "$targets" },
    [{ op: "CHANGE_OWNER" }, { op: "REVEAL", turns: 0 }],
    { ai: { grade: "C", hint: "只能俘获相邻的、军长及以下" } });
  C("H08", "救护", "战技", "生", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownHqCell", count: 1 }, [{ op: "REVIVE", repeat: "$count" }],
    { ai: { grade: "B", hint: "从阵亡池捞回来一个，放在大本营" } });
  C("H09", "孤胆", "战技", "变", "value",
    T({ rank: 8, n: 2 }, { rank: 8, n: 3 }, { rank: 8, n: 4 }), "play",
    { kind: "ownLowest", count: 1 }, [{ op: "RANK_SET", cond: "lowCount" }],
    { ai: { grade: "C", hint: "只剩两三枚子时才点得动，是翻盘牌" } });
  C("H10", "三板斧", "战技", "背", "uses",
    T({ uses: 3 }, { uses: 4 }, { uses: 5 }), "play",
    { kind: "ownPiece", filter: { rankMin: 1 }, count: 1 },
    [{ op: "REVEAL", turns: 0 }, { op: "SANBANFU" }],
    { ai: { grade: "A", hint: "选一枚子，接下来 3 场战斗必胜且不阵亡；打完第 3 场它永久变成团长" } });
  C("H11", "勇冠三军", "战技", "变", "value", T({ n: 3 }, { n: 3 }, { n: 2 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "yongguan", n: 3 }],
      ai: { grade: "B", hint: "吃掉 3 个军长/司令，最小的一枚直接变军长" } });
  C("H12", "晋级", "战技", "变", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "MARK", key: "growRank" }],
    { ai: { grade: "A", hint: "养一枚子，每吃一人升一级，封顶军长" } });
  C("H13", "降级", "战技", "变", "value", T({ count: 1, rank: 8 }, { count: 1, rank: 8 }, { count: 2, rank: 8 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "RANK_SET" }, { op: "MARK", key: "decayRank" }],
    { ai: { grade: "C", hint: "立刻变军长，但每回合掉一级，是沙漏不是翅膀" } });
  C("H14", "炮架", "战技", "兑", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyHighestRank", count: "$count" }, [{ op: "REMOVE" }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMin: 4 }, count: 1 },
      ai: { grade: "C", hint: "随机牺牲自己一枚连长以上，换掉对面最大的" } });
  C("H15", "爆破", "战技", "兑", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "BLAST" }],
    { ai: { grade: "B", hint: "自爆一枚子，把这一格和相邻四格的敌子一起清掉" } });
  C("H16", "击落王牌", "战技", "兑", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyFought", count: "$count" }, [{ op: "FORCE_TRADE" }],
    { ai: { grade: "A", hint: "只对打过仗的敌子生效——先逼他动手" } });
  C("H17", "反冲锋", "战技", "反", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "enemyAdjacent", count: "$count" }, [{ op: "REMOVE" }],
    { cost: { op: "DESTROY_RANDOM", filter: { rankMax: 3 }, count: 1 },
      ai: { grade: "B", hint: "用一个小子换掉贴脸的敌子" } });
  C("H18", "排弹", "战技", "反", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "enemyBomb", count: "$count" }, [{ op: "REMOVE" }],
    { ai: { grade: "A", hint: "直接拆掉对面的炸弹，不打架" } });
  C("H19", "炸桥", "战技", "堵", "duration", T({ duration: 2 }, { duration: 3 }, { duration: 4 }), "play",
    { kind: "cell", count: 1 }, [{ op: "BLOCK_EDGE", turns: "$duration" }],
    { ai: { grade: "A", hint: "选铁路上的一个点，断掉两边的路，双方都过不去" } });
  C("H20", "抢修", "战技", "堵", "value", T({ n: 1 }, { n: 1 }, { n: 2 }), "play",
    { kind: "none", count: 0 }, [{ op: "UNBLOCK" }],
    { ai: { grade: "B", hint: "把自己或对手断掉的路全部修回来" } });
  C("H21", "换位", "战技", "移", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "SWAP_POS" }],
    { sel2: { kind: "enemyAdjacent", count: 1 },
      ai: { grade: "B", hint: "跟贴脸的敌子换个位置，他进你的窝，你出他的门" } });
  C("H22", "渗透", "战技", "移", "count", T({ count: 1 }, { count: 1 }, { count: 2 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "RELOCATE" }],
    { sel2: { kind: "nearCells", count: 1, range: 4 },
      ai: { grade: "A", hint: "沿铁路往前走，一次能跨 4 格" } });
  C("H23", "蛰伏", "战技", "守", "duration", T({ duration: 3 }, { duration: 4 }, { duration: 5 }), "play",
    { kind: "ownPiece", count: 1 }, [{ op: "UNTARGETABLE", turns: "$duration" }],
    { ai: { grade: "B", hint: "这枚子几回合内谁都打不到，用来护旗或养子" } });
  C("H24", "守阵", "战技", "守", "count", T({ count: 1 }, { count: 2 }, { count: 3 }), "play",
    { kind: "ownPiece", count: "$count" }, [{ op: "DUEL_EVEN" }],
    { ai: { grade: "A", hint: "本回合被撞就是平兑，谁都不敢碰" } });
  C("H25", "空中侦察", "战技", "窥", "targets", T({ targets: 1 }, { targets: 1 }, { targets: 2 }), "play",
    { kind: "peekSpread", count: "$targets" }, [{ op: "PEEK" }],
    { ai: { grade: "B", hint: "四家各看一枚，先摸清谁在哪" } });
  C("H26", "越级克敌", "战技", "兑", "count", T({ count: 1 }, { count: 1 }, { count: 1 }), "passive",
    { kind: "none", count: 0 }, [], { onTake: [{ op: "TEAM_MARK", key: "overreach" }],
      ai: { grade: "A", hint: "营长以下撞军长/司令，改判同归于尽" } });

  const BY_ID = {};
  for (const c of CARDS) BY_ID[c.id] = c;

  const API = {
    CARDS, BY_ID,
    tierOf: (id, t) => (BY_ID[id] ? BY_ID[id].tiers[Math.max(0, Math.min(2, (t || 1) - 1))] : null),
  };
  global.JunqiDLCCards = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
