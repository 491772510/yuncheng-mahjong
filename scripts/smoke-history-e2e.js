'use strict';
// 端到端验证：登录用户打完一局后，历史对局记录应落盘且可被查询。
const WebSocket = require('ws');
const URL = 'ws://localhost:3100';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function open() { return new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); }); }
function send(ws, o) { ws.send(JSON.stringify(o)); }
function next(ws, pred, t = 5000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout')), t);
    ws.on('message', function h(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); }
    });
  });
}

(async () => {
  const ws = await open();
  const uname = 'e2e' + (Date.now() % 100000);
  send(ws, { type: 'register', username: uname, password: 'secret123', name: '记录员' });
  const reg = await next(ws, (m) => m.type === 'registered');
  const token = reg.token;
  send(ws, { type: 'join_lobby', name: 'x', token });
  await next(ws, (m) => m.type === 'hello');
  send(ws, { type: 'create_room', settings: { totalRounds: 4, variant: 'koudian', aiFill: true } });
  await next(ws, (m) => m.type === 'room_state' || (m.room && m.room.id));
  send(ws, { type: 'start_game' });
  // 等待本局结算：轮询历史记录，最多 100 秒
  let recs = [];
  for (let i = 0; i < 34; i++) {
    await wait(3000);
    send(ws, { type: 'get_history', limit: 10, token });
    const h = await next(ws, (m) => m.type === 'history', 4000).catch(() => null);
    if (h && h.records && h.records.length) { recs = h.records; break; }
  }
  ws.close();
  if (recs.length) {
    const r = recs[0];
    console.log('PASS - 登录用户打完一局后历史已落盘');
    console.log('  最新记录:', JSON.stringify({ variant: r.variant, roundNo: r.roundNo, delta: r.delta, total: r.total, isWin: r.isWin, type: r.type }));
    process.exit(0);
  } else {
    console.log('FAIL - 100 秒内未产生历史记录（可能本局未自动结算）');
    process.exit(1);
  }
})().catch((e) => { console.error('异常', e); process.exit(2); });
