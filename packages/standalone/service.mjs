import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { outletLabel, readOutletSelection, startEgressRelay } from '../../src/egress.js'
import { createManagement } from './management.mjs'
import { createStandaloneEac } from './eac.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 数据目录的进程级互斥端点：Windows 命名管道 / Linux 抽象 Unix Socket。
 *  端点由内核持有，持锁进程退出（无论多粗暴）都会自动释放；锁文件里的 PID
 *  则会被操作系统回收复用，不能单独作为持锁证据。 */
function processGuardAddress(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  return process.platform === 'win32' ? `\\\\.\\pipe\\ofm-service-lock-${id}` : `\0ofm-service-lock-${id}`
}

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir, address = processGuardAddress(dataDir)) {
  if (!address) return null
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  // 先拿内核互斥端点：它被占用说明真有活服务，直接抛 EEXIST；
  // 能拿到说明没有活的持锁者，下面锁文件里的 PID 只是历史信息。
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // PID 会被操作系统回收复用：旧服务早已死亡，PID 却可能已被无关进程占用，
      // ESRCH 判定随之失效，锁就永远废旧在这里（用户只能手删文件）。
      // 互斥端点由内核持有、进程退出即释放：能走到这里说明端点空着且已被本
      // 进程持有，等于没有活的持锁者，这份锁文件是上次异常退出留下的。
      // 没有互斥端点的平台退回原来的 PID 判断，保持保守。
      let exited = Boolean(releaseGuard)
      if (!exited) {
        try { process.kill(owner.pid, 0) }
        catch (probeError) { exited = probeError.code === 'ESRCH' }
      }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe, lanEnabled, lanPort,
  startRelay = startLanRelay,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  if (lanEnabled !== undefined && typeof lanEnabled !== 'boolean') throw new TypeError('lanEnabled must be a boolean')
  if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)) {
    throw new TypeError('lanPort must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireServiceLock(dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let eac
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  let relay
  let relayTarget
  let relayRequestedPort
  let relayError = null
  let relayChanges = Promise.resolve()
  // ── egress outlet ──────────────────────────────────────────────────────────
  // The optional proxy outlet (subscription via a managed mihomo, or a single
  // client proxy), off by default. Mirrors the plugin's `syncEgress` in
  // index.js: the relay handle is the only owner of the spawned child, and a
  // settings write reconciles against the last started fingerprint.
  let outletRelay = null
  let outletError = ''
  let outletFingerprint = ''
  let outletChanges = Promise.resolve()
  let outletRestartAttempts = 0
  let outletRestartTimer = null
  let outletUpSince = 0
  const OUTLET_STABLE_MS = 120_000
  const lanState = () => {
    const value = stores.settings.get()
    const addresses = rankLanAddresses(os.networkInterfaces())
    return {
      enabled: value.standaloneLanEnabled === true,
      running: relay !== undefined,
      host: relay?.host ?? '0.0.0.0',
      requestedPort: value.standaloneLanPort ?? 0,
      port: relay?.port ?? null,
      addresses,
      baseUrls: relay ? addresses.map(address => `http://${address}:${relay.port}/v1`) : [],
      error: relayError,
    }
  }
  async function closeRelay() {
    const current = relay
    const target = relayTarget
    relay = undefined
    relayTarget = undefined
    relayRequestedPort = undefined
    await Promise.all([current?.close(), target?.close()])
  }
  async function closeOutlet() {
    await outletChanges
    const current = outletRelay
    outletRelay = null
    outletFingerprint = ''
    await current?.close().catch(() => {})
  }
  function reconcileRelay() {
    relayChanges = relayChanges.then(async () => {
      const value = stores.settings.get()
      const wantedPort = value.standaloneLanPort ?? 0
      relayError = null
      if (stopped || value.enabled === false || value.standaloneLanEnabled !== true) {
        await closeRelay()
        return
      }
      if (relay && relayRequestedPort === wantedPort) return
      await closeRelay()
      try {
        if (typeof value.standaloneLanKey !== 'string' || value.standaloneLanKey === '' ||
            value.standaloneLanKey === value.forwardKey) {
          settingsPersist({ standaloneLanKey: generateKey() })
        }
        // The shared relay targets IPv4 loopback. An IPv6 management bind needs
        // a separate inference-only loopback target, with no management handler.
        if (listener.server.address().address !== '127.0.0.1') {
          relayTarget = await startForwardServer({
            config: () => ({
              host: '127.0.0.1', port: 0,
              enabled: !stopped && stores.settings.get().enabled !== false,
              key: stores.settings.get().forwardKey,
            }),
            complete: runtime.complete, modelRows: runtime.publicModelRows,
          })
        }
        const targetPort = relayTarget?.port ?? listener.port
        const started = await startRelay({
          config: () => ({
            enabled: !stopped && stores.settings.get().enabled !== false && stores.settings.get().standaloneLanEnabled === true,
            host: '0.0.0.0', port: wantedPort, targetPort,
            lanKey: stores.settings.get().standaloneLanKey,
            localKey: stores.settings.get().forwardKey,
          }),
          log: message => logger.warn?.(`our-free-model standalone LAN: ${message}`),
        })
        relay = started
        relayRequestedPort = wantedPort
        if (stopped || stores.settings.get().enabled === false || stores.settings.get().standaloneLanEnabled !== true) await closeRelay()
      } catch (error) {
        await closeRelay()
        relayError = `LAN relay could not start (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'START_FAILED'})`
        logger.warn?.(relayError)
      }
    })
    return relayChanges
  }
  function settingsPersist(patch) {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist the standalone LAN settings')
    }
  }
  // ── egress outlet reconciliation ───────────────────────────────────────────
  // Same serialisation gate as the LAN relay: the boot chain and every settings
  // write call this, and overlapping runs would leak a spawned mihomo (the
  // loser overwrites `outletRelay` while the winner's child still runs).
  function reconcileOutlet() {
    outletChanges = outletChanges.then(async () => {
      if (stopped) return
      const desired = stores.settings.get().egress ?? {}
      const wanted = desired.enabled === true
      const mode = desired.mode === 'client' ? 'client' : 'subscription'
      const url = String(desired.url ?? '').trim()
      const mihomoPath = String(desired.mihomoPath ?? '').trim()
      const fingerprint = `${mode}\n${url}\n${mihomoPath}`
      if (outletRelay !== null && wanted && outletFingerprint === fingerprint && !outletRelay.dead) return
      // 关出口时即使中继从没起来过，也要清掉上一次的启动失败读数，
      // 否则面板会留着一条与当前「已关闭」状态无关的错误。
      if (outletRelay === null && !wanted) { outletError = ''; return }
      if (outletRelay !== null) {
        const closing = outletRelay
        outletRelay = null
        outletFingerprint = ''
        await closing.close().catch(() => {})
        // The way out changed under every fetch: re-detect the exit so the
        // summary and the region verdicts describe the next request's path.
        void settleOutletWatch()
      }
      if (!wanted) {
        outletError = ''
        return
      }
      if (url === '') {
        outletError = 'the outlet needs a subscription or proxy URL'
        logger.warn?.(`our-free-model standalone: egress outlet not started (${outletError})`)
        return
      }
      try {
        outletRelay = await startEgressRelay({
          config: () => {
            const current = stores.settings.get().egress ?? {}
            return {
              mode: current.mode === 'client' ? 'client' : 'subscription',
              url: String(current.url ?? '').trim(),
              mihomoPath: String(current.mihomoPath ?? '').trim(),
            }
          },
          dataDir,
          log: message => logger.info?.(`our-free-model egress: ${message}`),
          onDead: scheduleOutletRestart,
        })
        outletFingerprint = fingerprint
        outletError = ''
        outletUpSince = Date.now()
        logger.info?.(`our-free-model standalone: egress outlet up (${outletLabel(url)} via ${mode})`)
        void settleOutletWatch()
      } catch (error) {
        outletError = String(error?.message ?? error)
        logger.warn?.(`our-free-model standalone: egress outlet could not start (${outletError})`)
      }
    })
    return outletChanges
  }
  // A managed mihomo that dies mid-run used to leave the outlet bricked until
  // the settings page was touched: the relay stays up but its dial port is gone,
  // so every upstream turn fails. A run that lasted two minutes counts as
  // healthy and resets the ladder; otherwise a bounded backoff restarts it.
  function scheduleOutletRestart() {
    if (stopped || outletRestartTimer !== null) return
    if (outletRelay === null) return
    const uptime = Date.now() - outletUpSince
    outletRestartAttempts = uptime >= OUTLET_STABLE_MS ? 0 : outletRestartAttempts + 1
    if (outletRestartAttempts > 6) {
      logger.warn?.('our-free-model standalone: egress outlet restart gave up; toggle it off and on')
      return
    }
    const delay = Math.min(30_000, 500 * 2 ** (outletRestartAttempts - 1))
    outletRestartTimer = setTimeout(() => {
      outletRestartTimer = null
      if (!stopped) void reconcileOutlet().catch(() => {})
    }, delay)
    outletRestartTimer.unref?.()
  }
  /** What the settings page reads for the outlet's live node and latency. */
  const outletStatus = async () => {
    const relay = outletRelay
    const settings = stores.settings.get().egress ?? {}
    const url = String(settings.url ?? '').trim()
    // 启动失败（如找不到 mihomo）时中继是 null，但错误必须送到面板，
    // 否则用户只看到「未启用」，不知道该去哪里修。
    if (relay === null) {
      return {
        running: false, active: false,
        mode: settings.mode === 'client' ? 'client' : 'subscription',
        outlet: url === '' ? '' : outletLabel(url),
        hasUrl: url !== '',
        urlLabel: url === '' ? '' : outletLabel(url),
        mihomoPath: String(settings.mihomoPath ?? '').trim(),
        node: '', nodeDelayMs: 0, nodeAt: 0,
        error: outletError,
      }
    }
    const base = {
      running: true,
      active: true,
      mode: relay.mode ?? '',
      outlet: outletLabel(relay.url ?? ''),
      hasUrl: url !== '',
      urlLabel: url === '' ? '' : outletLabel(url),
      mihomoPath: String(settings.mihomoPath ?? '').trim(),
      error: outletError !== '' ? outletError : (relay.dead ?? ''),
    }
    try {
      const selection = await readOutletSelection(relay)
      return { ...base, node: selection?.node ?? '', nodeDelayMs: selection?.delayMs ?? 0, nodeAt: Date.now() }
    } catch (error) {
      return { ...base, node: '', nodeDelayMs: 0, nodeAt: 0, error: String(error?.message ?? error) }
    }
  }
  // Re-detect the egress IP after the outlet changes: `egress` on the runtime is
  // the last probe's reading, and a new outlet means a new exit. The probe runs
  // through `egressFetch`, so it only carries the new outlet once the relay is
  // up. The watch gives a cold outlet a few rounds to answer before the verdicts
  // are regrouped, so a freshly started mihomo cannot misjudge models.
  const settleOutletWatch = async () => {
    let lastError
    for (let attempt = 0; attempt < 4; attempt++) {
      if (stopped) return
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2_500 : 5_000))
      if (stopped || outletRelay === null) return
      try {
        if (await runtime.watchEgress()) {
          // The exit answers, but url-test may not have ranked a node yet: read
          // the selection now, and once more a beat later so the settings page
          // does not sit on an empty node until the next periodic tick.
          await outletStatus().catch(() => {})
          const later = setTimeout(() => { void outletStatus().catch(() => {}) }, 5_000)
          later.unref?.()
          return
        }
      } catch (error) {
        lastError = error
      }
    }
    logger.warn?.(
      `our-free-model standalone: egress changed but the new exit never answered; leaving verdicts alone`
      + (lastError ? ` (${lastError?.message ?? lastError})` : ''),
    )
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    const savedLanPort = settings.get().standaloneLanPort
    settings.update({
      forwardKey: key,
      standaloneLanEnabled: lanEnabled ?? settings.get().standaloneLanEnabled === true,
      standaloneLanPort: lanPort ?? (Number.isInteger(savedLanPort) && savedLanPort >= 0 && savedLanPort <= 65535 ? savedLanPort : 0),
      ...probe === undefined ? {} : { standaloneProbe: probe === true },
    })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    eac = createStandaloneEac({
      dataDir,
      ...process.env.OFM_TEST_UPSTREAM ? { openExternal: async () => false } : {},
      onSaved: () => { void runtime?.refreshSealedLane().catch(error => logger.warn?.(`EAC 清单刷新失败：${error.message}`)) },
    })
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
      sealedCredential: eac.credential,
    })
    channels = await createChannelRuntime({ dataDir, logger, stats: stores.stats })
    const core = runtime
    runtime = {
      ...core,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      get catalog() { return [...core.catalog, ...channels.publicModelRows().map(row => ({ ...row, contextWindow: row.context_window, maxOutput: row.max_tokens }))] },
      state: () => ({ ...core.state(), catalog: [...core.catalog, ...channels.publicModelRows()] }),
      publicModelRows: () => [...core.publicModelRows(), ...channels.publicModelRows()],
      complete: (request, onChunk) => channels.handles(request.model) ? channels.complete(request, onChunk) : core.complete(request, onChunk),
      // `...core` 带过来的 testModel 只在自己的目录里查 id，而渠道行是上面
      // 才拼进 catalog 的 —— 不在这里分派，页面列出的渠道模型一点「测一次」
      // 就会得到 Unknown model。分派规则与 complete 保持同一优先级。
      testModel: (id, effort, options) => channels.handles(id) ? channels.testModel(id, options) : core.testModel(id, effort, options),
      async refreshCatalog(options) {
        if (stopped) return
        await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
      },
    }
    management = createManagement({
      stores, runtime, channels, eac,
      outlet: outletStatus,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true, lan: true },
        lan: lanState(),
      }),
      onSettingsChanged: async () => {
        if (!refreshInFlight) scheduleRefresh()
        await Promise.all([reconcileRelay(), reconcileOutlet()])
      },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      complete: runtime.complete,
      modelRows: runtime.publicModelRows,
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, eac: true, accountChannels: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()
    await Promise.all([reconcileRelay(), reconcileOutlet()])

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      get lan() { return lanState() },
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        if (outletRestartTimer !== null) clearTimeout(outletRestartTimer)
        management.dispose()
        eac.dispose()
        runtime.dispose()
        closing = (async () => {
          try {
            await relayChanges
            await Promise.all([closeRelay(), closeOutlet(), listener.close(), channels.close()])
          } finally {
            try { stores.dispose() } finally { await releaseLock() }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    if (outletRestartTimer !== null) clearTimeout(outletRestartTimer)
    management?.dispose()
    eac?.dispose()
    runtime?.dispose()
    await relayChanges
    await closeRelay()
    await outletChanges
    const current = outletRelay
    outletRelay = null
    await current?.close().catch(() => {})
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
