'use strict';

// ============ 西安红中麻将：game.js 游戏流程模块测试 ============
// 覆盖：112张无风发牌（庄14闲13）、禁吃/无报听、胡牌模式A/B、抢杠仅补杠+包赔三家、
// 一炮多响、下炮子独立计分、扎码中码翻倍、谁胡谁坐庄/流局连庄、need258Eye 开关、结算字段完整性。
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
  huMode: 'A',
  need258Eye: false,
  enablePaozi: false,
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
// h2：14 张自摸胡（癞子可作将，need258 两模式均可）
const H2_SELFHU = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w9', 'z0', 'z0'];
// h5：14 张自摸胡，将 t3 非二五八（need258Eye:true 时不可胡）
const H5_SELFHU_258 = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w9', 'w9', 'w9', 't3', 't3'];
// 普通闲家手牌（13张，不胡 w9/w5）
const PLAIN13 = ['b1', 'b1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 't2', 't2'];
// 13 张听 w5（抢杠目标）
const H3_TING_W5 = ['w6', 'w6', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 't1', 't2', 't3', 't4', 'z0'];

// ============ 发牌 / 基础流程 ============

test('红中开局：112张无风牌、庄14闲13、无报听、view透传variant与paozi', () => {
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
  assert.deepEqual(v0.game.paozi, [0, 0, 0, 0]);
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

// ============ 胡牌模式 A：点炮胡 ============

test('模式A点炮胡：放炮者包赔三家，结算字段完整', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  // 固定操作座位
  g.hands[0] = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't2', 't3', 'w9'];
  g.hands[1] = H1_TING_W9.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';

  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.ok(g.pending && g.pending.type === 'discard');
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu === true, '模式A下听牌家应可点炮胡');
  assert.ok(!g.pending.responders.some((r) => r.canHu && r.seat !== 1), '闲家不应误判胡');

  send(wss[1], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.type, 'hu');
  assert.equal(w.variant, 'hongzhong');
  assert.equal(w.winnerSeat, 1);
  assert.equal(w.winType, 'dianpao');
  assert.equal(w.discarder, 0);
  assert.ok(w.totalFan >= 1 && w.mult >= 2 && Array.isArray(w.fanNames));
  assert.deepEqual(w.paozi, [0, 0, 0, 0]);
  assert.equal(w.zhaMaCount, 0);
  const pay = w.payments.find((x) => x.kind === 'hu');
  assert.equal(pay.rows.length, 1, '点炮仅放炮者支付');
  assert.equal(pay.rows[0].seat, 0);
  assert.equal(pay.toAmount, w.score);
  assert.equal(room.players[0].roundScore, -w.score);
  assert.equal(room.players[1].roundScore, w.score);
  assert.equal(room.lastWinner, 1, '胡牌者应记为坐庄候选人');
  cleanupServer(srv);
});

// ============ 胡牌模式 B：只自摸+抢杠，禁点炮 ============

test('模式B：点炮不可胡（响应不含胡），自摸仍可胡', () => {
  const { srv, room, wss } = makeRoom4({ huMode: 'B' });
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
  // 模式B：无人可点炮 → 无响应，轮转下家
  assert.equal(g.pending, null, '模式B点炮不应产生胡响应');
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
  assert.equal(w.score, w.mult * 3, '无炮子无中码时 score = mult×3');
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
  const bu = g.melds[0].find((m) => m.type === 'bugang' && m.tile === 'w5');
  assert.ok(bu && bu.tiles.length === 4, '碰转补杠成功');
  cleanupServer(srv);
});

// ============ 一炮多响 ============

test('一炮多响：多家同时胡，放炮者包赔各胡家', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.hands[0] = ['w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't2', 't3', 'w9'];
  g.hands[1] = H1_TING_W9.slice();
  g.hands[2] = H1_TING_W9.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'play_tile', tile: 'w9' });

  const huSeats = g.pending.responders.filter((r) => r.canHu).map((r) => r.seat);
  assert.deepEqual(huSeats.sort(), [1, 2], '两家同时听w9应都可胡');

  send(wss[1], { type: 'hu' });
  send(wss[2], { type: 'hu' });
  assert.equal(g.hzWinners.length, 2, '一炮多响应有两条赢家记录');
  const w = g.winners;
  assert.equal(w.winners.length, 2);
  assert.equal(w.winType, 'dianpao');
  const huPays = w.payments.filter((x) => x.kind === 'hu');
  assert.equal(huPays.length, 2, '每个胡家一条支付记录');
  for (const pay of huPays) {
    assert.equal(pay.rows.length, 1);
    assert.equal(pay.rows[0].seat, 0);
  }
  // 放炮者共赔两家各一份
  assert.equal(room.players[0].roundScore, -(w.winners[0].scorePer * 3 + w.winners[1].scorePer * 3));
  assert.equal(room.players[1].roundScore, w.winners[0].scorePer * 3);
  assert.equal(room.players[2].roundScore, w.winners[1].scorePer * 3);
  cleanupServer(srv);
});

// ============ 下炮子独立计分 ============

test('下炮子：开局先选炮子（0/1），结算每炮+1分', () => {
  const { srv, room, wss } = makeRoom4({ enablePaozi: true });
  const g = room.game;
  assert.equal(g.stage, 'paozi', '开局应先进入下炮子阶段');
  // 3 家下 1 炮、1 家下 0 炮
  for (let i = 0; i < 3; i++) send(wss[i], { type: 'paozi', value: 1 });
  send(wss[3], { type: 'paozi', value: 0 });
  assert.equal(g.stage, 'draw', '全部选完炮子后开始行牌');
  assert.deepEqual(g.paozi, [1, 1, 1, 0]);

  // 构造庄家自摸：胡分 = mult×3 = 48；炮钱独立 = 胡家下炮三家各 1 分 + 输家(1/2座)下炮各 1 分 + (3座未下炮仅付胡家份) = 2+2+1 = 5 → score = 53
  g.hands[0] = H2_SELFHU.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.deepEqual(w.paozi, [1, 1, 1, 0]);
  assert.equal(w.mult, 16);
  assert.equal(w.score, 16 * 3 + 5, '炮子独立计分：胡分 mult×3，炮钱单列 5 分');
  assert.equal(room.players[0].roundScore, 16 * 3 + 5);
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
  assert.equal(w.score, w.mult * 3 * 4, '中2码 → 4倍翻倍');
  assert.equal(room.players[0].roundScore, w.mult * 3 * 4);
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
  assert.equal(w.score, w.mult * 3, '未中码不翻倍');
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

// ============ need258Eye 开关 ============

test('need258Eye 开关：开启后非二五八将不可胡', () => {
  const { srv, room, wss } = makeRoom4({ need258Eye: true });
  const g = room.game;
  // h5 将 t3 非二五八：开启时应拒绝自摸
  g.hands[0] = H5_SELFHU_258.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'hu' });
  assert.ok(lastOf(wss[0], 'error'), 'need258Eye开启时非二五八将应拒绝胡牌');
  cleanupServer(srv);
});

test('need258Eye 关闭：非二五八将可胡', () => {
  const { srv, room, wss } = makeRoom4({ need258Eye: false });
  const g = room.game;
  g.hands[0] = H5_SELFHU_258.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo', 'need258Eye关闭时应可胡');
  cleanupServer(srv);
});
