'use strict';
const WebSocket = require('ws');
const URL = 'ws://localhost:3100';
let pass = 0, fail = 0;
const log = (ok, m) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS' : 'FAIL') + ' - ' + m); };
function open() { return new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => res(ws)); }); }
function send(ws, o) { ws.send(JSON.stringify(o)); }
function next(ws, pred, t = 3000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout')), t);
    ws.on('message', function h(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); }
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ws = await open();
  // 1. 注册
  const uname = 'smk' + (Date.now() % 100000);
  send(ws, { type: 'register', username: uname, password: 'secret123', name: '阿烟' });
  const reg = await next(ws, (m) => m.type === 'registered' || (m.type === 'error'));
  log(reg.type === 'registered' && reg.token, '注册成功并返回 token');
  const token = reg.token;
  // 2. 错误密码登录被拒
  send(ws, { type: 'login', username: uname, password: 'wrong' });
  const bad = await next(ws, (m) => m.type === 'error' && m.code === 'AUTH_INVALID');
  log(!!bad, '错误密码登录被拒 (AUTH_INVALID)');
  // 3. token 登录
  send(ws, { type: 'login', token });
  const li = await next(ws, (m) => m.type === 'logged_in');
  log(li.token && li.user.username === uname, 'token 登录成功');
  // 4. 历史记录（空）
  send(ws, { type: 'get_history', limit: 10, token });
  const hist = await next(ws, (m) => m.type === 'history');
  log(hist.records && hist.records.length === 0 && !hist.guest, '历史记录为空（已登录）');
  // 5. 带 token 进大厅（账户关联）
  send(ws, { type: 'join_lobby', name: '游客名', token });
  const hello = await next(ws, (m) => m.type === 'hello');
  log(hello.name === '阿烟', '进大厅昵称被账户 displayName 覆盖 (阿烟)');
  // 6. 游客进大厅不关联
  const ws2 = await open();
  send(ws2, { type: 'join_lobby', name: '路人甲' });
  const hello2 = await next(ws2, (m) => m.type === 'hello');
  log(hello2.name === '路人甲', '游客进大厅保持原昵称');
  // 7. 弱密码注册被拒
  send(ws, { type: 'register', username: 'x', password: '123' });
  const weak = await next(ws, (m) => m.type === 'error' && m.code === 'AUTH_WEAK');
  log(!!weak, '弱用户名/密码注册被拒 (AUTH_WEAK)');
  ws.close(); ws2.close();
  await wait(100);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常', e); process.exit(2); });
