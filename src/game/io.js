'use strict';

/**
 * 发送 / 广播 I/O 层（GameServer mixin）
 *
 * 从 game.js 拆出：把「消息序列化并发送到连接」的纯 I/O 逻辑集中于此，
 * 只依赖 this._send / 视图构建方法（仍留在 game.js 核心），不触碰玩法状态机。
 */

const ioMixin = {
  _send(p, obj) {
    if (p && p.ws && p.ws.readyState === 1) {
      try {
        p.ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] send error:', e);
      }
    }
  },

  _sendWs(ws, obj) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        console.error('[game] sendWs error:', e);
      }
    }
  },

  _err(p, message) {
    this._send(p, { type: 'error', message });
    return null;
  },

  _broadcast(room, obj) {
    for (const pl of room.players) {
      if (pl && pl.ws) this._send(pl, obj);
    }
  },

  _prompt(room, seat, prompt) {
    const pl = room.players[seat];
    if (pl && pl.ws) this._send(pl, { type: 'action_prompt', prompt });
  },

  _broadcastGameState(room) {
    if (!room.game) return;
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl && pl.ws) {
        this._send(pl, { type: 'game_state', game: this._buildGameView(room, s) });
      }
    }
  },

  _broadcastRoomState(room) {
    for (const pl of room.players) {
      if (pl && pl.ws) this._send(pl, { type: 'room_state', room: this._buildRoomView(room, pl.seat) });
    }
  },

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
  },

  // 大厅房间列表：仅下发「房间号 / 状态 / 玩法设置 / 创建者昵称 / 人数」，
  // 无任何身份类字段：不含 ownerId、不含任何 playerId、不含 secret（已核对，无需再裁剪）。
  // 房间号保留是因为 public/app.js:425 的「加入」按钮依赖 r.id，砍掉会直接让大厅列表不可用；
  // 加入仍需房间号，且失败限频（JOIN_FAIL_LIMIT）已防暴力枚举。
  _sendLobbyState(p) {
    const rooms = [...this.rooms.values()].map((r) => ({
      id: r.id,
      state: r.state,
      settings: r.settings,
      ownerName: r.ownerName, // 创建者名称（房主转让/离开后仍保持原创建者）
      playerCount: r.players.filter(Boolean).length,
    }));
    this._send(p, { type: 'lobby_state', rooms });
  },

  _broadcastLobby() {
    for (const p of this.players.values()) {
      if (p.ws && p.connected && !p.roomId) this._sendLobbyState(p);
    }
  },
};

module.exports = ioMixin;
