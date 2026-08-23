'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/rules');

test('createTiles 生成 108 张牌，每种牌 4 张', () => {
  const tiles = rules.createTiles();
  assert.equal(tiles.length, 108);
  const cnt = rules.countTiles(tiles);
  assert.equal(cnt.size, 27);
  for (const c of cnt.values()) assert.equal(c, 4);
});

test('shuffle 返回同集合的随机排列', () => {
  const tiles = rules.createTiles();
  const shuffled = rules.shuffle(tiles, () => 0.42);
  assert.equal(shuffled.length, 108);
  assert.deepEqual(new Set(shuffled), new Set(tiles));
  // 原数组不被修改
  assert.equal(tiles.length, 108);
});

test('sortTiles 按 万<条<筒、数字升序 排序', () => {
  const sorted = rules.sortTiles(['b9', 'w5', 't1', 'w1', 'b1', 't9']);
  assert.deepEqual(sorted, ['w1', 'w5', 't1', 't9', 'b1', 'b9']);
});

test('checkHu 平胡成立', () => {
  // 123万 456万 789万 222条 55条
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.checkHu(hand), true);
});

test('checkHu 不成立（缺将）', () => {
  // 123万 456万 789万 123条 56条（14张但剩 56 不成对）
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't2', 't3', 't5', 't6'];
  assert.equal(rules.checkHu(hand), false);
});

test('checkHu 七对成立', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2', 't3', 't3'];
  assert.equal(rules.checkHu(hand), true);
});

test('checkHu 碰碰胡成立', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 't5', 't5'];
  assert.equal(rules.checkHu(hand), true);
});

test('isQiDui / isLuxuryQiDui', () => {
  const qiDui = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2', 't3', 't3'];
  assert.equal(rules.isQiDui(qiDui), true);
  assert.equal(rules.isLuxuryQiDui(qiDui), false);

  const luxury = ['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2'];
  assert.equal(rules.isQiDui(luxury), true);
  assert.equal(rules.isLuxuryQiDui(luxury), true);
});

test('isPengPengHu', () => {
  const pph = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 't5', 't5'];
  assert.equal(rules.isPengPengHu(pph), true);
  // 平胡（含顺子）不是碰碰胡
  const pingHu = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.isPengPengHu(pingHu), false);
});

test('canPeng / canGang / canAnGang / canBuGang', () => {
  const hand = ['w5', 'w5', 't3', 't3', 't3', 'b7', 'b7', 'b7', 'b7'];
  assert.equal(rules.canPeng(hand, 'w5'), true);
  assert.equal(rules.canPeng(hand, 't3'), true);
  assert.equal(rules.canPeng(hand, 'b7'), true);
  assert.equal(rules.canPeng(hand, 'w1'), false);

  assert.equal(rules.canGang(hand, 't3'), true);
  assert.equal(rules.canGang(hand, 'b7'), true);
  assert.equal(rules.canGang(hand, 'w5'), false);

  assert.equal(rules.canAnGang(hand, 'b7'), true);
  assert.equal(rules.canAnGang(hand, 't3'), false);

  const melds = [{ type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] }];
  assert.equal(rules.canBuGang(hand, melds, 't3'), true);
  assert.equal(rules.canBuGang(hand, melds, 'b7'), false);
  assert.equal(rules.canBuGang(['w1'], melds, 't3'), false);
});

test('canHuWith 点炮判定', () => {
  // 13 张：123万 456万 789万 222条 5条，听 5条
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5'];
  assert.equal(rules.canHuWith(hand, 't5'), true);
  assert.equal(rules.canHuWith(hand, 't3'), false);
});

test('isTing 听牌检测', () => {
  // 13 张听 5条
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5'];
  const ting = rules.isTing(hand);
  assert.ok(ting.includes('t5'));
  assert.equal(ting.length, 1);

  // 未听牌
  const notTing = ['w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't9'];
  assert.equal(rules.isTing(notTing).length, 0);
});

test('calcFan 平胡 1 番', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds: [] }), 1);
});

test('calcFan 碰碰胡 2 番', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 't5', 't5'];
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds: [] }), 2);
});

test('calcFan 清一色 3 番', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w1', 'w1', 'w1', 'w5', 'w5'];
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds: [] }), 3);
});

test('calcFan 清一色碰碰胡叠加 4 番', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 'w5', 'w5'];
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds: [] }), 4);
});

test('calcFan 七对 2 番、豪华七对 4 番', () => {
  const qiDui = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2', 't3', 't3'];
  assert.equal(rules.calcFan(qiDui, { winType: 'zimo', melds: [] }), 2);

  const luxury = ['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2'];
  assert.equal(rules.calcFan(luxury, { winType: 'zimo', melds: [] }), 4);
});

test('calcFan 杠上开花 / 抢杠胡 / 海底捞月 各 +1 番', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.calcFan(hand, { winType: 'zimo', gangShang: true, melds: [] }), 2);
  assert.equal(rules.calcFan(hand, { winType: 'qianggang', qiangGang: true, melds: [] }), 2);
  assert.equal(rules.calcFan(hand, { winType: 'zimo', haiDi: true, melds: [] }), 2);
});

test('calcFan 明牌区碰/杠不影响平胡基础判定且计入清一色', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const melds = [{ type: 'peng', tile: 'b1', tiles: ['b1', 'b1', 'b1'] }];
  // 明牌区有筒，非清一色
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds }), 1);
});

test('calcScore 底分 × 番数，封顶生效', () => {
  assert.equal(rules.calcScore(1, 2, 0), 2);
  assert.equal(rules.calcScore(2, 3, 0), 6);
  assert.equal(rules.calcScore(5, 1, 0), 5);
  assert.equal(rules.calcScore(10, 4, 0), 40);
  // 封顶 4
  assert.equal(rules.calcScore(2, 4, 4), 8);
  assert.equal(rules.calcScore(2, 6, 4), 8);
  // 封顶 8 / 16
  assert.equal(rules.calcScore(1, 9, 8), 8);
  assert.equal(rules.calcScore(1, 9, 16), 9);
});

test('canDeclareTing 听牌可报听（打出某张后仍听牌）', () => {
  // 14 张（摸牌后）：123万 456万 789万 222条 55条，打出任意顺子张仍听牌
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.canDeclareTing(hand), true);
});

test('canDeclareTing 非听牌状态不可报听', () => {
  const hand = ['w1', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't9', 'b1'];
  assert.equal(rules.canDeclareTing(hand), false);
});

test('calcFan 听口自摸 +1 番并计入番型名', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  // 平胡自摸 1 番，听口 +1 → 2 番
  assert.equal(rules.calcFan(hand, { winType: 'zimo', melds: [], tingKou: true }), 2);
  const fan = rules.calcFan(hand, { winType: 'zimo', melds: [], tingKou: true }, true);
  assert.ok(fan.names.includes('听口'));
});

// ============ 136 带风带箭牌型 ============

test('createTiles 136 张：万条筒+东南西北中发白各4张', () => {
  const tiles = rules.createTiles('136');
  assert.equal(tiles.length, 136);
  const cnt = rules.countTiles(tiles);
  assert.equal(cnt.size, 34);
  for (const c of cnt.values()) assert.equal(c, 4);
  // 默认仍为 108
  assert.equal(rules.createTiles().length, 108);
});

test('getTileTypes 136 含字牌、108 不含字牌', () => {
  const t108 = rules.getTileTypes('108');
  const t136 = rules.getTileTypes('136');
  assert.ok(!t108.includes('e'));
  assert.ok(!t108.includes('z'));
  assert.ok(t136.includes('e'));
  assert.ok(t136.includes('z'));
  assert.ok(t136.includes('p'));
  assert.equal(t136.length, 34);
});

test('tileName 字牌返回汉字', () => {
  assert.equal(rules.tileName('e'), '东');
  assert.equal(rules.tileName('s'), '南');
  assert.equal(rules.tileName('x'), '西');
  assert.equal(rules.tileName('n'), '北');
  assert.equal(rules.tileName('z'), '中');
  assert.equal(rules.tileName('f'), '发');
  assert.equal(rules.tileName('p'), '白');
});

test('checkHu 字牌仅能作刻子或将对（四风刻+箭对将）', () => {
  // 东东东 南南南 西西西 北北北 中发 白（将）—— 4 刻 + 1 将
  const hand = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'n', 'n', 'n', 'p', 'p'];
  assert.equal(rules.checkHu(hand), true);
  // 字牌不能成顺子：东东南（14 张中凑不出合法面子）应为 false
  const bad = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'n', 'n', 'n', 'e', 's'];
  assert.equal(rules.checkHu(bad), false);
});

test('checkHu 七对含字牌成立', () => {
  const hand = ['e', 'e', 's', 's', 'x', 'x', 'n', 'n', 'z', 'z', 'f', 'f', 'p', 'p'];
  assert.equal(rules.checkHu(hand), true);
});

test('calcFan 清一色判定排除字牌', () => {
  // 万清一色 + 中中中 作刻子：整体非清一色（字牌非万）
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'z', 'z', 'z', 't5', 't5'];
  const fan = rules.calcFan(hand, { winType: 'zimo', melds: [], tingKou: false }, true);
  assert.ok(!fan.names.includes('清一色'));
});

test('isTing 136 牌型听字牌', () => {
  // 东东东 南南南 西西西 白白（将） 中中（13张），听 中 成刻
  const hand = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'p', 'p', 'z', 'z'];
  const ting = rules.isTing(hand, '136');
  assert.ok(ting.includes('z'));
});

test('canDeclareTing 136 牌型字牌可报听', () => {
  // 摸牌后 14 张：东东东 南南南 西西西 白白 中中 东（冗余），打出冗余东后听中
  const hand = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'p', 'p', 'z', 'z', 'e'];
  assert.equal(rules.canDeclareTing(hand, '136'), true);
});
