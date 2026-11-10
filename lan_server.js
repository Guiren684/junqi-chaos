// lan_server.js — 局域网开黑的服务端（零依赖，只用 Node 内置模块）
//
// 干三件事：
//   1. 把整个目录当静态站点发出去（大家访问 http://<房主IP>:8080/ 就是游戏）
//   2. 记座位：第一个进来的是房主（南家），之后依次东/北/西
//   3. 转发：房主把权威局面推给服务端 → 服务端广播给其他人；
//            其他人的操作交给服务端 → 转给房主执行
//
// 为什么是"房主权威"而不是服务端跑 AI：AI 调度、卡牌结算、里程碑发牌全在浏览器里
// 已经跑通且有测试兜底，搬到 Node 等于把引擎再实现一遍。房主退出了就由客户端提示
// "房主已离线"，本局结束——局域网开黑这个代价可以接受。
//
// 用法：node lan_server.js [--port 8080]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = __dirname;
const argPort = (() => {
  const i = process.argv.indexOf("--port");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();
const PORT = argPort || Number(process.env.LAN_PORT) || 8080;
// 断线后保留座位的时长；--grace 毫秒（测试里用 800ms 验重连，正式跑 60s）
const argGrace = (() => {
  const i = process.argv.indexOf("--grace");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();
const GRACE_MS = argGrace || 60000;
// 入座顺序特意按"同队优先"排：四国里 南+北 一队、东+西 一队。
// 两个人开黑就该坐南北（队友），三个人再给东家（AI 西家陪打）。
const SEAT_ORDER = ["south", "north", "east", "west"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// ---------------- 房间状态（单进程单房间） ----------------
const room = {
  players: new Map(),      // pid → { pid, name, seat, isHost, at }
  order: [],               // pid 进入顺序
  started: false,
  hostPid: null,
  latest: null,            // 房主最近一次推的权威局面（JSON 字符串）
};
const streams = new Map(); // pid → res（SSE）

let pidSeq = 0;

// 只要还收到这个人的动静（SSE 重连 / 推送 / 操作），就把他标回在线，
// 并让"60 秒后删除"那个定时器自己失效（它检查 offline 标记）。
function touch(pid) {
  const p = room.players.get(pid);
  if (!p) return;
  if (p.offline) { p.offline = false; pushLobby(); }
  p.offlineAt = 0;
  p.at = Date.now();
}

function playerList() {
  return room.order
    .map((pid) => room.players.get(pid))
    .filter(Boolean)
    .map((p) => ({ pid: p.pid, name: p.name, seat: p.seat, isHost: !!p.isHost }));
}

function freeSeat() {
  const used = new Set(Array.from(room.players.values()).map((p) => p.seat));
  for (const s of SEAT_ORDER) if (!used.has(s)) return s;
  return null;
}

function sse(res, event, data) {
  res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

function broadcast(event, data, exceptPid) {
  for (const [pid, res] of streams) {
    if (pid === exceptPid) continue;
    try { sse(res, event, data); } catch (e) { /* 断开的连接下一轮心跳会清掉 */ }
  }
}

function sendTo(pid, event, data) {
  const res = streams.get(pid);
  if (!res) return false;
  try { sse(res, event, data); return true; } catch (e) { return false; }
}

function lobbyPayload() {
  return {
    players: playerList(),
    started: room.started,
    hostPid: room.hostPid,
    seats: SEAT_ORDER,
    aiSeats: SEAT_ORDER.filter((s) => !Array.from(room.players.values()).some((p) => p.seat === s)),
  };
}

function pushLobby() {
  broadcast("lobby", lobbyPayload());
}

// ---------------- HTTP ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  // 目录穿越防护
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 " + rel);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;

  // 预检（页面若从别的源打开，允许跨源调 API）
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ---- 加入 ----
  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "玩家").slice(0, 12);
    // 同一浏览器（同 pid）重复加入就用原来的
    let pid = String(body.pid || "");
    if (pid && room.players.has(pid)) {
      // 老玩家回来（多半是刷新页面）：座位、房主身份、局面都还给他
      const old = room.players.get(pid);
      old.name = name;
      old.offline = false;
      old.offlineAt = 0;
      pushLobby();
      json(res, 200, {
        ok: true, pid, seat: old.seat, isHost: !!old.isHost,
        players: playerList(), started: room.started, latest: room.latest,
      });
      return;
    }
    // 开局之后不再收人：现在没有观战席，半路进来会占一个其实在跑 AI 的座位
    if (room.started) { json(res, 409, { ok: false, error: "这局已经开始了，等这局结束再进" }); return; }
    const seat = freeSeat();
    if (!seat) { json(res, 409, { ok: false, error: "房间满了（最多 4 人）" }); return; }
    pid = "p" + (++pidSeq);
    const isHost = room.order.length === 0;
    room.players.set(pid, { pid, name, seat, isHost, at: Date.now() });
    room.order.push(pid);
    if (isHost) room.hostPid = pid;
    pushLobby();
    json(res, 200, { ok: true, pid, seat, isHost, players: playerList(), started: room.started, latest: room.latest });
    return;
  }

  // ---- 大厅信息 ----
  if (p === "/api/lobby") {
    json(res, 200, lobbyPayload());
    return;
  }

  // ---- SSE 事件流 ----
  if (p === "/api/events") {
    const pid = String(u.query.pid || "");
    if (!room.players.has(pid)) { res.writeHead(400); res.end("unknown pid"); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 1500\n\n");
    streams.set(pid, res);
    touch(pid);          // 重连回来：座位/房主身份照旧，别当成"离线"
    sse(res, "hello", { pid, seat: room.players.get(pid).seat, isHost: room.players.get(pid).isHost });
    sse(res, "lobby", lobbyPayload());
    if (room.latest) sse(res, "snapshot", { state: room.latest, started: room.started });
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) { /* */ } }, 20000);
    // 断线不立刻踢人：刷新页面会先断开再重连，立刻删座位会让"刷新一下"变成换座位。
    // 座位保留 60 秒，期间用同一个 pid 回来就还是原来那家。
    const cleanup = () => {
      clearInterval(hb);
      // 只删自己那条流：重连时新旧两条可能短暂并存，删错会把新连的踢掉
      if (streams.get(pid) === res) streams.delete(pid);
      if (streams.has(pid)) return;          // 还有另一条活着 = 在线，别标离线
      const gone = room.players.get(pid);
      if (!gone) return;
      gone.offline = true;
      gone.offlineAt = Date.now();
      pushLobby();
      setTimeout(() => {
        const p2 = room.players.get(pid);
        if (!p2 || !p2.offline || p2.offlineAt !== gone.offlineAt) return;
        room.players.delete(pid);
        room.order = room.order.filter((x) => x !== pid);
        if (pid === room.hostPid) {
          room.hostPid = null;
          room.started = false;
          room.latest = null;
          broadcast("hostgone", {});
        }
        pushLobby();
      }, GRACE_MS);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    return;
  }

  // ---- 客户端操作 → 转给房主 ----
  if (p === "/api/action" && req.method === "POST") {
    const body = await readBody(req);
    const pl = room.players.get(String(body.pid || ""));
    if (!pl) { json(res, 400, { ok: false, error: "还没加入房间" }); return; }
    touch(pl.pid);
    if (!room.hostPid || !streams.has(room.hostPid)) {
      json(res, 409, { ok: false, error: "房主不在线" });
      return;
    }
    sendTo(room.hostPid, "action", { pid: pl.pid, seat: pl.seat, kind: body.kind, payload: body.payload || {} });
    json(res, 200, { ok: true });
    return;
  }

  // ---- 房主推送权威局面 ----
  if (p === "/api/push" && req.method === "POST") {
    const body = await readBody(req);
    const pl = room.players.get(String(body.pid || ""));
    if (!pl || !pl.isHost) { json(res, 403, { ok: false, error: "只有房主能推局面" }); return; }
    touch(pl.pid);
    if (body.type === "start") {
      room.started = true;
      room.latest = body.state || null;
      broadcast("start", { state: room.latest, seats: playerList() }, pl.pid);
      pushLobby();
      json(res, 200, { ok: true });
      return;
    }
    if (body.type === "snapshot") {
      room.latest = body.state || null;
      broadcast("snapshot", { state: room.latest }, pl.pid);
      json(res, 200, { ok: true });
      return;
    }
    if (body.type === "over") {
      room.started = false;
      broadcast("over", { result: body.result || null }, pl.pid);
      pushLobby();
      json(res, 200, { ok: true });
      return;
    }
    json(res, 400, { ok: false, error: "未知的 type" });
    return;
  }

  // ---- 复用房间（重启一局） ----
  if (p === "/api/reset" && req.method === "POST") {
    const body = await readBody(req);
    const pl = room.players.get(String(body.pid || ""));
    if (!pl || !pl.isHost) { json(res, 403, { ok: false, error: "只有房主能重开" }); return; }
    room.started = false;
    room.latest = null;
    broadcast("reset", {});
    pushLobby();
    json(res, 200, { ok: true });
    return;
  }

  if (p === "/api/quit" && req.method === "POST") {
    const body = await readBody(req);
    const pid = String(body.pid || "");
    const gone = room.players.get(pid);
    if (gone) {
      room.players.delete(pid);
      room.order = room.order.filter((x) => x !== pid);
      if (pid === room.hostPid) { room.hostPid = null; room.started = false; broadcast("hostgone", {}); }
      pushLobby();
    }
    json(res, 200, { ok: true });
    return;
  }

  serveStatic(req, res, p);
});

server.listen(PORT, "0.0.0.0", () => {
  const nets = require("os").networkInterfaces();
  const addrs = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k] || []) {
      if (n.family === "IPv4" && !n.internal) addrs.push(n.address);
    }
  }
  console.log("局域网开黑服务已启动");
  console.log("  本机：http://127.0.0.1:" + PORT + "/");
  for (const a of addrs) console.log("  局域网：http://" + a + ":" + PORT + "/");
  console.log("  房主先开页面点「局域网开黑 → 创建房间」，其他人打开同一地址点「加入」。");
});
