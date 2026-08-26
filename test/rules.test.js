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

// ============ 报听缺陷修复：碰/杠明牌区（melds）计入听口/报听/胡牌 ============

test('isTing 带 melds：碰后听口立即识别（碰完即听，不待下轮摸牌）', () => {
  // 碰 t3 后手牌 10 张：123456789万 + 5条单张 → 听 5条（成将）
  const melds = [{ type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] }];
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5'];
  const ting = rules.isTing(hand, melds);
  assert.ok(ting.includes('t5'), '碰后听口应立即识别 t5');
  // 带 melds 判定与纯手牌结构判定在此例一致（11 张恰为 n*3+2 结构）；
  // 关键语义：碰后调用链必须统一传 melds，避免把明牌刻子当手牌面子重复计算
  assert.deepEqual(rules.isTing(hand, melds), rules.isTing(hand));
});

test('isTing 带 melds：碰 2 次 / 杠后听口', () => {
  // 碰 t3 + 碰 b3 后手牌 7 张：1234567万 → 听 7万成将（melds 提供 2 个已成型面子）
  const melds2 = [
    { type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] },
    { type: 'peng', tile: 'b3', tiles: ['b3', 'b3', 'b3'] },
  ];
  const hand2 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
  const ting2 = rules.isTing(hand2, melds2);
  assert.ok(ting2.includes('w7'), '碰2次后听口应立即识别 w7');

  // 杠 t3 后手牌 10 张：123456789万 + 5条单张 → 听 5条（杠算 1 个已成型面子）
  const meldsG = [{ type: 'gang', tile: 't3', tiles: ['t3', 't3', 't3', 't3'] }];
  const handG = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5'];
  const tingG = rules.isTing(handG, meldsG);
  assert.ok(tingG.includes('t5'), '杠后听口应立即识别 t5');
});

test('canDeclareTing136 带 melds：碰后报听资格（含 ≥6 点硬性条件）', () => {
  // 碰 t3 后 11 张：123456789万 + 99条 → 扣 9条 听 9条（9 点）可报听
  const melds = [{ type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] }];
  const hand11 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't9', 't9'];
  assert.equal(rules.canDeclareTing136(hand11, melds), true, '碰后应立即具备报听资格');
  // 不带 melds 时 11 张手牌本身为 n*3+2 结构也可能被识别；
  // 语义关键：碰后调用链必须统一传 melds，保证明牌刻子作为已成型面子正确参与计算
  assert.equal(rules.canDeclareTing136(hand11, melds), rules.canDeclareTing136(hand11));

  // 碰后只听小点数：111万222万333万+11条（碰 t3）→ 任意打法听口均 ≤5 点，不满足 ≥6 点硬性条件
  const handLow = ['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3', 't1', 't1'];
  assert.equal(rules.canDeclareTing136(handLow, melds), false);
});

test('canHuWith/checkHu 带 melds：碰后胡牌判定（点炮/自摸）', () => {
  // 碰 t3 后手牌 10 张 + 点炮 5条 → 胡；点炮 3条/其他牌不胡
  const melds = [{ type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] }];
  const hand10 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5'];
  assert.equal(rules.canHuWith(hand10, 't5', melds), true);
  assert.equal(rules.canHuWith(hand10, 't3', melds), false);
  assert.equal(rules.canHuWith(hand10, 'w9', melds), false);
  // 自摸：checkHu 带 melds（11 张）
  assert.equal(rules.checkHu(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5', 't5'], melds), true);
});

test('checkHuWithMelds 手牌长度/非法 meld 校验', () => {
  // 杠 1 次：胡牌时手牌须 11 张
  const meldsG = [{ type: 'gang', tile: 't3', tiles: ['t3', 't3', 't3', 't3'] }];
  assert.equal(rules.checkHu(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5', 't5'], meldsG), true);
  // 手牌张数不符 → false
  assert.equal(rules.checkHu(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5'], meldsG), false);
  // 非法 meld 类型 → false
  assert.equal(
    rules.checkHu(
      ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5', 't5'],
      [{ type: 'chi', tile: 't3', tiles: ['t1', 't2', 't3'] }]
    ),
    false
  );
});

test('上架暗牌不可作胡目标：胡牌仅基于手牌+melds，扣牌不参与判定', () => {
  // 报听扣牌（暗牌）存于上架区，不进手牌、不进 melds、不进弃牌区；
  // 他人点炮判定只看其手牌+melds，扣牌不会被误当作可胡目标
  const melds = [{ type: 'peng', tile: 't3', tiles: ['t3', 't3', 't3'] }];
  // 某玩家碰 t3 后手牌 10 张，听 t5
  const hand10 = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't5'];
  assert.equal(rules.canHuWith(hand10, 't5', melds), true, '收到听口 t5 才胡');
  assert.equal(rules.canHuWith(hand10, 'b7', melds), false, '上架暗牌 b7 不作为可胡目标');
  assert.equal(rules.canHuWith(hand10, 't9', melds), false, '收到非听口牌不胡');
});
