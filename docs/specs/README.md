# 文档索引（运城麻将 / 三玩法）

> 本目录为**现状索引层**：只描述"代码现在是什么样"，不描述"当初想做成什么样"。
> 所有结论均来自实际阅读代码，并标注文件名 + 行号。
> **行号基准**：2026-10-06 快照（`src/game.js` **3359** 行 / `src/rules.js` 1155 行 / `public/app.js` 1994 行）。
> ⚠️ `src/game.js` 在整理期间仍在持续变动（本次核对期间从 3302 → 3359 行），**行号必然漂移**，请以函数名为准。

## 1. 先看哪份？

1. **[variants-matrix.md](./variants-matrix.md)** —— 三玩法（koudian / hongzhong / tiejin）横向对照表。**最权威、最新**。
2. **[glossary.md](./glossary.md)** —— 术语表，每个术语都标注了"当前代码是否已实现"。
3. 玩法设计文档（历史，含失效标注）——仅在需要了解设计意图或补做未实现功能时查阅。

## 2. 文档状态表

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| `docs/specs/variants-matrix.md` | ✅ **有效** | 本次新建，三玩法现状对照 |
| `docs/specs/glossary.md` | ✅ **有效** | 本次新建，术语 + 实现状态 |
| `docs/specs/README.md`（本页） | ✅ **有效** | 索引 |
| `docs/superpowers/specs/2026-10-01-tiejin-mahjong-design.md` | 🟡 **部分失效（已校订）** | 玩法已完整落地；"AI 补位默认关""锁金解锁条件""AI 在 ai.js""用例数"等描述原与代码不符，已于 2026-10-06 就地修正并加 ⚠️ 标注 |
| `docs/superpowers/specs/2026-09-30-hongzhong-mahjong-design.md` | 🟡 **部分失效（已校订）** | 牌具/癞子胡/扎码/天胡已实现；**番数表、下炮子、二五八将、胡牌模式 A/B 开关四项从未实现**，已于 2026-10-06 显式标注"未实现（规划中）" |
| `docs/superpowers/specs/2026-08-23-koudian-mahjong-design.md` | 🔴 **历史基线（已降级）** | 原自称"权威版本"，实际行数/玩法/计分/杠分/定庄/依赖全部过期。已加顶部降级声明 + 正文 ⚠️ 标注。**仅供追溯规则来源，禁止据此开发** |
| `docs/superpowers/specs/2026-09-01-refactor-code-structure.md` | ⬜ **未核对** | 本次任务未逐条核对，引用前请自行验证 |

## 3. 各玩法文档 ↔ 代码对应关系

| 玩法 | `settings.variant` | 主要规则代码 | 主要流程代码 | AI 代码 | 测试 |
| --- | --- | --- | --- | --- | --- |
| 扣点点 | `koudian`（默认） | `src/rules.js` 通用段（`:1-512`）+ `calcMultiplier136`(`:418`) / `calcAddPoints136`(`:480`) | `src/game.js` 主流程 + `_settleHu` 扣点点分支（`:1624`） | **`src/ai.js`**（162 行） | `test/rules.test.js`、`test/game.test.js`、`test/ai.test.js`、`test/koudian-zipai.test.js` |
| 红中 | `hongzhong` | `src/rules.js` 红中段（`:514-876`），核心 `checkHuHongZhong`(`:737`) | `src/game.js` 红中模块（`_isHongZhong:3055`，结算分支 `:1486`） | **`src/game.js`**（`_decideHongZhongDrawAction:3130` 等） | `test/rules-hongzhong.test.js`、`test/game-hongzhong.test.js` |
| 贴金 | `tiejin` | `src/rules.js` 贴金段（`:878-1081`），核心 `checkHuTieJin`(`:915`)、`calcTieJinScoreA/B`(`:1011`/`:1051`) | `src/game.js` 贴金模块（`_tieJinWallEnded:3184`、`_liangjin:3208`） | **`src/game.js`**（`_shouldLiangjinTieJin:3294`、`_decideTieJinDrawAction:3307` 等） | `test/rules-tiejin.test.js`、`test/game-tiejin.test.js` |

**三玩法共用**：`src/rules.js`（同一文件分三段，互不修改既有函数）、`src/game.js` 的 `GameServer`
（`_validateSettings:2803`、`_afterDiscard:901`、`_settleHu`、`_settleDraw:1792` 内按 variant 分支）、
`public/app.js`、`public/index.html` 的创建房间弹窗（`variant` 下拉框切换不同开关区）。

## 4. 一句话现状

- 项目名仍叫"扣点点"，但已是**三玩法并存**；**「开局扣点」玩法已被移除**（`src/game.js:797` 注释，`public/`、`src/` 中已无该字段，仅 `test/game.test.js` 有一条反向断言（约 1186 行）确认其不存在）。
- 测试：`npm test` → **289 pass / 0 fail**（14 个测试文件）。
- 红中玩法有 4 项设计**从未实现**：番数表、下炮子、二五八将、胡牌模式 A/B 开关。
- 贴金玩法功能已完整落地，但文档中"AI 补位默认关"是错的（实际默认开）。

## 5. 维护约定

- 改代码后同步更新 `variants-matrix.md`（它是唯一要求"与代码一致"的表）。
- 历史设计文档**不要整篇重写或删除**：加顶部声明 + 正文 ⚠️ 标注即可，保留演进痕迹。
- 无法确认的内容一律写"未验证"，不得推测。
