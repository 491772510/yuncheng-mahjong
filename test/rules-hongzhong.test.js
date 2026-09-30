'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/rules');

// ============ 112 张牌墙 ============

test('createTiles112 生成 112 张牌：万筒条 1-9 各 4 + 红中 4，无风牌', () => {
  const tiles = rules.createTiles112();
  assert.equal(tiles.length, 112);
  const cnt = rules.countTiles(tiles);
  assert.equal(cnt.size, 28);
  for (const c of cnt.values()) assert.equal(c, 4);
  assert.equal(cnt.get('z0'), 4);
  // 无字牌（东南西北中发白）
  for (const t of ['e', 's', 'x', 'n', 'z', 'f', 'p']) assert.ok(!cnt.has(t));
});

test('红中 z0 编码：suit=z rank=0 名称红中', () => {
  assert.equal(rules.suitOf('z0'), 'z');
  assert.equal(rules.numOf('z0'), 0);
  assert.equal(rules.tileName('z0'), '红中');
  assert.ok(rules.isHongZhong('z0'));
  assert.ok(!rules.isHongZhong('w1'));
  // 红中排最前（rank=0，通过排序验证）
  assert.deepEqual(rules.sortTiles(['w1', 'z0', 'b9', 't5']), ['z0', 'w1', 't5', 'b9']);
  // 28 种牌型
  const types = rules.getHongZhongTileTypes();
  assert.equal(types.length, 28);
  assert.ok(types.includes('z0'));
  assert.ok(types.includes('w9'));
  assert.ok(!types.includes('z'));
});

// ============ 癞子胡牌判定 ============

test('checkHuHongZhong 平胡成立（无癞子，123万456万789万 222条 55条）', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.checkHuHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand, [], { need258Eye: true }), true); // 将 5 满足二五八
});

test('checkHuHongZhong 红中补顺子', () => {
  // 123w(红中补3) 456w 789w 222t 55t
  const hand = ['w1', 'w2', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('checkHuHongZhong 红中补刻子', () => {
  // 123w 456w 789w + t1t1+红中成刻 + t5t5 将
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 't5', 't5', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('checkHuHongZhong 红中补将（1 真 + 1 红中）', () => {
  // 123w 456w 789w 222t + t5 + z0 作将
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('checkHuHongZhong 2 张红中作将', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 'z0', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('checkHuHongZhong 不成立（缺牌且红中不够补）', () => {
  // 需 2 张红中补两处，实际只有 1 张
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't1', 't2', 't4', 't5', 't6', 't6', 'b1', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), false);
  // 平胡缺将
  const hand2 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't4', 't5'];
  assert.equal(rules.checkHuHongZhong(hand2), false);
});

test('canHuHongZhongWith 摸某张是否成胡', () => {
  const hand13 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5'];
  assert.equal(rules.canHuHongZhongWith(hand13, 't5'), true);
  assert.equal(rules.canHuHongZhongWith(hand13, 'w1'), false);
});

test('isTingHongZhong 听口含 5条', () => {
  const hand13 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5'];
  const ting = rules.isTingHongZhong(hand13);
  assert.ok(ting.includes('t5'));
  assert.ok(!ting.includes('w1'));
});

// ============ 七小对 / 龙七对 ============

test('七小对成立（无红中）', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't1', 't1', 't2', 't2', 't3', 't3', 'b1', 'b1'];
  assert.equal(rules.isQiDuiHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('七小对成立（红中两两成对）', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't1', 't1', 't2', 't2', 'b1', 'b1', 'z0', 'z0'];
  assert.equal(rules.isQiDuiHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('七小对成立（红中补单张凑对）', () => {
  // 5 对 + t3 + 3 红中（t3+红中 1 对、红中+红中 1 对）
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't1', 't1', 't2', 't2', 't3', 'z0', 'z0', 'z0'];
  assert.equal(rules.isQiDuiHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('龙七对成立（3 真 + 1 红中成四张）', () => {
  const hand = ['w1', 'w1', 'w1', 'z0', 'w2', 'w2', 't1', 't1', 't2', 't2', 't3', 't3', 't4', 't4'];
  assert.equal(rules.isLongQiDuiHongZhong(hand), true);
  assert.equal(rules.isQiDuiHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('龙七对成立（2 真 + 2 红中成四张）', () => {
  const hand = ['w1', 'w1', 'z0', 'z0', 'w2', 'w2', 't1', 't1', 't2', 't2', 't3', 't3', 't4', 't4'];
  assert.equal(rules.isLongQiDuiHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('普通七对不是龙七对', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't1', 't1', 't2', 't2', 't3', 't3', 'b1', 'b1'];
  assert.equal(rules.isQiDuiHongZhong(hand), true);
  assert.equal(rules.isLongQiDuiHongZhong(hand), false);
});

// ============ 碰碰胡 / 清一色 / 混一色 ============

test('碰碰胡成立（无癞子，4 刻 + 1 将）', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 't1', 't1', 't1', 't2', 't2', 't2', 't3', 't3'];
  assert.equal(rules.isPengPengHuHongZhong(hand), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('碰碰胡成立（红中补刻）', () => {
  // w1刻 w2刻 t1t1+红中成刻 t2刻 t3t3 将
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 't1', 't1', 't2', 't2', 't2', 't3', 't3', 'z0'];
  assert.equal(rules.isPengPengHuHongZhong(hand, [], 1), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('碰碰胡成立（2 红中作将）', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 't1', 't1', 't1', 't2', 't2', 't2', 'z0', 'z0'];
  assert.equal(rules.isPengPengHuHongZhong(hand, [], 2), true);
  assert.equal(rules.checkHuHongZhong(hand), true);
});

test('清一色判定', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w2', 'w2', 'w2', 'w5', 'w5'];
  assert.equal(rules.checkHuHongZhong(hand), true);
  assert.equal(rules.isQingYiSeHongZhong(hand), true);
  assert.equal(rules.isHunYiSeHongZhong(hand), false);
});

test('混一色判定（一门 + 红中）', () => {
  // 123w 456w 789w 222w + 5w+红中作将
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w2', 'w2', 'w2', 'w5', 'z0'];
  assert.equal(rules.checkHuHongZhong(hand), true);
  assert.equal(rules.isHunYiSeHongZhong(hand), true);
  assert.equal(rules.isQingYiSeHongZhong(hand), false);
});

test('带明牌区（碰/杠刻子）胡牌判定', () => {
  // 暗杠 w9 + 手牌 123w 456w 222t 55t（11 张）
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't2', 't2', 't2', 't5', 't5'];
  const melds = [{ type: 'angang', tile: 'w9', tiles: ['w9', 'w9', 'w9', 'w9'] }];
  assert.equal(rules.checkHuHongZhong(hand, melds), true);
  // 明牌区红中杠（红中在明牌区不算癞子）
  const melds2 = [{ type: 'gang', tile: 'z0', tiles: ['z0', 'z0', 'z0'] }];
  assert.equal(rules.checkHuHongZhong(hand, melds2), true);
});

// ============ 二五八将开关 ============

test('二五八将：平胡将对非 2/5/8 时不可胡，对 2/5/8 时可胡', () => {
  // 123w 456w 789w 222t + w1w1 将（非 258）
  const badEye = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 'w1', 'w1'];
  assert.equal(rules.checkHuHongZhong(badEye), true); // 不开开关可胡
  assert.equal(rules.checkHuHongZhong(badEye, [], { need258Eye: true }), false);
  // 将对 w5（258）可胡
  const goodEye = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 'w5', 'w5'];
  assert.equal(rules.checkHuHongZhong(goodEye, [], { need258Eye: true }), true);
});

test('二五八将：大胡（碰碰胡）不受限制', () => {
  // 碰碰胡将对 t3（非 258）
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 't1', 't1', 't1', 't2', 't2', 't2', 't3', 't3'];
  assert.equal(rules.checkHuHongZhong(hand, [], { need258Eye: true }), true);
});

// ============ 天胡 ============

test('天胡：起手 4 张红中直接胡', () => {
  // 4 红中 + 10 张完全不成型的牌仍直接天胡
  const hand = ['z0', 'z0', 'z0', 'z0', 'w1', 'w1', 'w1', 't1', 't1', 't2', 't2', 'b3', 'b4', 'b5'];
  assert.equal(rules.checkHuHongZhong(hand), true);
  // 3 张红中 + 高度散牌（癞子无法补成 4 面子 1 将）不算胡
  const hand3 = ['z0', 'z0', 'z0', 'w1', 'w3', 'w5', 't1', 't3', 't5', 'b1', 'b3', 'b5', 'b7', 'b9'];
  assert.equal(rules.checkHuHongZhong(hand3), false);
});

// ============ 红中碰/杠限制 ============

test('红中不可代碰杠（碰/杠对象必须是真实牌或真实红中）', () => {
  // w3×1 + z0×2 不能碰 w3（红中不能代替）
  assert.equal(rules.canPengHongZhong(['w3', 'z0', 'z0'], 'w3'), false);
  // 2 张真实红中可碰红中
  assert.equal(rules.canPengHongZhong(['w3', 'z0', 'z0'], 'z0'), true);
  assert.equal(rules.canPengHongZhong(['w3', 'w3', 'z0'], 'w3'), true);
  // 明杠需 3 张真实
  assert.equal(rules.canGangHongZhong(['w3', 'w3', 'w3'], 'w3'), true);
  assert.equal(rules.canGangHongZhong(['w3', 'w3', 'z0'], 'w3'), false);
  assert.equal(rules.canGangHongZhong(['z0', 'z0', 'z0'], 'z0'), true);
  // 暗杠需 4 张真实
  assert.equal(rules.canAnGangHongZhong(['w3', 'w3', 'w3', 'w3'], 'w3'), true);
  assert.equal(rules.canAnGangHongZhong(['w3', 'w3', 'w3', 'z0'], 'w3'), false);
});

// ============ 番数计算 ============

test('番数：平胡点炮门清 fan=1 mult=2', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const r = rules.calcMultiplierHongZhong(hand, { winType: 'dianpao' });
  assert.equal(r.fan, 1);
  assert.equal(r.mult, 2);
});

test('番数：自摸平胡 fan=2 mult=4；抢杠按自摸', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const r = rules.calcMultiplierHongZhong(hand, { winType: 'zimo' });
  assert.equal(r.fan, 2);
  assert.equal(r.mult, 4);
  const rg = rules.calcMultiplierHongZhong(hand, { winType: 'qianggang' });
  assert.equal(rg.fan, 2);
  assert.equal(rg.mult, 4);
});

test('番数：七小对自摸 fan=4 mult=16', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't1', 't1', 't2', 't2', 't3', 't3', 'b1', 'b1'];
  const r = rules.calcMultiplierHongZhong(hand, { winType: 'zimo' });
  assert.equal(r.fan, 4); // 自摸1 + 门清1 + 七小对2
  assert.equal(r.mult, 16);
});

test('番数：龙七对自摸 fan=5 mult=32', () => {
  const hand = ['w1', 'w1', 'w1', 'z0', 'w2', 'w2', 't1', 't1', 't2', 't2', 't3', 't3', 't4', 't4'];
  const r = rules.calcMultiplierHongZhong(hand, { winType: 'zimo' });
  assert.equal(r.fan, 5);
  assert.equal(r.mult, 32);
});

test('番数：碰碰胡自摸 fan=4 mult=16', () => {
  const hand = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 't1', 't1', 't1', 't2', 't2', 't2', 't3', 't3'];
  const r = rules.calcMultiplierHongZhong(hand, { winType: 'zimo' });
  assert.equal(r.fan, 4);
  assert.equal(r.mult, 16);
});

test('番数：混一色自摸 fan=4 mult=16；清一色自摸 fan=6 mult=64', () => {
  const hun = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w2', 'w2', 'w2', 'w5', 'z0'];
  const rh = rules.calcMultiplierHongZhong(hun, { winType: 'zimo' });
  assert.equal(rh.fan, 4);
  assert.equal(rh.mult, 16);
  const qing = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w2', 'w2', 'w2', 'w5', 'w5'];
  const rq = rules.calcMultiplierHongZhong(qing, { winType: 'zimo' });
  assert.equal(rq.fan, 6);
  assert.equal(rq.mult, 64);
});

test('番数：杠番（暗杠 +2、明杠 +1、红中杠 +2，明杠破门清）', () => {
  // 暗杠 w9：手牌 11 张 + 暗杠（暗杠不算破门清）
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't2', 't2', 't2', 't5', 't5'];
  const gang = { type: 'gang', tile: 'w9', tiles: ['w9', 'w9', 'w9'] };
  const anGang = { type: 'angang', tile: 'w9', tiles: ['w9', 'w9', 'w9', 'w9'] };
  const rAn = rules.calcMultiplierHongZhong(hand, { winType: 'zimo', melds: [anGang] });
  assert.equal(rAn.fan, 4); // 自摸1 + 门清1 + 暗杠2
  assert.equal(rAn.mult, 16);
  const rMing = rules.calcMultiplierHongZhong(hand, { winType: 'zimo', melds: [gang] });
  assert.equal(rMing.fan, 2); // 自摸1 + 明杠1（明杠破门清）
  assert.equal(rMing.mult, 4);
  const hongZhongGang = { type: 'gang', tile: 'z0', tiles: ['z0', 'z0', 'z0'] };
  const rHz = rules.calcMultiplierHongZhong(hand, { winType: 'zimo', melds: [hongZhongGang] });
  assert.equal(rHz.fan, 3); // 自摸1 + 红中杠2（明杠破门清，红中杠不再叠加明杠）
  assert.equal(rHz.mult, 8);
});

test('番数明细 names 正确', () => {
  const qing = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w2', 'w2', 'w2', 'w5', 'w5'];
  const r = rules.calcMultiplierHongZhong(qing, { winType: 'zimo' }, true);
  assert.equal(r.fan, 6);
  assert.equal(r.mult, 64);
  assert.deepEqual(r.names, ['自摸', '门清', '清一色']);
  const ping = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const rp = rules.calcMultiplierHongZhong(ping, { winType: 'dianpao' }, true);
  assert.deepEqual(rp.names, ['门清', '平胡']);
  assert.equal(rp.fan, 1);
  assert.equal(rp.mult, 2);
});

// ============ 中码判定 ============

test('中码：1/5/9 万筒条 + 红中', () => {
  for (const t of ['w1', 'w5', 'w9', 't1', 't5', 't9', 'b1', 'b5', 'b9', 'z0']) {
    assert.equal(rules.isZhongMa(t), true, t);
  }
  for (const t of ['w2', 'w3', 'w4', 'w6', 'w7', 'w8', 't2', 'b4']) {
    assert.equal(rules.isZhongMa(t), false, t);
  }
  assert.equal(rules.countZhongMa(['w1', 'w5', 'w9', 'z0', 'w2']), 4);
  assert.equal(rules.countZhongMa([]), 0);
});
