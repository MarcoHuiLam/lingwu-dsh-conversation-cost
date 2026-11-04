#!/usr/bin/env node
/**
 * 把「工作区里的插件源码」同步进本 skill 的分发副本（跨平台，纯 Node）。
 *
 * 本 skill 的 plugin/ 是给别的机器安装用的副本；日常改代码/改价请改工作区那份，
 * 改完跑一次本脚本，让分发副本跟上。
 *
 * 用法：
 *   node scripts/sync-plugin.mjs "<插件源码目录>"            # 同步
 *   node scripts/sync-plugin.mjs "<插件源码目录>" --check     # 只比对，不写
 *
 * 例：
 *   node scripts/sync-plugin.mjs "<别处的插件源码目录>"
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

const FILES = [
  ['index.js', ['plugin', 'index.js']],
  ['client.js', ['plugin', 'client.js']],
  ['package.json', ['plugin', 'package.json']],
  [join('test', 'client.test.mjs'), ['test', 'client.test.mjs']],
]

function digest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
  } catch {
    return 'missing'
  }
}

const source = process.argv[2]
const checkOnly = process.argv.includes('--check')
if (source === undefined) {
  console.error('用法: node scripts/sync-plugin.mjs "<插件源码目录>" [--check]')
  process.exit(2)
}
const sourceRoot = resolve(source)
if (!existsSync(sourceRoot)) {
  console.error('找不到插件源码目录: ' + sourceRoot)
  process.exit(2)
}

let changed = 0
let drift = 0
for (const [relative, targetParts] of FILES) {
  const from = join(sourceRoot, relative)
  const to = join(SKILL_ROOT, ...targetParts)
  if (!existsSync(from)) {
    console.log('  - 跳过（源里没有）: ' + relative)
    continue
  }
  const before = digest(to)
  const after = digest(from)
  if (checkOnly) {
    const same = before === after
    if (!same) drift += 1
    console.log((same ? '  ✓ ' : '  ✗ ') + relative + '  skill=' + before + ' source=' + after)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  const now = digest(to)
  if (now !== before) changed += 1
  console.log('  → ' + relative + '  ' + before + ' → ' + now)
}

if (checkOnly) {
  console.log(drift === 0 ? '\n同步一致。' : '\n有 ' + drift + ' 个文件不一致：去掉 --check 重跑。')
  process.exitCode = drift === 0 ? 0 : 1
} else {
  console.log('\n已同步 ' + changed + ' 个文件到 ' + SKILL_ROOT)
}
