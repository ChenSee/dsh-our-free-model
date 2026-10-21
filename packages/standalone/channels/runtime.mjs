import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { foldForwardOutcome } from '../../../src/core/completion.js'
import { recordTurn, recordUsage } from '../../../src/store.js'

/** 一实例一 Worker，避免原渠道业务的模块单例串目录、串账号。 */
export async function createChannelRuntime({ dataDir, logger = console, stats }) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    env: { ...process.env, OFM_CODEARTS_CACHE_DIR: path.join(dataDir, 'channel-pack', 'codearts-cache') },
  })
  const pending = new Map()
  let sequence = 0
  let closed = false
  let closing
  let rows = []
  let providers = []
  let refreshing
  let refreshTimer
  let finishClose
  let failed
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const rejectAll = error => {
    failed = error
    readyReject(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', code => {
    if (!closed) rejectAll(new Error(`渠道进程已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', message => {
    if (message.type === 'ready') { providers = message.providers; readyResolve(); return }
    if (message.type === 'log') { logger[message.level]?.(message.message); return }
    if (message.type === 'closed') { finishClose?.(); return }
    if (message.type === 'changed') {
      if (closed) return
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { void refresh().catch(error => logger.warn?.(`渠道目录刷新失败：${error.message}`)) }, 200)
      refreshTimer.unref?.()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try { entry.onChunk?.(message.chunk) } catch (error) { entry.reject(error); worker.postMessage({ type: 'cancel', id: message.id }) }
    } else if (message.type === 'error') entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    else entry.resolve(message.value)
  })
  function call(type, payload = {}, signal, onChunk, timeoutMs = 120000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); fn(value) }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }
  function refresh() {
    if (refreshing) return refreshing
    refreshing = call('models').then(value => { rows = value; return rows }).finally(() => { refreshing = undefined })
    return refreshing
  }
  const handles = model => providers.some(provider => model.startsWith(`${provider}/`))
  const runtime = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? failed.message : '' } },
    publicModelRows: () => rows,
    refresh,
    handles,
    async rpc(body, signal) {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) throw Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 })
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },
    async complete(request, onChunk) {
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const started = Date.now()
      let first = 0
      let ok = false
      try {
        const { signal, ...wire } = request
        await call('complete', { request: wire }, signal, chunk => {
          if (!first) first = Date.now()
          foldForwardOutcome(outcome, chunk)
          onChunk?.(chunk)
        }, 30 * 60000)
        ok = outcome.error === undefined
        return outcome
      } finally {
        if (!closed && stats) {
          const usage = outcome.usage
          recordUsage(stats, {
            model: request.model, at: Date.now(), input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0,
            reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
            ok, origin: 'forward', ttftMs: first ? first - started : undefined,
            decodeMs: first ? Date.now() - first : 0, decodeTokens: usage?.completion_tokens ?? 0,
            noUsage: usage === undefined, elapsedMs: Date.now() - started, aborted: request.signal?.aborted === true,
          })
          recordTurn(stats, { model: request.model, ok, recovered: false })
        }
      }
    },
    /**
     * 设置页的「测一次」。渠道行只存在于 worker 的清单里，核心目录并不认识
     * 这些 `provider/model` id，所以 core.testModel 会直接报 Unknown model。
     * 这里走同一条 worker 通道发一次真实的最小生成，返回值形状与
     * core.testModel 对齐，前端无需区分行的来源。
     */
    async testModel(model, { signal } = {}) {
      if (!handles(model)) throw Object.assign(new Error('Unknown model "' + model + '"'), { status: 404 })
      const started = Date.now()
      let first = 0
      let ok = false
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      try {
        await call('complete', {
          request: { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] },
        }, signal, chunk => {
          if (!first && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta')
            && typeof chunk.text === 'string' && chunk.text.length > 0) first = Date.now()
          foldForwardOutcome(outcome, chunk)
        }, 300000)
        if (outcome.error !== undefined) throw new Error(outcome.error)
        if (outcome.toolCalls.length > 0) throw new Error('Text test returned an unexpected tool call')
        if (!outcome.text.trim()) throw new Error('Text test returned no response text')
        ok = true
      } catch (error) {
        // 停用或不存在的模型在 worker 里是 statusCode 404；管理接口按 `status` 映射 HTTP 码。
        if (error?.statusCode === 404) throw Object.assign(new Error(error.message), { status: 404 })
        throw error
      } finally {
        if (!closed && stats) {
          const usage = outcome.usage
          const ended = Date.now()
          recordUsage(stats, {
            model, at: ended, input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0,
            reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
            ok, origin: 'bench', ttftMs: first ? first - started : undefined,
            decodeMs: first ? ended - first : 0, decodeTokens: usage?.completion_tokens ?? 0,
            noUsage: usage === undefined, elapsedMs: ended - started, aborted: signal?.aborted === true,
          })
          recordTurn(stats, { model, ok, recovered: false })
        }
      }
      const ended = Date.now()
      const usage = outcome.usage
      const outputTokens = usage?.completion_tokens ?? 0
      const decodeMs = first ? ended - first : 0
      return {
        model, ok: true,
        totalMs: ended - started, latencyMs: ended - started,
        ttftMs: first ? first - started : ended - started,
        outputTokens, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        tokensPerSecond: decodeMs > 0 && outputTokens > 0 ? Math.round((outputTokens * 1000) / decodeMs) : null,
        sample: outcome.text.slice(0, 60), text: outcome.text.slice(0, 2000),
      }
    },
    close() {
      if (closing) return closing
      closed = true
      clearTimeout(refreshTimer)
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer
        await new Promise(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }
  try {
    const timeout = setTimeout(() => readyReject(new Error('渠道初始化超时')), 30000)
    try { await ready } finally { clearTimeout(timeout) }
    runtime.ready = refresh().catch(error => { if (!closed) logger.warn?.(`渠道启动清单刷新失败：${error.message}`) })
    return runtime
  } catch (error) { await runtime.close(); throw error }
}
