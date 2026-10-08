/**
 * dsh-tide 逻辑仿真测试。
 * 用一个"最小可用的假 ctx / 假时钟 / 假余额 / 假 sessionController"驱动插件逻辑，验证：
 *  峰谷时钟 / 问询注入 / 同意-拒绝-过期 / 收尾闸门 / 双交接落盘 / 余额降级停机 / 看门狗唤醒 / 跨重启
 * 运行：node test/sim.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTide,
  classifyAnswer,
  parsePeakWindows,
  isPeakAt,
  SOURCE_KIND,
} from '../src/index.mjs'

let passed = 0
function ok(name) {
  passed += 1
  console.log(`  ok - ${name}`)
}

// ---------- 时间工具 ----------
/** 北京时间 (y,mo,d,h,mi) → epoch ms */
function bjMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h - 8, mi)
}
const T_THU_0800 = bjMs(2026, 10, 8, 8, 0)

// ---------- 假环境 ----------

function makeCtx(services) {
  const handlers = {}
  const tools = {}
  const guards = []
  const warns = []
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    tools: {
      register: (t) => { tools[t.name] = t },
      guard: (fn) => { guards.push(fn) },
    },
    logger: { info: () => {}, warn: (...a) => { warns.push(a.join(' ')) } },
    effect: (fn) => { fn() },
    inject: (_names, cb) => { cb(ctx) },
    ...services,
  }
  return { ctx, handlers, tools, guards, warns }
}

const SESSION_REGISTRY = new Map()

function makeSession(id, cwd) {
  const events = []
  let seq = 0
  const session = {
    id,
    header: { cwd },
    get surface() { return { nodes: [] } },
    snapshotEvents: () => events,
    append(type, data, _opts) {
      const event = { seq: seq++, type, data }
      events.push(event)
      return event
    },
    _events: events,
    _audits(subtype) {
      return events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === SOURCE_KIND && e.data.source.subtype === subtype)
    },
  }
  SESSION_REGISTRY.set(id, session)
  return session
}

function makeEnv({ preset = 'default', balance = 100, key = 'sk-test' } = {}) {
  const agents = new Map()
  const flushes = []
  const env = {
    preset,
    balance,
    key,
    agents,
    flushes,
    t: T_THU_0800,
    timerFns: [],
  }
  env.now = () => env.t
  env.fetch = async (_url) => ({
    ok: true,
    json: async () => ({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: String(env.balance) }],
    }),
  })
  env.services = {
    sessionController: {
      resolveAgent: async (sid) => {
        let agent = agents.get(sid)
        if (agent === undefined) {
          const s = SESSION_REGISTRY.get(sid)
          if (s === undefined) return { error: new Error(`no agent ${sid}`) }
          agent = agentFor(env, s)
        }
        return { agent }
      },
    },
    sessions: { flush: async (s) => { flushes.push(s?.id); return true } },
    permissionPresets: { current: () => env.preset },
    credentials: { resolve: async () => ({ value: env.key }) },
  }
  return env
}

function agentFor(env, session) {
  if (!env.agents.has(session.id)) {
    const agent = {
      session,
      followups: [],
      followup(msg) { this.followups.push(msg) },
    }
    env.agents.set(session.id, agent)
  }
  return env.agents.get(session.id)
}

function baseConfig(storageDir) {
  return {
    askEnabled: true,
    peakWindows: ['1-5 09:00-12:00', '1-5 14:00-18:00'],
    leadMinutes: 0,
    askTimeoutSeconds: 15,
    askValidMinutes: 10,
    guardWhileWrapping: true,
    denyPattern: 'job_|create_goal|update_goal|todo_write|send_message|subagent|workflow|ralph',
    activeWindowMinutes: 720,
    balanceEnabled: true,
    lowBalanceCNY: 5,
    resumeBalanceCNY: 20,
    balancePollSeconds: 60,
    watchdogSeconds: 900,
    balanceBaseUrl: 'https://api.deepseek.com',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    tickSeconds: 10,
    storageDir,
  }
}

function human(text) {
  return { source: { kind: 'user' }, content: [{ type: 'text', text }] }
}
const next = async () => ({ kind: 'enter', messages: [] })

function mkRuntime(env, overrides = {}) {
  const storageDir = overrides.storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sim-'))
  const cwd = overrides.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tide-cwd-'))
  const config = { ...baseConfig(storageDir), ...overrides.config }
  const { ctx, handlers, tools, guards, warns } = makeCtx(env.services)
  const rt = createTide({
    ctx,
    config,
    deps: {
      now: env.now,
      fetch: env.fetch,
      env: {},
      homeDir: '/nonexistent-home',
      timers: {
        setInterval: (fn, ms) => { env.timerFns.push({ fn, ms }); return { fn, ms } },
        clearInterval: () => {},
      },
    },
  })
  rt.start()
  return { rt, ctx, handlers, tools, guards, warns, config, storageDir, cwd }
}

async function turn(handlers, session, text) {
  return handlers['agent/pre-step'](
    { agent: { session }, messages: [human(text)] },
    next
  )
}

function followupsOf(env, sid) {
  return env.agents.get(sid)?.followups ?? []
}
function lastFollowOf(env, sid) {
  const f = followupsOf(env, sid)
  return f[f.length - 1]
}

console.log('== 1. 峰谷时钟（纯函数） ==')
{
  const ws = parsePeakWindows(['1-5 09:00-12:00', '1-5 14:00-18:00', '* 00:00-00:30', 'bad string', '7 09:00-08:00'])
  assert.equal(ws.length, 3); ok('解析出 3 个合法窗口（非法字符串与倒置区间被跳过）')
  assert.deepEqual(ws[0].days, [1, 2, 3, 4, 5]); ok('1-5 → 周一到周五')
  assert.equal(ws[0].startMin, 540); assert.equal(ws[0].endMin, 720); ok('09:00-12:00 → 540/720 分钟')

  assert.equal(isPeakAt(bjMs(2026, 10, 8, 10, 0), ws), true); ok('周四 10:00 → 峰')
  assert.equal(isPeakAt(bjMs(2026, 10, 8, 13, 0), ws), false); ok('周四 13:00（午间谷）→ 非峰')
  assert.equal(isPeakAt(bjMs(2026, 10, 8, 15, 0), ws), true); ok('周四 15:00 → 峰')
  assert.equal(isPeakAt(bjMs(2026, 10, 8, 18, 0), ws), false); ok('18:00 整点 → 已进入谷（半开区间）')
  assert.equal(isPeakAt(bjMs(2026, 10, 10, 10, 0), ws), false); ok('周六 10:00 → 非峰')
  assert.equal(isPeakAt(bjMs(2026, 10, 8, 0, 10), ws), true); ok('"* 00:00-00:30" 窗口生效（0:10 → 峰）')
}

console.log('== 2. 答复分类 ==')
{
  assert.equal(classifyAnswer('暂停'), 'consent'); ok('"暂停" → consent')
  assert.equal(classifyAnswer('好，先停一下吧'), 'consent'); ok('"先停一下吧" → consent')
  assert.equal(classifyAnswer('Pause'), 'consent'); ok('"Pause" → consent')
  assert.equal(classifyAnswer('继续'), 'decline'); ok('"继续" → decline')
  assert.equal(classifyAnswer('别暂停，继续干'), 'decline'); ok('"别暂停，继续干" → decline（否定式优先）')
  assert.equal(classifyAnswer('不要停'), 'decline'); ok('"不要停" → decline')
  assert.equal(classifyAnswer('先不用暂停'), 'decline'); ok('"先不用暂停" → decline')
  assert.equal(classifyAnswer('随便聊聊别的'), 'other'); ok('无关内容 → other')
}

console.log('== 3. 峰时问询注入（默认配置） ==')
const env3 = makeEnv({ balance: 100 })
const R3 = mkRuntime(env3)
const S1 = makeSession('s1', R3.cwd)
{
  assert.ok(typeof R3.tools['submit_pause_handoff'] === 'object'); ok('submit_pause_handoff 工具已注册')
  assert.equal(R3.guards.length, 1); ok('工具闸门已注册')
  assert.equal(env3.timerFns.length, 1); ok('宿主定时器已注册')
  assert.equal(env3.timerFns[0].ms, 10_000); ok('tick 间隔 = 10s（tickSeconds）')

  await turn(R3.handlers, S1, '开始干活')
  assert.ok(R3.rt._tracked.has('s1')); ok('会话已被追踪')

  env3.t = bjMs(2026, 10, 8, 8, 59)
  await R3.rt.tick()
  assert.equal(followupsOf(env3, 's1').length, 0); ok('8:59（谷）→ 不问')

  env3.t = bjMs(2026, 10, 8, 9, 0)
  await R3.rt.tick()
  const asks1 = S1._audits('ask')
  assert.equal(asks1.length, 1); ok('9:00 谷→峰 → 注入峰时提醒')
  assert.equal(asks1[0].data.source.kind, SOURCE_KIND); ok('提醒 source.kind = dsh-tide')
  assert.ok(String(asks1[0].data.content[0].text).includes('暂停')); ok('提醒告知可回复「暂停」')
  assert.ok(String(asks1[0].data.content[0].text).includes('15')); ok('提醒带 15 秒窗口')
  assert.equal(followupsOf(env3, 's1').length, 0); ok('非阻塞：不开模型回合（无 followup）')
  assert.equal(R3.rt._states.get('s1')?.phase, 'asking'); ok('会话进入 asking 状态')

  env3.t = bjMs(2026, 10, 8, 9, 1)
  await R3.rt.tick()
  assert.equal(S1._audits('ask').length, 1); ok('同一峰段不重复提醒（去重）')
}

console.log('== 4. leadMinutes 提前量 ==')
const env4 = makeEnv({ balance: 100 })
const R4 = mkRuntime(env4, { config: { leadMinutes: 10 } })
const S2 = makeSession('s2', R4.cwd)
{
  env4.t = bjMs(2026, 10, 8, 8, 30)
  await turn(R4.handlers, S2, '干活')
  env4.t = bjMs(2026, 10, 8, 8, 49)
  await R4.rt.tick()
  assert.equal(S2._audits('ask').length, 0); ok('8:49（+10=8:59 非峰）→ 不提醒')
  env4.t = bjMs(2026, 10, 8, 8, 50)
  await R4.rt.tick()
  assert.equal(S2._audits('ask').length, 1); ok('8:50（+10=9:00 峰）→ 提前 10 分钟提醒')
}

console.log('== 5. 同意 → 收尾 → 双交接 → 暂停 ==')
{
  env3.t = bjMs(2026, 10, 8, 9, 2)
  const decision = await turn(R3.handlers, S1, '好，先暂停吧')
  const injected = decision.messages.find((m) => m?.source?.subtype === 'wrap')
  assert.ok(injected !== undefined); ok('同意后本步注入收尾指令')
  assert.ok(injected.content[0].text.includes('submit_pause_handoff')); ok('收尾指令要求调用提交工具')
  assert.equal(R3.rt._states.get('s1')?.phase, 'wrapping'); ok('会话进入 wrapping 状态')
  assert.equal(S1._audits('consent').length, 1); ok('写入 consent 审计')

  const blocked = R3.guards[0]({ agent: { session: S1 }, name: 'job_run' })
  assert.ok(typeof blocked === 'string' && blocked.includes('收尾')); ok('收尾中"开新战线"工具被拦')
  assert.equal(R3.guards[0]({ agent: { session: S1 }, name: 'read' }), undefined); ok('收尾中读类工具放行')

  const out = await R3.tools['submit_pause_handoff'].execute(
    { human: '# H1 交接', model: '# M1 断点' },
    { agent: { session: S1 } }
  )
  assert.ok(String(out).includes('已优雅暂停')); ok('提交工具返回暂停回执')
  assert.equal(fs.readFileSync(path.join(R3.cwd, 'TIDE-PAUSED-handoff.md'), 'utf8'), '# H1 交接'); ok('人类交接写入工作目录')
  assert.equal(fs.readFileSync(path.join(R3.storageDir, 'handoffs', 's1.md'), 'utf8'), '# M1 断点'); ok('模型交接写入 storages')
  assert.equal(R3.rt._states.get('s1')?.phase, 'paused'); ok('会话进入 paused 状态')
  const persisted = JSON.parse(fs.readFileSync(path.join(R3.storageDir, 'state.json'), 'utf8'))
  assert.equal(persisted.paused.s1.reason, 'peak'); ok('暂停状态已落盘（reason=peak）')
  assert.equal(S1._audits('paused').length, 1); ok('写入 paused 审计（含文件路径）')
  assert.equal(R3.guards[0]({ agent: { session: S1 }, name: 'job_run' }), undefined); ok('paused 状态不再拦工具（等用户恢复）')
}

console.log('== 6. 手动恢复 ==')
{
  env3.t = bjMs(2026, 10, 8, 9, 5)
  const decision = await turn(R3.handlers, S1, '继续吧')
  const injected = decision.messages.find((m) => m?.source?.subtype === 'resumed')
  assert.ok(injected !== undefined); ok('恢复时注入恢复注记')
  assert.ok(injected.content[0].text.includes('恢复')); ok('注记说明恢复原因')
  assert.equal(R3.rt._states.has('s1'), false); ok('状态已清除')
  assert.equal(S1._audits('resumed').length, 1); ok('写入 resumed 审计')
}

console.log('== 7. 问询过期 ==')
const env7 = makeEnv({ balance: 100 })
const R7 = mkRuntime(env7)
const S3 = makeSession('s3', R7.cwd)
{
  env7.t = bjMs(2026, 10, 8, 9, 0)
  await turn(R7.handlers, S3, '干活')
  await R7.rt.tick()
  assert.equal(R7.rt._states.get('s3')?.phase, 'asking'); ok('问询已发出')
  env7.t = bjMs(2026, 10, 8, 9, 11) // 超过 askValidMinutes=10
  const decision = await turn(R7.handlers, S3, '哦')
  assert.equal(decision.messages.filter((m) => m?.source?.subtype === 'wrap').length, 0); ok('过期后不进入收尾')
  assert.equal(R7.rt._states.has('s3'), false); ok('过期状态清除')
  assert.equal(S3._audits('expired').length, 1); ok('写入 expired 审计')
}

console.log('== 8. 拒绝路径 ==')
const env8 = makeEnv({ balance: 100 })
const R8 = mkRuntime(env8)
const S4 = makeSession('s4', R8.cwd)
{
  env8.t = bjMs(2026, 10, 8, 9, 0)
  await turn(R8.handlers, S4, '干活')
  await R8.rt.tick()
  const decision = await turn(R8.handlers, S4, '继续，别停')
  assert.equal(decision.messages.length, 0); ok('拒绝时不注入任何指令')
  assert.equal(R8.rt._states.has('s4'), false); ok('状态清除')
  assert.equal(S4._audits('decline').length, 1); ok('写入 decline 审计')
}

console.log('== 9. 余额降级停机 + 看门狗唤醒 ==')
const env9 = makeEnv({ balance: 3 })
const R9 = mkRuntime(env9)
const S5 = makeSession('s5', R9.cwd)
{
  env9.t = bjMs(2026, 10, 8, 13, 0) // 谷时（无峰谷干扰）
  await turn(R9.handlers, S5, '干活')
  await R9.rt.tick()
  const f = lastFollowOf(env9, 's5')
  assert.equal(f?.source?.subtype, 'wrap'); ok('低余额 → 注入降级收尾指令')
  assert.equal(f?.source?.tide?.reason, 'balance'); ok('收尾原因 = balance')
  assert.ok(f.content[0].text.includes('余额不足')); ok('指令说明余额原因')
  assert.equal(R9.rt._states.get('s5')?.phase, 'stopping'); ok('进入 stopping 状态')

  await R9.rt.tick()
  assert.equal(followupsOf(env9, 's5').length, 1); ok('低余额不重复注入（等交接）')

  const out = await R9.tools['submit_pause_handoff'].execute(
    { human: '# H5', model: '# M5 断点内容' },
    { agent: { session: S5 } }
  )
  assert.ok(String(out).includes('看门狗')); ok('余额暂停回执提到看门狗唤醒')
  assert.equal(R9.rt._states.get('s5')?.phase, 'paused'); ok('已暂停（reason=balance）')

  env9.balance = 10 // 介于 low(5) 与 resume(20) 之间
  env9.t += 901_000
  await R9.rt.tick()
  assert.equal(followupsOf(env9, 's5').length, 1); ok('余额未达恢复阈值 → 不唤醒')

  env9.balance = 30
  env9.t += 901_000
  await R9.rt.tick()
  const w = lastFollowOf(env9, 's5')
  assert.equal(w?.source?.subtype, 'woken'); ok('余额恢复 → 看门狗唤醒')
  assert.ok(w.content[0].text.includes('# M5 断点内容')); ok('唤醒消息携带模型交接原文')
  assert.equal(R9.rt._states.has('s5'), false); ok('唤醒后状态清除')
  const p = JSON.parse(fs.readFileSync(path.join(R9.storageDir, 'state.json'), 'utf8'))
  assert.equal(Object.keys(p.paused).length, 0); ok('落盘状态同步清空')
}

console.log('== 10. Never Ask 模式跳过问询 ==')
const env10 = makeEnv({ balance: 100, preset: 'auto' })
const R10 = mkRuntime(env10)
const S6 = makeSession('s6', R10.cwd)
{
  env10.t = bjMs(2026, 10, 8, 9, 0)
  await turn(R10.handlers, S6, '干活')
  await R10.rt.tick()
  assert.equal(S6._audits('ask').length, 0); ok('Never Ask（auto 预设）→ 不注入提醒')
  assert.equal(R10.rt._states.size, 0); ok('不产生任何状态')
}

console.log('== 11. 收尾中取消 ==')
const env11 = makeEnv({ balance: 100 })
const R11 = mkRuntime(env11)
const S7 = makeSession('s7', R11.cwd)
{
  env11.t = bjMs(2026, 10, 8, 9, 0)
  await turn(R11.handlers, S7, '干活')
  await R11.rt.tick()
  await turn(R11.handlers, S7, '暂停')
  assert.equal(R11.rt._states.get('s7')?.phase, 'wrapping'); ok('进入收尾态')
  const decision = await turn(R11.handlers, S7, '算了别暂停了，继续')
  assert.equal(R11.rt._states.has('s7'), false); ok('取消收尾 → 状态清除')
  assert.equal(decision.messages.filter((m) => m?.source?.subtype === 'wrap').length, 0); ok('取消后不注入收尾')
  assert.equal(S7._audits('resumed').length, 1); ok('写入取消审计（resumed.cancelled）')
}

console.log('== 12. 跨重启：暂停状态从磁盘重建、看门狗继续工作 ==')
const env12 = makeEnv({ balance: 1 })
const STORAGE12 = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sim12-'))
{
  const RA = mkRuntime(env12, { storageDir: STORAGE12 })
  const S8 = makeSession('s8', RA.cwd)
  env12.t = bjMs(2026, 10, 8, 13, 0)
  await turn(RA.handlers, S8, '干活')
  await RA.rt.tick()
  await RA.tools['submit_pause_handoff'].execute({ human: '# H8', model: '# M8' }, { agent: { session: S8 } })
  assert.equal(RA.rt._states.get('s8')?.phase, 'paused'); ok('运行实例 A：已暂停')

  // 模拟进程重启：同 storageDir 新建实例 B（agent 可从磁盘解析——这里直接复用 registry）
  const RB = mkRuntime(env12, { storageDir: STORAGE12, cwd: RA.cwd })
  assert.equal(RB.rt._states.get('s8')?.phase, 'paused'); ok('实例 B：暂停状态已从磁盘重建')
  env12.balance = 50
  env12.t += 60_000
  await RB.rt.tick()
  const w = lastFollowOf(env12, 's8')
  assert.equal(w?.source?.subtype, 'woken'); ok('实例 B：看门狗唤醒成功')
  assert.ok(w.content[0].text.includes('# M8')); ok('唤醒携带重建后的模型交接')
}

console.log('== 13. 收尾闸门可配置关闭 ==')
{
  const env13 = makeEnv({ balance: 100 })
  const R13 = mkRuntime(env13, { config: { guardWhileWrapping: false } })
  const S9 = makeSession('s9', R13.cwd)
  R13.rt._states.set('s9', { phase: 'wrapping', reason: 'peak' })
  assert.equal(R13.guards[0]({ agent: { session: S9 }, name: 'job_run' }), undefined); ok('guardWhileWrapping=false → 不拦')
}

console.log('== 14. 子代理会话与无人类消息直接放行 ==')
{
  const env14 = makeEnv({ balance: 100 })
  const R14 = mkRuntime(env14)
  const SUB = makeSession('sub1', R14.cwd)
  SUB.header = { cwd: R14.cwd, origin: 'subagent' }
  await turn(R14.handlers, SUB, '干活')
  assert.equal(R14.rt._tracked.has('sub1'), false); ok('子代理会话不被追踪')
  const decision = await R14.handlers['agent/pre-step']({ agent: { session: SUB }, messages: [] }, next)
  assert.equal(decision.kind, 'enter'); ok('无人类消息 → 正常放行')
}

console.log('== 15. debugSeedSessions 预置追踪（E2E 支撑） ==')
{
  const env15 = makeEnv({ balance: 100 })
  const cwd15 = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-cwd-'))
  const SEED = makeSession('seed1', cwd15)
  const R15 = mkRuntime(env15, { config: { debugSeedSessions: ['seed1'] } })
  assert.ok(R15.rt._tracked.has('seed1')); ok('预置会话已进入追踪表')
  env15.t = bjMs(2026, 10, 8, 9, 0)
  await R15.rt.tick()
  assert.equal(SEED._audits('ask').length, 1); ok('预置会话无需先跑一轮也能收到峰时提醒')
}

console.log('== 17. 跨进程重建：新实例凭日志接手问询窗口 ==')
{
  const env17 = makeEnv({ balance: 100 })
  const S17 = makeSession('s17', fs.mkdtempSync(path.join(os.tmpdir(), 'tide-cwd-')))
  const A = mkRuntime(env17)
  env17.t = bjMs(2026, 10, 8, 9, 0)
  await turn(A.handlers, S17, '干活')
  await A.rt.tick()
  assert.equal(S17._audits('ask').length, 1); ok('实例 A：已注入峰时提醒（asking）')
  // 模拟"另一个进程里用户回复"：全新实例 B 的内存没有 asking 状态
  const B = mkRuntime(env17)
  assert.equal(B.rt._states.has('s17'), false); ok('实例 B：内存中没有该会话状态')
  const decision = await turn(B.handlers, S17, '暂停')
  const injected = decision.messages.find((m) => m?.source?.subtype === 'wrap')
  assert.ok(injected !== undefined); ok('实例 B：凭日志重建 asking → 同意进入收尾')
  assert.equal(B.rt._states.get('s17')?.phase, 'wrapping'); ok('实例 B：状态推进为 wrapping')
}

console.log('== 16. 阈值配置提醒（low >= resume 循环风险） ==')
{
  const env16 = makeEnv({ balance: 100 })
  const R16 = mkRuntime(env16, { config: { lowBalanceCNY: 999, resumeBalanceCNY: 50 } })
  assert.ok(R16.warns.some((w) => w.includes('lowBalanceCNY') && w.includes('resumeBalanceCNY'))); ok('low>=resume 时启动告警（E2E 实测的循环风险）')
  const R16b = mkRuntime(env16, { config: { lowBalanceCNY: 5, resumeBalanceCNY: 20 } })
  assert.equal(R16b.warns.length, 0); ok('low<resume 无告警')
}

console.log(`\n全部通过：${passed} 项断言`)
process.exit(0)
