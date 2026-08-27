'use strict';
// 直接构造 room.game 状态，验证 _ting 在"碰后摸牌"场景的真实行为
const { GameServer } = require('../src/game');
const rules = require('../src/rules');

function makePlayer(server, name, seat) {
  const ws = { readyState: 1, close() {}, on() {}, send() {} };
  const p = server._createPlayer(ws, name);
  p.roomId = 'r1';
  p.seat = seat;
  return p;
}

function makeRoom(server, players, game) {
  const room = {
    id: 'r1',
    state: 'playing',
    ownerId: players[0].id,
    roundNo: 1,
    settings: { allowTing: true, aiFill: true, totalRounds: 4, qingYiSeMult: 4, yiTiaoLongMult: 4, shiSanYaoMult: 8, enableQingYiSe: true, enableYiTiaoLong: true, enableShiSanYao: true, dealerFlow: 'next', enableKoupoint: true },
    players,
    game,
    logs: [],
    chat: [],
  };
  server.rooms.set('r1', room);
  for (const pl of players) { pl.roomId = 'r1'; }
  return room;
}

function makeGame(hand, melds, seat) {
  return {
    roundNo: 1,
    dealer: 0,
    stage: 'draw',
    turn: seat,
    drawnTile: hand[hand.length - 1],
    hands: [[], [], [], []],
    melds: [[], [], [], []],
    discards: [[], [], [], []],
    tingSeats: [],
    kouTiles: [null, null, null, null],
    kouPoints: [1, 1, 1, 1],
    gangLogs: [],
    winners: null,
    wall: [],
    wallPos: 0,
    lastDiscard: null,
    lastAction: null,
  };
}

const scenarios = [
  {
    name: '碰w5后摸牌(残留1张w5)，听口含t6(6点)',
    hand: ['w5', 'w6', 'w7', 'w8', 'w9', 'w9', 't1', 't2', 't3', 't7', 't8'],
    melds: [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }],
  },
  {
    name: '碰w5后摸牌，手牌2面子+1将+1刻',
    hand: ['w1', 'w2', 'w3', 'w6', 'w6', 'w6', 't2', 't3', 't4', 't5', 't5'],
    melds: [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }],
  },
  {
    name: '碰w5后摸牌，杠面子(gang)',
    hand: ['w1', 'w2', 'w3', 'w6', 'w6', 'w6', 't2', 't3', 't4', 't5', 't5'],
    melds: [{ type: 'gang', tile: 'w5', tiles: ['w5', 'w5', 'w5', 'w5'] }],
  },
];

for (const sc of scenarios) {
  const server = new GameServer();
  const players = [0, 1, 2, 3].map((s) => makePlayer(server, 'P' + s, s));
  const seat = 0;
  const g = makeGame(sc.hand, sc.melds, seat);
  g.hands[seat] = sc.hand.slice();
  g.melds[seat] = sc.melds.slice();
  const room = makeRoom(server, players, g);
  const p = players[seat];

  // 1) 前端提示层面：canDeclareTing136(hand) 无 melds
  const cdNoMelds = rules.canDeclareTing136(sc.hand);
  // 2) 逐张扣牌调 _ting，收集错误
  const errors = [];
  const successes = [];
  for (const t of [...new Set(sc.hand)]) {
    const g2 = makeGame(sc.hand, sc.melds, seat);
    g2.hands[seat] = sc.hand.slice();
    g2.melds[seat] = sc.melds.slice();
    server.rooms.get('r1').game = g2;
    const before = g2.hands[seat].length;
    try { server._ting(p, { tile: t }); } catch (e) { errors.push(t + '→异常:' + (e.stack || e.message).split('\n').slice(0, 3).join('|')); continue; }
    const after = server.rooms.get('r1').game.hands[seat].length;
    if (after === before) {
      // 被拒绝：从 room.logs 或返回不可见，直接判定为拒绝
      errors.push(t + '→拒绝');
    } else {
      successes.push(t);
    }
  }
  // 3) 带 melds 参考：canDeclareTing136WithMelds
  function isTingWithMelds(hand, melds) {
    // 简化：复用现有 checkHu 的等价性验证已做；这里仅展示 canDeclareTing136 等价性已由随机测试确认
    return rules.canDeclareTing136(hand);
  }
  console.log(`场景: ${sc.name}`);
  console.log(`  手牌: ${sc.hand.join(',')}`);
  console.log(`  melds: ${JSON.stringify(sc.melds)}`);
  console.log(`  canDeclareTing136(无melds): ${cdNoMelds}`);
  console.log(`  逐张扣牌报听结果: ${successes.length ? '成功[' + successes.join(',') + ']' : '全部拒绝'} ${errors.join(' ')}`);
  console.log('---');
}
