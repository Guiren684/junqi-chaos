/*
 * 乱战四国 · 棋盘与规则基座
 * 棋盘模型（17×17 坐标、行营/大本营、公路/铁路、中央九点、直线铁路线）改编自
 * BitByBitG/siguo-junqi（MIT License, Copyright (c) 2026 BitByBit）。
 * 原项目：https://github.com/BitByBitG/siguo-junqi
 * 本项目只保留棋盘/棋子定义，规则与交互按乱战四国重写。
 */
(function (global) {
  "use strict";

  const SEATS = ["north", "east", "south", "west"];
  const SEAT_NAMES = { north: "北方", east: "东方", south: "南方", west: "西方" };
  const SEAT_COLORS = { north: "#6f9a37", east: "#2f6fb0", south: "#d9792f", west: "#7b4b9e" };

  // 25 枚标准棋子（四国军棋）
  const PIECE_INFO = {
    flag:      { name: "军旗", rank: 0,  count: 1, immobile: true },
    commander: { name: "司令", rank: 9,  count: 1 },
    army:      { name: "军长", rank: 8,  count: 1 },
    division:  { name: "师长", rank: 7,  count: 2 },
    brigade:   { name: "旅长", rank: 6,  count: 2 },
    regiment:  { name: "团长", rank: 5,  count: 2 },
    battalion: { name: "营长", rank: 4,  count: 2 },
    company:   { name: "连长", rank: 3,  count: 3 },
    platoon:   { name: "排长", rank: 2,  count: 3 },
    engineer:  { name: "工兵", rank: 1,  count: 3 },
    mine:      { name: "地雷", rank: 0,  count: 3, immobile: true },
    bomb:      { name: "炸弹", rank: 0,  count: 2 },
  };

  const CAMP_CELLS = new Set(["1,1", "1,3", "2,2", "3,1", "3,3"]);
  const HQ_CELLS = new Set(["5,1", "5,3"]);

  function sectorPosition(seat, row, col) {
    if (seat === "north") return { x: 6 + col, y: 5 - row };
    if (seat === "south") return { x: 10 - col, y: 11 + row };
    if (seat === "west")  return { x: 5 - row,  y: 10 - col };
    return { x: 11 + row, y: 6 + col }; // east
  }

  function nodeId(seat, row, col) { return `${seat}-${row}-${col}`; }
  function edgeKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

  function buildBoard() {
    const nodes = [];
    const roads = new Set();
    const rails = new Set();
    const straightRailLines = [];
    const byId = new Map();
    const addEdge = (set, a, b) => set.add(edgeKey(a, b));

    for (const seat of SEATS) {
      for (let row = 0; row < 6; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          const key = `${row},${col}`;
          const node = {
            id: nodeId(seat, row, col),
            seat, row, col,
            x: sectorPosition(seat, row, col).x,
            y: sectorPosition(seat, row, col).y,
            kind: CAMP_CELLS.has(key) ? "camp" : HQ_CELLS.has(key) ? "hq" : "station",
          };
          nodes.push(node);
          byId.set(node.id, node);
        }
      }

      for (let row = 0; row < 6; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          const id = nodeId(seat, row, col);
          if (row + 1 < 6) addEdge(roads, id, nodeId(seat, row + 1, col));
          if (col + 1 < 5) addEdge(roads, id, nodeId(seat, row, col + 1));
          if (CAMP_CELLS.has(`${row},${col}`)) {
            for (const dr of [-1, 1]) {
              for (const dc of [-1, 1]) {
                if (row + dr >= 0 && row + dr < 6 && col + dc >= 0 && col + dc < 5) {
                  addEdge(roads, id, nodeId(seat, row + dr, col + dc));
                }
              }
            }
          }
        }
      }

      for (const row of [0, 4]) {
        for (let col = 0; col < 4; col += 1) {
          addEdge(rails, nodeId(seat, row, col), nodeId(seat, row, col + 1));
        }
      }
      for (const col of [0, 4]) {
        for (let row = 0; row < 4; row += 1) {
          addEdge(rails, nodeId(seat, row, col), nodeId(seat, row + 1, col));
        }
      }
      straightRailLines.push(
        Array.from({ length: 5 }, (_, col) => nodeId(seat, 0, col)),
        Array.from({ length: 5 }, (_, col) => nodeId(seat, 4, col)),
        Array.from({ length: 5 }, (_, row) => nodeId(seat, row, 0)),
        Array.from({ length: 5 }, (_, row) => nodeId(seat, row, 4)),
      );
    }

    // 中央九点
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const id = `center-${row}-${col}`;
        const node = { id, seat: null, row, col, x: 7 + col, y: 7 + row, kind: "station" };
        nodes.push(node);
        byId.set(id, node);
      }
    }
    const centerLines = [
      [nodeId("north", 0, 0), "center-0-0", "center-1-0", "center-2-0", nodeId("south", 0, 4)],
      [nodeId("north", 0, 2), "center-0-1", "center-1-1", "center-2-1", nodeId("south", 0, 2)],
      [nodeId("north", 0, 4), "center-0-2", "center-1-2", "center-2-2", nodeId("south", 0, 0)],
      [nodeId("west", 0, 4), "center-0-0", "center-0-1", "center-0-2", nodeId("east", 0, 0)],
      [nodeId("west", 0, 2), "center-1-0", "center-1-1", "center-1-2", nodeId("east", 0, 2)],
      [nodeId("west", 0, 0), "center-2-0", "center-2-1", "center-2-2", nodeId("east", 0, 4)],
    ];
    for (const line of centerLines) {
      for (let i = 0; i < line.length - 1; i += 1) {
        addEdge(roads, line[i], line[i + 1]);
        addEdge(rails, line[i], line[i + 1]);
      }
    }
    straightRailLines.push(...centerLines);

    // 对边铁路 + 中央铁路拼成一条直线
    straightRailLines.push(
      [...Array.from({ length: 5 }, (_, row) => nodeId("north", 4 - row, 0)), ...centerLines[0].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("south", row, 4))],
      [...Array.from({ length: 5 }, (_, row) => nodeId("north", 4 - row, 4)), ...centerLines[2].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("south", row, 0))],
      [...Array.from({ length: 5 }, (_, row) => nodeId("west", 4 - row, 4)), ...centerLines[3].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("east", row, 0))],
      [...Array.from({ length: 5 }, (_, row) => nodeId("west", 4 - row, 0)), ...centerLines[5].slice(1, -1), ...Array.from({ length: 5 }, (_, row) => nodeId("east", row, 4))],
    );

    // 四角弯道：相邻两方前角相连，规则上视为同一条直线铁路
    const cornerLinks = [];
    for (let i = 0; i < SEATS.length; i += 1) {
      const seat = SEATS[i];
      const next = SEATS[(i + 1) % SEATS.length];
      cornerLinks.push([nodeId(seat, 0, 4), nodeId(next, 0, 0)]);
      straightRailLines.push([
        ...Array.from({ length: 5 }, (_, offset) => nodeId(seat, 4 - offset, 4)),
        ...Array.from({ length: 5 }, (_, row) => nodeId(next, row, 0)),
      ]);
    }
    for (const [a, b] of cornerLinks) {
      addEdge(roads, a, b);
      addEdge(rails, a, b);
    }

    const neighbors = new Map(nodes.map((n) => [n.id, []]));
    const railNeighbors = new Map(nodes.map((n) => [n.id, []]));
    for (const key of roads) {
      const [a, b] = key.split("|");
      neighbors.get(a).push(b);
      neighbors.get(b).push(a);
    }
    for (const key of rails) {
      const [a, b] = key.split("|");
      railNeighbors.get(a).push(b);
      railNeighbors.get(b).push(a);
      if (!neighbors.get(a).includes(b)) neighbors.get(a).push(b);
      if (!neighbors.get(b).includes(a)) neighbors.get(b).push(a);
    }
    return { nodes, byId, roads, rails, neighbors, railNeighbors, straightRailLines };
  }

  const BOARD = buildBoard();

  // 队伍归属。双人模式（南 vs 北）下南/北本来就是同队，所以要能临时改判：
  // 用 setTeams 覆盖，退出双人模式时必须 setTeams(null) 复位，否则四国局会串味。
  let TEAM_OVERRIDE = null;
  function teamOf(seat) {
    if (TEAM_OVERRIDE && TEAM_OVERRIDE[seat]) return TEAM_OVERRIDE[seat];
    return seat === "north" || seat === "south" ? "A" : "B";
  }
  function setTeams(map) { TEAM_OVERRIDE = map || null; }
  function hqCells(seat) {
    return [nodeId(seat, 5, 1), nodeId(seat, 5, 3)];
  }
  function campCells(seat) {
    return [...CAMP_CELLS].map((key) => {
      const [row, col] = key.split(",").map(Number);
      return nodeId(seat, row, col);
    });
  }
  function frontierCells(seat) {
    return Array.from({ length: 5 }, (_, col) => nodeId(seat, 0, col));
  }
  function isOwnCell(seat, id) {
    const node = BOARD.byId.get(id);
    return !!node && node.seat === seat;
  }
  function cellLabel(id) {
    const node = BOARD.byId.get(id);
    if (!node) return id;
    if (node.seat === null) return "中央";
    return `${SEAT_NAMES[node.seat]}${node.row + 1}-${node.col + 1}`;
  }

  // 到某个格子的最少步数（按公路/铁路连通性，忽略棋子阻挡），用于 AI 位置评估
  const distanceCache = new Map();
  function distancesTo(targetId) {
    if (distanceCache.has(targetId)) return distanceCache.get(targetId);
    const dist = new Map([[targetId, 0]]);
    const queue = [targetId];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of BOARD.neighbors.get(cur) || []) {
        if (!dist.has(next)) {
          dist.set(next, dist.get(cur) + 1);
          queue.push(next);
        }
      }
    }
    distanceCache.set(targetId, dist);
    return dist;
  }

  const API = {
    SEATS, SEAT_NAMES, SEAT_COLORS, PIECE_INFO, CAMP_CELLS, HQ_CELLS,
    BOARD, teamOf, setTeams, hqCells, campCells, frontierCells,
    isOwnCell, cellLabel, distancesTo, nodeId, edgeKey,
  };
  global.JunqiBoard = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
