'use strict';

/**
 * 运城扣点点麻将 —— 后端 TTS 预合成桥接模块
 *
 * 职责：把"前端每次实时请求独立 TTS 服务"改为"麻将 Node 服务端预合成 + 文件/内存缓存"，
 * 消除出牌播报时 edge-tts 在线合成的网络等待延迟。
 *
 * 工作方式：
 * - 通过 HTTP 调用独立 Python TTS 服务（默认 http://127.0.0.1:8000，环境变量 TTS_API_URL 可覆盖），
 *   POST /api/tts 传 { text, voice, dialect: true, engine: 'edge' }，响应含 audio_url 相对路径，
 *   再 GET 下载音频字节。
 * - 合成音频保存到 public/tts/<voice>/<hash>.mp3（hash = md5(text|voice)），内存 Map + 文件双重缓存；
 *   文件已存在直接返回同源 URL，不重复合成。
 * - getAudioUrl(text, voice)：返回同源 URL（形如 /tts/<voice>/<hash>.mp3），首次合成失败抛错。
 * - PRESET_TEXTS：常用播报文本（34 种牌名 + 动作词），与 public/app.js tileSpeech/checkSpeakEvents 一致。
 * - warmup({concurrency})：后台对 PRESET_TEXTS × [male, female] 预合成，已存在跳过，单条失败静默。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TTS_API_URL = 'http://127.0.0.1:8000';
const VALID_VOICES = ['male', 'female'];

// 常用播报文本：34 种牌名（万/条/筒各 1-9 + 东南西北中发白）+ 动作词，
// 与 public/app.js 的 tileSpeech()/checkSpeakEvents() 播报文本保持一致
const PRESET_TEXTS = [
  // 万 1-9
  '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
  // 条 1-9
  '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
  // 筒 1-9
  '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
  // 字牌
  '东风', '南风', '西风', '北风', '红中', '发财', '白板',
  // 动作词
  '碰', '杠', '暗杠', '补杠', '吃', '自摸', '抢杠胡', '胡了', '报听',
];

/**
 * 创建 TTS 桥接实例（工厂便于测试注入 mock 合成客户端）
 * @param {object} options
 * @param {string} [options.ttsApiUrl] 独立 TTS 服务地址，默认环境变量 TTS_API_URL 或 127.0.0.1:8000
 * @param {string} [options.publicDir] public 目录（默认项目 public），音频写入 <publicDir>/tts/<voice>/
 * @param {Function} [options.synthesize] 合成客户端 (text, voice) => Buffer，默认走真实 HTTP
 */
function createTtsBridge(options = {}) {
  const ttsApiUrl = String(options.ttsApiUrl || process.env.TTS_API_URL || DEFAULT_TTS_API_URL).replace(/\/+$/, '');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const ttsRoot = path.join(publicDir, 'tts');
  const synthesize = options.synthesize || defaultSynthesize;
  const cache = new Map(); // key: text|voice -> 同源 URL

  function assertVoice(voice) {
    if (!VALID_VOICES.includes(voice)) {
      const err = new Error('invalid voice: ' + voice);
      err.code = 'INVALID_VOICE';
      throw err;
    }
  }

  function hashKey(text, voice) {
    return crypto.createHash('md5').update(text + '|' + voice).digest('hex');
  }

  // 默认合成客户端：POST /api/tts 取 audio_url，再 GET 下载音频字节
  async function defaultSynthesize(text, voice) {
    const resp = await fetch(ttsApiUrl + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, dialect: true, engine: 'edge' }),
    });
    if (!resp.ok) throw new Error('TTS api http ' + resp.status);
    const data = await resp.json();
    if (!data || !data.audio_url) throw new Error('TTS api no audio_url');
    const audioResp = await fetch(ttsApiUrl + data.audio_url);
    if (!audioResp.ok) throw new Error('TTS download http ' + audioResp.status);
    return Buffer.from(await audioResp.arrayBuffer());
  }

  /**
   * 获取同源音频 URL；文件已存在/内存已缓存直接返回，否则合成并落盘
   * @returns {Promise<string>} 形如 /tts/<voice>/<hash>.mp3
   */
  async function getAudioUrl(text, voice) {
    if (!text) throw new Error('text required');
    assertVoice(voice);
    const key = text + '|' + voice;
    const cached = cache.get(key);
    if (cached) return cached;
    const hash = hashKey(text, voice);
    const url = '/tts/' + voice + '/' + hash + '.mp3';
    const filePath = path.join(ttsRoot, voice, hash + '.mp3');
    if (fs.existsSync(filePath)) {
      cache.set(key, url);
      return url;
    }
    const audio = await synthesize(text, voice);
    fs.mkdirSync(path.join(ttsRoot, voice), { recursive: true });
    fs.writeFileSync(filePath, audio);
    cache.set(key, url);
    return url;
  }

  /**
   * 后台预合成：PRESET_TEXTS × [male, female]，并发受限，已存在跳过，单条失败静默
   * @param {object} [opts] { concurrency = 3 }
   */
  async function warmup(opts = {}) {
    const concurrency = Math.max(1, opts.concurrency == null ? 3 : opts.concurrency);
    const queue = [];
    for (const text of PRESET_TEXTS) {
      for (const voice of VALID_VOICES) {
        queue.push({ text, voice });
      }
    }
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < queue.length) {
        const item = queue[idx++];
        try {
          const key = item.text + '|' + item.voice;
          if (cache.has(key)) continue;
          const hash = hashKey(item.text, item.voice);
          const filePath = path.join(ttsRoot, item.voice, hash + '.mp3');
          if (fs.existsSync(filePath)) {
            cache.set(key, '/tts/' + item.voice + '/' + hash + '.mp3');
            continue;
          }
          await getAudioUrl(item.text, item.voice);
        } catch (e) {
          // 单个失败静默，不中断整体预热
        }
      }
    });
    await Promise.all(workers);
    return { total: queue.length };
  }

  return { getAudioUrl, warmup, PRESET_TEXTS };
}

module.exports = { createTtsBridge, PRESET_TEXTS };
