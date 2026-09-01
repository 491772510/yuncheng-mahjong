# 运城扣点点麻将 Web 应用 - 代码结构重构记录

日期：2026-09-01
状态：已完成（npm test 103/103 全绿）；本文档记录 2026-09-01 代码结构重构与 TTS 后移改造补录

## 1. 目标

在不改变任何外部行为的前提下，消除两处重复代码，提升可维护性：

1. `src/rules.js` 中 `checkHu` 与 `checkHuWithMelds` 末尾完全相同的"遍历牌计数找将牌"循环 → 抽取公共函数 `_tryPairAsEye`。
2. `public/app.js` 中单局结算 `showSettlement` 与房间结算"最后一局" `showSettleModal` 约 60+ 行重复的结算渲染模板 → 抽取公共函数 `buildSettleHtml`。
3. 顺带补录上一轮已完成但未入文档的 **TTS 后移改造**（后端预合成缓存），使本文档与当前代码实现保持一致。

## 2. 重构一：rules.js 抽取 `_tryPairAsEye`

### 2.1 动机

`checkHu`（原 L179-200）与 `checkHuWithMelds`（原 L202-227）末尾均存在逐字相同的循环：

```js
for (const [tile, c] of cnt) {
  if (c >= 2) {
    const c2 = new Map(cnt);
    const r = c - 2;
    if (r === 0) c2.delete(tile);
    else c2.set(tile, r);
    if (canFormMelds(c2, meldCount)) return true;
  }
}
return false;
```

两处逻辑完全一致：遍历牌计数找任意可作将牌的牌张（`c >= 2`），移除 2 张后调用 `canFormMelds` 验证剩余牌能否组成 `meldCount` 组面子。复制粘贴导致后续修改需同步两处，容易遗漏。

### 2.2 改动

- 新增模块内私有函数（沿用 `_` 前缀私有函数命名惯例）：

```js
/**
 * 尝试任一对子作为将牌：遍历 cnt 找 c>=2 的牌，移除 2 张后验证剩余牌能否组成 meldCount 组面子。
 * @param {Map<string, number>} cnt 牌计数
 * @param {number} meldCount 需要组成的面子数
 * @returns {boolean}
 */
function _tryPairAsEye(cnt, meldCount) {
  for (const [tile, c] of cnt) {
    if (c >= 2) {
      const c2 = new Map(cnt);
      const r = c - 2;
      if (r === 0) c2.delete(tile);
      else c2.set(tile, r);
      if (canFormMelds(c2, meldCount)) return true;
    }
  }
  return false;
}
```

- `checkHu` 末尾改为 `return _tryPairAsEye(cnt, meldCount);`
- `checkHuWithMelds` 末尾改为 `return _tryPairAsEye(cnt, meldCount);`

### 2.3 行为等价保证

- `checkHu` 的 `hand.length % 3 !== 2`、`hand.length === 2` 提前返回、`isQiDui` 提前返回分支**保持不变**；
- `checkHuWithMelds` 的 meld 类型/数量校验、`need` 长度校验**保持不变**；
- 两处 `cnt` 与 `meldCount` 的构造逻辑不变，仅将循环替换为对 `_tryPairAsEye` 的调用，语义逐字等价。

## 3. 重构二：app.js 抽取 `buildSettleHtml`

### 3.1 动机

`showSettlement`（原 L896-966，单局结算弹窗）与 `showSettleModal`（原 L996-1047，房间结算"最后一局"部分）存在约 60+ 行重复：

- 扣点 `kouText` 构造（遍历 `kouPoints` 拼"名字 扣N点"）；
- `hu` 分支的结算头部（`winLabel` / `multText` / `calcText` / 放炮者已报听·三家各出 1 份 or 未报听·独赔 3 份说明）；
- `draw` 分支的流局头部（听牌者 / 庄家连庄·下家接庄说明）；
- `settle-hands` 玩家手牌列表渲染（`tileHtml` + `renderMelds` + 胜者标记 + 单局分数）；
- `paymentTableHtml(result)` 调用。

### 3.2 改动

新增公共函数：

```js
function buildSettleHtml(result, opts = {})
```

参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `result` | - | 结算数据（`type='hu'|'draw'`，含 hands/kouPoints/winnerSeat/payments 等） |
| `opts.prefix` | `''` | 头部前缀，房间结算用 `最后一局：` |
| `opts.winnerLabel` | `（胡）` | 胜者手牌标记，单局结算 `（胡）`、房间结算 `（赢）` |
| `opts.compact` | `false` | 紧凑单行模式（房间结算）：hu 分支分数并入首行、放炮者说明用全角括号；draw 分支省略"牌墙剩 6 墩 / 听牌者 / 扣点 / 支付明细"细节行 |

- 内部复用现有 `paymentTableHtml(result)`、`tileText`、`tileHtml`、`renderMelds`、`esc`；
- `showSettlement`：hu/draw 两分支全部改走 `buildSettleHtml(result, { winnerLabel: '（胡）' })`，仅保留标题赋值与弹窗显隐；
- `showSettleModal`：hu 分支改走 `buildSettleHtml(w, { prefix: '最后一局：', winnerLabel: '（赢）', compact: true })`，draw 分支改走 `buildSettleHtml(w, { prefix: '最后一局：', compact: true })`；
- `showSettleModal` 的标题（🏆 房间结算）、玩家积分榜排序渲染（`sorted.map` 部分）**保持不动**，仅替换"最后一局"详情部分。

### 3.3 行为等价保证

- 单局结算 hu 分支：`settle-head`（settle-big 大分数 + 胡牌说明 + calcText + 放炮者说明 + 扣点）、支付明细、带分数手牌列表逐字与原模板一致；
- 单局结算 draw 分支：牌墙剩 6 墩 / 听牌者 / 扣点 / 支付明细 / 无分数手牌列表与原模板一致；
- 房间结算 hu 分支：`最后一局：` 单行头部 + 扣点 + 支付明细 + 带 `（赢）` 标记与分数的手牌列表与原模板一致；
- 房间结算 draw 分支：`最后一局：流局（庄家流转）` 单行头部 + 无分数手牌列表与原模板一致。

## 4. 补录：TTS 后移改造（预合成缓存）

> 本节为上一轮（2026-08 底）已完成改造的文档补录，使 specs 与当前代码一致。

### 4.1 背景

原前端实时 TTS 方案为浏览器 `speechSynthesis` 直接合成，受本地语音包与合成延迟影响，播报有明显卡顿。改造后改为 **后端 Node 服务预合成 + 缓存**：浏览器请求同源 `/api/tts/audio`，由后端转调独立 Python TTS 服务（`http://127.0.0.1:8000/api/tts`）合成 MP3，落盘缓存后返回同源 URL 播放，消除播报延迟。

### 4.2 后端（server.js）

- `GET /api/tts/audio?text=&voice=`：调用独立 Python TTS 服务合成音频，下载至 `public/tts/<voice>/<md5>.mp3`，内存 + 文件双缓存；返回 `{url}`（同源相对路径，如 `/tts/male/xxx.mp3`）。voice 非法返回 400，服务不可用返回 502。
- `GET /api/tts/warmup`：后台预热常用播报文本（34 种牌名 + 8 个动作词），立即返回 `{started:true}`，不阻塞请求。
- 静态服务补充 `.mp3` MIME 类型；`public/tts` 为缓存目录，已加入 `.gitignore`。

### 4.3 前端（public/app.js）

- 新增 `src/tts-bridge.js`（`getAudioUrl` / `warmup` / `PRESET_TEXTS` 34 牌名 + 8 动作词）；
- `playViaTTS` 改为 fetch **同源** `/api/tts/audio` 获取缓存音频 URL 播放，保留 `ttsCache` 与 `speechSynthesis` 降级链路（服务不可用 / 非 2xx / 静音模式均安全降级）；
- 移除原跨端口直连逻辑（`ttsBaseUrl` / `TTS_KEY` / `TTS_PORT`）。

### 4.4 测试

- `test/tts-bridge.test.js`：8 项用例（PRESET_TEXTS 覆盖、首次合成写文件、二次命中缓存、voice 非法抛错、合成失败抛错、warmup 并发限流与失败静默）；
- `test/frontend-voice.test.js` 同步更新：同源请求 / 女声 voice / 降级分支用例；
- npm test 全绿通过（103/103），实际联调验证：五万 male 返回 `/tts/male/...mp3`、voice 非法 400、warmup 正常、`public/tts` 缓存落盘。

## 5. 测试与提交

- 重构后 `npm test`：**103/103 全绿**（覆盖 checkHu/checkHuWithMelds 全部既有用例，行为不变）；
- `node --check public/app.js` 语法校验通过；
- commit：`refactor: 抽取公共函数消除重复 + 文档补齐`。
