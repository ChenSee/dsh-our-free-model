import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Check, LoaderCircle, RotateCcw, Save, Settings2, RefreshCw, Route, Eye, EyeOff, Copy, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Input, Switch } from './components/ui'
import { settingsDraft, settingsChanged, syncSettings, validateSettingsDraft } from './settings-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, OutletStatus, Summary } from './types'
import './settings.css'

type Draft = ReturnType<typeof settingsDraft>
type NumberField = 'defaultMaxTokens' | 'probeIntervalMinutes'
const connectionError = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? '保存请求超时，结果尚未确认。请重试或检查服务状态。'
    : reason instanceof TypeError && /fetch/i.test(reason.message) ? '无法连接本地服务，修改已保留，请确认服务正在运行后重试。'
    : reason.message : '保存失败，修改已保留，请重试。'
/** 出口状态：出口开着时页面每 15 秒轮询一次；关着不打扰服务。 */
const OUTLET_POLL_MS = 15_000
const useOutletStatus = (host: Host, enabled: boolean, active: boolean) => {
  const [status, setStatus] = useState<OutletStatus | null>(null)
  useEffect(() => {
    if (!enabled) { setStatus(null); return undefined }
    let disposed = false
    const read = async () => {
      try {
        const next = await host.readOutlet()
        if (!disposed) setStatus(next)
      } catch { /* 读数失败保留上一次；出站不受影响 */ }
    }
    void read()
    const timer = window.setInterval(() => { if (!document.hidden) void read() }, OUTLET_POLL_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [host, enabled, active])
  return status
}

export function Settings({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [state, setState] = useState(() => ({ saved: summary.settings, draft: settingsDraft(summary.settings) }))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<NumberField | 'egressUrl', string>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const generation = useRef(0)
  activeRef.current = active
  useEffect(() => () => { mounted.current = false; generation.current++ }, [])
  useEffect(() => {
    if (!active) { generation.current++; setMessage(''); setError('') }
  }, [active])
  useEffect(() => {
    setState(previous => syncSettings(previous, summary.settings, savingRef.current))
  }, [summary.settings])
  const dirty = settingsChanged(state.draft, state.saved)
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    setMessage(''); setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current || !activeRef.current) return
    const validation = validateSettingsDraft(state.draft)
    setErrors(validation.errors); setMessage(''); setError('')
    if (!validation.patch) return
    const started = ++generation.current
    const feedbackCurrent = () => mounted.current && activeRef.current && started === generation.current
    savingRef.current = true
    setSaving(true)
    try {
      const saved = await host.saveSettings(validation.patch)
      if (!mounted.current) return
      setState({ saved, draft: settingsDraft(saved) })
      if (feedbackCurrent()) setMessage('设置已保存并生效')
      // 保存结果已确认；后续读取失败不能误报为保存失败。
      try { await host.refresh() } catch {
        if (feedbackCurrent()) setMessage('设置已保存；状态刷新失败，稍后会自动重试。')
      }
    } catch (reason) {
      if (feedbackCurrent()) setError(connectionError(reason))
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const toggle = (name: 'enabled' | 'exposeRegionModels' | 'streamRecovery' | 'standaloneProbe' | 'hideFreeModels' | 'hideEacModels', label: string, help: string) =>
    <label className="settings-field" key={name}>
      <span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" role="switch" name={name} className="settings-toggle"
        checked={state.draft[name]} onChange={event => update(name, event.target.checked)} />
    </label>
  const numeric = (name: NumberField, label: string, help: string, min: number, max: number) =>
    <div className="settings-field settings-number-field">
      <label htmlFor={`setting-${name}`}><strong>{label}</strong><small>{help}</small></label>
      <div className="settings-number"><Input id={`setting-${name}`} name={name} type="number" min={min} max={max} step={1}
        value={state.draft[name]} onChange={event => update(name, event.target.value)}
        aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `setting-error-${name}` : undefined} />
        {errors[name] ? <p id={`setting-error-${name}`} className="settings-field-error" role="alert"><CircleAlert size={12} />{errors[name]}</p>
          : <span className="settings-hint">{min}–{max}</span>}
      </div>
    </div>
  if (!active) return null
  const statusClass = saving ? 'settings-status-saving' : dirty ? 'settings-status-dirty' : message ? 'settings-status-saved' : ''
  return <div className="settings-browser" data-testid="settings-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / SETTINGS</div>
      <h1>服务设置</h1><p>调整本机推理与模型刷新，保存后生效。</p></div>
      <Badge tone={summary.settings.enabled ? 'success' : 'warning'}>{summary.settings.enabled ? '推理服务已启用' : '推理服务已暂停'}</Badge>
    </header>
    <form onSubmit={event => { void submit(event) }} noValidate>
      <fieldset disabled={saving} className="settings-fieldset">
        <Card className="settings-card"><div className="settings-card-heading"><Settings2 size={16} /><div><h2>推理与模型</h2><p>控制客户端调用与模型展示。</p></div></div>
          {toggle('enabled', '启用推理服务', '关闭后暂停 API 推理，管理页面仍可访问。')}
          {toggle('exposeRegionModels', '显示地区受限模型', '保留受当前出口地区限制的模型供客户端选择。')}
          {toggle('hideFreeModels', visibility.hideFree, '仅从选择器和 API 模型清单隐藏，保留历史模型调用。')}
          {toggle('hideEacModels', visibility.hideEac, '保留授权和历史模型调用，可随时恢复显示。')}
          {toggle('streamRecovery', '自动恢复断流', '允许从已生成的检查点继续回答。')}
          {numeric('defaultMaxTokens', '单次最大输出 Token', '512–131072，实际输出还受模型能力限制。', 512, 131072)}
        </Card>
        <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>模型刷新</h2><p>管理模型清单的周期更新与探测。</p></div></div>
          {numeric('probeIntervalMinutes', '刷新间隔（分钟）', '1–1440 分钟，保存后重新安排下一轮。', 1, 1440)}
          {toggle('standaloneProbe', '自动探测可用性', '周期刷新时发送探测请求，消耗上游额度；遇到限流会自动退避。')}
          <p className="settings-note" role="note"><CircleAlert size={15} /><span>{summary.automaticRefresh
            ? '自动刷新已启用，保存间隔后会重新安排下一轮。'
            : '当前以 --no-refresh 启动。设置会保存，但自动任务保持暂停；手动刷新仍可用。'}</span></p>
        </Card>
        <EgressCard state={state} update={update} errors={errors} summary={summary} host={host} />
        <div className="settings-footer"><span role="status" aria-live="polite" className={statusClass}><span className="settings-status-dot" aria-hidden="true" />{saving ? '正在保存，请稍候…' : dirty ? '有尚未保存的修改' : message || '当前设置已同步'}</span>
          <div className="settings-actions"><Button variant="outline" disabled={!dirty || saving} onClick={() => {
            setState(previous => ({ ...previous, draft: settingsDraft(previous.saved) }))
            setErrors({}); setError(''); setMessage('')
          }}><RotateCcw size={15} />撤销修改</Button>
            <Button type="submit" disabled={!dirty || saving}>{saving ? <LoaderCircle size={15} className="spinning" /> : message && !dirty ? <Check size={15} /> : <Save size={15} />}{saving ? '正在保存' : '保存设置'}</Button></div>
        </div>
      </fieldset>
      {error && <p className="settings-save-error" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
    </form>
    <p className="footnote">配置保存在当前独立服务的数据目录中。页面读取和保存设置不会直接发送模型推理请求。</p>
  </div>
}

/** 出口代理卡片：开关、模式、地址（打码 / 按需取用 / 替换 / 清除）、
 *  mihomo 路径与当前最佳节点读数。地址是凭据：面板默认不持有原值。 */
function EgressCard({ state, update, errors, summary, host }: {
  state: { draft: Draft; saved: Summary['settings'] }
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  errors: Partial<Record<NumberField | 'egressUrl', string>>
  summary: Summary
  host: Host
}) {
  const draft = state.draft
  const [revealed, setRevealed] = useState('')
  const [showing, setShowing] = useState(false)
  const [copied, setCopied] = useState(false)
  const outlet = useOutletStatus(host, draft.egressEnabled === true, summary.settings.egress?.enabled === true)
  const reveal = async () => {
    if (showing) { setShowing(false); setRevealed(''); return }
    setShowing(true)
    setRevealed(await host.getEgressUrl().catch(() => ''))
  }
  const copy = async () => {
    const value = revealed || await host.getEgressUrl().catch(() => '')
    await host.copy(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_600) })
  }
  const clear = () => {
    update('egressEnabled', false)
    update('egressUrl', '')
    update('egressHasUrl', false)
    update('egressUrlLabel', '')
    // 清除地址要连 url 一起提交：显式空串让后端删除已存值。
    update('egressCleared', true)
  }
  const saved = state.saved.egress
  const active = saved?.enabled === true && outlet?.running !== false
  const nodeLabel = outlet && typeof outlet.node === 'string' && outlet.node !== ''
    ? `${outlet.node}${outlet.nodeDelayMs ? ` · ${outlet.nodeDelayMs}ms` : ''}`
    : '测量中…'
  const subscription = draft.egressSubscription === true
  return <Card className="settings-card"><div className="settings-card-heading"><Route size={16} /><div>
    <h2>出口代理</h2><p>让推理、模型清单与出口探测请求走代理出口，缓解按 IP 的频率限制与地区门。</p></div>
    <Badge tone={active ? 'success' : 'neutral'} dot={active}>{active ? '出口生效中' : '未启用'}</Badge>
  </div>
    <label className="settings-field">
      <span><strong>启用出口</strong><small>关闭时所有请求直连发出。开启后仅本服务的三类请求改道，浏览器与其它程序不受影响。</small></span>
      <Switch checked={draft.egressEnabled === true} onCheckedChange={next => update('egressEnabled', next)} aria-label="启用出口" />
    </label>
    <label className="settings-field">
      <span><strong>订阅模式</strong><small>打开：粘贴 Clash / V2Ray 订阅链接，由本机 mihomo 自动测速分流；关闭：手填单条 http / https / socks5 / socks5h 代理地址。</small></span>
      <Switch checked={subscription} onCheckedChange={next => update('egressSubscription', next)} aria-label="订阅模式" />
    </label>
    <div className="settings-field">
      <span><strong>订阅 / 代理地址</strong><small>{draft.egressHasUrl === true && draft.egressUrlLabel
        ? <>已保存：<code className="settings-mono">{showing && revealed ? revealed : `${draft.egressUrlLabel}/…`}</code></>
        : '未设置。地址只保存在本机设置文件中，接口不回显，面板默认打码。'}</small></span>
      <div className="settings-url-actions">
        <Button variant="outline" size="sm" onClick={() => void reveal()} disabled={draft.egressHasUrl !== true}>
          {showing ? <EyeOff size={14} /> : <Eye size={14} />}{showing ? '隐藏' : '显示'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copy()} disabled={draft.egressHasUrl !== true}>
          <Copy size={14} />{copied ? '已复制' : '复制'}
        </Button>
        <Button variant="outline" size="sm" onClick={clear} disabled={draft.egressHasUrl !== true}>
          <Trash2 size={14} />清除
        </Button>
      </div>
    </div>
    <div className="settings-field settings-number-field">
      <label htmlFor="setting-egressUrl"><strong>替换地址</strong><small>粘贴新的订阅或代理地址；留空表示保持当前地址不变。</small></label>
      <div className="settings-number"><Input id="setting-egressUrl" name="egressUrl" type="text"
        placeholder={draft.egressHasUrl === true ? '留空保持当前地址' : '粘贴订阅 / 代理地址'}
        value={draft.egressUrl ?? ''} onChange={event => update('egressUrl', event.target.value)}
        aria-invalid={!!errors.egressUrl} aria-describedby={errors.egressUrl ? 'setting-error-egressUrl' : undefined} />
        {errors.egressUrl ? <p id="setting-error-egressUrl" className="settings-field-error" role="alert"><CircleAlert size={12} />{errors.egressUrl}</p>
          : <span className="settings-hint">保存后生效</span>}
      </div>
    </div>
    {subscription && <div className="settings-field settings-number-field">
      <label htmlFor="setting-egressMihomoPath"><strong>mihomo 路径</strong><small>订阅模式留空则自动查找本机 mihomo（如 Clash Verge 的 verge-mihomo.exe）。</small></label>
      <div className="settings-number"><Input id="setting-egressMihomoPath" name="egressMihomoPath" type="text"
        placeholder="留空自动查找" value={draft.egressMihomoPath ?? ''} onChange={event => update('egressMihomoPath', event.target.value)} />
        <span className="settings-hint">仅订阅模式使用</span>
      </div>
    </div>}
    {draft.egressEnabled === true && <div className="settings-field settings-status-row">
      <span><strong>当前出口</strong><small>{draft.egressHasUrl === true ? `${draft.egressUrlLabel ?? ''} · ${subscription ? '订阅分流' : '单代理'}` : '尚未配置地址'}</small></span>
      <code className="settings-mono">{draft.egressHasUrl === true ? '已就绪' : '—'}</code>
    </div>}
    {draft.egressEnabled === true && <div className="settings-field settings-status-row">
      <span><strong>当前最佳节点</strong><small>url-test 自动选中的节点与它最近一次测速延迟，每 15 秒刷新。</small></span>
      <code className="settings-mono">{outlet?.mode === 'subscription' ? nodeLabel : '单代理模式无节点读数'}</code>
    </div>}
    {draft.egressEnabled === true && outlet?.error && <p className="settings-note" role="note"><CircleAlert size={15} /><span>出口启动失败：{outlet.error}</span></p>}
    <p className="settings-note" role="note"><CircleAlert size={15} /><span>出口只接管模型推理、模型清单与出口 IP 探测；公告、升级与渠道授权仍直连。按 IP 的频率限制与地区门会随出口变化，按会话的速率限制不认出口。</span></p>
  </Card>
}
