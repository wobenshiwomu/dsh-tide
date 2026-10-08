# dsh-tide

> DeepSeek Harness 插件：**看时机的优雅暂停（Graceful Pause on Timing）**。
> 退潮时暂停，涨潮时回来 —— 在"时机不对"的时刻，让 agent 优雅地把项目停在安全点、
> 留下可继承的交接，而不是硬停或继续烧钱。

## 两条链路（同一套骨架：暂停 → 双交接 → 条件唤醒）

**Part 1 · 峰时提醒（温和事件：给你选择权）**
- 谷→峰切换（"梁文谷"转"梁文峰"）时，向**最近活跃的会话**注入一条用户可见提醒：
  "在 15 秒内回复「暂停」可优雅收尾（先留交接，等便宜时段再继续）；不回复则照常推进。"
- 回复「暂停」→ 进入收尾：模型写两份交接（**人一份 + 模型一份**）→ 调用
  `submit_pause_handoff` 落盘 → 会话进入「已暂停」。
- **超时默认继续**：有些项目"宁愿多花钱、不能停"——15 秒是"抓在场的人"的窗口，
  不是等你做决定的窗口。设计上这是"同意机制"，不是"省钱强制"。
- Never Ask 模式下静默跳过（不打扰）。

**Part 2 · 余额降级（危险事件：强制处理）**
- 余额 ≤ `lowBalanceCNY` → 向活跃会话注入降级收尾指令（**不需要用户同意**），
  模型写双交接后停下。
- **看门狗**：暂停后按 `watchdogSeconds`（默认 15 分钟）轮询余额；恢复到
  `resumeBalanceCNY` 以上 → **自动唤醒模型**继续任务（模型交接原文随唤醒消息注入）。
- 未达恢复线则保持暂停，不重复打扰。

## 工作机制（全部使用公开 API，已在本机 DSH 源码逐项验证）

| 环节 | 机制 |
|---|---|
| 时间驱动 | 宿主 `setInterval` tick（默认 10s）；峰谷为北京时间周一至五 09:00–12:00、14:00–18:00（`peakWindows` 可覆盖，支持 `leadMinutes` 提前量） |
| 注入提醒/审计 | `session.append('user/message', msg, { surfaceOp: 'append' })` —— `surfaceOp` 在**回合外上下文是必须的**（surface 契约），审计元数据在 `source.tide` 字段 |
| 唤醒模型 | `ctx.sessionController.resolveAgent(sid)` → `agent.followup(message)` → `ctx.sessions.flush()`（与 dsh-schedule 同款用法） |
| 收尾产物 | `submit_pause_handoff` 工具：human 交接写工作目录 `TIDE-PAUSED-handoff.md`（+归档），model 交接写 `$DSH_HOME/storages/dsh-tide/handoffs/<会话>.md` 并随唤醒注入 |
| 余额 | 官方 `GET {baseUrl}/user/balance`（Bearer，key 走 `ctx.credentials` → 环境变量兜底），免费不耗额度 |
| 状态 | 内存状态机 + 落盘 `state.json`（暂停项跨重启）；问询窗口/暂停标记可从**会话日志重建**（跨进程可用） |

## 安装

**GitHub 直装（推荐，国内网络可直连，无需 npm 账号）**：

```sh
dsh plugin --profile web add 'https://codeload.github.com/wobenshiwomu/dsh-tide/tar.gz/v0.1.0'
```

或在图形界面：侧栏「插件」→ 添加插件 → 填上面这条 URL。装完重启 DSH 生效。
URL 末段的 `v0.1.0` 是版本标签；升级时换成本仓库的新版本标签重装即可。

**本地/开发安装**（本机路径）：

```sh
dsh plugin --profile web add /path/to/dsh-tide
```

**配置**（profile 用户层 `cordis.patch.yml`，覆盖构建默认）：

```yaml
- id: dsh-tide
  config:
    lowBalanceCNY: 1        # 低余额触发线（元）
    resumeBalanceCNY: 3     # 余额恢复线（元，须大于触发线）
    # peakWindows: ['1-5 09:00-12:00', '1-5 14:00-18:00']
    # leadMinutes: 0        # 峰时提醒提前量（分钟）
    # askTimeoutSeconds: 15 # 提醒时效
    # watchdogSeconds: 900  # 看门狗轮询间隔
```

> ⚠️ 触发线必须小于恢复线（`low < resume`）；相等或倒置会形成"唤醒后立刻再暂停"循环，
> 启动时会打印配置提醒。

## 配置项（全量）

| 键 | 默认 | 说明 |
|---|---|---|
| `askEnabled` | `true` | 峰时提醒总开关 |
| `peakWindows` | 周一至五 09:00–12:00 / 14:00–18:00 | 峰段（北京时间），格式 `"<0-6/*> <HH:MM>-<HH:MM>"` |
| `leadMinutes` | `0` | 峰时提醒提前量 |
| `askTimeoutSeconds` | `15` | 提醒中承诺的回复窗口 |
| `askValidMinutes` | `10` | 窗口后仍有效的答复时限（超过视为继续） |
| `guardWhileWrapping` | `true` | 收尾期间拦下"开新战线"工具（`denyPattern`） |
| `denyPattern` | `job_\|create_goal\|update_goal\|todo_write\|send_message\|subagent\|workflow\|ralph` | 收尾期拦截正则 |
| `activeWindowMinutes` | `720` | 只提醒最近活跃过的会话 |
| `balanceEnabled` | `true` | 余额降级总开关 |
| `lowBalanceCNY` | `5` | 低余额触发线（≤ 即触发） |
| `resumeBalanceCNY` | `20` | 恢复线（> 即唤醒） |
| `balancePollSeconds` | `60` | 常规余额轮询间隔 |
| `watchdogSeconds` | `900` | 暂停后的看门狗间隔 |
| `balanceBaseUrl` | `https://api.deepseek.com` | 余额接口 base |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 凭据服务引用名 |
| `tickSeconds` | `10` | 宿主 tick 间隔 |
| `storageDir` | `$DSH_HOME/storages/dsh-tide` | 状态与模型交接目录 |
| `debugSeedSessions` | `[]` | 调试：预置为"已追踪"的会话 ID |

## 审计（都在会话日志里，`source.tide` 字段）

`subtype`: `ask`（峰时提醒）· `consent`（用户同意）· `decline`（继续）· `expired`（过期）·
`wrap`（收尾指令）· `paused`（已暂停，含双交接路径）· `woken`（看门狗唤醒）· `resumed`（手动恢复）。

## 已知边界

- **节假日不建模**：官方峰段不含法定节假日；本插件按"周一至五"计算（节假日白天会按峰处理，
  偏差方向保守——最多多提醒一次）。
- **`resolveAgent` 会接管会话**：提醒送到哪个会话，该会话的写句柄就属于当前实例；
  多实例（web + headless 同时）共用同一会话时会出现锁冲突——单实例使用无影响。
- **不采用原生 `ask_user_question`**：其 timed 模式非宿主默认，且设置项所在的嵌套行
  无法被用户层 patch 覆盖（实测）；本插件的非阻塞提醒方案不依赖任何 ask 模式，
  headless 环境行为一致。
- 收尾质量取决于模型；`submit_pause_handoff` 是兜底（未调用则不会标记"已暂停"）。
- 与 `dsh-calm` 架构同源（pre-step 注入 + 工具闸门），可共存。

## 测试

```sh
npm install   # 首次：安装测试所需的宿主依赖
npm test      # 仿真测试：89 项断言（时钟/窗口/同意/双交接/看门狗/跨重启/跨进程）
```

`e2e/` 目录留有真实环境 E2E 用过的配置样例（含 mock 余额服务器脚本）供参考。
