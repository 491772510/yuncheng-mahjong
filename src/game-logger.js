'use strict';

/**
 * 游戏日志模块（Game Logger）
 *
 * 职责：
 *  - 记录每一局牌局的完整详情（round_start / action / round_end），按天落盘到 logs 目录
 *    （logs/game-YYYY-MM-DD.jsonl，JSONL 每行一个事件）
 *  - 自动清理超过 7 天的旧日志文件，仅保留最近 7 天
 *
 * 开关与目录：
 *  - 默认启用（生产/本地运行均落盘）；NODE_ENV === 'test' 或 MARVIS_GAME_LOG === '0' 时静默禁用
 *  - 目录优先取 MARVIS_GAME_LOG_DIR 环境变量（便于测试隔离），否则为项目根 logs 目录
 */

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 7; // 日志保留天数
const FILE_PREFIX = 'game-';

function nowParts(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return { day: `${y}-${m}-${day}`, ts: `${y}-${m}-${day}T${hh}:${mm}:${ss}.${ms}` };
}

function isEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.MARVIS_GAME_LOG === '0') return false;
  return true;
}

/**
 * 创建游戏日志器实例
 * @param {object} opts
 * @param {string} [opts.dir] 日志目录（默认：MARVIS_GAME_LOG_DIR 或项目 logs）
 * @param {boolean} [opts.enabled] 是否启用（默认按环境自动判断；显式传 false 可强制关闭）
 */
function createGameLogger(opts = {}) {
  const dir =
    opts.dir ||
    process.env.MARVIS_GAME_LOG_DIR ||
    path.join(__dirname, '..', 'logs');
  const enabled = opts.enabled !== undefined ? !!opts.enabled : isEnabled();

  function filePathFor(day) {
    return path.join(dir, `${FILE_PREFIX}${day}.jsonl`);
  }

  /** 追加一条事件：{ roomId, roundNo, type, data } → 拼装 JSONL 行并同步追加到当日文件 */
  function append(room, type, data) {
    if (!enabled) return false;
    if (!room || !room.id) return false;
    const { day, ts } = nowParts();
    const entry = {
      ts,
      roomId: room.id,
      roundNo: room.roundNo || 0,
      type,
      data,
    };
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(filePathFor(day), JSON.stringify(entry) + '\n', 'utf8');
      return true;
    } catch (e) {
      console.error('[game-logger] append failed:', e && e.message);
      return false;
    }
  }

  /** 清理超过 RETENTION_DAYS 天的日志文件，保留最近 7 天 */
  function cleanup() {
    if (!enabled) return { removed: 0, kept: 0 };
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    let kept = 0;
    try {
      if (!fs.existsSync(dir)) return { removed, kept };
      const files = fs.readdirSync(dir);
      for (const f of files) {
        // 仅处理 game-YYYY-MM-DD.jsonl 形态的日志文件
        const m = /^game-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
        if (!m) continue;
        const dayTs = new Date(m[1] + 'T00:00:00').getTime();
        if (Number.isNaN(dayTs)) continue;
        if (dayTs < cutoff) {
          try {
            fs.unlinkSync(path.join(dir, f));
            removed++;
          } catch (e) {
            console.error('[game-logger] cleanup failed for ' + f + ':', e && e.message);
          }
        } else {
          kept++;
        }
      }
    } catch (e) {
      console.error('[game-logger] cleanup error:', e && e.message);
    }
    return { removed, kept };
  }

  return { append, cleanup, enabled, dir };
}

module.exports = { createGameLogger, RETENTION_DAYS, FILE_PREFIX };
