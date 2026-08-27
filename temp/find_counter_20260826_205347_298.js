'use strict';
// 随机对比：现有 isTing(无melds) vs 参考实现 isTingWithMelds，找反例
const rules = require('../src/rules');

// 复制 canFormMelds 实现（未导出）
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
  const s = rules.suitOf(first);
  const num = rules.numOf(first);
  if (cnt.get(first) >= 3) {
    const c2 = new Map(cnt);
    const rest = c2.get(first) - 3;
    if (rest === 0) c2.delete(first);
    else c2.set(first, rest);
    if (canFormMelds(c2, n - 1)) return true;
  }
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

// 参考实现：带 melds 的胡牌判定（melds 每组 = 1 面子）
function checkHuWithMelds(hand, melds) {
  const m = melds || [];
  if (!Array.isArray(hand)) return false;
  const need = (4 - m.length) * 3 + 2;
  if (hand.length !== need) return false;
  if (hand.length === 2) {
    const cnt = rules.countTiles(hand);
    const vals = [...cnt.values()];
    return vals.length === 1 && vals[0] === 2;
  }
  const cnt = rules.countTiles(rules.sortTiles(hand));
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

function isTingWithMelds(hand, melds) {
  const res = [];
  for (const t of rules.getTileTypes()) {
    if (checkHuWithMelds([...hand, t], melds)) res.push(t);
  }
  return res;
}

function randomTiles(count, used) {
  const pool = [];
  for (const t of rules.getTileTypes()) {
    let n = 4 - (used.get(t) || 0);
    if (n > 0) for (let i = 0; i < n; i++) pool.push(t);
  }
  const hand = [];
  for (let i = 0; i < count; i++) {
    if (pool.length === 0) break;
    const idx = Math.floor(Math.random() * pool.length);
    hand.push(pool.splice(idx, 1)[0]);
  }
  return hand;
}

function genCase() {
  const meldCount = 1 + Math.floor(Math.random() * 3); // 1~3 组
  const melds = [];
  const used = new Map();
  for (let i = 0; i < meldCount; i++) {
    let t;
    do { t = rules.getTileTypes()[Math.floor(Math.random() * 34)]; } while ((used.get(t) || 0) >= 4);
    used.set(t, (used.get(t) || 0) + 4);
    const type = ['peng', 'gang', 'angang', 'bugang'][Math.floor(Math.random() * 4)];
    const n = type === 'peng' ? 3 : 4;
    melds.push({ type, tile: t, tiles: Array(n).fill(t) });
  }
  const handLen = (4 - meldCount) * 3 + 2;
  const hand = randomTiles(handLen, used);
  return { hand, melds };
}

let found = 0;
for (let iter = 0; iter < 200000; iter++) {
  const { hand, melds } = genCase();
  // 场景A：手牌即"出牌后手牌"（碰后出牌剩 10 张等），isTing 检查 [hand + t]
  const handA = hand.length >= 1 ? hand.slice(0, hand.length - 1) : hand.slice();
  // 场景B：完整手牌（摸牌后），模拟 canDeclareTing136：打出每张后 isTing
  const handB = hand.slice();
  for (const [mode, hand2] of [['A', handA], ['B', handB]]) {
    const t1 = rules.isTing(hand2);
    const t2 = isTingWithMelds(hand2, melds);
    const s1 = t1.slice().sort().join(',');
    const s2 = t2.slice().sort().join(',');
    if (s1 !== s2) {
      found++;
      console.log(`[${mode}] 不一致! hand=${hand2.join(',')} melds=${JSON.stringify(melds)}`);
      console.log(`  无melds: [${s1}]`);
      console.log(`  带melds: [${s2}]`);
      if (found >= 10) process.exit(0);
    }
  }
}
console.log('完成，不一致用例数:', found);
