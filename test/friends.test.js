'use strict';
// 好友系统：请求 / 互加 / 接受 / 删除
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离持久化目录：避免污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-friends-'));
process.env.KD_DATA_DIR = tmpDir;

const users = require('../src/users');

function uniq() { return 'f' + Math.random().toString(36).slice(2, 10); }

test('好友请求→接受→互为好友；删除后解除', async () => {
  const a = uniq();
  const b = uniq();
  users.registerUser(a, 'password1', '甲友');
  users.registerUser(b, 'password1', '乙友');

  // a 向 b 发请求
  const r1 = users.sendFriendRequest(a, b);
  assert.equal(r1.ok, true);
  // 重复请求不应再产生 pending
  const r1b = users.sendFriendRequest(a, b);
  assert.equal(r1b.already, true);
  // b 的 incoming 含 a
  const inc = users.listIncomingRequests(b);
  assert.ok(inc.find((x) => x.username === a), 'b 收到 a 的请求');

  // b 接受
  const ok = users.acceptFriendRequest(b, a);
  assert.equal(ok, true);
  assert.ok(users.listFriends(a).find((x) => x.username === b), 'a 的好友含 b');
  assert.ok(users.listFriends(b).find((x) => x.username === a), 'b 的好友含 a');
  assert.equal(users.listIncomingRequests(b).length, 0, '接受后 pending 清空');

  // 删除好友（双向解除）
  users.removeFriend(a, b);
  assert.equal(users.listFriends(a).length, 0);
  assert.equal(users.listFriends(b).length, 0);
});

test('双向 pending 自动互加', async () => {
  const a = uniq();
  const b = uniq();
  users.registerUser(a, 'password1', '甲');
  users.registerUser(b, 'password1', '乙');
  users.sendFriendRequest(a, b);
  const r = users.sendFriendRequest(b, a); // b 也向 a 发，应自动互加
  assert.equal(r.autoAccepted, true);
  assert.ok(users.listFriends(a).find((x) => x.username === b));
});
