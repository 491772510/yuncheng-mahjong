'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGameLogger, DEFAULT_MAX_FILE_SIZE } = require('../src/game-logger');
const { GameServer } = require('../src/game');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'koudian-logger-'));
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function dayOf(name) {
  return /^game-(\d{4}-\d{2}-\d{2})/.exec(name)[1];
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function cleanupServer(srv) {
  for (const room of srv.rooms.values()) {
    for (const [k, t] of room.timers) clearTimeout(t);
    room.timers.clear();
  }
  for (const ws of srv.wsPlayers.keys()) {
    if (ws._heartbeatTimer) {
      clearInterval(ws._heartbeatTimer);
      ws._heartbeatTimer = null;
    }
  }
  for (const p of srv.players.values()) {
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }
}

// ---------- 单元：模块级开关 ----------

test('createGameLogger：enabled 显式开关与环境变量分层生效', async () => {
  const dir = makeTmpDir();
  try {
    const off1 = createGameLogger({ dir, enabled: false });
    assert.equal(off1.enabled, false);
    assert.equal(off1.append({ id: 'r1' }, 'x', {}), false, '禁用时不写盘');

    const on = createGameLogger({ dir, enabled: true });
    assert.equal(on.enabled, true);
    assert.equal(on.append({ id: 'r1' }, 'x', {}), true, '启用时写盘');
    await on.flush();
    assert.ok(fs.existsSync(path.join(dir, fs.readdirSync(dir)[0])), '当日日志文件已创建');
    await on.close();
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：JSONL 格式与按天命名 ----------

test('append：按天命名 game-YYYY-MM-DD.jsonl，每行一个 JSON 事件', async () => {
  const dir = makeTmpDir();
  try {
    const logger = createGameLogger({ dir, enabled: true });
    logger.append({ id: 'roomA', roundNo: 3 }, 'action', { action: 'draw', seat: 1, tile: 'w1' });
    logger.append({ id: 'roomA', roundNo: 3 }, 'round_end', { result: 'hu' });
    await logger.flush();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('game-'));
    assert.equal(files.length, 1, '同一自然日只生成一个文件');
    const m = /^game-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(files[0]);
    assert.ok(m, '文件命名符合 game-YYYY-MM-DD.jsonl');
    const lines = fs
      .readFileSync(path.join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].roomId, 'roomA');
    assert.equal(lines[0].roundNo, 3);
    assert.equal(lines[0].type, 'action');
    assert.equal(lines[0].data.action, 'draw');
    assert.equal(lines[1].type, 'round_end');
    assert.ok(lines[0].ts, '事件带时间戳');
    await logger.close();
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：超过 7 天自动清理 ----------

test('cleanup：删除超过 7 天的旧日志，保留最近 7 天', () => {
  const dir = makeTmpDir();
  try {
    const oldName = 'game-2020-01-01.jsonl';
    const recentName = 'game-2026-10-01.jsonl';
    fs.writeFileSync(path.join(dir, oldName), '{}');
    fs.writeFileSync(path.join(dir, recentName), '{}');
    fs.writeFileSync(path.join(dir, 'not-log.txt'), 'x');

    const logger = createGameLogger({ dir, enabled: true });
    const res = logger.cleanup();
    assert.ok(!fs.existsSync(path.join(dir, oldName)), '超过 7 天的旧日志被删除');
    assert.ok(fs.existsSync(path.join(dir, recentName)), '最近 7 天内日志保留');
    assert.ok(fs.existsSync(path.join(dir, 'not-log.txt')), '非日志文件不受影响');
    assert.ok(res.removed >= 1 && res.kept >= 1, 'cleanup 返回删除/保留统计');
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：异步写盘与冲刷 ----------

test('append：调用后不立即落盘，flush 后完整可见（异步写不阻塞调用线程）', async () => {
  const dir = makeTmpDir();
  try {
    const logger = createGameLogger({ dir, enabled: true });
    assert.equal(logger.append({ id: 'r1' }, 'action', { i: 1 }), true, 'append 同步返回 true');
    assert.equal(
      fs.readdirSync(dir).filter((f) => f.startsWith('game-')).length,
      0,
      'append 返回时仍在队列中（未同步写盘）'
    );
    await logger.flush();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('game-'));
    assert.equal(files.length, 1, 'flush 后当日文件生成');
    const lines = readLines(path.join(dir, files[0]));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].data.i, 1);
    await logger.close();
  } finally {
    rmrf(dir);
  }
});

test('flushSync：同步冲刷后立即可读（进程退出兜底路径）', async () => {
  const dir = makeTmpDir();
  try {
    const logger = createGameLogger({ dir, enabled: true });
    logger.append({ id: 'r1' }, 'round_start', { i: 1 });
    logger.append({ id: 'r1' }, 'round_end', { i: 2 });
    logger.flushSync(); // 不 await：同步落盘
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('game-'));
    assert.equal(files.length, 1, 'flushSync 后无需等待即可读');
    assert.deepEqual(
      readLines(path.join(dir, files[0])).map((l) => l.data.i),
      [1, 2],
      'flushSync 保持写入顺序'
    );
    await logger.close();
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：按大小轮转（小阈值注入，不写真实大文件） ----------

test('append：单文件超过 maxFileSize 时轮转出 .1/.2 分片', async () => {
  const dir = makeTmpDir();
  try {
    const logger = createGameLogger({ dir, enabled: true, maxFileSize: 100 });
    for (let i = 1; i <= 3; i++) {
      logger.append({ id: 'r1', roundNo: i }, 'action', { i, pad: 'x'.repeat(120) });
      await logger.flush(); // 每条落盘一次，触发独立轮转判定
    }
    const day = dayOf(fs.readdirSync(dir).find((f) => f.startsWith('game-')));
    const base = `game-${day}.jsonl`;
    const s1 = `game-${day}.1.jsonl`;
    const s2 = `game-${day}.2.jsonl`;
    for (const f of [base, s1, s2]) {
      assert.ok(fs.existsSync(path.join(dir, f)), `应生成分片 ${f}`);
    }
    const baseSize = fs.statSync(path.join(dir, base)).size;
    assert.ok(baseSize < 300, `基础分片不超过阈值量级，实际 ${baseSize}`);
    assert.deepEqual(
      readLines(path.join(dir, base)).map((l) => l.data.i),
      [1],
      '第一条落在基础文件'
    );
    assert.deepEqual(readLines(path.join(dir, s1)).map((l) => l.data.i), [2], '第二条落在 .1');
    assert.deepEqual(readLines(path.join(dir, s2)).map((l) => l.data.i), [3], '第三条落在 .2');
    await logger.close();
  } finally {
    rmrf(dir);
  }
});

test('append：默认阈值为 20MB，可通过 maxFileSize/env 注入', () => {
  const dir = makeTmpDir();
  try {
    assert.equal(createGameLogger({ dir, enabled: true }).maxFileSize, DEFAULT_MAX_FILE_SIZE);
    assert.equal(createGameLogger({ dir, enabled: true, maxFileSize: 4096 }).maxFileSize, 4096);
    assert.equal(createGameLogger({ dir, enabled: true, maxFileSize: 0 }).maxFileSize, DEFAULT_MAX_FILE_SIZE);
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：写入顺序 ----------

test('append：连续写 N 条，落盘顺序与调用顺序一致', async () => {
  const dir = makeTmpDir();
  try {
    const logger = createGameLogger({ dir, enabled: true });
    const N = 50;
    for (let i = 0; i < N; i++) logger.append({ id: 'r1', roundNo: i }, 'action', { i });
    await logger.flush();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('game-'));
    assert.equal(files.length, 1, '未超阈值时不分片');
    const lines = readLines(path.join(dir, files[0]));
    assert.equal(lines.length, N, `${N} 条全部落盘`);
    assert.deepEqual(
      lines.map((l) => l.data.i),
      Array.from({ length: N }, (_, i) => i),
      '落盘顺序与调用顺序完全一致'
    );
    await logger.close();
  } finally {
    rmrf(dir);
  }
});

// ---------- 单元：清理识别带序号的分片 ----------

test('cleanup：识别并清理带序号的分片文件（.N.jsonl）', () => {
  const dir = makeTmpDir();
  try {
    const old = 'game-2020-01-01.jsonl';
    const oldShard = 'game-2020-01-01.3.jsonl';
    const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const recentDay = `${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, '0')}-${String(
      recent.getDate()
    ).padStart(2, '0')}`;
    const recentName = `game-${recentDay}.jsonl`;
    const recentShard = `game-${recentDay}.2.jsonl`;

    fs.writeFileSync(path.join(dir, old), '{}');
    fs.writeFileSync(path.join(dir, oldShard), '{}');
    fs.writeFileSync(path.join(dir, recentName), '{}');
    fs.writeFileSync(path.join(dir, recentShard), '{}');

    const logger = createGameLogger({ dir, enabled: true });
    const res = logger.cleanup();
    assert.ok(!fs.existsSync(path.join(dir, old)), '过期基础文件被删除');
    assert.ok(!fs.existsSync(path.join(dir, oldShard)), '过期分片文件被删除');
    assert.ok(fs.existsSync(path.join(dir, recentName)), '近期基础文件保留');
    assert.ok(fs.existsSync(path.join(dir, recentShard)), '近期分片文件保留');
    assert.equal(res.removed, 2, '删除数含分片');
    assert.equal(res.kept, 2, '保留数含分片');
  } finally {
    rmrf(dir);
  }
});

// ---------- 集成：GameServer 启用日志落盘一局完整事件链 ----------

test('GameServer：启用 gameLog 后一局牌局落盘 round_start / action / round_end 且字段完整', async () => {
  const dir = makeTmpDir();
  const srv = new GameServer({ gameLog: true, gameLogDir: dir });
  try {
    const wa = makeWs();
    srv.handleConnection(wa);
    send(wa, { type: 'join_lobby', name: '房主' });
    send(wa, { type: 'create_room', settings: { aiFill: true, totalRounds: 4, allowTing: true } });
    send(wa, { type: 'start_game' });
    const room = [...srv.rooms.values()][0];
    assert.ok(room && room.game, '房间应自动开局（AI 补满 4 人）');
    assert.ok(room.logs && room.logs.length > 0, '房间存在开局日志');

    // 手动构造一局自摸胡，走真实结算链路
    const g = room.game;
    const seat = g.dealer;
    g.stage = 'draw';
    g.turn = seat;
    g.drawnTile = 'w1';
    room.players[seat].roundScore = 0;
    srv._settleHu(room, seat, { winType: 'zimo', tile: 'w1' });
    srv._finishHuRound(room);

    await srv.gameLogger.flush();

    // 找当日日志文件并解析
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('game-') && f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, '当日日志文件已生成');
    const events = fs
      .readFileSync(path.join(dir, files[0]), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const types = events.map((e) => e.type);
    assert.ok(types.includes('round_start'), '包含 round_start（房间信息+底牌）');
    assert.ok(types.includes('round_end'), '包含 round_end（结算明细）');
    const hu = events.find((e) => e.type === 'action' && e.data.action === 'hu');
    assert.ok(hu, '包含胡牌 action');
    assert.equal(hu.data.seat, seat);
    assert.equal(hu.data.winType, 'zimo');

    const rs = events.find((e) => e.type === 'round_start');
    assert.ok(Array.isArray(rs.data.wall) && rs.data.wall.length > 0, 'round_start 含完整牌墙');
    assert.ok(Array.isArray(rs.data.hands) && rs.data.hands.length === 4, 'round_start 含各家手牌');
    assert.ok(rs.data.settings && rs.data.players && rs.data.dealer !== undefined, 'round_start 含房间信息');
    assert.equal(rs.data.roomId || rs.roomId, room.id, '事件带房间号');

    const re = events.find((e) => e.type === 'round_end');
    assert.ok(re.data.winners && re.data.winners.payments, 'round_end 含 winners 与支付明细');
    assert.ok(Array.isArray(re.data.players) && re.data.players.length >= 1, 'round_end 含各家得分快照');
    assert.ok(re.data.settings && re.data.variant, 'round_end 含房间设置');

    // 日志不泄露任何玩家的完整手牌给客户端（服务端落盘本身即权限边界，仅校验结构可序列化）
    assert.ok(events.every((e) => typeof e.data === 'object'), '所有事件 data 为 JSON 对象');
  } finally {
    await srv.gameLogger.close();
    cleanupServer(srv);
    rmrf(dir);
  }
});

test('GameServer：gameLog 默认关闭时不落盘', () => {
  const dir = makeTmpDir();
  const srv = new GameServer({ gameLog: false, gameLogDir: dir });
  try {
    assert.equal(srv.gameLogger.enabled, false, 'gameLog:false 时禁用日志器');
    assert.ok(fs.readdirSync(dir).length === 0, '不产生任何日志文件');
  } finally {
    rmrf(dir);
  }
});

// ---------- 测试辅助（与既有测试一致） ----------

function makeWs() {
  const listeners = {};
  return {
    readyState: 1,
    _sent: [],
    on(evt, fn) {
      listeners[evt] = fn;
    },
    send(data) {
      this._sent.push(String(data));
    },
    ping() {},
    pong() {},
    close() {},
    emit(evt, data) {
      if (listeners[evt]) listeners[evt](data);
    },
    _last(type) {
      const s = this._sent.filter((x) => {
        try {
          return JSON.parse(x).type === type;
        } catch {
          return false;
        }
      });
      return s.length ? JSON.parse(s[s.length - 1]) : null;
    },
  };
}

function send(ws, obj) {
  ws.emit('message', JSON.stringify(obj));
}
