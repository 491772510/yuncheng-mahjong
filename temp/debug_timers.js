'use strict';
const { GameServer } = require('../src/game');

function makeWs() {
  const ws = { readyState: 1, sent: [], handlers: {} };
  ws.on = (type, cb) => { ws.handlers[type] = cb; };
  ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
  ws.close = () => {};
  return ws;
}
function send(ws, obj) { ws.handlers.message(JSON.stringify(obj)); }

const srv = new GameServer();
const wa = makeWs();
const wb = makeWs();
srv.handleConnection(wa);
send(wa, { type: 'join_lobby', name: '房主' });
srv.handleConnection(wb);
send(wb, { type: 'join_lobby', name: '玩家乙' });
send(wa, { type: 'create_room', settings: { enableKoupoint: false, aiFill: true, totalRounds: 4 } });
const room = [...srv.rooms.values()][0];
send(wb, { type: 'join_room', roomId: room.id });
send(wa, { type: 'start_game' });

// 模拟测试3：房主断线 → 超时 → 本局结束解散
wa.handlers.close();
srv._handleOwnerOfflineTimeout(room);
srv._endRound(room);

// 模拟测试4：断线重连
const room2 = (() => {
  const wc = makeWs();
  const wd = makeWs();
  srv.handleConnection(wc);
  send(wc, { type: 'join_lobby', name: '房主丙' });
  srv.handleConnection(wd);
  send(wd, { type: 'join_lobby', name: '玩家丁' });
  send(wc, { type: 'create_room', settings: { enableKoupoint: false, aiFill: true, totalRounds: 4 } });
  const r2 = [...srv.rooms.values()][0];
  send(wd, { type: 'join_room', roomId: r2.id });
  send(wc, { type: 'start_game' });
  wc.handlers.close();
  // 重连
  const wc2 = makeWs();
  srv.handleConnection(wc2);
  send(wc2, { type: 'reconnect', playerId: srv.players.get(srv.wsPlayers.get(wc)).id });
  return r2;
})();

// 清理后检查 active timers
function cleanupServer(s) {
  for (const r of s.rooms.values()) {
    for (const t of r.timers.values()) clearTimeout(t);
    r.timers.clear();
  }
  for (const p of s.players.values()) {
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
  }
}
cleanupServer(srv);

setTimeout(() => {
  const timers = process._getActiveHandles().filter((h) => h.constructor && h.constructor.name === 'Timeout');
  console.log('active timers after cleanup:', timers.length);
  for (const t of timers) console.log('  delay:', t._idleTimeout, 'ms');
  process.exit(0);
}, 50);
