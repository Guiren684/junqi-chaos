/*
 * dlc_quiz.js — 用卡前的「战地问答」
 *
 * 规则（一次使用 = 两题）：
 *   初始等级 = 手牌等级（Ⅰ/Ⅱ/Ⅲ），每答对 1 题升 1 级，封顶 Ⅲ 级。
 *   也就是：Ⅰ 级卡答对 2 题 = Ⅲ 级效果；Ⅱ 级卡答对 1 题就满；Ⅲ 级卡本身已满，答题只为不降级。
 *
 * MODE 决定"初始从几级起"：
 *   "add"     —— 手牌等级 + 答对数（默认，保留抽牌等级/军功升级的价值）
 *   "replace" —— 一律从 Ⅰ 级起算，完全由答对数决定（抽到的等级只作展示）
 *
 * 这里只管"抽题 / 判分 / 换算等级"，不碰 DOM；界面在 ui.js。
 */
(function (global) {
  "use strict";

  const POOL = (global.JUNQI_QUIZ || []).slice();
  const MODE = "add";
  const PER_USE = 2;              // 每次使用问几题
  const MAX_LEVEL = 3;
  const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ"];

  function size() { return POOL.length; }
  function all() { return POOL.slice(); }
  function byId(id) { return POOL.find((q) => String(q.id) === String(id)) || null; }

  // 抽 n 道不重复的题；rng 可注入（测试用），exclude 是"这局已经问过的题号"
  // 剩余不足 n 道时当作题库用完了，整库重来（否则残局会抽不到题）
  function draw(n, rng, exclude) {
    const rand = rng || Math.random;
    const want = Math.max(0, Math.min(n == null ? PER_USE : n, POOL.length));
    const ex = new Set((exclude || []).map(String));
    let idx = POOL.map((q, i) => i).filter((i) => !ex.has(String(POOL[i].id)));
    if (idx.length < want) idx = POOL.map((q, i) => i);
    for (let i = idx.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return idx.slice(0, want).map((i) => POOL[i]);
  }

  // 一次使用里答对 correct 题，最终按几级结算
  function level(baseTier, correct) {
    const base = MODE === "replace" ? 1 : (baseTier || 1);
    return Math.max(1, Math.min(MAX_LEVEL, base + Math.max(0, correct || 0)));
  }

  // 答对 k 题时，这一步是不是"升级"
  function upgradeText(baseTier, correct) {
    const before = MODE === "replace" ? 1 : (baseTier || 1);
    const after = level(baseTier, correct);
    if (after === before) return "等级不变（已是 " + ROMAN[after - 1] + " 级）";
    return ROMAN[before - 1] + " 级 → " + ROMAN[after - 1] + " 级";
  }

  function check(question, choice) {    if (!question) return false;
    return Number(choice) === Number(question.a);
  }

  const API = { size, all, byId, draw, level, upgradeText, check, ROMAN, MODE, PER_USE, MAX_LEVEL };
  global.JunqiQuiz = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
