'use strict';

// ============ 运城扣点点麻将：实时语音对讲信令转发（_voiceSignal）单测 ============
// 覆盖：同房间真人目标收到转发 / 目标为 AI 时忽略 / 目标不在房间时忽略 / sig 超限拒绝

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');

// ---------- 测试工具：伪 WebSocket 客户端 ----------
function makeWs() {
  const ws = { readyState: 1, sent: [], handlers: {}, pingCount: 0, terminated: false };
  ws.on = (type, cb) => { ws.handlers[type] = cb; };
  ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
  ws.ping = () => { ws.pingCount += 1; };
  ws.terminate = () => {
    if (ws.terminated) return;
    ws.terminated = true;
    ws.readyState = 3;
    if (ws.handlers.close) ws.handlers.close();
  };
  return ws;
}

function send(ws, obj) {
  ws.handlers.message(JSON.stringify(obj));
}

function lastOf(ws, type) {
  const list = ws.sent.filter((m) => m.type === type);
  return list.length ? list[list.length - 1] : null;
}

function countOf(ws, type) {
  return ws.sent.filter((m) => m.type === type).length;
}

function helloId(ws) {
  const hello = ws.sent.find((m) => m.type === 'hello');
  return hello.playerId;
}

function newServer() {
  return new GameServer();
}

// 清理服务端所有定时器，避免 node --test 因 pending timer 拖慢退出
function cleanupServer(srv) {
  for (const room of srv.rooms.values()) {
    for (const t of room.timers.values()) clearTimeout(t);
    room.timers.clear();
  }
  for (const ws of srv.wsPlayers.keys()) {
    if (ws._heartbeatTimer) {
      clearInterval(ws._heartbeatTimer);
      ws._heartbeatTimer = null;
    }
  }
  for (const p of srv.players.values()) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

const BASE_SETTINGS = { aiFill: false, totalRounds: 4 };

// 构造：房主甲 + 真人乙同房间，房主再补一个 AI；丙在大厅（不在房间）
function setupScenario() {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  const wc = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];

  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '乙' });
  send(wb, { type: 'join_room', roomId: room.id });

  // 房主补一个 AI 玩家
  send(wa, { type: 'add_ai' });
  const ai = room.players.find((x) => x && x.isAI);
  assert.ok(ai, 'AI 玩家应已加入');

  // 丙只在大厅，不在房间
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '丙' });

  return { srv, room, wa, wb, wc, idA: helloId(wa), idB: helloId(wb), idC: helloId(wc), aiId: ai.id };
}

test('voice_signal：同房间真人目标收到转发（含 from/fromName/fromSeat/sig 原样）', () => {
  const { srv, wa, wb, idA, idB } = setupScenario();
  const sig = { kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5678 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
  send(wa, { type: 'voice_signal', target: idB, sig });

  const relayed = lastOf(wb, 'voice_signal');
  assert.ok(relayed, '乙应收到转发信令');
  assert.equal(relayed.from, idA);
  assert.equal(relayed.fromName, '甲');
  assert.equal(typeof relayed.fromSeat, 'number');
  assert.deepEqual(relayed.sig, sig);
  // 发起者不应收到错误提示
  assert.equal(countOf(wa, 'error'), 0, '正常转发不应产生错误');
  cleanupServer(srv);
});

test('voice_signal：目标为 AI 时静默忽略（不发错误）', () => {
  const { srv, wa, wb, aiId } = setupScenario();
  send(wa, { type: 'voice_signal', target: aiId, sig: { kind: 'offer', sdp: { type: 'offer', sdp: 'x' } } });

  // AI 无 ws，无从接收；关键验证：无任何错误下发、其他真人未收到无关信令
  assert.equal(countOf(wa, 'error'), 0, '目标为 AI 不应返回错误');
  assert.equal(countOf(wb, 'voice_signal'), 0, '乙不应收到发给 AI 的信令');
  cleanupServer(srv);
});

test('voice_signal：目标不在房间时静默忽略（不发错误）', () => {
  const { srv, wa, wb, idC } = setupScenario();
  send(wa, { type: 'voice_signal', target: idC, sig: { kind: 'ice', candidate: {} } });

  assert.equal(countOf(wa, 'error'), 0, '目标不在房间不应返回错误');
  assert.equal(countOf(wb, 'voice_signal'), 0, '乙不应收到无关信令');
  cleanupServer(srv);
});

test('voice_signal：sig 超限（>64KB）拒绝转发', () => {
  const { srv, wa, wb, idB } = setupScenario();
  const big = { kind: 'ice', candidate: { candidate: 'x'.repeat(64 * 1024) } };
  send(wa, { type: 'voice_signal', target: idB, sig: big });

  assert.equal(countOf(wb, 'voice_signal'), 0, '超限信令不应转发');
  assert.equal(countOf(wa, 'error'), 0, '超限拒绝应静默，不返回错误');
  cleanupServer(srv);
});

test('voice_signal：未加入房间的玩家发送时静默忽略', () => {
  const { srv, wc, idB } = setupScenario();
  send(wc, { type: 'voice_signal', target: idB, sig: { kind: 'ice', candidate: {} } });

  assert.equal(countOf(wc, 'error'), 0, '不在房间的发起者不应收到错误');
  cleanupServer(srv);
});
