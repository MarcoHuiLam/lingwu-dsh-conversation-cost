# DSH 客户端插件解剖（以 turnTail「每轮花费」为范例）

本文件是 `dsh-turn-cost` 插件（技能 **凌雾DSH对话计费** / `lingwu-dsh-turn-cost`）的实现说明书，
也是**给 DSH 写任何 UI 插件**的通用解剖。
所有结论都在 DSH 0.2.1-rc.2（Windows，源码安装）上实测过。

---

## 1. 先分清两种插件

| | 正式插件包 | 动态 Cordis 包（cordis_define / cordis_run） |
|---|---|---|
| 生命周期 | 随 DSH 启动加载，永久 | 只在当前进程内存里，重启即失 |
| 装法 | profile 依赖 + `cordis.patch.yml` 挂载行 | 会话里调工具，页面点一次允许 |
| 适用 | 想长期存在的功能（本插件） | 临时试验 UI |
| 文件 | `package.json` + host 半 + client 半 | 同左，但由工具传源码 |

本 skill 只做正式包。

---

## 2. 正式包的三分合同

```
dsh-turn-cost/
├── package.json   身份与两面声明
├── index.js       host 半（跑在 Node 宿主进程）
└── client.js      client 半（跑在浏览器，运行时 bundle）
```

### package.json

```json
{
  "name": "dsh-turn-cost",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-chat"],
      "external": ["react"]
    }
  }
}
```

- `exports['./client']` 是**硬要求**：`dsh.client` 声明了却没有这个子路径，DSH 会直接报
  `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。
- `dsh.client.inject` 是本 bundle 依赖的**其它 client 包**（加载顺序）；`external` 是允许
  `require` 的外部模块（本插件只要 `react`）。
- host 半 `main` 必须能解析到——哪怕它是空壳。

### host 半（index.js）

```js
export const name = 'turn-cost'
export const inject = []
export function apply() {}
export default { name, inject, apply }
```

本插件 host 半是空壳：UI 全在浏览器。它存在的唯一理由，是 **DSH 只为「活跃的 Loader 行」
投放 `dsh.client` 运行时 bundle**——没有可装载的 host 入口，就没有这一行，也就没有 client。

若需要模型工具/服务/文件读写，就在 `apply(ctx)` 里用 `ctx.tools.register(...)`、
`ctx.effect(() => ctx.interval(...))`；`inject` 必须写全（漏了 `tools` 会在 apply 里抛
`cannot get property "tools" without inject`，而 DSH 只在启动日志里 warning
`1 entry did not activate`，现象就是「插件像没装」）。

### client 半（client.js）的硬约束

浏览器拿到的不是 ESM 模块，而是**经典脚本**，所以：

```js
;(function () {
  'use strict'
  window.__ModuleLoader__.load({
    id: 'dsh-turn-cost',                         // 包名
    factory: function (require) {
      var React = require('react')               // 只能用 external 声明过的
      return {
        name: 'turn-cost',
        inject: ['slots'],                       // 需要哪些 client service
        apply: function (ctx) { /* 注册槽位 */ },
      }
    },
  })
})()
```

- **不能** `import` / TypeScript / JSX；要 TSX 就先编译成普通 JS。
- `require` 只能拿 `dsh.client.external` 里声明过的包；React 组件用
  `React.createElement` 手写（或预编译后的 `jsx` 调用）。
- `apply(ctx)` 里的东西都用 `ctx.effect(...)` 包起来，卸载时自动回收（样式标签、
  槽位注册都要）。

---

## 3. 槽位系统（UI 挂载点）

```js
ctx.effect(function () {
  return ctx.slots.inject(SLOT_NAME, function () {
    return ctx.slots.register({
      name: SLOT_NAME,
      id: 'turn-cost',      // 自己的格子 id；复用别人的 id = 覆盖那一格
      order: 10,            // 列表槽位里的排序
      locale: 'ns',         // 可选：注册后组件会拿到 t()
      inject: (sessionId) => ({ ... }),  // 可选：按会话注入 props
    }, Component)
  })
}, 'turn-cost.tail')
```

`ctx.slots.inject(name, callback)` 会**等到该槽位被声明**才执行 callback，所以插件加载顺序
不需要和 ui-chat 对齐。

常用槽位（实测存在，`scope` 会影响可用 props）：

| 槽位 | 类型 | owner props | 用途 |
|---|---|---|---|
| `conversation.chat.turnTail` | list | `{ turn: TurnLocation, seq, openFile }` | 每轮结束后的尾部（本插件用这个） |
| `conversation.chat.assistant-actions` | list | `{ messageId }` | 单条助手回复的操作行 |
| `conversation.session.header.utilities` | list | `sessionId` | 会话头部按钮 |
| `conversation.input.left` / `.right` | list | `sessionId` | 输入框工具行 |
| `conversation.composer.dock` | list | `sessionId` | 输入框下方 |
| `sidebar.footer.action` | list | — | 左侧栏底部入口 |
| `sidebar.session.row.leading` / `.hover` | list | 行数据 | 会话列表行 |
| `settings.section` / `settings.general.item` | list | — | 设置页 / 单行设置 |
| `main` | keyed | `key` | 主面板整页 |

完整实时清单（含每个槽位当前 occupant）用 inspect 查，不要靠猜：

```
cordis_inspect_query(client, Slots, listSubTree, {"root":"conversation.chat.turnTail"})
```

组件拿到的是 `owner props` + 各 `standardProps`（`useChat`、`useSession`、`useProjection`、
`useAccess`…）+ `inject` 注入的字段。**不要假设 props 一定存在**——本插件只读了 `props.turn`，
取不到就 `return null`。

---

## 4. 数据从哪来

| 想要 | 去哪拿 | 注意 |
|---|---|---|
| 本轮 token 账本（未命中/缓存命中/缓存写入/输出/总用量/路由） | `props.turn.data.get('turn-tail').tokenUsage` | **只在 `turn/end` 之后发布**；正在跑的轮次没有 |
| 会话累计 token | `useProjection('tokenUsage')` | 有个 `usePerformanceUsage` 模式门控（DSH 自己的胶囊在 compact 模式下会隐藏） |
| 会话事件原文 | `ctx.uiConversation.events.register(...)` 注册自己的 `ConversationNodeDefinition`（参考 ui-schedule 的 `schedule-created`） | 事件窗口可能从半轮开始，此时没有 `turn/start` |
| 官方价格 | 没有内置 | 自己维护（本插件 `client.js` 顶部 `DEEPSEEK_PRICES`） |
| 账户余额（v0.2.0） | `ctx.get('remote').account.getBalance(metadata)` | 凭据只在 Host；`ctx.get` 在服务未就绪时返回 undefined，要**安静降级**而不是抛错 |

`tokenUsage` 形状：

```ts
{ uncachedInputTokens, outputTokens, totalTokens,
  cacheReadTokens?, cacheWriteTokens?, reasoningTokens?,
  routes?: [{ provider, model }] }
```

缓存命中率 = `cacheReadTokens ÷ (totalTokens - outputTokens)`；部分命中不要四舍五入成 100%。

### 客户端调 Host Remote 的标准姿势（余额就是这么拿的）

**必须显式声明注入**：`inject: ['slots', 'remote', 'remote.account']`。Cordis 有服务注入守卫，
没声明就去碰 `remote.account` 会抛 `cannot get property "remote.account" without inject`——
这个错发生在渲染期，会被 `ui-renderer` 的 `SlotErrorBoundary` 接住、整格替换成
`[data-slot-error]` 占位，现象就是「这一格永远不出现」，而**花费行不受影响**（各自独立 entry）。
本插件 0.2.0 就踩了这个坑，0.2.1 修好：注入声明 + 整个读取函数包 try/catch。

`inject` 里声明的服务在 web profile 都固定存在（`web-app` bundle 里有 `account-controller` 行），
所以不会因为注入而整体不激活；换到没有该服务的自定义 profile 才会，那种情况应改用可选能力探测。

```js
function makeBalanceReader(ctx) {
  return function readBalance() {
    try {
      var remote = ctx.get('remote')
      if (!remote) return Promise.resolve(null)
      var account = remote.account                       // 需要 inject: ['remote.account']
      if (!account || typeof account.getBalance !== 'function') return Promise.resolve(null)
      return Promise.resolve(account.getBalance(accountClientMetadata()))
        .then(function (result) {
          if (!result || result.ok !== true) return null
          return normalizeBalance(result.value)          // status:'ready' → 归一化，其余 → null
        }, function () { return null })
    } catch (error) {
      return Promise.resolve(null)                       // 注入守卫 / Remote 未就绪 / 形状异常一律安静降级
    }
  }
}
```

- `getBalance` 的实参是 `{ version, locale, timezoneOffsetSeconds }`（`AccountClientMetadata`），
  Host 转成 Platform 请求头；**不含任何密钥**，Key 也不进浏览器。
- 返回 `{ ok, value }`，`value` 是 `{ status:'ready', value:[{currency:'CNY',balance:'88.10'}], bonusWallets:[...] }`
  或 `{ status:'failed' }` 或 `null`（未登录/授权变化）。
- 渲染层：拿不到数据就 `return null`（胶囊整格不渲染），比显示「—」干净。
- **验证这类格子有没有崩**：页面里查 `document.querySelector('[data-slot-error="<slot 名>"]')`，
  有就说明该 entry 抛错了；再看 Console 有没有 `without inject`。

---

## 5. 激活、热重载与验证

1. **挂载行**写在 `$DSH_HOME/cordis.patch.yml`（机器级，DSH 升级不丢）或 profile 的
   `cordis.patch.yml`：

   ```yaml
   - insert:
       - id: turn-cost
         name: dsh-turn-cost
   ```

2. **热重载**：DSH 的 `dsh-hmr` 监视 profile patch 文件和 `$DSH_HOME/cordis.patch.yml`，
   改动会触发 reconcile → 新行**无需重启即被挂载**（本插件实测如此）。客户端 bundle 的
   变更要**刷新页面**才生效。

3. **验证顺序**（从便宜到贵）：
   - 组合配置里有没有这一行：
     - 源码安装：`node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config`
     - 发布版：`dsh --profile web --dump-config`
   - 页面里有没有 bundle：`__DSH_BOOT__.entries` 中应出现 `{"id":"dsh-turn-cost","url":"plugins/??dsh-turn-cost/client.js&rev=…"}`
   - 槽位有没有 occupant：`cordis_inspect_query(client, Slots, listSubTree, {"root":"conversation.chat.turnTail"})`
   - DOM 有没有渲染：页面里 `document.querySelectorAll('.tc-line')`
   - 数字对不对：用 `scripts/probe-session.mjs` 直接解会话日志独立复算

4. **离线自测**（不打开浏览器）：`node test/client.test.mjs`。
   手法：`new Function('window','document', source)` 执行真实 bundle，拦下
   `window.__ModuleLoader__.load` 拿到工厂，用桩 React（`createElement`/`useState`）
   把组件树拍平成文本做断言。18 项覆盖计价数学、时段判定、命中率、收起/展开渲染、
   槽位注册参数、样式注入。

---

## 6. 排障对照表（都是真实踩过的）

| 现象 | 原因 / 处理 |
|---|---|
| 插件"像没装"：日志只有 `1 entry did not activate` | `inject` 漏了要用的 service（如 `tools`） |
| 页面没变化 | 刷新页面；bundle 变更不随 host 热重载 |
| `declares dsh.client but exports no "./client" bundle` | package.json 少 `exports['./client']` |
| 槽位注册成功但一条都不渲染 | owner props 取不到数据就 `return null`；先确认那一轮有 `turn/end` |
| 加了余额胶囊后整格 `active:false` | 组件拿到了 null（未登录 / 只用 API Key / Remote 不可用）。这是设计内的降级，先确认账号菜单是否有余额 |
| 页面有 native 胶囊但本插件没有 | 两者数据源不同：原生胶囊部分模式可隐藏，本插件读 `turn-tail.tokenUsage`；先用 probe 脚本确认该轮 `turnUsage` 可导出 |
| 金额不对 | 先看时段判断（法定节假日查不到，按工作日记高峰价）；再核对价格表是否最新官方价 |
| `require('react')` 报没注册 | `dsh.client.external` 里没写 `react` |
| 组件里 Hook 顺序报错 | 先无条件调完 Hook，再 `return null` |
| 改 bundle 后样式残留 | 样式标签用 `ctx.effect` 注入并在 disposer 里移除 |

---

## 7. 能直接用的主题 token（亮/暗自动）

`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-border-l1`、
`--dsw-alias-border-l2`、`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、
`--dsw-alias-bg-overlay`、`--dsw-alias-brand-primary`、`--dsw-alias-state-success-primary`、
`--dsw-alias-state-warn-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-idle-primary`、
`--dsw-specific-sidebar-fill`。

写法：`color: var(--dsw-alias-label-secondary, #8a8f98)`（带兜底值，主题缺失也不瞎）。

---

## 8. 平台差异（Windows / macOS / Linux）

- 插件本身：**零平台差异**。host 半是普通 ESM，client 半跑在浏览器里。
- 差异只在**路径与启动方式**：
  - `DSH_HOME`：默认是 `~/.dsh`（Windows 通常解析到用户目录下的 `.dsh`）
    `DSH_HOME` 环境变量覆盖）。
  - 安装/校验：本 skill 的脚本一律用 Node（`node:fs`/`node:os`/`node:path`），
    不写死盘符、不依赖 PowerShell 或 bash；`process.platform === 'win32'` 时用
    **junction**，其它平台用 **symlink**，失败则退回复制。
  - 启动 DSH：源码安装用 `node --import tsx/esm apps/cli/src/bin.ts web`（开发态）或
    构建后的 `apps/cli/lib/bin.js`；发布版直接 `dsh web`。
- Node 版本：脚本用到 `fs.cpSync` / `fs.rmSync`，Node ≥ 18 即可。
