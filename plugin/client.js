/**
 * lingwu-dsh-conversation-cost · 浏览器半（运行时 bundle，随包发布）
 *
 * 干什么：在**每一轮完成的助手回复**下方加一行
 *
 *     ≈ ¥0.0312 · 51.4k tok · 命中 98.0% ▾
 *
 * 点一下展开明细：未命中输入 / 缓存命中输入 / 缓存写入 / 输出 各自的
 * token 数、单价（元/百万 tokens）与小计，以及当前是高峰还是空闲时段。
 *
 * 数据来源：DSH 自己已经算好的「本轮用量」(`turn-tail` 的 tokenUsage，
 * 来自 ui-chat 的 deriveTurnTokenUsage)。本插件只做两件 DSH 没做的事：
 *   1. 按模型单价把 token 换成人民币；
 *   2. 按北京时间的高峰/空闲时段取价（DeepSeek 空闲时段是高峰价的一半）。
 *
 * 挂载点：
 *   · `conversation.chat.turnTail` —— 每轮花费结算行；
 *   · `conversation.session.header.utilities` —— 会话头部的「余额 ¥x.xx」胶囊，
 *     点开看充值余额 / 赠送余额 / 更新时间。余额走 DSH 的 `ctx.remote.account.getBalance`
 *     （Host 侧持有凭据，浏览器只拿到数字，插件里不出现 API Key）；未登录账号时这一格
 *     直接不渲染。每 60 秒或窗口重新获得焦点时刷新一次。
 *
 * ⚠️ 这个文件必须是 **CJS 风格的普通 JS**：不能 import / 不能 TS / 不能 JSX。
 * 外部依赖只能经工厂参数 require 拿，且必须在 package.json 的
 * `dsh.client.external` 里声明（本包声明了 react）。
 */
;(function () {
  'use strict'

  var SLOT_NAME = 'conversation.chat.turnTail'
  var CELL_ID = 'lingwu-conversation-cost'
  var STYLE_ATTR = 'data-lingwu-dsh-conversation-cost'

  /** 余额胶囊挂在会话头部；owner props 里有 sessionId，本插件不需要。 */
  var BALANCE_SLOT = 'conversation.session.header.utilities'
  var BALANCE_CELL_ID = 'lingwu-conversation-cost-balance'

  /** 余额自动刷新间隔（毫秒）。 */
  var BALANCE_REFRESH_MS = 60000

  // ══════════════════════════════════════════════════════════════════
  //  价格表：人民币 / 百万 tokens —— 改这里就能改价，改完刷新页面
  //
  //  官方价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  //  · peak = 高峰时段价：北京时间 周一至周五（法定节假日除外）
  //      9:00–12:00、14:00–18:00
  //  · off  = 空闲时段价：其余全部时间（含周末、法定节假日），是高峰价的一半
  //  · miss 缓存未命中输入 / hit 缓存命中输入 / write 缓存写入输入 / out 输出
  //
  //  想接别的供应商：在下面加一行 `'供应商/模型': { peak: {...}, off: {...} }`
  //  （provider 用 DSH 里的实际 id，例如 deepseek-official / deepseek-account）。
  // ══════════════════════════════════════════════════════════════════
  var DEEPSEEK_PRICES = {
    'deepseek-flash': {
      peak: { miss: 2, hit: 0.04, write: 2, out: 8 },
      off: { miss: 1, hit: 0.02, write: 1, out: 4 },
    },
    'deepseek-v4-pro': {
      peak: { miss: 9, hit: 0.3, write: 9, out: 27 },
      off: { miss: 4.5, hit: 0.15, write: 4.5, out: 13.5 },
    },
  }

  /** 旧模型名 / 版本号别名 → 计价用的价格键。 */
  var DEEPSEEK_ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deepseek-v4.1-flash-1017': 'deepseek-flash',
  }

  /** 走 DeepSeek 官方人民币价的 provider id。 */
  var DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek-account']

  // ────────────────────────────── 计价 ──────────────────────────────

  /** 非负数字兜底。 */
  function count(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0
  }

  /**
   * 解析一个 provider/model 的人民币价格表。
   * @param provider - 路由的 provider id。
   * @param model - 路由的 model id。
   * @returns 价格表，或 null（未配置的单子）。
   */
  function priceFor(provider, model) {
    if (typeof provider !== 'string' || typeof model !== 'string') return null
    if (DEEPSEEK_PROVIDERS.indexOf(provider) < 0) {
      // 兜底：provider id 可能随 DSH 版本/账号类型改名（deepseek-official / deepseek-account /
      // deepseek / custom-deepseek…），只要名字里带 deepseek 就按同一套人民币价折算，
      // 避免"插件还在、只是静默不显示"这种最难查的失效。
      if (String(provider).toLowerCase().indexOf('deepseek') < 0) return null
    }
    var key = Object.prototype.hasOwnProperty.call(DEEPSEEK_ALIASES, model)
      ? DEEPSEEK_ALIASES[model]
      : model
    return Object.prototype.hasOwnProperty.call(DEEPSEEK_PRICES, key) ? DEEPSEEK_PRICES[key] : null
  }

  /**
   * 北京时间是否处于高峰时段（周一至周五 9:00–12:00、14:00–18:00）。
   * 不查法定节假日：未知日期按高峰计价（宁可高估）。
   * @param ms - 毫秒时间戳。
   * @returns 是否高峰。
   */
  function isPeakWindow(ms) {
    var shanghai = new Date(ms + 8 * 60 * 60 * 1000)
    var weekday = shanghai.getUTCDay()
    if (weekday === 0 || weekday === 6) return false
    var minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
    return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  }

  /** 落价用的时间：优先这一轮的结束时刻，其次开始时刻。 */
  function turnTime(turn) {
    if (turn && turn.end && typeof turn.end.time === 'number') return turn.end.time
    if (turn && turn.start && typeof turn.start.time === 'number') return turn.start.time
    return Date.now()
  }

  /** 追加一条计价明细，返回它的小计。 */
  function priced(rows, label, tokens, rate) {
    if (tokens <= 0) return 0
    var amount = tokens * rate / 1e6
    rows.push({ label: label, tokens: tokens, rate: rate, amount: amount })
    return amount
  }

  /**
   * 把一轮的 token 账本折算成人民币。
   * @param usage - ui-chat 算好的「本轮用量」（TurnTokenUsage）。
   * @param atMs - 落价时刻（毫秒）。
   * @returns 可展示的汇总；`priced === false` 表示该模型没有人民币单价。
   */
  function computeSummary(usage, atMs) {
    var routes = Array.isArray(usage.routes)
      ? usage.routes.filter(function (route) { return route && typeof route.model === 'string' })
      : []
    var route = routes.length > 0 ? routes[0] : null
    var table = route === null ? null : priceFor(route.provider, route.model)
    var peak = isPeakWindow(atMs)
    var rates = table === null ? null : (peak ? table.peak : table.off)

    var miss = count(usage.uncachedInputTokens)
    var output = count(usage.outputTokens)
    var cacheRead = typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens >= 0
      ? usage.cacheReadTokens
      : null
    var cacheWrite = typeof usage.cacheWriteTokens === 'number' && usage.cacheWriteTokens >= 0
      ? usage.cacheWriteTokens
      : null
    var prompt = miss + (cacheRead === null ? 0 : cacheRead) + (cacheWrite === null ? 0 : cacheWrite)
    var total = typeof usage.totalTokens === 'number' && usage.totalTokens >= 0
      ? usage.totalTokens
      : prompt + output
    // 供应商没上报缓存桶时，实际输入与已知桶之间的差额按未命中保守计价。
    var hidden = Math.max(0, total - output - prompt)

    var rows = []
    var cost = null
    if (rates !== null) {
      cost = 0
      cost += priced(rows, '未命中输入', miss, rates.miss)
      cost += priced(rows, '缓存命中输入', cacheRead === null ? 0 : cacheRead, rates.hit)
      cost += priced(rows, '缓存写入输入', cacheWrite === null ? 0 : cacheWrite, rates.write)
      cost += priced(rows, '未上报输入（按未命中）', hidden, rates.miss)
      cost += priced(rows, '输出', output, rates.out)
    }

    var exactPrompt = total - output
    return {
      priced: cost !== null,
      cost: cost,
      peak: peak,
      route: route,
      routes: routes,
      rates: rates,
      rows: rows,
      total: total,
      hidden: hidden,
      cacheRead: cacheRead,
      hitText: hitPercent(cacheRead, exactPrompt),
    }
  }

  /**
   * 缓存命中率文本；部分命中绝不四舍五入成 100%。
   * @param cacheRead - 缓存命中输入 token，未知时为 null。
   * @param prompt - 精确的输入 token 总量。
   * @returns 形如 `98.0%` 的文本，或 null（没有输入 / 未上报）。
   */
  function hitPercent(cacheRead, prompt) {
    if (cacheRead === null || !(prompt > 0)) return null
    if (cacheRead >= prompt) return '100%'
    var pct = cacheRead / prompt * 100
    var text = pct.toFixed(1)
    if (text === '100.0') {
      text = pct.toFixed(2)
      if (text === '100.00') text = '99.99'
    }
    return text + '%'
  }

  // ────────────────────────────── 格式化 ──────────────────────────────

  /** 人民币金额（不带 ¥），按量级自动选小数位。 */
  function formatRmb(value) {
    if (!(value > 0)) return '0'
    if (value >= 100) return value.toFixed(2)
    if (value >= 1) return value.toFixed(3)
    if (value >= 0.01) return value.toFixed(4)
    if (value >= 0.0001) return value.toFixed(5)
    return value.toFixed(6)
  }

  /** 紧凑 token 数：517 / 12.3k / 1.2M。 */
  function formatTokens(value) {
    var scaled = function (candidate) {
      return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
    }
    if (value < 1000) return String(value)
    if (value < 1000000) return scaled(value / 1000) + 'k'
    return scaled(value / 1000000) + 'M'
  }

  /** 精确 token 数，带千分位。 */
  function formatExact(value) {
    var digits = String(Math.round(value))
    var grouped = ''
    for (var index = 0; index < digits.length; index += 1) {
      if (index > 0 && (digits.length - index) % 3 === 0) grouped += ','
      grouped += digits.charAt(index)
    }
    return grouped
  }

  // ────────────────────────────── 读取用量 ──────────────────────────────

  /**
   * 从 Turn 的位置数据里取「本轮用量」。
   * `turn-tail` 是 ui-chat 自己发布的聊天数据键，其中 tokenUsage 就是
   * 面板上「用量 x tok」胶囊用的同一份精确账本。
   * @param turn - turnTail 槽位给的 TurnLocation。
   * @returns TurnTokenUsage，或 undefined（该轮没有可用账本）。
   */
  function readTurnUsage(turn) {
    if (turn === null || typeof turn !== 'object') return undefined
    var store = turn.data
    if (store === null || typeof store !== 'object' || typeof store.get !== 'function') return undefined
    var tail = store.get('turn-tail')
    if (tail === null || typeof tail !== 'object') return undefined
    var usage = tail.tokenUsage
    if (usage === null || typeof usage !== 'object') return undefined
    return usage
  }

  // ────────────────────────────── 账户余额 ──────────────────────────────

  /** 金额格式化：千分位 + 两位小数（余额是精度足够的十进制字符串）。 */
  function formatMoney(value) {
    var fixed = Math.abs(value).toFixed(2)
    var parts = fixed.split('.')
    var grouped = ''
    for (var index = 0; index < parts[0].length; index += 1) {
      if (index > 0 && (parts[0].length - index) % 3 === 0) grouped += ','
      grouped += parts[0].charAt(index)
    }
    return (value < 0 ? '-' : '') + grouped + '.' + parts[1]
  }

  /** 同一币种的钱包求和；没有该币种时返回 null。 */
  function walletSum(wallets, currency) {
    if (!Array.isArray(wallets)) return null
    var sum = 0
    var seen = false
    for (var index = 0; index < wallets.length; index += 1) {
      var wallet = wallets[index]
      if (!wallet || wallet.currency !== currency) continue
      var amount = Number(wallet.balance)
      if (!isFinite(amount)) continue
      sum += amount
      seen = true
    }
    return seen ? sum : null
  }

  /** 一组钱包 → `¥12.34`（优先人民币，其次美元）；都没有返回 null。 */
  function balanceText(wallets) {
    var cny = walletSum(wallets, 'CNY')
    if (cny !== null) return '¥' + formatMoney(cny)
    var usd = walletSum(wallets, 'USD')
    if (usd !== null) return '$' + formatMoney(usd)
    return null
  }

  /**
   * 归一化 `ctx.remote.account.getBalance()` 的返回值。
   * 未登录 / 授权失效时上游给 null 或 `{status:'failed'}`，这里统一成 null（界面直接不显示）。
   * @param value - `AccountDetails['balance']`。
   * @returns `{ text, bonusText, wallets, bonusWallets, updatedAt }`，或 null。
   */
  function normalizeBalance(value) {
    if (!value || typeof value !== 'object' || value.status !== 'ready') return null
    var wallets = Array.isArray(value.value) ? value.value : []
    var bonus = Array.isArray(value.bonusWallets) ? value.bonusWallets : []
    var text = balanceText(wallets)
    if (text === null) return null
    return {
      text: text,
      bonusText: balanceText(bonus),
      wallets: wallets,
      bonusWallets: bonus,
      updatedAt: Date.now(),
    }
  }

  /** 这一次账户调用的客户端身份（Host 转成 Platform 请求头；不含任何密钥）。 */
  function accountClientMetadata() {
    var version = 'lingwu-dsh-conversation-cost'
    try {
      if (typeof process !== 'undefined' && process && process.env && process.env.DSH_CLIENT_VERSION) {
        version = process.env.DSH_CLIENT_VERSION
      }
    } catch (error) {
      // 浏览器打包环境没有 process 时用兜底 version。
    }
    return {
      version: version,
      locale: (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
  }

  /**
   * 造一个余额读取器：走 DSH 的 `ctx.remote.account.getBalance`。
   * 凭据只在 Host 侧，浏览器只拿到余额数字——插件里不出现、也不需要 API Key。
   * @param ctx - Cordis 客户端上下文。
   * @returns 无参函数：Promise<归一化余额 | null>；不可用时安静返回 null。
   */
  function makeBalanceReader(ctx) {
    return function readBalance() {
      try {
        var remote = ctx && typeof ctx.get === 'function' ? ctx.get('remote') : undefined
        if (!remote) return Promise.resolve(null)
        // Cordis 的注入守卫生效：访问 remote.account 之前必须声明 inject: ['remote.account']。
        var account = remote.account
        if (!account || typeof account.getBalance !== 'function') return Promise.resolve(null)
        var pending = account.getBalance(accountClientMetadata())
        return Promise.resolve(pending).then(function (result) {
          try {
            if (!result || result.ok !== true) return null
            return normalizeBalance(result.value)
          } catch (error) {
            return null
          }
        }, function () {
          return null
        })
      } catch (error) {
        // 缺注入 / Remote 未就绪 / 形状异常：安静降级，绝不让整个槽位条目崩掉。
        return Promise.resolve(null)
      }
    }
  }

  // ────────────────────────────── 组件 ──────────────────────────────

  var STYLES = [
    '.tc-wrap{display:flex;flex-direction:column;align-items:flex-start;gap:6px}',
    '.tc-line{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 9px;',
    'border:1px solid transparent;border-radius:999px;background:transparent;font:inherit;',
    'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;',
    'transition:background-color .15s ease,border-color .15s ease,color .15s ease}',
    '.tc-line:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,140,160,.10));',
    'border-color:var(--dsw-alias-border-l1,rgba(128,140,160,.28));',
    'color:var(--dsw-alias-label-primary,#1f2329)}',
    '.tc-line:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}',
    '.tc-amount{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);font-variant-numeric:tabular-nums}',
    '.tc-sep{opacity:.4}',
    '.tc-tok,.tc-hit{font-variant-numeric:tabular-nums}',
    '.tc-caret{opacity:.5;font-size:10px}',
    '.tc-detail{display:flex;flex-direction:column;gap:4px;max-width:560px;padding:8px 10px;',
    'border:1px solid var(--dsw-alias-border-l1,#e5e6eb);border-radius:10px;',
    'background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-secondary,#5a606b);',
    'font-size:12px;line-height:1.55}',
    '.tc-row{display:flex;gap:12px;justify-content:space-between}',
    '.tc-row>b{color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;',
    'font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.tc-note{opacity:.75;font-size:11.5px}',
    '.tc-bal-wrap{position:relative;display:inline-flex;flex-direction:column;align-items:flex-start}',
    '.tc-bal{gap:5px}',
    '.tc-bal-label{opacity:.72}',
    '.tc-bal-amount{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329);',
    'font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.tc-bal-wrap>.tc-detail{position:absolute;top:100%;left:0;z-index:30;margin-top:6px;min-width:210px;',
    'box-shadow:0 8px 24px rgba(15,20,30,.14);white-space:nowrap}',
    '@media (prefers-reduced-motion:reduce){.tc-line{transition:none}}',
  ].join('')

  /** 一行明细：左标签，右值。 */
  function detailRow(React, label, value, key) {
    return React.createElement('div', { className: 'tc-row', key: key },
      React.createElement('span', null, label),
      React.createElement('b', null, value),
    )
  }

  /** 一行说明文字。 */
  function note(React, text, key) {
    return React.createElement('div', { className: 'tc-note', key: key }, text)
  }

  /**
   * 造出组件（把 React 关在闭包里，bundle 里不依赖全局 React）。
   * @param React - 由工厂参数 require('react') 拿到的 React。
   * @returns 渲染「本轮花费」一行的 React 组件。
   */
  function makeComponent(React) {
    return function TurnCostLine(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var turn = props === null || props === undefined ? undefined : props.turn
      var usage = readTurnUsage(turn)
      // hook 已在上面无条件调用；没有账本就什么都不渲染。
      if (usage === undefined) return null
      var summary = computeSummary(usage, turnTime(turn))

      var head = [
        React.createElement('span', { className: 'tc-amount', key: 'amount' },
          summary.priced ? '≈ ¥' + formatRmb(summary.cost) : '¥ 未定价'),
        React.createElement('span', { className: 'tc-sep', key: 'sep1', 'aria-hidden': 'true' }, '·'),
        React.createElement('span', { className: 'tc-tok', key: 'tok' }, formatTokens(summary.total) + ' tok'),
      ]
      if (summary.hitText !== null) {
        head.push(React.createElement('span', { className: 'tc-sep', key: 'sep2', 'aria-hidden': 'true' }, '·'))
        head.push(React.createElement('span', { className: 'tc-hit', key: 'hit' }, '命中 ' + summary.hitText))
      }
      head.push(React.createElement('span', { className: 'tc-caret', key: 'caret', 'aria-hidden': 'true' },
        open ? '▴' : '▾'))

      var line = React.createElement('button', {
        type: 'button',
        className: 'tc-line',
        'aria-expanded': open ? 'true' : 'false',
        title: summary.priced ? '本轮实际花费（点击展开明细）' : '该模型未配置人民币单价（点击查看说明）',
        onClick: function () { setOpen(!open) },
      }, head)

      if (!open) return React.createElement('div', { className: 'tc-wrap' }, line)

      var body = []
      var routeText = summary.routes.length === 0
        ? '未知'
        : summary.routes.map(function (route) { return route.provider + '/' + route.model }).join('、')
      body.push(detailRow(React, '模型', routeText, 'k1'))
      body.push(detailRow(React, '时段', summary.peak ? '高峰（全价）' : '空闲（半价）', 'k2'))
      if (summary.priced) {
        for (var index = 0; index < summary.rows.length; index += 1) {
          var row = summary.rows[index]
          body.push(detailRow(
            React,
            row.label,
            formatExact(row.tokens) + ' tok × ¥' + row.rate + '/M = ¥' + formatRmb(row.amount),
            'r' + index,
          ))
        }
        body.push(detailRow(React, '合计', '¥' + formatRmb(summary.cost), 'k3'))
      } else {
        body.push(note(React,
          '这个模型没有人民币单价。在 client.js 顶部的 DEEPSEEK_PRICES 里加一行'
          + '（单位：元/百万 tokens），改完刷新页面即可。', 'n1'))
      }
      if (summary.cacheRead === null) {
        body.push(note(React, '供应商未上报「缓存命中输入」，未上报的输入按未命中保守计价。', 'n2'))
      }
      if (summary.routes.length > 1) {
        body.push(note(React, '本轮跨多个模型，按第一个模型的单价折算。', 'n3'))
      }

      return React.createElement('div', { className: 'tc-wrap' },
        line,
        React.createElement('div', { className: 'tc-detail' }, body),
      )
    }
  }

  /**
   * 造「账户余额」胶囊（挂在会话头部）。
   * @param React - require('react') 拿到的 React。
   * @param readBalance - 无参函数，返回 Promise<归一化余额 | null>。
   * @returns React 组件：`余额 ¥88.10 ▾`，点开是充值/赠送与更新时间。
   */
  function makeBalanceComponent(React, readBalance) {
    return function BalancePill() {
      var dataState = React.useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      React.useEffect(function () {
        var alive = true
        var load = function () {
          Promise.resolve(readBalance()).then(function (next) {
            if (alive) setData(next)
          }, function () {
            if (alive) setData(null)
          })
        }
        load()
        var timer = setInterval(load, BALANCE_REFRESH_MS)
        var onWake = function () { load() }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('focus', onWake)
        }
        return function () {
          alive = false
          clearInterval(timer)
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', onWake)
          }
        }
      }, [readBalance])
      // 未登录 / 余额不可用：这一格什么都不渲染，避免头部出现无意义的占位。
      if (!data || !data.text) return null

      var head = [
        React.createElement('span', { className: 'tc-bal-label', key: 'label' }, '余额'),
        React.createElement('span', { className: 'tc-bal-amount', key: 'amount' }, data.text),
        React.createElement('span', { className: 'tc-caret', key: 'caret', 'aria-hidden': 'true' },
          open ? '▴' : '▾'),
      ]
      var pill = React.createElement('button', {
        type: 'button',
        className: 'tc-line tc-bal',
        'aria-expanded': open ? 'true' : 'false',
        title: 'DeepSeek 账户余额（点击看充值 / 赠送明细）',
        onClick: function () { setOpen(!open) },
      }, head)
      if (!open) return pill

      var body = [detailRow(React, '充值余额', data.text, 'b1')]
      if (data.bonusText !== null) body.push(detailRow(React, '赠送余额', data.bonusText, 'b2'))
      body.push(detailRow(React, '更新时间', new Date(data.updatedAt).toLocaleTimeString(), 'b3'))
      return React.createElement('div', { className: 'tc-bal-wrap' },
        pill,
        React.createElement('div', { className: 'tc-detail' }, body),
      )
    }
  }

  // ────────────────────────────── 注册 ──────────────────────────────

  /** 注入组件样式（随插件卸载一起移除）。 */
  function injectStyles(ctx) {
    ctx.effect(function () {
      var tag = document.createElement('style')
      tag.setAttribute(STYLE_ATTR, '')
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return function () {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }, 'lingwu-conversation-cost.styles')
  }

  /** 把「本轮花费」一行挂到每一轮完成的回复下方，把「账户余额」胶囊挂到会话头部。 */
  function apply(ctx, React) {
    if (!ctx || !React) return
    injectStyles(ctx)
    var Component = makeComponent(React)
    ctx.effect(function () {
      return ctx.slots.inject(SLOT_NAME, function () {
        return ctx.slots.register({
          name: SLOT_NAME,
          id: CELL_ID,
          order: 10,
          label: '本轮花费',
        }, Component)
      })
    }, 'lingwu-conversation-cost.tail')
    var BalanceComponent = makeBalanceComponent(React, makeBalanceReader(ctx))
    ctx.effect(function () {
      return ctx.slots.inject(BALANCE_SLOT, function () {
        return ctx.slots.register({
          name: BALANCE_SLOT,
          id: BALANCE_CELL_ID,
          order: -20,
          label: '账户余额',
        }, BalanceComponent)
      })
    }, 'lingwu-conversation-cost.balance')
  }

  /** 纯函数 ＋ 组件的自检面（挂在 apply 上，不进 Cordis 插件契约）。 */
  function debugFace(React) {
    return {
      computeSummary: computeSummary,
      priceFor: priceFor,
      isPeakWindow: isPeakWindow,
      hitPercent: hitPercent,
      formatRmb: formatRmb,
      formatTokens: formatTokens,
      formatExact: formatExact,
      readTurnUsage: readTurnUsage,
      Component: makeComponent(React),
      formatMoney: formatMoney,
      balanceText: balanceText,
      normalizeBalance: normalizeBalance,
      accountClientMetadata: accountClientMetadata,
      makeBalanceReader: makeBalanceReader,
      Balance: makeBalanceComponent(React, function () { return Promise.resolve(null) }),
      balanceSlot: BALANCE_SLOT,
      balanceCellId: BALANCE_CELL_ID,
    }
  }

  window.__ModuleLoader__.load({
    id: 'lingwu-dsh-conversation-cost',
    factory: function (require) {
      var React = require('react')
      var bound = function (ctx) { apply(ctx, React) }
      bound.debug = debugFace(React)
      return {
        name: 'lingwu-conversation-cost',
        // slots：槽位注册；remote / remote.account：余额走账号 Remote（Cordis 注入守卫要求显式声明）。
        inject: ['slots', 'remote', 'remote.account'],
        apply: bound,
      }
    },
  })
})()
