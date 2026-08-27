'use strict';

// ============ AI 决策模块单测 ============

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/ai');

const baseRoom = { settings: { allowTing: false } };

// 构造仅含单个座位决策所需字段的 game 快照
function makeGame(overrides = {}) {
  return Object.assign(
    {
      drawnTile: null,
      lastAction: null,
      tingSeats: [],
      hands: [[]],
      melds: [[]],
      discards: [[], [], [], []],
    },
    overrides
  );
}

// ============ AI 补杠约束（f71a90f 回归） ============
// Bug 背景：AI 碰牌后（drawnTile=null）暗杠/补杠分支仍可能返回 gang，
// 服务端 _gang 校验"当前不能杠"拒绝该动作，AI 无后续出牌导致牌局死锁。
// 约束：仅摸牌后（drawnTile 非 null）才允许 AI 返回杠。

test('AI 碰牌后（drawnTile=null）：即使有暗杠/补杠机会也不返回 gang', () => {
  // 手牌 11 张（碰后未摸牌）：含 4 张 w1（暗杠机会）+ 碰刻子 b5 及 1 张 b5（补杠机会）
  const game = makeGame({
    lastAction: { type: 'peng' },
    hands: [['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'b5']],
    melds: [[{ type: 'peng', tile: 'b5' }]],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.notEqual(act.type, 'gang', '碰牌后未摸牌不得返回杠，避免服务端拒动死锁');
  assert.equal(act.type, 'play', '应正常进入出牌分支');
});

test('AI 摸牌后（drawnTile 非 null）：暗杠机会仍可正常返回 gang', () => {
  // 14 张（摸牌后）：含 4 张 w1 暗杠机会，未构成胡牌、不满足报听
  const game = makeGame({
    drawnTile: 'b6',
    hands: [['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 't1', 't2', 't3', 'b6']],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.equal(act.type, 'gang', '摸牌后允许暗杠');
  assert.equal(act.gangType, 'angang');
});

test('AI 摸牌后（drawnTile 非 null）：补杠机会仍可正常返回 gang', () => {
  // 14 张（摸牌后）：碰刻子 b5 + 手牌含 1 张 b5 可补杠，未构成胡牌
  const game = makeGame({
    drawnTile: 't4',
    hands: [['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 'b5', 't1', 't2', 't3', 'b5', 't4']],
    melds: [[{ type: 'peng', tile: 'b5' }]],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.equal(act.type, 'gang', '摸牌后允许补杠');
  assert.equal(act.gangType, 'bugang');
});
