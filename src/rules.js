'use strict';

/**
 * 运城扣点点麻将规则引擎（纯函数模块，可独立单测）
 *
 * 规则要点：
 *  - 108 张牌：万(w)/条(t)/筒(b) 1-9 各 4 张，无风、箭、花牌
 *  - 只能碰、杠，不能吃；默认只能自摸胡（房间可配置允许点炮）
 *  - 胡牌 = 4 面子 + 1 将（任意对子），或七对（含豪华七对）
 *  - 番型：平胡 1；碰碰胡 +1；清一色 +2；七对 2；豪华七对 4；清七对再 +2；
 *    杠上开花 +1；抢杠胡 +1；海底捞月 +1
 *  - 计分：基础分 = 底分 × 番数（番型上限可选封顶），自摸三家付 / 点炮一家付
 */

const SUITS = ['w', 't', 'b']; // 万、条、筒
const SUIT_NAMES = { w: '万', t: '条', b: '筒' };
const SUIT_ORDER = { w: 0, t: 1, b: 2 };

/** 全部 27 种牌型（每种 4 张共 108 张） */
const ALL_TILE_TYPES = [];
for (const s of SUITS) {
  for (let n = 1; n <= 9; n++) ALL_TILE_TYPES.push(s + n);
}

/** 生成完整 108 张牌 */
function createTiles() {
  const tiles = [];
  for (const s of SUITS) {
    for (let n = 1; n <= 9; n++) {
      for (let k = 0; k < 4; k++) tiles.push(s + n);
    }
  }
  return tiles;
}

/** Fisher-Yates 洗牌，返回新数组 */
function shuffle(tiles, rng = Math.random) {
  const a = tiles.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/** 手牌排序（万 < 条 < 筒，数字升序） */
function sortTiles(hand) {
  return hand.slice().sort((a, b) => {
    const d = SUIT_ORDER[a[0]] - SUIT_ORDER[b[0]];
    return d !== 0 ? d : numOf(a) - numOf(b);
  });
}

function suitOf(t) { return t[0]; }
function numOf(t) { return Number(t[1]); }
function tileName(t) { return numOf(t) + SUIT_NAMES[suitOf(t)]; }

/** 统计每种牌的张数，返回 Map（牌 -> 数量） */
function countTiles(hand) {
  const cnt = new Map();
  for (const t of hand) cnt.set(t, (cnt.get(t) || 0) + 1);
  return cnt;
}

/** 递归拆面子：能否把 cnt 中的牌全部拆成 n 组面子（刻子或顺子） */
function canFormMelds(cnt, n) {
  if (n === 0) {
    for (const c of cnt.values()) if (c !== 0) return false;
    return true;
  }
  let first = null;
  for (const [tile, c] of cnt) {
    if (c > 0) { first = tile; break; }
  }
  if (first === null) return false;
  const s = suitOf(first);
  const num = numOf(first);

  // 尝试刻子
  if (cnt.get(first) >= 3) {
    const c2 = new Map(cnt);
    const rest = c2.get(first) - 3;
    if (rest === 0) c2.delete(first);
    else c2.set(first, rest);
    if (canFormMelds(c2, n - 1)) return true;
  }
  // 尝试顺子（同花色连续三张）
  if (num <= 7) {
    const a = s + (num + 1);
    const b = s + (num + 2);
    if ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0) {
      const c2 = new Map(cnt);
      for (const t of [first, a, b]) {
        const r = c2.get(t) - 1;
        if (r === 0) c2.delete(t);
        else c2.set(t, r);
      }
      if (canFormMelds(c2, n - 1)) return true;
    }
  }
  return false;
}

/** 是否七对（14 张全部成对） */
function isQiDui(hand) {
  if (hand.length !== 14) return false;
  const cnt = countTiles(hand);
  for (const c of cnt.values()) if (c % 2 !== 0) return false;
  return true;
}

/** 是否豪华七对（七对且含 4 张相同牌） */
function isLuxuryQiDui(hand) {
  if (!isQiDui(hand)) return false;
  const cnt = countTiles(hand);
  for (const c of cnt.values()) if (c === 4) return true;
  return false;
}

/** 全部由刻子组成（每张牌数量为 3 的倍数） */
function allKezis(cnt) {
  for (const c of cnt.values()) if (c % 3 !== 0) return false;
  return true;
}

/** 是否碰碰胡：14 张可拆成 4 刻 + 1 将 */
function isPengPengHu(hand) {
  if (hand.length !== 14) return false;
  const cnt = countTiles(hand);
  for (const [tile, c] of cnt) {
    if (c >= 2) {
      const c2 = new Map(cnt);
      const r = c - 2;
      if (r === 0) c2.delete(tile);
      else c2.set(tile, r);
      if (allKezis(c2)) return true;
    }
  }
  return false;
}

/**
 * 标准胡牌判定：14 张（或 11/8/5/2 张结构）能否组成 4 面子 + 1 将，或七对。
 * 入参张数需满足 n*3+2（通常 14）。
 */
function checkHu(hand) {
  if (!Array.isArray(hand) || hand.length % 3 !== 2) return false;
  if (hand.length === 2) {
    const cnt = countTiles(hand);
    const vals = [...cnt.values()];
    return vals.length === 1 && vals[0] === 2;
  }
  if (isQiDui(hand)) return true;
  const cnt = countTiles(sortTiles(hand));
  const meldCount = (hand.length - 2) / 3;
  for (const [tile, c] of cnt) {
    if (c >= 2) {
      const c2 = new Map(cnt);
      const r = c - 2;
      if (r === 0) c2.delete(tile);
      else c2.set(tile, r);
      if (canFormMelds(c2, meldCount)) return true;
    }
  }
  return false;
}

/** 胡某张牌：hand（通常 13 张）+ tile 是否成胡 */
function canHuWith(hand, tile) {
  return checkHu([...hand, tile]);
}

/** 能否碰：手牌中该牌 >= 2 张 */
function canPeng(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 2;
}

/** 能否明杠（别人打出）：手牌中该牌 >= 3 张 */
function canGang(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 3;
}

/** 能否暗杠：手牌中该牌 >= 4 张 */
function canAnGang(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 4;
}

/** 能否补杠：手牌有 1 张该牌且明牌区有对应碰 */
function canBuGang(hand, melds, tile) {
  if ((countTiles(hand).get(tile) || 0) < 1) return false;
  return melds.some((m) => m.type === 'peng' && m.tile === tile);
}

/** 听牌检测：13 张手牌，返回能胡的牌列表（空数组 = 未听） */
function isTing(hand) {
  const res = [];
  for (const t of ALL_TILE_TYPES) {
    if (checkHu([...hand, t])) res.push(t);
  }
  return res;
}

/** 是否碰碰胡（考虑明牌区）：手牌部分每张牌数量为 3 的倍数或恰一个对子作将 */
function isPengPengHuWithMelds(hand, melds) {
  const cnt = countTiles(hand);
  let pairUsed = false;
  for (const c of cnt.values()) {
    const r = c % 3;
    if (r === 1) return false;
    if (r === 2) {
      if (pairUsed) return false;
      pairUsed = true;
    }
  }
  // 明牌区所有副露都是刻子（peng/gang/angang/bugang），天然满足碰碰胡
  for (const m of melds || []) {
    if (m.type !== 'peng' && m.type !== 'gang' && m.type !== 'angang' && m.type !== 'bugang') {
      return false;
    }
  }
  return true;
}

/**
 * 计算胡牌番数
 * @param {string[]} hand 胡牌时的 14 张手牌（不含明牌区）
 * @param {object} info
 *   winType: 'zimo' | 'dianpao' | 'qianggang'
 *   gangShang: boolean 杠上开花
 *   haiDi: boolean 海底捞月
 *   qiangGang: boolean 抢杠胡
 *   melds: [{type:'peng'|'gang'|'angang'|'bugang', tile, tiles}] 明牌区
 * @param {boolean} [detail] 为 true 时返回 { fan, names }
 * @returns {number | {fan:number, names:string[]}} 番数（detail 时为对象）
 */
function calcFan(hand, info = {}, detail = false) {
  const melds = info.melds || [];
  const winType = info.winType || 'zimo';
  const allTiles = hand.slice();
  for (const m of melds) {
    for (const t of m.tiles) allTiles.push(t);
  }
  const allSuit =
    allTiles.length > 0 && allTiles.every((t) => suitOf(t) === suitOf(allTiles[0]));

  let fan = 0;
  const names = [];
  const isQD = melds.length === 0 && isQiDui(hand);
  if (isQD) {
    fan = isLuxuryQiDui(hand) ? 4 : 2;
    names.push(isLuxuryQiDui(hand) ? '豪华七对' : '七对');
    if (allSuit) {
      fan += 2; // 清七对
      names.push('清一色');
    }
  } else {
    const pp = melds.length === 0 ? isPengPengHu(hand) : isPengPengHuWithMelds(hand, melds);
    if (pp) {
      fan += 1; // 碰碰胡
      names.push('碰碰胡');
    }
    if (allSuit) {
      fan += 2; // 清一色
      names.push('清一色');
    }
    fan += 1; // 平胡基础番
    if (names.length === 0) names.push('平胡');
  }
  if (info.gangShang) {
    fan += 1;
    names.push('杠上开花');
  }
  if (info.qiangGang) {
    fan += 1;
    names.push('抢杠胡');
  }
  if (info.haiDi) {
    fan += 1;
    names.push('海底捞月');
  }
  void winType;
  return detail ? { fan, names } : fan;
}

/**
 * 计分：基础分 = 底分 × 番数（番型上限可选封顶，0 表示不封顶）
 */
function calcScore(baseScore, fan, fanLimit) {
  let f = fan;
  if (fanLimit && fanLimit > 0 && f > fanLimit) f = fanLimit;
  return baseScore * f;
}

module.exports = {
  SUITS,
  SUIT_NAMES,
  ALL_TILE_TYPES,
  createTiles,
  shuffle,
  sortTiles,
  suitOf,
  numOf,
  tileName,
  countTiles,
  checkHu,
  canHuWith,
  canPeng,
  canGang,
  canAnGang,
  canBuGang,
  isTing,
  isQiDui,
  isLuxuryQiDui,
  isPengPengHu,
  isPengPengHuWithMelds,
  calcFan,
  calcScore,
};
