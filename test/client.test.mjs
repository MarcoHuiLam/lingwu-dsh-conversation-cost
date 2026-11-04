/**
 * lingwu-dsh-conversation-cost 离线自检：不打开浏览器也能验证「计价数学 + 渲染结构 + 槽位注册」。
 *
 * 做法：在宿主 realm 里用 new Function('window','document', source) 执行真实的
 * client.js（它只会在末尾调用 window.__ModuleLoader__.load 注册工厂），拿到工厂
 * 后用桩 React 渲染组件，再把整棵树拍平成文本做断言。
 *
 * 运行：node test/client.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
// 同一份测试有两种目录形态：
//   工作区源码：<pkg>/test/client.test.mjs + <pkg>/client.js
//   skill 副本：<skill>/test/client.test.mjs + <skill>/plugin/client.js
const SOURCE = [join(HERE, '..', 'client.js'), join(HERE, '..', 'plugin', 'client.js')]
  .map(candidate => {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      return undefined
    }
  })
  .find(text => text !== undefined)
if (SOURCE === undefined) throw new Error('找不到 client.js（试过 <pkg>/client.js 与 <pkg>/plugin/client.js）')

/** 极简 React 桩：只提供 createElement / useState / useEffect。 */
function fakeReact(initialOpen) {
  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  })
  return {
    createElement,
    useState: () => [initialOpen, () => {}],
    useEffect: () => {},
  }
}

/** 极简 document 桩：只够注入样式标签用。 */
function fakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
    },
  }
  return {
    head,
    createElement() {
      return {
        parentNode: null,
        attributes: {},
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        getAttribute(name) {
          return this.attributes[name]
        },
      }
    },
  }
}

/**
 * 加载 client.js 并取出插件工厂。
 * @param {boolean} initialOpen - 桩 useState 的初始展开状态。
 * @returns {{ plugin: object, React: object, document: object }}
 */
function loadPlugin(initialOpen = false) {
  const captured = []
  const React = fakeReact(initialOpen)
  const document = fakeDocument()
  const window = { __ModuleLoader__: { load: definition => captured.push(definition) } }
  // 在宿主 realm 里执行：跨 realm 的数组/对象会让 deepStrictEqual 因原型不同而失败。
  new Function('window', 'document', SOURCE)(window, document)
  assert.equal(captured.length, 1, 'client.js 必须恰好注册一个运行时 bundle')
  const definition = captured[0]
  assert.equal(definition.id, 'lingwu-dsh-conversation-cost')
  const plugin = definition.factory(specifier => {
    assert.equal(specifier, 'react', '只允许 require("react")')
    return React
  })
  return { plugin, React, document }
}

/** 把 React 元素树拍平成文本。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/** 收集树里所有 className。 */
function classesOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) classesOf(child, out)
    return out
  }
  if (node.props?.className) out.push(node.props.className)
  classesOf(node.children, out)
  return out
}

/** 造一个 turnTail 槽位会传进来的 TurnLocation。 */
function fakeTurn(tokenUsage, atMs) {
  return {
    start: { time: atMs - 60_000 },
    end: { time: atMs },
    data: {
      get(key) {
        if (key !== 'turn-tail') return undefined
        return { turn: 1, seq: 10, time: atMs, closing: null, branchUnavailable: false, tokenUsage }
      },
    },
  }
}

const USAGE = {
  uncachedInputTokens: 1000,
  outputTokens: 3400,
  totalTokens: 54400,
  cacheReadTokens: 50000,
  routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
}

const PEAK_WEDNESDAY_10 = Date.parse('2026-10-28T10:00:00+08:00')
const OFF_WEDNESDAY_20 = Date.parse('2026-10-28T20:00:00+08:00')
const SATURDAY_10 = Date.parse('2026-10-31T10:00:00+08:00')

const { plugin } = loadPlugin()
const debug = plugin.apply.debug
assert.ok(debug, 'apply.debug 必须暴露自检入口')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}
async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

console.log('lingwu-dsh-conversation-cost 自检')

check('插件声明的槽位与账户依赖', () => {
  // remote.account 必须显式声明：Cordis 注入守卫会在没声明时抛
  // "cannot get property \"remote.account\" without inject"。
  assert.deepEqual(plugin.inject, ['slots', 'remote', 'remote.account'])
  assert.equal(plugin.name, 'lingwu-dsh-conversation-cost')
})

check('deepseek-flash 价格表（官方人民币价）', () => {
  const table = debug.priceFor('deepseek-official', 'deepseek-flash')
  assert.deepEqual(table.peak, { miss: 2, hit: 0.04, write: 2, out: 8 })
  assert.deepEqual(table.off, { miss: 1, hit: 0.02, write: 1, out: 4 })
})

check('deepseek-v4-pro 价格表', () => {
  const table = debug.priceFor('deepseek-account', 'deepseek-v4-pro')
  assert.deepEqual(table.peak, { miss: 9, hit: 0.3, write: 9, out: 27 })
})

check('旧模型名按 Flash 计价', () => {
  assert.equal(debug.priceFor('deepseek-official', 'deepseek-v4-flash').peak.miss, 2)
  assert.equal(debug.priceFor('deepseek-official', 'deepseek-v4.1-flash-1017').peak.out, 8)
})

check('非 DeepSeek 供应商不给人民币价', () => {
  assert.equal(debug.priceFor('pi-ai', 'deepseek-flash'), null)
  assert.equal(debug.priceFor('deepseek-official', 'mystery-model'), null)
  assert.equal(debug.priceFor(undefined, 'deepseek-flash'), null)
})

check('高峰/空闲时段判定（北京时间）', () => {
  assert.equal(debug.isPeakWindow(PEAK_WEDNESDAY_10), true)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T11:59:00+08:00')), true)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T12:00:00+08:00')), false)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T13:30:00+08:00')), false)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T14:00:00+08:00')), true)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T17:59:00+08:00')), true)
  assert.equal(debug.isPeakWindow(Date.parse('2026-10-28T18:00:00+08:00')), false)
  assert.equal(debug.isPeakWindow(OFF_WEDNESDAY_20), false)
  assert.equal(debug.isPeakWindow(SATURDAY_10), false)
})

check('高峰价计算：¥0.0312', () => {
  const summary = debug.computeSummary(USAGE, PEAK_WEDNESDAY_10)
  assert.equal(summary.priced, true)
  assert.equal(summary.peak, true)
  assert.equal(summary.cost.toFixed(6), '0.031200')
  assert.equal(summary.hitText, '98.0%')
  assert.equal(debug.formatRmb(summary.cost), '0.0312')
  assert.equal(debug.formatTokens(summary.total), '54.4k')
  for (const row of summary.rows) {
    assert.equal(row.amount.toFixed(6), (row.tokens * row.rate / 1e6).toFixed(6))
  }
})

check('空闲时段是高峰价的一半：¥0.0156', () => {
  const summary = debug.computeSummary(USAGE, OFF_WEDNESDAY_20)
  assert.equal(summary.peak, false)
  assert.equal(summary.cost.toFixed(6), '0.015600')
})

check('缓存命中率：100% 只在真的全命中时出现', () => {
  assert.equal(debug.hitPercent(50000, 50000), '100%')
  assert.equal(debug.hitPercent(49999, 50000), '99.99%')
  assert.equal(debug.hitPercent(0, 50000), '0.0%')
  assert.equal(debug.hitPercent(null, 50000), null)
  assert.equal(debug.hitPercent(10, 0), null)
})

check('未上报缓存桶时，差额按未命中保守计价', () => {
  const usage = {
    uncachedInputTokens: 1000,
    outputTokens: 100,
    totalTokens: 5000,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  }
  const summary = debug.computeSummary(usage, PEAK_WEDNESDAY_10)
  assert.equal(summary.hidden, 3900)
  assert.equal(summary.cost.toFixed(6), '0.010600')
  assert.equal(summary.hitText, null)
})

check('未定价模型仍然显示 token，只说未定价', () => {
  const usage = { ...USAGE, routes: [{ provider: 'pi-ai', model: 'deepseek-flash' }] }
  const summary = debug.computeSummary(usage, PEAK_WEDNESDAY_10)
  assert.equal(summary.priced, false)
  assert.equal(summary.cost, null)
})

check('没有账本的轮次不渲染（返回 null）', () => {
  const { plugin: fresh } = loadPlugin()
  const Component = fresh.apply.debug.Component
  assert.equal(Component({ turn: undefined }), null)
  assert.equal(Component({}), null)
  assert.equal(Component({ turn: { data: { get: () => undefined } } }), null)
  assert.equal(Component({ turn: { data: { get: () => ({ tokenUsage: undefined }) } } }), null)
})

check('收起态渲染出「≈ ¥ · tok · 命中」一行', () => {
  const { plugin: fresh } = loadPlugin(false)
  const Component = fresh.apply.debug.Component
  const tree = Component({ turn: fakeTurn(USAGE, PEAK_WEDNESDAY_10) })
  const text = textOf(tree)
  assert.match(text, /≈ ¥0\.0312/)
  assert.match(text, /54\.4k tok/)
  assert.match(text, /命中 98\.0%/)
  assert.match(text, /▾/)
  assert.ok(!classesOf(tree).includes('tc-detail'), '收起态不应出现明细面板')
})

check('展开态渲染出明细：三段单价与小计、时段、模型', () => {
  const { plugin: fresh } = loadPlugin(true)
  const Component = fresh.apply.debug.Component
  const tree = Component({ turn: fakeTurn(USAGE, PEAK_WEDNESDAY_10) })
  const text = textOf(tree)
  const classes = classesOf(tree)
  assert.ok(classes.includes('tc-detail'))
  assert.match(text, /deepseek-official\/deepseek-flash/)
  assert.match(text, /高峰（全价）/)
  assert.match(text, /未命中输入/)
  assert.match(text, /1,000 tok × ¥2\/M = ¥0\.002/)
  assert.match(text, /缓存命中输入/)
  assert.match(text, /50,000 tok × ¥0\.04\/M = ¥0\.002/)
  assert.match(text, /输出/)
  assert.match(text, /3,400 tok × ¥8\/M = ¥0\.0272/)
  assert.match(text, /合计/)
  assert.match(text, /¥0\.0312/)
})

check('展开态在空闲时段说半价', () => {
  const { plugin: fresh } = loadPlugin(true)
  const text = textOf(fresh.apply.debug.Component({ turn: fakeTurn(USAGE, OFF_WEDNESDAY_20) }))
  assert.match(text, /空闲（半价）/)
  assert.match(text, /1,000 tok × ¥1\/M/)
})

check('展开态对未定价模型给出补价提示', () => {
  const { plugin: fresh } = loadPlugin(true)
  const usage = { ...USAGE, routes: [{ provider: 'pi-ai', model: 'unknown' }] }
  const text = textOf(fresh.apply.debug.Component({ turn: fakeTurn(usage, PEAK_WEDNESDAY_10) }))
  assert.match(text, /未定价/)
  assert.match(text, /DEEPSEEK_PRICES/)
})

check('槽位注册：turnTail 花费行 + 会话头部余额胶囊', () => {
  const { plugin: fresh } = loadPlugin()
  const registered = []
  const ctx = {
    effect(fn) { return fn() },
    get() { return undefined },
    slots: {
      inject(name, callback) { return callback() },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
  }
  fresh.apply(ctx)
  assert.equal(registered.length, 2)
  const cost = registered.find(entry => entry.options.id === 'lingwu-conversation-cost')
  const balance = registered.find(entry => entry.options.id === 'lingwu-conversation-cost-balance')
  assert.deepEqual(cost.options, {
    name: 'conversation.chat.turnTail',
    id: 'lingwu-conversation-cost',
    order: 10,
    label: '本轮花费',
  })
  assert.deepEqual(balance.options, {
    name: 'conversation.session.header.utilities',
    id: 'lingwu-conversation-cost-balance',
    order: -20,
    label: '账户余额',
  })
  assert.equal(typeof cost.component, 'function')
  assert.equal(typeof balance.component, 'function')
})

check('样式注入到 head，并带 data-lingwu-dsh-conversation-cost 标记', () => {
  const { plugin: fresh, document } = loadPlugin()
  const ctx = {
    effect(fn) { return fn() },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  fresh.apply(ctx)
  assert.equal(document.head.children.length, 1)
  const tag = document.head.children[0]
  assert.equal(tag.getAttribute('data-lingwu-dsh-conversation-cost'), '')
  assert.ok(tag.textContent.includes('.tc-line'))
  assert.ok(tag.textContent.includes('.tc-detail'))
})

check('余额金额格式化：千分位 + 两位小数', () => {
  assert.equal(debug.formatMoney(1234.5), '1,234.50')
  assert.equal(debug.formatMoney(0), '0.00')
  assert.equal(debug.formatMoney(0.014), '0.01')
  assert.equal(debug.formatMoney(-12.345), '-12.35')
})

check('余额取人民币钱包之和', () => {
  const wallets = [
    { currency: 'CNY', balance: '120.5' },
    { currency: 'CNY', balance: '0.25' },
    { currency: 'USD', balance: '9.99' },
  ]
  assert.equal(debug.balanceText(wallets), '¥120.75')
  assert.equal(debug.balanceText([{ currency: 'USD', balance: '3.5' }]), '$3.50')
  assert.equal(debug.balanceText([]), null)
  assert.equal(debug.balanceText([{ currency: 'CNY', balance: 'oops' }]), null)
})

check('余额归一化：ready 取充值/赠送，failed 与 null 一律不可用', () => {
  const ready = debug.normalizeBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '88.10' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  })
  assert.equal(ready.text, '¥88.10')
  assert.equal(ready.bonusText, '¥5.00')
  assert.ok(typeof ready.updatedAt === 'number')
  assert.equal(debug.normalizeBalance({ status: 'failed' }), null)
  assert.equal(debug.normalizeBalance(null), null)
  assert.equal(debug.normalizeBalance({ status: 'ready', value: [] }), null)
})

check('账户调用元数据：版本、语言、时区秒数，且不含密钥字段', () => {
  const meta = debug.accountClientMetadata()
  assert.equal(typeof meta.version, 'string')
  assert.ok(meta.version.length > 0)
  assert.equal(typeof meta.locale, 'string')
  assert.equal(Number.isInteger(meta.timezoneOffsetSeconds), true)
  assert.equal(Object.keys(meta).sort().join(','), 'locale,timezoneOffsetSeconds,version')
})

await checkAsync('余额读取器：走 remote.account.getBalance 并归一化', async () => {
  const calls = []
  const ctx = {
    get(name) {
      assert.equal(name, 'remote')
      return {
        account: {
          getBalance(meta) {
            calls.push(meta)
            return Promise.resolve({
              ok: true,
              value: { status: 'ready', value: [{ currency: 'CNY', balance: '56.78' }], bonusWallets: [] },
            })
          },
        },
      }
    },
  }
  const balance = await debug.makeBalanceReader(ctx)()
  assert.equal(balance.text, '¥56.78')
  assert.equal(balance.bonusText, null)
  assert.equal(calls.length, 1)
  assert.equal(typeof calls[0].version, 'string')
})

await checkAsync('余额读取器：没有账号 Remote 时安静返回 null', async () => {
  assert.equal(await debug.makeBalanceReader({ get: () => undefined })(), null)
  assert.equal(await debug.makeBalanceReader(undefined)(), null)
  assert.equal(await debug.makeBalanceReader({ get: () => ({}) })(), null)
})

await checkAsync('余额读取器：Remote 报错 / failed 时返回 null，不抛异常', async () => {
  const failing = {
    get: () => ({ account: { getBalance: () => Promise.reject(new Error('boom')) } }),
  }
  assert.equal(await debug.makeBalanceReader(failing)(), null)
  const failed = {
    get: () => ({ account: { getBalance: () => Promise.resolve({ ok: true, value: { status: 'failed' } }) } }),
  }
  assert.equal(await debug.makeBalanceReader(failed)(), null)
  const throwing = {
    get: () => ({ account: { getBalance: () => { throw new Error('sync boom') } } }),
  }
  assert.equal(await debug.makeBalanceReader(throwing)(), null)
})

await checkAsync('余额读取器：注入守卫抛错 / account 取值抛错时也要安静降级', async () => {
  // 模拟 Cordis 注入守卫：ctx.get 直接抛 "cannot get property ... without inject"。
  const guarded = { get: () => { throw new Error('cannot get property "remote.account" without inject') } }
  assert.equal(await debug.makeBalanceReader(guarded)(), null)
  // 模拟 Proxy 守卫：remote 拿到了，但访问 .account 时抛错。
  const proxy = {
    get: () => ({
      get account() { throw new Error('cannot get property "remote.account" without inject') },
    }),
  }
  assert.equal(await debug.makeBalanceReader(proxy)(), null)
  // Remote 返回值形状异常（getter 抛错）也不能冒泡。
  const badShape = {
    get: () => ({
      account: {
        getBalance: () => Promise.resolve({ ok: true, get value() { throw new Error('bad shape') } }),
      },
    }),
  }
  assert.equal(await debug.makeBalanceReader(badShape)(), null)
})

check('余额胶囊：没有数据时不渲染（返回 null）', () => {
  const { plugin: fresh } = loadPlugin()
  assert.equal(fresh.apply.debug.Balance({}), null)
})

console.log('\n全部通过：' + passed + ' 项')
