'use strict';

/**
 * 运城扣点点麻将 Web 应用 —— 服务端入口
 * - HTTP 静态服务（public 目录）
 * - WebSocket 实时通信（ws 模块）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const { WebSocketServer } = require('ws');
const { GameServer } = require('./src/game');
const { createTtsBridge } = require('./src/tts-bridge');

const PORT = Number(process.env.PORT || 3100);
const PORT_HTTPS = Number(process.env.PORT_HTTPS || 3443);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERTS_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERTS_DIR, 'server.crt');
const KEY_FILE = path.join(CERTS_DIR, 'server.key');

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

// 静态文件 + TTS 路由共用请求处理器（HTTP/HTTPS 双协议复用同一套逻辑）
function requestHandler(req, res) {
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
}

// 生成/复用自签证书（持久化到 certs/，已存在则复用）
async function ensureSelfSignedCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return {
      cert: fs.readFileSync(CERT_FILE),
      key: fs.readFileSync(KEY_FILE),
    };
  }
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }],
  });
  fs.writeFileSync(CERT_FILE, pems.cert);
  fs.writeFileSync(KEY_FILE, pems.private);
  return { cert: pems.cert, key: pems.private };
}

// 获取本机局域网 IPv4 地址（用于提示 https://<IP>:PORT 访问）
function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

const game = new GameServer();

function attachWs(server) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    game.handleConnection(ws);
  });
  return wss;
}

const server = http.createServer(requestHandler);
attachWs(server);

server.listen(PORT, () => {
  console.log(`[server] 运城扣点点麻将服务已启动: http://localhost:${PORT}`);
  // 启动后后台预合成常用播报（不阻塞 listen）
  ttsBridge.warmup({ concurrency: 3 })
    .then((r) => console.log(`[server] TTS 预热完成: ${r.total} 条已检查`))
    .catch(() => { /* 预热失败静默 */ });
});

// HTTPS 服务（自签证书，供手机浏览器麦克风权限使用）
(async () => {
  try {
    const creds = await ensureSelfSignedCert();
    const httpsServer = https.createServer(creds, requestHandler);
    attachWs(httpsServer);
    httpsServer.listen(PORT_HTTPS, () => {
      console.log(`[server] HTTPS 服务已启动: https://localhost:${PORT_HTTPS}`);
      console.log(`[server] 语音对讲请访问 https://${localIPv4()}:${PORT_HTTPS}`);
    });
  } catch (e) {
    console.error('[server] HTTPS 启动失败（语音对讲不可用）:', e);
  }
})();
