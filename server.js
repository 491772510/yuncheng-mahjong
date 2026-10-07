'use strict';

/**
 * 运城麻将 Web 应用 —— 服务端入口
 * - HTTP 静态服务（public 目录）
 * - WebSocket 实时通信（ws 模块）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { GameServer } = require('./src/game');
const { createTtsBridge, PRESET_TEXTS } = require('./src/tts-bridge');

const PORT = Number(process.env.PORT || 3100);
const PORT_HTTPS = Number(process.env.PORT_HTTPS || 3443);
const WS_MAX_PAYLOAD = 16 * 1024; // WebSocket 单帧最大字节数（对齐 src/game.js MAX_RAW_MSG）
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

// 静态资源缓存策略：可带版本号的文本资源（html/css/js）短缓存，便于发布后快速刷新；
// 图片/字体/音频等不变资源长缓存，减少重复下载。
const CACHE_MAX_AGE = {
  '.html': 'no-cache',                      // 入口页始终校验，避免拿到旧壳
  '.css': 'public, max-age=300',            // 已用 ?v=N 打版本，5 分钟即可
  '.js': 'public, max-age=300',
  '.json': 'no-cache',
  '.png': 'public, max-age=86400',
  '.jpg': 'public, max-age=86400',
  '.jpeg': 'public, max-age=86400',
  '.gif': 'public, max-age=86400',
  '.svg': 'public, max-age=86400',
  '.ico': 'public, max-age=86400',
  '.woff': 'public, max-age=86400',
  '.woff2': 'public, max-age=86400',
  '.mp3': 'public, max-age=86400',
};

// 可 gzip 的文本类型（图片/音频/字体已高压缩或已压缩，再 gzip 无益且费 CPU）
const GZIPABLE = new Set(['.html', '.css', '.js', '.json', '.svg']);
const GZIP_MIN_BYTES = 1024; // 小于 1KB 的文本不值得压缩

// 后端 TTS 预合成桥接：独立 TTS 服务合成 -> 落盘 public/tts -> 同源 URL 供前端播放
const ttsBridge = createTtsBridge();

// TTS 预热幂等锁：/api/tts/warmup 无鉴权，一次预热 = 34 种文本 × 2 声线，反复触发会打爆下游合成服务。
// 进程内两道闸：① 预热进行中 → 直接返回 {started:false, running:true}；
// ② 预热结束后 WARMUP_COOLDOWN_MS 内 → 返回上次结果，不再触发合成。
// startWarmup 返回 Promise（本次真正启动）或 null（被闸拦下）。
const WARMUP_COOLDOWN_MS = 60 * 1000;
const warmupState = { running: false, lastFinishedAt: 0, lastResult: null };

function startWarmup() {
  if (warmupState.running) return null;
  if (warmupState.lastFinishedAt && Date.now() - warmupState.lastFinishedAt < WARMUP_COOLDOWN_MS) return null;
  warmupState.running = true;
  const done = ttsBridge.warmup({ concurrency: 3 });
  done
    .then((r) => { warmupState.lastResult = r || { total: 0 }; })
    .catch(() => { warmupState.lastResult = { total: 0 }; })
    .finally(() => {
      warmupState.running = false;
      warmupState.lastFinishedAt = Date.now();
    });
  return done;
}

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
        // 防滥用/防刷盘：仅接受预置白名单文本（34 种牌名 + 动作词）且长度受限，拒绝任意自定义文本
        if (text.length > 16 || !PRESET_TEXTS.includes(text)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text not allowed' }));
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
        const body = { started: false, running: false, cached: false, result: null };
        if (warmupState.running) {
          body.running = true; // 正在预热：不重复触发下游合成
        } else if (warmupState.lastFinishedAt && Date.now() - warmupState.lastFinishedAt < WARMUP_COOLDOWN_MS) {
          body.cached = true; // 冷却期内：直接复用上次结果
          body.result = warmupState.lastResult;
        } else {
          startWarmup();
          body.started = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // 防路径穿越：严格边界（等于根目录或以路径分隔符开头才放行）
    const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
    const ok = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
    if (!ok) {
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
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      headers['Cache-Control'] = CACHE_MAX_AGE[ext] || 'no-cache';

      // gzip：仅压缩可压缩的文本类型，且客户端声明支持、内容超过阈值
      const acceptEncoding = String(req.headers['accept-encoding'] || '');
      if (
        GZIPABLE.has(ext) &&
        data.length >= GZIP_MIN_BYTES &&
        /\bgzip\b/.test(acceptEncoding)
      ) {
        zlib.gzip(data, (zerr, zdata) => {
          if (zerr) {
            // 压缩失败兜底：原样返回
            res.writeHead(200, headers);
            res.end(data);
            return;
          }
          headers['Content-Encoding'] = 'gzip';
          headers['Vary'] = 'Accept-Encoding';
          res.writeHead(200, headers);
          res.end(zdata);
        });
        return;
      }
      res.writeHead(200, headers);
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

// 优雅退出：停掉全部心跳/房间/断线定时器并关闭监听，避免 Ctrl+C 后进程被悬挂定时器拖住
let httpsServerRef = null;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，正在退出...`);
  try { game.stop(); } catch (e) { /* 清理失败不阻塞退出 */ }
  for (const s of [server, httpsServerRef]) {
    if (!s) continue;
    try { s.close(); } catch (e) { /* 关闭失败忽略 */ }
  }
  // 兜底强制退出；game-logger 已注册 exit 钩子，会同步冲刷未落盘的对局日志
  setTimeout(() => process.exit(0), 300).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

function attachWs(server) {
  // 单帧上限：默认 100MiB 过大，收窄到 16KB（与 src/game.js MAX_RAW_MSG 一致，覆盖语音信令实际载荷）
  const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD });
  // 连接异常等错误：记录日志而非触发未捕获异常崩溃进程
  wss.on('error', (e) => console.error('[server] WebSocket 错误:', e.message));
  wss.on('connection', (ws, req) => {
    // 透传来源 IP 与 User-Agent，供 GameServer 做单 IP 并发上限（计数粒度 IP+UA，降低 NAT 误伤）
    const ip = (req && req.socket && req.socket.remoteAddress) || '';
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    game.handleConnection(ws, { ip, ua });
  });
  return wss;
}

const server = http.createServer(requestHandler);
attachWs(server);

// 端口占用（EADDRINUSE）等启动错误：给出友好提示并标记退出码，避免进程直接崩溃
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[server] ❌ 端口 ${PORT} 已被占用，无法启动 HTTP 服务。`);
    console.error(`[server]    请关闭占用该端口的进程，或改用其他端口：`);
    console.error(`[server]    PORT=3101 npm start`);
    console.error('');
  } else {
    console.error('[server] HTTP 服务启动失败:', e.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`[server] 运城麻将服务已启动: http://localhost:${PORT}`);
  // 启动后后台预合成常用播报（不阻塞 listen）
  const warmupDone = startWarmup();
  if (warmupDone) {
    warmupDone
      .then((r) => console.log(`[server] TTS 预热完成: ${r.total} 条已检查`))
      .catch(() => { /* 预热失败静默 */ });
  }
});

// HTTPS 服务（自签证书，供手机浏览器麦克风权限使用）
(async () => {
  try {
    const creds = await ensureSelfSignedCert();
    const httpsServer = https.createServer(creds, requestHandler);
    httpsServerRef = httpsServer;
    attachWs(httpsServer);
    httpsServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`[server] ⚠️  HTTPS 端口 ${PORT_HTTPS} 已被占用（语音对讲不可用），可设 PORT_HTTPS 更换端口`);
      } else {
        console.error('[server] HTTPS 服务启动失败:', e.message);
      }
    });
    httpsServer.listen(PORT_HTTPS, () => {
      console.log(`[server] HTTPS 服务已启动: https://localhost:${PORT_HTTPS}`);
      console.log(`[server] 语音对讲请访问 https://${localIPv4()}:${PORT_HTTPS}`);
    });
  } catch (e) {
    console.error('[server] HTTPS 启动失败（语音对讲不可用）:', e);
  }
})();
