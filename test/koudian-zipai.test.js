'use strict';

// ============ 扣点点字牌出牌/杠牌回归测试 ============
// Bug 背景：_playTile 与 _gang 行动阶段用 _hzTileTypes 校验牌型，
// 该函数恒返回红中专用牌型（万筒条+红中，不含字牌），而扣点点牌墙为
// 136 张含字牌（东南西北中发白，代码 e/s/x/n/z/f/p）。AI/真人打出或
// 杠字牌时被服务端硬校验拒绝 '非法的牌'，牌局快照不变，
// _scheduleAutoAct 重试 3 次耗尽后打印 'AI stuck at seat X after 3 retries'
// 并卡死。
// 修复：_hzTileTypes 按玩法分流，非红中房间返回全量 136 张牌型。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');
const rules = require('../src/rules');

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

const HONOR_TILES = ['e', 's', 'x', 'n', 'z', 'f', 'p'];

test('扣点点：_hzTileTypes 返回全量 136 张（含字牌）', () => {
  const srv = new GameServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { enableKoupoint: true, aiFill: true, totalRounds: 4, allowTing: true } });
  const room = [...srv.rooms.values()][0];
  const all = srv._hzTileTypes(room);
  for (const h of HONOR_TILES) assert.ok(all.includes(h), `扣点点牌型应包含 ${h}`);
  assert.equal(all.length, rules.getTileTypes().length);
  cleanupServer(srv);
});

test('红中：_hzTileTypes 仍返回红中专用牌型（不含字牌）', () => {
  const srv = new GameServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '红中房主' });
  send(wa, { type: 'create_room', settings: { enableKoupoint: false, aiFill: true, totalRounds: 4, variant: 'hongzhong' } });
  const room = [...srv.rooms.values()][0];
  const hzTypes = srv._hzTileTypes(room);
  assert.ok(!hzTypes.includes('e'), '红中牌型不应包含字牌');
  assert.equal(hzTypes.length, rules.getHongZhongTileTypes().length);
  cleanupServer(srv);
});

function makeKoudianGame() {
  const srv = new GameServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  srv.handleConnection(wb);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { enableKoupoint: true, aiFill: true, totalRounds: 4, allowTing: true } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  return { srv, room, wa };
}

test('扣点点：打出字牌不被服务端拒绝（原 非法的牌 拒绝点已修复）', () => {
  const { srv, room, wa } = makeKoudianGame();
  const g = room.game;
  const seat = room.players.findIndex((p) => p && p.name === '房主');
  assert.ok(seat >= 0, '应找到房主座位');

  room.timers.clear();
  g.stage = 'draw';
  g.turn = seat;
  g.drawnTile = 'w1';
  g.tingSeats = [];
  g.lastAction = null;
  g.hands[seat] = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 'e'];
  g.newTiles[seat] = 'w1';

  const pl = room.players[seat];
  srv._playTile(pl, { tile: 'e' });

  assert.ok(g.discards[seat].includes('e'), '字牌应成功打出进入废牌堆');
  assert.equal(g.hands[seat].includes('e'), false, '手牌中的字牌应已移除');
  const gs = lastOf(wa, 'game_state');
  assert.ok(gs, '打出字牌后应有 game_state 下发');
  cleanupServer(srv);
});

test('扣点点：行动阶段暗杠字牌不被服务端拒绝', () => {
  const { srv, room, wa } = makeKoudianGame();
  const g = room.game;
  const seat = room.players.findIndex((p) => p && p.name === '房主');
  assert.ok(seat >= 0);

  room.timers.clear();
  g.stage = 'draw';
  g.turn = seat;
  g.drawnTile = 'e';
  g.tingSeats = [];
  g.lastAction = null;
  g.hands[seat] = ['e', 'e', 'e', 'e', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't1', 't2', 't3'];
  g.newTiles[seat] = 'e';

  const pl = room.players[seat];
  srv._gang(pl, { tile: 'e', gangType: 'angang' });

  assert.ok(g.melds[seat].some((m) => m.type === 'angang' && m.tile === 'e'), '字牌暗杠应成功入明牌区');
  const gs = lastOf(wa, 'game_state');
  assert.ok(gs, '暗杠字牌后应有 game_state 下发');
  cleanupServer(srv);
});
