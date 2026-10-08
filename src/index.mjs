/**
 * dsh-tide — 看时机的优雅暂停（峰谷 / 余额）
 *
 * 面向 DeepSeek Harness 的插件：在"时机不对"的时刻，让 agent 优雅地把
 * 项目暂停在一个安全点并留下可继承的交接，而不是硬停或继续烧钱。
 *
 * 两个触发（共用同一套"暂停 → 双交接 → 条件唤醒"骨架）：
 *  Part 1 峰谷切换（谷 → 峰，即"梁文谷"转"梁文锋"）：
 *    问用户一次"要不要优雅暂停当前项目"（原生 ask_user_question，
 *    timeout=15s；超时＝继续——有些项目宁愿多花钱也不能停）。
 *    用户同意 → 模型写双交接（人一份 + 模型一份）→ 暂停。
 *  Part 2 余额低于阈值：
 *    强制优雅降级收尾（不需要用户同意），暂停；
 *    看门狗按配置间隔轮询余额，余额恢复到阈值以上 → 唤醒模型续跑。
 *
 * 机制基础（全部已在本机 DSH 源码验证）：
 *  - 宿主侧唤醒空闲 agent：ctx.sessionController.resolveAgent(sid) →
 *    agent.followup(message)（dsh-schedule 同款用法）。
 *  - 时间驱动：宿主 setInterval tick；峰谷为北京时间工作日 09:00–12:00、
 *    14:00–18:00（可用 peakWindows 覆盖）。
 *  - 余额：官方 GET {baseUrl}/user/balance（Bearer key，走 ctx.credentials）。
 *  - 审计：与 dsh-calm 同源——元数据放进 tide 消息的 source.tide 字段
 *    （user/message.source 是浅校验、原样保留的天然审计槽位；勿用自定义
 *    事件类型，当前版本 session.append 未向插件开放 ignorable 标记）。
 *
 * @module dsh-tide
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-tide'
export const inject = ['tools']

export const Config = Schema.object({
  // Part 1 峰谷
  askEnabled: Schema.boolean().default(true).description('峰谷切换时问询用户是否优雅暂停'),
  peakWindows: Schema.array(Schema.string()).default(['1-5 09:00-12:00', '1-5 14:00-18:00'])
    .description('高峰时段（北京时间）。格式："<天> <HH:MM>-<HH:MM>"，天用 0-6（0=周日），支持 "1-5" 区间或 "*" 全部'),
  leadMinutes: Schema.number().default(0).description('问询提前量（分钟）：0=切换瞬间问，10=提前 10 分钟问（留出收尾时间）'),
  askTimeoutSeconds: Schema.number().default(15).description('问询时效（秒）：模型调用问询时使用的超时；超时未回答＝继续'),
  askValidMinutes: Schema.number().default(10).description('问询有效期（分钟）：超期后才到达的用户消息不再触发暂停流程'),
  guardWhileWrapping: Schema.boolean().default(true).description('收尾期间拦下"开新战线"的工具（子代理/工作流等）'),
  denyPattern: Schema.string().default('job_|create_goal|update_goal|todo_write|send_message|subagent|workflow|ralph')
    .description('收尾模式拦下的工具名正则（按本机工具名清单核对过）'),
  activeWindowMinutes: Schema.number().default(720).description('只对最近活跃过（该分钟数内）的会话发起峰时问询'),

  // Part 2 余额
  balanceEnabled: Schema.boolean().default(true).description('余额低于阈值时强制优雅降级并暂停'),
  lowBalanceCNY: Schema.number().default(5).description('低余额阈值（元）：低于/等于该值触发降级收尾'),
  resumeBalanceCNY: Schema.number().default(20).description('恢复阈值（元）：余额高于该值后看门狗唤醒模型续跑'),
  balancePollSeconds: Schema.number().default(60).description('常规余额轮询间隔（秒）'),
  watchdogSeconds: Schema.number().default(900).description('暂停后的看门狗轮询间隔（秒，默认 15 分钟）'),
  balanceBaseUrl: Schema.string().default('https://api.deepseek.com').description('余额接口 base（测试时可指向本地 mock）'),
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY').description('从 DSH 凭据服务读取密钥的引用名'),

  // 基建
  tickSeconds: Schema.number().default(10).description('宿主 tick 间隔（秒）'),
  storageDir: Schema.string().default('').description('状态与交接文件目录（默认 $DSH_HOME/storages/dsh-tide）'),
  debugSeedSessions: Schema.array(Schema.string()).default([])
    .description('调试/测试用：预置为"已追踪"的会话 ID 列表（重启后手补追踪，或 E2E 用）'),
})

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SOURCE_KIND = 'dsh-tide'
const SUBTYPES = {
  ask: 'ask',           // 峰时问询已注入
  consent: 'consent',   // 用户选择暂停
  decline: 'decline',   // 用户选择继续
  expired: 'expired',   // 问询过期/用户直接忙别的
  wrap: 'wrap',         // 收尾指令已注入
  paused: 'paused',     // 交接已提交、已暂停
  woken: 'woken',       // 看门狗唤醒
  resumed: 'resumed',   // 手动恢复
}
const HUMAN_HANDOFF_NAME = 'TIDE-PAUSED-handoff.md'
const ASK_EDGE_RE = /(暂停|先停|停一下|停一停|停下|停吧|歇了|别跑了|歇口气|pause|halt|stop\s+(it|now))/iu
const DECLINE_RE = /(继续|接着|不用停|不用了|不必|别停|不停|先不用|接着来|接着干|算了继续|continue|keep\s+going|go\s+on|don'?t\s+stop|never\s*mind)/iu
/** 否定式（"不要停/别暂停/先不用暂停"）优先按"继续"理解 */
const NEGATED_PAUSE_RE = /(取消|不用|不必|无需|不|别)[要想着急忙先吧个会能的是否允许暂]{0,3}停/u

// ---------------------------------------------------------------------------
// 峰谷时钟（北京时间；纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 解析峰谷窗口配置。
 * @param {string[]} list 形如 "1-5 09:00-12:00" / "* 00:00-08:00"
 * @returns {{days:number[], startMin:number, endMin:number, raw:string}[]}
 */
export function parsePeakWindows(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw).trim()
    const m = /^(\*|[0-6](?:-[0-6])?)\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(s)
    if (m === null) continue
    let days
    if (m[1] === '*') days = [0, 1, 2, 3, 4, 5, 6]
    else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number)
      days = []
      for (let d = a; ; d = (d + 1) % 7) {
        days.push(d)
        if (d === b) break
        if (days.length > 7) break
      }
    } else days = [Number(m[1])]
    const startMin = Number(m[2]) * 60 + Number(m[3])
    const endMin = Number(m[4]) * 60 + Number(m[5])
    if (endMin <= startMin) continue
    out.push({ days, startMin, endMin, raw: s })
  }
  return out
}

/**
 * 判断某时刻（ms）是否处于高峰。
 * @param {number} nowMs
 * @param {{days:number[], startMin:number, endMin:number}[]} windows
 */
export function isPeakAt(nowMs, windows) {
  const bj = new Date(nowMs + 8 * 3600 * 1000) // UTC+8，用 UTC getter 读
  const day = bj.getUTCDay()
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  for (const w of windows) {
    if (!w.days.includes(day)) continue
    if (minutes >= w.startMin && minutes < w.endMin) return true
  }
  return false
}

/**
 * 用户答复分类。
 * @returns {'consent'|'decline'|'other'}
 */
export function classifyAnswer(text) {
  const t = String(text ?? '').trim()
  if (t === '') return 'other'
  if (NEGATED_PAUSE_RE.test(t)) return 'decline' // "别暂停" 优先于 "暂停"
  if (ASK_EDGE_RE.test(t)) return 'consent'
  if (DECLINE_RE.test(t)) return 'decline'
  return 'other'
}

// ---------------------------------------------------------------------------
// 文本与消息工具
// ---------------------------------------------------------------------------

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim()
}

function isHumanMessage(message) {
  return message?.source?.kind === 'user'
}

function isSubagentSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

/** 移除 undefined 字段：会话日志要求无损 JSON。 */
function cleanMeta(meta) {
  const out = {}
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function tideSource(subtype, meta) {
  return { kind: SOURCE_KIND, subtype, tide: cleanMeta(meta) }
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

function buildPeakNote(config) {
  return [
    '〔tide · 峰时提醒〕高峰计费时段刚刚开始（"梁文峰"，价格约为谷时的 2 倍）。',
    `如需「优雅暂停」当前项目：在 ${config.askTimeoutSeconds} 秒内回复「暂停」，我会先把交接留好再停下（等便宜时段再继续）。`,
    '不回复则照常推进，不会打扰你。',
  ].join('\n')
}

function buildWrapInstruction(reason, extra) {
  const reasonLine = reason === 'balance'
    ? `原因：余额不足（当前 ¥${extra?.balance ?? '?'}，低于阈值 ¥${extra?.threshold ?? '?'}）。`
    : reason === 'peak'
      ? '原因：高峰计费时段已开始（“梁文锋”，价格翻倍），用户同意优雅暂停。'
      : '原因：用户要求优雅暂停。'
  return [
    '〔系统注记 · tide 收尾模式〕现在执行「优雅暂停」收尾：',
    '1. 把当前正在进行的原子步骤做完/做到安全点（不要开新任务、不要发起新的子代理或工作流）。',
    '2. 写两份交接，然后一次性调用 submit_pause_handoff 提交：',
    '   - human：给人看的交接（Markdown）——任务目标 / 干到哪了 / 动过哪些文件 / 怎么接着干；写给"第二天醒来的用户"；没有观察到的字段明确写"未观察到"，不要写 null。',
    '   - model：给模型自己看的交接——精确断点状态、下一步动作、注意事项（恢复时会原样喂给你）。',
    '3. 提交成功后，用一两句话告知用户"已优雅暂停"（说明交接文件位置与恢复方式），然后立即停下；不要继续任何工作。',
    reasonLine,
  ].join('\n')
}

function buildResumeText(reason, files) {
  const why = reason === 'balance' ? '余额不足' : reason === 'peak' ? '峰时暂停' : '手动暂停'
  const where = files?.humanFile !== undefined || files?.modelFile !== undefined
    ? `\n（交接文件：${files?.humanFile ?? '—'} ）`
    : ''
  return `〔tide 注记〕已从优雅暂停恢复（原因：${why}）。按用户最新指令继续推进即可。${where}`
}

function buildWakeText(balance, threshold, modelHandoff, modelFile) {
  const lines = [
    `〔tide 唤醒〕余额已恢复（当前 ¥${balance}，高于恢复阈值 ¥${threshold}），继续之前的任务。`,
  ]
  if (typeof modelHandoff === 'string' && modelHandoff.trim() !== '') {
    lines.push('上次暂停时的模型交接如下（从断点继续）：', '<tide-handoff>', modelHandoff, '</tide-handoff>')
  } else {
    lines.push(`上次暂停时的模型交接在：${modelFile ?? '（未记录）'}——先读它再继续。`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 核心运行时（依赖注入，可在仿测中驱动假时钟/假 fetch）
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.ctx 宿主 ctx
 * @param {object} opts.config 已过 schema 的配置
 * @param {object} [opts.deps] 可注入依赖（仿测用）：
 *   now / fetch / fs / env / homeDir / timers({setInterval,clearInterval})
 */
export function createTide({ ctx, config, deps = {} }) {
  const now = deps.now ?? (() => Date.now())
  const fetchFn = deps.fetch ?? ((...args) => fetch(...args))
  const fsImpl = deps.fs ?? fs
  const env = deps.env ?? process.env
  const homeDir = deps.homeDir ?? os.homedir()
  const timers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  }

  const windows = parsePeakWindows(config.peakWindows)
  const denyRe = new RegExp(config.denyPattern, 'i')

  /** 会话状态：sid -> { phase:'asking'|'wrapping'|'stopping'|'paused', ... } */
  const states = new Map()
  /** 追踪的活跃会话：sid -> { lastSeenAt } */
  const tracked = new Map()

  let lastIsPeak = isPeakAt(now(), windows)
  let lastBalance = { ok: false, at: 0, code: 'INIT' }
  let lastBalancePollAt = 0
  let tickInFlight = false
  let svc = {} // sessionController / sessions / permissionPresets / credentials
  let timerHandle = null

  const storageDir = config.storageDir !== '' && config.storageDir !== undefined
    ? config.storageDir
    : path.join(env.DSH_HOME ?? path.join(homeDir, '.dsh'), 'storages', 'dsh-tide')
  const stateFile = path.join(storageDir, 'state.json')

  // —— 持久化（只持久化 paused；跨重启看门狗靠它） ——

  function loadPersisted() {
    try {
      const raw = fsImpl.readFileSync(stateFile, 'utf8')
      const data = JSON.parse(raw)
      if (data?.paused !== undefined && typeof data.paused === 'object') {
        for (const [sid, entry] of Object.entries(data.paused)) {
          states.set(sid, { ...entry, phase: 'paused' })
        }
      }
    } catch {
      /* 首次运行或损坏：忽略 */
    }
  }

  function savePersisted() {
    try {
      fsImpl.mkdirSync(path.join(storageDir, 'handoffs'), { recursive: true })
      const paused = {}
      for (const [sid, st] of states.entries()) {
        if (st.phase === 'paused') paused[sid] = st
      }
      const tmp = `${stateFile}.tmp`
      fsImpl.writeFileSync(tmp, JSON.stringify({ version: 1, paused }, null, 2))
      fsImpl.renameSync(tmp, stateFile)
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] 状态落盘失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function writeFileSafe(file, content) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true })
      fsImpl.writeFileSync(file, content)
      return true
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] 写文件失败 ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // —— 审计 ——

  function appendTide(session, subtype, text, meta) {
    try {
      // surfaceOp: 'append' 是必须的：定时器等"回合外"上下文里，surface-eligible 事件
      // 会被 surface 契约要求显式声明意图（"requires a surfaceOp marker"，E2E 实测）。
      session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text }], source: tideSource(subtype, meta) }),
        { surfaceOp: 'append' }
      )
      return true
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] 审计写入失败(${subtype}): ${error instanceof Error ? error.message : String(error)}`)
      console.log(`[dsh-tide] 审计写入失败(${subtype}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      return false
    }
  }

  // —— 会话追踪与 agent 解析 ——

  function track(session) {
    if (session?.id === undefined) return
    tracked.set(session.id, { lastSeenAt: now() })
  }

  /**
   * 从会话日志重建 tide 状态（进程重启后接手未完成的问询窗口 / 暂停标记）。
   * 只关注最后一条 tide 标记：ask → 问询窗口进行中；paused → 已暂停（等手动恢复）。
   */
  function reconstructState(session) {
    let last
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind !== SOURCE_KIND) continue
      last = { subtype: source.subtype, tide: source.tide ?? {} }
    }
    if (last === undefined) return undefined
    if (last.subtype === SUBTYPES.ask) return { phase: 'asking', reason: 'peak', askedAt: last.tide.at }
    if (last.subtype === SUBTYPES.paused) {
      return {
        phase: 'paused',
        reason: last.tide.reason,
        since: last.tide.at,
        humanFile: last.tide.humanFile,
        modelFile: last.tide.modelFile,
      }
    }
    return undefined
  }

  async function followupTo(sessionId, message) {
    try {
      const resolved = await svc.sessionController.resolveAgent(sessionId)
      if (resolved === undefined || resolved?.agent === undefined) {
        ctx.logger.warn(`[dsh-tide] resolveAgent(${sessionId}) 失败`)
        return false
      }
      resolved.agent.followup(message)
      if (svc.sessions !== undefined && typeof svc.sessions.flush === 'function') {
        await svc.sessions.flush(resolved.agent.session)
      }
      return true
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] followup(${sessionId}) 失败: ${error instanceof Error ? error.message : String(error)}`)
      console.log(`[dsh-tide] followup(${sessionId}) 失败: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function tideFollowupMessage(subtype, text, meta) {
    return createUserMessage({ content: [{ type: 'text', text }], source: tideSource(subtype, meta) })
  }

  // —— Never Ask 检测 ——

  function isNeverAsk(session) {
    try {
      const preset = svc.permissionPresets?.current?.(session)
      return preset === 'auto' // auto 预设 = approval never（Never Ask 模式）
    } catch {
      return false
    }
  }

  // —— Part 1：峰谷问询 ——

  function clearStaleAsking(at) {
    for (const [sid, st] of states.entries()) {
      if (st.phase === 'asking' && at - (st.askedAt ?? 0) > config.askValidMinutes * 60_000) {
        states.delete(sid)
      }
    }
  }

  async function firePeakAsk() {
    clearStaleAsking(now())
    const at = now()
    const activeSince = at - config.activeWindowMinutes * 60_000
    for (const [sid, info] of tracked.entries()) {
      if (info.lastSeenAt < activeSince) {
        console.log(`[dsh-tide] 跳过 ${sid}：不活跃`)
        continue
      }
      const st = states.get(sid)
      if (st !== undefined) {
        console.log(`[dsh-tide] 跳过 ${sid}：已有状态 ${st.phase}`)
        continue // asking/wrapping/stopping/paused 都不打扰
      }
      const resolved = await svc.sessionController?.resolveAgent?.(sid)
      const session = resolved?.agent?.session
      if (session === undefined) {
        console.log(`[dsh-tide] 跳过 ${sid}：无法解析 agent`)
        continue
      }
      if (isSubagentSession(session)) continue
      if (isNeverAsk(session)) {
        // 设计：Never Ask 模式下不做问询，静默跳过（只打日志，不往会话里写东西）
        console.log(`[dsh-tide] 跳过 ${sid}：Never Ask 模式`)
        continue
      }
      // 非阻塞设计：注入一条用户可见的提醒（不额外开模型回合、不依赖 ask 工具模式）；
      // 窗口内回复"暂停"由 decide() 捕获并进入收尾，超时则自然继续。
      const ok = appendTide(session, SUBTYPES.ask, buildPeakNote(config), { at, edge: 'valley-to-peak' })
      if (ok) {
        states.set(sid, { phase: 'asking', reason: 'peak', askedAt: at })
        console.log(`[dsh-tide] 峰时提醒已注入 session=${sid}（${config.askTimeoutSeconds}s 窗口）`)
      }
    }
  }

  // —— Part 2：余额 ——

  async function readBalance() {
    let key
    try {
      const cred = await svc.credentials?.resolve?.(config.apiKeyRef)
      key = cred?.value
    } catch {
      key = undefined
    }
    if (key === undefined || key === '') key = env[config.apiKeyRef]
    if (key === undefined || key === '') return { ok: false, code: 'NO_KEY' }
    try {
      const res = await fetchFn(`${config.balanceBaseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return { ok: false, code: `HTTP ${res.status}` }
      const data = await res.json()
      const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : undefined
      const value = Number.parseFloat(info?.total_balance ?? '')
      if (!Number.isFinite(value)) return { ok: false, code: 'PARSE' }
      return { ok: true, value, currency: info?.currency ?? 'CNY', available: data?.is_available !== false, at: now() }
    } catch (error) {
      return { ok: false, code: (error instanceof Error ? error.message : String(error)).slice(0, 120) }
    }
  }

  function hasBalancePaused() {
    for (const st of states.values()) {
      if (st.phase === 'paused' && st.reason === 'balance') return true
    }
    return false
  }

  async function triggerBalanceStop(sid, balance) {
    const at = now()
    const ok = await followupTo(
      sid,
      tideFollowupMessage(SUBTYPES.wrap, buildWrapInstruction('balance', { balance, threshold: config.lowBalanceCNY }), {
        at, reason: 'balance', balance, threshold: config.lowBalanceCNY,
      })
    )
    if (ok) {
      states.set(sid, { phase: 'stopping', reason: 'balance', since: at })
      ctx.logger.info(`[dsh-tide] 低余额降级指令已注入 session=${sid} balance=¥${balance}`)
    }
  }

  async function wakeBalancePaused(balance) {
    const at = now()
    for (const [sid, st] of [...states.entries()]) {
      if (st.phase !== 'paused' || st.reason !== 'balance') continue
      const ok = await followupTo(
        sid,
        tideFollowupMessage(
          SUBTYPES.woken,
          buildWakeText(balance, config.resumeBalanceCNY, st.modelHandoff, st.modelFile),
          { at, balance, threshold: config.resumeBalanceCNY, since: st.since }
        )
      )
      if (ok) {
        states.delete(sid)
        savePersisted()
        ctx.logger.info(`[dsh-tide] 看门狗唤醒 session=${sid} balance=¥${balance}`)
      }
    }
  }

  async function pollBalanceOnce() {
    if (config.balanceEnabled !== true) return
    const at = now()
    const intervalMs = (hasBalancePaused() ? config.watchdogSeconds : config.balancePollSeconds) * 1000
    if (at - lastBalancePollAt < intervalMs) return
    lastBalancePollAt = at
    const result = await readBalance()
    lastBalance = { ...result, at }
    if (!result.ok) {
      ctx.logger.warn(`[dsh-tide] 余额查询失败: ${result.code}`)
      return
    }
    if (result.value <= config.lowBalanceCNY) {
      const activeSince = at - config.activeWindowMinutes * 60_000
      for (const [sid, info] of tracked.entries()) {
        if (info.lastSeenAt < activeSince) continue
        const st = states.get(sid)
        if (st !== undefined) continue
        await triggerBalanceStop(sid, result.value)
      }
    }
    if (result.value > config.resumeBalanceCNY) {
      await wakeBalancePaused(result.value)
    }
  }

  // —— tick ——

  async function tick() {
    if (tickInFlight) return
    tickInFlight = true
    try {
      const at = now()
      const cur = isPeakAt(at + config.leadMinutes * 60_000, windows)
      if (!lastIsPeak && cur) {
        console.log(`[dsh-tide] 谷→峰边沿（追踪会话 ${tracked.size} 个）`)
        await firePeakAsk()
      } else if (lastIsPeak && !cur) {
        console.log('[dsh-tide] 峰→谷边沿')
      }
      lastIsPeak = cur
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] peak tick 失败: ${error instanceof Error ? error.message : String(error)}`)
      console.log(`[dsh-tide] peak tick 失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
    try {
      await pollBalanceOnce()
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] balance tick 失败: ${error instanceof Error ? error.message : String(error)}`)
      console.log(`[dsh-tide] balance tick 失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
    tickInFlight = false
  }

  // —— pre-step 决策 ——

  function decide(payload) {
    const agent = payload?.agent
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (agent === undefined) return { kind: 'pass' }
    const session = agent.session
    if (session === undefined || isSubagentSession(session)) return { kind: 'pass' }
    track(session)

    const humans = messages.filter(isHumanMessage)
    let text = humans.map(messageText).join('\n').trim()
    const state = states.get(session.id) ?? reconstructState(session)
    // 问询答复可能不是 kind:'user' —— asking 状态下兜底收编非 tide 消息
    if (text === '' && state?.phase === 'asking') {
      text = messages
        .filter((m) => m?.source?.kind !== SOURCE_KIND)
        .map(messageText)
        .join('\n')
        .trim()
    }
    if (text === '') return { kind: 'pass' }

    // 已暂停 → 手动恢复
    if (state?.phase === 'paused') {
      const files = { humanFile: state.humanFile, modelFile: state.modelFile }
      states.delete(session.id)
      savePersisted()
      appendTide(session, SUBTYPES.resumed, `〔tide〕已从优雅暂停恢复（原因：${state.reason ?? 'manual'}）。`, {
        at: now(), reason: state.reason, since: state.since,
      })
      ctx.logger.info(`[dsh-tide] 手动恢复 session=${session.id}`)
      return {
        kind: 'resume',
        instruction: createUserMessage({
          content: [{ type: 'text', text: buildResumeText(state.reason, files) }],
          source: tideSource(SUBTYPES.resumed, { at: now(), reason: state.reason }),
        }),
      }
    }

    // 问询待答复
    if (state?.phase === 'asking') {
      const expired = now() - (state.askedAt ?? 0) > config.askValidMinutes * 60_000
      if (expired) {
        states.delete(session.id)
        appendTide(session, SUBTYPES.expired, '〔tide〕峰时问询已过期（未作选择，视为继续）。', { at: now(), askedAt: state.askedAt })
        return { kind: 'pass' }
      }
      const label = classifyAnswer(text)
      if (label === 'consent') {
        states.set(session.id, { phase: 'wrapping', reason: 'peak', since: now() })
        appendTide(session, SUBTYPES.consent, '〔tide〕用户选择优雅暂停（峰时问询）。', { at: now() })
        ctx.logger.info(`[dsh-tide] 用户同意暂停 session=${session.id}`)
        return {
          kind: 'wrap',
          instruction: createUserMessage({
            content: [{ type: 'text', text: buildWrapInstruction('peak', {}) }],
            source: tideSource(SUBTYPES.wrap, { at: now(), reason: 'peak', consent: true }),
          }),
        }
      }
      if (label === 'decline') {
        states.delete(session.id)
        appendTide(session, SUBTYPES.decline, '〔tide〕用户选择继续（峰时问询）。', { at: now() })
        return { kind: 'pass' }
      }
      // 其他内容 —— 视为已忙别的
      states.delete(session.id)
      appendTide(session, SUBTYPES.expired, '〔tide〕峰时问询结束（用户转而处理其他内容）。', { at: now(), askedAt: state.askedAt })
      return { kind: 'pass' }
    }

    // 收尾中
    if (state?.phase === 'wrapping' || state?.phase === 'stopping') {
      if (DECLINE_RE.test(text)) {
        states.delete(session.id)
        appendTide(session, SUBTYPES.resumed, '〔tide〕用户取消暂停，继续任务。', { at: now(), cancelled: true })
        return { kind: 'pass' }
      }
      // 用户还在继续说事 —— 重申收尾指令（保持收尾态）
      return {
        kind: 'wrap',
        instruction: createUserMessage({
          content: [{ type: 'text', text: buildWrapInstruction(state.reason, {}) }],
          source: tideSource(SUBTYPES.wrap, { at: now(), reason: state.reason, reiterate: true }),
        }),
      }
    }

    return { kind: 'pass' }
  }

  // —— 工具：提交双交接 ——

  const submitTool = defineTool({
    name: 'submit_pause_handoff',
    description:
      '在收尾模式（tide）中一次性提交两份交接并落盘：human=给人看的交接，model=给模型自己看的交接。提交后本次会话即进入优雅暂停。',
    parameters: {
      human: { type: 'string', required: true, description: '给人看的交接（Markdown）' },
      model: { type: 'string', required: true, description: '给模型自己看的交接（断点状态/下一步/注意事项）' },
      note: { type: 'string', description: '可选：一句话摘要（写入审计）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      const session = exec?.agent?.session
      if (session === undefined) return 'submit_pause_handoff：当前没有活动会话。'
      const st = states.get(session.id)
      const reason = st?.reason ?? 'manual'
      const at = now()
      const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
      const cwd = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined
      const humanFile = cwd !== undefined ? path.join(cwd, HUMAN_HANDOFF_NAME) : path.join(storageDir, 'handoffs', `${session.id}-${stamp}-human.md`)
      const modelFile = path.join(storageDir, 'handoffs', `${session.id}.md`)
      writeFileSafe(humanFile, String(args.human ?? ''))
      writeFileSafe(path.join(storageDir, 'handoffs', `${session.id}-${stamp}-human.md`), String(args.human ?? ''))
      writeFileSafe(modelFile, String(args.model ?? ''))
      const entry = {
        phase: 'paused',
        reason,
        since: at,
        humanFile,
        modelFile,
        modelHandoff: String(args.model ?? '').slice(0, 12000),
        note: args.note,
      }
      states.set(session.id, entry)
      savePersisted()
      appendTide(session, SUBTYPES.paused, `〔tide〕已优雅暂停（原因：${reason === 'balance' ? '余额不足' : reason === 'peak' ? '峰时' : '手动'}）。人交接：${humanFile}；模型交接：${modelFile}。`, {
        at, reason, humanFile, modelFile, note: args.note,
      })
      ctx.logger.info(`[dsh-tide] 已暂停 session=${session.id} reason=${reason}`)
      const resumeHint = reason === 'balance'
        ? '余额恢复到阈值以上后，看门狗会自动唤醒本会话继续。'
        : '用户回来说一句话即可从交接继续（也可以由用户手动恢复）。'
      return `已优雅暂停并落盘。人交接：${humanFile}；模型交接：${modelFile}。${resumeHint} 请用一两句话告知用户后立即停下，不要继续任何工作。`
    },
  })

  // —— 工具闸门：收尾期间不开新战线 ——

  function guard(exec) {
    if (config.guardWhileWrapping !== true) return undefined
    const session = exec?.agent?.session
    if (session === undefined) return undefined
    const st = states.get(session.id)
    if (st === undefined || (st.phase !== 'wrapping' && st.phase !== 'stopping')) return undefined
    if (!denyRe.test(String(exec.name ?? ''))) return undefined
    return `dsh-tide：正在优雅收尾，操作「${exec.name}」已被临时拦下。先完成交接提交（submit_pause_handoff），不要开新任务。`
  }

  // —— 装配 ——

  function start() {
    loadPersisted()
    // 阈值合理性检查：low >= resume 会形成"唤醒后立刻再暂停"的循环（E2E 实测过）
    if (config.balanceEnabled === true && config.lowBalanceCNY >= config.resumeBalanceCNY) {
      const msg = `[dsh-tide] 配置提醒：lowBalanceCNY(¥${config.lowBalanceCNY}) >= resumeBalanceCNY(¥${config.resumeBalanceCNY})，恢复后可能立刻再次触发暂停；建议 low < resume`
      ctx.logger.warn(msg)
      console.warn(msg)
    }
    for (const sid of Array.isArray(config.debugSeedSessions) ? config.debugSeedSessions : []) {
      tracked.set(sid, { lastSeenAt: now() })
    }

    ctx.on('agent/pre-step', async (payload, next) => {
      let action
      try {
        action = decide(payload)
      } catch (error) {
        ctx.logger.warn(`[dsh-tide] 判定失败（放行）: ${error instanceof Error ? error.message : String(error)}`)
        action = { kind: 'pass' }
      }
      const decision = await next()
      if ((action.kind === 'wrap' || action.kind === 'resume') && decision?.kind === 'enter' && Array.isArray(decision.messages)) {
        return { ...decision, messages: [...decision.messages, action.instruction] }
      }
      return decision
    })

    ctx.tools.guard(guard)
    ctx.tools.register(submitTool)

    // 服务依赖：等待全部就绪后再启动定时器
    try {
      ctx.inject(['sessionController', 'sessions', 'permissionPresets', 'credentials'], (scoped) => {
        svc = {
          sessionController: scoped.sessionController,
          sessions: scoped.sessions,
          permissionPresets: scoped.permissionPresets,
          credentials: scoped.credentials,
        }
        timerHandle = timers.setInterval(() => { void tick() }, config.tickSeconds * 1000)
      })
    } catch (error) {
      ctx.logger.warn(`[dsh-tide] 服务注入失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    ctx.effect(() => {
      const banner = `[dsh-tide] 已加载（ask=${config.askEnabled}, lead=${config.leadMinutes}min, balance=${config.balanceEnabled}, low=¥${config.lowBalanceCNY}, watchdog=${config.watchdogSeconds}s）`
      ctx.logger.info(banner)
      console.log(banner)
      return () => {
        if (timerHandle !== null) timers.clearInterval(timerHandle)
        ctx.logger.info('[dsh-tide] 已卸载')
      }
    })
  }

  return {
    start,
    tick,
    pollBalanceOnce,
    decide,
    // 测试与调试入口
    _states: states,
    _tracked: tracked,
    _lastBalance: () => lastBalance,
    _setLastPeak: (v) => { lastIsPeak = v },
    _isNeverAsk: isNeverAsk,
    _storageDir: storageDir,
  }
}

export function apply(ctx, config) {
  const rt = createTide({ ctx, config })
  rt.start()
  return rt
}

export { SOURCE_KIND, SUBTYPES }
