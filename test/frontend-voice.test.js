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

function enterRoom(env, overrides = {}) {
  broadcast(env, roomStateMsg(overrides));
}

// ---------- 声音选择 ----------
test('语音选择：默认无声，选择女声后保存到 localStorage 并立即生效', () => {
  const env = createEnv();
  const male = env.document.querySelector('#seg-voice .seg-item[data-value="male"]');
  const female = env.document.querySelector('#seg-voice .seg-item[data-value="female"]');
  const mute = env.document.querySelector('#seg-voice .seg-item[data-value="mute"]');
  assert.ok(male, '存在男声选项');
  assert.ok(female, '存在女声选项');
  assert.ok(mute.classList.contains('active'), '默认无声高亮');

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

test('语音选择：选择无声后保存到 localStorage，重新加载仍为无声', () => {
  const env = createEnv();
  const male = env.document.querySelector('#seg-voice .seg-item[data-value="male"]');
  const female = env.document.querySelector('#seg-voice .seg-item[data-value="female"]');
  const mute = env.document.querySelector('#seg-voice .seg-item[data-value="mute"]');
  assert.ok(mute, '存在无声选项');
  assert.ok(mute.classList.contains('active'), '默认仍为无声');

  mute.click();
  assert.ok(mute.classList.contains('active'), '点击后无声高亮');
  assert.ok(!male.classList.contains('active'), '男声取消高亮');
  assert.ok(!female.classList.contains('active'), '女声取消高亮');
  assert.equal(env.window.localStorage.getItem('kd.voice'), 'mute', '选择写入 localStorage');

  // 重新加载：无声仍高亮
  const env2 = createEnv({ storedVoice: 'mute' });
  const mute2 = env2.document.querySelector('#seg-voice .seg-item[data-value="mute"]');
  assert.ok(mute2.classList.contains('active'), '重新加载后无声高亮');
});

test('无声：选择无声后所有播报静默（出牌/胡均不触发）', () => {
  const env = createEnv();
  env.document.querySelector('#seg-voice .seg-item[data-value="mute"]').click();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5', 'z'] })));
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5', 'z', 'e'] }), { winners: { type: 'hu', winType: 'zimo', winnerSeat: 1, tile: 'w5' } }));
  assert.equal(env.spoken.length, 0, '无声模式下不播报任何动作');
});

test('无声：切回男声后播报立即恢复', () => {
  const env = createEnv();
  const mute = env.document.querySelector('#seg-voice .seg-item[data-value="mute"]');
  const male = env.document.querySelector('#seg-voice .seg-item[data-value="male"]');
  mute.click();
  male.click();
  assert.equal(env.window.localStorage.getItem('kd.voice'), 'male', '切回男声写入 localStorage');
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  broadcast(env, gameStateMsg(makePlayers({ 2: ['b6'] })));
  assert.deepEqual(env.spoken, ['六筒'], '切回后播报恢复');
});

// ---------- AI 动作静默 ----------
test('AI：AI 出牌不播报，真人出牌正常播报', () => {
  const env = createEnv({ storedVoice: 'male' });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  // AI（seat1）出牌：不播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] }, {}, [1])));
  assert.equal(env.spoken.length, 0, 'AI 出牌不播报');
  // 真人（seat2）出牌：正常播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'], 2: ['z'] }, {}, [1])));
  assert.deepEqual(env.spoken, ['红中'], '真人出牌正常播报');
  // 同帧 AI 再出牌 + 真人出牌：仅真人播报
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5', 'b9'], 2: ['z', 'e'] }, {}, [1])));
  assert.deepEqual(env.spoken, ['红中', '东风'], 'AI 再出牌仍不播报');
});

test('AI：AI 碰/杠不播报，真人碰正常播报', () => {
  const env = createEnv({ storedVoice: 'male' });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  // AI（seat1）碰：不播报
  broadcast(env, gameStateMsg(makePlayers({}, { 1: [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }] }, [1])));
  assert.equal(env.spoken.length, 0, 'AI 碰不播报');
  // 真人（seat2）碰：正常播报
  broadcast(env, gameStateMsg(makePlayers({}, {
    1: [{ type: 'peng', tile: 'w5', tiles: ['w5', 'w5', 'w5'] }],
    2: [{ type: 'gang', tile: 't2', tiles: ['t2', 't2', 't2', 't2'] }],
  }, [1])));
  assert.deepEqual(env.spoken, ['杠'], '真人杠正常播报，AI 明面不重复播报');
});

test('AI：AI 胡牌不播报，真人胡牌正常播报', () => {
  const env = createEnv({ storedVoice: 'male' });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  // AI（seat1）胡：不播报
  broadcast(env, gameStateMsg(makePlayers({}, {}, [1]), { winners: { type: 'hu', winType: 'zimo', winnerSeat: 1, tile: 'w5' } }));
  assert.equal(env.spoken.length, 0, 'AI 胡牌不播报');

  const env2 = createEnv({ storedVoice: 'male' });
  enterRoom(env2);
  broadcast(env2, gameStateMsg(makePlayers())); // 基线
  // 真人（seat2）胡：正常播报
  broadcast(env2, gameStateMsg(makePlayers({}, {}, [1]), { winners: { type: 'hu', winType: 'dianpao', winnerSeat: 2, tile: 'w5' } }));
  assert.deepEqual(env2.spoken, ['胡了'], '真人胡牌正常播报');
});

test('语音选择：默认无声不播报，切男声后播报使用男声 voice', () => {
  const env = createEnv();
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers())); // 基线
  broadcast(env, gameStateMsg(makePlayers({ 2: ['z'] })));
  assert.equal(env.spoken.length, 0, '默认无声不播报');
  env.document.querySelector('#seg-voice .seg-item[data-value="male"]').click();
  broadcast(env, gameStateMsg(makePlayers({ 2: ['z', 'w5'] })));
  assert.equal(env.spoken[0], '五万');
  assert.equal(env.utterances[0].voice.name, 'Microsoft YunJian - Chinese (Simplified, PRC)', '男声匹配 YunJian');
});

// ---------- 播报触发 ----------
test('播报：出牌报牌名（数字牌与字牌），首次广播只建基线不播报历史', () => {
  const env = createEnv({ storedVoice: 'male' });
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
  const env = createEnv({ storedVoice: 'male' });
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
  const env = createEnv({ storedVoice: 'male' });
  enterRoom(env);
  const players = makePlayers();
  broadcast(env, gameStateMsg(players)); // 基线
  broadcast(env, gameStateMsg(players, { winners: { type: 'hu', winType: 'dianpao', winnerSeat: 1, tile: 'w5' } }));
  assert.deepEqual(env.spoken, ['胡了']);
});

test('播报：自摸与抢杠胡', () => {
  const env = createEnv({ storedVoice: 'male' });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  broadcast(env, gameStateMsg(makePlayers(), { winners: { type: 'hu', winType: 'zimo', winnerSeat: 0, tile: 'w8' } }));
  assert.deepEqual(env.spoken, ['自摸']);

  const env2 = createEnv({ storedVoice: 'male' });
  enterRoom(env2);
  broadcast(env2, gameStateMsg(makePlayers()));
  broadcast(env2, gameStateMsg(makePlayers(), { winners: { type: 'hu', winType: 'qianggang', winnerSeat: 3, tile: 'f' } }));
  assert.deepEqual(env2.spoken, ['抢杠胡']);
});

// ---------- 节流与降级 ----------
test('节流：同一事件重复广播 500ms 内不重复播报，不同出牌正常播报', () => {
  const env = createEnv({ storedVoice: 'male' });
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
  const env = createEnv({ storedVoice: 'male' });
  Object.defineProperty(env.document, 'hidden', { value: true, configurable: true });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  assert.equal(env.spoken.length, 0, '不可见时不播报');
});

test('降级：无 speechSynthesis 支持时静默跳过，不抛错不阻塞', () => {
  const env = createEnv({ withSpeech: false, storedVoice: 'male' });
  enterRoom(env);
  broadcast(env, gameStateMsg(makePlayers()));
  assert.doesNotThrow(() => {
    broadcast(env, gameStateMsg(makePlayers({ 1: ['w5'] })));
  });
  assert.equal(env.spoken.length, 0, '不支持时无播报');
});
