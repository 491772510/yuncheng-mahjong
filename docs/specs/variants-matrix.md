# 三玩法差异对照表（koudian / hongzhong / tiejin）

> **本表为现状权威表**：每条都来自实际阅读代码，已标注文件名 + 行号。
> **行号基准**：2026-10-06 快照 —— `src/game.js` **3359** 行 / `src/rules.js` 1155 行 / `public/app.js` 1994 行 / `public/index.html` 202 行。
> ⚠️ `src/game.js` 在整理期间**仍在被外部修改**（本次核对期间从 3302 → 3359 行），
> **行号必然漂移**；若对不上，请按函数名搜索。凡未验证的均标"未验证"。

## 0. 速览

| | 扣点点 `koudian` | 红中 `hongzhong` | 贴金 `tiejin` |
| --- | --- | --- | --- |
| 一句话 | 136 张民间通用版 + 报听 + 点数限制 | 112 张，红中万能癞子，无番制 + 扎码 | 136 张 + 金牌万能 + 亮金/锁金 |
| 落地程度 | ✅ 完整 | 🟡 完整，但 4 项设计未实现 | ✅ 完整 |

## 1. 主对照表

| 维度 | 扣点点 `koudian` | 红中 `hongzhong` | 贴金 `tiejin` |
| --- | --- | --- | --- |
| **牌墙构成** | 136 张：万/条/筒 1-9 各 4（108）+ 东南西北中发白各 4（28）。`rules.createTiles()` `src/rules.js:39-45` | **112 张**：万/条/筒 1-9 各 4（108）+ 红中 `z0` ×4。**无风牌、无白板/发财**。`rules.createTiles112()` `src/rules.js:530-537` | 136 张（同扣点点）；**发牌前从牌墙末翻 1 张「金母」并 pop 掉**，按对牌关系定「金牌」。翻金母 `src/game.js:702` 起（`_dealRound`）；`rules.goldFromMother` `src/rules.js:890-898`、对牌表 `TIEJIN_HONOR_PAIR:887` |
| **起手张数** | 各发 13 张后庄家摸第 14 张开局（`src/game.js:797` 注释"已去除开局扣点玩法"） | 庄 14 / 闲 13，起手即进入出牌（`_startPlay` `src/game.js:3065`） | 庄 14 / 闲 13，起手即进入出牌（同上） |
| **胡牌结构** | 4 面子 + 1 将（任意对子）/ 七小对 / 豪华七小对 / 十三幺。`rules.checkHu` `src/rules.js:211-223`、`checkHuWithMelds:230-247` | 癞子胡：红中抽出为 wild，可补顺/刻/将；支持平胡/碰碰胡/七小对/龙七对/清一色/混一色；**天胡**（起手 4 红中直胡）。`rules.checkHuHongZhong` `src/rules.js:737-760`（天胡 `:751`） | **仅 3+2 基本牌型**（平胡 / 碰碰胡），**不含七小对等特殊牌型**；金牌可补顺/刻/将。`rules.checkHuTieJin` `src/rules.js:915-936` |
| **万能牌** | 无 | 红中 `z0`（本身可碰可杠，但**不可代碰代杠**——碰杠对象必须是真实牌）`src/rules.js:776-787` | 金牌（每局 4 张）；**金牌本身不可碰/杠**，`canPengTieJin` / `canGangTieJin` / `canAnGangTieJin` / `canBuGangTieJin` 均拒绝 `src/rules.js:944-968` |
| **番型倍数** | 平胡 ×1、碰碰胡 ×2、七小对 ×4、豪华七小对 ×8、杠上开花 ×2；清一色 ×4 / 一条龙 ×4 / 十三幺 ×8（**开关默认关**）。`rules.calcMultiplier136` `src/rules.js:418-470` | **无番制**：`fan` 恒为 0、`noFan: true`、`names:['无番']`（`src/game.js:1572-1578`）。倍数只来自扎码 `zmaMult = 2^中码张数`（`:1504`） | **无番**；收益核心是**金分**：按赢家亮金数 3 倍递增、**三金封顶**。A：1/3/9/27（`rules.tiejinGoldScoreA:982-989`）；B：5/15/45/135（`:992-999`）。封顶 `src/game.js:1412` `Math.min(..., 3)` |
| **计分公式** | **双模型** `scoreModel`（默认 `multiply`，`src/game.js:1631`）：<br>· `multiply` = 点数 × 牌型倍数（自摸再 ×2）<br>· `add` = 点数 ×(自摸?2:1) + 固定加分（七小对 +20、豪七 +40、清一色 +20、一条龙 +20）<br>庄底 `zhuangDi`（**默认关**，`:2849`）：开启时仅庄家胡牌单边 +5（非自摸）/+10（自摸），输家不扣（`:1636`）。<br>加算明细见 `rules.calcAddPoints136` `src/rules.js:480-512` | 底注恒 1 分（`src/game.js:1486` 分支注释"扎码无番制"）。<br>· 自摸：每家付 `1×(2 + zmaMult)`<br>· 点炮/抢杠：放炮者（被抢者）**包赔三家** `1×(1 + zmaMult)×3`（`:1524-1545` 附近）<br>杠分已当场结清，结算时只补展示明细 | **A（边趣/大唐，默认）**：胡牌分 H = 闲 1 / 庄 2；自摸每家 `2H + G`；点炮/抢杠三家各 `H + G`，**点炮者金分翻倍**（再 +G）。`rules.calcTieJinScoreA` `src/rules.js:1011-1037`<br>**B（搜狗 125）**：`base = 胡1 + 庄1 + G`，`dealerShare = base + 3`；点炮者再 +1 炮钱。`rules.calcTieJinScoreB` `src/rules.js:1051-1081` |
| **杠分结算时机** | **整局结束统一结算，流局不计**。杠时只 push `gangLogs`（`_settleGangScore` `src/game.js:1083`），胡牌时 `_applyGangScores`（`:1093`）统一入账（调用点 `:1753`）。金额：明杠/补杠 = 牌点数、暗杠 = 牌点 ×2，其余三家各付一份（`kou` 恒 1） | **当场结算**：放杠 = 放杠者独付 2 手（`:1199`）；补杠 = 每家 1 手（`:1371`）；暗杠 = 每家 2 手（`:1253`）。结算时 `_buildGangPayments`（`:1117`）只补展示明细 | **当场结算**：明杠/补杠每家 1 分（`:1215`、`:1387`）、暗杠每家 2 分（`:1269`）；**流局全部回滚**（`_settleDraw` `:1792`、回滚循环 `:1797`） |
| **流局（荒庄）判定** | 牌墙剩 **6 墩 = 12 张** → 流局 `src/game.js:821` | 牌墙**摸完最后一张**（剩 ≤0）→ 流局 `src/game.js:809` | **开关** `drawEndMode`：A = 摸完（剩 ≤0，默认）/ B = 剩 20 张（硬 10 墩）。`_tieJinWallEnded` `src/game.js:3184-3187` |
| **流局处理** | 无分差：**杠分不入账**（`gangLogs` 仅展示 `src/game.js:1825`，`payments` 为空数组）；公开听牌者名单 | 无胡支付；**庄家连庄**；杠分当场已结、**不回滚** | 无胡支付；**杠分回滚**；有杠→下家坐庄，无杠→庄家连庄（`:1844` `lastFlowHadGang`） |
| **庄家流转** | 谁胡谁坐庄（`:746`）；流局按 `dealerFlow`（**默认 `next` 下家接庄** / `keep` 连庄）`：2847`；首局随机 | 谁胡谁坐庄；**流局固定连庄**（`dealerFlow` 硬编码 `'keep'` `:2818`）；首局随机 | 谁胡谁坐庄（庄胡连庄）；**首局由创建房间者坐庄**（`:749-750`）；流局有杠下家、无杠连庄（`dealerFlow` 硬编码 `'flow'` `:2829`） |
| **一炮多响** | ❌ 否：距放炮者最近的一家胡（`:1000`） | ✅ **是**：全部同时胡，`hzWinners` 累计（`:991`） | ❌ 否：**截胡单响**（逆时针最近可胡者，`:906`、`:1000`） |
| **点炮胡** | ✅ 允许（须对方已报听 + 牌点 ≥6；`rules.canHuByPoints` `src/rules.js:325-329`） | ❌ **禁止**（`const canHu = false` `src/game.js:935`；前端徽标 `public/index.html:94`） | ✅ 允许但受限：**必须已亮金且未被锁**（`_tieJinCanDianpao` `:3192`） |
| **抢杠胡** | ✅ 仅补杠可抢，算点炮，由补杠者付，受点数限制（`_doBuGang` `:1282`，判定 `:1315`） | ✅ 仅补杠（`:1305`），暗杠不可抢（`_doAnGang` `:1228` 无抢杠分支）；被抢者包三家 | ✅ 仅补杠可抢、暗杠不可抢（`:1291`）；被抢杠者当放炮者；同样受亮金/锁金限制 |
| **特殊规则** | · **报听（听口）**：`allowTing` 固定 true（`:2840`）；听口须含 ≥6 点牌；报听后**摸牌即打、禁碰只可杠、禁杠听张**（`:948-951`）<br>· 点数限制：1/2 点不能胡；3/4/5 点只能自摸；6/7/8/9/字牌 10 点可点炮可自摸<br>· **包胡（一赔三）**：放炮者**未报听** → 独赔 3 份；已报听 → 三家各付 1 份（`:1665` `discarderTing`、`:1781` 提示文案） | · 红中癞子不可代碰代杠<br>· **扎码**（`zhaMa` 0/1/2/4/6，`:2811`）：胡牌后从牌墙补抓 N 张（`:1498-1500`），中码牌 = 1/5/9 万筒条 + 红中（`rules.ZHONG_MA_TILES` `src/rules.js:790`）<br>· 天胡（起手 4 红中） | · **亮金**：摸牌后出牌前独立操作，金牌摆面前亮金区（不入弃牌堆），从牌墙**尾部**补 1 张，手牌数不变、不轮转（`_liangjin` `:3208`）<br>· **锁金**：累计亮金 ≥2 张自动锁其他三家（`:3241`），被锁者只能自摸；**累计上金达 2 张即解锁**（`:3233-3235`）<br>· 金牌不可普通打出（`_chooseTieJinDiscard` `:3334` 过滤）<br>· **过胡限制**：可胡者主动过/超时 → 下次抓牌权前禁胡（设置 `:1000` 附近，摸牌时解除 `:835`）<br>· 字牌整副胡只能自摸（`rules.isAllHonorShape` `src/rules.js:971-979`） |
| **房间设置项** | `totalRounds`、`aiFill`（`:2838`）、`allowTing`(固定 true)、`enableQingYiSe/Mult`、`enableYiTiaoLong/Mult`、`enableShiSanYao/Mult`、`dealerFlow`、`scoreModel`、`zhuangDi`（`:2834-2850`） | **仅** `totalRounds`、`aiFill`（`:2815`）、`zhaMa`、`dealerFlow`(固定 keep)（`:2811-2819`） | **仅** `totalRounds`、`aiFill`（`:2825`）、`drawEndMode`、`scoreMode`、`dealerFlow`(固定 flow)（`:2821-2829`） |
| **AI 是否已实现** | ✅ 是，`src/ai.js`（`decideDrawAction` / `decideResponse` / `chooseDiscard`，含报听期望值择优 `:44-61`） | ✅ 是，但**在 `src/game.js` 内**：`_decideHongZhongDrawAction` `:3130`、`_chooseHongZhongDiscard` `:3151`、`_decideHongZhongResponse` `:3170` | ✅ 是，但**在 `src/game.js` 内**：`_shouldLiangjinTieJin` `:3294`、`_decideTieJinDrawAction` `:3307`、`_chooseTieJinDiscard` `:3334`、`_decideTieJinResponse` `:3351` |
| **测试覆盖** | `test/rules.test.js`(31) + `test/game.test.js`(51) + `test/ai.test.js`(10) + `test/koudian-zipai.test.js`(6) ≈ **98** | `test/rules-hongzhong.test.js`(36) + `test/game-hongzhong.test.js`(15) ≈ **51** | `test/rules-tiejin.test.js`(31) + `test/game-tiejin.test.js`(39) ≈ **70** |
| **未实现 / 已移除** | 「开局扣点 1-4 点」**已移除**（`src/game.js:797`） | ① 番数表 / 2^番 ② 下炮子（`paoGain` 硬编码 0 `:1578`）③ 二五八将 ④ 胡牌模式 A/B **开关**（固定为 B） | 无（设计条目均已落地） |

> 测试文件用例数为按文件统计的近似值；全量以 `npm test` 汇总为准：**289 pass / 0 fail**（14 个测试文件，2026-10-06 实测）。
> 另有跨玩法测试：`game-logger.test.js`(5)、`security.test.js`(14)、`tts-bridge.test.js`(8)、`voice-signal.test.js`(5)、
> `frontend-voice.test.js`(22)、`frontend-hand-interact.test.js`(16)。

## 2. 三玩法共用与分叉点

共用：
- 规则引擎 `src/rules.js`：三段分区（扣点点 `:1-512` / 红中 `:514-876` / 贴金 `:878-1081`），**新增玩法只加函数、不改既有函数**（各段头部注释均如此声明）。
- 状态机 `src/game.js` 的 `GameServer`：`_dealRound:702`、`_drawCard:805`、`_afterDiscard:901`、`_settleHu`、`_settleDraw:1792` 内部按 `_isHongZhong`（`:3055`）/ `_isTieJin`（`:3179`）分支。
- 前端：`public/index.html` 创建房间弹窗顶部「玩法」下拉框（`seg-variant`，`public/app.js:1569`）切换 `settings-hz` / `settings-tiejin` / `settings-136` 三个开关区；结算页按 `result.variant` 分派 `buildHZSettleHtml`（`public/app.js:1269`）/ `buildTieJinSettleHtml`（`:1333`）/ 扣点点分支。

主要分叉点（读代码时优先看这几处）：
1. `_validateSettings` `src/game.js:2803`：按 `variant` 返回**完全不同的设置对象**。
2. `_afterDiscard` `src/game.js:901`：响应判定三分支（贴金截胡单响 `:906` / 红中禁点炮 `:935` / 扣点点报听限制 `:948-951`）。
3. `_settleHu` 内三个分支：贴金 `:1410`、红中 `:1486`、扣点点 `:1624`。
4. `_settleDraw` `src/game.js:1792`：流局分支（贴金回滚杠分 `:1797` / 红中连庄 / 扣点点 6 墩）。

## 3. 未验证 / 存疑项

- `src/rules.js:435`：`calcMultiplier136` 判断十三幺时**未检查 `yao.enabled`**，即开关关闭时十三幺仍按 `yao.mult`（默认 8）计。代码行为已核实，**是否为预期未验证**（清一色/一条龙均有 `enabled` 判断，唯独十三幺没有）。
- 红中「放杠（明杠）」在代码里以"手（分）"计（`:1199`，放杠者独付 2 手），与未落地的番数表「明杠 +1 番」无对应关系；**番数制整体未实现**。
- 各玩法在真实对局中的平衡性、AI 强度对比：**未验证**（无对局数据支撑）。
- 前端 `public/app.js:1568` 贴金提示文案写"被锁者亮出最后金牌解锁"，与代码「累计 2 张解锁」不符；属文案遗留，**是否已排期修复未验证**。
- 大厅房间卡片「AI补位 / 无AI」展示（`public/app.js` 附近）：未逐行核对，**未验证**。
