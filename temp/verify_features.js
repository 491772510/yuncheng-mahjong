'use strict';
// 运城扣点点麻将：三个新功能端到端联调脚本
// 1) 房间列表 ownerName  2) 摸牌 newTile 视觉标志  3) 房主离线超 60s → 本局结束解散
// 运行: $env:NODE_PATH='D:\share\Marvis产出\koudian-mahjong\node_modules'; node temp/verify_features.js
const WebSocket = require('ws');
const http = require('http');
const { WebSocketServer } = require('ws');
const { GameServer } = require('../src/game');

const HOST = 'ws://localhost:3100';
const SETTINGS = { enableKoupoint: false, aiFill: true, totalRounds: 4 };

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      ws.messages.push(msg);
      for (let i = ws.waiters.length - 1; i >= 0; i--) {
        if (ws.waiters[i].pred(msg)) {
          const w = ws.waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
          break;
        }
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitFor(ws, pred, timeoutMs, label) {
  const hit = ws.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve, timer: null };
    w.timer = setTimeout(() => {
      const i = ws.waiters.indexOf(w);
      if (i >= 0) ws.waiters.splice(i, 1);
      reject(new Error('等待超时: ' + label));
    }, timeoutMs);
    ws.waiters.push(w);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  [PASS] ' + name); }
  else { failures++; console.log('  [FAIL] ' + name + (detail ? ' | ' + detail : '')); }
}

async function main() {
  // ============ Part 1: 房间列表 ownerName（真实 3100） ============
  console.log('== Part 1: 房间列表 ownerName ==');
  const A = await connect(HOST);
  send(A, { type: 'join_lobby', name: '房主验证' });
  await waitFor(A, (m) => m.type === 'hello', 3000, 'A hello');
  send(A, { type: 'create_room', settings: SETTINGS });
  const rsA = await waitFor(A, (m) => m.type === 'room_state' && m.room && m.room.id, 3000, 'A room_state');
  const roomId = rsA.room.id;

  const B = await connect(HOST);
  send(B, { type: 'join_lobby', name: '玩家乙' });
  await waitFor(B, (m) => m.type === 'hello', 3000, 'B hello');
  const lobbyB = await waitFor(B, (m) => m.type === 'lobby_state' && m.rooms && m.rooms.some((r) => r.id === roomId), 3000, 'B lobby_state');
  const roomInLobby = lobbyB.rooms.find((r) => r.id === roomId);
  check('大厅房间列表含 ownerName', roomInLobby.ownerName === '房主验证', 'ownerName=' + roomInLobby.ownerName);

  // ============ Part 2: 摸牌 newTile 视觉标志（真实 3100） ============
  console.log('== Part 2: 摸牌 newTile 视觉标志 ==');
  send(B, { type: 'join_room', roomId });
  await waitFor(B, (m) => m.type === 'room_state' && m.room && m.room.id === roomId, 3000, 'B join_room');
  send(A, { type: 'start_game' });
  const gsA0 = await waitFor(A, (m) => m.type === 'game_state' && m.game && m.game.stage, 5000, 'A game_state');
  const yourA = gsA0.game.yourSeat;
  const yourB = gsA0.game.players.find((p) => p && p.name === '玩家乙').seat;

  // 自动推进：A/B 收到 draw prompt 时脚本代为出牌，直到捕获 B 的摸牌回合
  let bDraw = null;
  let bNewTile = null;
  let playedByB = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !bDraw) {
    const promptMsg = await waitFor(
      B,
      (m) => m.type === 'action_prompt' && m.prompt && (m.prompt.type === 'draw' || m.prompt.type === 'response'),
      2000,
      'A/B prompt 轮询'
    ).catch(() => null);
    // 服务端只给对应座位发 prompt；轮询用 B 的流会漏掉 A 的 prompt，
    // 因此这里改为直接以当前 game_state 判断轮到谁，并代为出牌。
    const gs = B.messages.filter((m) => m.type === 'game_state').pop();
    if (!gs || !gs.game) continue;
    const turnSeat = gs.game.turn;
    const newTile = gs.game.newTile;
    console.log('  [DEBUG] turn=' + turnSeat + ' stage=' + gs.game.stage + ' newTile=' + newTile + ' Btype=' + (promptMsg && promptMsg.prompt.type));
    if (turnSeat === yourA) {
      if (gs.game.stage === 'response') { send(A, { type: 'pass' }); continue; }
      // 从 A 自己的视角取牌（B 视角下 A 的手牌为 null）
      const gsA2 = A.messages.filter((m) => m.type === 'game_state').pop();
      const pA = gsA2.game.players.find((p) => p && p.seat === yourA);
      const tileA = gsA2.game.newTile || pA.hand[pA.hand.length - 1];
      send(A, { type: 'play_tile', tile: tileA });
      continue;
    }
    if (turnSeat === yourB) {
      if (gs.game.stage === 'response') { send(B, { type: 'pass' }); continue; }
      const handB = gs.game.players.find((p) => p && p.seat === yourB).hand;
      bNewTile = newTile;
      bDraw = gs;
      check('B 摸牌后 game_state 下发 newTile', !!bNewTile, 'newTile=' + bNewTile);
      if (bNewTile) check('newTile 位于自己手牌中', handB.includes(bNewTile));
      const tileB = bNewTile || handB[handB.length - 1];
      send(B, { type: 'play_tile', tile: tileB });
      playedByB = true;
    }
  }
  if (!bDraw) throw new Error('20s 内未捕获 B 的摸牌回合');
  await sleep(300);

  const gsB2 = B.messages.filter((m) => m.type === 'game_state').pop();
  check('B 打出后 newTile 清除', gsB2.game.newTile === null, 'newTile=' + gsB2.game.newTile);
  // A 视角：他人 newTile 不可见（A 看到的是自己座位记录：null 或自己手牌中的牌）
  const gsA = A.messages.filter((m) => m.type === 'game_state').pop();
  const ntA = gsA && gsA.game ? gsA.game.newTile : null;
  const handA = gsA.game.players.find((p) => p && p.seat === yourA).hand;
  check('A 视角 newTile 仅为自己记录（null 或自己手牌）', ntA === null || handA.includes(ntA), 'ntA=' + ntA);

  // ============ Part 3: 房主离线超 60 秒（真实 3100，真实等待） ============
  console.log('== Part 3: 房主离线超 60 秒提示 + 本局未结束房间仍进行 ==');
  A.close();
  B.close();
  // 独立房间用无限局：保证 60 秒内本局不会终局，验证“提示后房间仍进行、不立即解散”
  const A3 = await connect(HOST);
  const B3 = await connect(HOST);
  send(A3, { type: 'join_lobby', name: '房主三' });
  await waitFor(A3, (m) => m.type === 'hello', 3000, 'A3 hello');
  send(B3, { type: 'join_lobby', name: '玩家丙' });
  await waitFor(B3, (m) => m.type === 'hello', 3000, 'B3 hello');
  send(A3, { type: 'create_room', settings: { ...SETTINGS, totalRounds: 0 } });
  const rsA3 = await waitFor(A3, (m) => m.type === 'room_state' && m.room && m.room.id, 3000, 'A3 room_state');
  const roomId3 = rsA3.room.id;
  send(B3, { type: 'join_room', roomId: roomId3 });
  await waitFor(B3, (m) => m.type === 'room_state' && m.room && m.room.id === roomId3, 3000, 'B3 join_room');
  send(A3, { type: 'start_game' });
  await waitFor(A3, (m) => m.type === 'game_state' && m.game && m.game.stage, 5000, 'A3 game_state');
  A3.close();
  console.log('  房主已断线，等待 60 秒超时...');
  const notice = await waitFor(B3, (m) => m.type === 'room_notice' && m.text && m.text.includes('房主离线超过60秒'), 65000, '房主超时提示');
  check('收到“房主离线超过60秒”广播提示', !!notice, notice && notice.text);
  await sleep(300);
  const rsB3 = B3.messages.filter((m) => m.type === 'room_state').pop();
  check('本局未结束：房间仍存在、玩家未回大厅', rsB3.room !== null && rsB3.room.state === 'playing', 'state=' + (rsB3.room && rsB3.room.state));
  B3.close();

  // ============ Part 4: 本局结束后自动解散（内存实例 + 真实 ws 协议，受控加速） ============
  console.log('== Part 4: 房主超时后本局结束 → 自动解散并通知回大厅 ==');
  const srv = new GameServer();
  const httpSrv = http.createServer();
  const wss = new WebSocketServer({ server: httpSrv });
  wss.on('connection', (ws) => srv.handleConnection(ws));
  await new Promise((r) => httpSrv.listen(0, r));
  const port = httpSrv.address().port;

  const C = await connect('ws://localhost:' + port);
  const D = await connect('ws://localhost:' + port);
  send(C, { type: 'join_lobby', name: '房主四' });
  await waitFor(C, (m) => m.type === 'hello', 3000, 'C hello');
  send(D, { type: 'join_lobby', name: '玩家丁' });
  await waitFor(D, (m) => m.type === 'hello', 3000, 'D hello');
  send(C, { type: 'create_room', settings: SETTINGS });
  const rsC = await waitFor(C, (m) => m.type === 'room_state' && m.room && m.room.id, 3000, 'C room_state');
  const roomId2 = rsC.room.id;
  send(D, { type: 'join_room', roomId: roomId2 });
  await waitFor(D, (m) => m.type === 'room_state' && m.room && m.room.id === roomId2, 3000, 'D join_room');
  send(C, { type: 'start_game' });
  await waitFor(C, (m) => m.type === 'game_state' && m.game && m.game.stage, 5000, 'C game_state');

  const room = [...srv.rooms.values()].find((r) => r.id === roomId2);
  C.close(); // 房主断线
  await sleep(300); // 等服务端处理 close 事件（p.connected=false）
  srv._handleOwnerOfflineTimeout(room); // 受控触发 60s 超时
  const notice2 = await waitFor(D, (m) => m.type === 'room_notice' && m.text && m.text.includes('房主离线超过60秒'), 3000, 'D 超时提示');
  check('收到房主离线超时提示', !!notice2);
  check('房间仍存在（本局未结束不解散）', srv.rooms.has(roomId2));

  srv._endRound(room); // 模拟本局结算结束
  const kick = await waitFor(D, (m) => m.type === 'room_state' && m.room === null, 3000, 'D 回大厅');
  check('本局结束后房间自动解散（服务端移除）', !srv.rooms.has(roomId2));
  check('玩家收到 room_state null（回大厅）', !!kick);
  const lobbyD = D.messages.filter((m) => m.type === 'lobby_state').pop();
  check('大厅房间列表不再包含该房间', !lobbyD.rooms.some((r) => r.id === roomId2));

  D.close();
  wss.close();
  httpSrv.close();

  console.log('');
  if (failures === 0) console.log('联调结果：全部通过');
  else console.log('联调结果：' + failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('联调异常:', e.message); process.exit(2); });
