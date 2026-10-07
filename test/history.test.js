'use strict';
/**
 * 历史对局记录落盘钩子集成测试：验证 _endRound 收口处 _recordRoundHistory
 * 会为「有账户的玩家」写入本局战绩（增量 delta / 累计 / 是否胡牌）。
 * 仅调用原型方法，不实例化整个 GameServer，避免心跳等副作用。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-hist-'));
process.env.KD_DATA_DIR = tmpDir;

const users = require('../src/users');
const { GameServer } = require('../src/game');

test('整局结算时为有账户玩家落盘历史（游客不记）', async () => {
  users.registerUser('hist1', 'passpass1');
  const room = {
    settings: { variant: 'koudian' },
    roundNo: 3,
    id: '1234',
    game: { winners: { type: 'hu', winnerSeat: 1 } },
    players: [
      { name: 'A', seat: 0, account: null, roundScore: 5, score: 20 },       // 游客：不记
      { name: 'B', seat: 1, account: 'hist1', roundScore: -5, score: 10 },    // 座位1 = 胡牌者
      { name: 'C', seat: 2, account: 'hist1', roundScore: 10, score: 30 },    // 座位2
      { name: 'D', seat: 3, account: null, roundScore: 0, score: 0 },         // 游客：不记
    ],
  };
  GameServer.prototype._recordRoundHistory.call({}, room);
  await users.flush();
  const recs = users.getHistory('hist1', 50);
  assert.strictEqual(recs.length, 2, '应只记录有账户的 B、C 两人');
  // getHistory 倒序：最新在前（C 后写入 → 在前）
  assert.strictEqual(recs[0].roundNo, 3);
  assert.strictEqual(recs[0].variant, 'koudian');
  assert.strictEqual(recs[0].isWin, false); // C 是座位2，非胡牌
  assert.strictEqual(recs[1].isWin, true);  // B 是座位1 = 胡牌者
  assert.strictEqual(recs[1].delta, -5);
});

test('流局（draw）也会记录，且 isWin 为 false', async () => {
  const room = {
    settings: { variant: 'hongzhong' },
    roundNo: 1,
    id: '5678',
    game: { winners: { type: 'draw' } },
    players: [
      { name: 'B', account: 'hist1', roundScore: 0, score: 10 },
      null, null, null,
    ],
  };
  GameServer.prototype._recordRoundHistory.call({}, room);
  await users.flush();
  const recs = users.getHistory('hist1', 50);
  assert.ok(recs.some((r) => r.type === 'draw' && r.isWin === false));
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
});
