'use strict';

// ============ 运城扣点点麻将：P0 安全护栏单测 ============
// 1) 重连凭据：缺 secret / 错误 secret / 他人拿到 playerId 顶替座位 一律拒绝
// 2) 房间号暴力枚举：连续 join 失败触发锁定退避，成功加入即清零
// 3) WebSocket 护栏：超长消息丢弃、每连接令牌桶限流、单 IP 并发上限与计数回收

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');

// ---------- 测试工具：伪 WebSocket 客户端（与 game.test.js 一致） ----------
// 所有创建的 ws 入池，cleanupServer 统一清心跳定时器，避免 pending interval 挂住 worker
const wsPool = [];

function makeWs() {
  const ws = { readyState: 1, sent: [], handlers: {}, pingCount: 0, terminated: false, closed: false };
  ws.on = (type, cb) => { ws.handlers[type] = cb; };
  ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
  ws.ping = () => { ws.pingCount += 1; };
  ws.close = () => { ws.closed = true; };
  ws.terminate = () => {
    if (ws.terminated) return;
    ws.terminated = true;
    ws.readyState = 3;
    if (ws.handlers.close) ws.handlers.close();
  };
  wsPool.push(ws);
  return ws;
}

function send(ws, obj) {
  ws.handlers.message(JSON.stringify(obj));
}

function lastOf(ws, type) {
  const list = ws.sent.filter((m) => m.type === type);
  return list.length ? list[list.length - 1] : null;
}

function newServer() {
  return new GameServer({ gameLog: false });
}

const BASE_SETTINGS = { aiFill: true, totalRounds: 4 };

// 清理定时器：额外传入未进大厅的连接，避免心跳 interval 挂住 worker
function cleanupServer(srv, extra = []) {
  for (const room of srv.rooms.values()) {
    for (const t of room.timers.values()) clearTimeout(t);
    room.timers.clear();
  }
  for (const ws of wsPool.concat(extra)) {
    if (ws._heartbeatTimer) {
      clearInterval(ws._heartbeatTimer);
      ws._heartbeatTimer = null;
    }
  }
  wsPool.length = 0;
  for (const p of srv.players.values()) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

// ============ 问题1：重连凭据不可劫持 ============

test('重连：缺少 secret 一律拒绝（不得接管他人座位）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const hello = lastOf(wa, 'hello');
  assert.ok(hello.secret, 'hello 应下发 secret（仅本人连接，仅此一次）');
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  wa.handlers.close(); // 甲断线

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: hello.playerId }); // 只带 playerId
  assert.ok(lastOf(wa2, 'error').message.includes('凭据无效'), '缺 secret 应被拒并给出明确提示');
  assert.equal(lastOf(wa2, 'hello'), null, '凭据无效不得下发 hello');
  assert.equal(srv.players.get(hello.playerId).ws, null, '原座位连接不得被顶替');
  cleanupServer(srv);
});

test('重连：错误 secret 被拒（即使 playerId 正确）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const id = lastOf(wa, 'hello').playerId;
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  wa.handlers.close();

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: id, secret: 'wrong-secret' });
  assert.ok(lastOf(wa2, 'error').message.includes('凭据无效'));
  assert.equal(srv.players.get(id).ws, null, '错误 secret 不得接管连接');
  cleanupServer(srv);
});

test('重连：正确 playerId + secret 方可恢复座位（正向对照）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const hello = lastOf(wa, 'hello');
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  wa.handlers.close();

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: hello.playerId, secret: hello.secret });
  assert.ok(lastOf(wa2, 'hello'), '凭据正确应下发 hello');
  assert.equal(srv.players.get(hello.playerId).ws, wa2, '连接已切换到新 ws');
  assert.equal(room.players[0].id, hello.playerId, '甲仍在原座位');
  cleanupServer(srv);
});

test('他人即使拿到 playerId 也无法顶替座位；房间视图不再广播真实 playerId/secret', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const helloA = lastOf(wa, 'hello');
  const idA = helloA.playerId;
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];

  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '乙' });
  const idB = lastOf(wb, 'hello').playerId;
  send(wb, { type: 'join_room', roomId: room.id });

  // 乙视角的房间视图：甲只有座位代称，无真实 playerId、无 secret
  const viewB = lastOf(wb, 'room_state').room;
  assert.equal(viewB.players[0].id, 's0', '他人视角仅暴露座位代称');
  assert.notEqual(viewB.players[0].id, idA, '他人视角不得下发真实 playerId');
  assert.equal(viewB.players[1].id, idB, '本人视角仍是真实 playerId');
  assert.notEqual(viewB.ownerId, idA, '他人视角的 ownerId 也不得是真实 playerId');
  assert.ok(!JSON.stringify(viewB).includes(helloA.secret), '房间视图不得携带 secret');

  // 乙拿甲的 playerId 重连（模拟 playerId 泄露）→ 拒绝，甲座位不受影响
  const wb2 = makeWs();
  srv.handleConnection(wb2);
  send(wb2, { type: 'reconnect', playerId: idA, secret: 'x' });
  assert.ok(lastOf(wb2, 'error'), '他人 playerId 重连应被拒');
  assert.equal(room.players[0].id, idA, '甲仍坐在原座位');
  assert.equal(srv.players.get(idA).ws, wa, '甲的连接未被接管');

  // 大厅列表也不得泄露 playerId / secret
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.ok(!JSON.stringify(lobbyB).includes(idA), 'lobby_state 不得含他人 playerId');
  assert.ok(!JSON.stringify(lobbyB).includes(helloA.secret), 'lobby_state 不得含 secret');
  assert.equal(lobbyB.rooms[0].ownerId, undefined, 'lobby_state 不下发 ownerId');
  cleanupServer(srv);
});

// ---------- 结构化错误码：老客户端（T-SEC-01 之前登录，本地无 secret）自愈入口 ----------

test('重连失败带结构化错误码 AUTH_FAILED，且不恢复座位（老客户端无 secret）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const hello = lastOf(wa, 'hello');
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  wa.handlers.close(); // 甲断线（模拟老用户刷新）

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: hello.playerId }); // 老客户端：只有 playerId
  const err = lastOf(wa2, 'error');
  assert.ok(err, '凭据无效应回 error');
  assert.equal(err.code, 'AUTH_FAILED', '应带机器可读的结构化错误码，供前端自愈');
  assert.ok(err.message.includes('凭据无效'), '中文文案保留用于直接展示');
  assert.equal(lastOf(wa2, 'hello'), null, '凭据无效不得下发 hello');
  assert.equal(srv.players.get(hello.playerId).ws, null, '不得为其恢复/接管连接');
  assert.equal(room.players[0].id, hello.playerId, '座位归属不变（不得被顶替）');
  cleanupServer(srv);
});

test('重连失败：错误 secret 同样返回 AUTH_FAILED（校验强度不降低）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const id = lastOf(wa, 'hello').playerId;
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  wa.handlers.close();

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: id, secret: 'wrong-secret' });
  assert.equal(lastOf(wa2, 'error').code, 'AUTH_FAILED');
  assert.equal(srv.players.get(id).ws, null, '错误 secret 不得接管连接');
  cleanupServer(srv);
});

test('重连成功（正确双因子）不返回 AUTH_FAILED，正常恢复座位', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const hello = lastOf(wa, 'hello');
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  wa.handlers.close();

  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: hello.playerId, secret: hello.secret });
  assert.equal(lastOf(wa2, 'error'), null, '正向重连不应产生 error');
  assert.ok(lastOf(wa2, 'hello'), '凭据正确应下发 hello');
  assert.ok(lastOf(wa2, 'room_state'), '在房间中重连应补发 room_state');
  assert.equal(srv.players.get(hello.playerId).ws, wa2, '连接已切换到新 ws');
  assert.equal(room.players[0].id, hello.playerId, '甲仍在原座位');
  cleanupServer(srv);
});

// ============ 问题2：房间号不可暴力枚举 ============

test('加入房间：连续失败达上限即锁定退避，锁定期内正确房间号也不放行', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const p = srv.players.get(lastOf(wa, 'hello').playerId);

  for (let i = 0; i < 5; i++) send(wa, { type: 'join_room', roomId: '0000' }); // 不存在的房间号
  assert.equal(p.joinFails, 5, '连续失败计数应累加');
  assert.ok(p.joinLockUntil > Date.now(), '达到上限后应进入锁定');

  send(wa, { type: 'join_room', roomId: '0000' });
  assert.ok(lastOf(wa, 'error').message.includes('过于频繁'), '锁定期应给出明确提示');
  assert.ok(srv.stats.joinLocked >= 1, '锁定命中应计数');

  // 锁定期内：房间号即便正确也拒绝加入（枚举被挡住）
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '乙' });
  send(wb, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wa, { type: 'join_room', roomId: room.id });
  assert.equal(room.players[1], null, '锁定期内正确房间号也不放行');

  // 解除锁定后可正常加入，且计数清零
  srv._resetJoinFails(p);
  send(wa, { type: 'join_room', roomId: room.id });
  assert.equal(room.players[1], p, '解除锁定后可正常加入');
  assert.equal(p.joinFails, 0, '加入成功后失败计数清零');
  cleanupServer(srv);
});

test('加入房间：未达上限的失败不影响后续正常加入', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const p = srv.players.get(lastOf(wa, 'hello').playerId);
  send(wa, { type: 'join_room', roomId: '0000' });
  send(wa, { type: 'join_room', roomId: '0000' });
  assert.equal(p.joinFails, 2);
  assert.equal(srv._joinLockLeft(p), 0, '未达上限不应锁定');

  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  assert.equal(p.joinFails, 0, '创建房间成功即清零失败计数');
  cleanupServer(srv);
});

// ============ 问题3：WebSocket 护栏 ============

test('超长消息：直接丢弃并计数，不解析、不抛异常、不回包', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const before = wa.sent.length;

  wa.handlers.message('x'.repeat(16 * 1024 + 1)); // 超过 MAX_RAW_MSG(16KB)
  assert.equal(wa.sent.length, before, '超长消息不应产生任何响应');
  assert.equal(srv.stats.oversize, 1, '超长消息应被计数');

  send(wa, { type: 'join_room', roomId: '0000' }); // 正常长度消息仍可用
  assert.ok(lastOf(wa, 'error'), '正常消息仍应被处理');
  cleanupServer(srv);
});

test('限流：每连接令牌桶耗尽后静默丢弃并计数', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });

  for (let i = 0; i < 200; i++) send(wa, { type: 'no_such_type' }); // 1 秒内远超 60 条
  assert.ok(srv.stats.rateLimited > 0, '超限消息应被丢弃并计数');
  assert.ok(srv.stats.unknownType <= 61, `1 秒内最多放行约 60 条，实际放行 ${srv.stats.unknownType}`);
  assert.equal(lastOf(wa, 'error'), null, '丢弃应静默，不回错误包');
  cleanupServer(srv);
});

test('限流：未知消息类型静默丢弃并计数（不回显）', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  const before = wa.sent.length;
  send(wa, { type: 'no_such_type' });
  assert.equal(wa.sent.length, before, '未知类型不应回复');
  assert.equal(srv.stats.unknownType, 1);
  cleanupServer(srv);
});

test('单 IP 并发上限：超额连接被拒，连接关闭后计数回收（不无界增长）', () => {
  const srv = newServer();
  const conns = [];
  for (let i = 0; i < 12; i++) {
    const ws = makeWs();
    srv.handleConnection(ws, { ip: '10.0.0.9' });
    conns.push(ws);
  }
  assert.equal(srv.ipConns.get('10.0.0.9'), 12);

  const extra = makeWs();
  srv.handleConnection(extra, { ip: '10.0.0.9' });
  assert.equal(srv.stats.rejectedConn, 1, '第 13 条同 IP 连接应被拒');
  assert.equal(extra.closed, true, '被拒连接应被关闭');
  assert.equal(extra.handlers.message, undefined, '被拒连接不接入业务层');

  conns[0].handlers.close(); // 关闭一条 → 计数回收
  const ws2 = makeWs();
  srv.handleConnection(ws2, { ip: '10.0.0.9' });
  assert.equal(srv.stats.rejectedConn, 1, '回收后不应继续拒绝');
  assert.ok(ws2.handlers.message, '回收后可正常接入');

  for (const ws of conns) if (!ws.closed) ws.handlers.close();
  ws2.handlers.close();
  assert.equal(srv.ipConns.size, 0, '全部关闭后不应残留计数');
  cleanupServer(srv, [...conns, extra, ws2]);
});

test('未传 IP 的连接（内部/测试直连）不受并发上限影响', () => {
  const srv = newServer();
  const list = [];
  for (let i = 0; i < 20; i++) {
    const ws = makeWs();
    srv.handleConnection(ws); // 无 ip
    list.push(ws);
  }
  assert.equal(srv.stats.rejectedConn, 0);
  assert.equal(srv.ipConns.size, 0, '无 IP 不落计数，避免内存无界');
  cleanupServer(srv, list);
});
