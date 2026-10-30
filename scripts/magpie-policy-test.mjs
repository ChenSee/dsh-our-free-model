/**
 * The retained account channels stay reachable through the model workspace.
 *
 * ⚠️ 本 fork 的立场与上游相反：上游 2.7.x 起排除 WorkBuddy 国内版/国际版与
 * 华为云，本 fork 明确保留这三个账号渠道。因此 `src/magpie-policy.js` 的排除
 * 表为空，本套测试验证的正是这一点 —— 渠道在插件市场、供应商目录、模型目录
 * 与所有变更入口上都不再被拦截，且策略层本身仍作为单一判定点正常工作。
 *
 * Runs against the real pinned executable, like magpie-engine-test.
 * Build first: node scripts/build-magpie-engine.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'
import { createMagpieModels } from '../src/magpie-models.js'
import { assertEngineMutation, deniedModel, filterEngineJSON, isDeniedChannel } from '../src/magpie-policy.js'
import { pinnedEngineEntry } from './lib/engine-binary.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-policy-'))
const saved = new Map()
for (const [name, value] of Object.entries({
  HOME: path.join(scratch, 'native-home'),
  USERPROFILE: path.join(scratch, 'native-home'),
  XDG_CONFIG_HOME: path.join(scratch, 'native-config'),
  XDG_CACHE_HOME: path.join(scratch, 'native-cache'),
  XDG_DATA_HOME: path.join(scratch, 'native-data'),
  XDG_STATE_HOME: path.join(scratch, 'native-state'),
})) {
  saved.set(name, process.env[name])
  process.env[name] = value
  fs.mkdirSync(value, { recursive: true })
}

const PACKAGE = '@magpie-community/opencode-workbuddy-auth'
const IDS = ['workbuddy', 'workbuddy-ai']
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data'), logger: {} })
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
const server = http.createServer((req, res) => {
  const subpath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url
  engine.proxy(req, res, subpath).catch(() => { try { res.destroy() } catch {} })
})
const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const denied = async (method, route, body) => {
  try {
    await engine.request(method, route, body === undefined ? {} : { body })
    return false
  } catch (error) {
    return error.statusCode === 403
  }
}

try {
  // The engine-backed groups need this platform's pinned binary; the pure-function
  // group at the end does not, so it still runs on a platform with no binary.
  const hasEngine = pinnedEngineEntry() !== null
  if (hasEngine) await engine.start()
  else console.log(`ok  engine-backed groups skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
  const origin = hasEngine ? await listen() : null
  const base = origin === null ? null : origin + prefix
  const read = async route => {
    const response = await fetch(base + route)
    assert.equal(response.status, 200, route)
    return response.json()
  }
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const engineCheck = async (name, run) => {
    if (!hasEngine) return
    await check(name, run)
  }

  // ── 策略层本身：三个渠道都不在排除表里 ─────────────────────────────────────
  await check('no account channel is excluded by this fork', () => {
    for (const id of ['workbuddy', 'workbuddy-ai', 'codebuddy', 'codebuddy-cn',
      'huaweicloud', 'codearts', '华为云', '码道']) {
      assert.equal(isDeniedChannel(id), false, `${id} must stay offered`)
    }
    // 未涉及的渠道当然也不会被误伤。
    for (const id of ['qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon',
      'minimax', 'zcode', 'gemini', 'lobsterai']) {
      assert.equal(isDeniedChannel(id), false, `${id} stays offered`)
    }
  })

  await check('the disclaimer describes provenance instead of exclusion', async () => {
    const { DISCLAIMER, EXCLUDED_CHANNELS } = await import('../src/disclaimer.js')
    assert.equal(EXCLUDED_CHANNELS.length, 0, 'this fork excludes no channel')
    const body = DISCLAIMER.sections.map(section => section.body).join(' ')
    assert.match(body, /WorkBuddy/, 'WorkBuddy is named')
    assert.match(body, /华为云|Huawei/i, 'Huawei Cloud is named')
    assert.match(body, /与本项目作者及团队无关/, 'it states the team is not responsible')
    assert.match(body, /个人学习/, 'it states the project purpose')
    assert.match(body, /自行承担/, 'it places the consequences on the user')
    assert.doesNotMatch(body, /不包含、也不提供/, 'it no longer claims the channels are withheld')
  })

  // ── 引擎面：三个渠道不再被过滤 ─────────────────────────────────────────────
  await engineCheck('the plugin market is not filtered for the channel', async () => {
    const listings = await read('api/plugins/listings')
    assert(Array.isArray(listings.listings), 'listings answered')
    assert(listings.listings.length > 5, 'the market still lists plugins')
    const market = await read('api/plugins/market')
    assert(Array.isArray(market.listings), 'market listings answered')
    assert(Array.isArray(market.state.plugins), 'market state stays intact')
  })

  await engineCheck('the Huawei Cloud preset is offered', async () => {
    const providers = await read('api/providers')
    assert(providers.presets.some(preset => preset.id === 'huaweicloud'), 'Huawei Cloud preset present')
    assert(providers.presets.some(preset => preset.id === 'tencent-cloud'), 'other regional presets stay')
    assert.equal(providers.presets.length > 5, true, 'presets stay')
  })

  await engineCheck('a provider save naming the channel is not refused by policy', async () => {
    for (const body of [
      { preset: 'huaweicloud', key: 'fixture' },
      { id: 'huaweicloud', name: 'Huawei Cloud', key: 'fixture' },
      { preset: 'codebuddy', key: 'fixture' },
    ]) {
      assert.equal(await denied('POST', '/api/provider/save', body), false, JSON.stringify(body))
    }
    const other = await post('api/provider/save', { preset: 'moonshot-cn', key: 'fixture', name: 'OFM policy fixture' })
    assert.notEqual(other.status, 403, 'an unrelated preset save is not refused by policy')
    await other.text()
  })

  await engineCheck('installing or signing in the channel is not refused by policy', async () => {
    for (const [route, body] of [
      ['/api/plugins/add', { spec: PACKAGE }],
      ['/api/plugins/upgrade', { spec: PACKAGE }],
      ['/api/plugins/off', { spec: PACKAGE, off: false }],
      ['/api/plugin-signin', { provider: IDS[0], method: 0 }],
      ['/api/signin', { agent: IDS[0] }],
      ['/api/provider/move', { id: IDS[0] }],
    ]) {
      assert.equal(await denied('POST', route, body), false, `${route} ${JSON.stringify(body)}`)
    }
  })

  await engineCheck('the model catalog keeps rows served through the channel', async () => {
    const published = []
    const models = createMagpieModels({
      engine,
      stats: { record() {} },
      logger: {},
      onChanged: () => published.push(models?.catalog?.().length ?? 0),
    })
    try {
      assert.equal(deniedModel({ id: 'glm-5.3-flash', owned_by: 'workbuddy' }), false, 'by provider')
      assert.equal(deniedModel({ id: 'workbuddy/glm-5.3-flash', owned_by: 'x' }), false, 'by id')
      assert.equal(deniedModel({ id: 'huaweicloud/deepseek-v4', owned_by: 'huaweicloud' }), false, 'Huawei row')
      await models.refresh()
    } finally { models.close() }
  })

  // ── 过滤器仍按路由工作，只是不再命中这三个渠道 ─────────────────────────────
  await check('the filter is a pure function of the route and the answer', () => {
    const listings = { listings: [
      { package: PACKAGE, name: 'WorkBuddy', providers: IDS },
      { package: '@magpie-community/opencode-zcode-auth', name: 'ZCode', providers: ['zcode'] },
    ] }
    // 排除表为空，因此两条都在 —— 这正是本 fork 的预期。
    const filtered = filterEngineJSON('/api/plugins/listings', structuredClone(listings))
    assert.equal(filtered.listings.length, 2, 'nothing is filtered out')
    assert.ok(filtered.listings.some(row => row.package === PACKAGE), 'WorkBuddy listing stays')
    const unknown = { anything: 1 }
    assert.equal(filterEngineJSON('/api/settings', unknown), unknown, 'other routes pass through')
    // 变更断言仍可拦截（只是不再有命中它的渠道名），并放行只读方法。
    assert.doesNotThrow(() => assertEngineMutation('POST', '/api/plugins/add', { spec: PACKAGE }))
    assert.doesNotThrow(() => assertEngineMutation('GET', '/api/plugins/add', { spec: PACKAGE }))
  })

  console.log(`magpie-policy: ${checks} checks passed`)
} finally {
  await engine.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}
