'use strict';

// ============ 运城贴金麻将：game.js 游戏流程模块测试 ============
// 覆盖：136张开局翻金母定金牌（庄14闲13）、上金后才能点炮胡（未上金只能自摸）、
// 锁金开关（锁金/解锁/被锁只能自摸）、上金/锁金动作与轮转、三金封顶、
// 计分A（自摸/点炮/金分3倍递增/点炮通赔）、计分B（125体系/庄家身份×2）、
// 截胡单响（逆时针最近）、过胡限制、抢杠（补杠可抢/暗杠不可抢）、
// 字牌整副胡只能自摸（金牌不代）、流局双开关（A摸完/B硬10墩）、流局杠分不计、
// 结算字段完整性（金母/金牌/上金数/金分/分项计算式/锁金状态）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');
const rules = require('../src/rules');

// ---------- 测试工具（与 game-hongzhong.test.js 同构） ----------
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
  variant: 'tiejin',
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

// ---------- 常用构造牌型（goldTile 统一固定为 w5，翻5→5，合法） ----------

// h1：13 张听 w9（点炮/抢杠目标；不含金牌）
const TING_W9_13 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2'];
// h2：14 张自摸胡 w9（摸到 w9 自摸）
const SELFHU_W9_14 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 't1', 't2', 't2'];
// h3：13 张听 w9，含 1 张金牌 w5（万能）：w1w2w3 / w4w5w6 / w7w8+金(当w9) / t1t1t1 / t2t2
const TING_W9_GOLD_13 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w5', 't1', 't1', 't1', 't2'];
// h4：14 张全字牌自摸胡：e/s/x/z 各3 + n 将2
const ALL_HONOR_SELFHU = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'z', 'z', 'z', 'n', 'n'];
// h5：13 张全字牌听 n（点炮目标：全字牌只能自摸，响应应无 hu）
const ALL_HONOR_TING_N_13 = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'z', 'z', 'z', 'n'];
// 普通闲家手牌（13张，不胡 w9/w5）
const PLAIN13 = ['b1', 'b1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 't2', 't2'];

// ============ 发牌 / 金牌确定 ============

test('贴金开局：136张、庄14闲13、翻金母定金牌、view含金牌/上金区/锁金字段', () => {
  const { srv, room, wss } = makeRoom4({});
  assert.equal(room.state, 'playing');
  const g = room.game;
  // 136 张洗牌，金母从牌墙翻出（墙剩 135）
  assert.equal(g.wall.length, 135);
  assert.ok(g.goldMother, '应有金母');
  assert.equal(g.goldTile, rules.goldFromMother(g.goldMother), '金牌由金母按对牌关系确定');
  assert.equal(g.hands[g.dealer].length, 14, '庄家 14 张');
  for (let s = 0; s < 4; s++) {
    if (s !== g.dealer) assert.equal(g.hands[s].length, 13, '闲家 13 张');
  }
  // 无报听
  assert.deepEqual(g.tingSeats, []);
  // view 展示字段
  const v0 = lastOf(wss[0], 'game_state');
  assert.equal(v0.game.settings.variant, 'tiejin');
  assert.equal(v0.game.settings.lockGold, true, '锁金开关默认开启');
  assert.equal(v0.game.settings.drawEndMode, 'A', '流局开关默认 A（摸完）');
  assert.equal(v0.game.settings.scoreMode, 'A', '计分开关默认 A（边趣版）');
  assert.equal(v0.game.goldTile, g.goldTile);
  assert.deepEqual(v0.game.shangjinCount, [0, 0, 0, 0]);
  assert.deepEqual(v0.game.locked, [false, false, false, false]);
  cleanupServer(srv);
});

// ============ 上金后才能点炮胡 / 未上金只能自摸 ============

test('点炮胡资格：未上金不能点炮（无胡响应），上过金才能点炮', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice(); // 未上金
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';

  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.equal(g.pending, null, '未上金：点炮不应产生胡响应（仅可碰杠，无碰杠则轮转）');
  assert.notEqual(g.turn, 0, '出牌后应轮转');

  // 上金后：可点炮胡（重置 13 张听口——此前 seat1 已摸过一张；seat0 重置为含 w9 手牌）
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  g.lastAction = null;
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice();
  g.melds[1] = [];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.ok(g.pending, '上金后可产生点炮胡响应');
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu === true, '上金后听 w9 家可点炮胡');
  cleanupServer(srv);
});

test('未上金只能自摸：自摸胡不受上金限制', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo', '未上金也应可自摸胡');
  cleanupServer(srv);
});

// ============ 上金 / 锁金动作与状态机 ============

test('上金动作：打出 1 张金牌入上金区、计数+1、轮转下家', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  // 14 张（摸牌后）含 2 张金牌 w5（1 真 1 金同码），上金打出 1 张后仍剩 13 张
  g.hands[0] = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w5', 't1', 't1', 't1', 't2', 't2'];
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  g.lastAction = null;
  g.shangjinCount = [0, 0, 0, 0];
  g.shangjinTiles = [[], [], [], []];

  send(wss[0], { type: 'shangjin' });
  assert.equal(g.shangjinCount[0], 1, '上金计数+1');
  assert.deepEqual(g.shangjinTiles[0], ['w5'], '上金区展示打出的金牌');
  assert.equal(g.hands[0].length, 13, '上金打出一张后手牌 13 张');
  assert.equal(g.turn, 1, '上金后轮转下家摸牌');
  assert.equal(g.stage, 'draw', '轮转后下家摸牌阶段');
  cleanupServer(srv);
});

test('锁金动作（开启锁金）：打出 2 张金牌、锁定其他三家、锁定者计数+2', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  // 14 张含 2 张金牌 w5
  g.hands[0] = ['w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2', 'w5', 'w5'];
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w5';
  g.lastAction = null;

  send(wss[0], { type: 'lock' });
  assert.equal(g.shangjinCount[0], 2, '锁金打出的 2 张金牌计入上金数');
  assert.deepEqual(g.shangjinTiles[0], ['w5', 'w5']);
  assert.deepEqual(g.locked, [false, true, true, true], '锁定其他三家（本家不受锁）');
  assert.equal(g.lockSeat, 0);
  assert.equal(g.hands[0].length, 12, '锁金打出 2 张后手牌 12 张');
  assert.notEqual(g.turn, 0, '锁金后轮转下家');
  cleanupServer(srv);
});

test('锁金关闭：lock 动作被拒；被锁者打出最后金牌可解锁', () => {
  const { srv, room, wss } = makeRoom4({ lockGold: false });
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2', 'w5', 'w5'];
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w5';
  send(wss[0], { type: 'lock' });
  assert.ok(lastOf(wss[0], 'error'), '关闭锁金时应拒绝 lock');
  assert.equal(g.shangjinCount[0], 0, '拒绝锁金不改变上金数');
  cleanupServer(srv);
});

test('被锁者只能自摸：锁金开启且被锁时点炮无胡响应；解锁后可点炮', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_GOLD_13.slice(); // 已上过金（设置），但被锁
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.locked = [false, true, false, false]; // seat1 被锁
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';

  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.equal(g.pending, null, '被锁者（已上金）也不能点炮胡');

  // 解锁：被锁者打出最后一张金牌（普通弃牌路径；13 张仅 1 张金牌）
  g.turn = 1;
  g.stage = 'draw';
  g.drawnTile = 'w5';
  g.lastAction = null;
  g.locked[1] = true;
  g.hands[1] = ['w1', 'w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2', 'w5'];
  send(wss[1], { type: 'play_tile', tile: 'w5' });
  assert.equal(g.locked[1], false, '被锁者打出最后一张金牌后解锁');
  // 解锁后可点炮
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  g.lastAction = null;
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice(); // 解锁后 13 张听 w9（无金牌）
  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.ok(g.pending, '解锁后可点炮胡');
  cleanupServer(srv);
});

// ============ 三金封顶 ============

test('三金封顶：上金数超过 3 按 3 金计（计分 A：G=9）', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.shangjinCount[0] = 5; // 超 3
  g.shangjinTiles[0] = ['w5', 'w5', 'w5', 'w5', 'w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.goldCount, 3, '三金封顶：按 3 金计');
  assert.equal(w.goldScore, 9, '3金 → 金分 9');
  cleanupServer(srv);
});

// ============ 计分 A（边趣版） ============

test('计分A 自摸：闲家胡1翻倍、金分3倍递增（2金=3），每家付 2×1+3=5', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.dealer = 1; // 胡家 seat0 为闲家
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.shangjinCount[0] = 2;
  g.shangjinTiles[0] = ['w5', 'w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.winType, 'zimo');
  assert.equal(w.goldCount, 2);
  assert.equal(w.goldScore, 3, '2金 → 金分 3');
  assert.equal(w.winnerGain, 15, '每家 2×1(胡)+3(金)=5，三家共 15');
  assert.ok(w.payments.every((p) => p.amount === 5), '自摸三家各付 5');
  assert.ok(w.payments.every((p) => p.formula && p.formula.includes('金')), '分项计算式含金分');
  assert.equal(room.players[0].roundScore, 15);
  cleanupServer(srv);
});

test('计分A 点炮通赔：闲胡1、点炮者金分翻倍，另两闲各付 1+金', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'play_tile', tile: 'w9' });
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu, '应可点炮胡');
  send(wss[1], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.winType, 'dianpao');
  assert.equal(w.discarder, 0, '放炮者 seat0');
  assert.equal(w.winnerGain, 7, '点炮通赔：点炮者付 1+1+1(金翻倍)=3，另两闲各付 1+1=2，共 7');
  const pay0 = w.payments.find((p) => p.from === 0);
  assert.equal(pay0.amount, 3, '点炮者金分翻倍 → 多付 1 分');
  assert.equal(pay0.role, '点炮');
  assert.equal(room.players[1].roundScore, 7);
  assert.equal(room.players[0].roundScore, -3);
  cleanupServer(srv);
});

test('计分A 庄家身份：庄家自摸胡2翻倍，2金时每家付 2×2+3=7', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.dealer = 0;
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.shangjinCount[0] = 2;
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.winnerGain, 21, '庄家自摸：每家 2×2+3=7，共 21');
  cleanupServer(srv);
});

// ============ 计分 B（125 体系） ============

test('计分B 点炮：1金=5，base=胡1+庄1+金5=7，点炮付8、另两闲各7', () => {
  const { srv, room, wss } = makeRoom4({ scoreMode: 'B' });
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'play_tile', tile: 'w9' });
  send(wss[1], { type: 'hu' });
  const w = g.winners;
  assert.equal(w.scoreMode, 'B');
  assert.equal(w.goldScore, 5, '1金=5');
  assert.equal(w.winnerGain, 22, '点炮8 + 两闲7×2 = 22');
  const pay0 = w.payments.find((p) => p.from === 0);
  assert.equal(pay0.amount, 8, '放炮者付 8');
  cleanupServer(srv);
});

test('计分B 庄家自摸共收 30（2金=15：每家 7+8? 口径为庄家身份×2 → dealerShare=base+3）', () => {
  const { srv, room, wss } = makeRoom4({ scoreMode: 'B' });
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.dealer = 0;
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.shangjinCount[0] = 2;
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const w = g.winners;
  // 2金 → G=15，base=1+1+15=17，庄家自摸 → dealerShare=base+3=20，三家共 60
  assert.equal(w.goldScore, 15);
  assert.equal(w.winnerGain, 60, '庄家身份×2：每家 base+3=20，共 60');
  assert.ok(w.payments.every((p) => p.amount === 20));
  cleanupServer(srv);
});

// ============ 截胡（不可一炮多响，逆时针最近） ============

test('截胡单响：多个玩家同时可胡时仅逆时针离点炮者最近者胡', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice();
  g.hands[2] = TING_W9_13.slice(); // seat2 也可胡
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinCount[2] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.shangjinTiles[2] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'play_tile', tile: 'w9' });
  assert.ok(g.pending, '应产生响应');
  const huResponders = g.pending.responders.filter((r) => r.canHu);
  assert.equal(huResponders.length, 1, '截胡：至多一人可胡');
  assert.equal(huResponders[0].seat, 1, '逆时针离点炮者最近者为 seat1');
  send(wss[1], { type: 'hu' });
  assert.equal(g.winners.winner, 1, '仅最近者胡牌');
  cleanupServer(srv);
});

// ============ 过胡限制 ============

test('过胡限制：点炮响应期内过胡后，获抓牌权前不能再胡', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w9', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = TING_W9_13.slice();
  g.hands[2] = ['w9', 'w9', 'w9', 'b5', 'b6', 'b7', 't3', 't3', 't3', 'b8', 'b9', 't4', 't4'];
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';

  send(wss[0], { type: 'play_tile', tile: 'w9' });
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu, 'seat1 可胡');
  send(wss[1], { type: 'pass' });
  // seat1 已过，seat2 可碰 w9（未决定完，标记暂未生效）
  send(wss[2], { type: 'peng' });
  assert.equal(g.huPassed[1], true, '过胡后未获抓牌权前标记禁止胡');
  assert.equal(g.turn, 2, '碰后由 seat2 出牌');
  assert.equal(g.stage, 'draw', '碰后仍处于行动阶段（drawnTile=null，仅可出牌）');
  assert.equal(g.drawnTile, null, '碰后无摸牌，只能出牌');
  assert.equal(g.lastAction.type, 'peng', '碰后 lastAction 标记为 peng，prompt 只给出牌');

  // seat2 打出剩余 w9：seat1 仍在过胡限制内，不得获得胡响应
  send(wss[2], { type: 'play_tile', tile: 'w9' });
  if (g.pending) {
    const rAgain = g.pending.responders.find((r) => r.seat === 1);
    assert.ok(!rAgain || !rAgain.canHu, '过胡后获得抓牌权前不能点炮胡');
  } else {
    assert.equal(g.pending, null, '过胡后无胡响应');
  }

  // 轮到 seat3 摸牌获得抓牌权（seat1 尚未获得抓牌权，过胡限制保持）
  assert.equal(g.turn, 3, 'seat2 出牌后轮转 seat3');
  assert.equal(g.stage, 'draw', 'seat3 摸牌阶段');
  assert.equal(g.huPassed[1], true, 'seat3 摸牌阶段 seat1 过胡限制仍生效');
  g.lastAction = null;
  send(wss[3], { type: 'play_tile', tile: 'b9' });
  assert.equal(g.turn, 0, 'seat3 出牌后轮转 seat0（逆时针）');
  assert.equal(g.stage, 'draw', 'seat0 摸牌阶段');
  assert.equal(g.huPassed[1], true, 'seat0 摸牌阶段 seat1 过胡限制仍生效');
  // seat0 出牌后轮到 seat1 摸牌，获得抓牌权 → 过胡限制解除
  g.lastAction = null;
  send(wss[0], { type: 'play_tile', tile: 'b2' });
  assert.equal(g.turn, 1, 'seat0 出牌后轮转 seat1');
  assert.equal(g.huPassed[1], false, 'seat1 获得抓牌权后过胡限制解除');
  cleanupServer(srv);
});

// ============ 抢杠：补杠可抢 / 暗杠不可抢 ============

test('抢杠胡：补杠触发抢杠判定（截胡单响），被抢者当放炮者', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.melds[0] = [{ type: 'peng', tile: 'w6', tiles: ['w6', 'w6', 'w6'] }];
  g.hands[0] = ['w6', 'w1', 'w2', 'w3', 'w4', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2'];
  g.hands[1] = ['w5', 'w5', 'w6', 'w7', 'w8', 'w9', 't3', 't3', 't3', 't4', 't5', 'b1', 'b2'];
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'gang', tile: 'w6', gangType: 'bugang' });
  assert.ok(g.pending && g.pending.type === 'qianggang', '补杠应触发抢杠判定');
  assert.equal(g.pending.discarder, 0, '被抢杠者=放炮者');
  const r1 = g.pending.responders.find((r) => r.seat === 1);
  assert.ok(r1 && r1.canHu === true, '听 w6 家可抢杠胡');
  send(wss[1], { type: 'hu' });
  assert.equal(g.winners.winType, 'qianggang');
  assert.equal(g.winners.winner, 1);
  cleanupServer(srv);
});

test('暗杠不可抢：暗杠不进入抢杠响应', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w6', 'w6', 'w6', 'w6', 'w1', 'w2', 'w3', 'w4', 'w7', 'w8', 't1', 't1', 't2'];
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'gang', tile: 'w6', gangType: 'angang' });
  assert.equal(g.pending, null, '暗杠不可抢，不进入响应');
  assert.equal(room.players[0].roundScore, 6, '暗杠当场结：收每家 2 分共 6');
  assert.equal(room.players[1].roundScore, -2);
  cleanupServer(srv);
});

// ============ 字牌整副胡限制 ============

test('字牌胡限制：全字牌胡只能自摸，不能点炮胡（金牌不代）', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  // 点炮：seat1 全字牌听 n（13 张，真实字牌无金牌）
  g.hands[0] = ['n', 'w1', 'w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'b1', 'b2', 'b3', 't2'];
  g.hands[1] = ALL_HONOR_TING_N_13.slice();
  g.hands[2] = PLAIN13.slice();
  g.hands[3] = PLAIN13.slice();
  g.melds = [[], [], [], []];
  g.shangjinCount[1] = 1;
  g.shangjinTiles[1] = ['w5'];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't2';
  send(wss[0], { type: 'play_tile', tile: 'n' });
  assert.equal(g.pending, null, '全字牌胡不能点炮胡（响应无 hu）');

  // 自摸：全字牌 14 张自摸可胡
  g.turn = 1;
  g.stage = 'draw';
  g.hands[1] = ALL_HONOR_SELFHU.slice();
  g.melds[1] = [];
  g.drawnTile = 'n';
  g.lastAction = null;
  send(wss[1], { type: 'hu' });
  assert.equal(g.winners.winType, 'zimo', '全字牌胡只能自摸');
  cleanupServer(srv);
});

// ============ 流局双开关 + 杠分不计 ============

test('流局开关A：摸完最后一张才流局（剩1张继续行牌），庄家连庄', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  const dealer0 = room.dealer;
  g.wallPos = g.wall.length - 1;
  srv._drawTileTieJin(room, 0);
  assert.equal(g.winners, null, '开关A：牌墙剩1张应继续摸');
  g.wallPos = g.wall.length;
  srv._drawTileTieJin(room, 1);
  assert.equal(g.winners.type, 'draw');
  assert.equal(g.winners.variant, 'tiejin');
  assert.equal(room.lastWinner, null);
  // 无杠：连庄
  srv._dealRoundTieJin(room);
  assert.equal(room.game.dealer, dealer0, '流局无杠庄家连庄');
  cleanupServer(srv);
});

test('流局开关B：剩10墩（20张）即黄庄；A模式下剩20张不流局', () => {
  const { srv, room, wss } = makeRoom4({ drawEndMode: 'B' });
  const g = room.game;
  g.wallPos = g.wall.length - 20;
  srv._drawTileTieJin(room, 0);
  assert.equal(g.winners.type, 'draw', '开关B：剩20张（硬10墩）即流局');
  cleanupServer(srv);
});

test('流局杠分不计：本局杠分当场结算后在流局时全部回滚', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = ['w6', 'w6', 'w6', 'w6', 'w1', 'w2', 'w3', 'w4', 'w7', 'w8', 't1', 't1', 't2'];
  g.melds = [[], [], [], []];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 't3';
  send(wss[0], { type: 'gang', tile: 'w6', gangType: 'angang' });
  assert.equal(room.players[0].roundScore, 6, '杠分当场结');
  assert.equal(room.players[1].roundScore, -2);
  // 流局
  g.wallPos = g.wall.length;
  srv._drawTileTieJin(room, 1);
  assert.equal(g.winners.type, 'draw');
  assert.equal(room.players[0].roundScore, 0, '流局杠分不计：杠家回滚到 0');
  assert.equal(room.players[1].roundScore, 0, '流局杠分不计：付家回滚到 0');
  assert.equal(room.lastFlowHadGang, true, '流局有杠：下局下家坐庄');
  const dealer0 = room.dealer;
  srv._dealRoundTieJin(room);
  assert.equal(room.game.dealer, (dealer0 + 1) % 4, '流局有杠下家坐庄');
  cleanupServer(srv);
});

// ============ 胡牌坐庄流转 ============

test('谁胡谁坐庄：本局胡牌者下局坐庄，庄家胡牌连庄', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  assert.equal(room.lastWinner, 0);
  const d0 = g.dealer;
  srv._dealRoundTieJin(room);
  assert.equal(room.game.dealer, 0, '谁胡谁坐庄（庄胡连庄）');
  cleanupServer(srv);
});

// ============ 结算字段完整性 ============

test('结算字段完整：金母/金牌/上金数/金分/分项计算式/锁金状态/各家手牌齐全', () => {
  const { srv, room, wss } = makeRoom4({});
  const g = room.game;
  g.goldTile = 'w5';
  g.goldMother = 'w5';
  g.hands[0] = SELFHU_W9_14.slice();
  g.melds[0] = [];
  g.shangjinCount[0] = 2;
  g.shangjinTiles[0] = ['w5', 'w5'];
  g.locked = [false, true, true, true];
  g.lockSeat = 0;
  g.turn = 0;
  g.stage = 'draw';
  g.drawnTile = 'w9';
  send(wss[0], { type: 'hu' });
  const settle = lastOf(wss[0], 'settlement');
  assert.ok(settle, '胡牌后必须广播 settlement');
  const r = settle.result;
  assert.equal(r.variant, 'tiejin');
  assert.equal(r.goldMother, 'w5');
  assert.equal(r.goldTile, 'w5');
  assert.equal(r.goldCount, 2);
  assert.equal(r.goldScore, 3);
  assert.ok(r.payments.every((p) => p.formula), '分项计算式 formula 齐全');
  assert.deepEqual(r.shangjinCount, [2, 0, 0, 0]);
  assert.deepEqual(r.locked, [false, true, true, true]);
  assert.equal(r.lockSeat, 0);
  assert.ok(r.hands && r.hands.length === 4, '结算需含各家手牌 hands');
  cleanupServer(srv);
});
