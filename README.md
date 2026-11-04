# 凌雾DSH对话花费

> 给 [DeepSeek Harness（DSH）](https://deepseek-harness.github.io/deepseek-harness/) Web GUI 装一张「每轮小票」：
> **每轮对话花了多少人民币、多少 token、缓存命中多少**，并用余额变化**对账出实际扣费**；
> 会话头部还常驻一个**账户余额**胶囊。

作者：**凌雾工坊 - MarcoHuiLam** ｜ 协议：[MIT](LICENSE)

---

## 效果

每轮对话结束（`turn/end`）后，回复下方出现一行：

```
≈ ¥0.0312 · 54.4k tok · 命中 98.0% ▾ · 实扣 ¥0.03
```

点开是明细（预估 + 余额对账）：

```
模型        deepseek-official/deepseek-flash
时段        高峰（全价）
未命中输入    1,000 tok × ¥2/M   = ¥0.002
缓存命中输入 50,000 tok × ¥0.04/M = ¥0.002
输出         3,400 tok × ¥8/M   = ¥0.0272
合计        ¥0.0312
余额对账
本轮实扣     ¥0.03
预估差额     一致（差 ¥0.00）
余额窗口     14:02:10 → 14:03:40
余额变化     ¥13.71 → ¥13.68
```

会话头部右侧还会有一个余额胶囊（需登录 DeepSeek 账号）：

```
余额 ¥88.10 ▾
```

点开是「充值余额 / 赠送余额 / 更新时间」，以及**本会话累计**：预估合计 / 实扣合计 / 差额 / 待对账轮数。

### 余额对账怎么算的

- 每 30 秒读一次账户余额，页面聚焦时也补一次。
- 每轮取两个快照：**轮开始前最近一次**（最多往回找 15 分钟）与**轮结束后至少 3 秒的第一次**。
- `实扣 = 轮前余额 - 轮后余额`（正数=扣费，负数=充值/退款）。它和按价目表算的 `≈ 预估` 并排显示，
  差额在 ±0.01 内标「一致」。
- 余额没动时不会立刻判 0，会再等最多 5 分钟给账单落账；等待期间显示「等待落账…」。
- 对账台账存在浏览器 localStorage（仅本机、仅自己），刷新页面不丢。

> 诚实的边界：同一个 DeepSeek 账号如果有别的会话/程序也在用，那段时间的余额下降会一起算进这一轮，
> 所以「实扣」是**这段时间的余额变化**，不是账单级别的一对一扣费。界面里也写了「有偏差时以账单为准」。

---

## 安装

前置：Node ≥ 18；DSH 的 Web profile（`dsh web`）能正常启动。

### 方式 A：一键安装器（推荐，Windows / macOS / Linux 同一份）

```bash
# 1) 体检（什么都不改）
node "<项目目录>/scripts/install.mjs" --check

# 2) 安装（复制插件到 DSH_HOME/plugins、挂到 profile、写入 cordis.patch.yml）
node "<项目目录>/scripts/install.mjs"

# 3) 刷新浏览器里的 DSH 页面
```

可选参数：`--home <DSH_HOME>`、`--profile <名字>`（默认 `web`）、`--dry-run`、`--force`、`--mode copy|link`。
安装器只用 Node 内置模块，不依赖 pnpm / PowerShell / bash，不写死盘符。

### 方式 B：把本目录当作技能

把整个项目目录复制到 `<DSH_HOME>/skills/lingwu-dsh-conversation-cost/`，然后在 DSH 会话里说
「装凌雾DSH对话花费」，技能会按 `SKILL.md` 走安装流程。

### 方式 C：当成普通 profile 依赖

```bash
dsh plugin --profile web add "<项目目录>/plugin"
# 然后手写 cordis.patch.yml 挂载行：
# - insert:
#     - id: lingwu-dsh-conversation-cost
#       name: lingwu-dsh-conversation-cost
```

装好后**刷新 DSH 页面**；若页面没变化，重启一次 `dsh web`。

---

## 使用

| 位置 | 内容 | 出现条件 |
|---|---|---|
| 每轮回复下方 | `≈ ¥ · tok · 命中率`，点开三段单价明细 | 该轮结束（`turn/end`）后 |
| 会话头部右侧 | `余额 ¥x.xx`，点开充值/赠送/更新时间 | 已登录 DeepSeek 账号；每 60 秒或窗口聚焦刷新 |

- **一轮很长时不会每个步骤都出**：DSH 的「一轮」以 `turn/end` 为界，轮结束才结算。
- 历史会话回放同样显示（数据来自会话日志重算）。
- 余额走 DSH 自己的账号服务（`ctx.remote.account.getBalance`），**API Key 不进浏览器**；
  只用 API Key、未登录账号时，余额胶囊按设计隐藏——不会留空壳。

---

## 改价

价格表在 `plugin/client.js` 顶部的 `DEEPSEEK_PRICES`（单位：**元 / 百万 tokens**）：

```js
var DEEPSEEK_PRICES = {
  'deepseek-flash': {
    peak: { miss: 2, hit: 0.04, write: 2, out: 8 },
    off:  { miss: 1, hit: 0.02, write: 1, out: 4 },
  },
  'deepseek-v4-pro': {
    peak: { miss: 9, hit: 0.3, write: 9, out: 27 },
    off:  { miss: 4.5, hit: 0.15, write: 4.5, out: 13.5 },
  },
}
```

- `peak` 高峰价 / `off` 空闲价（北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰；其余为空闲，空闲价通常为高峰一半）。
- `miss` 未命中输入 / `hit` 缓存命中输入 / `write` 缓存写入输入 / `out` 输出。
- 旧模型名映射在 `DEEPSEEK_ALIASES`；接别的供应商在 `DEEPSEEK_PROVIDERS` 里扩。
- 官方价目：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 改完**刷新页面**即生效。

---

## 技术原理

- **挂载点**：`conversation.chat.turnTail`（每轮结束后的尾部槽位）与
  `conversation.session.header.utilities`（会话头部工具区）。
- **数据源**：本轮 token 账本来自 ui-chat 的 `turn-tail.tokenUsage`（与 DSH 原生「用量 x tok」胶囊同源）；
  余额来自 `ctx.remote.account.getBalance`（Host 侧持有凭据）。
- **客户端 bundle**：`plugin/client.js` 是 CJS 风格的经典脚本（`window.__ModuleLoader__.load`），
  React 经 `dsh.client.external` 注入，不用构建。
- **失败降级**：槽位条目拿不到数据就返回 `null`，注入守卫/Remote 异常一律安静降级，不影响其他 UI。
- 详细解剖见 [`references/dsh-plugin-anatomy.md`](references/dsh-plugin-anatomy.md)。

---

## 自检与诊断

```bash
# 离线自检：27 项（计价数学 / 时段 / 命中率 / 渲染 / 槽位 / 余额归一化与降级）
node test/client.test.mjs

# 逐轮核对本机会话日志（可选，诊断用）
node scripts/probe-session.mjs "<session.v4.jsonl.zstd>"
```

---

## 目录结构

```
lingwu-dsh-conversation-cost/
├── SKILL.md                   技能说明（DSH 技能入口）
├── plugin/                    可安装的 DSH 插件包
│   ├── index.js               host 半（空壳，只为保持 Loader 行活跃）
│   ├── client.js              浏览器半：计价、渲染、余额
│   └── package.json           dsh.client 声明
├── scripts/
│   ├── install.mjs            跨平台安装器
│   ├── probe-session.mjs      会话日志逐轮核对（诊断）
│   └── sync-plugin.mjs        多副本场景下的同步工具
├── test/client.test.mjs       离线自检
├── references/                插件解剖与踩坑记录
├── V0.2.1/                    该版本发行物（zip + 使用说明）
├── CHANGELOG.md
├── LICENSE
└── README.md
```

---

## 隐私与安全

- 本插件**不收集、不上传**任何数据；除 DSH 自身的账号/模型请求外不产生网络流量。
- 不含、也不读取任何 API Key：余额查询走 DSH Host 侧已有的账号会话。
- 仓库内不含任何个人账号、密钥、IP、本机路径或会话内容；仅保留署名「凌雾工坊 - MarcoHuiLam」。
- 价格表与代码全部本地运行，可自行审阅。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面上没有花费行 | 先确认这一轮已结束；再刷新页面；最后检查 `node scripts/install.mjs --check` |
| 显示「¥ 未定价」 | 该模型不在价格表里，补一行即可 |
| 头部没有「余额」 | 未登录 DeepSeek 账号时按设计隐藏；登录后刷新即可。已登录仍无：看 Console 与 `[data-slot-error]` |
| 金额和账单对不上 | 金额是估算；法定节假日按工作日记（可能偏高）；跨模型轮次按首个模型单价折算 |
| 改了代码不生效 | 改的是客户端 bundle，**必须刷新页面**；改 host 半则需重启 `dsh web` |

---

## 参与贡献

欢迎提 Issue / PR。提交前请确保：

1. `node test/client.test.mjs` 全绿；
2. 不引入任何个人账号、密钥、IP、本机绝对路径或会话内容；
3. 改动记入 `CHANGELOG.md`。

---

## 协议与署名

[MIT License](LICENSE) © 2026 **凌雾工坊 - MarcoHuiLam**

转载、二次开发请保留署名与协议声明。
