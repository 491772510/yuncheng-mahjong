'use strict';
// 随机对比：现有 isTing(无melds) vs 参考实现 isTingWithMelds，找反例
const rules = require('../src/rules');
const { countTiles, canFormMelds } = require('../src/rules');

// 参考实现：带 melds 的胡牌判定
function checkHuWithMelds(hand, melds) {
  const m = melds || [];
  if (!Array.isArray(hand)) return false;
  const need = (4 - m.length) * 3 + 2;
  if (hand.length !== need) return false;
  if (hand.length === 2) {
    const cnt = countTiles(hand);
    const vals = [...cnt.values()];
    return vals.length === 1 && vals[0] === 2;
  }
  const cnt = countTiles(rules.sortTiles(hand));
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

// 生成完整牌墙并随机抽取手牌
function randomTiles(count, exclude) {
  const pool = [];
  const ex = new Set(exclude || []);
  for (const t of rules.getTileTypes()) {
    let n = 4 - (ex.has(t) ? 1 : 0);
    if (n > 0) for (let i = 0; i < n; i++) pool.push(t);
  }
  const hand = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    hand.push(pool.splice(idx, 1)[0]);
  }
  return hand;
}

// 生成随机 melds（碰/杠），并生成配套手牌：随机生成直到满足胡牌结构（含 melds）
function genCase() {
  const meldCount = 1 + Math.floor(Math.random() * 3); // 1~3 组
  const melds = [];
  const used = new Set();
  for (let i = 0; i < meldCount; i++) {
    let t;
    do { t = rules.getTileTypes()[Math.floor(Math.random() * 34)]; } while (used.has(t));
    used.add(t);
    const type = ['peng', 'gang', 'angang', 'bugang'][Math.floor(Math.random() * 4)];
    melds.push({ type, tile: t, tiles: Array(type === 'peng' ? 3 : 4).fill(t) });
  }
  const handLen = (4 - meldCount) * 3 + 2;
  const hand = randomTiles(handLen, []);
  return { hand, melds };
}

// 找出：isTing(无melds) 与 isTingWithMelds 不一致的用例
let found = 0;
for (let iter = 0; iter < 200000; iter++) {
  const { hand, melds } = genCase();
  // 场景A：手牌即"出牌后手牌"（如碰后 10 张），isTing 检查 [hand + t]
  // 场景B：完整手牌（如碰后摸牌 11 张），模拟 canDeclareTing136：打出每张后 isTing
  for (const mode of ['A', 'B']) {
    const hand2 = mode === 'A' ? hand.slice(0, hand.length - 1) : hand.slice();
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
