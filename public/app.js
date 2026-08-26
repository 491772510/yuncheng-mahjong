'use strict';
/* 运城扣点点麻将 - 前端渲染与交互 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const state = {
    ws: null,
    playerId: localStorage.getItem('kd.playerId') || '',
    name: localStorage.getItem('kd.name') || '',
    lobby: null,
    room: null,
    game: null,
    prompt: null,
    tingPick: false, // 听口选牌状态：点击手牌表示报听
    reconnectAttempts: 0,
    countdownTimer: null,
    countdownEnd: 0,
    lastSettlementShown: null,
  };

  // ================= WS =================
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;
    ws.onopen = () => {
      state.reconnectAttempts = 0;
      hideConnMask();
      if (state.playerId) {
        send({ type: 'reconnect', playerId: state.playerId, name: state.name });
      }
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      state.connected = false;
      if (!state.room) {
        // 大厅中：显示重连遮罩但不打扰（自动恢复）
      }
      showConnMask('连接断开，正在重连…');
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(1.6, state.reconnectAttempts), 8000);
    state.reconnectAttempts++;
    setTimeout(connect, delay);
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(obj));
    } else {
      toast('连接未就绪，请稍候', true);
    }
  }

  // ================= 消息处理 =================
  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello':
        state.playerId = msg.playerId;
        state.name = msg.name;
        localStorage.setItem('kd.playerId', state.playerId);
        localStorage.setItem('kd.name', state.name);
        $('#nick-input').value = state.name;
        break;
      case 'lobby_state':
        state.lobby = msg;
        if (!state.room) renderLobby();
        break;
      case 'room_state':
        if (msg.room === null) {
          state.room = null;
          state.game = null;
          state.prompt = null;
          hideConnMask();
          // 回到大厅，重新同步昵称与大厅状态
          renderLobby();
          return;
        }
        state.room = msg.room;
        renderRoomView();
        // 不在确认阶段时清理结算确认区，避免跨局/跨房间残留
        if (!msg.room.settleConfirms) {
          $('#settle-confirm').classList.add('hidden');
          $('#settle-confirm-btn').classList.add('hidden');
          $('#settle-close').classList.remove('hidden');
        }
        if (state.room.state === 'settled') {
          showSettleModal();
        }
        break;
      case 'game_state':
        state.game = msg.game;
        state.tingPick = false;
        // 重连兜底：若轮到本玩家出牌或本玩家有未决定的碰/杠/胡响应权，
        // 但服务端未（或消息已丢失）下发 action_prompt，则按 game_state 自行补齐，
        // 避免手牌/操作按钮不可点导致整局卡死
        if (msg.game.isDrawTurn) {
          if (!state.prompt || state.prompt.type !== 'draw') {
            state.prompt = { type: 'draw', actions: ['play'], gangOptions: [], canHu: false, canDeclareTing: false };
          }
        } else if (msg.game.pending) {
          const r = msg.game.pending.responders.find((x) => x.seat === msg.game.yourSeat);
          if (r && r.choice === null) {
            if (!state.prompt || state.prompt.type !== 'response') {
              state.prompt = {
                type: 'response',
                actions: ['pass'],
                canHu: r.canHu,
                canGang: r.canGang,
                canPeng: r.canPeng,
                tile: msg.game.pending.tile,
                pendingType: msg.game.pending.type,
                timeoutMs: 20000,
              };
            }
          } else {
            state.prompt = null;
          }
        } else {
          state.prompt = null;
        }
        if (msg.game.logs && state.room) state.room.logs = msg.game.logs;
        if (state.room && state.room.state === 'playing') {
          renderTable();
          renderSidePanel();
        }
        // 新一局开始（非结算阶段）时关闭结算弹窗
        if (msg.game.stage !== 'over') hideModal('settle-modal');
        break;
      case 'action_prompt':
        state.prompt = msg.prompt;
        state.tingPick = false;
        if (msg.prompt && msg.prompt.type === 'koupoint') {
          showKoupointModal();
        } else {
          hideModal('koupoint-modal');
          renderActions();
        }
        break;
      case 'settlement':
        if (state.room && state.room.state === 'settled') break; // 总结算弹窗已含最后一局摘要
        state.lastSettlementShown = (state.game && state.game.roundNo) || 0;
        showSettlement(msg.result);
        // 处于确认阶段（含重连恢复）：渲染确认状态并确保弹窗可见
        if (msg.confirms) {
          renderSettleConfirm(msg.confirms);
          showModal('settle-modal');
        }
        break;
      case 'settlement_confirm':
        if (state.room && state.room.state === 'settled') break;
        if (msg.confirms) {
          renderSettleConfirm(msg.confirms);
          showModal('settle-modal');
        }
        break;
      case 'draw_notice':
        // 摸牌提示：显示摸到的具体牌（含字牌）
        toast('摸到 ' + tileText(msg.tile), false);
        break;
      case 'chat':
        renderChat(msg.chat);
        break;
      case 'error':
        toast(msg.message || '操作失败', true);
        break;
      default:
        break;
    }
  }

  // ================= 视图切换 =================
  function showView(name) {
    $('#lobby-view').classList.toggle('hidden', name !== 'lobby');
    $('#room-view').classList.toggle('hidden', name !== 'room');
  }

  // ================= 大厅 =================
  function renderLobby() {
    showView('lobby');
    const list = $('#room-list');
    const rooms = (state.lobby && state.lobby.rooms) || [];
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">暂无房间，点击「创建房间」开一桌～</div>';
      return;
    }
    list.innerHTML = rooms.map((r) => `
      <div class="room-card">
        <div class="rc-id">房间 ${r.id}</div>
        <div class="rc-meta">
          <span class="badge ${r.state}">${roomStateText(r.state)}</span>
          <span>${r.playerCount}/4 人</span>
          <span>136张·带风带箭</span>
          <span>${r.settings.aiFill ? 'AI补位' : '无AI'}</span>
          <span>报听必开</span>
          <span>${roundsText(r.settings.totalRounds)}</span>
        </div>
        <button class="btn small primary" data-join="${r.id}"
          ${r.state !== 'waiting' || r.playerCount >= 4 ? 'disabled' : ''}>加入</button>
      </div>`).join('');
  }

  function roomStateText(s) {
    return s === 'playing' ? '游戏中' : s === 'settled' ? '已结算' : '等待中';
  }
  function roundsText(v) { return v === 0 ? '不限局数' : v + ' 局'; }

  // ================= 房间视图 =================
  function renderRoomView() {
    showView('room');
    const room = state.room;
    $('#room-id-text').textContent = room.id;
    $('#room-state-text').textContent =
      roomStateText(room.state) + (room.roundNo ? ` · 第 ${room.roundNo} 局` : '') +
      (room.settleConfirms && !room.settleConfirms.every(Boolean) ? ' · 等待确认' : '') +
      ` · ${roundsText(room.settings.totalRounds)}`;
    renderHeaderBtns();
    if (room.state === 'playing' && state.game) {
      renderTable();
    } else if (room.state === 'settled') {
      renderSettledRoom();
    } else {
      renderWaitingRoom();
    }
    renderSidePanel();
  }

  function renderHeaderBtns() {
    const room = state.room;
    const isOwner = room.ownerId === state.playerId;
    const box = $('#header-btns');
    let html = '';
    if (isOwner && room.state === 'waiting') {
      html += `<button class="btn small" id="btn-add-ai">＋ AI 补位</button>`;
      html += `<button class="btn small primary" id="btn-start">开始游戏</button>`;
    }
    if (isOwner && room.state === 'settled') {
      html += `<button class="btn small primary" id="btn-restart">再来一轮</button>`;
    }
    if (isOwner) {
      html += `<button class="btn small" id="btn-dissolve">解散房间</button>`;
    } else {
      html += `<button class="btn small" id="btn-leave">退出房间</button>`;
    }
    box.innerHTML = html;
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('btn-add-ai', () => send({ type: 'add_ai' }));
    on('btn-start', () => send({ type: 'start_game' }));
    on('btn-restart', () => send({ type: 'start_game' }));
    on('btn-dissolve', () => {
      if (confirm('确定解散房间吗？所有玩家都会被移出。')) send({ type: 'dissolve' });
    });
    on('btn-leave', () => send({ type: 'leave_room' }));
  }

  function renderWaitingRoom() {
    const room = state.room;
    const wrap = $('#table-wrap');
    let html = '<div class="waiting-grid">';
    for (let s = 0; s < 4; s++) {
      const pl = room.players[s];
      if (pl) {
        html += `<div class="wait-card">
          <div class="nm">${esc(pl.name)}${pl.id === state.playerId ? '（我）' : ''}</div>
          <div>${pl.isAI ? '🤖 AI' : '真人'}${pl.id === room.ownerId ? ' · 房主' : ''}</div>
        </div>`;
      } else {
        html += `<div class="wait-card empty-card"><div class="nm">空位</div><div>等待加入…</div></div>`;
      }
    }
    html += '</div>';
    const isOwner = room.ownerId === state.playerId;
    html += `<div class="wait-hint">${
      isOwner
        ? '点击「开始游戏」开局；未满 4 人时可点击「＋ AI 补位」加入机器人。'
        : '等待房主开始游戏…（满 4 人将自动开局）'
    }</div>`;
    wrap.innerHTML = html;
  }

  function renderSettledRoom() {
    const room = state.room;
    const wrap = $('#table-wrap');
    const sorted = [...room.players].filter(Boolean).sort((a, b) => b.score - a.score);
    wrap.innerHTML = `
      <div class="settle-final">
        <div class="wait-hint" style="font-size:18px;font-weight:700;">🏆 全部 ${room.settings.totalRounds} 局结束</div>
        ${sorted.map((p, i) => `
          <div class="settle-player" style="margin-bottom:8px;">
            <span>${i + 1}.</span>
            <span class="nm">${esc(p.name)}${p.id === state.playerId ? '（我）' : ''}</span>
            <span class="delta ${p.score >= 0 ? 'up' : 'down'}">${p.score >= 0 ? '+' : ''}${p.score}</span>
          </div>`).join('')}
        <div class="wait-hint">房主可点击「再来一轮」重置积分重新开战，或解散房间。</div>
      </div>`;
  }

  // ================= 牌桌 =================
  function renderTable() {
    const game = state.game;
    if (!game) return;
    const wrap = $('#table-wrap');
    const d = (seat) => (seat - game.yourSeat + 4) % 4;
    const POS = ['bottom', 'right', 'top', 'left'];
    let html = '<div class="table">';
    html += `<div class="table-center">
      <div class="wall-count">牌墙 <b>${game.wallCount}</b></div>
      <div class="turn-info">${turnText()}</div>
      <div class="action-bar" id="action-bar"></div>
    </div>`;
    for (let seat = 0; seat < 4; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const pos = POS[d(seat)];
      html += `<div class="seat seat-${pos}" data-seat="${seat}">`;
      html += pos === 'bottom' ? renderSelfCard(p, seat) : renderOtherCard(p, seat, pos);
      html += '</div>';
    }
    html += '</div>';
    wrap.innerHTML = html;
    bindTileClicks();
    bindCancelHosted();
    renderActions();
  }

  function bindCancelHosted() {
    const btn = document.querySelector('#table-wrap .btn-cancel-hosted');
    if (btn) btn.onclick = () => send({ type: 'cancel_hosted' });
  }

  function turnText() {
    const game = state.game;
    if (!game) return '';
    if (game.stage === 'response' && game.pending) {
      const who = game.players[game.pending.discarder];
      return `${who ? who.name : '?'} 打出，等待响应…`;
    }
    if (game.winners) {
      return game.winners.type === 'draw' ? '流局' : '本局结束';
    }
    const cur = game.players[game.turn];
    if (!cur) return '';
    const you = game.yourSeat === game.turn;
    if (you) return cur.ting ? '你已报听，摸牌即打（只能杠，不能碰/换牌）' : '轮到你出牌';
    return cur.ting ? `等待 ${cur.name} 摸打（报听）…` : `等待 ${cur.name} 出牌…`;
  }

  function renderOtherCard(p, seat, pos) {
    const game = state.game;
    const isTurn = game.turn === seat && !game.winners;
    const meldHtml = renderMelds(p.melds);
    const discards = (p.discards || []).map((t) => tileHtml(t, 'tiny')).join('');
    const kouTile = game.kouTiles && game.kouTiles[seat];
    const kp = game.kouPoints && game.kouPoints[seat];
    return `<div class="player-card ${isTurn ? 'active-turn' : ''}">
      <div class="pc-top">
        ${p.isDealer ? '<span class="pc-dealer">庄</span>' : ''}
        ${p.isAI ? '<span class="pc-ai">AI</span>' : ''}
        ${!p.connected ? '<span class="pc-off">离线</span>' : ''}
        ${p.hosted ? '<span class="pc-host">托管</span>' : ''}
        ${p.ting ? '<span class="pc-ting">报听</span>' : ''}
        ${kp != null ? `<span class="pc-koupoint">扣${kp}点</span>` : ''}
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-score">${p.score}</span>
      </div>
      ${kouTile ? `<div class="kou-tile-row"><span class="tile tiny back"></span><span class="kou-label">报听扣牌</span></div>` : ''}
      <div class="melds">${meldHtml}</div>
      <div class="discard-area">${discards}</div>
    </div>`;
  }

  function renderSelfCard(p, seat) {
    const game = state.game;
    const isTurn = game.turn === seat && !game.winners;
    const hand = (p.hand || []).map((t) => {
      const ting = game.tingHints && game.tingHints[t] ? game.tingHints[t] : 0;
      return tileHtml(t, '', ting, true);
    }).join('');
    const meldHtml = renderMelds(p.melds);
    const discards = (p.discards || []).map((t) => tileHtml(t, 'tiny')).join('');
    const kouTile = game.kouTiles && game.kouTiles[seat];
    const kp = game.kouPoints && game.kouPoints[seat];
    return `<div class="player-card ${isTurn ? 'active-turn' : ''}">
      <div class="pc-top">
        ${p.isDealer ? '<span class="pc-dealer">庄</span>' : ''}
        ${p.isAI ? '<span class="pc-ai">AI</span>' : ''}
        ${p.hosted ? '<span class="pc-host">AI托管中</span>' : ''}
        ${p.ting ? '<span class="pc-ting">报听</span>' : ''}
        ${kp != null ? `<span class="pc-koupoint">扣${kp}点</span>` : ''}
        <span class="pc-name">${esc(p.name)}（我）</span>
        <span class="pc-score">${p.score}</span>
        ${p.hosted ? '<button class="btn-cancel-hosted">取消托管</button>' : ''}
      </div>
      ${kouTile ? `<div class="kou-tile-row"><span class="tile tiny back"></span><span class="kou-label">报听扣牌（暗牌）</span></div>` : ''}
      <div class="melds">${meldHtml}</div>
      <div class="hand">${state.tingPick ? '<div class="ting-pick-hint">请选择要扣的牌报听（需听牌中含 ≥6 点牌）</div>' : ''}<div class="hand-tiles">${hand}</div></div>
      <div class="discard-area">${discards}</div>
    </div>`;
  }

  function renderMelds(melds) {
    if (!melds || !melds.length) return '';
    return melds.map((m) => {
      const tiles = m.type === 'angang'
        ? '<span class="tile tiny back"></span><span class="tile tiny back"></span><span class="tile tiny back"></span><span class="tile tiny back"></span>'
        : m.tiles.map((t) => tileHtml(t, 'tiny')).join('');
      return `<div class="meld">${tiles}</div>`;
    }).join('');
  }

  const HONOR_NAMES = { e: '東', s: '南', x: '西', n: '北', z: '中', f: '發', p: '白' };

  function tileHtml(tile, size, ting, discardable) {
    if (!tile) return '';
    const suit = tile[0];
    const isHonor = HONOR_NAMES[tile];
    const cls = `tile ${size} ${suitClass(suit)}` +
      (isHonor ? ' honor' : '') +
      (discardable ? ' discardable' : '') +
      (ting ? ' ting-mark' : '');
    const attr = ting ? ` data-ting="${ting}张"` : '';
    const inner = isHonor ? honorFace(tile) : suitFace(tile);
    return `<span class="${cls}" data-tile="${tile}"${attr}>${inner}</span>`;
  }

  // ===== 传统麻将图案牌面（纯 CSS/HTML，无图片资源）=====
  // 筒子 1-9 传统圆点布局（百分比坐标：左%, 顶%）
  const PIP_LAYOUT = {
    '1': [[50, 50]],
    '2': [[30, 30], [70, 70]],
    '3': [[30, 30], [50, 50], [70, 70]],
    '4': [[30, 30], [70, 30], [30, 70], [70, 70]],
    '5': [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]],
    '6': [[30, 20], [70, 20], [30, 50], [70, 50], [30, 80], [70, 80]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[28, 12], [28, 37], [28, 63], [28, 88], [72, 12], [72, 37], [72, 63], [72, 88]],
    '9': [[17, 17], [50, 17], [83, 17], [17, 50], [50, 50], [83, 50], [17, 83], [50, 83], [83, 83]]
  };
  // 条子 2-9 竖条布局（与筒子传统排列对应）
  const BAR_LAYOUT = {
    '2': [[30, 50], [70, 50]],
    '3': [[50, 25], [30, 75], [70, 75]],
    '4': [[30, 25], [70, 25], [30, 75], [70, 75]],
    '5': [[30, 20], [70, 20], [50, 50], [30, 80], [70, 80]],
    '6': [[30, 17], [30, 50], [30, 83], [70, 17], [70, 50], [70, 83]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[28, 12], [28, 37], [28, 63], [28, 88], [72, 12], [72, 37], [72, 63], [72, 88]],
    '9': [[17, 17], [50, 17], [83, 17], [17, 50], [50, 50], [83, 50], [17, 83], [50, 83], [83, 83]]
  };

  function suitFace(tile) {
    const suit = tile[0];
    const num = tile.slice(1);
    if (suit === 'w') {
      return `<span class="wan-face"><b>${num}</b><i>萬</i></span>`;
    }
    if (suit === 't') {
      if (num === '1') {
        return `<span class="bird"><i class="b-head"></i><i class="b-body"></i><i class="b-wing"></i><i class="b-tail"></i></span>`;
      }
      const pts = BAR_LAYOUT[num] || [];
      // 7 条按参考图：上 3 绿条斜排 + 下 4 红条 2×2
      const colored = num === '7' ? pts.map((p, idx) => idx < 3 ? [p[0], p[1], '#1e8449'] : [p[0], p[1], '#c0392b']) : pts;
      return `<span class="bars">${colored.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    if (suit === 'b') {
      const pts = PIP_LAYOUT[num] || [];
      // 7 筒按参考图：上 3 绿点斜排 + 下 4 红点 2×2
      const colored = num === '7' ? pts.map((p, idx) => idx < 3 ? [p[0], p[1], '#1e8449'] : [p[0], p[1], '#c0392b']) : pts;
      return `<span class="pips">${colored.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    return '';
  }

  function honorFace(tile) {
    const ch = HONOR_NAMES[tile];
    if (tile === 'z') return `<span class="honor-face hz">${ch}</span>`;
    if (tile === 'f') return `<span class="honor-face hf">${ch}</span>`;
    if (tile === 'p') return `<span class="honor-face hp"></span>`;
    return `<span class="honor-face hw">${ch}</span>`;
  }

  function suitClass(s) {
    if (s === 'w') return 'wan';
    if (s === 't') return 'tiao';
    if (s === 'b') return 'tong';
    return 'honor';
  }

  function tileText(t) {
    if (!t) return '';
    if (HONOR_NAMES[t]) return HONOR_NAMES[t];
    const num = t.slice(1);
    const s = t[0];
    const suit = s === 'w' ? '万' : s === 't' ? '条' : '筒';
    return `${num}${suit}`;
  }

  function bindTileClicks() {
    const wrap = $('#table-wrap');
    const tiles = wrap.querySelectorAll('.hand-tiles .tile.discardable');
    tiles.forEach((el) => {
      el.onclick = () => {
        const tile = el.dataset.tile;
        const game = state.game;
        if (!game || !game.isDrawTurn) return;
        if (!state.prompt || state.prompt.type !== 'draw') return;
        if (state.tingPick) {
          // 听口：点击手牌即打出该张报听
          send({ type: 'ting', tile });
          return;
        }
        send({ type: 'play_tile', tile });
      };
    });
  }

  // ================= 操作区 =================
  function renderActions() {
    const bar = $('#action-bar');
    if (!bar) return;
    const p = state.prompt;
    if (!p) { bar.innerHTML = ''; return; }
    let btns = '';
    if (p.type === 'draw') {
      if (p.canHu) btns += `<button class="act act-hu" data-act="hu">胡</button>`;
      if (p.actions && p.actions.includes('pass')) btns += `<button class="act act-pass" data-act="pass">过</button>`;
      if (p.gangOptions && p.gangOptions.length) btns += `<button class="act act-gang" data-act="gang">杠</button>`;
      if (p.canDeclareTing && !state.tingPick) btns += `<button class="act act-ting" data-act="ting">报听</button>`;
      if (state.tingPick) {
        btns += `<button class="act act-pass" data-act="ting-cancel">取消</button>`;
        btns += `<span class="countdown" style="align-self:center;">点击要扣的牌报听</span>`;
      } else {
        btns += `<span class="countdown" style="align-self:center;">点击手牌出牌</span>`;
      }
    } else if (p.type === 'response') {
      if (p.canHu) btns += `<button class="act act-hu" data-act="hu">胡</button>`;
      if (p.canGang) btns += `<button class="act act-gang" data-act="gang">杠</button>`;
      if (p.canPeng) btns += `<button class="act act-peng" data-act="peng">碰</button>`;
      btns += `<button class="act act-pass" data-act="pass">过</button>`;
      btns += `<span class="countdown" style="align-self:center;">${p.pendingType === 'qianggang' ? '抢杠胡' : tileText(p.tile)}</span>`;
    }
    bar.innerHTML = btns;
    if (p.timeoutMs) {
      state.countdownEnd = Date.now() + p.timeoutMs;
      startCountdown();
    }
    $$('#action-bar [data-act]').forEach((b) => {
      b.onclick = () => onAction(b.dataset.act);
    });
  }

  function startCountdown() {
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    const cd = () => {
      const remain = Math.max(0, Math.round((state.countdownEnd - Date.now()) / 1000));
      const el = document.querySelector('.countdown');
      if (el && remain > 0) el.textContent = `⏱ ${remain}s`;
    };
    cd();
    state.countdownTimer = setInterval(cd, 1000);
  }

  function onAction(act) {
    if (act === 'hu') send({ type: 'hu' });
    else if (act === 'peng') send({ type: 'peng' });
    else if (act === 'pass') send({ type: 'pass' });
    else if (act === 'gang') showGangMenu();
    else if (act === 'ting') {
      state.tingPick = true;
      renderTable();
    } else if (act === 'ting-cancel') {
      state.tingPick = false;
      renderTable();
    }
  }

  function showGangMenu() {
    const p = state.prompt;
    if (!p || !p.gangOptions || !p.gangOptions.length) { send({ type: 'gang' }); return; }
    const btn = document.querySelector('[data-act="gang"]');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'gang-menu';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.min(rect.left, window.innerWidth - 170) + 'px';
    p.gangOptions.forEach((opt) => {
      const label = opt.gangType === 'angang' ? `暗杠 ${tileText(opt.tile)}` : `补杠 ${tileText(opt.tile)}`;
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        document.body.removeChild(menu);
        send({ type: 'gang', tile: opt.tile, gangType: opt.gangType });
      };
      menu.appendChild(b);
    });
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => document.body.removeChild(menu);
    menu.appendChild(cancel);
    document.body.appendChild(menu);
    setTimeout(() => {
      const off = (e) => {
        if (!menu.contains(e.target)) {
          if (menu.parentNode) menu.parentNode.removeChild(menu);
          document.removeEventListener('click', off);
        }
      };
      document.addEventListener('click', off);
    }, 0);
  }

  // ================= 136 扣点弹窗 =================
  let koupointSelected = null;
  function showKoupointModal() {
    koupointSelected = null;
    // 弹窗内同步展示自己的手牌，方便参考决定扣几点
    const game = state.game;
    const mySeat = game && game.yourSeat;
    const myHand = game && game.players && game.players[mySeat] && game.players[mySeat].hand;
    $('#koupoint-hand').innerHTML = myHand && myHand.length
      ? myHand.map((t) => tileHtml(t)).join('')
      : '<span class="hand-empty">手牌加载中…</span>';
    const box = $('#koupoint-options');
    box.innerHTML = [1, 2, 3, 4].map((n) => `
      <button class="koupoint-opt" data-points="${n}">
        <span class="kp-num">${n}</span>
        <span class="kp-tip">×${n}</span>
      </button>`).join('');
    box.querySelectorAll('.koupoint-opt').forEach((b) => {
      b.onclick = () => {
        box.querySelectorAll('.koupoint-opt').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        koupointSelected = Number(b.dataset.points);
        $('#koupoint-confirm').classList.remove('hidden');
      };
    });
    $('#koupoint-confirm').onclick = () => {
      if (koupointSelected == null) return;
      send({ type: 'koupoint', points: koupointSelected });
      hideModal('koupoint-modal');
    };
    showModal('koupoint-modal');
  }

  // ================= 侧栏 =================
  function renderSidePanel() {
    if (!state.room) return;
    renderScoreTab();
    renderLogTab();
    renderChat(state.room.chat);
  }

  function renderScoreTab() {
    const room = state.room;
    const sorted = [...room.players].filter(Boolean).sort((a, b) => b.score - a.score);
    $('#tab-score').innerHTML = sorted.map((p) => `
      <div class="score-row">
        <span class="nm">${esc(p.name)}${p.id === state.playerId ? '（我）' : ''}</span>
        ${p.id === room.ownerId ? '<span class="tag host">房主</span>' : ''}
        ${p.isAI ? '<span class="tag ai">AI</span>' : ''}
        ${!p.connected ? '<span class="tag off">离线</span>' : ''}
        <span class="rs">本局 ${p.roundScore >= 0 ? '+' : ''}${p.roundScore}</span>
        <span class="sc">${p.score >= 0 ? '+' : ''}${p.score}</span>
      </div>`).join('');
  }

  function renderLogTab() {
    const room = state.room;
    $('#tab-log').innerHTML = (room.logs || []).slice().reverse().map((l) => `
      <div class="log-line"><span class="t">${l.time}</span>${esc(l.text)}</div>`).join('') ||
      '<div class="empty">暂无日志</div>';
  }

  function renderChat(chat) {
    const box = $('#chat-messages');
    if (!box) return;
    box.innerHTML = (chat || []).map((m) => `
      <div class="chat-msg"><span class="who">${esc(m.from)}</span><span class="txt">${esc(m.text)}</span></div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  // ================= 结算 =================
  function gangLogsHtml(logs, players) {
    if (!logs || !logs.length) return '';
    const nameOf = (s) => (players && players[s] ? players[s].name : '座位' + s);
    return `<div class="settle-gang">
      <div class="settle-sub">杠分（明杠/补杠=该牌点数，暗杠=点数×2，字牌=10点；再乘杠主扣点，其余三家各付一份）</div>
      ${logs.map((lg) => {
        const typeName = lg.type === 'angang' ? '暗杠' : lg.type === 'bugang' ? '补杠' : '明杠';
        const kouText = lg.kou != null && lg.kou > 1 ? '×扣' + lg.kou : '';
        return `<div class="row">${esc(nameOf(lg.seat))} ${typeName} ${tileText(lg.tile)} · ${lg.points != null ? lg.points + '点' + kouText : ''}，每家 ${lg.perSeat} 分</div>`;
      }).join('')}
    </div>`;
  }

  function showSettlement(result) {
    if (!result) return;
    const title = $('#settle-title');
    const content = $('#settle-content');
    // ===== 136 张玩法结算：点数 × 牌型倍数 × 扣点 =====
    if (result.type === 'draw') {
      // 流局：剩 6 墩无人胡，公开听牌者 / 扣点 / 杠分
      title.textContent = '流局';
      const ting = (result.tingSeats || []).map((s) => result.hands[s] ? result.hands[s].name : '').join('、');
      const kouText = (result.kouPoints || []).map((v, s) => {
        const nm = result.hands && result.hands[s] ? result.hands[s].name : '座位' + s;
        return `${esc(nm)} 扣${v}点`;
      }).join(' · ');
      const flowLabel = state.room && state.room.settings && state.room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
      content.innerHTML = `
        <div class="settle-head"><div class="settle-sub">牌墙剩 6 墩，流局（无分差，${flowLabel}）</div></div>
        <div class="settle-sub">${ting ? '听牌者：' + ting : '无人听牌'}</div>
        <div class="settle-sub">暗扣公开：${kouText}</div>
        ${gangLogsHtml(result.gangLogs, result.hands)}
        <div class="settle-hands">${result.hands.map((h) => h ? `
          <div class="row"><b>${esc(h.name)}</b>
            ${h.hand.map((t) => tileHtml(t, 'tiny')).join('')}
            ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds) : ''}
          </div>` : '').join('')}</div>`;
      $('#settle-modal').classList.remove('hidden');
      return;
    }
    const winner = result.hands && result.hands[result.winnerSeat];
    const winLabel = result.winType === 'zimo' ? '自摸' : result.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    title.textContent = `${winner ? winner.name : ''} ${winLabel}！`;
    const multText = (result.multNames && result.multNames.length ? result.multNames.join('、') : '平胡');
    const kouText = (result.kouPoints || []).map((v, s) => {
      const nm = result.hands && result.hands[s] ? result.hands[s].name : '座位' + s;
      return `${esc(nm)} 扣${v}点`;
    }).join(' · ');
    const calcText = result.winType === 'zimo'
      ? `${result.tilePoints}点 × 2 × ${result.mult}倍 × 扣${result.kouPoint}点`
      : `${result.tilePoints}点 × ${result.mult}倍 × 扣${result.kouPoint}点`;
    content.innerHTML = `
      <div class="settle-head">
        <div class="settle-big">${result.score >= 0 ? '+' : ''}${result.score}</div>
        <div class="settle-sub">胡 ${tileText(result.tile)} · ${multText}（×${result.mult}）</div>
        <div class="settle-sub">${calcText}${result.baoHu ? ' · 包胡（一包三）' : ''}</div>
        <div class="settle-sub">暗扣公开：${kouText}</div>
      </div>
      ${gangLogsHtml(result.gangLogs, result.hands)}
      <div class="settle-hands">${result.hands.map((h) => h ? `
        <div class="row">
          <b>${esc(h.name)}${h.seat === result.winnerSeat ? '（胡）' : ''}</b>
          ${h.hand.map((t) => tileHtml(t, 'tiny')).join('')}
          ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds) : ''}
          <span style="opacity:.7">${h.roundScore >= 0 ? '+' : ''}${h.roundScore}</span>
        </div>` : '').join('')}</div>`;
    $('#settle-modal').classList.remove('hidden');
  }

  // 结算确认区：每位玩家「已确认 / 待确认」+ 自己的「确定」按钮
  function renderSettleConfirm(confirms) {
    const wrap = $('#settle-confirm');
    const btn = $('#settle-confirm-btn');
    const close = $('#settle-close');
    const room = state.room;
    if (!room || !confirms) {
      wrap.classList.add('hidden');
      btn.classList.add('hidden');
      close.classList.remove('hidden');
      return;
    }
    // 确认阶段不允许关闭弹窗，必须点「确定」
    close.classList.add('hidden');
    wrap.classList.remove('hidden');
    let mySeat = state.game ? state.game.yourSeat : -1;
    if (mySeat < 0) mySeat = room.players.findIndex((pl) => pl && pl.id === state.playerId);
    const players = room.players || [];
    wrap.innerHTML =
      `<div class="settle-confirm-title">本局结算确认（全员确认后开始下一局）</div>` +
      players
        .map((pl, s) =>
          pl
            ? `<div class="settle-confirm-row ${confirms[s] ? 'ok' : 'wait'}">
                 <span class="nm">${esc(pl.name)}${s === mySeat ? '（我）' : ''}</span>
                 <span class="st">${confirms[s] ? '已确认' : '待确认'}</span>
               </div>`
            : ''
        )
        .join('');
    if (mySeat >= 0 && !confirms[mySeat]) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '确定';
      btn.onclick = () => {
        send({ type: 'settle_confirm' });
        // 乐观更新：等待服务端广播回写全员状态
        btn.classList.add('hidden');
      };
    } else {
      btn.classList.add('hidden');
    }
  }

  function showSettleModal() {
    // 房间总战绩结算
    const room = state.room;
    const title = $('#settle-title');
    const content = $('#settle-content');
    const sorted = [...room.players].filter(Boolean).sort((a, b) => b.score - a.score);
    title.textContent = '🏆 房间结算';
    let html = '';
    const w = state.game && state.game.winners;
    if (w) {
      if (w.type === 'hu') {
        const winner = w.hands && w.hands[w.winnerSeat];
        const winLabel = w.winType === 'zimo' ? '自摸' : w.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
        const multText = (w.multNames && w.multNames.length ? w.multNames.join('、') : '平胡');
        const kouText = (w.kouPoints || []).map((v, s) => {
          const nm = w.hands && w.hands[s] ? w.hands[s].name : '座位' + s;
          return `${esc(nm)} 扣${v}点`;
        }).join(' · ');
        const calcText = w.winType === 'zimo'
          ? `${w.tilePoints}点 × 2 × ${w.mult}倍 × 扣${w.kouPoint}点`
          : `${w.tilePoints}点 × ${w.mult}倍 × 扣${w.kouPoint}点`;
        html += `<div class="settle-head">
          <div class="settle-sub">最后一局：${winner ? winner.name : ''} ${winLabel} ${tileText(w.tile)} · ${multText} · ${calcText}${w.baoHu ? '（包胡）' : ''} → ${w.score >= 0 ? '+' : ''}${w.score} 分</div>
          <div class="settle-sub">暗扣公开：${kouText}</div>
        </div>${gangLogsHtml(w.gangLogs, w.hands)}`;
      } else {
        const ting = (w.tingSeats || []).map((s) => w.hands[s] ? w.hands[s].name : '').join('、');
        const flowLabel = room.settings && room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
        html += `<div class="settle-head"><div class="settle-sub">最后一局：流局（${flowLabel}）${ting ? '，听牌者：' + ting : ''}</div></div>`;
      }
    }
    html += sorted.map((p, i) => `
      <div class="settle-player">
        <span>${i + 1}.</span>
        <span class="nm">${esc(p.name)}${p.id === state.playerId ? '（我）' : ''}</span>
        <span class="delta ${p.score >= 0 ? 'up' : 'down'}">${p.score >= 0 ? '+' : ''}${p.score}</span>
      </div>`).join('');
    content.innerHTML = html;
    $('#settle-modal').classList.remove('hidden');
  }

  // ================= 弹窗 =================
  function showModal(id) { $('#' + id).classList.remove('hidden'); }
  function hideModal(id) { $('#' + id).classList.add('hidden'); }

  function initCreateModal() {
    buildSeg('seg-rounds', [4, 8, 12, 0], (v) => (v === 0 ? '不限' : v + ' 局'));
    buildSeg('seg-dealer-flow', ['next', 'keep'], (v) => (v === 'keep' ? '连庄' : '下家接庄'));
    $('#create-cancel').onclick = () => hideModal('create-modal');
    $('#settle-close').onclick = () => hideModal('settle-modal');
    $('#create-confirm').onclick = () => {
      const totalRounds = segValue('seg-rounds');
      const aiFill = $('#opt-aifill').checked;
      const enableQingYiSe = $('#opt-qingyise').checked;
      const enableYiTiaoLong = $('#opt-yitiaolong').checked;
      const enableShiSanYao = $('#opt-shisanyao').checked;
      const dealerFlow = segValue('seg-dealer-flow') === 'keep' ? 'keep' : 'next';
      send({ type: 'create_room', settings: {
        totalRounds, aiFill, dealerFlow,
        enableKoupoint: $('#opt-koupoint').checked,
        enableQingYiSe, qingYiSeMult: Number($('#opt-qingyise-mult').value) || 4,
        enableYiTiaoLong, yiTiaoLongMult: Number($('#opt-yitiaolong-mult').value) || 4,
        enableShiSanYao, shiSanYaoMult: Number($('#opt-shisanyao-mult').value) || 8,
      } });
      hideModal('create-modal');
    };
  }

  function buildSeg(containerId, values, labelFn) {
    const c = $('#' + containerId);
    c.innerHTML = values.map((v, i) =>
      `<button class="seg-item ${i === 0 ? 'active' : ''}" data-value="${v}">${labelFn(v)}</button>`).join('');
    c.querySelectorAll('.seg-item').forEach((b) => {
      b.onclick = () => {
        c.querySelectorAll('.seg-item').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      };
    });
  }
  function segValue(containerId) {
    const el = $('#' + containerId + ' .seg-item.active');
    return parseInt(el ? el.dataset.value : '0', 10);
  }

  // ================= 其它 UI =================
  let toastTimer = null;
  function toast(text, isError) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function showConnMask(text) {
    $('#conn-text').textContent = text || '连接断开，正在重连…';
    $('#conn-mask').classList.remove('hidden');
  }
  function hideConnMask() {
    $('#conn-mask').classList.add('hidden');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ================= 事件绑定 =================
  function bindEvents() {
    $('#join-lobby-btn').onclick = () => {
      const name = $('#nick-input').value.trim();
      if (!name) { toast('请输入昵称', true); return; }
      state.name = name;
      localStorage.setItem('kd.name', name);
      send({ type: 'join_lobby', name });
    };
    $('#join-room-btn').onclick = () => {
      const id = $('#join-room-input').value.trim();
      if (!/^\d{4}$/.test(id)) { toast('请输入 4 位房间号', true); return; }
      send({ type: 'join_room', roomId: id });
    };
    $('#nick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-lobby-btn').click(); });
    $('#join-room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join-room-btn').click(); });
    $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    $('#chat-send-btn').onclick = sendChat;
    $('#create-room-btn').onclick = () => showModal('create-modal');

    document.addEventListener('click', (e) => {
      const joinBtn = e.target.closest('[data-join]');
      if (joinBtn && !joinBtn.disabled) {
        send({ type: 'join_room', roomId: joinBtn.dataset.join });
      }
      const tab = e.target.closest('.tab');
      if (tab) {
        $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === 'tab-' + tab.dataset.tab));
      }
    });
  }

  function sendChat() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  }

  // ================= 启动 =================
  function init() {
    $('#nick-input').value = state.name;
    initCreateModal();
    bindEvents();
    connect();
  }
  init();
})();
