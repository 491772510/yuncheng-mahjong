'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/rules');

// ============ 金牌确定（金母 → 金牌） ============

test('goldFromMother 序数牌：翻 x → 金牌 = 10-x', () => {
  assert.equal(rules.goldFromMother('w1'), 'w9');
  assert.equal(rules.goldFromMother('w2'), 'w8');
  assert.equal(rules.goldFromMother('w3'), 'w7');
  assert.equal(rules.goldFromMother('w4'), 'w6');
  assert.equal(rules.goldFromMother('w6'), 'w4');
  assert.equal(rules.goldFromMother('w7'), 'w3');
  assert.equal(rules.goldFromMother('w8'), 'w2');
  assert.equal(rules.goldFromMother('w9'), 'w1');
  assert.equal(rules.goldFromMother('t3'), 't7');
  assert.equal(rules.goldFromMother('b6'), 'b4');
});

test('goldFromMother 翻 5 → 金牌即 5 本身', () => {
  assert.equal(rules.goldFromMother('w5'), 'w5');
  assert.equal(rules.goldFromMother('t5'), 't5');
  assert.equal(rules.goldFromMother('b5'), 'b5');
});

test('goldFromMother 翻发财 → 金牌即发财', () => {
  assert.equal(rules.goldFromMother('f'), 'f');
});

test('goldFromMother 风/箭按对牌关系：东↔西、南↔北、中↔白、发↔发', () => {
  assert.equal(rules.goldFromMother('e'), 'x'); // 东 → 西
  assert.equal(rules.goldFromMother('x'), 'e'); // 西 → 东
  assert.equal(rules.goldFromMother('s'), 'n'); // 南 → 北
  assert.equal(rules.goldFromMother('n'), 's'); // 北 → 南
  assert.equal(rules.goldFromMother('z'), 'p'); // 中 → 白
  assert.equal(rules.goldFromMother('p'), 'z'); // 白 → 中
  assert.equal(rules.goldFromMother('f'), 'f'); // 发 → 发
});

test('isGold / countGold 基础判定', () => {
  assert.ok(rules.isGold('w9', 'w9'));
  assert.ok(!rules.isGold('w8', 'w9'));
  assert.equal(rules.countGold(['w9', 'w5', 'w9', 'f'], 'w9'), 2);
  assert.equal(rules.countGold(['w9', 'w5'], 'w9'), 1);
});

// ============ 贴金胡牌判定（金牌万能补位） ============

test('checkHuTieJin 平胡成立（无金牌参与）', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 金牌补顺子后位', () => {
  // 12w + 金(补3) 成 123w；456w 789w 222t 55t
  const hand = ['w1', 'w2', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 金牌补顺子前位', () => {
  // 89b + 金(w9 作 b7) 补前位成 789b；123w 456w 222t + t5t5 将
  const hand = ['b8', 'b9', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't2', 't2', 't2', 't5', 't5', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 金牌补顺子中位', () => {
  // 79w + 金(补8) 成 789w；123w 456w 222t 55t
  const hand = ['w7', 'w9', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 't2', 't2', 't2', 't5', 't5', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 金牌补刻子', () => {
  // 123w 456w 789w + t1t1+金(补t1) 成刻 + t5t5 将
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't1', 't1', 't5', 't5', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 金牌补将（1 真 + 1 金）', () => {
  // 123w 456w 789w 222t + t5 + 金(w9 作 t5) 作将
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 2 张金牌作将', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 'w9', 'w9'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true);
});

test('checkHuTieJin 非胡牌型返回 false', () => {
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 'w1'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), false);
  // 手牌张数不符
  assert.equal(rules.checkHuTieJin(['w1', 'w2', 'w3'], [], 'w9'), false);
});

test('checkHuTieJin 带明牌区（碰/杠）可胡', () => {
  // 明牌区 111w（碰）；手牌 456w 789w 222t + 55t（6+3+2=11 张：456 789 222 55）
  const hand = ['w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const melds = [{ type: 'peng', tile: 'w1', tiles: ['w1', 'w1', 'w1'] }];
  assert.equal(rules.checkHuTieJin(hand, melds, 'w9'), true);
});

test('checkHuTieJin 明牌区为金牌的碰/杠视为非法（金牌不可碰杠）', () => {
  const hand = ['w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  const melds = [{ type: 'peng', tile: 'w9', tiles: ['w9', 'w9', 'w9'] }];
  assert.equal(rules.checkHuTieJin(hand, melds, 'w9'), false);
});

test('canHuTieJinWith 摸/抢某张后成胡', () => {
  // 听 w5：123w 456w 789w t2t2t2 + t5 将，摸/抢 t5 成胡
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5'];
  assert.equal(rules.canHuTieJinWith(hand, 't5', [], 'w9'), true);
  assert.equal(rules.canHuTieJinWith(hand, 't3', [], 'w9'), false);
});

// ============ 贴金七小对 / 豪华七小对（金牌可当万能凑对） ============

test('isQiDuiTieJin：7 个真对成立，含金（万能）亦可凑对', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'b8'];
  assert.equal(rules.isQiDuiTieJin(hand, 'w9'), true, '7 个真对');
  // 含 1 张金牌 w9 作万能：1 真 + 金 成对
  const hand2 = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'w9'];
  assert.equal(rules.isQiDuiTieJin(hand2, 'w9'), true, '1 张金补最后一张成对');
  // 2 张金牌自成一对
  const hand3 = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'w9', 'w9', 'b8'];
  assert.equal(rules.isQiDuiTieJin(hand3, 'w9'), true, '2 张金两两成对');
  // 1 张金无法补成（需要 2 张补齐不同花色，金只有 1 张）
  const hand4 = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b8', 'b9', 'w9'];
  assert.equal(rules.isQiDuiTieJin(hand4, 'w9'), false, '3 张散牌 + 1 金不足以补成 7 对');
  // 牌数不符
  assert.equal(rules.isQiDuiTieJin(hand.slice(0, 13), 'w9'), false);
});

test('isLuxuryQiDuiTieJin：含 4 张同牌为豪华七对；金补成 4 张亦成立', () => {
  const hand = ['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7'];
  assert.equal(rules.isLuxuryQiDuiTieJin(hand, 'w9'), true, '含 4 张 w1');
  // 3 张真牌 + 1 张金补成 4 张，其余成对
  const hand2 = ['w1', 'w1', 'w1', 'w9', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7'];
  assert.equal(rules.isLuxuryQiDuiTieJin(hand2, 'w9'), true, '3 真 + 1 金补足 4 张');
  // 普通七对（无 4 张）→ 非豪华
  const hand3 = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'b8'];
  assert.equal(rules.isLuxuryQiDuiTieJin(hand3, 'w9'), false);
});

test('checkHuTieJin 支持七小对（无金与含金两种）', () => {
  const hand = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'b8'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w9'), true, '七小对无明牌区可胡');
  const hand2 = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'w9'];
  assert.equal(rules.checkHuTieJin(hand2, [], 'w9'), true, '含金补对的七小对可胡');
  // 有明牌区时七对不成立
  const melds = [{ type: 'peng', tile: 'b1', tiles: ['b1', 'b1', 'b1'] }];
  assert.equal(rules.checkHuTieJin(hand, melds, 'w9'), false, '有碰/杠时不算七对');
});

test('tiejinShapeMult：七小对 ×2、豪华七小对 ×4，普通牌型 ×1', () => {
  const qd = ['w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7', 'b8', 'b8'];
  assert.deepEqual(rules.tiejinShapeMult(qd, [], 'w9'), { mult: 2, names: ['七小对'] });
  const lq = ['w1', 'w1', 'w1', 'w1', 'w2', 'w2', 'w3', 'w3', 't4', 't4', 't5', 't5', 'b7', 'b7'];
  assert.deepEqual(rules.tiejinShapeMult(lq, [], 'w9'), { mult: 4, names: ['豪华七小对'] });
  // 平胡
  const ph = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 't2', 't2', 't2', 't5', 't5'];
  assert.deepEqual(rules.tiejinShapeMult(ph, [], 'w9'), { mult: 1, names: [] });
  // 有明牌区 → 不判七对
  const melds = [{ type: 'peng', tile: 'b1', tiles: ['b1', 'b1', 'b1'] }];
  assert.equal(rules.tiejinShapeMult(qd, melds, 'w9').mult, 1);
});

// ============ 计分加番（七对只放大胡牌分，金分不变） ============

test('calcTieJinScoreA 七对加番 ×2：胡牌分翻倍，金分不变', () => {
  const base = rules.calcTieJinScoreA({ winType: 'zimo', winnerDealer: false, goldCount: 2 });
  const qd = rules.calcTieJinScoreA({ winType: 'zimo', winnerDealer: false, goldCount: 2, fanMult: 2 });
  assert.equal(base.H, 1);
  assert.equal(qd.H, 2, '七对 H = 1×2');
  assert.equal(qd.G, base.G, '金分不受加番影响');
  // 自摸每家 = 2H + G = 2×2 + 3 = 7
  assert.equal(qd.payers[0].amount, 2 * 2 + 3);
});

test('calcTieJinScoreB 七对加番 ×2：基础份的胡庄部分翻倍，金分不变', () => {
  const base = rules.calcTieJinScoreB({ winType: 'dianpao', winnerDealer: false, goldCount: 1 });
  const qd = rules.calcTieJinScoreB({ winType: 'dianpao', winnerDealer: false, goldCount: 1, fanMult: 2 });
  assert.equal(base.base, 7, '普通：胡1+庄1+金1=3... 实为 1+1+5=7（125体系 G=5）');
  assert.equal(qd.base, (1 + 1) * 2 + 5, '七对：(1+1)×2 + 5 = 9');
  assert.equal(qd.G, base.G, '金分不受加番影响');
});

// ============ 第一张金必须上（有金未上不能胡） ============

test('isFirstGoldUnplayed：手握金牌且一张未上 → 违规禁止胡', () => {
  // 手牌含 1 张金牌 w5、上金 0 张 → 违规
  assert.equal(rules.isFirstGoldUnplayed(['w1', 'w2', 'w3', 'w5'], 'w5', 0), true);
  // 手中无金 → 不违规（牌墙金母/已弃金牌等情形）
  assert.equal(rules.isFirstGoldUnplayed(['w1', 'w2', 'w3'], 'w5', 0), false);
  // 已上过金（手牌已无金）→ 不违规
  assert.equal(rules.isFirstGoldUnplayed(['w1', 'w2', 'w3'], 'w5', 1), false);
  // 已上过金但后期又摸入金牌：允许（首金条件已满足），但要走亮金才能拿点炮资格
  assert.equal(rules.isFirstGoldUnplayed(['w1', 'w2', 'w3', 'w5'], 'w5', 1), false);
  // 无金牌局 → 不违规
  assert.equal(rules.isFirstGoldUnplayed(['w1', 'w5'], null, 0), false);
  // 上金数为 undefined/null 视为 0
  assert.equal(rules.isFirstGoldUnplayed(['w5'], 'w5', undefined), true);
  assert.equal(rules.isFirstGoldUnplayed(['w5'], 'w5', null), true);
  // 即使牌型未用到金牌作万能补位，手握金未上同样禁止
  const hand = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 't1', 't1', 't1', 't2', 't2', 'w5'];
  assert.equal(rules.checkHuTieJin(hand, [], 'w5'), true, '牌型本身可胡');
  assert.equal(rules.isFirstGoldUnplayed(hand, 'w5', 0), true, '但手握金未上 → 禁止胡');
});

// ============ 金牌不可碰/杠 ============

test('canPengTieJin / canGangTieJin / canAnGangTieJin 金牌牌面不可碰杠', () => {
  const hand = ['w9', 'w9', 'w9', 'w9', 't5', 't5'];
  assert.equal(rules.canPengTieJin(hand, 'w9', 'w9'), false); // 金牌不可碰
  assert.equal(rules.canGangTieJin(hand, 'w9', 'w9'), false); // 金牌不可杠
  assert.equal(rules.canAnGangTieJin(hand, 'w9', 'w9'), false); // 金牌不可暗杠
  // 真实牌可碰可杠
  assert.equal(rules.canPengTieJin(hand, 't5', 'w9'), true);
  const hand2 = ['t5', 't5', 't5', 'w1', 'w2'];
  assert.equal(rules.canGangTieJin(hand2, 't5', 'w9'), true);
  const hand3 = ['t5', 't5', 't5', 't5'];
  assert.equal(rules.canAnGangTieJin(hand3, 't5', 'w9'), true);
});

test('canBuGangTieJin 金牌不可补杠、真实牌可补杠', () => {
  const melds = [{ type: 'peng', tile: 't5', tiles: ['t5', 't5', 't5'] }];
  const hand = ['w9', 'w1', 'w2'];
  assert.equal(rules.canBuGangTieJin(hand, melds, 'w9', 'w9'), false); // 金牌补杠拒绝
  const hand2 = ['t5', 'w1', 'w2'];
  assert.equal(rules.canBuGangTieJin(hand2, melds, 't5', 'w9'), true);
});

// ============ 全字牌整副（字牌胡限制） ============

test('isAllHonorShape 全字牌且无金牌', () => {
  const hand = ['e', 'e', 's', 's', 'z', 'z', 'n', 'n', 'p', 'p', 'f', 'f', 'x', 'x'];
  assert.equal(rules.isAllHonorShape(hand, [], 'w9'), true);
  // 含金牌（金牌不代替）→ false
  assert.equal(rules.isAllHonorShape(['e', 'e', 's', 's', 'z', 'z', 'n', 'n', 'p', 'p', 'f', 'f', 'x', 'w9'], [], 'w9'), false);
  // 含数牌 → false
  assert.equal(rules.isAllHonorShape(['e', 'e', 's', 's', 'z', 'z', 'n', 'n', 'p', 'p', 'f', 'f', 'x', 'w1'], [], 'w9'), false);
});

// ============ 计分 A（边趣/大唐版） ============

test('tiejinGoldScoreA 3 倍递增、27 封顶', () => {
  assert.equal(rules.tiejinGoldScoreA(0), 0);
  assert.equal(rules.tiejinGoldScoreA(1), 1);
  assert.equal(rules.tiejinGoldScoreA(2), 3);
  assert.equal(rules.tiejinGoldScoreA(3), 9);
  assert.equal(rules.tiejinGoldScoreA(4), 27);
  assert.equal(rules.tiejinGoldScoreA(5), 27); // 封顶
});

test('calcTieJinScoreA 闲家自摸：每家 2×1 + G', () => {
  const r = rules.calcTieJinScoreA({ winType: 'zimo', winnerDealer: false, goldCount: 2 });
  assert.equal(r.H, 1);
  assert.equal(r.G, 3);
  assert.equal(r.payers.length, 3);
  assert.equal(r.payers[0].amount, 2 * 1 + 3); // 5
  assert.equal(r.winnerGain, 3 * (2 + 3)); // 15
  assert.equal(r.huGain, 6);
  assert.equal(r.goldGain, 9);
});

test('calcTieJinScoreA 庄家自摸：每家 2×2 + G', () => {
  const r = rules.calcTieJinScoreA({ winType: 'zimo', winnerDealer: true, goldCount: 1 });
  assert.equal(r.H, 2);
  assert.equal(r.G, 1);
  assert.equal(r.payers[0].amount, 2 * 2 + 1); // 5
  assert.equal(r.winnerGain, 15);
});

test('calcTieJinScoreA 闲家点炮通赔：三家各付 H，点炮者金分翻倍', () => {
  const r = rules.calcTieJinScoreA({ winType: 'dianpao', winnerDealer: false, goldCount: 3 });
  assert.equal(r.H, 1);
  assert.equal(r.G, 9);
  // 点炮者 = payers[0]：H + 2G = 1+18 = 19；另两家 H + G = 10
  assert.equal(r.payers[0].amount, 1 + 18);
  assert.equal(r.payers[1].amount, 10);
  assert.equal(r.payers[2].amount, 10);
  assert.equal(r.winnerGain, 19 + 10 + 10); // 39
  assert.equal(r.goldGain, 4 * 9); // 36
});

test('calcTieJinScoreA 庄家点炮通赔：三家各付 H=2，点炮者金分翻倍', () => {
  const r = rules.calcTieJinScoreA({ winType: 'qianggang', winnerDealer: true, goldCount: 1 });
  assert.equal(r.H, 2);
  assert.equal(r.G, 1);
  assert.equal(r.payers[0].amount, 2 + 2); // 4
  assert.equal(r.payers[1].amount, 3);
  assert.equal(r.winnerGain, 4 + 3 + 3); // 10
});

// ============ 计分 B（搜狗 125 打法） ============

test('tiejinGoldScoreB 3 倍叠加、135 封顶', () => {
  assert.equal(rules.tiejinGoldScoreB(0), 0);
  assert.equal(rules.tiejinGoldScoreB(1), 5);
  assert.equal(rules.tiejinGoldScoreB(2), 15);
  assert.equal(rules.tiejinGoldScoreB(3), 45);
  assert.equal(rules.tiejinGoldScoreB(4), 135);
  assert.equal(rules.tiejinGoldScoreB(5), 135); // 封顶
});

test('calcTieJinScoreB 偏家吃胡（点炮）：放炮者 8、另两偏家各 7（1 金）', () => {
  const r = rules.calcTieJinScoreB({ winType: 'dianpao', winnerDealer: false, goldCount: 1 });
  assert.equal(r.base, 7);
  assert.equal(r.dealerShare, 10);
  assert.equal(r.payers[0].amount, 8); // 放炮者 +1 炮钱
  assert.equal(r.payers[1].amount, 7);
  assert.equal(r.payers[2].amount, 7);
  assert.equal(r.winnerGain, 22);
});

test('calcTieJinScoreB 2 金：放炮者 18、另两 17', () => {
  const r = rules.calcTieJinScoreB({ winType: 'dianpao', winnerDealer: false, goldCount: 2 });
  assert.equal(r.base, 17);
  assert.equal(r.payers[0].amount, 18);
  assert.equal(r.payers[1].amount, 17);
  assert.equal(r.winnerGain, 52);
});

test('calcTieJinScoreB 偏家自摸：偏家各 7、庄家 10（1 金）', () => {
  const r = rules.calcTieJinScoreB({ winType: 'zimo', winnerDealer: false, goldCount: 1 });
  assert.equal(r.payers[0].amount, 10); // 庄家
  assert.equal(r.payers[1].amount, 7);
  assert.equal(r.payers[2].amount, 7);
  assert.equal(r.winnerGain, 24);
});

test('calcTieJinScoreB 庄家自摸：每家 10，共 30（1 金）', () => {
  const r = rules.calcTieJinScoreB({ winType: 'zimo', winnerDealer: true, goldCount: 1 });
  assert.equal(r.payers[0].amount, 10);
  assert.equal(r.payers[1].amount, 10);
  assert.equal(r.payers[2].amount, 10);
  assert.equal(r.winnerGain, 30);
});

test('calcTieJinScoreB 庄家吃胡（点炮）：每家 10、点炮者 +1 炮钱=11', () => {
  const r = rules.calcTieJinScoreB({ winType: 'dianpao', winnerDealer: true, goldCount: 1 });
  assert.equal(r.payers[0].amount, 11);
  assert.equal(r.payers[1].amount, 10);
  assert.equal(r.payers[2].amount, 10);
  assert.equal(r.winnerGain, 31);
});

test('calcTieJinScoreB 返回 huGain（总收入减金分，非恒 0）', () => {
  const r = rules.calcTieJinScoreB({ winType: 'zimo', winnerDealer: false, goldCount: 2 });
  assert.equal(r.G, 15, '2金金分=15（125体系）');
  assert.equal(r.payers[0].amount, 20, '庄家 20');
  assert.equal(r.payers[1].amount, 17, '偏家 17');
  assert.equal(r.winnerGain, 54, '偏家自摸 2 金：庄 20 + 偏家各 17 = 54');
  assert.equal(r.huGain, r.winnerGain - 3 * r.G, 'huGain = 总收入 - 3×金分');
  assert.ok(r.huGain > 0, 'huGain 应为正数');
});
