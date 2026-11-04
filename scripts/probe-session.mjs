#!/usr/bin/env node
/**
 * 会话日志逐轮核对器（诊断用，跨平台纯 Node）
 *
 * 作用：直接解 DSH 的会话日志（`session.v4.jsonl.zstd`，多帧追加的 zstd），
 * 逐轮打印 token 账本、缓存命中率、按官方价估算的人民币花费，用来核对
 * 页面上的「≈ ¥x · tok · 命中 x%」到底对不对，或者判断「为什么页面没显示」。
 *
 * 用法：
 *   node scripts/probe-session.mjs "<session.v4.jsonl.zstd>"
 *   node scripts/probe-session.mjs "<...>" --checkout "D:\DSH\deepseek-harness"
 *
 * 会话日志位置：
 *   <DSH_HOME>/sessions/<工作区哈希>/<session-id>/session.v4.jsonl.zstd
 *
 * --checkout 指向 DSH 源码目录时，额外用 DSH 自己的 deriveTurnTokenUsage 复核
 * （这是 ui-chat 真正用的函数，需要该目录里有 tsx 依赖，命令要带 --import tsx/esm）。
 * 不带 --checkout 时用本脚本自带的近似合计，仅作参考。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const MAGIC = '\u0028\u00b5\u002f\u00fd'

/** 会话日志是逐帧追加的 zstd；单次解压只认第一帧，所以按帧魔数切开逐帧解。 */
function decompressAll(buffer) {
  const latin = buffer.toString('latin1')
  const starts = []
  let at = latin.indexOf(MAGIC)
  while (at >= 0) {
    starts.push(at)
    at = latin.indexOf(MAGIC, at + 1)
  }
  const parts = []
  let index = 0
  while (index < starts.length) {
    let candidate = index + 1
    let end = candidate < starts.length ? starts[candidate] : buffer.length
    let decoded
    for (;;) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8')
        break
      } catch {
        if (candidate >= starts.length) return parts.join('')
        end = candidate + 1 < starts.length ? starts[candidate + 1] : buffer.length
        candidate += 1
      }
    }
    parts.push(decoded)
    index = candidate
  }
  return parts.join('')
}

// 官方价：元 / 百万 tokens（与插件 client.js 顶部 DEEPSEEK_PRICES 同一份口径）
const PRICES = {
  'deepseek-flash': { peak: { miss: 2, hit: 0.04, out: 8 }, off: { miss: 1, hit: 0.02, out: 4 } },
  'deepseek-v4-pro': { peak: { miss: 9, hit: 0.3, out: 27 }, off: { miss: 4.5, hit: 0.15, out: 13.5 } },
}
const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-flash',
}

/** 北京时间高峰：周一至周五 9:00-12:00、14:00-18:00。 */
function isPeak(ms) {
  const beijing = new Date(ms + 8 * 3600 * 1000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

function estimate(usage, atMs) {
  const model = usage.routes?.[0]?.model
  if (model === undefined) return null
  const table = PRICES[ALIASES[model] ?? model]
  if (table === undefined) return null
  const rates = isPeak(atMs) ? table.peak : table.off
  const miss = usage.uncachedInputTokens ?? 0
  const hit = usage.cacheReadTokens ?? 0
  const out = usage.outputTokens ?? 0
  return {
    peak: isPeak(atMs),
    cost: (miss * rates.miss + hit * rates.hit + out * rates.out) / 1e6,
    hitPercent: hit + miss > 0 ? (hit / (hit + miss) * 100) : null,
  }
}

function formatTokens(value) {
  return value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'k' : String(value)
}

const file = process.argv[2]
const checkoutIndex = process.argv.indexOf('--checkout')
const checkout = checkoutIndex > 0 ? resolve(process.argv[checkoutIndex + 1]) : undefined
if (file === undefined || file.startsWith('--')) {
  console.error('用法: node scripts/probe-session.mjs "<session.v4.jsonl.zstd>" [--checkout <DSH源码目录>]')
  process.exit(2)
}

const events = decompressAll(readFileSync(file)).split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
const header = events[0]
console.log('会话      : ' + header.id)
console.log('cwd       : ' + header.cwd)
console.log('创建时间  : ' + new Date(header.createdAt).toISOString())
console.log('事件数    : ' + events.length)

for (const event of events) {
  if (event.type === 'session/title') console.log('标题      : ' + event.data.title)
}

// 按 turn 分桶
const turns = new Map()
for (const event of events) {
  const turn = event.data?.turn
  if (turn === undefined) continue
  if (!turns.has(turn)) turns.set(turn, [])
  turns.get(turn).push(event)
}
const ids = [...turns.keys()].sort((a, b) => a - b)
console.log('轮次      : ' + ids.length + ' 轮 (' + ids.join(', ') + ')')

// 可选：用 DSH 自己的派生函数复核
let derive
if (checkout !== undefined) {
  try {
    const module = await import(pathToFileURL(join(checkout, 'packages/llm/token-meter/src/turn-usage.ts')).href)
    derive = module.deriveTurnTokenUsage
    console.log('复核函数  : DSH deriveTurnTokenUsage（来自 ' + checkout + '）')
  } catch (error) {
    console.log('复核函数  : 载入失败（' + String((error && error.message) || error) + '）；改用本脚本近似合计')
    console.log('            提示：导入 TS 源码需要 `node --import tsx/esm scripts/probe-session.mjs …`')
  }
} else {
  console.log('复核函数  : 未提供 --checkout，用本脚本近似合计（仅供参考）')
}

let openTurns = 0
for (const turn of ids) {
  const of = turns.get(turn)
  const types = of.map(event => event.type)
  const ended = types.includes('turn/end')
  if (!ended) openTurns += 1
  // 近似合计：把每条 assistant/message 的 usage 相加
  const sum = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, routes: [] }
  let messages = 0
  for (const event of of) {
    if (event.type !== 'assistant/message') continue
    messages += 1
    const usage = event.data.usage
    if (usage?.inputTokens !== undefined) sum.uncachedInputTokens += usage.inputTokens
    if (usage?.outputTokens !== undefined) sum.outputTokens += usage.outputTokens
    if (usage?.cacheReadTokens !== undefined) sum.cacheReadTokens += usage.cacheReadTokens
    if (usage?.totalTokens !== undefined) sum.totalTokens += usage.totalTokens
    const route = event.data.message?.source
    if (route?.provider !== undefined && route?.model !== undefined) {
      const key = route.provider + '/' + route.model
      if (!sum.routes.some(candidate => candidate.key === key)) {
        sum.routes.push({ key, provider: route.provider, model: route.model })
      }
    }
  }
  const end = of.find(event => event.type === 'turn/end')
  const at = end?.time ?? of.at(-1)?.time ?? Date.now()
  const priced = estimate(sum, at)
  const authoritative = derive === undefined ? undefined : derive(of)
  console.log(`
— turn ${turn} ${ended ? '' : '（进行中，没有 turn/end → 页面上不会出现结算行）'}
  事件 ${of.length}，assistant/message ${messages}，step/start ${types.filter(t => t === 'step/start').length}
  近似 token: 未命中 ${formatTokens(sum.uncachedInputTokens)} / 缓存命中 ${formatTokens(sum.cacheReadTokens)} / 输出 ${formatTokens(sum.outputTokens)} / 合计 ${formatTokens(sum.totalTokens)}
  ${priced === null ? '估算花费: 无单价（该模型不在价格表里）' : `估算花费: ≈ ¥${priced.cost.toFixed(4)}（${priced.peak ? '高峰' : '空闲'}时段，命中率 ${priced.hitPercent === null ? '—' : priced.hitPercent.toFixed(1) + '%'}）`}
  ${authoritative === undefined ? '' : 'DSH 复核: ' + (authoritative === undefined ? 'undefined（够不上精确条件，页面也不显示）' : JSON.stringify(authoritative))}`)
}

console.log('\n结论：' + (openTurns > 0
  ? '有 ' + openTurns + ' 轮还没结束；它结束（turn/end 落盘）后页面才会出现该轮的「≈ ¥」行。'
  : '所有轮次都已结束，页面上应能看到每一轮的结算行；若还没看到，先刷新页面，再查 Loader 是否挂载了本插件。'))
