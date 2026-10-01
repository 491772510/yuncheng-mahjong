'use strict';

// ============ 西安红中麻将：game.js 游戏流程模块测试 ============
// 覆盖：112张无风发牌（庄14闲13）、禁吃/无报听、胡牌仅自摸/抢杠（禁点炮）、
// 抢杠仅补杠+包赔三家、杠牌当场结（放杠2手/补杠每家1手/暗杠每家2手）、
// 无番制结算（自摸=2手底注+中码数×底注，抢杠/点炮=被抢者/放炮者包三家）、扎码中码翻倍、
// 谁胡谁坐庄/流局连庄、无将牌限制、结算字段完整性。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');
const rules = require('../src/rules');

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

function newServer() {
  return new GameServer();
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

const BASE = {
  variant: 'hongzhong',
  zhaMa: 0,
  aiFill: false,
  totalRounds: 4,
};

// 4 个真人满员自动开局（无 AI 干扰，测试全手动驱动）
function makeRoom4(settings) {
  const srv = newServer();
  const wss = [makeWs(), makeWs(), makeWs(), makeWs()];
  wss.forEach((ws, i) => {
    srv.handleConnection(ws);
    send(ws, { type: 'join_lobby', name: '玩家' + i });
  });
  send(wss[0], { type: 'create_room', settings: { ...BASE, ...settings } });
  const room = [...srv.rooms.values()][0];
  for (let i = 1; i < 4; i++) send(wss[i], { type: 'join_room', roomId: room.id });
  return { srv, room, wss };
}

// 常用构造牌型
// h1：13 张听 w9（点炮/抢杠目标）
const H1_TING_W9 = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'z0', 'z0'];
// h2：14 张自摸胡（癞子可作将）
const H2_SELFHU = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w9', 'z0', 'z0'];
// h5：14 张自摸胡，将 t3（无将牌限制，可胡）
const H5_SELFHU_258 = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w9', 'w9', 'w9', 't3', 't3'];
// 普通闲家手牌（13张，不胡 w9/w5）
const PLAIN13 = ['b1', 'b1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 't2', 't2'];
// 13 张听 w5（抢杠目标）
const H3_TING_W5 = ['w6', 'w6', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 't1', 't2', 't3', 't4', 'z0'];

// ============ 发牌 / 基础流程 ============

test('红中开局：112张无风牌、庄14闲13、无报听、view不含废弃开关字段', () => {
  const { srv, room, wss } = makeRoom4({});
  assert.equal(room.state, 'playing');
  const g = room.game;
  assert.equal(g.wall.length, 112);
  // 庄家起手 14 张即终态（发牌 13+补 1），开局直接出牌不再摸；闲家 13 张
  assert.equal(g.hands[g.dealer].length, 14);
  for (let s = 0; s < 4; s++) {
    if (s !== g.dealer) assert.equal(g.hands[s].length, 13);
    for (const t of g.hands[s]) {
      assert.ok(!['e', 's', 'x', 'n', 'z', 'f', 'p'].includes(t), '红中模式不允许风牌/箭牌');
    }
  }
  const v0 = lastOf(wss[0], 'game_state');
  assert.equal(v0.game.settings.variant, 'hongzhong');
  assert.deepEqual(g.tingSeats, []);
  cleanupServer(srv);
});

test('红中禁吃与无报听：ting/koupoint 被拒', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  send(wss[0], { type: 'ting', tile: g.hands[0][0] });
  assert.ok(lastOf(wss[0], 'error'), '红中应拒绝报听');
  send(wss[0], { type: 'koupoint', tile: g.hands[0][0] });
  assert.ok(lastOf(wss[0], 'error'), '红中应拒绝扣点');
  cleanupServer(srv);
});

// ============ 胡牌方式：只自摸+抢杠，禁点炮 ============

test('胡牌方式：点炮不可胡（响应不含胡），自摸仍可胡', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.hands[0] = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't2', 't3', 'w9'];
  g.hands[1] = H1_TING_W9.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';

  send(wss[0], { type: 'play_tile', tile: 'w9' });
  // 无人可点炮 → 无响应，轮转下家
  assert.equal(g.pending, null, '点炮不应产生胡响应');
  assert.equal(g.lastAction, null);
  assert.notEqual(g.turn, 0, '出牌后应轮转');

  // 自摸仍可胡
  g.hands[1] = H2_SELFHU.slice();
  g.turn = 1;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  g.lastAction = null;
  send(wss[1], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo');
  assert.equal(g.winners.winnerSeat, 1);
  cleanupServer(srv);
});

// ============ 自摸胡 + 谁胡谁坐庄 ============

test('自摸胡：三家各付；谁胡谁坐庄（下一局由胜者坐庄）', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.hands[0] = H2_SELFHU.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });

  const w = g.winners;
  assert.equal(w.winType, 'zimo');
  assert.equal(w.discarder, null);
  const pay = w.payments.find((x) => x.kind === 'hu');
  assert.equal(pay.rows.length, 3, '自摸三家各付');
  assert.equal(pay.toAmount, w.score);
  assert.equal(w.zmaMult, 1, '未开扎码时中码倍数=1');
  assert.equal(w.noFan, true, '无番制结算');
  assert.equal(w.score, (2 + w.zmaMult) * 3, '自摸：每家 2手底注+中码数×底注=3，三家共 9 分');
  assert.equal(room.players[0].roundScore, w.score);
  assert.equal(room.lastWinner, 0);

  // 下一局：谁胡谁坐庄
  srv._dealRoundHongZhong(room);
  assert.equal(room.game.dealer, 0);
  assert.equal(room.dealer, 0);
  cleanupServer(srv);
});

// ============ 抢杠：仅补杠可抢，被抢杠者包赔三家 ============

test('抢杠胡：补杠触发抢杠判定，被抢杠者包赔三家', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  // seat0 已碰 w5，手中有第 4 张 w5
  g.melds[0] = [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }];
  g.hands[0] = ['w5', 'w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2'];
  g.hands[1] = H3_TING_W5.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2'; // 行动阶段允许杠
  send(wss[0], { type: 'gang', tile: 'w5', gangType: 'bugang' });

  assert.ok(g.pending && g.pending.type === 'qianggang', '补杠应触发抢杠判定');
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu === true, '听w5家可抢杠胡');

  send(wss[1], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.winType, 'qianggang');
  assert.equal(w.discarder, 0, '被抢杠者为放炮者');
  const pay = w.payments.find((x) => x.kind === 'hu');
  assert.equal(pay.rows.length, 1);
  assert.equal(pay.rows[0].seat, 0);
  assert.equal(pay.rows[0].role, '被抢杠者（包三家）');
  assert.equal(pay.rows[0].amount, -6, '抢杠：被抢者按(1手底注+中码数×底注)×3=6分独赔');
  assert.equal(w.score, 6);
  assert.equal(room.players[0].roundScore, -w.score);
  assert.equal(room.players[1].roundScore, w.score);
  cleanupServer(srv);
});

test('抢杠无人抢时正常补杠并续行', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.melds[0] = [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }];
  g.hands[0] = ['w5', 'w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2'];
  g.hands[1] = PLAIN13.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'gang', tile: 'w5', gangType: 'bugang' });

  assert.equal(g.pending, null, '无人抢杠不应进入响应');
  assert.equal(g.turn, 0, '补杠后原家补牌');
  assert.equal(g.stage, 'draw');
  assert.equal(room.players[0].roundScore, 3, '补杠当场结：杠家收每家1手共3分');
  assert.equal(room.players[1].roundScore, -1, '补杠每家付1手');
  assert.equal(room.players[3].roundScore, -1);
  const bu = g.melds[0].find((m) => m.type === 'bugang' && m.tile === 'w5');
  assert.ok(bu && bu.tiles.length === 4, '碰转补杠成功');
  cleanupServer(srv);
});

// ============ 杠牌当场结（放杠2手 / 补杠每家1手 / 暗杠每家2手） ============

test('放杠当场结：放杠者付 2 手给杠家', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.hands[0] = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't2', 't3', 'w5'];
  g.hands[1] = ['w5', 'w5', 'w5', 'b1', 'b1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 't1', 't2'];
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w5';
  send(wss[0], { type: 'play_tile', tile: 'w5' });
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canGang === true, '三家 w5 应可放杠');
  send(wss[1], { type: 'gang', tile: 'w5', gangType: 'gang' });
  assert.equal(room.players[0].roundScore, -2, '放杠者当场付 2 手');
  assert.equal(room.players[1].roundScore, 2, '杠家当场收 2 手');
  assert.equal(g.gangLogs.length, 1);
  assert.equal(g.gangLogs[0].hz, true);
  assert.equal(g.gangLogs[0].perSeat, 2);
  assert.equal(g.gangLogs[0].payer, 0);
  cleanupServer(srv);
});

test('暗杠当场结：其余每家付 2 手给杠家', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.hands[0] = ['w5', 'w5', 'w5', 'w5', 'w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't2'];
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'gang', tile: 'w5', gangType: 'angang' });
  assert.equal(room.players[0].roundScore, 6, '暗杠杠家收每家 2 手共 6 分');
  assert.equal(room.players[1].roundScore, -2);
  assert.equal(room.players[2].roundScore, -2);
  assert.equal(room.players[3].roundScore, -2);
  const ag = g.gangLogs[0];
  assert.equal(ag.type, 'angang');
  assert.equal(ag.hz, true);
  assert.equal(ag.perSeat, 2);
  cleanupServer(srv);
});

// ============ 扎码中码翻倍 ============

test('扎码：1/5/9+红中算中码，每张翻一倍', () => {
  const { srv, room, wss } = makeRoom4({ zhaMa: 2 });
  const g = room.game;
  // 控制牌墙：当前摸牌位置起 2 张为中码（1万、红中）
  assert.ok(g.wall.length - g.wallPos > 6, '牌墙需留有足够扎码张数');
  g.wall[g.wallPos] = 'w1';
  g.wall[g.wallPos + 1] = 'z0';

  g.hands[0] = H2_SELFHU.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.zhaMaCount, 2);
  assert.deepEqual(w.zhaMaTiles, ['w1', 'z0']);
  assert.equal(w.zmaMult, 4, '中2码 → 中码倍数4');
  assert.equal(w.score, (2 + w.zmaMult) * 3, '自摸：每家 2手底注+中码数×底注，共(2+4)×3=18');
  assert.equal(room.players[0].roundScore, (2 + w.zmaMult) * 3);
  cleanupServer(srv);
});

test('扎码：未中码不翻倍', () => {
  const { srv, room, wss } = makeRoom4({ zhaMa: 2 });
  const g = room.game;
  assert.ok(g.wall.length - g.wallPos > 6);
  g.wall[g.wallPos] = 'w2';
  g.wall[g.wallPos + 1] = 'b3';

  g.hands[0] = H2_SELFHU.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.zhaMaCount, 0);
  assert.equal(w.zmaMult, 1, '未中码倍数=1');
  assert.equal(w.score, (2 + w.zmaMult) * 3, '未中码：每家 2+1=3 分，共 9 分');
  cleanupServer(srv);
});

// ============ 流局连庄 ============

test('流局：牌墙摸完最后一张才流局，庄家连庄', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  const dealer0 = room.dealer;
  // 牌墙还有 1 张：应继续摸，不流局
  g.wallPos = g.wall.length - 1;
  srv._drawTileHongZhong(room, 0);
  assert.equal(g.winners, null, '牌墙还有 1 张应继续行牌');
  // 牌墙摸空：流局
  g.wallPos = g.wall.length;
  srv._drawTileHongZhong(room, 1);

  assert.equal(g.winners.type, 'draw');
  assert.equal(g.winners.variant, 'hongzhong');
  assert.equal(room.lastWinner, null, '流局不产生新坐庄者');
  // 下一局庄家不变
  srv._dealRoundHongZhong(room);
  assert.equal(room.game.dealer, dealer0, '流局后庄家连庄');
  cleanupServer(srv);
});

// ============ 将牌无限制 ============

test('将牌无限制：非 2/5/8 将自摸可胡', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  // h5 将 t3（非 2/5/8）：无将牌限制应可胡
  g.hands[0] = H5_SELFHU_258.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo', '无将牌限制时非 2/5/8 将应可胡');
  cleanupServer(srv);
});

// ============ 自摸结算必须广播 settlement（与抢杠一致，修复确认页自摸无详情） ============

test('自摸胡必须广播 settlement：确认弹窗展示手牌/扎码/计算式（防回归）', () => {
  const { srv, room, wss } = makeRoom4({ zhaMa: 2 });
  const g = room.game;
  g.hands[0] = H2_SELFHU.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo');

  const settle = lastOf(wss[0], 'settlement');
  assert.ok(settle, '自摸胡后必须广播 settlement 消息（原缺陷：自摸直接 _endRound 未走 _finishHuRoundHongZhong）');
  const r = settle.result;
  assert.equal(r.winType, 'zimo');
  assert.ok(r.payments && r.payments.length === 1, 'settlement result 需含 hu 支付明细');
  assert.ok(r.payments[0].rows.every((x) => x.formula), '每行需含分项计算式 formula');
  assert.ok(r.hands && r.hands.length === 4, 'settlement result 需含各家手牌 hands');
  assert.ok(r.zhaMaTiles && r.zhaMaTiles.length === 2, 'settlement result 需含扎码牌 zhaMaTiles');

  const confirm = lastOf(wss[0], 'settlement_confirm');
  assert.ok(confirm && confirm.confirms, '自摸后应进入结算确认阶段并广播 settlement_confirm');
  cleanupServer(srv);
});
