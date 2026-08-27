'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const { GameServer } = require('../src/game');
const SETTINGS = { enableKoupoint: false, aiFill: true, totalRounds: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const srv = new GameServer();
  // patch：观察 _handleOwnerOfflineTimeout 是否被调用及异常
  const origHandle = srv._handleOwnerOfflineTimeout.bind(srv);
  srv._handleOwnerOfflineTimeout = (room) => {
    console.log('[EVENT] _handleOwnerOfflineTimeout 被调用 at', Date.now() % 100000, 'room=', room.id, 'state=', room.state);
    try { origHandle(room); console.log('[EVENT] 调用结束 pendingDisband=', room.pendingDisband); }
    catch (e) { console.log('[EVENT] 调用异常:', e.message); }
  };

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
  A.close();
  await sleep(300);
  console.log('断线后 timers=', [...room.timers.keys()], 'owner.connected=', room.players.find((p) => p && p.id === room.ownerId).connected);

  B.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'room_notice') console.log('[B收到] room_notice:', m.text); });
  for (let i = 0; i < 13; i++) {
    await sleep(5000);
    const own = room.players.find((p) => p && p.id === room.ownerId);
    console.log('T+' + ((i + 1) * 5) + 's state=' + room.state + ' pendingDisband=' + room.pendingDisband + ' owner.connected=' + (own ? own.connected : 'gone') + ' timers=' + [...room.timers.keys()]);
  }
  B.close();
  wss.close();
  httpSrv.close();
  process.exit(0);
}
main().catch((e) => { console.error('异常:', e.message); process.exit(2); });
