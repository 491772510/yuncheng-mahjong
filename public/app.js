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
    selectedIndex: null, // 手牌选中交互：当前选中的手牌索引（默认模式，开关关闭时生效）
    _lastTurn: null, // 最近一次 game_state 的 turn，用于检测轮次变化并清除选中态
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
      voiceDisable();
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
          state.selectedIndex = null;
          state._lastTurn = null;
          hideConnMask();
          resetVoiceBaseline();
          voiceDisable();
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
        // 手牌选中态：轮次变化 / 自己不可出牌 / 本局结束任一条件满足即清除，避免残留
        if (state.selectedIndex != null) {
          const stillMine = !!msg.game.isDrawTurn && msg.game.turn === msg.game.yourSeat && !msg.game.winners;
          const turnChanged = state._lastTurn != null && state._lastTurn !== msg.game.turn;
          if (!stillMine || turnChanged) state.selectedIndex = null;
        }
        state._lastTurn = msg.game.turn;
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
        // 杠分即时结算只广播 game_state，不广播 room_state；
        // 这里同步 players 的 score/roundScore，保证积分榜与实时牌局一致
        if (msg.game.players && state.room && state.room.players) {
          for (const p of msg.game.players) {
            if (p && state.room.players[p.seat]) {
              state.room.players[p.seat].score = p.score;
              state.room.players[p.seat].roundScore = p.roundScore;
            }
          }
        }
        if (state.room && state.room.state === 'playing') {
          checkSpeakEvents(msg.game);
          renderTable();
          renderSidePanel();
        }
        // 新一局开始（非结算阶段）时关闭结算弹窗
        if (msg.game.stage !== 'over') hideModal('settle-modal');
        break;
      case 'action_prompt':
        state.prompt = msg.prompt;
        state.tingPick = false;
        state.selectedIndex = null;
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
      case 'room_notice':
        // 房间级广播提示（如房主离线超时，本局结束后解散房间）
        toast(msg.text || '', true);
        break;
      case 'chat':
        // 同步 state.room.chat，避免 game_state 重绘侧栏时用旧快照把聊天记录打回原形
        if (state.room) state.room.chat = msg.chat || [];
        renderChat(state.room && state.room.chat);
        {
          const cm = (msg.chat && msg.chat.length) ? msg.chat[msg.chat.length - 1] : null;
          if (cm) showChatBubble(cm.from, cm.text);
        }
        break;
      case 'error':
        toast(msg.message || '操作失败', true);
        break;
      case 'voice_signal':
        handleVoiceSignal(msg);
        break;
      default:
        break;
    }
  }

  // ================= 实时语音对讲（WebRTC mesh） =================
  let voiceEnabled = false; // 语音开关状态
  let voiceLocalStream = null; // 本地麦克风音轨
  const voicePcs = new Map(); // targetId -> RTCPeerConnection
  const voiceAudioEls = new Map(); // targetId -> <audio>
  const speakingSeats = new Set(); // 正在说话的座位号

  // 房间内其他真人玩家（排除自己与 AI）
  function roomHumanPeers() {
    const out = [];
    if (!state.room || !state.room.players) return out;
    for (const pl of state.room.players) {
      if (pl && pl.id !== state.playerId && !pl.isAI && pl.connected) out.push(pl);
    }
    return out;
  }

  function seatOfPlayerId(pid) {
    if (!state.room || !state.room.players) return null;
    for (let s = 0; s < state.room.players.length; s++) {
      const pl = state.room.players[s];
      if (pl && pl.id === pid) return s;
    }
    return null;
  }

  // 开启语音：校验安全上下文 -> 取麦克风 -> 对每个真人对手建 pc/offer
  async function voiceEnable() {
    if (voiceEnabled) return;
    if (!window.isSecureContext) {
      const host = location.hostname || 'IP';
      toast('语音对讲需通过 https://' + host + ':3443 访问', true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前浏览器不支持麦克风，请使用 Chrome/Safari 等现代浏览器', true);
      return;
    }
    try {
      voiceLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      toast('无法获取麦克风权限，请检查浏览器授权', true);
      return;
    }
    voiceEnabled = true;
    updateVoiceBtn();
    for (const peer of roomHumanPeers()) {
      await voiceCreatePeer(peer);
    }
  }

  async function voiceCreatePeer(peer) {
    if (!voiceEnabled || !voiceLocalStream || voicePcs.has(peer.id)) return;
    const pc = new RTCPeerConnection();
    voicePcs.set(peer.id, pc);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        send({ type: 'voice_signal', target: peer.id, sig: { kind: 'ice', candidate: ev.candidate } });
      }
    };
    pc.ontrack = (ev) => voiceOnTrack(peer.id, ev);
    voiceLocalStream.getTracks().forEach((t) => pc.addTrack(t, voiceLocalStream));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'voice_signal', target: peer.id, sig: { kind: 'offer', sdp: pc.localDescription } });
    } catch (e) {
      console.error('[voice] createOffer error:', e);
      voiceRemovePeer(peer.id);
    }
  }

  function voiceOnTrack(fromId, ev) {
    const seat = seatOfPlayerId(fromId);
    if (seat == null) return;
    let audio = voiceAudioEls.get(fromId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      document.body.appendChild(audio);
      voiceAudioEls.set(fromId, audio);
      audio.addEventListener('play', () => { speakingSeats.add(seat); syncSpeaking(); });
      audio.addEventListener('pause', () => { speakingSeats.delete(seat); syncSpeaking(); });
      audio.addEventListener('ended', () => { speakingSeats.delete(seat); syncSpeaking(); });
    }
    audio.srcObject = ev.streams[0];
    audio.play().catch(() => {});
  }

  function voiceRemovePeer(targetId) {
    const pc = voicePcs.get(targetId);
    if (pc) {
      try { pc.close(); } catch (e) { /* ignore */ }
      voicePcs.delete(targetId);
    }
    const audio = voiceAudioEls.get(targetId);
    if (audio) {
      try { audio.pause(); audio.srcObject = null; audio.remove(); } catch (e) { /* ignore */ }
      voiceAudioEls.delete(targetId);
    }
    const seat = seatOfPlayerId(targetId);
    if (seat != null) { speakingSeats.delete(seat); syncSpeaking(); }
  }

  // 收到信令：offer -> 建 pc + answer；answer -> setRemoteDescription；ice -> addIceCandidate
  async function handleVoiceSignal(msg) {
    const fromId = msg.from;
    const sig = msg.sig || {};
    if (!fromId || !sig || typeof sig !== 'object') return;
    if (sig.kind === 'offer') {
      if (!voiceEnabled || !voiceLocalStream) return; // 未开启语音则忽略对端邀请
      let pc = voicePcs.get(fromId);
      if (!pc) {
        pc = new RTCPeerConnection();
        voicePcs.set(fromId, pc);
        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            send({ type: 'voice_signal', target: fromId, sig: { kind: 'ice', candidate: ev.candidate } });
          }
        };
        pc.ontrack = (ev) => voiceOnTrack(fromId, ev);
        voiceLocalStream.getTracks().forEach((t) => pc.addTrack(t, voiceLocalStream));
      }
      try {
        await pc.setRemoteDescription(sig.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'voice_signal', target: fromId, sig: { kind: 'answer', sdp: pc.localDescription } });
      } catch (e) {
        console.error('[voice] answer error:', e);
        voiceRemovePeer(fromId);
      }
    } else if (sig.kind === 'answer') {
      const pc = voicePcs.get(fromId);
      if (pc && sig.sdp) {
        try { await pc.setRemoteDescription(sig.sdp); } catch (e) { console.error('[voice] setRemote error:', e); }
      }
    } else if (sig.kind === 'ice') {
      const pc = voicePcs.get(fromId);
      if (pc && sig.candidate) {
        try { await pc.addIceCandidate(sig.candidate); } catch (e) { /* 竞态忽略 */ }
      }
    }
  }

  // 关闭语音：关闭所有 pc、停止本地音轨、清空说话指示
  function voiceDisable() {
    if (!voiceEnabled && voicePcs.size === 0 && !voiceLocalStream) return;
    voiceEnabled = false;
    for (const id of [...voicePcs.keys()]) voiceRemovePeer(id);
    if (voiceLocalStream) {
      voiceLocalStream.getTracks().forEach((t) => t.stop());
      voiceLocalStream = null;
    }
    speakingSeats.clear();
    syncSpeaking();
    updateVoiceBtn();
  }

  function updateVoiceBtn() {
    const btn = $('#btn-voice');
    if (!btn) return;
    btn.classList.toggle('voice-on', voiceEnabled);
    btn.textContent = voiceEnabled ? '语音开' : '语音';
  }

  // renderTable 重绘后恢复"正在说话"指示
  function syncSpeaking() {
    const seats = document.querySelectorAll('#table-wrap .seat[data-seat]');
    seats.forEach((el) => {
      const card = el.querySelector('.player-card');
      if (!card) return;
      const seat = Number(el.getAttribute('data-seat'));
      card.classList.toggle('pc-speaking', speakingSeats.has(seat));
    });
  }

  // ================= 视图切换 =================
  function showView(name) {
    $('#lobby-view').classList.toggle('hidden', name !== 'lobby');
    $('#room-view').classList.toggle('hidden', name !== 'room');
  }

  // ================= 大厅 =================
  function renderLobby() {
    showView('lobby');
    applyVariantChrome('koudian'); // 大厅默认扣点点文案
    const list = $('#room-list');
    const rooms = (state.lobby && state.lobby.rooms) || [];
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">暂无房间，点击「创建房间」开一桌～</div>';
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const hz = isHongZhongOf(r);
      const tj = !!(r.settings && r.settings.variant === 'tiejin');
      return `
      <div class="room-card">
        <div class="rc-id">房间 ${r.id}</div>
        <div class="rc-meta">
          <span class="badge ${r.state}">${roomStateText(r.state)}</span>
          <span>${r.playerCount}/4 人</span>
          <span>创建者 ${esc(r.ownerName || '未知')}</span>
          <span>${hz ? '112张·红中麻将' : tj ? '136张·贴金麻将' : '136张·带风带箭'}</span>
          <span>${r.settings.aiFill ? 'AI补位' : '无AI'}</span>
          <span>${hz ? '癞子红中' : tj ? '金牌万能' : '报听必开'}</span>
          <span>${roundsText(r.settings.totalRounds)}</span>
        </div>
        <button class="btn small primary" data-join="${r.id}"
          ${r.state !== 'waiting' || r.playerCount >= 4 ? 'disabled' : ''}>加入</button>
      </div>`;
    }).join('');
  }

  function roomStateText(s) {
    return s === 'playing' ? '游戏中' : s === 'settled' ? '已结算' : '等待中';
  }
  function roundsText(v) { return v === 0 ? '不限局数' : v + ' 局'; }
  // 玩法识别：settings.variant（优先）或 game.variant 兜底
  function isHongZhongOf(s) { return !!(s && ((s.settings && s.settings.variant === 'hongzhong') || s.variant === 'hongzhong')); }
  function variantLabel(settings) { return settings && settings.variant === 'hongzhong' ? '红中麻将' : settings && settings.variant === 'tiejin' ? '贴金麻将' : '扣点点'; }
  // 页面标题/Logo/Slogan 随玩法切换：koudian 默认，tiejin/hongzhong 各自文案
  function variantChrome(variant) {
    if (variant === 'tiejin') return { title: '运城贴金麻将', logo: '🀄 运城贴金麻将', slogan: '贴金 · 金牌万能 · 亮金锁金' };
    if (variant === 'hongzhong') return { title: '红中麻将', logo: '🀄 红中麻将', slogan: '红中癞子 · 自摸抢杠 · 扎码翻倍' };
    return { title: '运城扣点点麻将', logo: '🀄 运城扣点点麻将', slogan: '扣点点 · 只碰不吃 · 胡牌自摸' };
  }
  function applyVariantChrome(variant) {
    const c = variantChrome(variant);
    document.title = c.title;
    const logo = $('.logo');
    const slogan = $('.slogan');
    if (logo) logo.textContent = c.logo;
    if (slogan) slogan.textContent = c.slogan;
  }

  // ================= 房间视图 =================
  function renderRoomView() {
    showView('room');
    fitViewportHeight();
    const room = state.room;
    applyVariantChrome(room.settings && room.settings.variant || 'koudian');
    $('#room-id-text').textContent = room.id;
    $('#room-state-text').textContent =
      `${variantLabel(room.settings)} · ${roomStateText(room.state)}` +
      (room.roundNo ? ` · 第 ${room.roundNo} 局` : '') +
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
    html += `<button class="btn small${voiceEnabled ? ' voice-on' : ''}" id="btn-voice">${voiceEnabled ? '语音开' : '语音'}</button>`;
    box.innerHTML = html;
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('btn-add-ai', () => send({ type: 'add_ai' }));
    on('btn-start', () => send({ type: 'start_game' }));
    on('btn-restart', () => send({ type: 'start_game' }));
    on('btn-dissolve', () => {
      if (confirm('确定解散房间吗？所有玩家都会被移出。')) send({ type: 'dissolve' });
    });
    on('btn-leave', () => send({ type: 'leave_room' }));
    on('btn-voice', () => {
      if (voiceEnabled) voiceDisable();
      else voiceEnable();
    });
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
    const tjGold = game.goldMother && game.goldTile
      ? `<div class="gold-mother">金母 <b>${tileHtml(game.goldMother, 'small', 0, false, false, undefined, false, game.goldMother)}</b> · 金牌 <b>${tileHtml(game.goldTile, 'small', 0, false, false, undefined, false, game.goldTile)}</b></div>`
      : '';
    html += `<div class="table-center">
      ${tjGold}
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
    // 保留已弹出的聊天气泡层（renderTable 整桌重绘，气泡需跨重绘存活）
    const layers = [...wrap.querySelectorAll('.bubble-layer')];
    wrap.innerHTML = html;
    for (const l of layers) wrap.appendChild(l);
    bindTileClicks();
    bindCancelHosted();
    applyWeakHighlight();
    renderActions();
    syncBubbleLayers();
    syncSpeaking();
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
    const hz = isHongZhongOf(game);
    const isTurn = game.turn === seat && !game.winners;
    const goldTile = game.goldTile || null;
    const meldHtml = renderMelds(p.melds, false, goldTile);
    const discards = (p.discards || []).map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('');
    const kp = hz ? null : (game.kouPoints && game.kouPoints[seat]);
    const tj = game.goldTile != null;
    const shangjin = (tj && game.shangjinTiles && game.shangjinTiles[seat]) || null;
    const lockedBadge = tj && game.locked && game.locked[seat] ? '<span class="pc-lock">锁金</span>' : '';
    return `<div class="player-card ${isTurn ? 'active-turn' : ''}">
      <div class="pc-top">
        ${p.isDealer ? '<span class="pc-dealer">庄</span>' : ''}
        ${p.isAI ? '<span class="pc-ai">AI</span>' : ''}
        ${!p.connected ? '<span class="pc-off">离线</span>' : ''}
        ${p.hosted ? '<span class="pc-host">托管</span>' : ''}
        ${p.ting ? '<span class="pc-ting">报听</span>' : ''}
        ${kp != null ? `<span class="pc-koupoint">扣${kp}点</span>` : ''}
        ${lockedBadge}
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-score">${p.score}</span>
      </div>
      ${shangjin ? `<div class="shangjin-area" title="亮金区（${shangjin.length}/3）">${shangjin.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('')}</div>` : ''}
      <div class="melds">${meldHtml}</div>
      <div class="discard-area">${discards}</div>
    </div>`;
  }

  // 单张手牌 HTML：复用与 renderSelfCard 一致的听口/新摸牌/选中态判定，供全量重绘与选中重绘共用
  function selfTileHtml(p, t, i) {
    const game = state.game;
    // tingHints[t] 未定义 = 打出后听口不含 ≥6 点牌（不可报听）；为 0 = 绝听但可报听（仅角标显示剩余 0 张）
    const tH = game.tingHints ? game.tingHints[t] : undefined;
    const ting = tH === undefined ? 0 : tH;
    // 报听选牌阶段：仅进入提示列表（含 ≥6 点听口）的选项可点击，未进入置灰；绝听（tH===0）仍可报听
    const canDiscard = state.tingPick ? tH !== undefined : true;
    // 新摸牌标志：与 newTile 同值且为排序后手牌中第一张该牌（其余同值牌不标记）
    const isNew = game.newTile === t && p.hand.indexOf(t) === i;
    // 选中态：普通出牌受「单击直接出牌」开关影响（开启时不选中）；报听阶段始终走选中交互，不受开关影响
    const selected = (state.tingPick || !isTapToDiscard()) && state.selectedIndex === i;
    return tileHtml(t, '', ting, canDiscard, isNew, i, selected, game.goldTile);
  }

  function renderSelfCard(p, seat) {
    const game = state.game;
    const isTurn = game.turn === seat && !game.winners;
    const hz = isHongZhongOf(game);
    const goldTile = game.goldTile || null;
    const hand = (p.hand || []).map((t, i) => selfTileHtml(p, t, i)).join('');
    const meldHtml = renderMelds(p.melds, true, goldTile);
    const discards = (p.discards || []).map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('');
    const kp = hz ? null : (game.kouPoints && game.kouPoints[seat]);
    const tj = game.goldTile != null;
    const shangjin = (tj && game.shangjinTiles && game.shangjinTiles[seat]) || null;
    const lockedBadge = tj && game.locked && game.locked[seat] ? '<span class="pc-lock">锁金</span>' : '';
    return `<div class="player-card ${isTurn ? 'active-turn' : ''}">
      <div class="pc-top">
        ${p.isDealer ? '<span class="pc-dealer">庄</span>' : ''}
        ${p.isAI ? '<span class="pc-ai">AI</span>' : ''}
        ${p.hosted ? '<span class="pc-host">AI托管中</span>' : ''}
        ${p.ting ? '<span class="pc-ting">报听</span>' : ''}
        ${kp != null ? `<span class="pc-koupoint">扣${kp}点</span>` : ''}
        ${lockedBadge}
        <span class="pc-name">${esc(p.name)}（我）</span>
        <span class="pc-score">${p.score}</span>
        ${p.hosted ? '<button class="btn-cancel-hosted">取消托管</button>' : ''}
      </div>
      ${shangjin ? `<div class="shangjin-area" title="亮金区（${shangjin.length}/3）">${shangjin.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('')}</div>` : ''}
      <div class="melds">${meldHtml}</div>
      <div class="hand">${state.tingPick ? '<div class="ting-pick-hint">请选择要扣的牌报听（需听牌中含 ≥6 点牌，灰色不可选）</div>' : ''}<div class="hand-tiles${state.tingPick ? ' ting-pick' : ''}">${hand}</div></div>
      <div class="discard-area">${discards}</div>
    </div>`;
  }

  function renderMelds(melds, isMine = false, goldTile) {
    if (!melds || !melds.length) return '';
    return melds.map((m) => {
      const tiles = m.type === 'angang' && isMine
        ? tileHtml(m.tiles[0], 'tiny', 0, false, false, undefined, false, goldTile) + '<span class="tile tiny back"></span><span class="tile tiny back"></span><span class="tile tiny back"></span>'
        : m.type === 'angang'
          ? '<span class="tile tiny back"></span><span class="tile tiny back"></span><span class="tile tiny back"></span><span class="tile tiny back"></span>'
          : m.tiles.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, goldTile)).join('');
      return `<div class="meld">${tiles}</div>`;
    }).join('');
  }

  const HONOR_NAMES = { e: '東', s: '南', x: '西', n: '北', z: '中', f: '發', p: '白', z0: '中' };

  function tileHtml(tile, size, ting, discardable, isNew, idx, selected, goldTile) {
    if (!tile) return '';
    if (tile === 'back') return `<span class="tile ${size} back"></span>`;
    const suit = tile[0];
    const isHonor = HONOR_NAMES[tile];
    const isGold = goldTile != null && tile === goldTile;
    const cls = `tile ${size} ${suitClass(suit)}` +
      (isHonor ? ' honor' : '') +
      (isGold ? ' gold-tile' : '') +
      (discardable ? ' discardable' : '') +
      (ting ? ' ting-mark' : '') +
      (isNew ? ' new-tile' : '') +
      (selected ? ' selected' : '');
    const idxAttr = idx != null ? ` data-idx="${idx}"` : '';
    const attr = ting ? ` data-ting="${ting}张"` : '';
    const inner = isHonor ? honorFace(tile) : suitFace(tile);
    return `<span class="${cls}" data-tile="${tile}"${idxAttr}${attr}>${inner}</span>`;
  }

  // ===== 传统麻将图案牌面（纯 CSS/HTML，无图片资源）=====
  // 筒子 1-9 传统圆点布局（百分比坐标：左%, 顶%）
  const PIP_LAYOUT = {
    '1': [[50, 50]],
    '2': [[30, 30], [70, 70]],
    '3': [[30, 30], [50, 50], [70, 70]],
    '4': [[30, 30], [70, 30], [30, 70], [70, 70]],
    '5': [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]],
    '6': [[30, 25], [70, 25], [30, 58], [70, 58], [30, 82], [70, 82]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[28, 12], [28, 37], [28, 63], [28, 88], [72, 12], [72, 37], [72, 63], [72, 88]],
    '9': [[17, 17], [50, 17], [83, 17], [17, 50], [50, 50], [83, 50], [17, 83], [50, 83], [83, 83]]
  };
  // 条子 2-9 竖条布局（与筒子传统排列对应）
  const BAR_LAYOUT = {
    '2': [[50, 30], [50, 70]],
    '3': [[50, 25], [30, 75], [70, 75]],
    '4': [[30, 25], [70, 25], [30, 75], [70, 75]],
    '5': [[30, 20], [70, 20], [50, 50], [30, 80], [70, 80]],
    '6': [[30, 30], [50, 30], [70, 30], [30, 70], [50, 70], [70, 70]],
    '7': [[30, 22], [50, 32], [70, 42], [30, 64], [70, 64], [30, 86], [70, 86]],
    '8': [[20, 20], [40, 20], [60, 20], [80, 20], [20, 80], [40, 80], [60, 80], [80, 80]],
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
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><circle cx="21" cy="18" r="7" stroke="#007830" stroke-width="2" fill="none"/><circle cx="24" cy="17" r="2" fill="#007830"/><path d="M28 18 L33 16" stroke="#007830" stroke-width="2"/><path d="M21 25 L21 38" stroke="#007830" stroke-width="2"/><path d="M21 29 L12 34" stroke="#007830" stroke-width="2"/><path d="M21 29 L30 34" stroke="#007830" stroke-width="2"/><path d="M21 38 L16 54 M21 38 L26 54" stroke="#007830" stroke-width="2"/></svg></span>`;
      }
      if (num === '8') {
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><path d="M7 12 L14 24 L21 12 L28 24 L35 12" stroke="#007830" stroke-width="2" fill="none"/><path d="M7 48 L14 36 L21 48 L28 36 L35 48" stroke="#007830" stroke-width="2" fill="none"/></svg></span>`;
      }
      if (num === '7') {
        // 7 条按用户指定 SVG：上方 1 竖条（红）+ 上排 3 条 + 下排 3 条（绿 #007830）
        return `<span class="tiao-mark"><svg viewBox="0 0 42 60"><path d="M21 12 L21 22" stroke="#c8102e" stroke-width="3" stroke-linecap="round"/><path d="M12 26 L12 36 M21 26 L21 36 M30 26 L30 36" stroke="#007830" stroke-width="3" stroke-linecap="round"/><path d="M12 40 L12 50 M21 40 L21 50 M30 40 L30 50" stroke="#007830" stroke-width="3" stroke-linecap="round"/></svg></span>`;
      }
      const pts = BAR_LAYOUT[num] || [];
      return `<span class="bars">${pts.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    if (suit === 'b') {
      const pts = PIP_LAYOUT[num] || [];
      // 7 筒按参考图：上 3 绿点斜排 + 下 4 红点 2×2；6 筒按参考图：上 2 绿点横排 + 下 4 红点 2×2
      let colored = pts;
      let pipsCls = 'pips';
      if (num === '7' || num === '6') {
        const greenN = num === '7' ? 3 : 2;
        colored = pts.map((p, idx) => idx < greenN ? [p[0], p[1], '#1e8449'] : [p[0], p[1], '#c0392b']);
        if (num === '6') pipsCls = 'pips with-core';
      }
      // 9 筒：中间一排（y=50 的三个点）为红色，上下两排保持默认色
      if (num === '9') {
        colored = pts.map((p, idx) => (idx >= 3 && idx <= 5) ? [p[0], p[1], '#c0392b'] : p);
      }
      return `<span class="${pipsCls}">${colored.map((p) => `<i style="left:${p[0]}%;top:${p[1]}%;${p[2] ? 'background:' + p[2] : ''}"></i>`).join('')}</span>`;
    }
    return '';
  }

  function honorFace(tile) {
    const ch = HONOR_NAMES[tile];
    if (tile === 'z') return `<span class="honor-face hz">${ch}</span>`;
    if (tile === 'z0') return `<span class="honor-face hz hz-wild">${ch}</span>`;
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
    if (t === 'z0') return '红中';
    if (HONOR_NAMES[t]) return HONOR_NAMES[t];
    const num = t.slice(1);
    const s = t[0];
    const suit = s === 'w' ? '万' : s === 't' ? '条' : '筒';
    return `${num}${suit}`;
  }

  // ===== 手牌选中交互（默认模式，开关关闭时生效）=====
  // 清除选中态：清空索引并移除 .selected / .weak-highlight 视觉
  function clearTileSelection() {
    state.selectedIndex = null;
    $$('#table-wrap .tile.selected').forEach((el) => el.classList.remove('selected'));
    // 同时清掉弃牌区与明牌区（碰/明杠/暗杠真牌/补杠）的弱高亮
    $$('#table-wrap .tile.weak-highlight').forEach((el) => el.classList.remove('weak-highlight'));
  }

  // 弃牌区与明牌区同种牌弱高亮：对当前选中牌同 tile 值的已打出牌与明牌区牌加 .weak-highlight，
  // 一眼看全该牌已见张数（弃牌区+碰/杠区；暗杠他人视角为牌背无 data-tile，自动跳过）
  function applyWeakHighlight() {
    $$('#table-wrap .tile.weak-highlight').forEach((el) => el.classList.remove('weak-highlight'));
    const sel = state.selectedIndex;
    if (sel == null) return;
    const game = state.game;
    if (!game) return;
    const p = game.players && game.players[game.yourSeat];
    if (!p || !p.hand || p.hand[sel] == null) return;
    const tile = p.hand[sel];
    $$('#table-wrap .discard-area .tile, #table-wrap .melds .meld .tile').forEach((el) => {
      if (el.dataset.tile === tile) el.classList.add('weak-highlight');
    });
  }

  // 选中/切换选中后局部重绘：只更新手牌区与弱高亮，不整桌重绘（避免重置倒计时/操作区）
  function renderSelfHandAndHighlight() {
    const game = state.game;
    if (!game) return;
    const wrap = $('#table-wrap');
    const seat = game.yourSeat;
    const card = wrap.querySelector(`.seat[data-seat="${seat}"] .player-card`);
    if (!card) return;
    const p = game.players && game.players[seat];
    if (!p) return;
    const handTilesBox = card.querySelector('.hand-tiles');
    if (handTilesBox) handTilesBox.innerHTML = (p.hand || []).map((t, i) => selfTileHtml(p, t, i)).join('');
    applyWeakHighlight();
    bindTileClicks();
  }

  function bindTileClicks() {
    const wrap = $('#table-wrap');
    const tiles = wrap.querySelectorAll('.hand-tiles .tile.discardable');
    tiles.forEach((el) => {
      el.onclick = () => {
        const tile = el.dataset.tile;
        const idx = Number(el.dataset.idx);
        const game = state.game;
        if (!game || !game.isDrawTurn) return;
        if (!state.prompt || state.prompt.type !== 'draw') return;
        if (state.tingPick) {
          // 听口：先选中（.selected），再次点击同一张确认报听；仅听口含 ≥6 点牌的选项有效
          // 注意：tingHints[t] 为 0（该听口牌 4 张已全见，绝听）也算有效可报听，只有未进入提示列表（undefined）才拒绝
          const h = game.tingHints && game.tingHints[tile];
          if (h === undefined || h === null) {
            toast('打出这张后听口不含 ≥6 点牌，不能报听', true);
            return;
          }
          if (state.selectedIndex === idx) {
            clearTileSelection();
            send({ type: 'ting', tile });
          } else {
            state.selectedIndex = idx;
            renderSelfHandAndHighlight();
          }
          return;
        }
        // 已报听：摸牌即打，不进入选中交互（与报听阶段语义一致，不受开关影响）
        const me = game.players && game.players[game.yourSeat];
        if (me && me.ting) {
          send({ type: 'play_tile', tile });
          return;
        }
        // 单击直接出牌开关：一次点击直接打出（给熟手提速）
        if (isTapToDiscard()) {
          send({ type: 'play_tile', tile });
          return;
        }
        // 默认选中交互：首次点击选中，再次点击同一张出牌，点击其他张切换选中
        if (state.selectedIndex === idx) {
          clearTileSelection();
          send({ type: 'play_tile', tile });
        } else {
          state.selectedIndex = idx;
          renderSelfHandAndHighlight();
        }
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
      if (p.actions && p.actions.includes('liangjin')) btns += `<button class="act act-gold" data-act="liangjin">亮金</button>`;
      if (p.canDeclareTing && !state.tingPick) btns += `<button class="act act-ting" data-act="ting">报听</button>`;
      if (state.tingPick) {
        btns += `<button class="act act-pass" data-act="ting-cancel">取消</button>`;
        btns += `<span class="countdown" style="align-self:center;">点击要扣的牌选中，再次点击报听</span>`;
      } else {
        btns += `<span class="countdown" style="align-self:center;">${isTapToDiscard() ? '点击手牌出牌' : '点击手牌选中，再次点击出牌'}</span>`;
      }
    } else if (p.type === 'response') {
      if (p.canHu) btns += `<button class="act act-hu" data-act="hu">胡</button>`;
      if (p.canGang) btns += `<button class="act act-gang" data-act="gang">杠</button>`;
      if (p.canPeng) btns += `<button class="act act-peng" data-act="peng">碰</button>`;
      btns += `<button class="act act-pass" data-act="pass">过</button>`;
      const acts = [];
      if (p.canPeng) acts.push('碰');
      if (p.canGang) acts.push('杠');
      if (p.canHu) acts.push('胡');
      const actLabel = acts.length ? acts.join('/') : (p.pendingType === 'qianggang' ? '抢杠胡' : '');
      btns += `<span class="resp-hint">${actLabel ? actLabel + '「' : ''}${tileHtml(p.tile, 'small')}${actLabel ? '」' : ''}</span>`;
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
    else if (act === 'liangjin') send({ type: 'liangjin' });
    else if (act === 'ting') {
      state.tingPick = true;
      state.selectedIndex = null;
      renderTable();
    } else if (act === 'ting-cancel') {
      state.tingPick = false;
      state.selectedIndex = null;
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

  // ================= 聊天消息气泡 =================
  // 服务端 chat 只带 from 昵称，按昵称反查座位号挂气泡；
  // 气泡层挂在 table-wrap 顶层，renderTable 重绘时由调用方保留再同步定位
  const bubbleLayers = new Map(); // seat -> 气泡层 DOM

  function seatOfName(name) {
    const pls = state.room && state.room.players;
    if (!pls) return -1;
    for (let i = 0; i < pls.length; i++) {
      if (pls[i] && pls[i].name === name) return i;
    }
    return -1;
  }

  function seatDir(seat) {
    const wrap = $('#table-wrap');
    const el = wrap && wrap.querySelector(`.seat[data-seat="${seat}"]`);
    if (!el) return 'bottom';
    if (el.className.includes('seat-top')) return 'top';
    if (el.className.includes('seat-left')) return 'left';
    if (el.className.includes('seat-right')) return 'right';
    return 'bottom';
  }

  function getBubbleLayer(seat) {
    let layer = bubbleLayers.get(seat);
    if (!layer || !layer.parentNode) {
      layer = document.createElement('div');
      layer.className = 'bubble-layer';
      bubbleLayers.set(seat, layer);
      const wrap = $('#table-wrap');
      if (wrap) wrap.appendChild(layer);
    }
    return layer;
  }

  // 气泡浮在座位朝向牌桌中央的一侧（bottom=上方 / top=下方 / left=右侧 / right=左侧）
  function repositionBubbleLayer(seat, layer) {
    const wrap = $('#table-wrap');
    const seatEl = wrap && wrap.querySelector(`.seat[data-seat="${seat}"]`);
    if (!wrap || !seatEl) return;
    const sr = seatEl.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = sr.left - wr.left + sr.width / 2;
    const cy = sr.top - wr.top + sr.height / 2;
    const cls = seatEl.className;
    if (cls.includes('seat-bottom')) {
      layer.style.left = cx + 'px';
      layer.style.bottom = (wr.bottom - sr.top + 6) + 'px';
      layer.style.top = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateX(-50%)';
    } else if (cls.includes('seat-top')) {
      layer.style.top = (sr.bottom - wr.top + 6) + 'px';
      layer.style.left = cx + 'px';
      layer.style.bottom = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateX(-50%)';
    } else if (cls.includes('seat-left')) {
      layer.style.left = (sr.right - wr.left + 6) + 'px';
      layer.style.top = cy + 'px';
      layer.style.bottom = 'auto';
      layer.style.right = 'auto';
      layer.style.transform = 'translateY(-50%)';
    } else { // seat-right
      layer.style.right = (wr.right - sr.left + 6) + 'px';
      layer.style.top = cy + 'px';
      layer.style.bottom = 'auto';
      layer.style.left = 'auto';
      layer.style.transform = 'translateY(-50%)';
    }
  }

  function syncBubbleLayers() {
    const wrap = $('#table-wrap');
    if (!wrap) return;
    for (const [seat, layer] of bubbleLayers) {
      if (!layer.parentNode) wrap.appendChild(layer);
      repositionBubbleLayer(seat, layer);
    }
  }

  function showChatBubble(from, text) {
    if (!state.game) return;
    const seat = seatOfName(from);
    if (seat < 0) return;
    const wrap = $('#table-wrap');
    if (!wrap || !wrap.querySelector(`.seat[data-seat="${seat}"]`)) return;
    const layer = getBubbleLayer(seat);
    // 同一座位最多叠 3 条：超出直接移除最旧（避免遮牌）
    const olds = layer.querySelectorAll('.bubble');
    for (let i = 0; i < olds.length - 2; i++) {
      if (olds[i]._timer) clearTimeout(olds[i]._timer);
      olds[i].remove();
    }
    const b = document.createElement('div');
    b.className = 'bubble dir-' + seatDir(seat);
    b.innerHTML = `<span class="b-who">${esc(from)}</span>${esc(text)}`;
    layer.prepend(b);
    repositionBubbleLayer(seat, layer);
    b._timer = setTimeout(() => {
      b.classList.add('leaving');
      setTimeout(() => { b.remove(); }, 380);
    }, 3000);
  }

  // ================= 结算 =================
  // 统一支付明细表：胡牌支付（自摸三家各付1份 / 点炮已报听三家各出1份 / 点炮未报听独赔3份）
  // + 杠分（明杠/补杠=该牌点数，暗杠=点数×2，字牌=10点；再乘杠主扣点，其余三家各付一份）
  // 数据来自后端 winners.payments（[{kind:'hu'|'gang', title, toSeat, toAmount, rows:[{seat,amount,role}]}]）
  function paymentTableHtml(result) {
    const pays = result && result.payments;
    if (!pays || !pays.length) return '';
    const nameOf = (s) => (result.hands && result.hands[s] ? result.hands[s].name : '座位' + s);
    const rowsHtml = pays.map((pay) => {
      const fromTxt = pay.rows.map((r) =>
        `<div class="pay-line">${esc(nameOf(r.seat))} <span class="pay-neg">${r.amount}</span>${r.role ? '<span class="pay-role">（' + esc(r.role) + '）</span>' : ''}${r.formula ? '<span class="pay-formula">' + esc(r.formula) + '</span>' : ''}</div>`
      ).join('');
      const actor = pay.kind === 'gang' ? '杠牌' : '胡牌';
      // 项目列写明谁胡/谁杠/谁点炮：点炮者从付款方行 role 含"放炮者"的行反推
      const discarderRow = pay.rows.find((r) => r.role && r.role.includes('放炮者'));
      let title = pay.title;
      if (pay.kind === 'gang') {
        title = `${nameOf(pay.toSeat)} ${title}`;
      } else {
        title = title
          .replace(/^点炮胡/, `${nameOf(pay.toSeat)} 胡`)
          .replace(/^自摸/, `${nameOf(pay.toSeat)} 自摸`)
          .replace(/^抢杠胡/, `${nameOf(pay.toSeat)} 抢杠胡`);
        if (discarderRow) title = title.replace(/（放炮者[^）]*）/, '').replace(/胡/, `胡（${nameOf(discarderRow.seat)} 点炮）`);
      }
      return `<tr>
        <td class="pay-item">${esc(title)}</td>
        <td class="pay-from">${fromTxt}</td>
        <td class="pay-to"><span class="pay-actor">${actor}</span>${esc(nameOf(pay.toSeat))} <span class="pay-pos">+${pay.toAmount}</span></td>
      </tr>`;
    }).join('');
    return `<div class="settle-gang">
      <div class="settle-sub">支付明细（负数=付出，正数=收入）</div>
      <table class="pay-table">
        <thead><tr><th>项目</th><th>付款方</th><th>收款方</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  }

  /** 红中麻将结算详情（variant==='hongzhong'）：番数倍数 + 扎码 + 支付明细 */
  function buildHZSettleHtml(result, opts = {}) {
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const nameOf = (s) => (result.hands && result.hands[s] ? result.hands[s].name : '座位' + s);
    const handsHtml = (withScore) => (result.hands || []).map((h) => h ? `
        <div class="row">
          <b>${esc(h.name)}${h.seat === result.winnerSeat ? winnerLabel : ''}</b>
          ${h.hand.map((t) => tileHtml(t, 'tiny')).join('')}
          ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds) : ''}
          ${withScore ? `<span style="opacity:.7">${h.roundScore >= 0 ? '+' : ''}${h.roundScore}</span>` : ''}
        </div>` : '').join('');
    const settleHands = `<div class="settle-hands">${handsHtml(result.type === 'hu')}</div>`;
    if (result.type === 'draw') {
      const flowLabel = state.room && state.room.settings && state.room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（红中 · ${flowLabel}）</div></div>` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">牌墙剩 6 墩，流局（红中麻将 · ${flowLabel}）</div></div>
        ${paymentTableHtml(result)}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[result.winnerSeat];
    const winLabel = result.winType === 'zimo' ? '自摸' : result.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    const calcText = '无番制';
    // 扎码牌独立展示：红中 1/5/9 万筒条 及 红中 为中码
    const isZhongMaTile = (t) =>
      t === 'z0' || ((t[0] === 'w' || t[0] === 't' || t[0] === 'b') && ['1', '5', '9'].includes(t[1]));
    const zhaMaBlock = (label, tiles, count, mult) => {
      if (!tiles || !tiles.length) return '';
      const tileSpans = tiles.map((t) =>
        `<span class="zm-tile${isZhongMaTile(t) ? ' zm-hit' : ''}">${tileHtml(t, 'tiny')}</span>`
      ).join('');
      const hitTxt = count > 0 ? `中 ${count} 张 ×${mult || 1}` : '未中';
      return `<div class="settle-zm"><span class="settle-zm-label">${label}（${hitTxt}）</span>${tileSpans}</div>`;
    };
    const zhaBlockMulti = (w) =>
      zhaMaBlock(`${nameOf(w.winnerSeat)} 扎码`, w.zhaMaTiles, w.zhaMaCount || 0, w.zmaMult || 1);
    const zmaBlocks = (result.winners || []).length > 1
      ? result.winners.map(zhaBlockMulti).join('')
      : zhaMaBlock('扎码', result.zhaMaTiles, result.zhaMaCount || 0, result.zmaMult || result.mult || 1);
    const multiText = (result.winners || []).length > 1
      ? `<div class="settle-sub">一炮多响：${result.winners.map((w) =>
          `${nameOf(w.winnerSeat)}（${w.winType === 'zimo' ? '自摸' : w.winType === 'qianggang' ? '抢杠胡' : '点炮胡'}${w.zmaMult ? '，中码×' + w.zmaMult : ''}）`).join('、')}</div>`
      : '';
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · ${calcText} → ${result.score >= 0 ? '+' : ''}${result.score} 分</div>
      </div>${zmaBlocks}${paymentTableHtml(result)}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.score >= 0 ? '+' : ''}${result.score}</div>
        <div class="settle-sub">红中麻将 · ${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)}</div>
        <div class="settle-sub">${calcText}</div>
        ${multiText}
      </div>
      ${zmaBlocks}
      ${paymentTableHtml(result)}
      ${settleHands}`;
  }

  /** 运城贴金麻将结算详情（variant==='tiejin'）：金母/金牌/亮金/锁金 + 金分 + 支付明细 */
  function buildTieJinSettleHtml(result, opts = {}) {
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const winSeat = result.winner != null ? result.winner : result.winnerSeat;
    const nameOf = (s) => (result.hands && result.hands[s] ? result.hands[s].name : '座位' + s);
    const handsHtml = (withScore) => (result.hands || []).map((h) => h ? `
        <div class="row">
          <b>${esc(h.name)}${h.seat === winSeat ? winnerLabel : ''}</b>
          ${h.hand.map((t) => tileHtml(t, 'tiny', 0, false, false, undefined, false, result.goldTile)).join('')}
          ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds, false, result.goldTile) : ''}
          ${withScore ? `<span style="opacity:.7">${h.roundScore >= 0 ? '+' : ''}${h.roundScore}</span>` : ''}
        </div>` : '').join('');
    const settleHands = `<div class="settle-hands">${handsHtml(result.type === 'hu')}</div>`;
    const goldBlock = result.goldMother && result.goldTile
      ? `<div class="settle-sub">金母 ${tileHtml(result.goldMother, 'tiny', 0, false, false, undefined, false, result.goldMother)} → 金牌 ${tileHtml(result.goldTile, 'tiny', 0, false, false, undefined, false, result.goldTile)}（${result.scoreMode === 'B' ? '125体系' : '边趣计分'}）</div>`
      : '';
    const shangjinBlock = (result.shangjinCount || []).map((c, s) =>
      c > 0 ? `<span class="settle-sub" style="display:inline-block;margin-right:10px;">${esc(nameOf(s))} 亮金 ${c}</span>` : ''
    ).join('');
    const locked = (result.locked || []).some(Boolean);
    const lockBlock = locked
      ? `<div class="settle-sub">锁金状态：${result.locked.map((v, s) => `${esc(nameOf(s))}${v ? '（锁）' : '（解）'}`).join(' ')}${result.lockSeat != null ? ' · 锁家：' + esc(nameOf(result.lockSeat)) : ''}</div>`
      : '';
    const pays = result.payments || [];
    const payBlock = pays.length
      ? `<div class="settle-gang"><div class="settle-sub">支付明细（负数=付出，正数=收入）</div>
          <table class="pay-table">
            <thead><tr><th>项目</th><th>付款方</th><th>收款方</th></tr></thead>
            <tbody>${pays.map((pay) => `
              <tr>
                <td class="pay-item">${esc(pay.role || '胡牌')}${pay.formula ? '<span class="pay-formula">' + esc(pay.formula) + '</span>' : ''}</td>
                <td class="pay-from"><div class="pay-line">${esc(nameOf(pay.from))} <span class="pay-neg">${pay.amount}</span></div></td>
                <td class="pay-to"><span class="pay-actor">胡牌</span>${esc(nameOf(pay.to))} <span class="pay-pos">+${pay.amount}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`
      : '';
    if (result.type === 'draw') {
      const flowTxt = (result.gangLogs || []).length > 0 ? '，有杠下家坐庄' : '，无杠庄家连庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（运城贴金 · ${flowTxt}）</div></div>${goldBlock}${shangjinBlock}${lockBlock}` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">流局（运城贴金麻将${flowTxt}，杠分不计）</div></div>
        ${goldBlock}
        ${shangjinBlock}
        ${lockBlock}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[winSeat];
    const winLabel = result.winType === 'zimo' ? '自摸' : result.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · 亮金 ${result.goldCount || 0} 张 · 金分 ${result.goldScore || 0} → ${result.winnerGain >= 0 ? '+' : ''}${result.winnerGain} 分</div>
      </div>${goldBlock}${shangjinBlock}${lockBlock}${payBlock}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.winnerGain >= 0 ? '+' : ''}${result.winnerGain}</div>
        <div class="settle-sub">运城贴金麻将 · ${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)}</div>
        <div class="settle-sub">亮金 ${result.goldCount || 0} 张（三金封顶）· 金分 ${result.goldScore || 0}${result.huGain ? ' · 胡分 ' + result.huGain : ''}</div>
        ${goldBlock}
        ${shangjinBlock}
        ${lockBlock}
      </div>
      ${payBlock}
      ${settleHands}`;
  }

  /**
   * 结算详情公共渲染：单局结算（showSettlement）与房间结算"最后一局"（showSettleModal）共用，
   * 消除约 60+ 行重复模板。内部复用 paymentTableHtml / tileText / tileHtml / renderMelds / esc。
   * @param {object} result 结算数据（type='hu'|'draw'，含 hands/kouPoints/winnerSeat/payments 等）
   * @param {object} [opts]
   * @param {string} [opts.prefix='']  头部前缀，房间结算用"最后一局："
   * @param {string} [opts.winnerLabel='（胡）'] 胜者手牌标记，单局结算"（胡）"、房间结算"（赢）"
   * @param {boolean} [opts.compact=false] 紧凑单行模式（房间结算），hu 分支分数并入首行、放炮者说明用全角括号；
   *                                        draw 分支省略"牌墙剩 6 墩/听牌者/扣点/支付明细"细节行
   * @returns {string} settle-head + 支付明细 + settle-hands 的 HTML
   */
  function buildSettleHtml(result, opts = {}) {
    if (result && result.variant === 'hongzhong') return buildHZSettleHtml(result, opts);
    if (result && result.variant === 'tiejin') return buildTieJinSettleHtml(result, opts);
    const prefix = opts.prefix || '';
    const winnerLabel = opts.winnerLabel || '（胡）';
    const compact = !!opts.compact;
    const kouText = (result.kouPoints || []).map((v, s) => {
      const nm = result.hands && result.hands[s] ? result.hands[s].name : '座位' + s;
      return `${esc(nm)} 扣${v}点`;
    }).join(' · ');
    const handsHtml = (withScore) => (result.hands || []).map((h) => h ? `
        <div class="row">
          <b>${esc(h.name)}${h.seat === result.winnerSeat ? winnerLabel : ''}</b>
          ${h.hand.map((t) => tileHtml(t, 'tiny')).join('')}
          ${h.melds && h.melds.length ? '<span>|</span>' + renderMelds(h.melds) : ''}
          ${withScore ? `<span style="opacity:.7">${h.roundScore >= 0 ? '+' : ''}${h.roundScore}</span>` : ''}
        </div>` : '').join('');
    const settleHands = `<div class="settle-hands">${handsHtml(result.type === 'hu')}</div>`;
    if (result.type === 'draw') {
      const ting = (result.tingSeats || []).map((s) => result.hands[s] ? result.hands[s].name : '').join('、');
      const flowLabel = state.room && state.room.settings && state.room.settings.dealerFlow === 'keep' ? '庄家连庄' : '下家接庄';
      if (compact) {
        return `<div class="settle-head"><div class="settle-sub">${prefix}流局（${flowLabel}）${ting ? '，听牌者：' + ting : ''}</div></div>` + settleHands;
      }
      return `
        <div class="settle-head"><div class="settle-sub">牌墙剩 6 墩，流局（无分差，${flowLabel}）</div></div>
        <div class="settle-sub">${ting ? '听牌者：' + ting : '无人听牌'}</div>
        <div class="settle-sub">扣点：${kouText}</div>
        ${paymentTableHtml(result)}
        ${settleHands}`;
    }
    const winner = result.hands && result.hands[result.winnerSeat];
    const winLabel = result.winType === 'zimo' ? '自摸' : result.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
    const multText = (result.multNames && result.multNames.length ? result.multNames.join('、') : '平胡');
    const calcText = result.winType === 'zimo'
      ? `${result.tilePoints}点 × 2 × ${result.mult}倍 × 扣${result.kouPoint}点`
      : `${result.tilePoints}点 × ${result.mult}倍 × 扣${result.kouPoint}点`;
    const shooterNote = result.winType !== 'zimo'
      ? (result.discarderTing ? ' · 放炮者已报听，三家各出1份' : ' · 放炮者未报听，独赔3份')
      : '';
    const shooterNoteParen = result.winType !== 'zimo'
      ? (result.discarderTing ? '（放炮者已报听，三家各出1份）' : '（放炮者未报听，独赔3份）')
      : '';
    if (compact) {
      return `<div class="settle-head">
        <div class="settle-sub">${prefix}${winner ? winner.name : ''} ${winLabel} ${tileText(result.tile)} · ${multText} · ${calcText}${shooterNoteParen} → ${result.score >= 0 ? '+' : ''}${result.score} 分</div>
        <div class="settle-sub">扣点：${kouText}</div>
      </div>${paymentTableHtml(result)}` + settleHands;
    }
    return `
      <div class="settle-head">
        <div class="settle-big">${result.score >= 0 ? '+' : ''}${result.score}</div>
        <div class="settle-sub">胡 ${tileText(result.tile)} · ${multText}（×${result.mult}）</div>
        <div class="settle-sub">${calcText}${shooterNote}</div>
        <div class="settle-sub">扣点：${kouText}</div>
      </div>
      ${paymentTableHtml(result)}
      ${settleHands}`;
  }

  function showSettlement(result) {
    if (!result) return;
    const title = $('#settle-title');
    const content = $('#settle-content');
    // ===== 136 张玩法结算：点数 × 牌型倍数 × 扣点（详情统一由 buildSettleHtml 渲染）=====
    if (result.type === 'draw') {
      // 流局：剩 6 墩无人胡，公开听牌者 / 扣点 / 杠分
      title.textContent = '流局';
    } else {
      const ws = result.winner != null ? result.winner : result.winnerSeat;
      const winner = result.hands && result.hands[ws];
      const winLabel = result.winType === 'zimo' ? '自摸' : result.winType === 'qianggang' ? '抢杠胡' : '点炮胡';
      title.textContent = `${winner ? winner.name : ''} ${winLabel}！`;
    }
    content.innerHTML = buildSettleHtml(result, { winnerLabel: '（胡）' });
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
        html += buildSettleHtml(w, { prefix: '最后一局：', winnerLabel: '（赢）', compact: true });
      } else {
        html += buildSettleHtml(w, { prefix: '最后一局：', compact: true });
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
    const koudianTip = '未满 4 人时由 AI 自动补位；关闭则需等满 4 名真人开局。136 张民间通用版（万条筒+东南西北中发白）：开局每人暗扣 1-4 点（本局倍数），报听需听牌中含 6 点及以上牌并扣一张牌上架，报听后禁碰只可杠、摸牌即打；胡牌受点数限制（1/2 点不能胡，3/4/5 点只能自摸，6/7/8/9/字牌=10 点可点炮可自摸）。';
    const hongzhongTip = '红中麻将（112 张，无风）：红中为万能癞子，可代替任意牌；只能自摸或抢杠胡，不能点炮；抢杠仅抢补杠（暗杠不可抢），被抢者按（1手底注+中码数×底注）×3包赔三家；杠牌当场结算（放杠2手、补杠每家1手、暗杠每家2手）；扎码：胡牌后从牌墙翻码，1/5/9 万筒条及红中为中码，每张中码倍数翻一倍；流局庄家连庄。';
    const tiejinTip = '运城贴金麻将（136 张，无花）：翻牌定金母定金牌（序数牌 10-点数、发财即发财、风箭按对牌），金牌亮出为「亮金」独立操作（摸牌后、出牌前亮出金牌摆面前、牌尾补一张、手牌数不变），金牌不可当普通牌打出；亮金一次才有点炮胡资格，亮金区独立展示，三金封顶；连续亮金两张自动锁金（锁定其他三家只能自摸，被锁者亮出最后金牌解锁）；可碰可杠不可吃，无报听；点炮可截胡，过胡在获抓牌权前不能再胡；抢杠算点炮胡（明杠可抢、暗杠不可抢）；字牌整副胡只能自摸且金牌不代；流局模式 A 摸完 / B 剩 10 墩，计分 A 边趣 / B 125，流局杠分不计；谁胡谁坐庄。';
    buildSeg('seg-variant', ['koudian', 'hongzhong', 'tiejin'], (v) => (v === 'hongzhong' ? '红中麻将' : v === 'tiejin' ? '贴金麻将' : '扣点点'), (v) => {
      const hz = v === 'hongzhong';
      const tj = v === 'tiejin';
      $('#settings-hz').classList.toggle('hidden', !hz);
      $('#settings-tiejin').classList.toggle('hidden', !tj);
      $('#settings-136').classList.toggle('hidden', hz || tj);
      $('#create-tip').textContent = hz ? hongzhongTip : tj ? tiejinTip : koudianTip;
    });
    buildSeg('seg-rounds', [4, 8, 12, 0], (v) => (v === 0 ? '不限' : v + ' 局'));
    buildSeg('seg-dealer-flow', ['next', 'keep'], (v) => (v === 'keep' ? '连庄' : '下家接庄'));
    buildSeg('seg-zha-ma', [0, 1, 2, 4, 6], (v) => (v === 0 ? '关' : v + ' 张'));
    buildSeg('seg-draw-end', ['A', 'B'], (v) => (v === 'B' ? 'B 剩10墩流局' : 'A 摸完流局'));
    buildSeg('seg-score-mode', ['A', 'B'], (v) => (v === 'B' ? 'B 125体系' : 'A 边趣计分'));
    $('#create-cancel').onclick = () => hideModal('create-modal');
    $('#settle-close').onclick = () => hideModal('settle-modal');
    $('#create-confirm').onclick = () => {
      const variant = segValue('seg-variant');
      const totalRounds = segValue('seg-rounds');
      const aiFill = $('#opt-aifill').checked;
      const base = { totalRounds, aiFill };
      if (variant === 'hongzhong') {
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'hongzhong',
          zhaMa: segValue('seg-zha-ma'),
        } });
      } else if (variant === 'tiejin') {
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'tiejin',
          drawEndMode: segValue('seg-draw-end'),
          scoreMode: segValue('seg-score-mode'),
        } });
      } else {
        const enableQingYiSe = $('#opt-qingyise').checked;
        const enableYiTiaoLong = $('#opt-yitiaolong').checked;
        const enableShiSanYao = $('#opt-shisanyao').checked;
        const dealerFlow = segValue('seg-dealer-flow') === 'keep' ? 'keep' : 'next';
        send({ type: 'create_room', settings: {
          ...base,
          variant: 'koudian',
          dealerFlow,
          enableKoupoint: $('#opt-koupoint').checked,
          enableQingYiSe, qingYiSeMult: Number($('#opt-qingyise-mult').value) || 4,
          enableYiTiaoLong, yiTiaoLongMult: Number($('#opt-yitiaolong-mult').value) || 4,
          enableShiSanYao, shiSanYaoMult: Number($('#opt-shisanyao-mult').value) || 8,
        } });
      }
      hideModal('create-modal');
    };
  }

  function buildSeg(containerId, values, labelFn, onChange) {
    const c = $('#' + containerId);
    c.innerHTML = values.map((v, i) =>
      `<button class="seg-item ${i === 0 ? 'active' : ''}" data-value="${v}">${labelFn(v)}</button>`).join('');
    c.querySelectorAll('.seg-item').forEach((b) => {
      b.onclick = () => {
        c.querySelectorAll('.seg-item').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        if (onChange) onChange(b.dataset.value);
      };
    });
  }
  function segValue(containerId) {
    const el = $('#' + containerId + ' .seg-item.active');
    if (!el) return '';
    const v = el.dataset.value;
    return /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
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

  // ================= 语音播报 =================
  // 播报走后端预合成缓存：同源 GET /api/tts/audio?text=&voice= 返回已缓存音频 URL（/tts/<voice>/<hash>.mp3），
  // 由麻将 Node 服务在后台调用独立 TTS 服务预合成落盘，前端不再实时跨端口合成，消除出牌播报延迟；
  // 请求失败（服务未启动/网络错误/非 2xx）时降级 Web Speech API（zh-CN）；
  // 出牌报牌名，碰/杠/暗杠/补杠/吃/胡报动作词；
  // 声音选择存 localStorage('kd.voice')：male 男声 / female 女声 / mute 无声，默认无声；
  // 已有用户保存过男声/女声则保持其选择不变（仅影响未设置过的新用户默认值）；
  // 页面加载即 fire-and-forget 触发 /api/tts/warmup 预热常用播报文本；
  // AI（isAI 座位）打牌/碰/杠/胡等动作不播报，仅真人玩家动作播报
  const VOICE_KEY = 'kd.voice';
  const VOICE_GAP_MS = 500; // 同一事件 500ms 内不重复播报
  const ttsCache = new Map(); // key: text|voice -> audio_url，同文本同性别不重复请求
  function readVoiceMode() {
    const v = localStorage.getItem(VOICE_KEY);
    return (v === 'male' || v === 'female' || v === 'mute') ? v : 'mute';
  }
  const voiceState = {
    mode: readVoiceMode(),
    maleVoice: null,
    femaleVoice: null,
    lastSpeakAt: new Map(), // eventKey -> timestamp
    baselineReady: false,
    prevDiscardCounts: [],
    prevMelds: [],
    prevTing: [],
    hadWinners: false,
  };

  const SPEECH_NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SPEECH_HONOR = { e: '东风', s: '南风', x: '西风', n: '北风', z: '红中', f: '发财', p: '白板' };
  // zh-CN 语音按名称启发式匹配性别：常见女声（Huihui/Yaoyao/Xiaoxiao/Yunxi 等）与男声（YunJian/YunYang 等）
  const SPEECH_FEMALE_RE = /huihui|yaoyao|xiaoxiao|yunxi|xiaoyi|meijia|tingting|female|女/i;
  const SPEECH_MALE_RE = /yunjian|yunyang|kangkang|male|男/i;

  function speechSupported() {
    return !!(window.speechSynthesis && typeof window.speechSynthesis.speak === 'function');
  }

  // 牌码 -> 播报文本："w5" -> "五万"、"z" -> "红中"
  function tileSpeech(t) {
    if (!t || t === 'back') return '';
    if (SPEECH_HONOR[t]) return SPEECH_HONOR[t];
    const num = Number(t.slice(1));
    const suit = t[0] === 'w' ? '万' : t[0] === 't' ? '条' : '筒';
    return (SPEECH_NUM_CN[num] || num) + suit;
  }

  function pickVoice(gender) {
    if (!speechSupported()) return null;
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { voices = []; }
    const zh = voices.filter((v) => /^zh/i.test(v.lang || ''));
    if (!zh.length) return null;
    const re = gender === 'female' ? SPEECH_FEMALE_RE : SPEECH_MALE_RE;
    return zh.find((v) => re.test(v.name || '')) || zh[0];
  }

  function setVoiceMode(mode) {
    voiceState.mode = (mode === 'male' || mode === 'female' || mode === 'mute') ? mode : 'mute';
    localStorage.setItem(VOICE_KEY, voiceState.mode);
    // 切换后立即刷新目标语音缓存，下次播报即用新声音
    voiceState.femaleVoice = pickVoice('female');
    voiceState.maleVoice = pickVoice('male');
  }

  // 同源请求后端预合成缓存音频并播放；失败时抛出，由调用方降级到 Web Speech
  async function playViaTTS(text) {
    const key = text + '|' + voiceState.mode;
    let audioUrl = ttsCache.get(key);
    if (!audioUrl) {
      const resp = await fetch('/api/tts/audio?text=' + encodeURIComponent(text) + '&voice=' + encodeURIComponent(voiceState.mode));
      if (!resp.ok) throw new Error('TTS http ' + resp.status);
      const data = await resp.json();
      if (!data || !data.url) throw new Error('TTS no url');
      audioUrl = data.url;
      ttsCache.set(key, audioUrl);
    }
    const audio = new Audio(audioUrl);
    audio.play().catch(() => { /* 播放失败静默 */ });
  }

  // Web Speech 降级播报
  function speakViaSpeech(text) {
    // 无 Web Speech 支持/无声卡：静默降级，不抛错不阻塞交互
    if (!speechSupported()) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1;
      const v = voiceState.mode === 'female' ? voiceState.femaleVoice : voiceState.maleVoice;
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 静默降级 */ }
  }

  function speakText(text, eventKey) {
    if (!text) return;
    // 无声：全局静默跳过（不占用节流 key，切回后立即恢复）
    if (voiceState.mode === 'mute') return;
    // 页面不可见：静默跳过
    if (document.hidden || document.visibilityState === 'hidden') return;
    // 同一事件 500ms 内不重复
    const now = Date.now();
    if (eventKey) {
      const last = voiceState.lastSpeakAt.get(eventKey);
      if (last != null && now - last < VOICE_GAP_MS) return;
      voiceState.lastSpeakAt.set(eventKey, now);
    }
    // 优先本地 TTS；请求失败降级 Web Speech；两者皆不可用时静默不抛错
    playViaTTS(text).catch(() => speakViaSpeech(text));
  }

  function refreshVoicesCache() {
    voiceState.femaleVoice = pickVoice('female');
    voiceState.maleVoice = pickVoice('male');
  }

  function initVoice() {
    refreshVoicesCache();
    if (speechSupported() && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoicesCache);
    }
    // 页面加载即触发后端预合成预热（fire-and-forget，不等待不阻塞）
    if (window.fetch) {
      fetch('/api/tts/warmup').catch(() => { /* 预热失败静默，播报时按需合成 */ });
    }
    // 大厅声音选择控件（进大厅前选择，默认无声）
    const seg = $('#seg-voice');
    if (seg) {
      seg.querySelectorAll('.seg-item').forEach((b) => {
        b.classList.toggle('active', b.dataset.value === voiceState.mode);
        b.onclick = () => {
          seg.querySelectorAll('.seg-item').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          setVoiceMode(b.dataset.value);
        };
      });
    }
  }

  // ===== 手牌点击设置 =====
  // 「单击直接出牌」个人全局设置：默认关闭（走选中交互），勾选后点击手牌直接打出（给熟手提速）
  const TAP_KEY = 'kd.tapToDiscard';
  function isTapToDiscard() {
    const el = $('#opt-tap-discard');
    return !!(el && el.checked);
  }
  function initTapToDiscard() {
    const el = $('#opt-tap-discard');
    if (!el) return;
    el.checked = localStorage.getItem(TAP_KEY) === '1';
    el.addEventListener('change', () => {
      localStorage.setItem(TAP_KEY, el.checked ? '1' : '0');
      if (el.checked) {
        // 开启直接出牌：移除已有选中态并重绘
        clearTileSelection();
        if (state.room && state.room.state === 'playing' && state.game) renderTable();
      }
    });
  }

  function resetVoiceBaseline() {
    voiceState.baselineReady = false;
    voiceState.prevDiscardCounts = [];
    voiceState.prevMelds = [];
    voiceState.prevTing = [];
    voiceState.hadWinners = false;
  }

  function meldSig(m) {
    return (m.type || '') + ':' + (m.tile || '') + ':' + ((m.tiles || []).join(''));
  }

  // 基于每次 game_state 广播做增量检测：出牌、碰/杠/吃、胡
  function checkSpeakEvents(game) {
    if (!game || !game.players) return;
    if (!voiceState.baselineReady) {
      // 首次进入牌局：只建立基线，不播报历史动作，避免把已发生的出牌/明面全报一遍
      for (let seat = 0; seat < game.players.length; seat++) {
        const p = game.players[seat];
        if (!p) continue;
        voiceState.prevDiscardCounts[seat] = (p.discards || []).length;
        voiceState.prevMelds[seat] = (p.melds || []).map(meldSig);
        voiceState.prevTing[seat] = !!p.ting;
      }
      voiceState.hadWinners = !!game.winners;
      voiceState.baselineReady = true;
      return;
    }
    // 出牌：废牌堆新增非牌背牌（'back' 为报听暗扣，不播报）；AI 动作不播报
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const discs = p.discards || [];
      const prev = voiceState.prevDiscardCounts[seat] || 0;
      if (discs.length > prev && !p.isAI) {
        const last = discs[discs.length - 1];
        if (last && last !== 'back') speakText(tileSpeech(last), 'discard:' + seat + ':' + last);
      }
      voiceState.prevDiscardCounts[seat] = discs.length;
    }
    // 报听：非 AI 玩家由未报听 -> 报听（ting false -> true）时播报
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const nowTing = !!p.ting;
      if (nowTing && !voiceState.prevTing[seat] && !p.isAI) {
        speakText('报听', 'ting:' + seat);
      }
      voiceState.prevTing[seat] = nowTing;
    }
    // 碰/杠/暗杠/补杠/吃：明面新增（补杠表现为同一明面由 peng 转为 bugang）；AI 动作不播报
    for (let seat = 0; seat < game.players.length; seat++) {
      const p = game.players[seat];
      if (!p) continue;
      const cur = (p.melds || []).map(meldSig);
      const prev = voiceState.prevMelds[seat] || [];
      if (!p.isAI) {
        for (const cs of cur) {
          if (!prev.includes(cs)) {
            const type = cs.split(':')[0];
            const word = type === 'peng' ? '碰' : type === 'gang' ? '杠' : type === 'angang' ? '暗杠' : type === 'bugang' ? '补杠' : type === 'chi' ? '吃' : '';
            if (word) speakText(word, 'meld:' + seat + ':' + cs);
          }
        }
      }
      voiceState.prevMelds[seat] = cur;
    }
    // 胡：winners 由无到有（点炮/自摸/抢杠胡）；AI 胡牌不播报
    if (game.winners && !voiceState.hadWinners) {
      if (game.winners.type === 'hu') {
        const ws = game.winners.winner != null ? game.winners.winner : game.winners.winnerSeat;
        const winner = game.players[ws];
        if (!winner || !winner.isAI) {
          const wt = game.winners.winType;
          speakText(wt === 'zimo' ? '自摸' : wt === 'qianggang' ? '抢杠胡' : '胡了', 'hu:' + game.roundNo);
        }
      }
    }
    voiceState.hadWinners = !!game.winners;
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
  // 移动端浏览器工具栏遮挡修复：100vh 在手机浏览器含地址栏/底部工具栏，
  // 用真实可视视口高度（visualViewport / innerHeight）重算 room-body 高度；
  // Android 浏览器（Chrome/微信等）横屏时底部工具栏悬浮覆盖页面，需额外预留空间
  function fitViewportHeight() {
    const body = $('.room-body');
    if (!body) return;
    const header = $('.room-header');
    const vh = (window.visualViewport && window.visualViewport.height) ||
               window.innerHeight || document.documentElement.clientHeight;
    const hh = header ? header.offsetHeight : 52;
    // Android 底部工具栏（含手势条）约 56px；竖屏可随滚动收起，横屏常驻，故横屏必留
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    const isLandscape = window.matchMedia && window.matchMedia('(orientation: landscape)').matches;
    const bottom = (isAndroid && isLandscape) ? 56 : 0;
    body.style.height = Math.max(Math.round(vh - hh - bottom), 200) + 'px';
  }
  window.addEventListener('resize', fitViewportHeight);
  window.addEventListener('orientationchange', () => setTimeout(fitViewportHeight, 300));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewportHeight);
  }

  function init() {
    $('#nick-input').value = state.name;
    initCreateModal();
    initVoice();
    initTapToDiscard();
    bindEvents();
    connect();
    // 浏览器工具栏显隐有延迟，多等几次再校准高度，避免刚进入房间时底部被盖
    fitViewportHeight();
    [300, 900, 2000].forEach((ms) => setTimeout(fitViewportHeight, ms));
  }
  init();
})();
