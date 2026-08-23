'use strict';

/**
 * 房间与牌局状态机（GameServer）
 *
 * 职责：
 *  - 大厅：昵称注册、重连
 *  - 房间：创建/加入/退出/解散、AI 补位、房主管理、4 人满自动开局
 *  - 牌局：发牌、回合流转（摸牌→出牌→响应）、碰/杠/胡/过、抢杠胡、
 *    杠上开花、海底捞月、流局荒庄、积分结算、总局数结算
 *  - 健壮性：全部操作服务端校验；断线 60 秒重连恢复；超时 AI 托管
 */

const rules = require('./rules');
const ai = require('./ai');

const RECONNECT_MS = 60000; // 断线重连窗口
const HUMAN_TIMEOUT_MS = 30000; // 真人行动超时（自动托管）
const RESPONSE_TIMEOUT_MS = 20000; // 响应窗口
const MAX_ROOMS = 100;
const MAX_LOGS = 200;
const MAX_CHAT = 50;

function nowTime() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

class GameServer {
  constructor() {
    this.rooms = new Map(); // roomId -> room
    this.players = new Map(); // playerId -> player
    this.wsPlayers = new Map(); // ws -> playerId
  }

  // ============ 网络层 ============

  handleConnection(ws) {
    ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
    ws.on('close', () => this._onWsClose(ws));
    ws.on('error', () => {});
  }

  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this._sendWs(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this._sendWs(ws, { type: 'error', message: '无效的消息格式' });
      return;
    }
    try {
      if (msg.type === 'join_lobby') return this._joinLobby(ws, msg);
      if (msg.type === 'reconnect') return this._reconnect(ws, msg);

      const playerId = this.wsPlayers.get(ws);
      const p = playerId ? this.players.get(playerId) : null;
      if (!p) {
        this._sendWs(ws, { type: 'error', message: '请先进入大厅' });
        return;
      }
      switch (msg.type) {
        case 'create_room': return this._createRoom(p, msg);
        case 'join_room': return this._joinRoom(p, msg);
        case 'leave_room': return this._leaveRoom(p);
        case 'start_game': return this._startGame(p);
        case 'add_ai': return this._addAIByPlayer(p);
        case 'dissolve': return this._dissolve(p);
        case 'play_tile': return this._playTile(p, msg);
        case 'ting': return this._ting(p, msg);
        case 'peng': return this._peng(p);
        case 'gang': return this._gang(p, msg);
        case 'hu': return this._hu(p);
        case 'pass': return this._pass(p);
        case 'chat': return this._chat(p, msg);
        default: return this._send(p, { type: 'error', message: '未知消息类型' });
      }
    } catch (e) {
      console.error('[game] handleMessage error:', e);
      this._sendWs(ws, { type: 'error', message: '服务器内部错误' });
    }
  }

  // ============ 大厅 ============

  _joinLobby(ws, msg) {
    const name = this._sanitizeName(msg && msg.name);
    if (!name) {
      this._sendWs(ws, { type: 'error', message: '昵称不能为空（1-12 个字符）' });
      return;
    }
    const p = this._createPlayer(ws, name);
    this._send(p, { type: 'hello', playerId: p.id, name: p.name });
    this._sendLobbyState(p);
  }

  _reconnect(ws, msg) {
    const id = String((msg && msg.playerId) || '');
    const p = this.players.get(id);
    if (!p) {
      this._sendWs(ws, { type: 'error', message: '重连失败：找不到玩家记录，请重新进入' });
      return;
    }
    // 替换旧连接
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) {
      try { p.ws.close(); } catch { /* ignore */ }
    }
    if (p.ws) this.wsPlayers.delete(p.ws);
    p.ws = ws;
    p.connected = true;
    p.hosted = false;
    if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
    this.wsPlayers.set(ws, p.id);
    this._send(p, { type: 'hello', playerId: p.id, name: p.name });

    if (p.roomId) {
      const room = this.rooms.get(p.roomId);
      const stillSeated = room && room.players[p.seat] === p;
      if (!room || !stillSeated) {
        p.roomId = null;
        p.seat = null;
        this._sendLobbyState(p);
        return;
      }
      this._log(room, `${p.name} 重新连接`);
      this._send(p, { type: 'room_state', room: this._buildRoomView(room) });
      if (room.state === 'playing' && room.game) {
        this._send(p, { type: 'game_state', game: this._buildGameView(room, p.seat) });
      }
      if (room.game && room.game.winners) this._sendSettlement(room, p);
      this._broadcastRoomState(room);
      // 若正好轮到他且已托管：恢复真人控制后仍由本人操作
      this._broadcastGameState(room);
    } else {
      this._sendLobbyState(p);
    }
  }

  _onWsClose(ws) {
    const playerId = this.wsPlayers.get(ws);
    if (!playerId) return;
    this.wsPlayers.delete(ws);
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.ws === ws) p.ws = null;
    p.connected = false;

    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (room) {
      this._log(room, `${p.name} 断线（60 秒内可重连）`);
      if (room.state === 'playing' && room.game) {
        p.hosted = true;
        // 若正等该玩家响应 → 立即视为过，避免卡局
        const g = room.game;
        if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === p.seat);
          if (r && r.choice === null) {
            r.choice = 'pass';
            this._clearTimer(room, 'resp:' + p.seat);
            this._log(room, `${p.name} 断线，响应视为过`);
            this._tryResolvePending(room, g, g.pending);
          }
        }
        if (this._shouldAutoAct(room, p.seat)) this._scheduleAutoAct(room, p.seat);
      }
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game) this._broadcastGameState(room);
    }
    if (!p.disconnectTimer) {
      p.disconnectTimer = setTimeout(() => this._handleDisconnectTimeout(p), RECONNECT_MS);
    }
  }

  _handleDisconnectTimeout(p) {
    if (p.connected) return;
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) {
      this.players.delete(p.id);
      return;
    }
    if (room.state === 'waiting') {
      this._log(room, `${p.name} 超时未重连，已离开房间`);
      if (p.id === room.ownerId) {
        const others = room.players.filter(Boolean).filter((x) => x.id !== p.id);
        if (others.length === 0) {
          this._destroyRoom(room);
          return;
        }
        room.ownerId = others[0].id;
      }
      this._unseatPlayer(room, p);
      this.players.delete(p.id);
      this._broadcastRoomState(room);
      this._broadcastLobby();
    } else {
      if (!p.hosted) p.hosted = true;
      this._log(room, `${p.name} 超时未重连，座位已由 AI 托管`);
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game && this._shouldAutoAct(room, p.seat)) {
        this._scheduleAutoAct(room, p.seat);
      }
    }
  }

  // ============ 房间 ============

  _createRoom(p, msg) {
    if (p.roomId) return this._err(p, '您已在房间中，请先退出');
    if (this.rooms.size >= MAX_ROOMS) return this._err(p, '房间数量已达上限');
    const settings = this._validateSettings(msg && msg.settings);
    if (!settings) return this._err(p, '房间设置不合法（底分/番型上限/总局数取值错误）');

    let id;
    do {
      id = String(Math.floor(1000 + Math.random() * 9000));
    } while (this.rooms.has(id));

    const room = {
      id,
      settings,
      ownerId: p.id,
      state: 'waiting',
      roundNo: 0,
      players: [null, null, null, null],
      game: null,
      dealer: null,
      lastWinner: null,
      logs: [],
      chat: [],
      timers: new Map(),
      nextAiNo: 1,
    };
    this.rooms.set(id, room);
    this._seatPlayer(room, p);
    this._log(room, `${p.name} 创建了房间 ${id}`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room) });
    this._broadcastLobby();
  }

  _joinRoom(p, msg) {
    if (p.roomId) return this._err(p, '您已在房间中，请先退出');
    const id = String((msg && msg.roomId) || '').trim();
    if (!/^\d{4}$/.test(id)) return this._err(p, '房间号必须是 4 位数字');
    const room = this.rooms.get(id);
    if (!room) return this._err(p, '房间不存在');
    if (room.state !== 'waiting') return this._err(p, '房间当前不可加入（游戏中或已结算）');
    if (!room.players.some((x) => x === null)) return this._err(p, '房间已满');

    this._seatPlayer(room, p);
    this._log(room, `${p.name} 加入房间`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room) });
    this._broadcastRoomState(room);
    this._broadcastLobby();
    // 4 人满自动开局
    if (room.players.filter(Boolean).length === 4) {
      this._startGameInternal(room);
    }
  }

  _leaveRoom(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (room.state === 'playing') {
      return this._err(p, '牌局进行中，无法退出（可请房主解散房间）');
    }
    if (p.id === room.ownerId) {
      const others = room.players.filter(Boolean).filter((x) => x.id !== p.id);
      if (others.length === 0) {
        this._destroyRoom(room);
        return;
      }
      room.ownerId = others[0].id;
      this._log(room, `房主 ${p.name} 退出，${others[0].name} 成为新房主`);
    }
    this._unseatPlayer(room, p);
    this._log(room, `${p.name} 离开了房间`);
    this._send(p, { type: 'room_state', room: null });
    this._sendLobbyState(p);
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  _dissolve(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以解散房间');
    this._log(room, `房间 ${room.id} 已被房主解散`);
    this._destroyRoom(room);
  }

  _addAIByPlayer(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以添加 AI');
    if (room.state !== 'waiting') return this._err(p, '当前状态不能添加 AI');
    if (room.players.filter(Boolean).length >= 4) return this._err(p, '房间已满');
    this._addAI(room);
    this._broadcastRoomState(room);
    this._broadcastLobby();
    if (room.players.filter(Boolean).length === 4) {
      this._startGameInternal(room);
    }
  }

  _startGame(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (p.id !== room.ownerId) return this._err(p, '只有房主可以开始游戏');
    if (room.state !== 'waiting' && room.state !== 'settled') {
      return this._err(p, '牌局正在进行中');
    }
    this._startGameInternal(room);
  }

  _startGameInternal(room) {
    if (room.state === 'settled') {
      // 新一轮：重置积分与局数
      room.roundNo = 0;
      room.lastWinner = null;
      room.dealer = null;
      for (const pl of room.players) {
        if (pl) {
          pl.score = 0;
          pl.roundScore = 0;
          pl.hosted = false;
        }
      }
      room.state = 'waiting';
      this._log(room, '开启新一轮，积分已重置');
    }
    if (room.state !== 'waiting') return;
    if (room.settings.aiFill) {
      while (room.players.filter(Boolean).length < 4) this._addAI(room);
    }
    if (room.players.filter(Boolean).length !== 4) {
      this._log(room, '人数不足，无法开局（AI 补位已关闭）');
      this._broadcastRoomState(room);
      return;
    }
    this._dealRound(room);
  }

  _addAI(room) {
    const seat = room.players.findIndex((x) => x === null);
    if (seat < 0) return null;
    const seq = room.nextAiNo++;
    const p = {
      id: `ai_${room.id}_${seq}`,
      name: `机器人${seq}`,
      isAI: true,
      connected: true,
      hosted: false,
      ws: null,
      roomId: room.id,
      seat,
      score: 0,
      roundScore: 0,
      disconnectTimer: null,
      _auto: 0,
    };
    room.players[seat] = p;
    this.players.set(p.id, p);
    this._log(room, `${p.name} 加入房间（AI）`);
    return p;
  }

  // ============ 牌局 ============

  _dealRound(room) {
    room.roundNo = (room.roundNo || 0) + 1;
    const wall = rules.shuffle(rules.createTiles(room.settings.tileSet));
    const g = (room.game = {
      roundNo: room.roundNo,
      wall,
      wallPos: 0,
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      turn: -1,
      stage: 'draw',
      drawnTile: null,
      lastDiscard: null,
      lastAction: null,
      pending: null,
      dealer: -1,
      winners: null,
      tingSeats: [], // 已报听（听口）的玩家 seat 列表
      startAt: Date.now(),
    });
    for (let i = 0; i < 13; i++) {
      for (let s = 0; s < 4; s++) g.hands[s].push(g.wall[g.wallPos++]);
    }
    // 庄家：上局胡牌者坐庄；荒庄连庄；首局随机
    if (room.lastWinner != null && room.players[room.lastWinner]) {
      room.dealer = room.lastWinner;
    } else if (room.dealer == null || !room.players[room.dealer]) {
      room.dealer = Math.floor(Math.random() * 4);
    }
    g.dealer = room.dealer;
    for (const pl of room.players) if (pl) pl.roundScore = 0;
    room.state = 'playing';
    this._log(room, `第 ${room.roundNo} 局开始，${this._pName(room, g.dealer)} 坐庄`);
    this._broadcastRoomState(room);
    this._drawTile(room, g.dealer);
  }

  _drawTile(room, seat) {
    const g = room.game;
    if (g.wallPos >= g.wall.length) {
      this._settleDraw(room);
      return;
    }
    const tile = g.wall[g.wallPos++];
    g.hands[seat].push(tile);
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = tile;
    g.lastDiscard = null;
    g.lastAction = null;
    this._log(room, `${this._pName(room, seat)} 摸到 ${rules.tileName(tile)}`);
    const cur = room.players[seat];
    if (cur && cur.ws) this._send(cur, { type: 'draw_notice', tile });
    // 听口玩家：摸牌即打（不能换牌、不能碰杠），系统自动打出刚摸的牌
    if (g.tingSeats.includes(seat)) {
      this._autoTingDiscard(room, seat, tile);
      return;
    }
    this._afterTurnStart(room, seat);
  }

  /** 听口玩家摸牌即打：将刚摸的牌立即打出，并进入响应判定 */
  _autoTingDiscard(room, seat, tile) {
    const g = room.game;
    const idx = g.hands[seat].lastIndexOf(tile);
    if (idx >= 0) g.hands[seat].splice(idx, 1);
    g.discards[seat].push(tile);
    g.lastDiscard = { tile, seat };
    g.drawnTile = null;
    g.lastAction = null;
    this._clearTimer(room, 'draw:' + seat);
    this._log(room, `${this._pName(room, seat)} 摸牌即打 ${rules.tileName(tile)}（听口）`);
    this._afterDiscard(room, seat);
  }

  /** 碰后 / 摸牌后 / 杠后补牌后：统一进入行动阶段 */
  _afterTurnStart(room, seat) {
    const g = room.game;
    this._broadcastGameState(room);
    this._prompt(room, seat, this._buildDrawPrompt(room, seat));
    this._setTimer(room, 'draw:' + seat, HUMAN_TIMEOUT_MS, () => {
      const g2 = room.game;
      if (room.state === 'playing' && g2 === g && g2.stage === 'draw' && g2.turn === seat) {
        const pl = room.players[seat];
        if (pl && !pl.isAI && pl.connected && !pl.hosted) {
          pl.hosted = true;
          this._log(room, `${pl.name} 操作超时，已由 AI 托管`);
          this._broadcastRoomState(room);
        }
        if (this._shouldAutoAct(room, seat)) this._scheduleAutoAct(room, seat);
      }
    });
    if (this._shouldAutoAct(room, seat)) this._scheduleAutoAct(room, seat);
  }

  /** 杠后补牌 */
  _drawAfterGang(room, seat) {
    const g = room.game;
    if (g.wallPos >= g.wall.length) {
      this._settleDraw(room);
      return;
    }
    const tile = g.wall[g.wallPos++];
    g.hands[seat].push(tile);
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = tile;
    g.lastDiscard = null;
    g.lastAction = { type: 'gang' }; // 保持杠标记 → 杠上开花
    this._log(room, `${this._pName(room, seat)} 杠后补到 ${rules.tileName(tile)}`);
    const cur = room.players[seat];
    if (cur && cur.ws) this._send(cur, { type: 'draw_notice', tile });
    this._afterTurnStart(room, seat);
  }

  _nextTurn(room, fromSeat) {
    for (let i = 1; i <= 4; i++) {
      const s = (fromSeat + i) % 4;
      if (room.players[s]) {
        this._drawTile(room, s);
        return;
      }
    }
  }

  /** 出牌后的响应判定 */
  _afterDiscard(room, discarder) {
    const g = room.game;
    const tile = g.lastDiscard.tile;
    const responders = [];
    for (let s = 0; s < 4; s++) {
      if (!room.players[s] || s === discarder) continue;
      if (g.tingSeats.includes(s)) continue; // 听口玩家只能自摸，不参与碰/杠/点炮
      const canHu = room.settings.allowDianpao && rules.canHuWith(g.hands[s], tile);
      const canGang = rules.canGang(g.hands[s], tile);
      const canPeng = rules.canPeng(g.hands[s], tile);
      if (canHu || canGang || canPeng) {
        responders.push({ seat: s, canHu, canGang, canPeng, choice: null });
      }
    }
    if (responders.length === 0) {
      g.lastAction = null;
      this._nextTurn(room, discarder);
      return;
    }
    g.stage = 'response';
    g.pending = { type: 'discard', tile, discarder, responders };
    this._broadcastGameState(room);
    for (const r of responders) {
      this._prompt(room, r.seat, this._buildResponsePrompt(room, r));
      this._setTimer(room, 'resp:' + r.seat, RESPONSE_TIMEOUT_MS, () => {
        const g2 = room.game;
        if (room.state === 'playing' && g2 === g && g.pending === r._pendingRef && r.choice === null) {
          const pl = room.players[r.seat];
          if (pl && !pl.isAI && pl.connected && !pl.hosted) {
            pl.hosted = true;
            this._log(room, `${pl.name} 响应超时，已由 AI 托管`);
            this._broadcastRoomState(room);
          }
          r.choice = 'pass';
          this._tryResolvePending(room, g, g.pending);
        }
      });
      r._pendingRef = g.pending;
      if (this._shouldAutoAct(room, r.seat)) this._scheduleAutoAct(room, r.seat);
    }
  }

  _tryResolvePending(room, g, pending) {
    if (!pending) return;
    const allDecided = pending.responders.every((r) => r.choice !== null);
    if (!allDecided) return;
    for (const r of pending.responders) this._clearTimer(room, 'resp:' + r.seat);
    g.pending = null;

    const huList = pending.responders.filter((r) => r.choice === 'hu');
    if (huList.length > 0) {
      for (const r of huList) {
        this._settleHu(room, r.seat, {
          winType: pending.type === 'qianggang' ? 'qianggang' : 'dianpao',
          tile: pending.tile,
          discarder: pending.discarder,
          qiangGang: pending.type === 'qianggang',
        });
      }
      this._endRound(room);
      return;
    }
    const gangList = pending.responders.filter((r) => r.choice === 'gang');
    if (gangList.length > 0) {
      const pick = this._nearestSeat(gangList.map((r) => r.seat), pending.discarder);
      this._doGangFromDiscard(room, pick, pending.tile);
      return;
    }
    const pengList = pending.responders.filter((r) => r.choice === 'peng');
    if (pengList.length > 0) {
      const pick = this._nearestSeat(pengList.map((r) => r.seat), pending.discarder);
      this._doPeng(room, pick, pending.tile);
      return;
    }
    g.lastAction = null;
    this._nextTurn(room, pending.discarder);
  }

  _nearestSeat(seats, fromSeat) {
    let best = seats[0];
    let bestDist = Infinity;
    for (const s of seats) {
      const d = (s - fromSeat + 4) % 4;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  _doPeng(room, seat, tile) {
    const g = room.game;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 2; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    g.melds[seat].push({ type: 'peng', tile, tiles: [tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'peng' };
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = null; // 碰后只能出牌，不能胡/杠
    this._log(room, `${this._pName(room, seat)} 碰了 ${rules.tileName(tile)}`);
    this._afterTurnStart(room, seat);
  }

  _doGangFromDiscard(room, seat, tile) {
    const g = room.game;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 3; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    g.melds[seat].push({ type: 'gang', tile, tiles: [tile, tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'gang' };
    g.turn = seat;
    this._log(room, `${this._pName(room, seat)} 明杠了 ${rules.tileName(tile)}`);
    this._drawAfterGang(room, seat);
  }

  _doAnGang(room, seat, tile) {
    const g = room.game;
    const hand = g.hands[seat];
    let removed = 0;
    for (let i = 0; i < hand.length && removed < 4; i++) {
      if (hand[i] === tile) {
        hand.splice(i, 1);
        i--;
        removed++;
      }
    }
    g.melds[seat].push({ type: 'angang', tile, tiles: [tile, tile, tile, tile] });
    g.lastAction = { type: 'gang' };
    this._log(room, `${this._pName(room, seat)} 暗杠了 ${rules.tileName(tile)}`);
    this._drawAfterGang(room, seat);
  }

  _doBuGang(room, seat, tile) {
    const g = room.game;
    // 先检查抢杠胡
    const grabbers = [];
    for (let s = 0; s < 4; s++) {
      if (s === seat || !room.players[s]) continue;
      if (g.tingSeats.includes(s)) continue; // 听口玩家不参与抢杠胡
      if (rules.canHuWith(g.hands[s], tile)) grabbers.push(s);
    }
    if (grabbers.length > 0) {
      g.stage = 'response';
      g.pending = {
        type: 'qianggang',
        tile,
        discarder: seat,
        responders: grabbers.map((s) => ({
          seat: s,
          canHu: true,
          canGang: false,
          canPeng: false,
          choice: null,
        })),
      };
      this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}，触发抢杠胡判定`);
      this._broadcastGameState(room);
      for (const r of g.pending.responders) {
        this._prompt(room, r.seat, this._buildResponsePrompt(room, r));
        this._setTimer(room, 'resp:' + r.seat, RESPONSE_TIMEOUT_MS, () => {
          const g2 = room.game;
          if (room.state === 'playing' && g2 === g && g.pending === r._pendingRef && r.choice === null) {
            r.choice = 'pass';
            this._tryResolvePending(room, g, g.pending);
          }
        });
        r._pendingRef = g.pending;
        if (this._shouldAutoAct(room, r.seat)) this._scheduleAutoAct(room, r.seat);
      }
      return;
    }
    // 无人抢杠 → 补杠
    const hand = g.hands[seat];
    const idx = hand.indexOf(tile);
    if (idx >= 0) hand.splice(idx, 1);
    const m = g.melds[seat].find((mm) => mm.type === 'peng' && mm.tile === tile);
    if (m) {
      m.type = 'bugang';
      m.tiles.push(tile);
    }
    g.lastAction = { type: 'gang' };
    this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}`);
    this._drawAfterGang(room, seat);
  }

  _settleHu(room, winnerSeat, info) {
    const g = room.game;
    const hand = g.hands[winnerSeat];
    const gangShang = info.winType === 'zimo' && !!(g.lastAction && g.lastAction.type === 'gang');
    const haiDi = info.winType === 'zimo' && g.wallPos >= g.wall.length;
    const fanCalc = rules.calcFan(
      hand,
      {
        winType: info.winType,
        gangShang,
        haiDi,
        qiangGang: !!info.qiangGang,
        tingKou: info.winType === 'zimo' && g.tingSeats.includes(winnerSeat),
        melds: g.melds[winnerSeat],
      },
      true
    );
    const fan = fanCalc.fan;
    const fanNames = fanCalc.names;
    const base = room.settings.baseScore;
    const score = rules.calcScore(base, fan, room.settings.fanLimit);
    const cappedFan = score / base;

    if (info.winType === 'zimo') {
      for (let s = 0; s < 4; s++) {
        if (s === winnerSeat || !room.players[s]) continue;
        room.players[s].score -= score;
        room.players[s].roundScore -= score;
        room.players[winnerSeat].score += score;
        room.players[winnerSeat].roundScore += score;
      }
    } else {
      const loser = room.players[info.discarder];
      if (loser) {
        loser.score -= score;
        loser.roundScore -= score;
        room.players[winnerSeat].score += score;
        room.players[winnerSeat].roundScore += score;
      }
    }

    g.winners = {
      type: 'hu',
      winnerSeat,
      winType: info.winType,
      fan: cappedFan,
      fanNames,
      score,
      tile: info.tile,
      discarder: info.winType === 'zimo' ? null : info.discarder,
      hands: this._revealHands(room),
    };
    room.lastWinner = winnerSeat;
    const winLabel =
      info.winType === 'zimo' ? '自摸' : info.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    this._log(
      room,
      `${this._pName(room, winnerSeat)} ${winLabel} ${rules.tileName(info.tile)}（${cappedFan}番 → ${score}分）`
    );
    this._broadcastGameState(room);
    this._sendSettlement(room);
    this._broadcastRoomState(room);
  }

  _settleDraw(room) {
    const g = room.game;
    g.stage = 'over';
    const tingSeats = [];
    for (let s = 0; s < 4; s++) {
      if (room.players[s] && rules.isTing(g.hands[s], room.settings.tileSet).length > 0) tingSeats.push(s);
    }
    const notTing = [];
    for (let s = 0; s < 4; s++) {
      if (room.players[s] && !tingSeats.includes(s)) notTing.push(s);
    }
    if (tingSeats.length > 0 && tingSeats.length < 4) {
      const base = room.settings.baseScore;
      for (const t of tingSeats) {
        for (const n of notTing) {
          room.players[t].score += base;
          room.players[t].roundScore += base;
          room.players[n].score -= base;
          room.players[n].roundScore -= base;
        }
      }
    }
    g.winners = { type: 'draw', tingSeats, notTing, hands: this._revealHands(room) };
    room.lastWinner = null; // 荒庄连庄
    this._log(
      room,
      `牌墙摸完，荒庄` +
        (tingSeats.length ? `，听牌者：${tingSeats.map((s) => this._pName(room, s)).join('、')}` : '')
    );
    this._broadcastGameState(room);
    this._sendSettlement(room);
    this._broadcastRoomState(room);
    this._endRound(room);
  }

  _endRound(room) {
    const g = room.game;
    if (g) g.stage = 'over';
    for (const [k, t] of room.timers) clearTimeout(t);
    room.timers.clear();
    const total = room.settings.totalRounds;
    if (total > 0 && room.roundNo >= total) {
      room.state = 'settled';
      this._log(room, `已打完 ${total} 局，房间进入结算（房主可「再来一轮」或解散）`);
      this._broadcastRoomState(room);
      this._broadcastLobby();
    } else {
      setTimeout(() => {
        if (room.state === 'playing' && this.rooms.get(room.id) === room) {
          this._dealRound(room);
        }
      }, 1500);
    }
  }

  // ============ 玩家操作（全部服务端校验） ============

  _playTile(p, msg) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '听口状态由系统自动摸打，不能出牌');
    if (g.stage !== 'draw') return this._err(p, '当前不能出牌');
    if (g.turn !== p.seat) return this._err(p, '不是您的回合');
    const tile = String((msg && msg.tile) || '');
    if (!rules.getTileTypes(room.settings.tileSet).includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');

    hand.splice(idx, 1);
    g.discards[p.seat].push(tile);
    g.lastDiscard = { tile, seat: p.seat };
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 打出 ${rules.tileName(tile)}`);
    this._afterDiscard(room, p.seat);
  }

  /** 报听（听口）：摸牌后存在可打的听牌牌型时，打出指定牌并锁定手牌 */
  _ting(p, msg) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'draw') return this._err(p, '当前不能报听');
    if (g.turn !== p.seat) return this._err(p, '不是您的回合');
    if (g.drawnTile === null) return this._err(p, '未摸牌不能报听');
    if (!room.settings.allowTing) return this._err(p, '房间未开启听口玩法');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '您已经报听');
    const tile = String((msg && msg.tile) || '');
    if (!rules.getTileTypes(room.settings.tileSet).includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');
    const rest = hand.slice();
    rest.splice(idx, 1);
    if (rules.isTing(rest, room.settings.tileSet).length === 0) return this._err(p, '当前手牌不能报听');

    hand.splice(idx, 1);
    g.discards[p.seat].push(tile);
    g.lastDiscard = { tile, seat: p.seat };
    g.tingSeats.push(p.seat);
    g.drawnTile = null;
    g.lastAction = null;
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 报听，打出 ${rules.tileName(tile)}（听口）`);
    this._afterDiscard(room, p.seat);
  }

  _peng(p) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'response' || !g.pending) return this._err(p, '当前没有可响应的操作');
    const r = g.pending.responders.find((x) => x.seat === p.seat);
    if (!r) return this._err(p, '您没有可响应的操作');
    if (r.choice !== null) return this._err(p, '您已响应过');
    if (!r.canPeng) return this._err(p, '不能碰');
    r.choice = 'peng';
    this._clearTimer(room, 'resp:' + p.seat);
    this._log(room, `${p.name} 选择碰`);
    this._tryResolvePending(room, g, g.pending);
  }

  _gang(p, msg) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '听口状态不能杠');

    // 响应阶段：明杠（别人打出的牌）
    if (g.stage === 'response' && g.pending) {
      const r = g.pending.responders.find((x) => x.seat === p.seat);
      if (!r) return this._err(p, '您没有可响应的操作');
      if (r.choice !== null) return this._err(p, '您已响应过');
      if (!r.canGang) return this._err(p, '不能杠');
      r.choice = 'gang';
      this._clearTimer(room, 'resp:' + p.seat);
      this._log(room, `${p.name} 选择杠`);
      this._tryResolvePending(room, g, g.pending);
      return;
    }

    // 行动阶段：暗杠 / 补杠（自己回合）
    if (g.stage === 'draw' && g.turn === p.seat) {
      if (g.drawnTile === null) return this._err(p, '当前不能杠');
      const tile = String((msg && msg.tile) || '');
      if (!rules.getTileTypes(room.settings.tileSet).includes(tile)) return this._err(p, '非法的牌');
      const gangType = msg && msg.gangType === 'bugang' ? 'bugang' : 'angang';
      if (gangType === 'angang') {
        if (!rules.canAnGang(g.hands[p.seat], tile)) return this._err(p, '不能暗杠');
        this._doAnGang(room, p.seat, tile);
      } else {
        if (!rules.canBuGang(g.hands[p.seat], g.melds[p.seat], tile)) return this._err(p, '不能补杠');
        this._doBuGang(room, p.seat, tile);
      }
      return;
    }
    return this._err(p, '当前不能杠');
  }

  _hu(p) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');

    // 响应阶段：点炮 / 抢杠胡
    if (g.stage === 'response' && g.pending) {
      if (g.tingSeats.includes(p.seat)) return this._err(p, '听口状态只能自摸胡');
      const r = g.pending.responders.find((x) => x.seat === p.seat);
      if (!r) return this._err(p, '您没有可响应的操作');
      if (r.choice !== null) return this._err(p, '您已响应过');
      if (!r.canHu) return this._err(p, '不能胡');
      r.choice = 'hu';
      this._clearTimer(room, 'resp:' + p.seat);
      this._log(room, `${p.name} 胡牌`);
      this._tryResolvePending(room, g, g.pending);
      return;
    }

    // 行动阶段：自摸
    if (g.stage === 'draw' && g.turn === p.seat && g.drawnTile !== null) {
      if (!rules.checkHu(g.hands[p.seat])) return this._err(p, '手牌不构成胡牌');
      this._settleHu(room, p.seat, {
        winType: 'zimo',
        tile: g.drawnTile,
      });
      this._endRound(room);
      return;
    }
    return this._err(p, '当前不能胡');
  }

  _pass(p) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'response' || !g.pending) return this._err(p, '当前没有可响应的操作');
    const r = g.pending.responders.find((x) => x.seat === p.seat);
    if (!r) return this._err(p, '您没有可响应的操作');
    if (r.choice !== null) return this._err(p, '您已响应过');
    r.choice = 'pass';
    this._clearTimer(room, 'resp:' + p.seat);
    this._log(room, `${p.name} 选择过`);
    this._tryResolvePending(room, g, g.pending);
  }

  _chat(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const text = String((msg && msg.text) || '').trim().slice(0, 200);
    if (!text) return;
    room.chat.push({ from: p.name, text, time: nowTime() });
    if (room.chat.length > MAX_CHAT) room.chat.shift();
    this._broadcast(room, { type: 'chat', chat: room.chat.slice(-MAX_CHAT) });
  }

  // ============ AI 自动行动 ============

  _shouldAutoAct(room, seat) {
    const pl = room.players[seat];
    return !!pl && (pl.isAI || pl.hosted || !pl.connected);
  }

  _markAutoActing(p) {
    // AI 代打中的动作：不恢复真人控制
    void p;
  }

  _restoreControl(p) {
    if (p && p.hosted && !p.isAI) p.hosted = false;
  }

  _scheduleAutoAct(room, seat) {
    const pl = room.players[seat];
    if (!pl) return;
    pl._auto = (pl._auto || 0) + 1;
    setTimeout(() => {
      if (!room.players[seat]) return;
      if (room.state !== 'playing' || !room.game) {
        pl._auto = Math.max(0, (pl._auto || 0) - 1);
        return;
      }
      const g = room.game;
      try {
        if (g.stage === 'draw' && g.turn === seat) {
          const decision = ai.decideDrawAction(g, room, seat);
          if (decision.type === 'hu') this._hu(pl, {});
          else if (decision.type === 'ting') this._ting(pl, { tile: decision.tile });
          else if (decision.type === 'gang') this._gang(pl, { tile: decision.tile, gangType: decision.gangType });
          else this._playTile(pl, { tile: decision.tile });
        } else if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === seat);
          if (r && r.choice === null) {
            const choice = ai.decideResponse(g, room, seat, r);
            if (choice === 'hu') this._hu(pl, {});
            else if (choice === 'gang') this._gang(pl, {});
            else if (choice === 'peng') this._peng(pl);
            else this._pass(pl);
          }
        }
      } catch (e) {
        console.error('[game] AI action error:', e);
      }
      // 动作执行完毕（动作期间 _auto>0 不会恢复真人控制），再递减
      pl._auto = Math.max(0, (pl._auto || 0) - 1);
    }, 80);
  }

  // ============ 构建视图 / 消息 ============

  _buildRoomView(room) {
    return {
      id: room.id,
      state: room.state,
      roundNo: room.roundNo,
      settings: room.settings,
      ownerId: room.ownerId,
      players: room.players.map((pl, seat) =>
        pl
          ? {
              seat,
              id: pl.id,
              name: pl.name,
              isAI: pl.isAI,
              connected: pl.connected,
              hosted: pl.hosted,
              score: pl.score,
              roundScore: pl.roundScore,
            }
          : null
      ),
      logs: room.logs.slice(-MAX_LOGS),
      chat: room.chat.slice(-MAX_CHAT),
    };
  }

  _buildGameView(room, viewerSeat) {
    const g = room.game;
    const players = [];
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (!pl) {
        players.push(null);
        continue;
      }
      const isSelf = s === viewerSeat;
      players.push({
        seat: s,
        name: pl.name,
        isAI: pl.isAI,
        connected: pl.connected,
        hosted: pl.hosted,
        score: pl.score,
        roundScore: pl.roundScore,
        hand: isSelf ? rules.sortTiles(g.hands[s]) : null,
        handCount: g.hands[s].length,
        melds: g.melds[s],
        discards: g.discards[s],
        isDealer: s === g.dealer,
        ting: g.tingSeats.includes(s),
      });
    }
    const isDrawTurn = g.stage === 'draw' && g.turn === viewerSeat;
    const view = {
      roundNo: g.roundNo,
      dealer: g.dealer,
      turn: g.turn,
      stage: g.stage,
      wallCount: g.wall.length - g.wallPos,
      lastDiscard: g.lastDiscard,
      drawnTile: isDrawTurn && g.drawnTile !== null ? g.drawnTile : null,
      yourSeat: viewerSeat,
      isDrawTurn,
      players,
      pending: g.pending
        ? {
            type: g.pending.type,
            tile: g.pending.tile,
            discarder: g.pending.discarder,
            responders: g.pending.responders.map((r) => ({
              seat: r.seat,
              canHu: r.canHu,
              canGang: r.canGang,
              canPeng: r.canPeng,
              choice: r.choice,
            })),
          }
        : null,
      winners: g.winners,
      settings: room.settings,
      logs: room.logs,
    };
    if (isDrawTurn && g.drawnTile !== null) {
      // 听牌提示：打出某张后听牌数
      const hints = {};
      const hand = g.hands[viewerSeat];
      for (const t of [...new Set(hand)]) {
        const rest = hand.slice();
        rest.splice(rest.indexOf(t), 1);
        const ting = rules.isTing(rest, room.settings.tileSet);
        if (ting.length > 0) hints[t] = ting.length;
      }
      view.tingHints = hints;
    }
    return view;
  }

  _buildDrawPrompt(room, seat) {
    const g = room.game;
    const hand = g.hands[seat];
    const actions = ['play'];
    const gangOptions = [];
    if (g.drawnTile !== null) {
      if (rules.checkHu(hand)) actions.push('hu');
      const cnt = rules.countTiles(hand);
      for (const [t, c] of cnt) {
        if (c === 4) gangOptions.push({ gangType: 'angang', tile: t });
      }
      for (const m of g.melds[seat]) {
        if (m.type === 'peng' && cnt.get(m.tile) >= 1) {
          gangOptions.push({ gangType: 'bugang', tile: m.tile });
        }
      }
      if (gangOptions.length) actions.push('gang');
      if (room.settings.allowTing && !g.tingSeats.includes(seat) && rules.canDeclareTing(hand, room.settings.tileSet)) {
        actions.push('ting');
      }
    }
    return {
      type: 'draw',
      actions,
      gangOptions,
      canHu: actions.includes('hu'),
      canDeclareTing: actions.includes('ting'),
      timeoutMs: HUMAN_TIMEOUT_MS,
    };
  }

  _buildResponsePrompt(room, r) {
    const actions = [];
    if (r.canHu) actions.push('hu');
    if (r.canGang) actions.push('gang');
    if (r.canPeng) actions.push('peng');
    actions.push('pass');
    return {
      type: 'response',
      actions,
      canHu: r.canHu,
      canGang: r.canGang,
      canPeng: r.canPeng,
      tile: room.game.pending.tile,
      pendingType: room.game.pending.type,
      timeoutMs: RESPONSE_TIMEOUT_MS,
    };
  }

  _revealHands(room) {
    const g = room.game;
    return [0, 1, 2, 3].map((s) =>
      room.players[s]
        ? {
            seat: s,
            name: room.players[s].name,
            hand: rules.sortTiles(g.hands[s]),
            melds: g.melds[s],
            roundScore: room.players[s].roundScore,
          }
        : null
    );
  }

  // ============ 工具方法 ============

  _createPlayer(ws, name) {
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const p = {
      id,
      name,
      ws,
      roomId: null,
      seat: null,
      connected: true,
      hosted: false,
      isAI: false,
      score: 0,
      roundScore: 0,
      disconnectTimer: null,
      _auto: 0,
    };
    this.players.set(id, p);
    this.wsPlayers.set(ws, id);
    return p;
  }

  _sanitizeName(name) {
    if (typeof name !== 'string') return '';
    let n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    return n;
  }

  _validateSettings(s) {
    if (!s || typeof s !== 'object') return null;
    const baseScore = Number(s.baseScore);
    const fanLimit = Number(s.fanLimit);
    const totalRounds = Number(s.totalRounds);
    if (![1, 2, 5, 10].includes(baseScore)) return null;
    if (![0, 4, 8, 16].includes(fanLimit)) return null;
    if (![0, 4, 8, 12].includes(totalRounds)) return null;
    return {
      baseScore,
      allowDianpao: !!s.allowDianpao,
      fanLimit,
      totalRounds,
      aiFill: !!s.aiFill,
      allowTing: s.allowTing !== false,
      tileSet: s.tileSet === '136' ? '136' : '108',
    };
  }

  _seatPlayer(room, p) {
    const seat = room.players.findIndex((x) => x === null);
    if (seat < 0) return false;
    room.players[seat] = p;
    p.roomId = room.id;
    p.seat = seat;
    p.roundScore = 0;
    p.hosted = false;
    p._auto = 0;
    return true;
  }

  _unseatPlayer(room, p) {
    if (p.seat != null && room.players[p.seat] === p) room.players[p.seat] = null;
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
    p.roomId = null;
    p.seat = null;
  }

  _destroyRoom(room) {
    for (const pl of room.players) {
      if (pl) {
        pl.roomId = null;
        pl.seat = null;
        pl.hosted = false;
        if (pl.disconnectTimer) {
          clearTimeout(pl.disconnectTimer);
          pl.disconnectTimer = null;
        }
        this._send(pl, { type: 'room_state', room: null });
        this._sendLobbyState(pl);
      }
    }
    for (const t of room.timers.values()) clearTimeout(t);
    room.timers.clear();
    this.rooms.delete(room.id);
    this._broadcastLobby();
  }

  _setTimer(room, key, ms, fn) {
    this._clearTimer(room, key);
    room.timers.set(
      key,
      setTimeout(() => {
        room.timers.delete(key);
        fn();
      }, ms)
    );
  }

  _clearTimer(room, key) {
    const t = room.timers.get(key);
    if (t) {
      clearTimeout(t);
      room.timers.delete(key);
    }
  }

  _log(room, text) {
    if (!room) return;
    room.logs.push({ time: nowTime(), text });
    if (room.logs.length > MAX_LOGS) room.logs.shift();
  }

  _pName(room, seat) {
    const pl = room.players[seat];
    return pl ? pl.name : '空位';
  }

  _broadcastGameState(room) {
    if (!room.game) return;
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl && pl.ws) {
        this._send(pl, { type: 'game_state', game: this._buildGameView(room, s) });
      }
    }
  }

  _broadcastRoomState(room) {
    for (const pl of room.players) {
      if (pl && pl.ws) this._send(pl, { type: 'room_state', room: this._buildRoomView(room) });
    }
  }

  _broadcast(room, obj) {
    for (const pl of room.players) {
      if (pl && pl.ws) this._send(pl, obj);
    }
  }

  _prompt(room, seat, prompt) {
    const pl = room.players[seat];
    if (pl && pl.ws) this._send(pl, { type: 'action_prompt', prompt });
  }

  _sendSettlement(room, targetPlayer) {
    const g = room.game;
    if (!g || !g.winners) return;
    const msg = {
      type: 'settlement',
      result: g.winners,
      roundNo: g.roundNo,
      settings: room.settings,
    };
    if (targetPlayer) this._send(targetPlayer, msg);
    else this._broadcast(room, msg);
  }

  _sendLobbyState(p) {
    const rooms = [...this.rooms.values()].map((r) => ({
      id: r.id,
      state: r.state,
      settings: r.settings,
      playerCount: r.players.filter(Boolean).length,
    }));
    this._send(p, { type: 'lobby_state', rooms });
  }

  _broadcastLobby() {
    for (const p of this.players.values()) {
      if (p.ws && p.connected && !p.roomId) this._sendLobbyState(p);
    }
  }

  _send(p, obj) {
    if (p && p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] send error:', e);
      }
    }
  }

  _sendWs(ws, obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] sendWs error:', e);
      }
    }
  }

  _err(p, message) {
    this._send(p, { type: 'error', message });
    return null;
  }
}

module.exports = { GameServer };
