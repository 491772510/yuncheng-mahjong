'use strict';

// ============ 共享测试基建 ============
// 收敛各游戏流程测试文件里重复的伪 WebSocket 客户端与 server 生命周期工具，
// 统一随机源注入（可复现种子）与心跳参数（极小间隔，避免 pending timer 拖慢进程退出）。

const assert = require('node:assert/strict');
const { GameServer } = require('../src/game');

/**
 * 可复现的伪随机数生成器（mulberry32）。同一 seed 产同一序列，
 * 让「牌墙 / 金母 / 庄家」等随机点在测试里完全确定。
 * 返回一个 [0,1) 的纯函数，可直接作为 GameServer 的 rng 注入。
 */
function seededRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 伪 WebSocket 客户端：记录 sent 消息流，便于用 lastOf(type) 断言 */
function makeWs() {
  const ws = { readyState: 1, sent: [], handlers: {}, pingCount: 0, terminated: false };
  ws.on = (type, cb) => { ws.handlers[type] = cb; };
  ws.send = (data) => { ws.sent.push(JSON.parse(data)); };
  ws.ping = () => { ws.pingCount += 1; };
  ws.terminate = () => {
    if (ws.terminated) return;
    ws.terminated = true;
    ws.readyState = 3;
    if (ws.handlers.close) ws.handlers.close();
  };
  return ws;
}

/** 模拟客户端发消息 */
function send(ws, obj) {
  ws.handlers.message(JSON.stringify(obj));
}

/** 取该连接收到的最后一个指定类型消息（无则 null） */
function lastOf(ws, type) {
  const list = ws.sent.filter((m) => m.type === type);
  return list.length ? list[list.length - 1] : null;
}

/** 取该连接收到的所有指定类型消息 */
function allOf(ws, type) {
  return ws.sent.filter((m) => m.type === type);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 测试心跳参数：间隔注入极小值（10ms），让挂在事件循环上的 interval 不再按生产
// 的 30s 拖延进程退出；同时把「最大丢失次数」放大——伪 ws 永不回 pong，若沿用生产
// 阈值 3，任何一次 sleep 都会被误判死连接而 terminate，污染其余用例的断言。
// 需要真实 miss 语义的心跳用例自行用 newServer({ heartbeatMaxMiss: HEARTBEAT_MAX_MISS }) 覆盖。
const TEST_HEARTBEAT = { heartbeatIntervalMs: 10, heartbeatMaxMiss: 10000 };

/**
 * 新建测试用 GameServer。默认注入可复现 rng（seed 固定，杜绝随机 flaky），
 * 并套用 TEST_HEARTBEAT 极小间隔。opts 可覆盖 rng / heartbeat* / gameLog 等任意字段。
 */
function newServer(opts = {}) {
  const { rng = seededRng(), ...rest } = opts;
  return new GameServer({ gameLog: false, ...TEST_HEARTBEAT, rng, ...rest });
}

/**
 * 清理 server 所有定时器，避免 node --test 因 pending timer 拖慢退出。
 * stop() 以「句柄集合 + 全量登记」为准清理，覆盖已离开房间 / 已超时移除 /
 * 从未 join 的连接，无需再手动遍历 room.timers / players。
 */
function cleanupServer(srv) {
  if (typeof srv.stop === 'function') srv.stop();
}

module.exports = {
  seededRng,
  makeWs,
  send,
  lastOf,
  allOf,
  sleep,
  newServer,
  cleanupServer,
  TEST_HEARTBEAT,
  assert,
};
