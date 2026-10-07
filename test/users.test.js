'use strict';
/**
 * 账号体系与历史对局记录单元测试。
 * 通过 KD_DATA_DIR 把持久化目录指向临时目录，避免污染真实 data/。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-users-'));
process.env.KD_DATA_DIR = tmpDir;

const users = require('../src/users');

test('registerUser 成功并返回不含密码哈希的公开信息', () => {
  const u = users.registerUser('alice', 'secret123', 'Alice');
  assert.strictEqual(u.username, 'alice');
  assert.strictEqual(u.displayName, 'Alice');
  assert.ok(!('hash' in u) && !('salt' in u));
});

test('registerUser 拒绝弱用户名/弱密码', () => {
  assert.throws(() => users.registerUser('a', 'secret123'), (e) => e.code === 'AUTH_WEAK');
  assert.throws(() => users.registerUser('bob', '123'), (e) => e.code === 'AUTH_WEAK');
  assert.throws(() => users.registerUser('x y', 'secret123'), (e) => e.code === 'AUTH_WEAK');
});

test('registerUser 拒绝重复用户名', () => {
  users.registerUser('carol', 'secret123');
  assert.throws(() => users.registerUser('carol', 'other456'), (e) => e.code === 'AUTH_EXISTS');
});

test('verifyUser 正确/错误密码', () => {
  users.registerUser('dave', 'passpass1');
  assert.ok(users.verifyUser('dave', 'passpass1'));
  assert.strictEqual(users.verifyUser('dave', 'wrong'), null);
  assert.strictEqual(users.verifyUser('ghost', 'passpass1'), null);
});

test('issueToken / getUserByToken / logoutToken', () => {
  const u = users.registerUser('erin', 'passpass1');
  const token = users.issueToken(u.username);
  assert.ok(users.getUserByToken(token));
  users.logoutToken(token);
  assert.strictEqual(users.getUserByToken(token), null);
});

test('历史记录写入后可按用户取回，且倒序、最多 limit 条', async () => {
  const u = users.registerUser('frank', 'passpass1');
  for (let i = 1; i <= 5; i++) {
    users.appendHistory(u.username, { t: Date.now() + i, variant: 'koudian', roundNo: i, delta: i, total: i * 10, isWin: i === 5, type: 'hu' });
  }
  await users.flush(); // 等异步追加落盘
  const all = users.getHistory(u.username, 50);
  assert.strictEqual(all.length, 5);
  assert.strictEqual(all[0].roundNo, 5, '应倒序：最新在前');
  assert.strictEqual(all[0].isWin, true);
  const limited = users.getHistory(u.username, 3);
  assert.strictEqual(limited.length, 3);
  const none = users.getHistory('nobody', 50);
  assert.deepStrictEqual(none, []);
});

test('注册后落盘，重新加载仍可校验（持久化）', async () => {
  users.registerUser('grace', 'passpass1');
  await users.flush(); // 等防抖保存落盘
  // 重新加载模块（清掉内存缓存，模拟重启）
  delete require.cache[require.resolve('../src/users')];
  const users2 = require('../src/users');
  users2.initUsers();
  assert.ok(users2.verifyUser('grace', 'passpass1'), '重启后账户应仍在');
  assert.strictEqual(users2.getUserByToken('invalid-token'), null);
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
});
