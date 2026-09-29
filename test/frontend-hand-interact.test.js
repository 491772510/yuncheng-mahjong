'use strict';

// ============ 运城扣点点麻将：前端手牌选中交互 jsdom 单测 ============
// 1) 默认模式（单击直接出牌开关关闭）：点击手牌=选中（.selected），弃牌区同种牌弱高亮（.weak-highlight），
//    再次点击同一张=出牌，点击其他张=切换选中
// 2) 设置开关「单击直接出牌」：勾选后点击直接出牌、不显示选中态、保存 localStorage、进入大厅时恢复
// 3) 边界：报听选牌阶段不受影响（点击=报听扣牌）、已报听玩家摸牌即打、turn 变化/不可出牌清除选中
// 4) 操作区提示文案随开关切换

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function createEnv(opts = {}) {
  const { storedTapToDiscard = null } = opts;
  const dom = new JSDOM(html, {
    url: 'http://localhost:3100/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  if (storedTapToDiscard) window.localStorage.setItem('kd.tapToDiscard', storedTapToDiscard);

  // 语音降级链路在 jsdom 中静默，避免播报干扰手牌断言
  window.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.lang = ''; this.voice = null; }
  };
  window.speechSynthesis = {
    getVoices() { return [{ name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' }]; },
    speak() {}, cancel() {}, addEventListener() {}, removeEventListener() {},
  };
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  window.Audio = class { constructor(src) { this.src = src; } play() { return Promise.resolve(); } };
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; window.__lastWs = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };

  window.eval(appJs);

  return { dom, window, document, get ws() { return window.__lastWs; } };
}

function broadcast(env, msg) {
  env.ws.onmessage({ data: JSON.stringify(msg) });
}

function roomStateMsg(overrides = {}) {
  return {
    type: 'room_state',
    room: Object.assign({
      id: 1234,
      state: 'playing',
      roundNo: 1,
      players: [0, 1, 2, 3].map((seat) => ({ seat, name: 'P' + seat, score: 0, roundScore: 0, connected: true })),
      settings: { totalRounds: 4, aiFill: false, dealerFlow: 'next' },
      logs: [],
    }, overrides),
  };
}

function gameStateMsg(players, overrides = {}) {
  return {
    type: 'game_state',
    game: Object.assign({
      stage: 'playing',
      roundNo: 1,
      yourSeat: 0,
      turn: 1,
      wallCount: 60,
      kouPoints: {},
      players,
    }, overrides),
  };
}

function makePlayers(discardsMap = {}, meldsMap = {}, aiSeats = []) {
  return [0, 1, 2, 3].map((seat) => ({
    seat,
    name: 'P' + seat,
    hand: [],
    discards: discardsMap[seat] || [],
    melds: meldsMap[seat] || [],
    score: 0,
    roundScore: 0,
    connected: true,
    isAI: aiSeats.includes(seat),
    isDealer: false,
    ting: false,
    hosted: false,
  }));
}

// 进入对局并置于本家摸牌出牌阶段（isDrawTurn=true、prompt.type='draw'）
function setupDrawTurn(env, opts = {}) {
  const { hand = ['w1', 'w2', 'w3'], turn = 0, meTing = false, tingHints = null, promptOverrides = {} } = opts;
  broadcast(env, roomStateMsg());
  const players = makePlayers({ 1: ['t1', 'w1'] }, {}, [1, 2, 3]);
  players[0].hand = hand;
  players[0].ting = meTing;
  const gameOverrides = { yourSeat: 0, turn, isDrawTurn: true };
  if (tingHints) gameOverrides.tingHints = tingHints;
  broadcast(env, gameStateMsg(players, gameOverrides));
  broadcast(env, {
    type: 'action_prompt',
    prompt: Object.assign({ type: 'draw', canHu: false, actions: ['pass'], canDeclareTing: false }, promptOverrides),
  });
}

function handTiles(env) {
  return Array.from(env.document.querySelectorAll('#table-wrap .hand-tiles .tile.discardable'));
}
function clickHandTile(env, idx) {
  handTiles(env)[idx].click();
}
function selectedTiles(env) {
  return Array.from(env.document.querySelectorAll('#table-wrap .hand-tiles .tile.selected'));
}
function weakHighlighted(env) {
  return Array.from(env.document.querySelectorAll('#table-wrap .discard-area .tile.weak-highlight'));
}
function lastSent(env) {
  const sent = env.ws.sent;
  return sent[sent.length - 1];
}
function tapSwitch(env) {
  return env.document.querySelector('#opt-tap-discard');
}

// ---------- 功能1：默认选中交互 ----------
test('默认模式：点击手牌选中并弱高亮弃牌区同牌，再次点击同一张出牌', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });

  // 首次点击 = 选中，不出牌
  clickHandTile(env, 0);
  assert.equal(selectedTiles(env).length, 1);
  assert.equal(selectedTiles(env)[0].dataset.tile, 'w1');
  assert.equal(env.ws.sent.some((m) => m.type === 'play_tile'), false);

  // 弃牌区同种 w1 弱高亮（P1 已打出 w1），其他牌不高亮
  const weak = weakHighlighted(env);
  assert.equal(weak.length, 1);
  assert.equal(weak[0].dataset.tile, 'w1');
  assert.ok(weak[0].closest('.discard-area'));

  // 再次点击同一张 = 出牌，清除选中与弱高亮
  clickHandTile(env, 0);
  assert.deepEqual(lastSent(env), { type: 'play_tile', tile: 'w1' });
  assert.equal(selectedTiles(env).length, 0);
  assert.equal(weakHighlighted(env).length, 0);
});

test('默认模式：选中状态下点击其他手牌切换选中（旧牌取消、新牌选中）', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });

  clickHandTile(env, 0);
  assert.equal(selectedTiles(env)[0].dataset.tile, 'w1');

  clickHandTile(env, 2);
  assert.equal(env.ws.sent.some((m) => m.type === 'play_tile'), false);
  const sel = selectedTiles(env);
  assert.equal(sel.length, 1);
  assert.equal(sel[0].dataset.tile, 'w3');
  assert.equal(sel[0].dataset.idx, '2');

  // 切换后弱高亮跟随新选中牌：w3 场上无人打出，无高亮
  assert.equal(weakHighlighted(env).length, 0);
});

test('默认模式：操作区提示文案为「点击手牌选中，再次点击出牌」', () => {
  const env = createEnv();
  setupDrawTurn(env);
  assert.equal(env.document.querySelector('#action-bar .countdown').textContent, '点击手牌选中，再次点击出牌');
});

// ---------- 功能2：单击直接出牌开关 ----------
test('开关开启：单击手牌直接出牌、不显示选中态、保存 localStorage', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });

  tapSwitch(env).click();
  assert.equal(env.window.localStorage.getItem('kd.tapToDiscard'), '1');
  assert.equal(env.document.querySelector('#action-bar .countdown').textContent, '点击手牌出牌');

  clickHandTile(env, 0);
  assert.deepEqual(lastSent(env), { type: 'play_tile', tile: 'w1' });
  assert.equal(selectedTiles(env).length, 0);
  assert.equal(weakHighlighted(env).length, 0);
});

test('开关关闭时再次勾选生效、取消勾选回退选中交互并保存', () => {
  const env = createEnv({ storedTapToDiscard: '1' });
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });
  assert.equal(tapSwitch(env).checked, true);

  // 取消勾选 = 回到默认选中交互
  tapSwitch(env).click();
  assert.equal(env.window.localStorage.getItem('kd.tapToDiscard'), '0');
  clickHandTile(env, 0);
  assert.equal(selectedTiles(env).length, 1);
  assert.equal(env.ws.sent.some((m) => m.type === 'play_tile'), false);
});

test('localStorage 预存开启值时进入大厅自动勾选开关', () => {
  const env = createEnv({ storedTapToDiscard: '1' });
  assert.equal(tapSwitch(env).checked, true);
});

// ---------- 边界：报听 / 已报听 / 轮次变化 ----------
test('报听选牌阶段：点击手牌=报听扣牌，不受选中交互与开关影响', () => {
  const env = createEnv();
  // 服务端下发听口提示：w1/w2/w3 均可报听
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'], tingHints: { w1: 2, w2: 1, w3: 3 }, promptOverrides: { canDeclareTing: true } });
  tapSwitch(env).click(); // 开关开启也不影响报听

  // 进入报听选牌阶段（点击「报听」按钮）
  env.document.querySelector('#action-bar .act-ting').click();
  assert.ok(env.document.querySelector('#table-wrap .hand-tiles').classList.contains('ting-pick'));

  clickHandTile(env, 0);
  assert.deepEqual(lastSent(env), { type: 'ting', tile: 'w1' });
  assert.equal(selectedTiles(env).length, 0);
  assert.equal(weakHighlighted(env).length, 0);
});

test('已报听玩家摸牌即打：点击直接出牌，不进入选中交互', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'], meTing: true });

  clickHandTile(env, 0);
  assert.deepEqual(lastSent(env), { type: 'play_tile', tile: 'w1' });
  assert.equal(selectedTiles(env).length, 0);
});

test('轮次变化时清除选中态，避免残留', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });
  clickHandTile(env, 0);
  assert.equal(selectedTiles(env).length, 1);

  // 广播 turn 变化（轮到别人），重绘后不再有 .selected
  const players = makePlayers({ 1: ['t1', 'w1'] }, {}, [1, 2, 3]);
  players[0].hand = ['w1', 'w2', 'w3'];
  broadcast(env, gameStateMsg(players, { yourSeat: 0, turn: 1 }));
  assert.equal(selectedTiles(env).length, 0);
  assert.equal(weakHighlighted(env).length, 0);
});

test('本局结束（winners 出现）时清除选中态', () => {
  const env = createEnv();
  setupDrawTurn(env, { hand: ['w1', 'w2', 'w3'] });
  clickHandTile(env, 0);
  assert.equal(selectedTiles(env).length, 1);

  const players = makePlayers({ 1: ['t1', 'w1'] }, {}, [1, 2, 3]);
  players[0].hand = ['w1', 'w2', 'w3'];
  broadcast(env, gameStateMsg(players, { yourSeat: 0, turn: 0, winners: [0] }));
  assert.equal(selectedTiles(env).length, 0);
});
