export type Page = 'overview' | 'models' | 'usage' | 'channels' | 'eac' | 'settings' | 'connection' | 'sponsor'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  hiddenByUser?: boolean
  hiddenByGroup?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availability?: string
  ttftMs?: number | null
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number }
/** 出口设置写入载荷：面板只提交改动的键，地址留空即保持原值。 */
export interface EgressPatch {
  enabled?: boolean
  mode?: 'subscription' | 'client'
  url?: string
  mihomoPath?: string
}
export interface EgressSettings {
  enabled: boolean
  mode: 'subscription' | 'client'
  /** 脱敏域名，如 `https://host/…`；完整值只存在于设置文件与本机内存中。 */
  hasUrl: boolean
  urlLabel: string
  mihomoPath: string
}
export interface OutletStatus {
  running: boolean
  active?: boolean
  mode?: string
  outlet?: string
  node?: string
  nodeDelayMs?: number
  nodeAt?: number
  latencyMs?: number
  latencyAt?: number
  error?: string
}
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  hiddenModelIds: string[]
  hideFreeModels: boolean
  hideEacModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
  egress?: EgressSettings
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  channels: { state: string; error?: string }
  eacAuth?: { local?: boolean; authorized?: boolean; login?: string }
  catalog: Model[]
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  saveSettings(settings: Omit<Partial<ServiceSettings>, 'egress'> & { egress?: EgressPatch }): Promise<ServiceSettings>
  /** 出口代理：完整订阅 / 代理地址按需取用（设置页自己发起）。 */
  getEgressUrl(): Promise<string>
  /** 出口代理：当前最佳节点与延迟读数。 */
  readOutlet(): Promise<OutletStatus>
}
