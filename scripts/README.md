# Smoke 测试（真机端到端）

这三个脚本是**真机冒烟测试**，与 `test/` 下的单元测试不同：它们连接一个**真实运行中的 server.js**（默认 `localhost:3100`），覆盖 HTTP + WebSocket 全流程与安全护栏。

## 前置条件

先启动服务端：

```bash
npm start
```

## 运行

```bash
npm run smoke          # 核心冒烟：HTTP + 建房间 + 发牌 + 重连安全 + 限频
node scripts/smoke-auth.js           # 注册/登录/历史/账户关联
node scripts/smoke-history-e2e.js    # 打完一局后历史对局落盘
```

## 各脚本覆盖

| 脚本 | 覆盖点 |
|---|---|
| `smoke-real.js` | HTTP 首页、join_lobby 下发 secret、建房间、发牌、错误/正确 secret 重连、超长消息帧层防御、房间码暴力枚举限频 |
| `smoke-auth.js` | 注册、错误密码登录被拒、token 登录、历史记录、账户昵称覆盖、弱密码被拒 |
| `smoke-history-e2e.js` | 登录用户打完一局后历史对局记录落盘并可查询 |

> 注：端口写死为 `3100`，与 `server.js` 默认 `PORT` 一致。如需改端口，需同步修改脚本内 `URL`/`port` 常量。
