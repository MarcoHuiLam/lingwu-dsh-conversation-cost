/**
 * lingwu-dsh-conversation-cost · host 半
 *
 * 全部功能都在浏览器半（client.js）：每轮助手回复下方一行
 * 「≈ ¥x.xxx · 12.3k tok · 缓存命中 92.1%」，以及会话头部的「余额 ¥x.xx」胶囊。
 *
 * host 半不注册工具、不占端口、不读文件；它存在的唯一理由是：
 * DSH 只为「活跃的 Loader 行」投放 `dsh.client` 运行时 bundle，
 * 所以本包必须有一个可被 Loader 装载的 host 入口。
 *
 * 署名：凌雾工坊 - MarcoHuiLam ｜ 协议：MIT
 */

export const name = 'lingwu-dsh-conversation-cost'

/** 不依赖任何 host service。 */
export const inject = []

/** 无需初始化；client.js 在页面侧自行注册槽位条目。 */
export function apply() {}

export default { name, inject, apply }
