'use strict';
// 账号设置：修改显示昵称 / 修改密码 / 注销账号
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离持久化目录：避免污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-account-'));
process.env.KD_DATA_DIR = tmpDir;

const users = require('../src/users');

function uniq() { return 'a' + Math.random().toString(36).slice(2, 10); }

test('修改显示昵称：成功更新 + 登录用户名不变 + 空昵称拒绝', async () => {
  const u = uniq();
  users.registerUser(u, 'password1', '旧昵称');
  const pub = users.changeDisplayName(u, '新昵称');
  assert.equal(pub.displayName, '新昵称');
  assert.equal(pub.username, u); // username 主键不变
  // 重新登录后 displayName 为新昵称
  const login = users.verifyUser(u, 'password1');
  assert.equal(login.username, u);
  assert.equal(login.displayName, '新昵称');
  // 空昵称拒绝
  assert.throws(() => users.changeDisplayName(u, '   '), (e) => e.code === 'PARAM');
  // 超过 12 字截断
  const pub2 = users.changeDisplayName(u, '一'.repeat(20));
  assert.equal(pub2.displayName, '一'.repeat(12));
});

test('修改密码：旧密码错误拒绝 + 弱新密码拒绝 + 成功后旧密码失效新密码可登录', async () => {
  const u = uniq();
  users.registerUser(u, 'oldpass', '甲');
  // 旧密码错误
  assert.throws(() => users.changePassword(u, 'wrong', 'newpass1'), (e) => e.code === 'AUTH_INVALID');
  // 新密码太弱
  assert.throws(() => users.changePassword(u, 'oldpass', '12345'), (e) => e.code === 'AUTH_WEAK');
  // 成功改密
  assert.equal(users.changePassword(u, 'oldpass', 'newpass1'), true);
  assert.equal(users.verifyUser(u, 'oldpass'), null);
  assert.ok(users.verifyUser(u, 'newpass1'));
});

test('注销账号：无法再登录 + 历史文件删除 + 好友关系清空 + 排行榜消失', async () => {
  const a = uniq();
  const b = uniq();
  const c = uniq();
  users.registerUser(a, 'password1', '甲');
  users.registerUser(b, 'password1', '乙');
  users.registerUser(c, 'password1', '丙');

  // 好友关系：a 与 b 互为好友；a 向 c 发出 pending 请求
  users.sendFriendRequest(a, b);
  users.acceptFriendRequest(b, a);
  users.sendFriendRequest(a, c);
  assert.equal(users.listFriends(a).length, 1);
  assert.equal(users.listFriends(b).length, 1);
  assert.ok(users.listIncomingRequests(c).find((x) => x.username === a), 'c 收到 a 的请求');

  // 历史对局记录
  users.appendHistory(a, { t: Date.now(), variant: 'koudian', delta: 10, total: 10, isWin: true, type: 'hu' });
  await users.flush();

  // 会话 token
  const token = users.issueToken(a);
  assert.ok(users.getUserByToken(token));

  users.deleteAccount(a);
  await users.flush();

  // 账号已删除，无法再登录；token 被清
  assert.equal(users.hasUser(a), false);
  assert.equal(users.verifyUser(a, 'password1'), null);
  assert.equal(users.getUserByToken(token), null);

  // 历史对局文件被删除
  const histFile = path.join(tmpDir, 'history', a + '.jsonl');
  assert.equal(fs.existsSync(histFile), false);

  // 好友关系清空（双向解除 + pending 请求移除）
  assert.equal(users.listFriends(b).length, 0);
  assert.equal(users.listIncomingRequests(c).find((x) => x.username === a), undefined);

  // 排行榜不再出现该用户
  const lb = users.getLeaderboard(100);
  assert.equal(lb.find((x) => x.username === a), undefined);
});
