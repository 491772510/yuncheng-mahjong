'use strict';
// 贴金麻将 AI 决策（从 src/game.js 拆出，独立模块）
// 简易策略：胡/杠优先，有金必亮金，出牌保留金牌
const rules = require('./rules');

/** 贴金流局判定：开关 A=摸完最后一张（剩余<=0）；开关 B=剩 10 墩硬黄（剩余<=20 张） */
function tieJinWallEnded(room, g) {
  const remain = g.wall.length - g.wallPos;
  if (room.settings && room.settings.drawEndMode === 'B') return remain <= 20;
  return remain <= 0;
}

function decideDrawAction(g, room, seat) {
  const hand = g.hands[seat];
  if (g.lastAction && g.lastAction.type === 'peng') {
    const goldCountAfterPeng = g.goldTile ? rules.countGold(hand, g.goldTile) : 0;
    if (goldCountAfterPeng > 0 && !tieJinWallEnded(room, g)) {
      return { type: 'liangjin' };
    }
    return { type: 'play', tile: chooseDiscard(g, room, seat) };
  }
  if (rules.checkHuTieJin(hand, g.melds[seat], g.goldTile)) {
    return { type: 'hu' };
  }
  const cnt = rules.countTiles(hand);
  for (const [t, c] of cnt) {
    if (c === 4 && !rules.isGold(t, g.goldTile)) return { type: 'gang', tile: t, gangType: 'angang' };
  }
  for (const m of g.melds[seat]) {
    if ((m.type === 'peng' || m.type === 'bugang') && (cnt.get(m.tile) || 0) >= 1 && !rules.isGold(m.tile, g.goldTile)) {
      return { type: 'gang', tile: m.tile, gangType: 'bugang' };
    }
  }
  const goldCount = g.goldTile ? rules.countGold(hand, g.goldTile) : 0;
  // 有金必亮金（拥有出牌权、牌墙未结束）：连续亮金两张后自动触发锁金
  if (goldCount > 0 && !tieJinWallEnded(room, g)) {
    return { type: 'liangjin' };
  }
  return { type: 'play', tile: chooseDiscard(g, room, seat) };
}

function chooseDiscard(g, room, seat) {
  const cnt = rules.countTiles(g.hands[seat]);
  const candidates = [];
  for (const [t, c] of cnt) {
    if (rules.isGold(t, g.goldTile)) continue; // 金牌万能牌保留
    if (c === 1) candidates.push(t);
  }
  if (candidates.length === 0) {
    for (const [t, c] of cnt) if (!rules.isGold(t, g.goldTile)) candidates.push(t);
  }
  if (candidates.length === 0) {
    return g.hands[seat].find((t) => !rules.isGold(t, g.goldTile)) || g.hands[seat][0];
  }
  candidates.sort((a, b) => rules.numOf(a) - rules.numOf(b));
  return candidates[0];
}

function decideResponse(g, room, seat, r) {
  if (r.canHu) return 'hu';
  if (r.canGang) return 'gang';
  if (r.canPeng) return 'peng';
  return 'pass';
}

module.exports = { decideDrawAction, decideResponse, chooseDiscard, tieJinWallEnded };
