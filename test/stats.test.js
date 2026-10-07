'use strict';
// 战绩统计与排行榜：聚合 history jsonl
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离持久化目录：避免污染真实 data/，也避免历史测试账号占满排行榜前 20 名
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-stats-'));
process.env.KD_DATA_DIR = tmpDir;

const users = require('../src/users');

function uniq() { return 's' + Math.random().toString(36).slice(2, 10); }

test('getUserStats 聚合胜率/净积分/单局最佳；getLeaderboard 按净积分降序', async () => {
  const a = uniq();
  const b = uniq();
  // a：两胜一负，净积分 +30 / -10
  users.registerUser(a, 'password1', '阿甲');
  users.appendHistory(a, { t: Date.now(), variant: 'koudian', roundNo: 1, delta: 20, total: 20, isWin: true, type: 'hu' });
  users.appendHistory(a, { t: Date.now(), variant: 'koudian', roundNo: 2, delta: 10, total: 30, isWin: true, type: 'hu' });
  users.appendHistory(a, { t: Date.now(), variant: 'hongzhong', roundNo: 3, delta: -10, total: 20, isWin: false, type: 'hu' });
  // b：一胜，净积分 +50
  users.registerUser(b, 'password1', '乙乙');
  users.appendHistory(b, { t: Date.now(), variant: 'tiejin', roundNo: 1, delta: 50, total: 50, isWin: true, type: 'hu' });

  await users.flush();

  const sa = users.getUserStats(a);
  assert.equal(sa.games, 3);
  assert.equal(sa.wins, 2);
  assert.equal(sa.losses, 1);
  assert.equal(sa.draws, 0);
  assert.equal(sa.winRate, 2 / 3);
  assert.equal(sa.totalScore, 20); // 20+10-10
  assert.equal(sa.bestRound, 20);
  assert.equal(sa.byVariant.koudian, 30);
  assert.equal(sa.byVariant.hongzhong, -10);

  const lb = users.getLeaderboard(20);
  const rowA = lb.find((r) => r.username === a);
  const rowB = lb.find((r) => r.username === b);
  assert.ok(rowA && rowB, '排行榜含两名用户');
  assert.equal(rowB.score, 50);
  assert.equal(rowA.score, 20);
  // 降序：b(+50) 排在 a(+20) 前面
  assert.ok(lb.indexOf(rowB) < lb.indexOf(rowA), '按净积分降序');
});
