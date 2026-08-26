'use strict';

/**
 * 运城扣点点麻将规则引擎（纯函数模块，可独立单测）
 *
 * 规则要点（136 张民间通用版，唯一玩法）：
 *  - 136 张牌：万(w)/条(t)/筒(b) 1-9 各 4 张 + 东南西北中发白 各 4 张
 *  - 只能碰、杠，不能吃；可点炮可自摸（受胡牌点数限制）
 *  - 胡牌 = 4 面子 + 1 将（任意对子），或七对（含豪华七对）、十三幺
 *  - 开局每人暗扣 1-4 点（本局胡牌倍数，结算公开）；报听需听口含 ≥6 点牌
 *  - 胡牌点数限制：1/2 点不能胡；3/4/5 点只能自摸；6/7/8/9/字牌(10 点)可点炮可自摸
 *  - 计分：点数 × 牌型倍数 × 自己扣点；杠分即时结算（明杠每家 1、暗杠每家 2）
 */

const SUITS = ['w', 't', 'b']; // 万、条、筒
const SUIT_NAMES = { w: '万', t: '条', b: '筒' };
const SUIT_ORDER = { w: 0, t: 1, b: 2 };

/** 字牌（风牌 + 箭牌）：东南西北中发白。只能组成刻子或将牌，不能组成顺子 */
const HONOR_TILES = ['e', 's', 'x', 'n', 'z', 'f', 'p']; // 东 南 西 北 中 发 白
const HONOR_NAMES = { e: '东', s: '南', x: '西', n: '北', z: '中', f: '发', p: '白' };
const HONOR_ORDER = { e: 0, s: 1, x: 2, n: 3, z: 4, f: 5, p: 6 };

/** 全部 27 种数牌（每种 4 张）；字牌见 HONOR_TILES（7 种 × 4 = 28 张），合计 136 张 */
const ALL_TILE_TYPES = [];
for (const s of SUITS) {
  for (let n = 1; n <= 9; n++) ALL_TILE_TYPES.push(s + n);
}

/** 全部牌型编码：万条筒 27 种 + 东南西北中发白 7 种 = 34 种（136 张） */
function getTileTypes() {
  return ALL_TILE_TYPES.concat(HONOR_TILES);
}

/** 生成完整牌墙：136 张（万条筒 1-9 各 4 张 + 字牌各 4 张） */
function createTiles() {
  const tiles = [];
  for (const t of getTileTypes()) {
    for (let k = 0; k < 4; k++) tiles.push(t);
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

/** 牌排序键：万 < 条 < 筒（数字升序），字牌排最后（东南西北中发白） */
function rankOf(t) {
  if (HONOR_ORDER[t] !== undefined) return 30 + HONOR_ORDER[t];
  return SUIT_ORDER[t[0]] * 10 + numOf(t);
}

/** 手牌排序（万 < 条 < 筒，数字升序；字牌按东南西北中发白） */
function sortTiles(hand) {
  return hand.slice().sort((a, b) => rankOf(a) - rankOf(b));
}

function suitOf(t) { return t[0]; }
function numOf(t) { return Number(t[1]); }
function tileName(t) {
  if (HONOR_NAMES[t]) return HONOR_NAMES[t];
  return numOf(t) + SUIT_NAMES[suitOf(t)];
}

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

/** 听牌检测：13 张手牌，返回能胡的牌列表（空数组 = 未听）。候选牌范围为全部 34 种 */
function isTing(hand) {
  const res = [];
  for (const t of getTileTypes()) {
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

// ============ 136 模式：扣点点完整规则（本地民间通用版） ============

/** 胡牌点数：数牌按面值（1-9），字牌一律 10 点 */
function tilePoints(t) {
  if (HONOR_NAMES[t]) return 10;
  return Number(t[1]);
}

/**
 * 胡牌点数限制（136 模式）
 *  1/2 点：不能胡（点炮自摸都不行）
 *  3/4/5 点：只能自摸
 *  6/7/8/9/字牌（10 点）：可点炮可自摸
 * @param {number} pt 胡的那张牌的点数
 * @param {string} winType 'zimo' | 'dianpao' | 'qianggang'
 */
function canHuByPoints(pt, winType) {
  if (pt <= 2) return false;
  if (pt <= 5) return winType === 'zimo';
  return true;
}

/**
 * 报听资格：手牌（14 张，摸牌后）中存在一张牌 t，打出后仍听牌，
 * 且听口列表中至少包含一张 6 点及以上牌（6/7/8/9/字牌=10点）。
 */
function canDeclareTing136(hand) {
  for (const t of [...new Set(hand)]) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(t), 1);
    const ting = isTing(rest);
    if (ting.some((x) => tilePoints(x) >= 6)) return true;
  }
  return false;
}

/** 是否一条龙：手牌+明牌区中同一花色 1-9 齐全（不必构成单一顺子） */
function isYiTiaoLong(hand, melds) {
  const cnt = countTiles(hand);
  for (const m of melds || []) {
    for (const t of m.tiles) cnt.set(t, (cnt.get(t) || 0) + 1);
  }
  for (const s of SUITS) {
    let ok = true;
    for (let n = 1; n <= 9; n++) {
      if (!(cnt.get(s + n) || 0)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** 幺九牌：19万/19条/19筒 + 东南西北中发白 */
const YAO_TILES = ['w1', 'w9', 't1', 't9', 'b1', 'b9', 'e', 's', 'x', 'n', 'z', 'f', 'p'];

/** 是否十三幺：14 张 = 13 种幺九牌各 1 张 + 其中 1 种成对（无明牌区） */
function isShiSanYao(hand) {
  if (hand.length !== 14) return false;
  const cnt = countTiles(hand);
  if (cnt.size !== 13) return false;
  let pair = false;
  for (const t of YAO_TILES) {
    const c = cnt.get(t) || 0;
    if (c === 0) return false;
    if (c === 2) {
      if (pair) return false;
      pair = true;
    } else if (c !== 1) {
      return false;
    }
  }
  return pair;
}

/**
 * 牌型倍数（乘法叠加）：
 *  平胡×1、碰碰胡×2、七小对×4、豪华七小对×8、杠上开花×2；
 *  清一色/一条龙/十三幺为房间开关，启用时倍数可配（默认 ×4/×4/×8）。
 * @param {string[]} hand 胡牌时的 14 张手牌
 * @param {object} info { winType, gangShang, qiangGang, melds }
 * @param {object} opts { qingyise:{enabled,mult}, yitiaolong:{enabled,mult}, shisanyao:{enabled,mult} }
 * @param {boolean} [detail] true 时返回 { mult, names }
 */
function calcMultiplier136(hand, info = {}, opts = {}, detail = false) {
  const melds = info.melds || [];
  const qing = opts.qingyise || { enabled: false, mult: 4 };
  const long = opts.yitiaolong || { enabled: false, mult: 4 };
  const yao = opts.shisanyao || { enabled: false, mult: 8 };
  const allTiles = hand.slice();
  for (const m of melds) {
    for (const t of m.tiles) allTiles.push(t);
  }
  const allSuit =
    allTiles.length > 0 &&
    allTiles.every((t) => !HONOR_NAMES[t]) &&
    allTiles.every((t) => suitOf(t) === suitOf(allTiles[0]));

  let mult = 1;
  const names = [];

  if (melds.length === 0 && isShiSanYao(hand)) {
    mult = yao.mult;
    names.push('十三幺');
  } else {
    const isQD = melds.length === 0 && isQiDui(hand);
    if (isQD) {
      if (isLuxuryQiDui(hand)) {
        mult = 8;
        names.push('豪华七小对');
      } else {
        mult = 4;
        names.push('七小对');
      }
    } else {
      const pp = melds.length === 0 ? isPengPengHu(hand) : isPengPengHuWithMelds(hand, melds);
      if (pp) {
        mult *= 2;
        names.push('碰碰胡');
      }
      if (names.length === 0) names.push('平胡');
    }
    if (qing.enabled && allSuit) {
      mult *= qing.mult;
      names.push('清一色');
    }
    if (long.enabled && isYiTiaoLong(hand, melds)) {
      mult *= long.mult;
      names.push('一条龙');
    }
  }
  if (info.gangShang) {
    mult *= 2;
    names.push('杠上开花');
  }
  return detail ? { mult, names } : mult;
}

module.exports = {
  SUITS,
  SUIT_NAMES,
  ALL_TILE_TYPES,
  HONOR_TILES,
  HONOR_NAMES,
  getTileTypes,
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
  tilePoints,
  canHuByPoints,
  canDeclareTing136,
  isYiTiaoLong,
  isShiSanYao,
  calcMultiplier136,
};
