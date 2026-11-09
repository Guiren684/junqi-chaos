/*
 * dlc_status.js — DLC 状态层
 * 所有"不是立刻结束"的效果都落成一条状态，统一挂在 state.dlc.statuses 上，统一 tick。
 *
 * 状态条：{ key, target, team, value, until, decay }
 *   target: 棋子 id | 座位名 | "cell:<格>" | "edge:<a|b>" | null
 *   until : 还剩几手（null = 永久，靠事件清除）
 *   decay : 每 tick 让 value.n 减 1（用于"每回合降一级"）
 */
(function (global) {
  "use strict";

  function store(state) {
    if (!state.dlc) state.dlc = {};
    if (!Array.isArray(state.dlc.statuses)) state.dlc.statuses = [];
    return state.dlc.statuses;
  }

  function add(state, entry) {
    const list = store(state);
    // 同 key 同 target：取时间较长者，不叠加
    const old = list.find((s) => s.key === entry.key && s.target === entry.target && s.team === entry.team);
    if (old) {
      if (entry.until != null && (old.until == null || entry.until > old.until)) old.until = entry.until;
      if (entry.value && entry.value.n != null) old.value.n = Math.max(old.value.n || 0, entry.value.n);
      return old;
    }
    const row = {
      key: entry.key,
      target: entry.target != null ? entry.target : null,
      team: entry.team != null ? entry.team : null,
      value: entry.value || {},
      until: entry.until != null ? entry.until : null,
      decay: entry.decay || 0,
    };
    list.push(row);
    return row;
  }

  function get(state, key, target, team) {
    const list = store(state);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const s = list[i];
      if (s.key !== key) continue;
      if (target !== undefined && s.target !== target) continue;
      if (team !== undefined && s.team !== team) continue;
      return s;
    }
    return null;
  }

  function has(state, key, target, team) {
    return !!get(state, key, target, team);
  }

  function clear(state, key, target) {
    const list = store(state);
    state.dlc.statuses = list.filter((s) => !(s.key === key && (target === undefined || s.target === target)));
  }

  function byTarget(state, target) {
    return store(state).filter((s) => s.target === target);
  }

  function byTeam(state, team) {
    return store(state).filter((s) => s.team === team);
  }

  /**
   * 每手结束调用：until 递减、到期移除、decay 生效。
   * onExpire(state, status) 由 dlc.js 注入，用于"到期时执行某事"（如三板斧降级）。
   */
  function tick(state, onExpire) {
    const list = store(state);
    const keep = [];
    for (const s of list) {
      if (s.decay && s.value && s.value.n != null) {
        s.value.n -= s.decay;
        if (s.value.n <= 0) {
          if (onExpire) onExpire(state, s);
          continue;
        }
      }
      if (s.until != null) {
        s.until -= 1;
        if (s.until <= 0) {
          if (onExpire) onExpire(state, s);
          continue;
        }
      }
      keep.push(s);
    }
    state.dlc.statuses = keep;
  }

  function snapshot(state) {
    return store(state).map((s) => ({ key: s.key, target: s.target, team: s.team, until: s.until, value: s.value }));
  }

  const API = { add, get, has, clear, byTarget, byTeam, tick, snapshot, store };
  global.JunqiDLCStatus = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
