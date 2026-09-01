'use strict';

// ============ 运城扣点点麻将：后端 TTS 预合成桥接（tts-bridge）单测 ============
// 1) PRESET_TEXTS 覆盖 34 种牌名 + 8 个动作词
// 2) getAudioUrl：首次合成写文件并返回同源 URL / 二次命中缓存不重复合成（内存 + 文件）
// 3) getAudioUrl：voice 非法抛错 / 首次合成失败抛错
// 4) warmup：并发限流且失败静默，已存在跳过不重复合成
// 全部通过注入 mock 合成客户端，不发起真实网络请求

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTtsBridge, PRESET_TEXTS } = require('../src/tts-bridge');

function tempPublicDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tts-bridge-test-'));
}

function hashOf(text, voice) {
  return crypto.createHash('md5').update(text + '|' + voice).digest('hex');
}

test('PRESET_TEXTS：覆盖 34 种牌名与动作词', () => {
  assert.equal(PRESET_TEXTS.length, 34 + 9, '34 牌名 + 9 动作词');
  for (const w of ['一万', '九万', '一条', '九条', '一筒', '九筒', '东风', '南风', '西风', '北风', '红中', '发财', '白板']) {
    assert.ok(PRESET_TEXTS.includes(w), '包含牌名 ' + w);
  }
  for (const a of ['碰', '杠', '暗杠', '补杠', '吃', '自摸', '抢杠胡', '胡了', '报听']) {
    assert.ok(PRESET_TEXTS.includes(a), '包含动作词 ' + a);
  }
});

test('getAudioUrl：首次合成写文件并返回同源 URL', async () => {
  const dir = tempPublicDir();
  const calls = [];
  const bridge = createTtsBridge({
    publicDir: dir,
    synthesize: async (text, voice) => { calls.push({ text, voice }); return Buffer.from('MP3DATA-' + text); },
  });
  const url = await bridge.getAudioUrl('五万', 'male');
  const hash = hashOf('五万', 'male');
  assert.equal(url, '/tts/male/' + hash + '.mp3', 'URL 形如 /tts/<voice>/<hash>.mp3');
  assert.ok(fs.existsSync(path.join(dir, 'tts', 'male', hash + '.mp3')), '音频文件已落盘');
  assert.deepEqual(calls, [{ text: '五万', voice: 'male' }], '仅合成一次');
});

test('getAudioUrl：二次命中缓存不重复合成（内存 + 文件）', async () => {
  const dir = tempPublicDir();
  const calls = [];
  const bridge = createTtsBridge({
    publicDir: dir,
    synthesize: async (text, voice) => { calls.push({ text, voice }); return Buffer.from('MP3'); },
  });
  await bridge.getAudioUrl('五万', 'male');
  await bridge.getAudioUrl('五万', 'male');
  assert.equal(calls.length, 1, '同实例内存缓存命中，不重复合成');
  // 新实例：文件缓存命中，不重复合成
  const bridge2 = createTtsBridge({
    publicDir: dir,
    synthesize: async () => { calls.push({}); return Buffer.from('MP3'); },
  });
  await bridge2.getAudioUrl('五万', 'male');
  assert.equal(calls.length, 1, '文件缓存命中，不重复合成');
});

test('getAudioUrl：voice 非法抛错', async () => {
  const bridge = createTtsBridge({ publicDir: tempPublicDir() });
  await assert.rejects(() => bridge.getAudioUrl('五万', 'robot'), /invalid voice/);
  await assert.rejects(() => bridge.getAudioUrl('五万', ''), /invalid voice/);
});

test('getAudioUrl：首次合成失败抛错', async () => {
  const bridge = createTtsBridge({
    publicDir: tempPublicDir(),
    synthesize: async () => { throw new Error('boom'); },
  });
  await assert.rejects(() => bridge.getAudioUrl('五万', 'male'), /boom/);
});

test('warmup：并发限流且失败静默，已存在跳过', async () => {
  const dir = tempPublicDir();
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  const bridge = createTtsBridge({
    publicDir: dir,
    synthesize: async (text, voice) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      calls.push({ text, voice });
      return Buffer.from('MP3');
    },
  });
  await bridge.warmup({ concurrency: 3 });
  assert.equal(calls.length, PRESET_TEXTS.length * 2, '预热全部条目（男声+女声）');
  assert.ok(maxInflight <= 3, '并发不超过 3，实际 ' + maxInflight);
  // 再次预热：全部命中文件缓存，不重复合成
  calls.length = 0;
  await bridge.warmup({ concurrency: 3 });
  assert.equal(calls.length, 0, '已存在跳过不重复合成');
});

test('warmup：单个失败静默不中断', async () => {
  const dir = tempPublicDir();
  let n = 0;
  const bridge = createTtsBridge({
    publicDir: dir,
    synthesize: async (text, voice) => {
      n++;
      if (n === 1) throw new Error('first fail');
      return Buffer.from('MP3');
    },
  });
  await bridge.warmup({ concurrency: 1 });
  assert.equal(n, PRESET_TEXTS.length * 2, '首条失败后其余条目继续合成');
});
