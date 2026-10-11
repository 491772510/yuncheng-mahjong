'use strict';

// ============ 贴金首金强制亮金规则：AI 自动对局卡死回归测试 ============
// 背景：「首金未亮时只能亮金」这类「禁止动作」改动最容易让 AI/托管因无合法动作而
// 反复重试直至 'AI stuck'，或整局永久卡死。本测试用 mock timers 同步推进多局全 AI
// 对局，断言每局都能走到胡牌收尾、零 AI stuck。
//
// 加速原理：AI 行动由 _scheduleAutoAct 的 setTimeout(80ms) 异步调度，这里用
// node:test 的 mock.timers 把定时器变同步，循环 tick 即可在毫秒级跑完整局。

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');
const { makeWs, send, seededRng } = require('../lib/testutils');

// 每局推进上限：正常对局数十步即可胡牌；超过即视为卡死，直接失败
const MAX_STEPS = 500;

/** 用固定 seed 跑一局全 AI 对局，同步推进到胡牌或卡死，返回统计 */
function runAutoRound(seed) {
  const srv = new GameServer({ gameLog: false, rng: seededRng(seed) });
  const wss = [0, 1, 2, 3].map(() => makeWs());
  wss.forEach((ws, i) => {
    srv.handleConnection(ws);
    send(ws, { type: 'join_lobby', name: 'P' + i });
  });
  send(wss[0], { type: 'create_room', settings: { variant: 'tiejin', aiFill: false, totalRounds: 4 } });
  const room = [...srv.rooms.values()][0];
  for (let i = 1; i < 4; i++) send(wss[i], { type: 'join_room', roomId: room.id });
  send(wss[0], { type: 'start_game' });

  const g = room.game;
  for (let s = 0; s < 4; s++) if (room.players[s]) room.players[s].isAI = true;

  // 捕获 AI stuck 误报
  let stuck = 0;
  const origErr = console.error;
  console.error = (...a) => { if (a.join(' ').includes('AI stuck')) stuck++; else origErr(...a); };

  let steps = 0;
  try {
    while (room.state === 'playing' && !g.winners && steps < MAX_STEPS) {
      steps++;
      const cur = g.turn;
      srv._scheduleAutoAct(room, cur);
      mock.timers.tick(100); // 触发 80ms 的 auto timer（含可能的响应 timer）
    }
  } finally {
    console.error = origErr;
    srv.stop();
  }

  return { steps, verdict: g.winners ? 'HU' : 'STALL', stuck };
}

test('贴金全 AI 自动对局：多局均胡牌收尾、零 AI stuck（首金强制亮金不卡死）', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    for (let seed = 1; seed <= 6; seed++) {
      const r = runAutoRound(seed);
      assert.equal(r.stuck, 0, `seed=${seed} 不应出现 AI stuck（实际 ${r.stuck} 次）`);
      assert.equal(r.verdict, 'HU', `seed=${seed} 应在 ${MAX_STEPS} 步内胡牌收尾（实际 ${r.steps} 步 ${r.verdict}）`);
    }
  } finally {
    mock.timers.reset();
  }
});
