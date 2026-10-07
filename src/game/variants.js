'use strict';

/**
 * 三种玩法的「决策分发表」（策略表方案的落地载体）。
 *
 * 目标：把核心状态机里重复出现的「按 variant 三选一」的分叉（AI 出牌决策、AI 响应决策、
 * 出牌提示构建）收敛为一张查表，主流程读表而非写 if(isHz)/else if(isTj)/else。
 *
 * 关键设计：这里不存放具体实现（红中/贴金的方法依赖 GameServer 的 this 与游戏状态，
 * 无法作为纯函数抽离），而是存放「方法名」。GameServer 通过 this[handlerName](...) 调用，
 * 从而在保持 this 上下文正确的前提下，把分叉逻辑从 if 链变成数据驱动。
 * 新增玩法：在此登记一行，无需改动主流程的 if 分支。
 */

const handlers = {
  // 扣点点（默认 136 张）：通用 AI + 通用出牌提示
  koudian: {
    decideDrawAction: 'ai.decideDrawAction',   // 特例：直接调用 ai 模块的通用实现
    decideResponse: 'ai.decideResponse',
    buildDrawPrompt: '_buildDrawPrompt',        // game.js 默认实现
  },
  // 红中（112 张无风）：专用 AI + 专用提示
  hongzhong: {
    decideDrawAction: '_decideHongZhongDrawAction',
    decideResponse: '_decideHongZhongResponse',
    buildDrawPrompt: '_buildDrawPromptHongZhong',
  },
  // 贴金（136 张金牌万能）：专用 AI + 专用提示
  tiejin: {
    decideDrawAction: '_decideTieJinDrawAction',
    decideResponse: '_decideTieJinResponse',
    buildDrawPrompt: '_buildDrawPromptTieJin',
  },
};

/**
 * 归一化 variant：任意输入 → 三种之一，非法值回落 koudian。
 * 与 game.js _validateSettings 里的归一化保持一致。
 */
function normalizeVariant(v) {
  if (v === 'hongzhong') return 'hongzhong';
  if (v === 'tiejin') return 'tiejin';
  return 'koudian';
}

/** 取某个房间的玩法 handler 表（只读，勿改） */
function handlersOf(room) {
  const v = room && room.settings ? room.settings.variant : 'koudian';
  return handlers[normalizeVariant(v)] || handlers.koudian;
}

module.exports = { handlers, normalizeVariant, handlersOf };
