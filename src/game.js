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
const HEARTBEAT_INTERVAL_MS = 30000; // 心跳 ping 间隔
const HEARTBEAT_MAX_MISS = 3; // 连续 3 次未收到 pong（约 90s）判定死连接
const OWNER_OFFLINE_MS = 60000; // 房主离线超时：AI 托管打完本局，本局结束后自动解散房间
const HUMAN_TIMEOUT_MS = 30000; // 真人行动超时（自动托管）
const RESPONSE_TIMEOUT_MS = 20000; // 响应窗口
const SETTLE_TIMEOUT_MS = 60000; // 结算确认超时：在线真人 60 秒未点「确定」自动确认
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
    this._startHeartbeat(ws);
  }

  // ---------- 心跳保活（ping/pong） ----------
  _startHeartbeat(ws) {
    if (!ws || typeof ws.ping !== 'function' || ws._heartbeatTimer) return;
    ws._pongMiss = 0;
    // ws 库收到 pong 帧自动触发 'pong' 事件（客户端浏览器/ws 库均自动回 pong，无需改协议）
    ws.on('pong', () => { ws._pongMiss = 0; });
    ws._heartbeatTimer = setInterval(() => this._heartbeatTick(ws), HEARTBEAT_INTERVAL_MS);
  }

  // 每个心跳周期：累计 miss，超过阈值判定半开/死连接
  _heartbeatTick(ws) {
    if (!ws || ws.readyState !== 1) return;
    ws._pongMiss = (ws._pongMiss || 0) + 1;
    if (ws._pongMiss > HEARTBEAT_MAX_MISS) {
      // 连续超过阈值未收到 pong：强制断开，触发 close → _onWsClose 走既有断线重连流程
      try { ws.terminate(); } catch (e) { console.error('[game] heartbeat terminate error:', e); }
      return;
    }
    try { ws.ping(); } catch (e) { console.error('[game] heartbeat ping error:', e); }
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
        case 'koupoint': return this._koupoint(p, msg);
        case 'peng': return this._peng(p);
        case 'gang': return this._gang(p, msg);
        case 'hu': return this._hu(p);
        case 'pass': return this._pass(p);
        case 'cancel_hosted': return this._cancelHosted(p);
        case 'settle_confirm': return this._settleConfirm(p);
        case 'chat': return this._chat(p, msg);
        case 'voice_signal': return this._voiceSignal(p, msg);
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
      // 房主重连：取消离线超时解散定时器（已触发 pendingDisband 的不回退）
      if (p.id === room.ownerId) {
        this._clearTimer(room, 'owner:offline');
        room.ownerOfflineSince = null;
      }
      this._log(room, `${p.name} 重新连接`);
      this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
      if (room.state === 'playing' && room.game) {
        this._send(p, { type: 'game_state', game: this._buildGameView(room, p.seat) });
        // 重连补发 action_prompt：若正好轮到该玩家出牌，或该玩家尚有未决定的碰/杠/胡响应权，
        // 否则前端 prompt 为空，手牌/操作按钮不可点，会卡住整局
        const g = room.game;
        if (g.stage === 'draw' && g.turn === p.seat) {
          this._send(p, { type: 'action_prompt', prompt: this._buildDrawPrompt(room, p.seat) });
        } else if (g.stage === 'response' && g.pending) {
          const r = g.pending.responders.find((x) => x.seat === p.seat);
          if (r && r.choice === null) {
            this._send(p, { type: 'action_prompt', prompt: this._buildResponsePrompt(room, r) });
          }
        }
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
    // 连接关闭即清理心跳定时器，避免泄漏
    if (ws._heartbeatTimer) {
      clearInterval(ws._heartbeatTimer);
      ws._heartbeatTimer = null;
    }
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
        if (g.stage === 'koupoint' && g.kouPoints[p.seat] == null) {
          // 扣点阶段断线：立即自动补扣点，避免四座填不满卡在扣点阶段无法开局
          this._autoFillKoupoint(room, p.seat);
        }
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
      // 结算确认阶段掉线：立即自动确认本局结算，避免全员等待该座位
      if (room.settleConfirms && !room.settleConfirms[p.seat]) {
        this._clearTimer(room, 'settle:' + p.seat);
        room.settleConfirms[p.seat] = true;
        this._log(room, `${p.name} 断线，自动确认本局结算`);
        this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
        this._tryStartNextRound(room);
      }
      // 房主断线：非 waiting 状态启动 60 秒超时定时器；超时后牌局进行中则 AI 托管打完本局自动解散，牌局未进行（结算确认/终局）则转让房主或解散
      if (p.id === room.ownerId && room.state !== 'waiting' && !room.pendingDisband) {
        room.ownerOfflineSince = Date.now();
        this._setTimer(room, 'owner:offline', OWNER_OFFLINE_MS, () => this._handleOwnerOfflineTimeout(room));
      }
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game) this._broadcastGameState(room);
    }
    if (!p.disconnectTimer) {
      p.disconnectTimer = setTimeout(() => {
        try {
          this._handleDisconnectTimeout(p);
        } catch (e) {
          console.error('[game] disconnect timer error:', e);
        }
      }, RECONNECT_MS);
    }
  }

  _handleDisconnectTimeout(p) {
    // 超时已触发：无论是否重连都置空，便于下次断线重新计时；同时作为「已超时」标记供清理判断
    p.disconnectTimer = null;
    if (p.connected) return;
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) {
      this.players.delete(p.id);
      return;
    }
    if (room.state === 'waiting') {
      this._log(room, `${p.name} 超时未重连，已离开房间`);
      if (p.id === room.ownerId) {
        // AI 不能成为房主：仅从其他在线真人中转让，无真人则解散房间
        const others = room.players.filter(Boolean).filter((x) => x.id !== p.id && !x.isAI);
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
      // 结算确认阶段超时未重连：确保该座位已自动确认（掉线时通常已即时确认，此处幂等兜底）
      if (room.settleConfirms && !room.settleConfirms[p.seat]) {
        this._clearTimer(room, 'settle:' + p.seat);
        room.settleConfirms[p.seat] = true;
        this._log(room, `${p.name} 超时未重连，自动确认本局结算`);
        this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
        this._tryStartNextRound(room);
      }
      this._broadcastRoomState(room);
      if (room.state === 'playing' && room.game && this._shouldAutoAct(room, p.seat)) {
        this._scheduleAutoAct(room, p.seat);
      }
    }
  }

  /** 房主离线超过 60 秒：牌局进行中则 AI 托管打完本局、本局结束自动解散；牌局未进行（结算确认/终局）则转让房主给在线真人，无真人则解散 */
  _handleOwnerOfflineTimeout(room) {
    // 回调已触发：无论是否重连都清理定时器，防止重入/重复触发
    this._clearTimer(room, 'owner:offline');
    const owner = room.players.find((pl) => pl && pl.id === room.ownerId);
    if (owner && owner.connected) {
      // 已重连：取消解散
      room.ownerOfflineSince = null;
      return;
    }
    // 无任何在线真人（含房主）：房间已无意义，直接解散
    if (!room.players.some((pl) => pl && !pl.isAI && pl.connected)) {
      this._destroyRoom(room);
      return;
    }
    // 牌局进行中（未到结算）：房主座位 AI 托管打完本局，本局结束后自动解散
    if (room.state === 'playing' && room.game && room.game.stage !== 'over') {
      room.pendingDisband = true;
      this._log(room, '房主离线超过 60 秒，本局结束后将解散房间');
      this._broadcast(room, { type: 'room_notice', text: '房主离线超过60秒，本局结束后将解散房间' });
      this._broadcastRoomState(room);
      // 确保房主座位由 AI 托管继续打本局（断线时已托管，此处兜底）
      const ownerSeat = owner ? room.players.indexOf(owner) : -1;
      if (ownerSeat >= 0 && this._shouldAutoAct(room, ownerSeat)) {
        this._scheduleAutoAct(room, ownerSeat);
      }
      return;
    }
    // 牌局未进行（结算确认中 / 终局 settled）：房主不在则转让给其他在线真人，无真人则解散
    const others = room.players.filter(Boolean).filter((x) => x.id !== room.ownerId && !x.isAI && x.connected);
    if (others.length === 0) {
      this._destroyRoom(room);
      return;
    }
    const newOwner = others[0];
    room.ownerId = newOwner.id;
    room.ownerOfflineSince = null;
    this._log(room, `房主 ${owner ? owner.name : '（离线）'} 离线超时，${newOwner.name} 成为新房主`);
    this._broadcast(room, { type: 'room_notice', text: `房主离线超时，${newOwner.name} 成为新房主` });
    this._broadcastRoomState(room);
    this._broadcastLobby();
  }

  // ============ 房间 ============

  _createRoom(p, msg) {
    if (p.roomId) return this._err(p, '您已在房间中，请先退出');
    if (this.rooms.size >= MAX_ROOMS) return this._err(p, '房间数量已达上限');
    const settings = this._validateSettings(msg && msg.settings);
    if (!settings) return this._err(p, '房间设置不合法（总局数取值错误）');

    let id;
    do {
      id = String(Math.floor(1000 + Math.random() * 9000));
    } while (this.rooms.has(id));

    const room = {
      id,
      settings,
      ownerId: p.id,
      ownerName: p.name, // 创建者名称（房主转让/离开后保持原创建者）
      ownerOfflineSince: null, // 房主离线起始时间；超 60 秒后 AI 托管并在本局结束后解散
      pendingDisband: false, // 房主离线超时标记：本局结束后自动解散房间
      state: 'waiting',
      roundNo: 0,
      players: [null, null, null, null],
      game: null,
      dealer: null,
      lastWinner: null,
      settleConfirms: null, // 本局结算确认状态：[seat] -> bool；null 表示不在确认阶段
      logs: [],
      chat: [],
      timers: new Map(),
      autoSeq: 0, // AI 自动行动定时器唯一 key 递增序号
      nextAiNo: 1,
    };
    this.rooms.set(id, room);
    this._seatPlayer(room, p);
    this._log(room, `${p.name} 创建了房间 ${id}`);
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
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
    this._send(p, { type: 'room_state', room: this._buildRoomView(room, p.seat) });
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
      // AI 不能成为房主：仅从其他真人中转让，无真人则解散房间
      const others = room.players.filter(Boolean).filter((x) => x.id !== p.id && !x.isAI);
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
    const wall = rules.shuffle(rules.createTiles());
    const g = (room.game = {
      roundNo: room.roundNo,
      wall,
      wallPos: 0,
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      kouTiles: [[], [], [], []], // 136 报听时倒扣上架的牌（只存牌值，渲染为背面）
      kouPoints: [null, null, null, null], // 136 暗扣点数 1-4（结算公开）
      gangLogs: [], // 本局杠分明细（136 模式）
      turn: -1,
      stage: 'draw',
      drawnTile: null,
      newTiles: [null, null, null, null], // 每位玩家当前“新摸到”的牌（仅自己视角可见，打出/碰/杠/报听后清除）
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
    // 庄家：上局胡牌者坐庄（谁胡谁坐庄）；流局按设置流转（keep=连庄 / next=下家接庄，默认下家接庄）；首局随机
    if (room.lastWinner != null && room.players[room.lastWinner]) {
      room.dealer = room.lastWinner;
    } else if (room.dealer == null || !room.players[room.dealer]) {
      room.dealer = Math.floor(Math.random() * 4);
    } else if (room.settings.dealerFlow !== 'keep') {
      room.dealer = (room.dealer + 1) % 4; // 流局下家接庄
    }
    // dealerFlow === 'keep' 时：流局连庄，room.dealer 保持不变
    g.dealer = room.dealer;
    for (const pl of room.players) if (pl) pl.roundScore = 0;
    room.state = 'playing';
    this._log(room, `第 ${room.roundNo} 局开始，${this._pName(room, g.dealer)} 坐庄`);

    // 开局扣点（默认开启）：每人扣 1-4 点（AI 随机），全部选完后庄家摸第 14 张；关闭时跳过扣点，倍数固定 ×1
    if (room.settings.enableKoupoint === false) {
      g.kouPoints = [1, 1, 1, 1]; // 关闭：不乘扣点
      this._broadcastRoomState(room);
      this._broadcastGameState(room);
      this._drawTile(room, g.dealer);
      return;
    }
    g.stage = 'koupoint';
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (!pl) continue;
      if (pl.isAI || pl.hosted || !pl.connected) {
        // AI / 托管 / 断线真人：自动随机补 1-4 扣点，保证不卡扣点阶段
        g.kouPoints[s] = 1 + Math.floor(Math.random() * 4);
        this._log(room, `${this._pName(room, s)} 自动暗扣（${g.kouPoints[s]} 点）`);
      } else {
        // 在线未托管真人：等待选择；超时未选则自动补
        this._setTimer(room, 'koupoint:' + s, HUMAN_TIMEOUT_MS, () => {
          this._autoFillKoupoint(room, s);
        });
      }
    }
    this._broadcastRoomState(room);
    this._broadcastGameState(room);
    this._promptKoupoint(room);
    if (g.kouPoints.every((x) => x != null)) this._tryStartAfterKouPoint(room);
    return;
  }

  /** 自动为未选扣点座位随机补 1-4 点（AI/托管/断线/超时），确保四座填满正常开局 */
  _autoFillKoupoint(room, seat) {
    const g = room && room.game;
    if (!room || !g || room.state !== 'playing' || g.stage !== 'koupoint') return;
    if (g.kouPoints[seat] != null) return;
    g.kouPoints[seat] = 1 + Math.floor(Math.random() * 4);
    this._log(room, `${this._pName(room, seat)} 未选择扣点，系统自动暗扣（${g.kouPoints[seat]} 点）`);
    const pl = room.players[seat];
    if (pl && !pl.isAI && !pl.hosted) {
      // 在线真人超时未确认：进入托管，由 AI 代打后续出牌
      pl.hosted = true;
      this._log(room, `${this._pName(room, seat)} 扣点阶段未确认，已由 AI 托管`);
      this._broadcastRoomState(room);
    }
    this._broadcastGameState(room);
    if (g.kouPoints.every((x) => x != null)) this._tryStartAfterKouPoint(room);
  }

  /** 136 扣点阶段：通知未选择扣点的真人玩家 */
  _promptKoupoint(room) {
    const g = room.game;
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl && !pl.isAI && pl.connected && g.kouPoints[s] == null) {
        this._send(pl, { type: 'action_prompt', prompt: { type: 'koupoint' } });
      }
    }
  }

  /** 136 扣点选择 */
  _koupoint(p, msg) {
    const room = this.rooms.get(p.roomId);
    const g = room && room.game;
    if (!room || !g || room.state !== 'playing' || g.stage !== 'koupoint') {
      return this._err(p, '当前不在扣点阶段');
    }
    const points = Number(msg && msg.points);
    if (![1, 2, 3, 4].includes(points)) return this._err(p, '扣点必须为 1-4 点');
    if (g.kouPoints[p.seat] != null) return this._err(p, '本局已选择过扣点');
    g.kouPoints[p.seat] = points;
    this._log(room, `${this._pName(room, p.seat)} 已暗扣（${points} 点）`);
    this._broadcastGameState(room);
    if (g.kouPoints.every((x) => x != null)) this._tryStartAfterKouPoint(room);
  }

  /** 扣点全部选择完成后，庄家摸第 14 张正式开始 */
  _tryStartAfterKouPoint(room) {
    const g = room.game;
    if (!g || g.stage !== 'koupoint') return;
    if (!g.kouPoints.every((x) => x != null)) return;
    this._drawTile(room, g.dealer);
  }

  _drawTile(room, seat) {
    const g = room.game;
    // 牌墙剩 6 墩（12 张）直接流局
    if (g.wall.length - g.wallPos <= 12) {
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
    // 报听玩家摸牌即打（或自摸），手牌锁死，不标“新牌”；正常玩家记录新摸牌
    g.newTiles[seat] = g.tingSeats.includes(seat) ? null : tile;
    this._log(room, `${this._pName(room, seat)} 摸到 ${rules.tileName(tile)}`, seat, `${this._pName(room, seat)} 摸牌`);
    const cur = room.players[seat];
    if (cur && cur.ws) this._send(cur, { type: 'draw_notice', tile });
    // 听口玩家：摸牌即打（不能换牌、不能碰杠），系统自动打出刚摸的牌
    if (g.tingSeats.includes(seat)) {
      // 报听玩家：若摸牌构成自摸胡（且满足点数限制），进入行动阶段给胡/过；否则摸牌即打（锁死）
      if (rules.checkHu(g.hands[seat], g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(tile), 'zimo')) {
        this._afterTurnStart(room, seat);
        return;
      }
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
    g.newTiles[seat] = null; // 摸牌即打：新牌标志随出牌清除
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
    // 牌墙剩 6 墩（12 张）直接流局
    if (g.wall.length - g.wallPos <= 12) {
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
    // 报听玩家杠后补牌仍锁死摸打，不标“新牌”；正常玩家记录新摸牌
    g.newTiles[seat] = g.tingSeats.includes(seat) ? null : tile;
    this._log(room, `${this._pName(room, seat)} 杠后补到 ${rules.tileName(tile)}`);
    const cur = room.players[seat];
    if (cur && cur.ws) this._send(cur, { type: 'draw_notice', tile });
    // 报听玩家：杠后补牌手牌继续锁死；若构成自摸胡给胡/过，否则摸牌即打
    if (g.tingSeats.includes(seat)) {
      if (rules.checkHu(g.hands[seat], g.melds[seat])) {
        this._afterTurnStart(room, seat);
        return;
      }
      this._autoTingDiscard(room, seat, tile);
      return;
    }
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
      // 胡牌受点数限制（6 点及以上才可点炮胡）；仅报听玩家可胡/可杠，不能碰
      const canHu = g.tingSeats.includes(s) && rules.canHuWith(g.hands[s], tile, g.melds[s]) && rules.canHuByPoints(rules.tilePoints(tile), 'dianpao');
      // 报听玩家杠不能破坏听张：杠牌若在当前听口中则不允许明杠
      const canGang = g.tingSeats.includes(s)
        ? (rules.canGang(g.hands[s], tile) && !rules.isTing(g.hands[s], g.melds[s]).includes(tile))
        : rules.canGang(g.hands[s], tile);
      const canPeng = g.tingSeats.includes(s) ? false : rules.canPeng(g.hands[s], tile);
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
          // 仅自动过牌，不托管在线真人：响应窗口只给“过”的兜底，
          // 托管交由出牌阶段 HUMAN_TIMEOUT 处理，避免在线玩家被误判挂机
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
      // 不支持一炮多响：仅距离放炮（补杠）者最近的一家胡牌
      const pick = this._nearestSeat(huList.map((r) => r.seat), pending.discarder);
      this._settleHu(room, pick, {
        winType: pending.type === 'qianggang' ? 'qianggang' : 'dianpao',
        tile: pending.tile,
        discarder: pending.discarder,
        qiangGang: pending.type === 'qianggang',
      });
      this._endRound(room);
      return;
    }
    const gangList = pending.responders.filter((r) => r.choice === 'gang');
    if (gangList.length > 0) {
      const pick = this._nearestSeat(gangList.map((r) => r.seat), pending.discarder);
      this._doGangFromDiscard(room, pick, pending.tile, pending.discarder);
      return;
    }
    const pengList = pending.responders.filter((r) => r.choice === 'peng');
    if (pengList.length > 0) {
      const pick = this._nearestSeat(pengList.map((r) => r.seat), pending.discarder);
      this._doPeng(room, pick, pending.tile, pending.discarder);
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

  _doPeng(room, seat, tile, discarder) {
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
    // 从打出者弃牌区移除被碰的牌（打出者最近打出的牌位于数组末尾，从末尾向前找最后一张同值牌）
    if (discarder != null && g.discards[discarder]) {
      const arr = g.discards[discarder];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === tile) {
          arr.splice(i, 1);
          break;
        }
      }
    }
    g.melds[seat].push({ type: 'peng', tile, tiles: [tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'peng' };
    g.turn = seat;
    g.stage = 'draw';
    g.drawnTile = null; // 碰后只能出牌/报听（碰完即听可立即报听），不能胡/杠
    g.newTiles[seat] = null; // 碰后手牌变动，新牌标志清除
    this._log(room, `${this._pName(room, seat)} 碰了 ${rules.tileName(tile)}`);
    this._afterTurnStart(room, seat);
  }

  /** 136 模式杠分：明杠/补杠=该牌点数（字牌 10 点）、暗杠=点数×2，再乘以杠主本局开局扣点数；其余三家各付一份给杠主；杠时即时结算；抢杠胡成立时不结算（调用方在抢杠分支直接返回，不会进入本方法） */
  _settleGangScore(room, seat, tile, type) {
    const g = room.game;
    const points = rules.tilePoints(tile); // 数牌按面值、字牌 10 点
    const kou = g.kouPoints[seat] || 1; // 杠主本局开局扣点（开关关闭时恒为 1）
    const perSeat = (type === 'angang' ? points * 2 : points) * kou;
    const gain = perSeat * 3;
    for (let s = 0; s < 4; s++) {
      if (s === seat || !room.players[s]) continue;
      room.players[s].score -= perSeat;
      room.players[s].roundScore -= perSeat;
    }
    room.players[seat].score += gain;
    room.players[seat].roundScore += gain;
    g.gangLogs.push({ seat, tile, type, perSeat, points, kou });
    const typeName = type === 'angang' ? '暗杠' : type === 'bugang' ? '补杠' : '明杠';
    this._log(room, `${this._pName(room, seat)} ${typeName} ${rules.tileName(tile)}（${points}点×扣${kou}），每家 ${perSeat} 分`);
  }

  /** 杠分支付明细条目（统一支付明细表用）：明杠/补杠=牌点、暗杠=牌点×2，乘杠主扣点，其余三家各付一份给杠主 */
  _buildGangPayments(room) {
    const g = room.game;
    const pays = [];
    for (const lg of g.gangLogs) {
      const typeName = lg.type === 'angang' ? '暗杠' : lg.type === 'bugang' ? '补杠' : '明杠';
      const kouText = lg.kou != null && lg.kou > 1 ? '×扣' + lg.kou : '';
      const rows = [];
      for (let s = 0; s < 4; s++) {
        if (s === lg.seat) continue;
        rows.push({ seat: s, amount: -lg.perSeat, role: '杠分' });
      }
      pays.push({
        kind: 'gang',
        title: `${typeName} ${rules.tileName(lg.tile)}（${lg.points}点${kouText}）`,
        toSeat: lg.seat,
        toAmount: lg.perSeat * 3,
        rows,
      });
    }
    return pays;
  }

  _doGangFromDiscard(room, seat, tile, discarder) {
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
    // 从打出者弃牌区移除被明杠的牌（从末尾向前找最后一张同值牌）
    if (discarder != null && g.discards[discarder]) {
      const arr = g.discards[discarder];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === tile) {
          arr.splice(i, 1);
          break;
        }
      }
    }
    g.melds[seat].push({ type: 'gang', tile, tiles: [tile, tile, tile, tile] });
    g.lastDiscard = null;
    g.lastAction = { type: 'gang' };
    g.turn = seat;
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置）
    this._log(room, `${this._pName(room, seat)} 明杠了 ${rules.tileName(tile)}`);
    this._settleGangScore(room, seat, tile, 'ming');
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
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置）
    this._log(room, `${this._pName(room, seat)} 暗杠了 ${rules.tileName(tile)}`);
    this._settleGangScore(room, seat, tile, 'angang');
    this._drawAfterGang(room, seat);
  }

  _doBuGang(room, seat, tile) {
    const g = room.game;
    // 先检查抢杠胡
    const grabbers = [];
    for (let s = 0; s < 4; s++) {
      if (s === seat || !room.players[s]) continue;
      // 抢杠胡算点炮，受点数限制（6 点及以上才可胡）；仅报听玩家可抢杠；明牌区刻子计入已成型面子
      const canHu = g.tingSeats.includes(s) && rules.canHuWith(g.hands[s], tile, g.melds[s]) && rules.canHuByPoints(rules.tilePoints(tile), 'qianggang');
      if (canHu) grabbers.push(s);
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
    g.newTiles[seat] = null; // 杠后补牌前清除旧标志（补牌后重新设置；抢杠分支不动，牌仍在手）
    this._log(room, `${this._pName(room, seat)} 补杠了 ${rules.tileName(tile)}`);
    this._settleGangScore(room, seat, tile, 'bugang');
    this._drawAfterGang(room, seat);
  }

  _settleHu(room, winnerSeat, info) {
    const g = room.game;
    // 算番型时必须使用完整手牌：自摸时胡牌已在手牌；点炮/抢杠时 info.tile 是打出的胡牌，需并入
    const hand = g.hands[winnerSeat].slice();
    if (info.winType !== 'zimo') hand.push(info.tile);
    const gangShang = info.winType === 'zimo' && !!(g.lastAction && g.lastAction.type === 'gang');
    const winLabel =
      info.winType === 'zimo' ? '自摸' : info.winType === 'qianggang' ? '抢杠胡' : '点炮胡';

    // ===== 点数 × 牌型倍数 × 自己扣点；包胡一包三 =====
      const tilePoints = rules.tilePoints(info.tile);
      const multOpts = {
        qingyise: { enabled: room.settings.enableQingYiSe, mult: room.settings.qingYiSeMult },
        yitiaolong: { enabled: room.settings.enableYiTiaoLong, mult: room.settings.yiTiaoLongMult },
        shisanyao: { enabled: room.settings.enableShiSanYao, mult: room.settings.shiSanYaoMult },
      };
      const multCalc = rules.calcMultiplier136(
        hand,
        {
          winType: info.winType,
          gangShang,
          qiangGang: !!info.qiangGang,
          melds: g.melds[winnerSeat],
        },
        multOpts,
        true
      );
      const mult = multCalc.mult;
      const multNames = multCalc.names;
      const kp = g.kouPoints[winnerSeat] || 1; // 胡牌者自己的扣点
      const discarderTing = info.winType !== 'zimo' && g.tingSeats.includes(info.discarder);

      let score;
      const huPayments = [];
      if (info.winType === 'zimo') {
        // 自摸 = 点数 × 2 × 倍数 × 扣点，三家都给
        score = tilePoints * 2 * mult * kp;
        for (let s = 0; s < 4; s++) {
          if (s === winnerSeat || !room.players[s]) continue;
          room.players[s].score -= score;
          room.players[s].roundScore -= score;
          room.players[winnerSeat].score += score;
          room.players[winnerSeat].roundScore += score;
        }
        huPayments.push({
          kind: 'hu',
          title: `自摸 · 三家各付 ${score} 分`,
          toSeat: winnerSeat,
          toAmount: score * 3,
          rows: [0, 1, 2, 3].filter((s) => s !== winnerSeat).map((s) => ({ seat: s, amount: -score, role: '闲家' })),
        });
      } else if (discarderTing) {
        // 点炮且放炮者已报听：三家各出 1 份（放炮者与另两家闲家各付 score），胡牌者共收 3 份
        score = tilePoints * mult * kp;
        for (let s = 0; s < 4; s++) {
          if (s === winnerSeat || !room.players[s]) continue;
          room.players[s].score -= score;
          room.players[s].roundScore -= score;
          room.players[winnerSeat].score += score;
          room.players[winnerSeat].roundScore += score;
        }
        huPayments.push({
          kind: 'hu',
          title: `${winLabel}（放炮者已报听）· 三家各付 ${score} 分`,
          toSeat: winnerSeat,
          toAmount: score * 3,
          rows: [0, 1, 2, 3]
            .filter((s) => s !== winnerSeat)
            .map((s) => ({ seat: s, amount: -score, role: s === info.discarder ? '放炮者（已报听）' : '闲家' })),
        });
      } else {
        // 点炮且放炮者未报听：放炮者独赔 3 份点炮分（含原包胡情形），胡牌者共收 3 份
        score = tilePoints * mult * kp * 3;
        const loser = room.players[info.discarder];
        if (loser) {
          loser.score -= score;
          loser.roundScore -= score;
          room.players[winnerSeat].score += score;
          room.players[winnerSeat].roundScore += score;
        }
        huPayments.push({
          kind: 'hu',
          title: `${winLabel}（放炮者未报听）· 放炮者独赔 ${score} 分`,
          toSeat: winnerSeat,
          toAmount: score,
          rows: [{ seat: info.discarder, amount: -score, role: '放炮者（未报听，独赔3份）' }],
        });
      }

      g.winners = {
        type: 'hu',
        winnerSeat,
        winType: info.winType,
        mode136: true,
        tilePoints,
        mult,
        multNames,
        kouPoint: kp,
        kouPoints: g.kouPoints.slice(), // 结算公开全部玩家扣点
        discarderTing,
        score,
        tile: info.tile,
        discarder: info.winType === 'zimo' ? null : info.discarder,
        gangLogs: g.gangLogs.slice(),
        payments: [...huPayments, ...this._buildGangPayments(room)],
        hands: this._revealHandsWithWinTile(room, winnerSeat, info),
      };
      room.lastWinner = winnerSeat;
      const payLabel =
        info.winType === 'zimo'
          ? ''
          : discarderTing
            ? '（放炮者已报听，三家各出1份）'
            : '（放炮者未报听，独赔3份）';
      this._log(
        room,
        `${this._pName(room, winnerSeat)} ${winLabel} ${rules.tileName(info.tile)}（${tilePoints}点 × ${mult}倍 × 扣${kp}${payLabel} → ${score}分）`
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
      if (room.players[s] && rules.isTing(g.hands[s], g.melds[s]).length > 0) tingSeats.push(s);
    }
    const notTing = [];
    for (let s = 0; s < 4; s++) {
      if (room.players[s] && !tingSeats.includes(s)) notTing.push(s);
    }
    g.winners = {
      type: 'draw',
      tingSeats,
      notTing,
      mode136: true,
      kouPoints: g.kouPoints.slice(), // 结算公开扣点
      gangLogs: g.gangLogs.slice(), // 杠分照常结算（杠时已即时入账）
      payments: this._buildGangPayments(room), // 流局无胡牌支付，仅杠分明细
      hands: this._revealHands(room),
    };
    room.lastWinner = null; // 流局：庄家流转由 _dealRound 按 settings.dealerFlow 处理（连庄/下家接庄）
    this._log(
      room,
      '牌墙剩 6 墩，流局' +
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
    // 保留房主离线超时定时器：本局结束时不能误清，否则房主超时后本局结束自动解散将失效
    const ownerOfflineTimer = room.timers.get('owner:offline');
    for (const [k, t] of room.timers) if (k !== 'owner:offline') clearTimeout(t);
    room.timers.clear();
    if (ownerOfflineTimer) room.timers.set('owner:offline', ownerOfflineTimer);
    // 房主离线超时：本局结算已广播，直接解散房间，通知所有玩家回大厅
    if (room.pendingDisband) {
      this._log(room, '房主离线超时，本局结束，房间解散');
      this._broadcast(room, { type: 'room_notice', text: '房主离线超时，本局结束，房间已解散' });
      this._destroyRoom(room);
      return;
    }
    const total = room.settings.totalRounds;
    if (total > 0 && room.roundNo >= total) {
      room.state = 'settled';
      room.settleConfirms = null;
      this._log(room, `已打完 ${total} 局，房间进入结算（房主可「再来一轮」或解散）`);
      this._broadcastRoomState(room);
      this._broadcastLobby();
      return;
    }
    // 非最后一局：进入结算确认阶段，全员确认后才自动开始下一局
    room.settleConfirms = [false, false, false, false];
    for (let s = 0; s < 4; s++) {
      // AI / 托管 / 断线玩家自动确认；在线真人等待手动点击「确定」
      if (room.players[s] && this._shouldAutoAct(room, s)) room.settleConfirms[s] = true;
      // 在线真人：启动 60 秒确认超时定时器，超时未点「确定」则自动确认
      else if (room.players[s]) this._setTimer(room, 'settle:' + s, SETTLE_TIMEOUT_MS, () => this._handleSettleTimeout(room, s));
    }
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._broadcastRoomState(room);
    this._log(room, '本局结束，等待所有玩家确认「确定」后开始下一局');
    this._tryStartNextRound(room);
  }

  // ============ 结算确认 ============

  /** 在线真人 60 秒未点「确定」：自动确认本局结算 */
  _handleSettleTimeout(room, seat) {
    this._clearTimer(room, 'settle:' + seat); // 回调已触发，清理防重入
    if (!room.settleConfirms) return; // 已开局 / 终局 / 房间销毁
    if (room.settleConfirms[seat]) return; // 已确认（掉线自动确认等）幂等忽略
    const p = room.players[seat];
    if (!p) return;
    room.settleConfirms[seat] = true;
    this._log(room, `${p.name} 60 秒未确认，系统自动确认本局结算`);
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._tryStartNextRound(room);
  }

  _settleConfirm(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    if (!room.settleConfirms) return this._err(p, '当前没有需要确认的结算');
    if (room.players[p.seat] !== p) return this._err(p, '您不在本局座位中');
    if (room.settleConfirms[p.seat]) return; // 幂等：已确认直接忽略
    room.settleConfirms[p.seat] = true;
    this._clearTimer(room, 'settle:' + p.seat); // 手动确认后取消本人超时定时器
    this._log(room, `${p.name} 已确认本局结算`);
    this._broadcast(room, { type: 'settlement_confirm', confirms: room.settleConfirms.slice() });
    this._tryStartNextRound(room);
  }

  _tryStartNextRound(room) {
    if (!room.settleConfirms) return;
    if (!room.settleConfirms.every(Boolean)) return;
    room.settleConfirms = null;
    // 全员确认：清理所有结算确认超时定时器
    for (let s = 0; s < 4; s++) this._clearTimer(room, 'settle:' + s);
    this._log(room, '所有玩家已确认，开始下一局');
    this._dealRound(room);
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
    if (!rules.getTileTypes().includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');

    hand.splice(idx, 1);
    g.discards[p.seat].push(tile);
    g.lastDiscard = { tile, seat: p.seat };
    g.drawnTile = null;
    g.newTiles[p.seat] = null; // 新牌已打出，标志清除
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 打出 ${rules.tileName(tile)}`);
    this._afterDiscard(room, p.seat);
  }

  /** 报听（听口）：摸牌后（或碰后立即听牌）存在可打的听牌牌型时，打出指定牌并锁定手牌 */
  _ting(p, msg) {
    if (p._auto > 0) this._markAutoActing(p);
    else this._restoreControl(p);
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room) return this._err(p, '您不在房间中');
    const g = room.game;
    if (room.state !== 'playing' || !g) return this._err(p, '牌局未开始');
    if (g.stage !== 'draw') return this._err(p, '当前不能报听');
    if (g.turn !== p.seat) return this._err(p, '不是您的回合');
    // 碰后（未摸牌）也可报听：碰完即听立即识别，不待下一轮摸牌
    const justPeng = !!(g.lastAction && g.lastAction.type === 'peng');
    if (g.drawnTile === null && !justPeng) return this._err(p, '未摸牌不能报听');
    if (!room.settings.allowTing) return this._err(p, '房间未开启听口玩法');
    if (g.tingSeats.includes(p.seat)) return this._err(p, '您已经报听');
    const tile = String((msg && msg.tile) || '');
    if (!rules.getTileTypes().includes(tile)) return this._err(p, '非法的牌');
    const hand = g.hands[p.seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) return this._err(p, '手牌中没有这张牌');
    const rest = hand.slice();
    rest.splice(idx, 1);
    // 碰/杠刻子（明牌区）作为已成型面子参与听口计算
    const tingList = rules.isTing(rest, g.melds[p.seat]);
    if (tingList.length === 0) return this._err(p, '当前手牌不能报听');

    // 报听硬性条件：听牌中至少含一张 6 点及以上牌
    if (!tingList.some((x) => rules.tilePoints(x) >= 6)) {
      return this._err(p, '听牌中须至少含一张 6 点及以上牌（6/7/8/9/字牌）才能报听');
    }
    hand.splice(idx, 1);
    g.tingSeats.push(p.seat);
    g.kouTiles[p.seat] = tile; // 记录扣牌（报听状态标识，不再单独上架公示）
    g.discards[p.seat].push('back'); // 暗扣进废牌堆：渲染为牌背，不参与任何响应判定
    g.drawnTile = null;
    g.lastAction = null;
    g.lastDiscard = null; // 扣牌不进入响应判定，他人不能碰/胡
    g.newTiles[p.seat] = null; // 报听后手牌锁定，新牌标志清除
    this._clearTimer(room, 'draw:' + p.seat);
    this._log(room, `${this._pName(room, p.seat)} 报听，扣牌暗扣进废牌堆`);
    this._broadcastGameState(room);
    this._nextTurn(room, p.seat);
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
    // 报听玩家允许杠（杠后补牌手牌继续锁死）

    // 响应阶段：明杠（别人打出的牌）
    if (g.stage === 'response' && g.pending) {
      const r = g.pending.responders.find((x) => x.seat === p.seat);
      if (!r) return this._err(p, '您没有可响应的操作');
      if (r.choice !== null) return this._err(p, '您已响应过');
      if (!r.canGang) return this._err(p, '不能杠');
      // 双保险：报听玩家明杠听张（响应判定已过滤，此处防绕过）
      if (g.tingSeats.includes(p.seat) && rules.isTing(g.hands[p.seat], g.melds[p.seat]).includes(g.pending.tile)) {
        return this._err(p, '报听后不能杠听张，会破坏听口');
      }
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
      if (!rules.getTileTypes().includes(tile)) return this._err(p, '非法的牌');
      // 报听后杠不能破坏听张：去掉刚摸的牌后，杠牌若仍在听口中则拒绝
      if (g.tingSeats.includes(p.seat)) {
        const base = g.hands[p.seat].slice();
        const di = base.lastIndexOf(g.drawnTile);
        if (di >= 0) base.splice(di, 1);
        if (rules.isTing(base, g.melds[p.seat]).includes(tile)) {
          return this._err(p, '报听后不能杠听张，会破坏听口');
        }
      }
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
      // 报听玩家可点炮/抢杠（胡牌点数限制已在响应判定中处理）
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
      if (!rules.checkHu(g.hands[p.seat], g.melds[p.seat])) return this._err(p, '手牌不构成胡牌');
      // 自摸胡点数限制：1/2 点不能胡
      if (!rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo')) {
        return this._err(p, '胡牌点数限制：1/2 点不能胡（自摸也不允许）');
      }
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
    // 报听玩家自摸可选择不胡：系统自动打出刚摸的牌（手牌继续锁死）
    if (g.stage === 'draw' && g.turn === p.seat && g.drawnTile !== null) {
      if (g.tingSeats.includes(p.seat)) {
        this._autoTingDiscard(room, p.seat, g.drawnTile);
        return;
      }
      return this._err(p, '当前不能过牌');
    }
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

  // 实时语音对讲信令转发（WebRTC mesh：信令走 WS，媒体走 P2P）
  // 校验：发起者在房间内；目标为同房间真人玩家（非 AI、有可用 ws）；sig 序列化 ≤ 64KB
  _voiceSignal(p, msg) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room || !room.players || room.players[p.seat] !== p) return; // 不在房间，静默忽略
    const targetId = String((msg && msg.target) || '');
    const target = this.players.get(targetId);
    // 目标必须是同房间真人玩家（非 AI、有可用 ws），否则静默忽略
    if (!target || target.isAI || !target.ws || target.ws.readyState !== 1) return;
    if (target.roomId !== room.id || !room.players || room.players[target.seat] !== target) return;
    const sig = (msg && msg.sig) || null;
    if (!sig || typeof sig !== 'object') return;
    let sigJson;
    try {
      sigJson = JSON.stringify(sig);
    } catch {
      return; // 序列化失败（循环引用等）直接忽略
    }
    if (sigJson.length > 64 * 1024) return; // 超限拒绝，防滥用
    this._send(target, {
      type: 'voice_signal',
      from: p.id,
      fromName: p.name,
      fromSeat: p.seat,
      sig,
    });
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

  /** 玩家主动取消托管，恢复真人控制 */
  _cancelHosted(p) {
    const room = p.roomId ? this.rooms.get(p.roomId) : null;
    if (!room || !room.players || room.players[p.seat] !== p) {
      return this._err(p, '您不在房间中');
    }
    if (p.isAI) return this._err(p, 'AI 玩家无法取消托管');
    if (!p.connected) return this._err(p, '您当前不在线，无法取消托管');
    if (!p.hosted) return this._err(p, '您当前未被托管');
    p.hosted = false;
    // 若正好轮到该玩家且有 AI 待执行动作：清计数，后续不再调度新 AI 动作
    if (room.state === 'playing' && room.game && room.game.turn === p.seat) {
      p._auto = 0;
    }
    this._log(room, `${p.name} 已取消托管`);
    this._broadcastRoomState(room);
    if (room.state === 'playing' && room.game) this._broadcastGameState(room);
  }

  _scheduleAutoAct(room, seat) {
    const pl = room.players[seat];
    if (!pl) return;
    pl._auto = (pl._auto || 0) + 1;
    // 纳入 room.timers 统一跟踪：唯一 key（seat + 递增序号）支持同一座位并发多定时器，
    // 不使用 _setTimer（会 clear 旧 key），回调触发后自行删除本 key。
    const autoKey = 'auto:' + seat + ':' + (++room.autoSeq);
    room.timers.set(
      autoKey,
      setTimeout(() => {
        room.timers.delete(autoKey);
        try {
        if (!room.players[seat]) return;
        if (room.state !== 'playing' || !room.game) {
          pl._auto = Math.max(0, (pl._auto || 0) - 1);
          return;
        }
        const g = room.game;
        // 真人已接管（取消托管/重连）：跳过本次代打，避免与真人操作并发
        if (pl._auto <= 0 || !this._shouldAutoAct(room, seat)) {
          pl._auto = Math.max(0, (pl._auto || 0) - 1);
          return;
        }
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
        // 动作执行完毕（动作期间 _auto>0 不会恢复真人控制），再递减
        pl._auto = Math.max(0, (pl._auto || 0) - 1);
      } catch (e) {
        console.error('[game] AI action error:', e);
        // 异常也要递减计数，避免 _auto 泄漏导致后续不再代打
        pl._auto = Math.max(0, (pl._auto || 0) - 1);
      }
      }, 80)
    );
  }

  // ============ 构建视图 / 消息 ============

  _buildRoomView(room, viewerSeat) {
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
      settleConfirms: room.settleConfirms ? room.settleConfirms.slice() : null,
      logs: this._maskLogsForViewer(room.logs.slice(-MAX_LOGS), viewerSeat),
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
      // 新摸牌标志：仅下发本玩家自己的新摸牌（他人视角恒为 null）
      newTile: (g.newTiles && g.newTiles[viewerSeat]) || null,
      yourSeat: viewerSeat,
      isDrawTurn,
      // 扣点选择后全公开；报听扣牌上架暗牌脱敏（所有人只见背面，不含牌面）与杠分明细全公开
      kouPoints: g.kouPoints.slice(),
      kouTiles: g.kouTiles.map((t) => (t ? 'back' : null)),
      gangLogs: g.gangLogs.slice(),
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
      logs: this._maskLogsForViewer(room.logs, viewerSeat),
    };
    if (isDrawTurn && !g.tingSeats.includes(viewerSeat)) {
      // 听牌提示：打出某张后，听口剩余可胡张数（4 - 已见张数）
      // 性能优化：以 手牌牌型/自身明牌/已见牌 快照为 key 缓存，手牌未变化时直接复用，
      // 避免每次广播对整副牌型做 去重手牌×34牌型×checkHu 回溯重算（约 2000 次 checkHu）。
      if (!g.tingHintsCache) g.tingHintsCache = new Map();
      if (!g.tingCacheStats) g.tingCacheStats = { hit: 0, miss: 0 };
      const cacheKey = this._buildTingHintsKey(g, viewerSeat);
      const cached = g.tingHintsCache.get(cacheKey);
      if (cached !== undefined) {
        g.tingCacheStats.hit++;
        view.tingHints = { ...cached };
      } else {
        g.tingCacheStats.miss++;
        const hints = {};
        const hand = g.hands[viewerSeat];
        // 统计已见牌：自己手牌 + 各家弃牌(牌背不统计) + 明牌区(碰/杠) + 报听扣牌(自己视角可知)
        const seen = new Map();
        const addSeen = (t) => {
          if (t && t !== 'back') seen.set(t, (seen.get(t) || 0) + 1);
        };
        for (const t of hand) addSeen(t);
        for (const d of g.discards) for (const t of d) addSeen(t);
        for (const m of g.melds) for (const meld of m) for (const t of meld.tiles) addSeen(t);
        if (g.kouTiles[viewerSeat]) addSeen(g.kouTiles[viewerSeat]);
        for (const t of [...new Set(hand)]) {
          const rest = hand.slice();
          rest.splice(rest.indexOf(t), 1);
          const ting = rules.isTing(rest, g.melds[viewerSeat]);
          // 只提示可报听的选项：听口中须至少含一张 ≥6 点牌，与 canDeclareTing136 保持一致
          if (ting.length > 0 && ting.some((x) => rules.tilePoints(x) >= 6)) {
            hints[t] = ting.reduce((sum, x) => sum + Math.max(0, 4 - (seen.get(x) || 0)), 0);
          }
        }
        g.tingHintsCache.set(cacheKey, hints);
        view.tingHints = hints;
      }
    }
    return view;
  }

  // tingHints 缓存 key：覆盖所有影响听口结果的输入（手牌牌型、自身明牌结构、已见牌），
  // 摸牌/出牌/杠/报听等任何手牌或牌面变化都会改变 key，从而自动失效。
  _buildTingHintsKey(g, seat) {
    const parts = [];
    parts.push('h:' + rules.sortTiles(g.hands[seat]).join(','));
    parts.push('m:' + g.melds[seat].map((mm) => mm.type + mm.tile + mm.tiles.join('')).join(';'));
    const seen = [];
    for (const d of g.discards) seen.push(d.join(''));
    for (const ms of g.melds) for (const mm of ms) seen.push(mm.tiles.join(''));
    if (g.kouTiles[seat]) seen.push(g.kouTiles[seat]);
    parts.push('s:' + seen.join(';'));
    return parts.join('|');
  }

  _buildDrawPrompt(room, seat) {
    const g = room.game;
    const hand = g.hands[seat];
    const actions = ['play'];
    const gangOptions = [];
    // 碰后（未摸牌）也可报听：碰完即听立即识别，不待下一轮摸牌；碰后手牌结构不允许胡/杠，只给 play/ting
    const justPeng = !!(g.lastAction && g.lastAction.type === 'peng');
    if (justPeng) {
      if (room.settings.allowTing && !g.tingSeats.includes(seat)) {
        // 报听：碰后 11 张手牌存在某张可扣牌，打出后仍听牌且听口中含 ≥6 点牌；明牌区刻子计入
        if (rules.canDeclareTing136(hand, g.melds[seat])) {
          actions.push('ting');
        }
      }
      return {
        type: 'draw',
        actions,
        gangOptions,
        canHu: false,
        canDeclareTing: actions.includes('ting'),
        timeoutMs: HUMAN_TIMEOUT_MS,
      };
    }
    if (g.drawnTile !== null) {
      // 自摸胡受点数限制：1/2 点不能胡（自摸也不允许），3/4/5 点可自摸；明牌区刻子计入已成型面子；仅报听玩家可自摸胡
      const canSelfHu = g.tingSeats.includes(seat) && rules.checkHu(hand, g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo');
      if (canSelfHu) actions.push('hu');
      // 报听玩家：自摸可胡（满足点数限制），不胡则系统摸打（给“过”）；手牌锁死不换牌
      if (g.tingSeats.includes(seat)) {
        const canSelfHu = rules.checkHu(hand, g.melds[seat]) && rules.canHuByPoints(rules.tilePoints(g.drawnTile), 'zimo');
        return {
          type: 'draw',
          actions: canSelfHu ? ['hu', 'pass'] : ['pass'],
          gangOptions: [],
          canHu: canSelfHu,
          canDeclareTing: false,
          timeoutMs: HUMAN_TIMEOUT_MS,
        };
      }
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
      if (room.settings.allowTing && !g.tingSeats.includes(seat)) {
        // 报听：手牌（摸牌后 14 张）存在某张可扣牌，打出后仍听牌且听口中含 ≥6 点牌；明牌区刻子计入
        if (rules.canDeclareTing136(hand, g.melds[seat])) {
          actions.push('ting');
        }
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

  /**
   * 结算手牌展示：基于真实手牌（_revealHands），点炮/抢杠胡赢家补入胡的那张牌（14 张完整展示），自摸不补（胡牌已在手）。
   * 仅影响展示，g.hands 原始数据与 _settleHu 局部算番副本均不受影响。
   */
  _revealHandsWithWinTile(room, winnerSeat, info) {
    const revealed = this._revealHands(room);
    if (info.winType !== 'zimo') {
      const w = revealed.find((r) => r && r.seat === winnerSeat);
      if (w) w.hand = rules.sortTiles([...w.hand, info.tile]);
    }
    return revealed;
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
    const totalRounds = Number(s.totalRounds);
    if (![0, 4, 8, 12].includes(totalRounds)) return null;
    const qingYiSeMult = Number(s.qingYiSeMult) || 4;
    const yiTiaoLongMult = Number(s.yiTiaoLongMult) || 4;
    const shiSanYaoMult = Number(s.shiSanYaoMult) || 8;
    return {
      totalRounds,
      aiFill: !!s.aiFill,
      allowTing: true, // 报听为 136 必选核心规则
      enableQingYiSe: !!s.enableQingYiSe,
      enableYiTiaoLong: !!s.enableYiTiaoLong,
      enableShiSanYao: !!s.enableShiSanYao,
      qingYiSeMult,
      yiTiaoLongMult,
      shiSanYaoMult,
      dealerFlow: s.dealerFlow === 'keep' ? 'keep' : 'next', // 流局庄家：keep=连庄 / next=下家接庄（默认）
      enableKoupoint: s.enableKoupoint !== false, // 开局扣点开关（默认开启）
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
        // 掉线超时（disconnectTimer 已触发且未重连）的真人已无重连可能，可安全从全局移除
        const timedOut = !pl.isAI && !pl.connected && pl.disconnectTimer === null;
        pl.roomId = null;
        pl.seat = null;
        pl.hosted = false;
        if (pl.disconnectTimer) {
          clearTimeout(pl.disconnectTimer);
          pl.disconnectTimer = null;
        }
        // AI 与掉线超时玩家无重连可能：从全局 players 移除，避免内存泄漏；在线/短暂离线真人保留可重连
        if (pl.isAI || timedOut) {
          this.players.delete(pl.id);
          this.wsPlayers.delete(pl.ws);
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
        try {
          fn();
        } catch (e) {
          console.error('[game] timer error (' + key + '):', e);
        }
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

  _log(room, text, privateFor, maskedText) {
    if (!room) return;
    const entry = { time: nowTime(), text };
    if (typeof privateFor === 'number') entry.privateFor = privateFor;
    if (typeof maskedText === 'string') entry.maskedText = maskedText;
    room.logs.push(entry);
    if (room.logs.length > MAX_LOGS) room.logs.shift();
  }

  /** 按查看者视角脱敏日志：私有日志（privateFor）仅本人见完整文本，他人见 maskedText */
  _maskLogsForViewer(logs, viewerSeat) {
    return (logs || []).map((e) => {
      if (e && e.privateFor !== undefined && e.privateFor !== viewerSeat && typeof e.maskedText === 'string') {
        return { time: e.time, text: e.maskedText };
      }
      return e;
    });
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
      if (pl && pl.ws) this._send(pl, { type: 'room_state', room: this._buildRoomView(room, pl.seat) });
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
    // 携带本局确认状态（确认阶段 / 重连恢复用）
    if (room.settleConfirms) msg.confirms = room.settleConfirms.slice();
    if (targetPlayer) this._send(targetPlayer, msg);
    else this._broadcast(room, msg);
  }

  _sendLobbyState(p) {
    const rooms = [...this.rooms.values()].map((r) => ({
      id: r.id,
      state: r.state,
      settings: r.settings,
      ownerName: r.ownerName, // 创建者名称（房主转让/离开后仍保持原创建者）
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

module.exports = { GameServer, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MAX_MISS };
