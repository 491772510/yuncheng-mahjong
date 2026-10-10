'use strict';

// ============ 前端 localStorage 禁用防护回归测试 ============
// 背景：app.js 顶层有 34 处 localStorage 裸访问，在禁用存储的环境（企业 WebView /
// 严格隐私模式）会抛 SecurityError 导致整页白屏。已加 store 安全封装（降级内存 Map）。
// 本测试模拟 localStorage 访问即抛异常的环境，验证：
// 1) app.js 求值不抛异常（不白屏）
// 2) 基础交互链路仍通（填昵称 → 进大厅 → ws 发出 join_lobby）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('localStorage 被禁用时 app.js 不白屏且基础交互可用', () => {
  const dom = new JSDOM(html, {
    url: 'http://localhost:3100/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // 模拟禁用存储：任何 localStorage 访问都抛 SecurityError（Safari 严格隐私模式的真实行为）
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new window.DOMException('The document is not permitted to use localStorage', 'SecurityError');
    },
  });

  // 最小 mock：与 frontend-hand-interact.test.js 保持一致
  window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  window.Audio = class { constructor(src) { this.src = src; } play() { return Promise.resolve(); } };
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; window.__lastWs = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  };

  // 核心断言 1：顶层初始化不因 SecurityError 崩溃
  assert.doesNotThrow(() => window.eval(appJs), '禁用 localStorage 时 app.js 求值不应抛异常');

  // 核心断言 2：进大厅链路可用（store 降级内存 Map，凭据为空但功能不崩）
  document.querySelector('#nick-input').value = '测试玩家';
  document.querySelector('#join-lobby-btn').click();
  const ws = window.__lastWs;
  assert.ok(ws, '点击进大厅应已建立 WebSocket');
  const join = ws.sent.find((m) => m.type === 'join_lobby');
  assert.ok(join, '应发出 join_lobby 消息');
  assert.strictEqual(join.name, '测试玩家');
});
