'use strict';

/**
 * 运城扣点点麻将 Web 应用 —— 服务端入口
 * - HTTP 静态服务（public 目录）
 * - WebSocket 实时通信（ws 模块）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { GameServer } = require('./src/game');
const { createTtsBridge } = require('./src/tts-bridge');

const PORT = Number(process.env.PORT || 3100);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

// 后端 TTS 预合成桥接：独立 TTS 服务合成 -> 落盘 public/tts -> 同源 URL 供前端播放
const ttsBridge = createTtsBridge();

const server = http.createServer((req, res) => {
  try {
    // 静态服务前的 TTS 路由（预合成缓存，消除前端实时合成延迟）
    if (req.url && req.url.startsWith('/api/tts/')) {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/api/tts/audio' && req.method === 'GET') {
        const text = (u.searchParams.get('text') || '').trim();
        const voice = (u.searchParams.get('voice') || '').trim();
        if (!text || (voice !== 'male' && voice !== 'female')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text and voice(male|female) are required' }));
          return;
        }
        ttsBridge.getAudioUrl(text, voice)
          .then((url) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ url }));
          })
          .catch(() => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'tts synthesize failed' }));
          });
        return;
      }
      if (u.pathname === '/api/tts/warmup' && req.method === 'GET') {
        // 后台触发预热，不阻塞响应
        ttsBridge.warmup({ concurrency: 3 }).catch(() => { /* 预热失败静默，不影响主流程 */ });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ started: true }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // 防路径穿越
    const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Server Error');
  }
});

const game = new GameServer();

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  game.handleConnection(ws);
});

server.listen(PORT, () => {
  console.log(`[server] 运城扣点点麻将服务已启动: http://localhost:${PORT}`);
  // 启动后后台预合成常用播报（不阻塞 listen）
  ttsBridge.warmup({ concurrency: 3 })
    .then((r) => console.log(`[server] TTS 预热完成: ${r.total} 条已检查`))
    .catch(() => { /* 预热失败静默 */ });
});
