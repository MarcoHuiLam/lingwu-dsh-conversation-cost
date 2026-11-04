---
name: lingwu-dsh-conversation-cost
description: 凌雾DSH对话花费 —— 给 DSH Web GUI 加「每轮对话结算」：每轮助手回复下方一行「≈ ¥人民币花费 · token 用量 · 缓存命中率」，点开是未命中/缓存命中/输出三段单价明细（内置 DeepSeek 官方价目与高峰/空闲时段）；同时在会话头部显示「账户余额 ¥x.xx」（需登录账号）。当用户说「每轮花了多少钱 / 显示人民币花费 / 消耗多少 token / 缓存命中率 / 显示余额 / 账户余额 / 还剩多少钱 / 装个 DSH 计费插件 / 改插件价格 / 插件在 DSH 里没生效 / DSH 插件怎么写」时使用。含跨平台安装器、离线自检、会话日志逐轮核对器与插件解剖参考。
---

# 凌雾DSH对话花费（`lingwu-dsh-conversation-cost`）

> 作者：**凌雾工坊 - MarcoHuiLam** ｜ 协议：MIT
> 技能名受 DSH 约束只能是 kebab-case ASCII；中文名「凌雾DSH对话花费」是它在技能目录里显示的名字。

给 DSH Web GUI 的正式插件包：每轮对话结束后，在回复下方显示

```
≈ ¥0.0312 · 54.4k tok · 命中 98.0% ▾
```

点开是本轮明细（模型 / 高峰还是空闲 / 三段 token 各自的 token × 单价 = 小计 / 合计）。
会话头部右侧另有 `余额 ¥88.10 ▾` 胶囊：点开是充值余额 / 赠送余额 / 更新时间。
历史会话回放同样显示；数据来自 DSH 自己算好的本轮用量，本插件只负责「按模型单价换成人民币」。

**出现时机（最容易误判的一点）**：DSH 的「一轮」以 `turn/end` 为界。这行是**轮结算**——
一轮很长（几十步、上百次工具调用）时要等它跑完才出现；正在流式输出的那一轮暂时没有
（DSH 自带的「用量 x tok」胶囊同样如此）。这不是插件没装好。
余额胶囊不受此限：进页面就有，每 60 秒或窗口重新聚焦时刷新。

---

## 一、安装

前置：Node ≥ 18；这台 DSH 有 `web` profile（默认都有）。

```bash
# 1) 体检（什么都不改）
node "<项目目录>/scripts/install.mjs" --check

# 2) 预览计划
node "<项目目录>/scripts/install.mjs" --dry-run

# 3) 安装
node "<项目目录>/scripts/install.mjs"
```

`<项目目录>` 就是本技能所在目录（含 `SKILL.md` / `plugin/` / `scripts/`）。
安装器只做三件幂等的事，**不依赖 pnpm、不依赖 PowerShell/bash、不写死盘符**：

| 步 | 动作 | 位置 |
|---|---|---|
| 1 | 复制插件到机器级目录 | `<DSH_HOME>/plugins/lingwu-dsh-conversation-cost` |
| 2 | 挂到 profile 的 `node_modules` | `<DSH_HOME>/profiles/<profile>/node_modules/lingwu-dsh-conversation-cost`（Windows 用 junction，其它平台 symlink，失败退回复制） |
| 3 | 补挂载行 | `<DSH_HOME>/cordis.patch.yml` 里的 `- id: lingwu-dsh-conversation-cost` |

可选参数：`--home <目录>`（默认 `$DSH_HOME`，其次 `~/.dsh`）、`--profile <名字>`（默认 `web`）、
`--from <插件源码目录>`、`--force`（已装过也换成本副本）、`--mode copy|link`。

装完**刷新浏览器里的 DSH 页面**即可；配置热重载会自动挂载。页面没变化就重启 `dsh web`。

> 官方风格替代装法：`dsh plugin --profile web add "<项目目录>/plugin"`，然后手写挂载行。

---

## 二、使用与改价

| 位置 | 内容 | 出现条件 |
|---|---|---|
| 每轮回复下方 | `≈ ¥ 花费 · token · 命中率`，点开三段单价明细 | 该轮 `turn/end` 之后 |
| 会话头部右侧 | `余额 ¥x.xx`，点开充值/赠送/更新时间 | 已登录 DeepSeek 账号 |

价格表在 `plugin/client.js` 顶部 `DEEPSEEK_PRICES`（单位：**元 / 百万 tokens**）：

```js
var DEEPSEEK_PRICES = {
  'deepseek-flash': {
    peak: { miss: 2, hit: 0.04, write: 2, out: 8 },   // 高峰价
    off:  { miss: 1, hit: 0.02, write: 1, out: 4 },   // 空闲价（通常为高峰一半）
  },
  'deepseek-v4-pro': {
    peak: { miss: 9, hit: 0.3, write: 9, out: 27 },
    off:  { miss: 4.5, hit: 0.15, write: 4.5, out: 13.5 },
  },
}
```

- `miss` 未命中输入 / `hit` 缓存命中输入 / `write` 缓存写入输入 / `out` 输出。
- 官方价目：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- 旧模型名在 `DEEPSEEK_ALIASES` 里映射；接别的供应商扩展 `DEEPSEEK_PROVIDERS` 并加价格键。
- 改完**刷新页面**即生效（改的是客户端 bundle）。

---

## 三、口径与偏差（写进交付说明，别让用户对不上账）

| 项 | 口径 |
|---|---|
| 金额 | 前面是 `≈`：按官方价目算的**应扣估算**，不是账单流水（还受赠送余额、优惠、取整影响） |
| 时段 | 北京时间周一至周五（法定节假日除外）9:00–12:00、14:00–18:00 = 高峰全价；其余 = 空闲半价。**查不到法定节假日**，按工作日记（偏高） |
| 命中率 | 缓存命中输入 ÷ 总输入；部分命中不会四舍五入成 100% |
| 跨模型轮次 | 一轮里换了模型时 token 已按轮聚合，按**第一个模型**的单价折算，明细里会注明 |
| 缓存桶缺失 | 供应商没上报「缓存命中输入」时，未上报部分按**未命中价**计（偏高，不假装免费） |
| 非 DeepSeek 路由 | 没配人民币单价 → 显示 `¥ 未定价`，token 与命中率照常显示 |
| 时机 | 花费行只在 `turn/end` 后显示；进行中的轮次没有 |
| 余额 | 会话头部胶囊，来自 `ctx.remote.account.getBalance`（需 `inject: ['slots','remote','remote.account']`，缺了会被注入守卫抛错、整格变 `[data-slot-error]`）。**前提是登录了 DeepSeek 账号**；只用 API Key 时按设计隐藏，不留空壳 |

---

## 四、验证三件套（从便宜到贵）

```bash
# 1) 离线自检：计价数学 + 渲染结构 + 槽位参数 + 余额归一化/降级（27 项，不需要浏览器）
node "<项目目录>/test/client.test.mjs"

# 2) 会话日志逐轮核对（诊断/对账，可选）：
#    解 <DSH_HOME>/sessions/**/session.v4.jsonl.zstd（多帧 zstd），逐轮打印 token / 命中率 / 估算花费
node "<项目目录>/scripts/probe-session.mjs" "<session.v4.jsonl.zstd>"
#    带 --checkout <DSH 源码目录> 时还会用 DSH 自己的 deriveTurnTokenUsage 复核（需 --import tsx/esm）
```

```bash
# 3) 页面侧实证
#   · 组合配置有没有这一行
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config | Select-String lingwu-dsh-conversation-cost
dsh --profile web --dump-config
#   · 页面里有没有 bundle：__DSH_BOOT__.entries 应含 {"id":"lingwu-dsh-conversation-cost",...}
#   · 槽位有没有 occupant：
#       cordis_inspect_query client Slots listSubTree {"root":"conversation.chat.turnTail"}
#       cordis_inspect_query client Slots listSubTree {"root":"conversation.session.header.utilities"}
#   · 有没有真渲染：document.querySelectorAll('.tc-line')；余额胶囊是 document.querySelectorAll('.tc-bal')
#   · 槽位崩没崩：document.querySelectorAll('[data-slot-error]') 应为 0
```

---

## 五、排障

| 现象 | 处理 |
|---|---|
| 页面上没有花费行 | 先确认这几轮都“结束了”；再刷新页面；`--check` 看挂载三件套；最后看 `__DSH_BOOT__` 里有没有 bundle |
| 刷新后仍没有 | 重启 `dsh web`（host 侧挂载 + 页面重新拿 graph 最稳） |
| 显示 `¥ 未定价` | 该模型/供应商不在 `DEEPSEEK_PRICES`；补价格键 |
| 头部没有「余额」 | 未登录 DeepSeek 账号时按设计隐藏；登录后刷新即出现。已登录仍无：查 `[data-slot-error]` 与 Console 的 `without inject`，那是 0.2.0 的注入 bug，升 0.2.1 |
| 余额数字不更新 | 60 秒自动刷新；窗口重新聚焦也会刷新；刷新页面可立即重取 |
| 金额对不上官方账单 | 先看明细里的「时段」是否正确；再核对价格表是否最新；节假日会被当工作日 |
| 想临时关掉 | `<DSH_HOME>/cordis.patch.yml` 里给 `- id: lingwu-dsh-conversation-cost` 加 `disabled: true`，刷新页面 |
| 改了代码不生效 | 客户端 bundle 变更**必须刷新页面**；host 半变更需重启 `dsh web` |
| 分发副本与源码不一致 | `node scripts/sync-plugin.mjs "<插件源码目录>" --check` 比对，去掉 `--check` 同步 |

---

## 六、安全与隐私

- 不收集、不上传任何数据；除 DSH 自身的账号/模型请求外不产生网络流量。
- 不含也不读取 API Key：余额查询走 DSH Host 侧已有的账号会话（`remote.account.getBalance`）。
- 仓库与技能内不含个人账号、密钥、IP、本机绝对路径或会话内容；仅保留署名「凌雾工坊 - MarcoHuiLam」。

---

## 七、项目结构与开发

```
<项目目录>/
├── SKILL.md                   本文件（技能入口）
├── plugin/                    可安装的 DSH 插件包（index.js / client.js / package.json）
├── scripts/                   install.mjs（安装）/ probe-session.mjs（诊断）/ sync-plugin.mjs（多副本同步）
├── test/client.test.mjs       离线自检
├── references/                插件解剖与踩坑记录（写别的 DSH UI 插件可参考）
├── V<版本>/                   版本发行物（zip + 使用说明）
├── README.md / CHANGELOG.md / LICENSE
```

- 单一源码位置：项目目录即源码，DSH 里的 skill 与 profile 挂载都指向它（junction/symlink），不复制第二份源码。
- 改代码 → `node test/client.test.mjs` → 刷新页面；升级版本时同步 `plugin/package.json`、`CHANGELOG.md`、`V<版本>/`。

---

## 八、署名与协议

[MIT License](LICENSE) © 2026 **凌雾工坊 - MarcoHuiLam**。转载、二次开发请保留署名与协议声明。
