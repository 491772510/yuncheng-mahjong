'use strict';
/**
 * 运城麻将 —— 账号与历史对局记录
 * 零额外依赖：用 Node 内置 crypto（scrypt）做密码哈希，文件落盘做持久化。
 * 设计取舍：
 *   - 账户存 data/users.json（内存 Map 为主、200ms 防抖落盘），注册低频，足够局域网场景。
 *   - token 仅存内存（不落盘）：重启即全员下线；但历史记录按账户落盘，重新登录即可查，无数据丢失。
 *   - 历史记录按用户分文件 data/history/<user>.jsonl（appendFile，单进程 O_APPEND 保证顺序）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.KD_DATA_DIR
  ? path.resolve(process.env.KD_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

let users = new Map();      // username -> { username, salt, hash, displayName, createdAt }
let sessions = new Map();   // token -> username
let writeChain = Promise.resolve(); // 串行化所有落盘（用户保存 + 历史追加），flush() 可await

function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* noop */ }
  try { if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true }); } catch (e) { /* noop */ }
}

function load() {
  ensureDir();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const arr = JSON.parse(raw || '[]');
    users = new Map(arr.map((u) => [u.username, u]));
  } catch (e) {
    users = new Map();
  }
}

function scheduleSave() {
  // 注册低频，直接串行落盘（无防抖），保证每次写都进 writeChain，flush() 可安全 await
  writeChain = writeChain.then(() =>
    fsp.writeFile(USERS_FILE, JSON.stringify([...users.values()], null, 2)).catch(() => { /* noop */ }));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function publicUser(u) {
  return { username: u.username, displayName: u.displayName, createdAt: u.createdAt };
}

function registerUser(username, password, displayName) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_一-龥]{2,16}$/.test(username)) {
    const err = new Error('用户名需 2-16 位（字母/数字/下划线/中文）');
    err.code = 'AUTH_WEAK';
    throw err;
  }
  if (!password || String(password).length < 6) {
    const err = new Error('密码至少 6 位');
    err.code = 'AUTH_WEAK';
    throw err;
  }
  if (users.has(username)) {
    const err = new Error('用户名已被占用');
    err.code = 'AUTH_EXISTS';
    throw err;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const user = {
    username,
    salt,
    hash,
    displayName: String(displayName || username).trim().slice(0, 12) || username,
    createdAt: Date.now(),
  };
  users.set(username, user);
  scheduleSave();
  return publicUser(user);
}

function verifyUser(username, password) {
  const u = users.get(String(username || '').trim());
  if (!u) return null;
  let h;
  try {
    h = hashPassword(String(password || ''), u.salt);
  } catch (e) {
    return null;
  }
  const a = Buffer.from(h);
  const b = Buffer.from(u.hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return publicUser(u);
}

function issueToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, username);
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const username = sessions.get(token);
  if (!username) return null;
  const u = users.get(username);
  return u ? publicUser(u) : null;
}

function logoutToken(token) {
  if (token) sessions.delete(token);
}

function appendHistory(username, record) {
  try {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const file = path.join(HISTORY_DIR, username + '.jsonl');
    const line = JSON.stringify(record) + '\n';
    writeChain = writeChain.then(() => fsp.appendFile(file, line).catch(() => { /* noop */ }));
  } catch (e) { /* noop */ }
}

function getHistory(username, limit) {
  limit = limit || 50;
  try {
    const file = path.join(HISTORY_DIR, username + '.jsonl');
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const arr = lines
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
    return arr.slice(-limit).reverse();
  } catch (e) {
    return [];
  }
}

function initUsers() {
  load();
}

// 等待所有挂起的落盘完成（测试与优雅退出用）
function flush() {
  return writeChain;
}

module.exports = {
  initUsers,
  registerUser,
  verifyUser,
  issueToken,
  getUserByToken,
  logoutToken,
  appendHistory,
  getHistory,
  flush,
};
