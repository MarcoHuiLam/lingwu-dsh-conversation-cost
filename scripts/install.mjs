#!/usr/bin/env node
/**
 * lingwu-dsh-conversation-cost 跨平台安装器（Windows / macOS / Linux 同一个脚本）
 *
 * 做三件事，全部幂等：
 *   1. 把插件包复制到 <DSH_HOME>/plugins/lingwu-dsh-conversation-cost   （机器级，与 skill 所在位置解耦）
 *   2. 在 profile 的 node_modules 里挂上它（优先 junction/symlink，失败则复制）
 *   3. 在 <DSH_HOME>/cordis.patch.yml 里补一行挂载（已有则跳过）
 *
 * 只用 Node 内置模块：不依赖 pnpm、不依赖 PowerShell/bash、不写死盘符。
 *
 * 用法：
 *   node scripts/install.mjs                 # 装到 $DSH_HOME/profiles/web
 *   node scripts/install.mjs --check         # 只体检，不改任何东西
 *   node scripts/install.mjs --dry-run       # 只打印将要做什么
 *   node scripts/install.mjs --profile tui   # 换 profile
 *   node scripts/install.mjs --home /path/to/.dsh --from <插件源码目录>
 *   node scripts/install.mjs --force         # 已装过也强制换成 plugins/ 下的独立副本
 *   node scripts/install.mjs --mode copy     # 不用软链，直接复制进 node_modules
 */
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const PACKAGE_NAME = 'lingwu-dsh-conversation-cost'
const ROW_ID = PACKAGE_NAME

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(SKILL_ROOT, 'plugin', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

/** 解析 `--key value` 与 `--flag`。 */
function parseArgs(argv) {
  const options = { mode: 'auto', profile: 'web', check: false, dryRun: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--check') options.check = true
    else if (token === '--dry-run') options.dryRun = true
    else if (token === '--force') options.force = true
    else if (token === '--home') options.home = argv[++index]
    else if (token === '--profile') options.profile = argv[++index]
    else if (token === '--from') options.from = argv[++index]
    else if (token === '--mode') options.mode = argv[++index]
    else if (token === '--help' || token === '-h') options.help = true
    else if (token.startsWith('--')) throw new Error('未知参数: ' + token)
  }
  return options
}

function help() {
  console.log('lingwu-dsh-conversation-cost 安装器 ' + VERSION + `

  node scripts/install.mjs [选项]

  --home <目录>           DSH_HOME（默认 $DSH_HOME，其次 ~/.dsh）
  --profile <名字>        profile 名（默认 web）
  --from <目录>           插件源码目录（默认本 skill 的 plugin/）
  --check                 只体检，不修改
  --dry-run               只打印计划
  --force                 已装过也强制换成本副本
  --mode auto|link|copy   profile/node_modules 的挂载方式（默认 auto：先软链，失败则复制）
  --help, -h              本说明
`)
}

/** 读文本，不存在返回空串。 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** patch 里是否已有本插件的挂载行。 */
function hasRow(text) {
  return new RegExp('^\\s*-\\s*id:\\s*' + ROW_ID + '\\s*$', 'm').test(text)
}

/** profile/node_modules 里的挂载点现状。 */
function mountState(path) {
  try {
    const stats = lstatSync(path)
    if (!stats.isSymbolicLink()) return { kind: 'dir' }
    return { kind: 'link', target: resolve(dirname(path), readlinkSync(path)) }
  } catch {
    return undefined
  }
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    help()
    return 0
  }

  const home = resolve(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profileDir = join(home, 'profiles', options.profile)
  const pluginSource = resolve(options.from ?? join(SKILL_ROOT, 'plugin'))
  const pluginTarget = join(home, 'plugins', PACKAGE_NAME)
  const profileManifest = join(profileDir, 'package.json')
  const modulesDir = join(profileDir, 'node_modules')
  const mountPath = join(modulesDir, PACKAGE_NAME)
  const patchPath = join(home, 'cordis.patch.yml')

  console.log('DSH_HOME    : ' + home)
  console.log('profile     : ' + options.profile + '  (' + profileDir + ')')
  console.log('插件源码    : ' + pluginSource)
  console.log('独立副本    : ' + pluginTarget)
  console.log('profile 挂载: ' + mountPath)

  if (!existsSync(pluginSource)) {
    console.error('\n[!] 找不到插件源码目录: ' + pluginSource)
    return 2
  }
  if (!existsSync(profileManifest)) {
    console.error('\n[!] 这个 DSH 下没有 profile "' + options.profile + '"（缺 ' + profileManifest + '）')
    console.error('    用 --profile 指定一个已存在的 profile，或在 DSH 里先建一个。')
    return 2
  }

  const patchText = readText(patchPath)
  const rowPresent = hasRow(patchText)
  const mount = mountState(mountPath)
  const targetPresent = existsSync(pluginTarget)

  // ── --check：只体检 ──────────────────────────────────────────────
  if (options.check) {
    const checks = [
      ['profile/node_modules 里有 lingwu-dsh-conversation-cost（可被 Loader 解析）', mount !== undefined],
      ['cordis.patch.yml 有 - id: ' + ROW_ID + ' 挂载行', rowPresent],
    ]
    let bad = 0
    for (const [label, ok] of checks) {
      if (!ok) bad += 1
      console.log((ok ? '  ✓ ' : '  ✗ ') + label)
    }
    if (mount !== undefined) {
      console.log('    挂载形态: ' + (mount.kind === 'link' ? 'link → ' + mount.target : '实目录（复制）'))
    }
    console.log('    独立副本: ' + (targetPresent ? pluginTarget : '无（用 --force 可换成本 skill 的副本）'))
    if (bad === 0) {
      console.log('\n已安装。刷新 DSH 页面即可看到「每轮花费」行。')
      return 0
    }
    console.log('\n未装好（' + bad + ' 项缺失）：运行 node scripts/install.mjs')
    return 1
  }

  // ── 计划 ────────────────────────────────────────────────────────
  const plan = []
  if (!targetPresent || options.force) plan.push('复制插件 → ' + pluginTarget)
  if (mount === undefined || options.force) {
    plan.push('挂载到 ' + mountPath + '（mode=' + options.mode + '）')
  } else {
    plan.push('挂载点已存在（' + (mount.kind === 'link' ? 'link → ' + mount.target : '实目录') + '），保留不动')
  }
  if (!rowPresent) plan.push('在 ' + patchPath + ' 追加挂载行')

  console.log('\n计划：')
  for (const step of plan) console.log('  · ' + step)
  if (options.dryRun) {
    console.log('\n--dry-run：什么都没改。')
    return 0
  }

  // ── 1. 复制插件到 DSH_HOME/plugins ──────────────────────────────
  mkdirSync(dirname(pluginTarget), { recursive: true })
  if (!targetPresent || options.force) {
    rmSync(pluginTarget, { recursive: true, force: true })
    cpSync(pluginSource, pluginTarget, { recursive: true })
    console.log('\n[1/3] 已复制插件 → ' + pluginTarget)
  } else {
    console.log('\n[1/3] 独立副本已存在，跳过')
  }

  // ── 2. profile/node_modules 挂载 ────────────────────────────────
  if (mount === undefined || options.force) {
    mkdirSync(modulesDir, { recursive: true })
    if (mount !== undefined) rmSync(mountPath, { recursive: true, force: true })
    let mounted = options.mode === 'copy' ? 'copy' : 'link'
    if (mounted === 'link') {
      try {
        symlinkSync(pluginTarget, mountPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        console.log('[2/3] 软链失败（' + String((error && error.message) || error) + '），改用复制')
        mounted = 'copy'
      }
    }
    if (mounted === 'copy') {
      rmSync(mountPath, { recursive: true, force: true })
      cpSync(pluginTarget, mountPath, { recursive: true })
    }
    console.log('[2/3] 已挂载（' + (mounted === 'link' ? 'link → plugins/' + PACKAGE_NAME : '复制') + '）')
    console.log('      注：这是手工挂载，不写在 profile/package.json 里；以后若对该 profile 跑 pnpm install，重跑本脚本即可。')
  } else {
    console.log('[2/3] 挂载点已存在，保留现有形态（--force 可换成独立副本）')
  }

  // ── 3. cordis.patch.yml 挂载行 ──────────────────────────────────
  if (!rowPresent) {
    const block = [
      '',
      '# 每轮花费（lingwu-dsh-conversation-cost）：每轮回复下方显示人民币花费 / token / 缓存命中率',
      '- insert:',
      '    - id: ' + ROW_ID,
      '      name: ' + PACKAGE_NAME,
      '',
    ].join('\n')
    mkdirSync(dirname(patchPath), { recursive: true })
    const base = patchText === '' ? '# DSH 机器级插件层\n' : patchText.replace(/\s*$/, '\n')
    writeFileSync(patchPath, base + block, 'utf8')
    console.log('[3/3] 已写入挂载行 → ' + patchPath)
  } else {
    console.log('[3/3] 挂载行已存在，跳过')
  }

  console.log(`
装好了。接下来：

  1) 刷新浏览器里的 DSH 页面（配置热重载会自动挂载它；若页面没变化，重启 dsh web 最稳）。
  2) 每轮对话结束，回复下方出现：≈ ¥0.0123 · 51.4k tok · 命中 98.0% ▾
  3) 改价：编辑 ${join(pluginTarget, 'client.js')} 顶部的 DEEPSEEK_PRICES，刷新页面。
  4) 体检：node scripts/install.mjs --check
  5) 禁用：在 ${patchPath} 里给 - id: ${ROW_ID} 加 disabled: true
`)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
