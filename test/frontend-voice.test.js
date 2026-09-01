'use strict';

// ============ 运城扣点点麻将：前端语音播报 jsdom 单测 ============
// 1) 大厅声音选择：默认男声 / 选择保存 localStorage / 读取已保存声音
// 2) 播报触发：出牌报牌名、碰/杠/暗杠/补杠/吃/胡（点炮/自摸/抢杠）报动作词
// 3) 节流与降级：同事件 500ms 内不重复、页面不可见静默跳过、语音不可用静默降级
// 4) 男女声匹配：切换声音后立即生效（选择对应 voice）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function createEnv(opts = {}) {
  const { withSpeech = true, storedVoice = null } = opts;
  const dom = new JSDOM(html, {
    url: 'http://localhost:3100/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  if (storedVoice) window.localStorage.setItem('kd.voice', storedVoice);

  const spoken = [];
  const utterances = [];
  window.__lastWs = null;

  if (withSpeech) {
    // 模拟浏览器中文语音：Huihui（女）/ YunJian（男），无匹配时回退首个 zh-CN
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; this.lang = ''; this.voice = null; }
    };
    window.speechSynthesis = {
      getVoices() {
        return [
          { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
          { name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN' },
          { name: 'Microsoft YunJian - Chinese (Simplified, PRC)', lang: 'zh-CN' },
        ];
      },
      speak(u) { utterances.push(u); spoken.push(u.text); },
      cancel() {},
      addEventListener() {},
      removeEventListener() {},
    };
  }

  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; window.__lastWs = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };

  window.eval(appJs);

  return { dom, window, document, spoken, utterances, get ws() { return window.__lastWs; } };
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

function makePlayers(discardsMap = {}, meldsMap = {}) {
  return [0, 1, 2, 3].map((seat) => ({
    seat,
    name: 'P' + seat,
    hand: [],
    discards: discardsMap[seat] || [],
    melds: meldsMap[seat] || [],
    score: 0,
    roundScore: 0,
    connected: true,
    isAI: false,
    isDealer: false,
    ting: false,
    hosted: false,
  }));
}

function enterRoom(env, overrides = {}) {
  broadcast(env, roomStateMsg(overrides));
}

// ---------- 声音选择 ----------
test('语音选择：默认男声，选择女声后保存到 localStorage 并立即生效', () => {
  const env = createEnv();
  const male = env.document.querySelector('#seg-voice .seg-item[data-value="male"]');
  const female = env.document.querySelector('#seg-voice .seg-item[data-value="female"]');
  assert.ok(male, '存在男声选项');
  assert.ok(female, '存在女声选项');
  assert.ok(male.classList.contains('active'), '默认男声高亮');

  female.click();
  assert.ok(female.classList.contains('active'), '点击后女声高亮');
  assert.ok(!male.classList.contains('active'), '点击后男声取消高亮');
  assert.equal(env.window.localStorage.getItem('kd.voice'), 'female', '选择写入 localStorage');

  // 女声立即生效：进入牌局后播报使用女声 voice
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  assert.equal(env.spoken[0], '五万');
  assert.equal(env.utterances[0].voice.name, 'Microsoft Huihui - Chinese (Simplified, PRC)', '女声匹配 Huihui');
});

test('语音选择：读取已保存的 localStorage 声音（女声）', () => {
  const env = createEnv({ storedVoice: 'female' });
  const male = env.document.querySelector('#seg-voice .seg-item[data-value="male"]');
  const female = env.document.querySelector('#seg-voice .seg-item[data-value="female"]');
  assert.ok(female.classList.contains('active'), '已保存女声时女声高亮');
  assert.ok(!male.classList.contains('active'), '男声不高亮');
});

test('语音选择：默认男声播报使用男声 voice', () => {
  const env = createEnv();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  broadcast(env, gameStateMsg(makePlayers({ 2: ['z'] })));
  assert.equal(env.spoken[0], '红中');
  assert.equal(env.utterances[0].voice.name, 'Microsoft YunJian - Chinese (Simplified, PRC)', '男声匹配 YunJian');
});

// ---------- 播报触发 ----------
test('播报：出牌报牌名（数字牌与字牌），首次广播只建基线不播报历史', () => {
  const env = createEnv();
  enterRoom(env);
  // 首帧含已出过的牌：只建基线，不播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w3', 'b7'] })));
  assert.equal(env.spoken.length, 0, '首帧不播报历史出牌');
  // 后续新增出牌才播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w3', 'b7', 'e'] })));
  assert.deepEqual(env.spoken, ['东风']);
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w3', 'b7', 'e', 'w5'] })));
  assert.deepEqual(env.spoken, ['东风', '五万']);
});

test('播报：碰/杠/暗杠/补杠/吃报动作词，胡按类型报词', () => {
  const env = createEnv();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  // 碰
  broadcast(env, gameStateMsg(makePlayers({}, { 2: [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }] })));
  assert.deepEqual(env.spoken, ['碰']);
  // 明杠（新增）
  broadcast(env, gameStateMsg(makePlayers({}, { 2: [
    { type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] },
    { type: 'gang', tile: 't2', tiles: ['t2', 't2', 't2', 't2'] },
  ] })));
  assert.deepEqual(env.spoken, ['碰', '杠']);
  // 暗杠（新增）
  broadcast(env, gameStateMsg(makePlayers({}, { 2: [
    { type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] },
    { type: 'gang', tile: 't2', tiles: ['t2', 't2', 't2', 't2'] },
    { type: 'angang', tile: 'z', tiles: ['z', 'z', 'z', 'z'] },
  ] })));
  assert.deepEqual(env.spoken, ['碰', '杠', '暗杠']);
  // 补杠（明面由 peng 转 bugang）
  broadcast(env, gameStateMsg(makePlayers({}, { 2: [
    { type: 'bugang', tile: 'w5', tiles: ['w5', 'w5', 'w5', 'w5'] },
    { type: 'gang', tile: 't2', tiles: ['t2', 't2', 't2', 't2'] },
    { type: 'angang', tile: 'z', tiles: ['z', 'z', 'z', 'z'] },
  ] })));
  assert.deepEqual(env.spoken, ['碰', '杠', '暗杠', '补杠']);
  // 吃（如有）
  broadcast(env, gameStateMsg(makePlayers({}, { 2: [
    { type: 'bugang', tile: 'w5', tiles: ['w5', 'w5', 'w5', 'w5'] },
    { type: 'gang', tile: 't2', tiles: ['t2', 't2', 't2', 't2'] },
    { type: 'angang', tile: 'z', tiles: ['z', 'z', 'z', 'z'] },
    { type: 'chi', tile: 'w4', tiles: ['w3', 'w4', 'w5'] },
  ] })));
  assert.deepEqual(env.spoken, ['碰', '杠', '暗杠', '补杠', '吃']);
});

test('播报：胡按类型报词（点炮/自摸/抢杠）', () => {
  const env = createEnv();
  enterRoom(env);
  const players = makePlayers();
  broadcast(env, gameStateMsg(players)); // 基线
  broadcast(env, gameStateMsg(players, { winners: { type: 'hu', winType: 'dianpao', winnerSeat: 1, tile: 'w5' } }));
  assert.deepEqual(env.spoken, ['胡了']);
});

test('播报：自摸与抢杠胡', () => {
  const env = createEnv();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  broadcast(env, gameStateMsg(makePlayers(), { winners: { type: 'hu', winType: 'zimo', winnerSeat: 0, tile: 'w8' } }));
  assert.deepEqual(env.spoken, ['自摸']);

  const env2 = createEnv();
  enterRoom(env2);
  broadcast(env2, gameStateMsg(makePlayers()));
  broadcast(env2, gameStateMsg(makePlayers(), { winners: { type: 'hu', winType: 'qianggang', winnerSeat: 3, tile: 'f' } }));
  assert.deepEqual(env2.spoken, ['抢杠胡']);
});

// ---------- 节流与降级 ----------
test('节流：同一事件重复广播 500ms 内不重复播报，不同出牌正常播报', () => {
  const env = createEnv();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  // 第一次出牌播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  assert.deepEqual(env.spoken, ['五万']);
  // 同一事件重复广播（冗余 game_state）：不再播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  assert.deepEqual(env.spoken, ['五万'], '重复广播不重复播报');
  // 同座连续新出牌：不同事件正常播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5', 'b2'] })));
  assert.deepEqual(env.spoken, ['五万', '二筒']);
  // 同座重复出同牌（新的一圈又打同一张）：同事件 500ms 内不重复
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5', 'b2', 'w5'] })));
  assert.deepEqual(env.spoken, ['五万', '二筒'], '500ms 内同牌不重复播报');
});

test('降级：页面不可见时静默跳过播报', () => {
  const env = createEnv();
  Object.defineProperty(env.document, 'hidden', { value: true, configurable: true });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  assert.equal(env.spoken.length, 0, '不可见时不播报');
});

test('降级：无 speechSynthesis 支持时静默跳过，不抛错不阻塞', () => {
  const env = createEnv({ withSpeech: false });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  assert.doesNotThrow(() => {
    broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  });
  assert.equal(env.spoken.length, 0, '不支持时无播报');
});
