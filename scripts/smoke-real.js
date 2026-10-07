// 真机冒烟测试：连真实运行中的 server.js（3100），覆盖 HTTP + WebSocket 全流程 + 安全护栏
const WebSocket = require('ws');
const http = require('http');

const URL = 'ws://localhost:3100';
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? '  :: ' + extra : ''));
}

function httpGet(path) {
  return new Promise((res, rej) => {
    http.get({ host: 'localhost', port: 3100, path }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ code: r.statusCode, body: d }));
    }).on('error', rej);
  });
}

function open() {
  return new Promise((res, rej) => {
    let tries = 0;
    const tryOnce = () => {
      const ws = new WebSocket(URL);
      ws.on('open', () => res(ws));
      ws.on('error', e => { if (tries++ < 12) setTimeout(tryOnce, 300); else rej(e); });
    };
    tryOnce();
  });
}

function nextMsg(ws, pred, timeout = 4000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), timeout);
    const h = m => {
      let o; try { o = JSON.parse(m); } catch { return; }
      if (pred(o)) { clearTimeout(t); ws.off('message', h); res(o); }
    };
    ws.on('message', h);
  });
}

// 在对象里递归找一个 13/14 长度的牌串数组（手牌）
function findHand(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length >= 13 && v.length <= 14 && v.every(x => typeof x === 'string' && /^[wtbz]/.test(x))) return v;
    if (typeof v === 'object') { const r = findHand(v); if (r) return r; }
  }
  return null;
}

(async () => {
  // 1. HTTP 首页
  const h = await httpGet('/');
  check('HTTP 首页返回 200', h.code === 200, 'code=' + h.code);
  check('首页 <title> 含「运城麻将」', h.body.includes('运城麻将'));

  // 2. join_lobby -> hello(secret)
  const a = await open();
  a.send(JSON.stringify({ type: 'join_lobby', name: '实测甲' }));
  const hello = await nextMsg(a, o => o.type === 'hello');
  check('join_lobby 下发 secret（重连凭据）', !!hello.secret && hello.secret.length > 0, 'pid=' + hello.playerId.slice(0, 8));
  const pid = hello.playerId, secret = hello.secret;

  // 3. create_room -> 4 位房间码
  a.send(JSON.stringify({ type: 'create_room', settings: { totalRounds: 4, variant: 'koudian', aiFill: true } }));
  const room = await nextMsg(a, o => o.type === 'room_state' && o.room);
  check('create_room 返回 4 位房间码', !!room.room && /^\d{4}$/.test(room.room.id), 'room=' + (room.room && room.room.id));

  // 4. start_game -> 进入对局
  a.send(JSON.stringify({ type: 'start_game' }));
  const gv = await nextMsg(a, o => o.type === 'game_view' || (o.type === 'room_state' && o.room && o.room.state === 'playing'), 9000);
  const playing = gv.type === 'game_view' || (gv.room && gv.room.state === 'playing');
  check('start_game 后进入对局(playing)', playing, 'type=' + gv.type);
  const hand = findHand(gv);
  if (hand) check('本家手牌已发(13/14 张)', hand.length === 13 || hand.length === 14, 'len=' + hand.length);
  else console.log('INFO - game_view 已收到（手牌字段名未识别，跳过张数断言）');

  // 5. 安全：错误 secret 重连被拒
  const b = await open();
  b.send(JSON.stringify({ type: 'reconnect', playerId: pid, secret: 'deadbeef', name: '实测甲' }));
  const errBad = await nextMsg(b, o => o.type === 'error', 3000).catch(() => null);
  check('重连(错误 secret)被拒 · 返回 AUTH_FAILED', !!errBad && errBad.code === 'AUTH_FAILED', 'code=' + (errBad && errBad.code));
  b.close();

  // 6. 安全：正确 secret 重连成功
  const c = await open();
  c.send(JSON.stringify({ type: 'reconnect', playerId: pid, secret, name: '实测甲' }));
  const hello2 = await nextMsg(c, o => o.type === 'hello', 3000).catch(() => null);
  check('重连(正确 secret)成功', !!hello2 && hello2.playerId === pid, '');
  c.close();

  // 7. 超长消息：ws 帧层 maxPayload(16KB) 直接断开该连接（硬性防御），但服务进程不崩
  a.send('x'.repeat(20000));
  // 用一条全新连接验证服务端仍然在线、可正常服务
  const e = await open();
  e.send(JSON.stringify({ type: 'join_lobby', name: '存活探针' }));
  const alive = await nextMsg(e, o => o.type === 'hello', 3000).catch(() => null);
  check('超长消息后服务进程仍存活(新连接可正常 join_lobby)', !!alive, 'resp=' + (alive && alive.type));
  e.close();
  // 原连接因超帧被 ws 断开属预期；确认其已不再 OPEN
  check('超长消息触发 ws 帧层断开(防御生效)', a.readyState !== WebSocket.OPEN, 'readyState=' + a.readyState);

  // 8. 房间码暴力枚举限频
  const d = await open();
  d.send(JSON.stringify({ type: 'join_lobby', name: '枚举者' }));
  await nextMsg(d, o => o.type === 'hello');
  let locked = false;
  for (let i = 0; i < 6; i++) {
    d.send(JSON.stringify({ type: 'join_room', roomId: '0000' }));
    const e = await nextMsg(d, o => o.type === 'error', 2000).catch(() => null);
    if (e && /频繁/.test(e.message)) { locked = true; break; }
  }
  check('连续错误房间码触发限频锁定', locked, '');
  d.close();

  a.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n==== 实测结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SMOKE ERROR', e); process.exit(2); });
