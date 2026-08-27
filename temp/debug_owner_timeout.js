'use strict';
const WebSocket = require('ws');
const HOST = 'ws://localhost:3100';
const SETTINGS = { enableKoupoint: false, aiFill: true, totalRounds: 4 };
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      ws.messages.push(msg);
      console.log('[' + (msg.name || (msg.room && msg.room.id) || '') + '] ' + msg.type + ' ' + JSON.stringify(msg).slice(0, 160));
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const A = await connect(HOST);
  send(A, { type: 'join_lobby', name: '房主X' });
  await sleep(300);
  send(A, { type: 'create_room', settings: SETTINGS });
  await sleep(300);
  const rs = A.messages.find((m) => m.type === 'room_state');
  const roomId = rs.room.id;
  const B = await connect(HOST);
  send(B, { type: 'join_lobby', name: '玩家Y' });
  await sleep(300);
  send(B, { type: 'join_room', roomId });
  await sleep(300);
  send(A, { type: 'start_game' });
  await sleep(800);
  console.log('--- 房主断线 ---');
  A.close();
  await sleep(65000);
  console.log('--- 65s 后 B 收到的消息 ---');
  const types = B.messages.map((m) => m.type + (m.text ? ':' + m.text : ''));
  console.log(types.join('\n'));
  B.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
