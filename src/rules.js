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

/** 红中麻将牌编码（suit=z, rank=0），与扣点点字牌 z(中) 区分 */
const HONG_ZHONG = 'z0';

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
  if (t === HONG_ZHONG) return 0; // 红中排最前（rank=0）
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
  if (t === HONG_ZHONG) return '红中';
  if (HONOR_NAMES[t]) return HONOR_NAMES[t];
  return numOf(t) + SUIT_NAMES[suitOf(t)];
}

/** 统计每种牌的张数，返回 Map（牌 -> 数量） */
function countTiles(hand) {
  const cnt = new Map();
  for (const t of hand) cnt.set(t, (cnt.get(t) || 0) + 1);
  return cnt;
}

/** 牌计数减 k（减到 0 则删除键，保持 Map 内无 0 值，与旧实现 new Map 语义一致） */
function decCount(cnt, tile, k) {
  const r = (cnt.get(tile) || 0) - k;
  if (r <= 0) cnt.delete(tile);
  else cnt.set(tile, r);
}

/** 牌计数加 k */
function incCount(cnt, tile, k) {
  cnt.set(tile, (cnt.get(tile) || 0) + k);
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

  // 尝试刻子：临时扣减后递归，返回时恢复，避免每层 new Map 全量拷贝
  if (cnt.get(first) >= 3) {
    decCount(cnt, first, 3);
    if (canFormMelds(cnt, n - 1)) { incCount(cnt, first, 3); return true; }
    incCount(cnt, first, 3);
  }
  // 尝试顺子（同花色连续三张）
  if (num <= 7) {
    const a = s + (num + 1);
    const b = s + (num + 2);
    if ((cnt.get(a) || 0) > 0 && (cnt.get(b) || 0) > 0) {
      decCount(cnt, first, 1);
      decCount(cnt, a, 1);
      decCount(cnt, b, 1);
      if (canFormMelds(cnt, n - 1)) {
        incCount(cnt, first, 1);
        incCount(cnt, a, 1);
        incCount(cnt, b, 1);
        return true;
      }
      incCount(cnt, first, 1);
      incCount(cnt, a, 1);
      incCount(cnt, b, 1);
    }
  }
  return false;
}

/**
 * 公共找将：遍历牌计数找可作将牌的牌（c>=2），移除 2 张后尝试把剩余牌拆成面子。
 * checkHu 与 checkHuWithMelds 末尾共用同一循环，抽取避免重复实现，行为完全等价。
 * @param {Map<string, number>} cnt 手牌计数（已排序）
 * @param {number} meldCount 需要拆出的面子数 = (hand.length - 2) / 3
 * @returns {boolean} 是否存在某张牌作将后剩余牌可全部组成面子
 */
function _tryPairAsEye(cnt, meldCount) {
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
 * @param {string[]} hand 手牌
 * @param {object[]} [melds] 明牌区（碰/杠刻子），非空时走 checkHuWithMelds
 */
function checkHu(hand, melds) {
  if (!Array.isArray(hand) || hand.length % 3 !== 2) return false;
  if (Array.isArray(melds) && melds.length > 0) return checkHuWithMelds(hand, melds);
  if (hand.length === 2) {
    const cnt = countTiles(hand);
    const vals = [...cnt.values()];
    return vals.length === 1 && vals[0] === 2;
  }
  if (isQiDui(hand)) return true;
  const cnt = countTiles(sortTiles(hand));
  const meldCount = (hand.length - 2) / 3;
  return _tryPairAsEye(cnt, meldCount);
}

/**
 * 胡牌判定（带明牌区）：将碰/杠刻子作为已成型面子参与结构计算。
 * 手牌长度须等于 (4 - 明牌面子数) * 3 + 2（杠的展示第 4 张为冗余展示，不参与结构）。
 * 例：碰 1 次手牌 11 张（11+3=14 张等效）、杠 1 次手牌 11 张（11+4=15 张）、碰 1 杠 1 手牌 8 张。
 */
function checkHuWithMelds(hand, melds) {
  if (!Array.isArray(hand) || !Array.isArray(melds)) return false;
  const m = melds.filter((x) => x && typeof x === 'object' && x.tile);
  const meldSets = m.length;
  if (meldSets > 4) return false;
  for (const mm of m) {
    if (mm.type !== 'peng' && mm.type !== 'gang' && mm.type !== 'angang' && mm.type !== 'bugang') {
      return false;
    }
    const c = countTiles(mm.tiles || []).get(mm.tile) || 0;
    if (c < 3) return false;
  }
  const need = (4 - meldSets) * 3 + 2;
  if (hand.length !== need) return false;
  const cnt = countTiles(sortTiles(hand));
  const meldCount = (hand.length - 2) / 3;
  return _tryPairAsEye(cnt, meldCount);
}

/** 胡某张牌：hand（通常 13 张）+ tile 是否成胡；melds 非空时按带明牌判定 */
function canHuWith(hand, tile, melds) {
  if (Array.isArray(melds) && melds.length > 0) return checkHuWithMelds([...hand, tile], melds);
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

/** 听牌列表：手牌摸入哪张即胡；melds 非空时按带明牌区（碰/杠刻子）计算听口 */
function isTing(hand, melds) {
  const res = [];
  const withMelds = Array.isArray(melds) && melds.length > 0;
  for (const t of getTileTypes()) {
    if (withMelds) {
      if (checkHuWithMelds([...hand, t], melds)) res.push(t);
    } else if (checkHu([...hand, t])) res.push(t);
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
 * 报听资格：手牌（14 张，摸牌后；或碰后 11 张）中存在一张牌 t，打出后仍听牌，
 * 且听口列表中至少包含一张 6 点及以上牌（6/7/8/9/字牌=10点）。
 * 明牌区碰/杠刻子（melds）作为已成型面子参与听口计算。
 */
function canDeclareTing136(hand, melds) {
  for (const t of [...new Set(hand)]) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(t), 1);
    const ting = isTing(rest, melds);
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

// ============ 红中麻将（西安红中）判定模块 ============
// 独立于扣点点 136 模式：112 张牌（万筒条 1-9 各 4 + 红中 z0 × 4），红中为万能癞子。
// 不改动扣点点既有函数行为，仅新增以下红中专用函数。

/** 红中玩法全部 28 种牌型：27 数牌 + 红中 */
function getHongZhongTileTypes() {
  const types = ALL_TILE_TYPES.slice(); // w1..w9 / t1..t9 / b1..b9
  types.push(HONG_ZHONG);
  return types;
}

function isHongZhong(t) {
  return t === HONG_ZHONG;
}

/** 生成红中麻将完整牌墙：112 张（万筒条 1-9 各 4 + 红中 4） */
function createTiles112() {
  const tiles = [];
  for (const t of ALL_TILE_TYPES) {
    for (let k = 0; k < 4; k++) tiles.push(t);
  }
  for (let k = 0; k < 4; k++) tiles.push(HONG_ZHONG);
  return tiles;
}

/** 拆面子（含癞子）：把 cnt（已剔除红中）拆成 n 组面子，缺张可用红中补齐。
 *  每副面子（顺/刻）由真实牌与 wild 张红中共同组成，红中不能在同一位置重复使用（受 wild 总量约束）。
 */
function canFormMeldsWithWild(cnt, n, wild) {
  if (n === 0) {
    if (wild !== 0) return false;
    for (const c of cnt.values()) if (c > 0) return false;
    return true;
  }
  let first = null;
  for (const [tile, c] of cnt) {
    if (c > 0) { first = tile; break; }
  }
  if (first === null) {
    // 剩余面子全部由红中补齐（如 3 张红中成刻）
    return wild >= 3 * n;
  }
  const s = suitOf(first);
  const num = numOf(first);

  // 刻子：真实 first 3-wUsed 张 + wUsed 张红中
  for (let wUsed = 0; wUsed <= 3 && wUsed <= wild; wUsed++) {
    const realNeed = 3 - wUsed;
    if ((cnt.get(first) || 0) >= realNeed) {
      const c2 = new Map(cnt);
      decCount(c2, first, realNeed);
      if (canFormMeldsWithWild(c2, n - 1, wild - wUsed)) return true;
    }
  }
  // 顺子：first 必须作为顺子的一部分；顺子起点 a 可为 num-2 / num-1 / num（合法范围），
  // 每个位置优先用真实牌，也可用红中补齐（枚举各位置红中用量，保留真实牌给后续结构）。
  // 例：b8,b9+红中 可成 7,8,9（起点 7，红中补 b7）；w2,w3+红中 可成 1,2,3 或 2,3,4。
  const startMin = Math.max(1, num - 2);
  const startMax = Math.min(7, num);
  for (let a = startMin; a <= startMax; a++) {
    const pos = [s + a, s + (a + 1), s + (a + 2)];
    const posReal = pos.map((t) => (t === first ? 1 : (cnt.get(t) || 0)));
    for (let mask = 0; mask < 8; mask++) {
      let needWild = 0;
      let ok = true;
      const c2 = new Map(cnt);
      for (let i = 0; i < 3; i++) {
        // first 所在位置必须消耗真实牌，避免同组红中重复形成顺子
        const useReal = (pos[i] === first) || ((mask >> i) & 1);
        if (useReal) {
          if (posReal[i] <= 0) { ok = false; break; }
          decCount(c2, pos[i], 1);
        } else {
          needWild++;
        }
      }
      if (!ok || needWild > wild) continue;
      if (canFormMeldsWithWild(c2, n - 1, wild - needWild)) return true;
    }
  }
  return false;
}

/** 找将（含癞子）：cnt（已剔除红中）+ wild 张红中，先取一对将，剩余拆 n 组面子。 */
function _tryPairAsEyeWithWild(cnt, n, wild) {
  // 真对作将
  for (const [tile, c] of cnt) {
    if (c >= 2) {
      const c2 = new Map(cnt);
      decCount(c2, tile, 2);
      if (canFormMeldsWithWild(c2, n, wild)) return true;
    }
  }
  // 1 真 + 1 红中作将
  if (wild >= 1) {
    for (const [tile, c] of cnt) {
      if (c >= 1) {
        const c2 = new Map(cnt);
        decCount(c2, tile, 1);
        if (canFormMeldsWithWild(c2, n, wild - 1)) return true;
      }
    }
  }
  // 2 红中作将（红中可当任意牌）
  if (wild >= 2) {
    if (canFormMeldsWithWild(new Map(cnt), n, wild - 2)) return true;
  }
  return false;
}

/** 七小对（含癞子）：14 张全部成对，红中可补单张凑对，剩余红中两两成对 */
function isQiDuiHongZhong(hand) {
  if (hand.length !== 14) return false;
  const wild = countTiles(hand).get(HONG_ZHONG) || 0;
  const cnt = countTiles(hand);
  cnt.delete(HONG_ZHONG);
  let need = 0;
  for (const c of cnt.values()) need += c % 2; // 奇数张的每种需 1 张红中补成对
  if (need > wild) return false;
  return (wild - need) % 2 === 0;
}

/** 龙七对（含癞子）：七对成立，且存在 4 张相同牌（红中可充当） */
function isLongQiDuiHongZhong(hand) {
  if (!isQiDuiHongZhong(hand)) return false;
  const wild = countTiles(hand).get(HONG_ZHONG) || 0;
  const cnt = countTiles(hand);
  cnt.delete(HONG_ZHONG);
  for (const [tile, c] of cnt) {
    if (c >= 4) return true;
    const red = 4 - c; // 用 red 张红中把该牌补成 4 张
    if (red > wild) continue;
    const restWild = wild - red;
    let need = 0;
    for (const [t2, c2] of cnt) {
      if (t2 !== tile) need += c2 % 2;
    }
    if (need <= restWild && (restWild - need) % 2 === 0) return true;
  }
  return false;
}

/** 剩余牌能否拆成 meldCount 副刻子（含癞子）：红中可补刻 */
function allKezisWithWild(cnt, wild, meldCount) {
  let realCount = 0;
  let need = 0;
  for (const c of cnt.values()) {
    realCount += c;
    const r = c % 3;
    if (r === 1) need += 2;
    else if (r === 2) need += 1;
  }
  if (realCount === 0) return wild >= 3 * meldCount;
  return need <= wild && (wild - need) % 3 === 0;
}

/** 碰碰胡（含癞子）：手牌部分（+ 明牌区刻子）拆成 4 刻 + 1 将，红中可补刻/将 */
function isPengPengHuHongZhong(hand, melds, wild = 0) {
  const m = (Array.isArray(melds) ? melds : []).filter((x) => x && typeof x === 'object' && x.tile);
  const meldSets = m.length;
  const handMeldCount = 4 - meldSets;
  const cnt = countTiles(sortTiles(hand));
  cnt.delete(HONG_ZHONG);
  // 真对作将
  for (const [tile, c] of cnt) {
    if (c >= 2) {
      const c2 = new Map(cnt);
      decCount(c2, tile, 2);
      if (allKezisWithWild(c2, wild, handMeldCount)) return true;
    }
  }
  // 1 真 + 1 红中作将
  if (wild >= 1) {
    for (const [tile, c] of cnt) {
      if (c >= 1) {
        const c2 = new Map(cnt);
        decCount(c2, tile, 1);
        if (allKezisWithWild(c2, wild - 1, handMeldCount)) return true;
      }
    }
  }
  // 2 红中作将
  if (wild >= 2) {
    if (allKezisWithWild(new Map(cnt), wild - 2, handMeldCount)) return true;
  }
  return false;
}

/** 花色信息（红中玩法）：非红中牌花色 + 是否含红中 */
function _suitInfoHongZhong(hand, melds) {
  const tiles = hand.slice();
  for (const m of melds || []) {
    if (m && Array.isArray(m.tiles)) tiles.push(...m.tiles);
  }
  const nonWild = tiles.filter((t) => t !== HONG_ZHONG);
  const hasWild = tiles.some((t) => t === HONG_ZHONG);
  if (nonWild.length === 0) return { oneSuit: false, suit: null, hasWild };
  const s = suitOf(nonWild[0]);
  const oneSuit = nonWild.every((t) => suitOf(t) === s);
  return { oneSuit, suit: s, hasWild };
}

/** 清一色：所有非红中牌同一花色，且无红中（红中算字牌，不计入清一色） */
function isQingYiSeHongZhong(hand, melds) {
  const si = _suitInfoHongZhong(hand, melds);
  return si.oneSuit && !si.hasWild;
}

/** 混一色：所有非红中牌同一花色，且含红中（红中作字牌） */
function isHunYiSeHongZhong(hand, melds) {
  const si = _suitInfoHongZhong(hand, melds);
  return si.oneSuit && si.hasWild;
}

/**
 * 红中麻将胡牌判定（核心癞子胡）：
 *  - 红中(z0)从手牌抽出为癞子 wildCount，可补顺子/刻子/将；
 *  - 明牌区（碰/杠）为已成型面子，不可被红中替代补成；
 *  - 支持平胡/碰碰胡/七小对/龙七对/清一色/混一色；
 *  - 起手 4 张红中直接天胡（开牌即胡）。
 * @param {string[]} hand 手牌
 * @param {object[]} [melds] 明牌区（碰/杠）
 */
function checkHuHongZhong(hand, melds) {
  if (!Array.isArray(hand)) return false;
  const m = (Array.isArray(melds) ? melds : []).filter((x) => x && typeof x === 'object' && x.tile);
  const meldSets = m.length;
  if (meldSets > 4) return false;
  for (const mm of m) {
    if (mm.type !== 'peng' && mm.type !== 'gang' && mm.type !== 'angang' && mm.type !== 'bugang') {
      return false;
    }
    const c = countTiles(mm.tiles || []).get(mm.tile) || 0;
    if (c < 3) return false;
  }
  const wild = countTiles(hand).get(HONG_ZHONG) || 0;
  // 天胡：起手 4 张红中直接胡（无明牌区）
  if (meldSets === 0 && hand.length === 14 && wild === 4) return true;
  const need = (4 - meldSets) * 3 + 2;
  if (hand.length !== need) return false;
  // 门清七小对/龙七对（无明牌区）
  if (meldSets === 0 && isQiDuiHongZhong(hand)) return true;
  const cnt = countTiles(sortTiles(hand));
  cnt.delete(HONG_ZHONG);
  const meldCount = (hand.length - 2) / 3;
  return _tryPairAsEyeWithWild(cnt, meldCount, wild);
}

/** 摸/吃入某张牌后是否成胡（红中麻将） */
function canHuHongZhongWith(hand, tile, melds) {
  return checkHuHongZhong([...hand, tile], melds);
}

/** 红中玩法听口：摸入哪张可胡（28 种牌型，含红中） */
function isTingHongZhong(hand, melds) {
  const res = [];
  for (const t of getHongZhongTileTypes()) {
    if (checkHuHongZhong([...hand, t], melds)) res.push(t);
  }
  return res;
}

// 红中可碰/可杠，但不可代碰杠：碰/杠对象必须是真实红中或真实牌，红中不能当万能牌参与碰/杠。
function canPengHongZhong(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 2;
}

function canGangHongZhong(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 3;
}

function canAnGangHongZhong(hand, tile) {
  return (countTiles(hand).get(tile) || 0) >= 4;
}

/** 中码牌：1/5/9 万筒条 + 红中 */
const ZHONG_MA_TILES = ['w1', 'w5', 'w9', 't1', 't5', 't9', 'b1', 'b5', 'b9', HONG_ZHONG];

function isZhongMa(tile) {
  return ZHONG_MA_TILES.includes(tile);
}

function countZhongMa(tiles) {
  return (tiles || []).filter((t) => isZhongMa(t)).length;
}

/**
 * 红中麻将番数（历史规则，仅保留供规则单测/参考；正式结算已改为无番公式，不再调用本函数）：
 *  现行结算：胡牌 = 底注×中码倍数×基础手数（自摸2/抢杠1/点炮1）；
 *  杠分当场结算（放杠2手/补杠每家1手/暗杠每家2手），不再并入番数。
 *  历史番数（底分 1，倍数 = 2^总番）：
 *  自摸/抢杠 +1、门清 +1、七小对 +2、龙七对 +3、碰碰胡 +2、混一色 +2、清一色 +4、
 *  明杠(含补杠) +1、暗杠 +2、红中杠 +2（红中杠不再叠加明/暗杠）。
 * @param {string[]} hand 胡牌手牌
 * @param {object} info { winType:'zimo'|'dianpao'|'qianggang', menQing, melds }
 * @param {boolean} [detail] true 时返回 { fan, mult, names }
 */
function calcMultiplierHongZhong(hand, info = {}, detail = false) {
  const m = (Array.isArray(info.melds) ? info.melds : []).filter((x) => x && typeof x === 'object' && x.tile);
  const wild = countTiles(hand).get(HONG_ZHONG) || 0;
  let fan = 0;
  const names = [];
  // 自摸/抢杠
  const winType = info.winType || 'zimo';
  if (winType === 'zimo' || winType === 'qianggang') {
    fan += 1;
    names.push('自摸');
  }
  // 门清：默认没有碰/明杠/补杠（暗杠不算破门清）
  const menQing =
    info.menQing !== undefined
      ? info.menQing
      : !m.some((x) => x.type === 'peng' || x.type === 'gang' || x.type === 'bugang');
  if (menQing) {
    fan += 1;
    names.push('门清');
  }
  // 牌型
  let hasShape = false;
  if (m.length === 0) {
    if (isLongQiDuiHongZhong(hand)) {
      fan += 3;
      names.push('龙七对');
      hasShape = true;
    } else if (isQiDuiHongZhong(hand)) {
      fan += 2;
      names.push('七小对');
      hasShape = true;
    }
  }
  if (isPengPengHuHongZhong(hand, m, wild)) {
    fan += 2;
    names.push('碰碰胡');
    hasShape = true;
  }
  const si = _suitInfoHongZhong(hand, m);
  if (si.oneSuit) {
    if (!si.hasWild) {
      fan += 4;
      names.push('清一色');
    } else {
      fan += 2;
      names.push('混一色');
    }
    hasShape = true;
  }
  if (!hasShape) names.push('平胡');
  // 杠
  for (const mm of m) {
    if (mm.tile === HONG_ZHONG) {
      fan += 2;
      names.push('红中杠');
    } else if (mm.type === 'angang') {
      fan += 2;
      names.push('暗杠');
    } else if (mm.type === 'gang' || mm.type === 'bugang') {
      fan += 1;
      names.push('明杠');
    }
  }
  const mult = Math.pow(2, fan);
  return detail ? { fan, mult, names } : { fan, mult };
}

// ============ 运城贴金麻将（tiejin）判定模块 ============
// 136 张无花（万筒条 + 东南西北中发白），不可吃、可碰可杠（明杠/暗杠/补杠）、无报听。
// 每局从牌墙翻一张「金母」确定本局「金牌」（万能牌，共 4 张）：
//   - 序数牌翻 x → 金牌 = 10-x（翻 5 → 5）；翻发财 → 金牌=发财；
//   - 风/箭按对牌关系：东↔西、南↔北、中↔白、发↔发。
// 金牌可当任意牌参与顺子/刻子/将（万能），但金牌本身不能被碰/杠（碰杠对象必须是真实牌）。
// 本模块不改动扣点点/红中既有函数，仅新增贴金专用函数。

/** 金母 → 金牌：字牌对牌关系（东↔西、南↔北、中↔白、发↔发） */
const TIEJIN_HONOR_PAIR = { e: 'x', x: 'e', s: 'n', n: 's', z: 'p', p: 'z', f: 'f' };

/** 根据金母确定本局金牌（序数牌翻 x → 10-x；翻 5 → 5；发 → 发；风箭按对牌） */
function goldFromMother(mother) {
  if (!mother) return null;
  const s = mother[0];
  if (s === 'w' || s === 't' || s === 'b') {
    const n = Number(mother[1]);
    return s + String(10 - n);
  }
  return TIEJIN_HONOR_PAIR[mother] || mother;
}

/** 是否为金牌 */
function isGold(tile, gold) {
  return !!gold && tile === gold;
}

/** 手牌中金牌数量 */
function countGold(hand, gold) {
  if (!gold) return 0;
  return (hand || []).filter((t) => t === gold).length;
}

/** 贴金胡牌判定（核心万能胡）：3+2 基本牌型（四副顺子/刻子 + 一对将），
 *  金牌可补顺子前/中/后位、补刻子、补将（复用 _tryPairAsEyeWithWild 拆牌）；
 *  明牌区（碰/杠）为真实牌成型面子，金牌不可参与碰/杠（流程保证，此处双保险）；
 *  仅支持平胡/碰碰胡（含金牌补刻/补将），不含七对等特殊牌型。 */
function checkHuTieJin(hand, melds, gold) {
  if (!Array.isArray(hand)) return false;
  if (!gold) return checkHu(hand, melds);
  const m = (Array.isArray(melds) ? melds : []).filter((x) => x && typeof x === 'object' && x.tile);
  const meldSets = m.length;
  if (meldSets > 4) return false;
  for (const mm of m) {
    if (mm.type !== 'peng' && mm.type !== 'gang' && mm.type !== 'angang' && mm.type !== 'bugang') {
      return false;
    }
    if (mm.tile === gold) return false; // 金牌不可被碰/杠
    const c = countTiles(mm.tiles || []).get(mm.tile) || 0;
    if (c < 3) return false;
  }
  const wild = countGold(hand, gold);
  const need = (4 - meldSets) * 3 + 2;
  if (hand.length !== need) return false;
  const cnt = countTiles(sortTiles(hand));
  cnt.delete(gold);
  const meldCount = (hand.length - 2) / 3;
  return _tryPairAsEyeWithWild(cnt, meldCount, wild);
}

/** 摸/抢入某张牌后是否成胡（贴金麻将） */
function canHuTieJinWith(hand, tile, melds, gold) {
  return checkHuTieJin([...hand, tile], melds, gold);
}

/** 贴金可碰：必须真实牌（金牌不可碰）且手牌同牌 ≥2 */
function canPengTieJin(hand, tile, gold) {
  if (isGold(tile, gold)) return false;
  return (countTiles(hand).get(tile) || 0) >= 2;
}

/** 贴金明杠（放杠）：必须真实牌（金牌不可杠）且手牌同牌 ≥3 */
function canGangTieJin(hand, tile, gold) {
  if (isGold(tile, gold)) return false;
  return (countTiles(hand).get(tile) || 0) >= 3;
}

/** 贴金暗杠：真实牌 ≥4（金牌不可杠） */
function canAnGangTieJin(hand, tile, gold) {
  if (isGold(tile, gold)) return false;
  return (countTiles(hand).get(tile) || 0) >= 4;
}

/** 贴金补杠：手中有 1 张真实同牌且明牌区已有该牌碰/杠（金牌不可补杠） */
function canBuGangTieJin(hand, melds, tile, gold) {
  if (isGold(tile, gold)) return false;
  if ((countTiles(hand).get(tile) || 0) < 1) return false;
  return (Array.isArray(melds) ? melds : []).some(
    (mm) => mm && (mm.type === 'peng' || mm.type === 'gang' || mm.type === 'bugang') && mm.tile === tile
  );
}

/** 全字牌整副：手牌+明牌区全部为字牌且不含金牌（金牌不代替，字牌整副胡须为真实字牌） */
function isAllHonorShape(hand, melds, gold) {
  const tiles = (Array.isArray(hand) ? hand : []).slice();
  for (const m of melds || []) {
    if (m && Array.isArray(m.tiles)) tiles.push(...m.tiles);
  }
  if (tiles.length === 0) return false;
  if (tiles.some((t) => isGold(t, gold))) return false;
  return tiles.every((t) => HONOR_NAMES[t] !== undefined);
}

/** 计分 A（边趣/大唐版）金分：1金=1、2金=3、3金=9、4金及以上=27（3倍递增，27 封顶） */
function tiejinGoldScoreA(goldCount) {
  const g = Math.max(0, goldCount || 0);
  if (g <= 0) return 0;
  if (g === 1) return 1;
  if (g === 2) return 3;
  if (g === 3) return 9;
  return 27;
}

/** 计分 B（搜狗 125 打法）金分：1金=5、2金=15、3金=45、4金及以上=135（3倍叠加，135 封顶） */
function tiejinGoldScoreB(goldCount) {
  const g = Math.max(0, goldCount || 0);
  if (g <= 0) return 0;
  if (g === 1) return 5;
  if (g === 2) return 15;
  if (g === 3) return 45;
  return 135;
}

/**
 * 计分 A（边趣/大唐版）完整结算模型（支付明细由 game.js 按座位映射落地）：
 *  - 胡牌分 H：闲 1 / 庄 2（按赢家身份）；自摸每家付 2H；点炮三家各付 H（通赔）。
 *  - 金分 G：1金=1、2金=3、3金=9、4金+=27（27 封顶），金随胡走、胡后才计；
 *      自摸每家付 G；点炮三家各付 G，点炮者额外多一份（金分翻倍付 2G，通赔）。
 *  - 赢家得分 = 胡牌分收入 + 杠分（当场已结）+ 金分收入。
 * @param {object} info { winType:'zimo'|'dianpao'|'qianggang', winnerDealer:boolean, goldCount:number }
 * @returns {{ payers:[{amount,role,formula}], winnerGain, huGain, goldGain, H, G, isZimo }}
 *   注意 payers 顺序：点炮/抢杠时第 0 项为放炮者（被抢者）。
 */
function calcTieJinScoreA(info) {
  const H = info.winnerDealer ? 2 : 1;
  const G = tiejinGoldScoreA(info.goldCount);
  const isZimo = info.winType === 'zimo';
  const payers = [];
  let winnerGain = 0;
  if (isZimo) {
    for (let i = 0; i < 3; i++) {
      const amount = 2 * H + G;
      payers.push({ amount, role: '自摸', formula: `2×${H}(胡)+${G}(金)=${amount}` });
      winnerGain += amount;
    }
    return { payers, winnerGain, huGain: 6 * H, goldGain: 3 * G, H, G, isZimo: true };
  }
  // 点炮/抢杠：三家各付 H；金分三家各 G，点炮者额外多一份（2G）
  for (let i = 0; i < 3; i++) {
    const isShooter = i === 0;
    const amount = H + G + (isShooter ? G : 0);
    payers.push({
      amount,
      role: isShooter ? '点炮' : '闲家',
      formula: `${H}(胡)+${G}(金)${isShooter ? `+${G}(点炮金翻倍)` : ''}=${amount}`,
    });
    winnerGain += amount;
  }
  return { payers, winnerGain, huGain: 3 * H, goldGain: 4 * G, H, G, isZimo: false };
}

/**
 * 计分 B（搜狗 125 打法）完整结算模型：
 *  - 金分 G：1金=5、2金=15、3金=45、4金+=135（3倍叠加，135 封顶）。
 *  - 偏家赢家：基础份 P = 胡1 + 庄1 + G；点炮三家各付 P、点炮者 +1 炮钱；
 *      自摸偏家付 P、庄家付 P+3（庄家相关份）。
 *  - 庄家赢家：每家付 P+3（庄家身份×2 统一口径，1金时 7→10 与"庄家自摸共收 30"吻合）；
 *      点炮时点炮者再 +1 炮钱。
 *  - 杠分同 A（明杠每家 1、暗杠每家 2，当场结算，流局不计）。
 * @param {object} info { winType:'zimo'|'dianpao'|'qianggang', winnerDealer:boolean, goldCount:number }
 * @returns {{ payers:[{amount,role,formula}], winnerGain, G, base, dealerShare, isZimo, winnerIsDealer }}
 *   注意 payers 顺序：点炮/抢杠时第 0 项为放炮者（被抢者）。
 */
function calcTieJinScoreB(info) {
  const G = tiejinGoldScoreB(info.goldCount);
  const base = 1 + 1 + G; // 胡1 + 庄1 + 金G
  const dealerShare = base + 3; // 庄家相关份（1金时 7→10）
  const isZimo = info.winType === 'zimo';
  const winnerIsDealer = !!info.winnerDealer;
  const payers = [];
  let winnerGain = 0;
  const add = (amount, role, formula) => {
    payers.push({ amount, role, formula });
    winnerGain += amount;
  };
  if (winnerIsDealer) {
    for (let i = 0; i < 3; i++) {
      if (isZimo) {
        add(dealerShare, '庄家自摸', `${base}+3=${dealerShare}`);
      } else {
        const amount = dealerShare + (i === 0 ? 1 : 0);
        add(amount, i === 0 ? '点炮' : '闲家', `${dealerShare}${i === 0 ? '+1炮' : ''}=${amount}`);
      }
    }
  } else if (isZimo) {
    add(dealerShare, '庄家', `${base}+3=${dealerShare}`);
    for (let i = 0; i < 2; i++) add(base, '偏家', `${base}`);
  } else {
    add(base + 1, '点炮', `${base}+1炮=${base + 1}`);
    for (let i = 0; i < 2; i++) add(base, '闲家', `${base}`);
  }
  return { payers, winnerGain, G, base, dealerShare, isZimo, winnerIsDealer };
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
  rankOf,
  suitOf,
  numOf,
  tileName,
  countTiles,
  checkHu,
  checkHuWithMelds,
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
  // 红中麻将（西安红中）模块
  HONG_ZHONG,
  getHongZhongTileTypes,
  isHongZhong,
  createTiles112,
  checkHuHongZhong,
  canHuHongZhongWith,
  isTingHongZhong,
  canPengHongZhong,
  canGangHongZhong,
  canAnGangHongZhong,
  isQiDuiHongZhong,
  isLongQiDuiHongZhong,
  isPengPengHuHongZhong,
  isQingYiSeHongZhong,
  isHunYiSeHongZhong,
  calcMultiplierHongZhong,
  ZHONG_MA_TILES,
  isZhongMa,
  countZhongMa,
  // 运城贴金麻将（tiejin）模块
  TIEJIN_HONOR_PAIR,
  goldFromMother,
  isGold,
  countGold,
  checkHuTieJin,
  canHuTieJinWith,
  canPengTieJin,
  canGangTieJin,
  canAnGangTieJin,
  canBuGangTieJin,
  isAllHonorShape,
  tiejinGoldScoreA,
  tiejinGoldScoreB,
  calcTieJinScoreA,
  calcTieJinScoreB,
};
