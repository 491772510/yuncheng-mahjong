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

// ============ D5 补丁：报听选牌质量 / 点数 / 剩余张数 / 清一色 / 抢杠规避 ============
// 对应审查报告 D1-D4 修复，全部使用固定牌例（不依赖随机），node --test 可直接回归。

const rules = require('../src/rules');
// 允许报听且关闭所有开关型倍数的房间设置（默认乘算模型）
const tingRoom = { settings: { allowTing: true, enableQingYiSe: false, enableYiTiaoLong: false, enableShiSanYao: false } };

test('D1 报听选牌按期望择优：不取牌序第一个满足≥6点的弃牌', () => {
  // 审查报告 probe 用例 1：扣 b9 听 [b7,b8]（期望 52）应优于扣 t7 听 [b7]（期望 28）
  const game = makeGame({
    drawnTile: 'b9',
    hands: [['t1', 't2', 't2', 't3', 't3', 't4', 't7', 't7', 't7', 'b6', 'b6', 'b6', 'b8', 'b9']],
  });

  const act = ai.decideDrawAction(game, tingRoom, 0);
  assert.equal(act.type, 'ting', '应报听');
  assert.equal(act.tile, 'b9', '应扣 b9（听 b7/b8，期望 52），而非牌序靠前的 t7（期望 28）');
});

test('D1 报听排除死听口：一张都胡不到的弃牌不被选中', () => {
  // 扣 b9 后只听 [b8]，但桌面已见 4 张 b8 → 死听口；扣 w1 听 [b7]（活听口）应被选中
  const game = makeGame({
    drawnTile: 'b8',
    hands: [['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w1', 'w1', 'w1', 'b9', 'b8']],
    discards: [[], ['b8', 'b8', 'b8', 'b8'], [], []],
  });

  const act = ai.decideDrawAction(game, tingRoom, 0);
  assert.equal(act.type, 'ting', '应报听（存在活听口）');
  assert.notEqual(act.tile, 'b9', '扣 b9 听 [b8] 已绝张（桌面 4 张 b8 全见），死听口必须被排除');
  assert.ok(['w1', 'b8'].includes(act.tile), `应选活听口（w1/b8），实际为 ${act.tile}`);
});

test('D1 剩余张数精确统计：remainingCount 计入手牌/桌面已见/明牌区，忽略 back 暗扣', () => {
  // 手牌持 2 张 w1；桌面已见 1 张 w1（back 不计）→ 剩余 1
  const g = makeGame({ hands: [['w1', 'w1']], discards: [['w1', 'back'], [], [], []] });
  assert.equal(rules.remainingCount(g, 0, 'w1'), 1, '4-2(手牌)-1(桌面)=1，back 不计');
  // 明牌区（含暗杠第 4 张）也计入已见
  const g2 = makeGame({
    hands: [['w9']],
    melds: [[{ type: 'angang', tile: 'w9', tiles: ['w9', 'w9', 'w9', 'w9'] }]],
  });
  assert.equal(rules.remainingCount(g2, 0, 'w9'), 0, '暗杠第 4 张在明牌区，w9 已绝张');
});

test('D3 报听考虑清一色倍数：清一色射程内选择期望最高的清一色扣法', () => {
  // 14 张全筒（任意扣法后 13 张仍全筒）：清一色 ×4 放大后扣 b1（期望 332）为最优
  const room = {
    settings: { allowTing: true, enableQingYiSe: true, qingYiSeMult: 4, enableYiTiaoLong: false, enableShiSanYao: false },
  };
  const game = makeGame({
    drawnTile: 'b7',
    hands: [['b1', 'b1', 'b1', 'b1', 'b2', 'b2', 'b2', 'b3', 'b3', 'b3', 'b4', 'b5', 'b6', 'b7']],
  });

  const act = ai.decideDrawAction(game, room, 0);
  assert.equal(act.type, 'ting', '应报听');
  assert.equal(act.tile, 'b1', '清一色射程内应扣 b1（期望 332）而非其他扣法');
});

test('D2 补杠抢杠规避：报听对手等该张时不补杠', () => {
  // 座位 0 碰 w9 + 手牌 1 张 w9（可补杠）；座位 1 已报听，手牌 13 张听 w9（qianggang 9 点可抢）
  const game = makeGame({
    drawnTile: 'w9',
    hands: [
      ['w9', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 't1', 't2', 't3', 't9'],
      ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w9', 'w9', 't9', 't9'],
    ],
    melds: [[{ type: 'peng', tile: 'w9' }], []],
    tingSeats: [1],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.notEqual(act.type, 'gang', '报听对手等 w9，补杠会送抢杠，必须跳过');
  assert.equal(act.type, 'play', '应正常出牌');
});

test('D2 补杠正常（对照）：无报听对手等该张时仍正常补杠', () => {
  const game = makeGame({
    drawnTile: 'w9',
    hands: [
      ['w9', 'w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 't1', 't2', 't3', 't9'],
      ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w9', 'w9', 't9', 't9'],
    ],
    melds: [[{ type: 'peng', tile: 'w9' }], []],
    tingSeats: [],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.equal(act.type, 'gang', '无抢杠风险时允许补杠');
  assert.equal(act.gangType, 'bugang');
});

test('D4 暗杠降级：手牌对子单位≥6 且未报听时不暗杠 4 张同牌', () => {
  // w1×4 + w2~w6 各一对：对子单位 = 2+1+1+1+1+1 = 7 ≥6，七小对/豪七在射程内 → 不应暗杠 w1
  const game = makeGame({
    drawnTile: 'w6',
    hands: [['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 'w5', 'w5', 'w6', 'w6']],
  });

  const act = ai.decideDrawAction(game, baseRoom, 0);
  assert.notEqual(act.type, 'gang', '七小对在射程内，暗杠破坏对子结构，必须放弃');
  assert.equal(act.type, 'play', '应正常出牌');
});
