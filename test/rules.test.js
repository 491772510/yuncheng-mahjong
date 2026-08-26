'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/rules');

// ============ 136 张牌墙 ============

test('createTiles 生成 136 张牌，34 种各 4 张（万条筒+东南西北中发白）', () => {
  const tiles = rules.createTiles();
  assert.equal(tiles.length, 136);
  const cnt = rules.countTiles(tiles);
  assert.equal(cnt.size, 34);
  for (const c of cnt.values()) assert.equal(c, 4);
  // 含全部字牌
  for (const t of ['e', 's', 'x', 'n', 'z', 'f', 'p']) assert.ok(cnt.has(t));
});

test('shuffle 返回同集合的随机排列', () => {
  const tiles = rules.createTiles();
  const shuffled = rules.shuffle(tiles, () => 0.42);
  assert.equal(shuffled.length, 136);
  assert.deepEqual(new Set(shuffled), new Set(tiles));
  // 原数组不被修改
  assert.equal(tiles.length, 136);
});

test('getTileTypes 136 含字牌，共 34 种', () => {
  const t = rules.getTileTypes();
  assert.ok(t.includes('e'));
  assert.ok(t.includes('z'));
  assert.ok(t.includes('p'));
  assert.equal(t.length, 34);
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

test('sortTiles 按 万<条<筒、数字升序、字牌最后 排序', () => {
  const sorted = rules.sortTiles(['b9', 'w5', 't1', 'w1', 'e', 'b1', 't9', 'z']);
  assert.deepEqual(sorted, ['w1', 'w5', 't1', 't9', 'b1', 'b9', 'e', 'z']);
});

// ============ 胡牌判定 ============

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

test('isTing 136 牌型听字牌', () => {
  // 东东东 南南南 西西西 白白（将） 中中（13张），听 中 成刻
  const hand = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'p', 'p', 'z', 'z'];
  const ting = rules.isTing(hand);
  assert.ok(ting.includes('z'));
});

// ============ 136 扣点点新规则 ============

test('tilePoints 数牌按面值、字牌 10 点', () => {
  assert.equal(rules.tilePoints('w1'), 1);
  assert.equal(rules.tilePoints('t9'), 9);
  assert.equal(rules.tilePoints('b5'), 5);
  assert.equal(rules.tilePoints('e'), 10);
  assert.equal(rules.tilePoints('s'), 10);
  assert.equal(rules.tilePoints('x'), 10);
  assert.equal(rules.tilePoints('n'), 10);
  assert.equal(rules.tilePoints('z'), 10);
  assert.equal(rules.tilePoints('f'), 10);
  assert.equal(rules.tilePoints('p'), 10);
});

test('canHuByPoints 胡牌点数限制', () => {
  // 1/2 点：任何方式都不能胡
  assert.equal(rules.canHuByPoints(1, 'zimo'), false);
  assert.equal(rules.canHuByPoints(1, 'dianpao'), false);
  assert.equal(rules.canHuByPoints(2, 'zimo'), false);
  assert.equal(rules.canHuByPoints(2, 'dianpao'), false);
  // 3/4/5 点：只能自摸
  assert.equal(rules.canHuByPoints(3, 'zimo'), true);
  assert.equal(rules.canHuByPoints(3, 'dianpao'), false);
  assert.equal(rules.canHuByPoints(5, 'zimo'), true);
  assert.equal(rules.canHuByPoints(5, 'dianpao'), false);
  // 6 点及以上 / 字牌(10)：可点炮可自摸
  assert.equal(rules.canHuByPoints(6, 'zimo'), true);
  assert.equal(rules.canHuByPoints(6, 'dianpao'), true);
  assert.equal(rules.canHuByPoints(10, 'dianpao'), true);
});

test('canDeclareTing136 硬性条件：听口含 ≥6 点牌', () => {
  // 只听小点数：123万 123条 123筒 222万 55万 → 任何打法听口均 ≤5 点，不可报听
  const handLow = ['w1', 'w2', 'w3', 't1', 't2', 't3', 'b1', 'b2', 'b3', 'w2', 'w2', 'w2', 'w5', 'w5'];
  assert.equal(rules.canDeclareTing136(handLow), false);
  // 听 6 条（6 点）可报听
  const hand6 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't6', 't6'];
  assert.equal(rules.canDeclareTing136(hand6), true);
  // 听字牌（10 点）可报听
  const handZ = ['e', 'e', 'e', 's', 's', 's', 'x', 'x', 'x', 'p', 'p', 'z', 'z', 'e'];
  assert.equal(rules.canDeclareTing136(handZ), true);
});

test('calcMultiplier136 平胡/碰碰胡/七对/豪华七对/杠上开花', () => {
  const ping = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const pp = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 'w4', 'w4', 'w4', 't5', 't5'];
  const qd = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2', 't3', 't3'];
  const lx = ['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 'w4', 'w4', 't1', 't1', 't2', 't2'];

  assert.equal(rules.calcMultiplier136(ping, { winType: 'zimo', melds: [] }, {}), 1);
  assert.equal(rules.calcMultiplier136(pp, { winType: 'zimo', melds: [] }, {}), 2);
  assert.equal(rules.calcMultiplier136(qd, { winType: 'zimo', melds: [] }, {}), 4);
  assert.equal(rules.calcMultiplier136(lx, { winType: 'zimo', melds: [] }, {}), 8);
  // 杠上开花 ×2 与平胡叠加
  assert.equal(
    rules.calcMultiplier136(ping, { winType: 'zimo', gangShang: true, melds: [] }, {}),
    2
  );
});

test('calcMultiplier136 开关型倍数：清一色/一条龙/十三幺', () => {
  const qing = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w1', 'w1', 'w1', 'w5', 'w5'];
  // 关闭时不算
  assert.equal(rules.calcMultiplier136(qing, { winType: 'zimo', melds: [] }, {}), 1);
  // 开启 ×4
  const r = rules.calcMultiplier136(
    qing,
    { winType: 'zimo', melds: [] },
    { qingyise: { enabled: true, mult: 4 } },
    true
  );
  assert.equal(r.mult, 4);
  assert.ok(r.names.includes('清一色'));

  // 一条龙：123456789万 + 任意面子
  const long = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const r2 = rules.calcMultiplier136(
    long,
    { winType: 'zimo', melds: [] },
    { yitiaolong: { enabled: true, mult: 4 } },
    true
  );
  assert.equal(r2.mult, 4);
  assert.ok(r2.names.includes('一条龙'));

  // 十三幺：13 种幺九各 1 + 1 对
  const yao = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'p', 'w1'];
  const r3 = rules.calcMultiplier136(
    yao,
    { winType: 'zimo', melds: [] },
    { shisanyao: { enabled: true, mult: 8 } },
    true
  );
  assert.equal(r3.mult, 8);
  assert.ok(r3.names.includes('十三幺'));
});

test('isShiSanYao 判定', () => {
  const ok = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'p', 'w1'];
  assert.equal(rules.isShiSanYao(ok), true);
  const bad = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'w2', 'w1'];
  assert.equal(rules.isShiSanYao(bad), false);
});

test('isYiTiaoLong 判定（手牌+明牌区同花色 1-9 齐全）', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.isYiTiaoLong(hand, []), true);
  // 缺 9 万不是一条龙
  const no9 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't2', 't2', 't2', 't5', 't5', 'w5'];
  assert.equal(rules.isYiTiaoLong(no9, []), false);
});
