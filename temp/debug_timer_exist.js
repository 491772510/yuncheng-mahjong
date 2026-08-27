'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const { GameServer } = require('../src/game');
const SETTINGS = { enableKoupoint: false, aiFill: true, totalRounds: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = new GameServer();
  const httpSrv = http.createServer();
  const wss = new WebSocketServer({ server: httpSrv });
  wss.on('connection', (ws) => srv.handleConnection(ws));
  await new Promise((r) => httpSrv.listen(0, r));
  const port = httpSrv.address().port;

  const A = await new Promise((res, rej) => { const w = new (require('ws'))('ws://localhost:' + port); w.on('open', () => res(w)); w.on('error', rej); });
  const B = await new Promise((res, rej) => { const w = new (require('ws'))('ws://localhost:' + port); w.on('open', () => res(w)); w.on('error', rej); });
  const send = (w, o) => w.send(JSON.stringify(o));
  const wait = (w, pred, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('wait timeout')), ms);
    const onMsg = (d) => { const m = JSON.parse(d.toString()); if (pred(m)) { clearTimeout(t); w.off('message', onMsg); res(m); } };
    w.on('message', onMsg);
  });

  send(A, { type: 'join_lobby', name: '房主Z' });
  await wait(A, (m) => m.type === 'hello', 2000);
  send(A, { type: 'create_room', settings: SETTINGS });
  const rs = await wait(A, (m) => m.type === 'room_state', 2000);
  const roomId = rs.room.id;
  send(B, { type: 'join_lobby', name: '玩家W' });
  await wait(B, (m) => m.type === 'hello', 2000);
  send(B, { type: 'join_room', roomId });
  await wait(B, (m) => m.type === 'room_state', 2000);
  send(A, { type: 'start_game' });
  await wait(A, (m) => m.type === 'game_state', 3000);
  await sleep(200);

  const room = [...srv.rooms.values()].find((r) => r.id === roomId);
  console.log('开局后 state=', room.state, 'timers keys=', [...room.timers.keys()]);
  A.close();
  await sleep(200);
  console.log('房主断线后 timers keys=', [...room.timers.keys()], 'ownerOfflineSince=', room.ownerOfflineSince, 'ownerId=', room.ownerId);

  // 等真实 65s 观察 notice 与状态
  let gotNotice = false;
  B.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'room_notice') { gotNotice = true; console.log('收到 room_notice:', m.text); } if (m.type === 'room_state' && m.room === null) console.log('收到 room_state null 回大厅'); });
  console.log('等待 65 秒...');
  await sleep(65000);
  console.log('65s 后: gotNotice=', gotNotice, 'room存在=', srv.rooms.has(roomId), 'state=', room.state, 'pendingDisband=', room.pendingDisband, 'timers=', [...room.timers.keys()]);
  B.close();
  wss.close();
  httpSrv.close();
  process.exit(0);
}
main().catch((e) => { console.error('异常:', e.message); process.exit(2); });
