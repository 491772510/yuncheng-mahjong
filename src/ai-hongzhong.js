'use strict';
// 红中麻将 AI 决策（从 src/game.js 拆出，独立模块）
// 简易策略：自摸/杠优先，出牌保留红中、优先拆孤张
const rules = require('./rules');

function decideDrawAction(g, room, seat) {
  const hand = g.hands[seat];
  // 碰后（未摸牌）：手牌结构不允许胡/杠，只能出牌（与 _buildDrawPromptHongZhong 保持一致，防止 AI 卡死）
  if (g.lastAction && g.lastAction.type === 'peng') {
    return { type: 'play', tile: chooseDiscard(g, room, seat) };
  }
  if (rules.checkHuHongZhong(hand, g.melds[seat])) {
    return { type: 'hu' };
  }
  const cnt = rules.countTiles(hand);
  for (const [t, c] of cnt) {
    if (c === 4) return { type: 'gang', tile: t, gangType: 'angang' };
  }
  for (const m of g.melds[seat]) {
    if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
      return { type: 'gang', tile: m.tile, gangType: 'bugang' };
    }
  }
  return { type: 'play', tile: chooseDiscard(g, room, seat) };
}

function chooseDiscard(g, room, seat) {
  const cnt = rules.countTiles(g.hands[seat]);
  const candidates = [];
  for (const [t, c] of cnt) {
    if (t === rules.HONG_ZHONG) continue; // 红中万能牌永不出
    if (c === 1) candidates.push(t); // 孤张优先
  }
  if (candidates.length === 0) {
    for (const [t, c] of cnt) {
      if (t === rules.HONG_ZHONG) continue;
      candidates.push(t);
    }
  }
  candidates.sort((a, b) => rules.numOf(a) - rules.numOf(b));
  const tile = candidates[0];
  if (tile) return tile;
  return g.hands[seat].find((t) => t !== rules.HONG_ZHONG) || g.hands[seat][0];
}

function decideResponse(g, room, seat, r) {
  if (r.canHu) return 'hu';
  if (r.canGang) return 'gang';
  if (r.canPeng) return 'peng';
  return 'pass';
}

module.exports = { decideDrawAction, decideResponse, chooseDiscard };
