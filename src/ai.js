'use strict';

/**
 * AI 决策模块（机器人 / 断线托管代打）
 * 简单可靠策略：能胡就胡、能杠就杠、按安全度与保留价值出牌。
 */

const rules = require('./rules');

/**
 * 回合摸牌后的决策
 * @returns {{type:'hu'|'gang'|'play', gangType?:string, tile?:string}}
 */
function decideDrawAction(game, room, seat) {
  const hand = game.hands[seat];

  // 1) 自摸胡（受点数限制：1/2 点不能胡，3/4/5 点可自摸）；明牌区刻子计入已成型面子
  if (
    game.drawnTile !== null &&
    game.tingSeats.includes(seat) && // A1 修复：136 玩法须报听后方可自摸胡（与真人提示一致，禁止跳过报听）
    rules.checkHu(hand, game.melds[seat]) &&
    rules.canHuByPoints(rules.tilePoints(game.drawnTile), 'zimo')
  ) {
    return { type: 'hu' };
  }

  // 1.5) 报听：房间开启且未报听时，若打出某张后仍听牌且听口含 ≥6 点牌则报听（优先于杠，保住听口）
  // 覆盖两种时机：摸牌后（drawnTile 非空）与碰牌后未摸牌（justPeng，碰完即听立即识别，不待下一轮摸牌）
  // 听口判定均计入明牌区碰/杠刻子（melds）
  const justPeng = !!(game.lastAction && game.lastAction.type === 'peng');
  if (
    room.settings.allowTing &&
    (!game.tingSeats || !game.tingSeats.includes(seat)) &&
    (game.drawnTile !== null || justPeng)
  ) {
    if (rules.canDeclareTing136(hand, game.melds[seat])) {
      for (const t of [...new Set(hand)]) {
        const rest = hand.slice();
        rest.splice(rest.indexOf(t), 1);
        if (rules.isTing(rest, game.melds[seat]).some((x) => rules.tilePoints(x) >= 6)) {
          return { type: 'ting', tile: t };
        }
      }
    }
  }

  // 2) 暗杠 / 3) 补杠：仅摸牌后可杠（碰牌后 drawnTile 为 null，服务端 _gang 会拒绝“当前不能杠”，
  // 若此处仍返回 gang，AI 动作被拒后无后续出牌，牌局将死锁）
  if (game.drawnTile !== null) {
    const cnt = rules.countTiles(hand);
    for (const [t, c] of cnt) {
      if (c === 4) return { type: 'gang', gangType: 'angang', tile: t };
    }
    for (const m of game.melds[seat]) {
      if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
        return { type: 'gang', gangType: 'bugang', tile: m.tile };
      }
    }
  }

  // 4) 出牌
  return { type: 'play', tile: chooseDiscard(hand, game, room, seat) };
}

/**
 * 响应阶段决策（碰/杠/胡/过）
 */
function decideResponse(game, room, seat, prompt) {
  if (prompt.canHu) return 'hu';
  if (prompt.canGang) return 'gang';
  if (prompt.canPeng) {
    // 简单策略：接近听牌时倾向不碰，否则碰；明牌区刻子计入听口判断
    if (game.hands[seat].length <= 13 && rules.isTing(game.hands[seat], game.melds[seat]).length > 0) return 'pass';
    return 'peng';
  }
  return 'pass';
}

/**
 * 出牌选择：安全度优先（别人打过的牌），其次保留价值低（孤张/边张）的牌
 */
function chooseDiscard(hand, game, room, seat) {
  const safe = new Set();
  for (const d of game.discards) {
    for (const t of d) safe.add(t);
  }

  const cnt = rules.countTiles(hand);
  let best = null;
  let bestScore = Infinity;
  for (const t of hand) {
    const c = cnt.get(t);
    const s = rules.suitOf(t);
    const num = rules.numOf(t);
    let score = 0;
    // 对子/刻子保留价值高（分数高 = 不优先打）
    if (c >= 3) score += 40;
    else if (c === 2) score += 20;
    // 相邻牌成顺价值
    for (const d of [-2, -1, 1, 2]) {
      const nt = s + (num + d);
      if (num + d >= 1 && num + d <= 9 && cnt.get(nt)) score += 3 - Math.abs(d);
    }
    // 边张价值略低
    if (num === 1 || num === 9) score -= 1;
    // 安全牌优先打出
    if (safe.has(t)) score -= 12;
    // 与上家刚打出的牌同花色的中张保守处理：无额外逻辑
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best || hand[0];
}

module.exports = {
  decideDrawAction,
  decideResponse,
  chooseDiscard,
};
