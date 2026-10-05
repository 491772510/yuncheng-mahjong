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
  const srv = new GameServer({ gameLog: false });
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { aiFill: true, totalRounds: 4, allowTing: true } });
  const room = [...srv.rooms.values()][0];
  const all = srv._hzTileTypes(room);
  for (const h of HONOR_TILES) assert.ok(all.includes(h), `扣点点牌型应包含 ${h}`);
  assert.equal(all.length, rules.getTileTypes().length);
  cleanupServer(srv);
});

test('红中：_hzTileTypes 仍返回红中专用牌型（不含字牌）', () => {
  const srv = new GameServer({ gameLog: false });
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '红中房主' });
  send(wa, { type: 'create_room', settings: { aiFill: true, totalRounds: 4, variant: 'hongzhong' } });
  const room = [...srv.rooms.values()][0];
  const hzTypes = srv._hzTileTypes(room);
  assert.ok(!hzTypes.includes('e'), '红中牌型不应包含字牌');
  assert.equal(hzTypes.length, rules.getHongZhongTileTypes().length);
  cleanupServer(srv);
});

function makeKoudianGame() {
  const srv = new GameServer({ gameLog: false });
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  srv.handleConnection(wb);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { aiFill: true, totalRounds: 4, allowTing: true } });
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

// ============ 报听玩家杠后补牌低点胡 / AI 代打卡死回归测试 ============
// Bug 背景：报听玩家杠后补牌若构成 1/2 点低点胡（不能自摸），_drawAfterGang
// 旧逻辑仅判 checkHu 就进入行动阶段；AI decideDrawAction 自摸胡检查因点数
// 不足跳过，最终落回 {type:'play'} 被 _playTile 以"听口状态由系统自动摸打"
// 拒绝，快照不变，重试 3 次后打印 'AI stuck at seat X after 3 retries' 卡死。
// 修复：_drawAfterGang 报听分支对齐 _drawTile 补 canHuByPoints 校验；并在
// _scheduleAutoAct 增加报听兜底（可胡才给胡/过，否则摸打，绝不 AI 出牌）。

const TING_DRAW_HAND = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 'e', 'e']; // 摸 w1 成胡

test('扣点点：报听玩家摸到低点胡（1点不能自摸）→ AI 兜底摸牌即打不卡死', async () => {
  const { srv, room } = makeKoudianGame();
  const g = room.game;
  const seat = room.players.findIndex((p) => p && p.name === '房主');
  assert.ok(seat >= 0);

  room.timers.clear();
  room.players[seat].isAI = true; // 模拟 AI / 托管触发 _scheduleAutoAct
  g.tingSeats = [seat];
  g.stage = 'draw';
  g.turn = seat;
  g.drawnTile = 'w1';
  g.lastAction = null;
  g.hands[seat] = TING_DRAW_HAND.slice();
  g.melds[seat] = [];
  g.discards[seat] = [];
  g.newTiles[seat] = 'w1';

  assert.ok(rules.checkHu(g.hands[seat], g.melds[seat]), '前置：手牌构成胡');
  assert.equal(rules.canHuByPoints(rules.tilePoints('w1'), 'zimo'), false, '前置：w1 为低点胡不能自摸');

  srv._scheduleAutoAct(room, seat);
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(g.discards[seat].includes('w1'), '刚摸的 w1 应被打出');
  assert.equal(g.hands[seat].length, TING_DRAW_HAND.length - 1, '摸打后手牌应减少 1 张');
  assert.ok(g.tingSeats.includes(seat), '报听状态应保持');
  cleanupServer(srv);
});

test('扣点点：报听玩家杠后补牌低点胡 → _drawAfterGang 直接摸打不进入行动阶段', () => {
  const { srv, room } = makeKoudianGame();
  const g = room.game;
  const seat = room.players.findIndex((p) => p && p.name === '房主');
  assert.ok(seat >= 0);

  room.timers.clear();
  room.players[seat].isAI = true;
  g.tingSeats = [seat];
  g.stage = 'draw';
  g.turn = seat;
  g.lastAction = { type: 'gang' };
  g.hands[seat] = ['w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 'e', 'e']; // 13张，补 w1 成胡
  g.melds[seat] = [];
  g.discards[seat] = [];
  g.newTiles[seat] = null;
  g.wallPos = 30; // 牌墙中段，剩余 >12 张不会误触发流局
  g.wall[30] = 'w1';

  srv._drawCard(room, seat, true);

  assert.ok(g.discards[seat].includes('w1'), '补到的 w1 应直接打出');
  assert.equal(g.hands[seat].length, 13, '13 张手牌 + 补 1 打 1 应仍为 13 张');
  cleanupServer(srv);
});
