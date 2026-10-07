'use strict';

/**
 * 账号 / 好友 / 战绩 处理层（GameServer mixin）
 *
 * 从 game.js 拆出，只依赖 users 模块与 this._sendWs，不触碰房间/牌局状态。
 * 通过 Object.assign(GameServer.prototype, accountMixin) 混入，方法内 this 上下文不变。
 */

const users = require('../users');

const accountMixin = {
  _register(ws, msg) {
    try {
      const u = users.registerUser(msg && msg.username, msg && msg.password, msg && msg.name);
      const token = users.issueToken(u.username);
      this._sendWs(ws, { type: 'registered', token, user: u });
    } catch (e) {
      this._sendWs(ws, { type: 'error', code: e.code || 'AUTH_WEAK', message: e.message });
    }
  },

  _login(ws, msg) {
    // 支持两种登录：{username,password} 或 {token}（token 登录用于刷新页面后自动重登）
    let u;
    if (msg && msg.token) u = users.getUserByToken(msg.token);
    else u = users.verifyUser(msg && msg.username, msg && msg.password);
    if (!u) {
      this._sendWs(ws, { type: 'error', code: 'AUTH_INVALID', message: '用户名或密码错误' });
      return;
    }
    const token = users.issueToken(u.username); // 重新签发，旧 token 自然失效
    this._sendWs(ws, { type: 'logged_in', token, user: u });
  },

  _logout(ws, msg) {
    if (msg && msg.token) users.logoutToken(msg.token);
    this._sendWs(ws, { type: 'logged_out' });
  },

  _getHistory(ws, msg) {
    // 账户来源：优先用已进大厅并关联账户的玩家；未进大厅（仅 token 登录）则用 token 解析
    const p = this.wsPlayers.get(ws);
    let account = p && p.account;
    if (!account && msg && msg.token) {
      const u = users.getUserByToken(msg.token);
      if (u) account = u.username;
    }
    if (!account) {
      this._sendWs(ws, { type: 'history', records: [], guest: true });
      return;
    }
    const limit = Math.min(200, Math.max(10, Number(msg && msg.limit) || 50));
    const records = users.getHistory(account, limit);
    this._sendWs(ws, { type: 'history', records, account });
  },

  // 个人战绩统计：聚合历史记录，输出胜率/净积分/单局最佳等
  _getStats(ws, msg) {
    const p = this.wsPlayers.get(ws);
    let account = p && p.account;
    if (!account && msg && msg.token) {
      const u = users.getUserByToken(msg.token);
      if (u) account = u.username;
    }
    if (!account) {
      this._sendWs(ws, { type: 'stats', guest: true });
      return;
    }
    this._sendWs(ws, { type: 'stats', account, stats: users.getUserStats(account) });
  },

  // 全局排行榜：按净积分降序取前 N（任何人可查）
  _getLeaderboard(ws, msg) {
    const limit = Math.min(100, Math.max(1, Number((msg && msg.limit)) || 20));
    this._sendWs(ws, { type: 'leaderboard', list: users.getLeaderboard(limit) });
  },

  // 解析请求账户：优先用已进大厅并关联账户的玩家；其次 token
  _accountOf(ws, msg) {
    const p = this.wsPlayers.get(ws);
    let account = p && p.account;
    if (!account && msg && msg.token) {
      const u = users.getUserByToken(msg.token);
      if (u) account = u.username;
    }
    return account || null;
  },

  // 向某个账户的所有在线连接推送好友关系变更
  _notifyFriendUpdate(username) {
    if (!username) return;
    for (const pl of this.players.values()) {
      if (pl && pl.account === username && pl.ws && pl.ws.readyState === 1) {
        this._sendWs(pl.ws, { type: 'friend_update' });
      }
    }
  },

  _addFriend(ws, msg) {
    const account = this._accountOf(ws, msg);
    if (!account) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'AUTH', message: '请先登录' });
    const target = String((msg && msg.username) || '').trim();
    try {
      const r = users.sendFriendRequest(account, target);
      if (r.already) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'ALREADY', message: '已是好友或请求待处理' });
      this._sendWs(ws, { type: 'friend_result', ok: true, autoAccepted: !!r.autoAccepted, target });
      if (r.autoAccepted) { this._notifyFriendUpdate(account); this._notifyFriendUpdate(target); }
      else this._notifyFriendUpdate(target); // 通知对方有新的好友请求
    } catch (e) {
      this._sendWs(ws, { type: 'friend_result', ok: false, code: e.code || 'ERR', message: e.message });
    }
  },

  _acceptFriend(ws, msg) {
    const account = this._accountOf(ws, msg);
    if (!account) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'AUTH', message: '请先登录' });
    const from = String((msg && msg.username) || '').trim();
    const ok = users.acceptFriendRequest(account, from);
    if (!ok) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'NO_REQ', message: '没有该好友请求' });
    this._sendWs(ws, { type: 'friend_result', ok: true, accepted: from });
    this._notifyFriendUpdate(account);
    this._notifyFriendUpdate(from);
  },

  _declineFriend(ws, msg) {
    const account = this._accountOf(ws, msg);
    if (!account) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'AUTH', message: '请先登录' });
    const from = String((msg && msg.username) || '').trim();
    users.declineFriendRequest(account, from);
    this._sendWs(ws, { type: 'friend_result', ok: true, declined: from });
  },

  _removeFriend(ws, msg) {
    const account = this._accountOf(ws, msg);
    if (!account) return this._sendWs(ws, { type: 'friend_result', ok: false, code: 'AUTH', message: '请先登录' });
    const target = String((msg && msg.username) || '').trim();
    users.removeFriend(account, target);
    this._sendWs(ws, { type: 'friend_result', ok: true, removed: target });
    this._notifyFriendUpdate(account);
    this._notifyFriendUpdate(target);
  },

  _friendList(ws, msg) {
    const account = this._accountOf(ws, msg);
    if (!account) return this._sendWs(ws, { type: 'friend_list', guest: true });
    this._sendWs(ws, {
      type: 'friend_list',
      friends: users.listFriends(account),
      requests: users.listIncomingRequests(account),
    });
  },

  // 本局结算收口：把有账户的玩家本局战绩落盘（增量 delta + 累计总分 + 是否胡牌）
  _recordRoundHistory(room) {
    if (!room || !room.players) return;
    const winners = room.game && room.game.winners;
    if (!winners) return; // 异常中止的局不记录
    const variant = room.settings ? room.settings.variant : 'unknown';
    const roundNo = room.roundNo || 0;
    const type = winners.type; // 'hu' | 'draw'
    const winnerSeat = type === 'hu' ? winners.winnerSeat : -1;
    for (const pl of room.players) {
      if (!pl || !pl.account) continue; // 游客不记录
      users.appendHistory(pl.account, {
        t: Date.now(),
        variant,
        roundNo,
        roomId: room.id,
        name: pl.name,
        delta: pl.roundScore || 0,
        total: pl.score || 0,
        isWin: type === 'hu' && winnerSeat === pl.seat,
        type,
      });
    }
  },
};

module.exports = accountMixin;
