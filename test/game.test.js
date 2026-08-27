'use strict';

// ============ 运城扣点点麻将：服务端三个新功能单测 ============
// 1) 新摸到的牌加视觉标志（game_state 下发 newTile，仅自己视角）
// 2) 房间列表显示创建者名称（lobby_state 下发 ownerName，转让/离开后保持）
// 3) 房主离线超 60 秒 AI 托管，本局结束后自动解散房间

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');

// ---------- 测试工具：伪 WebSocket 客户端 ----------
function makeWs() {
  const ws = { readyState: 1, sent: [], handlers: {} };
  ws.on = (type, cb) => { ws.handlers[type] = cb; };
  ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
  return ws;
}

function send(ws, obj) {
  ws.handlers.message(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastOf(ws, type) {
  const list = ws.sent.filter((m) => m.type === type);
  return list.length ? list[list.length - 1] : null;
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
  for (const p of srv.players.values()) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

const BASE_SETTINGS = { enableKoupoint: false, aiFill: true, totalRounds: 4 };

// ============ 功能2：房间列表显示创建者名称 ============
test('房间列表包含创建者名称 ownerName；房主离开转让后创建者名称保持原创建者', () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主甲' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });

  const room = [...srv.rooms.values()][0];
  assert.ok(room);
  assert.equal(room.ownerName, '房主甲'); // 服务端记录创建者名称

  // 其他玩家进入大厅看到的房间列表包含 ownerName
  const wb = makeWs();
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.ok(lobbyB && lobbyB.rooms.length === 1);
  assert.equal(lobbyB.rooms[0].ownerName, '房主甲');

  // 房主在 waiting 状态离开：房主身份转让给玩家乙，创建者名称保持房主甲
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'leave_room' });
  assert.equal(room.ownerId, wbSentPlayerId(wb, '玩家乙'));
  assert.equal(room.ownerName, '房主甲');
  // 离开后房主回到大厅，房间列表仍显示原创建者名称
  const lobbyA2 = lastOf(wa, 'lobby_state');
  assert.equal(lobbyA2.rooms[0].ownerName, '房主甲');
  cleanupServer(srv);
});

// 辅助：取大厅玩家 id（join_lobby 返回 hello.playerId）
function wbSentPlayerId(ws, name) {
  const hello = ws.sent.find((m) => m.type === 'hello');
  return hello.playerId;
}

// ============ 功能1：新摸到的牌加视觉标志 ============
test('摸牌后 game_state 下发 newTile（仅自己视角），打出后清除', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' }); // aiFill 补 2 个 AI 后开局

  assert.equal(room.state, 'playing');
  const g = room.game;
  // 开局庄家摸第 14 张后，服务端记录了新摸牌（新摸牌标志的源头）
  assert.ok(g.newTiles[g.turn], '庄家摸牌后内部应记录新摸牌');
  assert.ok(g.hands[g.turn].includes(g.newTiles[g.turn]));

  // 手动驱动座位 1（玩家乙）摸牌：验证“自己摸牌 → 自己视角收到 newTile”
  srv._drawTile(room, 1);
  const tileB = g.newTiles[1];
  assert.ok(tileB, '玩家乙摸牌后内部应记录新摸牌');
  const gsB = lastOf(wb, 'game_state');
  assert.equal(gsB.game.newTile, tileB, '自己视角应收到 newTile');
  assert.ok(gsB.game.players[1].hand.includes(tileB));

  // 他人视角不可见：房主（座位 0）看到的是自己座位的新摸牌记录，不是玩家乙的牌
  const gsA = lastOf(wa, 'game_state');
  assert.equal(gsA.game.newTile, g.newTiles[0] || null, '他人视角仅能看到自己的新摸牌记录');

  // 打出新摸的牌后：newTile 清除
  send(wb, { type: 'play_tile', tile: tileB });
  const gsB2 = lastOf(wb, 'game_state');
  assert.equal(gsB2.game.newTile, null, '打出后 newTile 应清除');
  assert.equal(g.newTiles[1], null);
  await sleep(400); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 功能3：房主离线超 60 秒 AI 托管，本局结束自动解散 ============
test('房主离线超时：广播提示，本局结束后自动解散房间并通知所有玩家回大厅', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.ownerOfflineSince !== null, '房主离线起始时间已记录');
  assert.ok(room.timers.has('owner:offline'), '60 秒超时定时器已启动');

  // 模拟 60 秒超时（直接触发回调）
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.pendingDisband, true, '本局结束后解散标记已置位');
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('房主离线超过60秒'), '已广播房主离线超时提示');
  assert.ok(room.timers.has('owner:offline') === false, '超时回调后定时器已清理');

  // 本局结算结束：自动解散房间，玩家回到大厅
  srv._endRound(room);
  assert.equal(srv.rooms.has(room.id), false, '房间已从服务端移除');
  const kick = lastOf(wb, 'room_state');
  assert.equal(kick.room, null, '玩家收到 room_state null（回大厅）');
  const lobbyB = lastOf(wb, 'lobby_state');
  assert.ok(lobbyB && !lobbyB.rooms.some((r) => r.id === room.id), '大厅房间列表不再包含该房间');
  await sleep(400); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('牌局中途 _endRound 结算不得误清房主离线超时定时器（owner:offline 保留，超时后本局结束仍解散）', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 模拟真实场景：房主超时（60s）之前，牌局先打完了当前局 → _endRound 正常结算
  // 此时不得把 owner:offline 定时器一并清掉，否则超时回调永远不会触发
  srv._endRound(room);
  assert.ok(room.timers.has('owner:offline'), '_endRound 后房主离线超时定时器应保留');
  assert.equal(room.pendingDisband, false, '正常结算不应误触发解散');

  // 60 秒超时回调随后触发：广播提示 + 置解散标记
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.pendingDisband, true, '超时后解散标记已置位');
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('房主离线超过60秒'), '已广播房主离线超时提示');

  // 新一局（或当前局）结算结束：自动解散房间
  srv._endRound(room);
  assert.equal(srv.rooms.has(room.id), false, '本局结束后房间已解散');
  const kick = lastOf(wb, 'room_state');
  assert.equal(kick.room, null, '玩家收到 room_state null（回大厅）');
  await sleep(400); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('房主超时时本局已终局（settled）：广播提示后直接解散房间', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线：启动 60 秒超时定时器
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 模拟超时到来前牌局已全部打完（终局 settled）
  room.state = 'settled';
  srv._handleOwnerOfflineTimeout(room);
  const notice = lastOf(wb, 'room_notice');
  assert.ok(notice && notice.text.includes('房主离线超过60秒'), '已广播房主离线超时提示');
  assert.equal(srv.rooms.has(room.id), false, '本局已结束，房间直接解散');
  const kick = lastOf(wb, 'room_state');
  assert.equal(kick.room, null, '玩家收到 room_state null（回大厅）');
  await sleep(400); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

test('房主 60 秒内重连：取消离线超时解散，房间继续正常进行', async () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS } });
  const room = [...srv.rooms.values()][0];
  const ownerId = room.ownerId;
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  assert.equal(room.state, 'playing');

  // 房主断线
  wa.handlers.close();
  assert.ok(room.timers.has('owner:offline'));

  // 60 秒内重连：使用新连接执行 reconnect
  const wa2 = makeWs();
  srv.handleConnection(wa2);
  send(wa2, { type: 'reconnect', playerId: ownerId, name: '房主' });
  assert.equal(room.ownerOfflineSince, null, '重连后离线起始时间已清除');
  assert.equal(room.timers.has('owner:offline'), false, '重连后超时定时器已取消');

  // 即使超时回调被触发（理论不会），已重连的房主不应导致解散
  srv._handleOwnerOfflineTimeout(room);
  assert.equal(room.pendingDisband, false, '重连后不应触发解散');
  assert.equal(srv.rooms.has(room.id), true, '房间仍在进行');
  await sleep(400); // 等待 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

// ============ 功能4：开局扣点阶段不卡局 ============
test('开局扣点阶段：断线真人座位立即自动补扣点，四座填满正常开局', () => {
  const srv = newServer();
  const wa = makeWs();
  const wb = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  srv.handleConnection(wb);
  send(wb, { type: 'join_lobby', name: '玩家乙' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, enableKoupoint: true } });
  const room = [...srv.rooms.values()][0];
  send(wb, { type: 'join_room', roomId: room.id });
  send(wa, { type: 'start_game' });
  const g = room.game;
  assert.equal(g.stage, 'koupoint');

  // AI 座位开局即自动填 1-4 扣点
  for (let s = 0; s < 4; s++) {
    const pl = room.players[s];
    if (pl && pl.isAI) {
      assert.ok(g.kouPoints[s] >= 1 && g.kouPoints[s] <= 4, 'AI 座位自动随机补扣点');
    }
  }

  // 玩家乙在扣点阶段断线 → 立即自动补扣点（不等 30s 超时）
  wb.handlers.close();
  const seatB = room.players.findIndex((p) => p && p.name === '玩家乙');
  assert.ok(g.kouPoints[seatB] >= 1 && g.kouPoints[seatB] <= 4, '断线真人座位立即自动补扣点');

  // 房主收到扣点选择提示，选择后四座填满正常开局
  const promptA = lastOf(wa, 'action_prompt');
  assert.ok(promptA && promptA.prompt.type === 'koupoint', '在线真人收到扣点选择提示');
  send(wa, { type: 'koupoint', points: 3 });
  assert.ok(g.kouPoints.every((x) => x != null), '四座扣点全部填满');
  assert.equal(g.stage, 'draw', '扣点填满后正常开局，不卡 koupoint');
  assert.equal(room.state, 'playing');
  cleanupServer(srv);
});

test('开局扣点阶段：在线真人超时未选自动补扣点，不卡 koupoint 阶段', async () => {
  const srv = newServer();
  const wa = makeWs();
  srv.handleConnection(wa);
  send(wa, { type: 'join_lobby', name: '房主' });
  send(wa, { type: 'create_room', settings: { ...BASE_SETTINGS, enableKoupoint: true } });
  const room = [...srv.rooms.values()][0];
  send(wa, { type: 'start_game' });
  const g = room.game;
  assert.equal(g.stage, 'koupoint');
  const seatA = room.players.findIndex((p) => p && p.name === '房主');

  // 在线未托管真人：设有超时自动补定时器（HUMAN_TIMEOUT_MS=30s）
  assert.ok(room.timers.has('koupoint:' + seatA), '在线真人设有超时自动补扣点定时器');
  assert.ok(g.kouPoints[seatA] == null, '真人尚未选择扣点');

  // 模拟超时回调触发：自动补 1-4 扣点
  srv._autoFillKoupoint(room, seatA);
  assert.ok(g.kouPoints[seatA] >= 1 && g.kouPoints[seatA] <= 4, '超时后自动补扣点');
  assert.ok(g.kouPoints.every((x) => x != null), '四座扣点全部填满');
  assert.equal(g.stage, 'draw', '扣点填满后正常开局，不卡 koupoint');

  // 已填座位重复触发自动补应为 no-op（不重复改值）
  const before = g.kouPoints[seatA];
  srv._autoFillKoupoint(room, seatA);
  assert.equal(g.kouPoints[seatA], before, '已选座位自动补为 no-op');
  await sleep(400); // 等待开局后 AI 托管链（80ms 裸定时器）跑完，避免残留定时器挂住 worker
  cleanupServer(srv);
});

