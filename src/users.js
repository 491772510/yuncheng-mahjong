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

// 由历史记录聚合个人战绩：总对局/胜/平/负/胜率/净积分/单局最佳/分玩法积分
function computeStats(records) {
  let games = 0, wins = 0, draws = 0, total = 0, best = 0;
  const byVariant = {};
  for (const r of records) {
    games += 1;
    if (r.isWin) wins += 1;
    else if (r.type === 'draw') draws += 1;
    const d = Number(r.delta) || 0;
    total += d;
    if (d > best) best = d;
    const v = r.variant || 'unknown';
    byVariant[v] = (byVariant[v] || 0) + d;
  }
  const losses = games - wins - draws;
  return {
    games, wins, draws, losses,
    winRate: games ? wins / games : 0,
    totalScore: total,
    bestRound: best,
    byVariant,
  };
}

function getUserStats(username) {
  return computeStats(getHistory(username, 1000000));
}

// 全局排行榜：聚合所有用户历史记录，按净积分降序取前 N
function getLeaderboard(limit) {
  limit = Math.min(100, Math.max(1, Number(limit) || 20));
  let files = [];
  try { files = fs.readdirSync(HISTORY_DIR); } catch (e) { return []; }
  const agg = new Map(); // username -> 聚合
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const uname = f.slice(0, -'.jsonl'.length);
    if (!/^[A-Za-z0-9_一-龥]+$/.test(uname)) continue; // 防御：仅处理合法用户名文件
    let recs;
    try { recs = getHistory(uname, 1000000); } catch (e) { continue; }
    let score = 0, games = 0, wins = 0;
    for (const r of recs) { score += Number(r.delta) || 0; games += 1; if (r.isWin) wins += 1; }
    const u = users.get(uname);
    agg.set(uname, {
      username: uname,
      displayName: u ? u.displayName : uname,
      score, games, wins,
      winRate: games ? wins / games : 0,
    });
  }
  return [...agg.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ============ 好友关系 ============
// 存储：data/friends.json —— { friends: {username:[...]}, requests: {username:[requester,...]} }
// 好友为双向（mutual）；requests 为「待我处理的 incoming」。
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
let friendGraph = { friends: {}, requests: {} };

function saveFriends() {
  writeChain = writeChain.then(() =>
    fsp.writeFile(FRIENDS_FILE, JSON.stringify(friendGraph)).catch(() => { /* noop */ }));
}

function loadFriends() {
  ensureDir();
  try {
    const raw = fs.readFileSync(FRIENDS_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    friendGraph = { friends: obj.friends || {}, requests: obj.requests || {} };
  } catch (e) {
    friendGraph = { friends: {}, requests: {} };
  }
}

function _friendView(username) {
  const u = users.get(username);
  return { username, displayName: u ? u.displayName : username };
}

// 发送好友请求：返回 { ok, autoAccepted, already }；双向 pending 时自动互加
function sendFriendRequest(from, to) {
  from = String(from || '').trim();
  to = String(to || '').trim();
  if (!from || !to) { const e = new Error('用户名不能为空'); e.code = 'PARAM'; throw e; }
  if (from === to) { const e = new Error('不能添加自己为好友'); e.code = 'SELF'; throw e; }
  if (!users.has(to)) { const e = new Error('用户不存在'); e.code = 'NO_USER'; throw e; }
  if (!friendGraph.friends[from]) friendGraph.friends[from] = [];
  if (friendGraph.friends[from].includes(to)) { return { ok: false, already: true }; }
  // 对方也已向我发起请求 → 自动互加
  if ((friendGraph.requests[from] || []).includes(to)) {
    _addMutual(from, to);
    saveFriends();
    return { ok: true, autoAccepted: true };
  }
  if (!friendGraph.requests[to]) friendGraph.requests[to] = [];
  if (friendGraph.requests[to].includes(from)) { return { ok: false, already: true }; }
  friendGraph.requests[to].push(from);
  saveFriends();
  return { ok: true };
}

function _addMutual(a, b) {
  if (!friendGraph.friends[a]) friendGraph.friends[a] = [];
  if (!friendGraph.friends[b]) friendGraph.friends[b] = [];
  if (!friendGraph.friends[a].includes(b)) friendGraph.friends[a].push(b);
  if (!friendGraph.friends[b].includes(a)) friendGraph.friends[b].push(a);
  // 清除双方 pending
  friendGraph.requests[a] = (friendGraph.requests[a] || []).filter((x) => x !== b);
  friendGraph.requests[b] = (friendGraph.requests[b] || []).filter((x) => x !== a);
}

function acceptFriendRequest(to, from) {
  to = String(to || '').trim();
  from = String(from || '').trim();
  if (!friendGraph.requests[to] || !friendGraph.requests[to].includes(from)) return false;
  _addMutual(from, to);
  saveFriends();
  return true;
}

function declineFriendRequest(to, from) {
  to = String(to || '').trim();
  from = String(from || '').trim();
  if (!friendGraph.requests[to]) return false;
  friendGraph.requests[to] = friendGraph.requests[to].filter((x) => x !== from);
  saveFriends();
  return true;
}

function removeFriend(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (friendGraph.friends[a]) friendGraph.friends[a] = friendGraph.friends[a].filter((x) => x !== b);
  if (friendGraph.friends[b]) friendGraph.friends[b] = friendGraph.friends[b].filter((x) => x !== a);
  saveFriends();
  return true;
}

function listFriends(username) {
  const list = friendGraph.friends[String(username || '').trim()] || [];
  return list.map(_friendView);
}

function listIncomingRequests(username) {
  const list = friendGraph.requests[String(username || '').trim()] || [];
  return list.map(_friendView);
}

// 修改显示昵称：仅更新 displayName，登录用户名 username 保持不变（好友/历史/排行榜主键）
function changeDisplayName(username, displayName) {
  username = String(username || '').trim();
  const u = users.get(username);
  if (!u) {
    const e = new Error('用户不存在');
    e.code = 'NO_USER';
    throw e;
  }
  displayName = String(displayName || '').trim().slice(0, 12);
  if (!displayName) {
    const e = new Error('昵称不能为空');
    e.code = 'PARAM';
    throw e;
  }
  u.displayName = displayName;
  scheduleSave();
  return publicUser(u);
}

// 修改密码：验证旧密码后重新生成 salt + hash
function changePassword(username, oldPassword, newPassword) {
  username = String(username || '').trim();
  if (!verifyUser(username, oldPassword)) {
    const e = new Error('原密码错误');
    e.code = 'AUTH_INVALID';
    throw e;
  }
  if (!newPassword || String(newPassword).length < 6) {
    const e = new Error('新密码至少 6 位');
    e.code = 'AUTH_WEAK';
    throw e;
  }
  const u = users.get(username);
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt;
  u.hash = hashPassword(newPassword, salt);
  scheduleSave();
  return true;
}

// 注销账号：彻底删除账号 + 历史对局文件 + 好友关系 + 会话 token，不可恢复
function deleteAccount(username) {
  username = String(username || '').trim();
  if (!users.has(username)) {
    const e = new Error('用户不存在');
    e.code = 'NO_USER';
    throw e;
  }
  users.delete(username);
  // 删除所有指向该账号的会话 token
  for (const [token, uname] of sessions) {
    if (uname === username) sessions.delete(token);
  }
  // 删除历史对局文件（串行进 writeChain，排在已挂起的 appendFile 之后，避免竞争）
  const file = path.join(HISTORY_DIR, username + '.jsonl');
  writeChain = writeChain.then(() =>
    fsp.unlink(file).catch((e) => { if (e.code !== 'ENOENT') { /* noop */ } }));
  // 清理好友关系：删除自己的 key，并从别人的 friends/requests 数组里移除它
  delete friendGraph.friends[username];
  delete friendGraph.requests[username];
  for (const key of Object.keys(friendGraph.friends)) {
    friendGraph.friends[key] = friendGraph.friends[key].filter((x) => x !== username);
  }
  for (const key of Object.keys(friendGraph.requests)) {
    friendGraph.requests[key] = friendGraph.requests[key].filter((x) => x !== username);
  }
  saveFriends();
  scheduleSave(); // 删除后落盘用户表
  return true;
}

function initUsers() {
  load();
  loadFriends();
}

function hasUser(username) {
  return users.has(String(username || '').trim());
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
  getUserStats,
  getLeaderboard,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  listFriends,
  listIncomingRequests,
  changeDisplayName,
  changePassword,
  deleteAccount,
  hasUser,
  flush,
};
