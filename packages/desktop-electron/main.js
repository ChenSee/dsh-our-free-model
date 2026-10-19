'use strict'
/**
 * Our Free Model 桌面壳（Electron 版）。
 *
 * 与 Tauri 版保持同一套行为契约：
 *  - 启动时先显示 splash，后台拉起内置 Node 独立服务；
 *  - 服务握手只来自自己的 stdout 管道（ofm-desktop-ready/v1），
 *    不信任端口占用者或共享目录里的 ready 文件；
 *  - 主窗口加载握手返回的管理地址，无边框 + 注入自定义标题栏；
 *  - 关闭主窗口 = 隐藏到托盘，托盘「退出」才真正关闭服务并释放数据锁；
 *  - 单实例：第二个实例只唤醒已有窗口；
 *  - 数据目录由 OFM_HOME 决定，默认 ~/.our-free-model，与已安装版一致。
 */
const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron')
// 无 GPU / GPU 驱动异常的环境（虚拟机、远程桌面、部分老机器）下，
// Electron 默认的硬件加速会直接把进程带崩。界面本身不需要它。
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const PRODUCT = 'our-free-model-standalone'
const PROTOCOL_READY = 'ofm-desktop-ready/v1'
const PROTOCOL_ERROR = 'ofm-desktop-error/v1'

/** 应用根目录：开发时是包目录，打包后是 resources 的上一级。 */
function appRoot() {
  // getAppPath 返回绝对路径，比 __dirname 更可靠（某些启动方式下 __dirname 是 "."）。
  return app.getAppPath()
}

/** 界面资源（splash / 图标 / titlebar）统一放在 app 目录的 assets/ 与 splash/，
 *  开发与打包使用同一相对位置；内容由 scripts/prepare-electron.mjs 从 Tauri 版同步。 */
function asset(...segments) {
  return path.join(appRoot(), ...segments)
}

/** 资源根目录：开发时在仓库内，打包后在 resources/。 */
function resourceRoot() {
  return app.isPackaged ? path.join(process.resourcesPath) : path.join(appRoot(), '..', 'desktop', 'src-tauri', 'resources')
}

function resolveDataDir() {
  const configured = process.env.OFM_HOME
  if (configured && configured.trim() !== '') return path.resolve(configured.trim())
  return path.join(app.getPath('home'), '.our-free-model')
}

/**
 * 校验握手：字段、协议、pid、端口、token 形态全部核对后才允许加载，
 * 与 Tauri 版 service.rs 的 ready_address 同口径。
 */
function verifyHandshake(value, pid) {
  if (value.protocol === PROTOCOL_ERROR) {
    if (value.code === 'DATA_DIRECTORY_IN_USE') {
      return { error: '数据目录已被服务占用，请先停止已有独立服务；不会删除它的锁文件' }
    }
    return { error: '后端服务启动失败，请检查安装资源和数据目录权限' }
  }
  const address = typeof value.managementUrl === 'string' ? value.managementUrl : ''
  let url
  try { url = new URL(address) } catch { return { error: '服务握手地址无效' } }
  const token = url.hash.startsWith('#login=') ? url.hash.slice(7) : ''
  const checks = [
    value.protocol === PROTOCOL_READY,
    value.product === PRODUCT,
    value.pid === pid,
    value.port === Number(url.port || (url.protocol === 'http:' ? 80 : 443)),
    Number(url.port || 0) > 0,
    url.protocol === 'http:',
    url.hostname === '127.0.0.1',
    url.username === '',
    url.password === '',
    url.pathname === '/',
    url.search === '',
    token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token),
  ]
  if (!checks.every(Boolean)) return { error: '服务握手校验失败' }
  return { address }
}

/** 启动服务子进程并等待握手。返回 { address } 或 { error }。 */
function startService() {
  const root = resourceRoot()
  const node = path.join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const host = path.join(root, 'service', 'packages', 'desktop', 'service-host.mjs')
  if (!fs.existsSync(node) || !fs.existsSync(host)) {
    return Promise.resolve({ error: '安装资源不完整，请重新安装桌面程序' })
  }
  const dataDir = resolveDataDir()
  const env = { ...process.env, OFM_HOME: dataDir }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  // 端口默认与安装版一致（18900）；OFM_PORT 供绿色版多开或排障时避让。
  const port = /^\d+$/.test(process.env.OFM_PORT ?? '') ? Number(process.env.OFM_PORT) : null
  return new Promise(resolve => {
    // 与 Tauri 版一致：以服务目录为工作目录、只传文件名，避免 Windows
    // canonicalize 后的 \\?\ 长路径前缀被 Node 拒绝。
    const args = ['--data-dir', dataDir]
    if (port !== null) args.push('--port', String(port))
    const child = spawn(node, [path.basename(host), ...args], {
      cwd: path.dirname(host), env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    })
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      const line = buffer.indexOf('\n')
      if (line < 0) return
      const first = buffer.slice(0, line).trim()
      buffer = buffer.slice(line + 1)
      if (first === '') return
      let value
      try { value = JSON.parse(first) } catch { finish({ error: '服务握手校验失败', child }); return }
      const result = verifyHandshake(value, child.pid)
      if (result.error) child.kill()
      finish({ ...result, child })
    })
    child.on('error', () => finish({ error: '无法启动内置 Node 服务', child }))
    child.on('exit', code => {
      // 服务在运行中自己死了（例如数据目录被抢占、进程崩溃），
      // 既要把托盘刷成真实状态，也要给用户一个重试入口。
      if (serviceChild === child) {
        serviceChild = null
        updateTray()
        if (!quitting && !starting && serviceAddress !== '') {
          logEvent(`service: 运行中退出（code=${code ?? 'signal'}）`)
          showFailure(`本地服务已退出（${code ?? 'signal'}）。`)
        }
      }
      finish({ error: `服务提前退出（${code ?? 'signal'}）`, code, child })
    })
    // 握手管道：父进程 stdin 关闭即父进程已离开，服务自行退出。
    process.once('exit', () => { try { child.kill() } catch {} })
  })
}

/** 与 titlebar.js 配套的注入脚本：只对握手 origin 生效。
 *  不改动 titlebar.js 源码（它与 Tauri 版共用），只把 __TAURI__ 桥接到
 *  preload 暴露的 ofmTitlebarApi；拖拽由 CSS app-region 承担，
 *  startDragging 成为 no-op。 */
function titlebarScript(origin) {
  const css = fs.readFileSync(asset('assets', 'titlebar.css'), 'utf8')
    // 无边框拖拽：标题栏空白区域可拖动（按钮区域由 no-drag 排除）。
    .replace('#ofm-titlebar {', '#ofm-titlebar{-webkit-app-region:drag}')
  const js = fs.readFileSync(asset('assets', 'titlebar.js'), 'utf8')
    .replace(/window\.__TAURI__/g, 'window.ofmTitlebar')
  const bridge = `
    // Tauri 的用法是 const win = window.__TAURI__.window.getCurrentWindow()，
    // 之后 win.minimize() / win.isMaximized() 直接可用——窗口方法必须同时挂在
    // 顶层与 .window 上，两种取法都要成立。
    const ofmWin = {
      minimize: () => window.ofmTitlebarApi.minimize(),
      maximize: () => window.ofmTitlebarApi.toggleMaximize(),
      unmaximize: () => window.ofmTitlebarApi.toggleMaximize(),
      hide: () => window.ofmTitlebarApi.hide(),
      // 拖拽由 CSS -webkit-app-region 完成，这里只做能力占位。
      startDragging: () => {},
      isMaximized: async () => window.ofmTitlebarApi.isMaximized(),
    };
    window.ofmTitlebar = Object.assign(ofmWin, {
      // titlebar.js 以 getCurrentWindow 探测宿主能力。
      getCurrentWindow: () => ofmWin,
      window: Object.assign({}, ofmWin, { getCurrentWindow: () => ofmWin }),
    });`
  return `
    if (location.origin === ${JSON.stringify(origin)}) {
      const mount = () => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(css)};
        document.head.appendChild(style);
        ${bridge}
        ${js}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
      else mount();
    }`
}

let splashWindow = null
let mainWindow = null
let failureWindow = null
let tray = null
let serviceChild = null
/** 握手成功后的管理地址：窗口被销毁后仍能凭它重建面板。 */
let serviceAddress = ''
let quitting = false
let starting = false
/** 启动重试：上一个实例退出需要时间（数据目录锁未释放）。 */
const START_ATTEMPTS = 4
const START_BACKOFF_MS = [0, 2500, 5000, 10000]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 诊断日志：GUI 程序的 stdout 用户看不到，排障只能靠它。上限 512KB，超出截断。 */
const LOG_LIMIT = 512 * 1024
function logEvent(message) {
  try {
    const file = path.join(app.getPath('logs'), 'shell.log')
    if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT) {
      fs.writeFileSync(file, '')
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
  } catch { /* 日志写不了不影响主流程 */ }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showExisting())
  // 自定义标题栏的窗口操作桥：只回应自己注入的 preload，不暴露 Node 能力。
  const { ipcMain } = require('electron')
  ipcMain.handle('ofm:minimize', () => mainWindow && mainWindow.minimize())
  ipcMain.handle('ofm:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('ofm:hide', () => mainWindow && mainWindow.hide())
  ipcMain.handle('ofm:is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()))
  // 拖拽由 CSS -webkit-app-region 承担，这里只保留调用入口。
  ipcMain.handle('ofm:start-drag', () => {})
  ipcMain.handle('ofm:error-retry', () => void retryStart())
  ipcMain.handle('ofm:error-quit', () => quit())
  app.whenReady().then(boot)
}

async function boot() {
  logEvent('boot: 桌面壳启动')
  app.setAppUserModelId('com.ourfreemodel.desktop')
  splashWindow = new BrowserWindow({
    width: 460, height: 320, center: true, resizable: false,
    frame: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // splash 只是启动动画：加载失败不阻塞服务启动与主窗口。
  await splashWindow.loadURL(pathToFileURL(asset('splash', 'splash.html')).toString())
    .then(() => splashWindow.show())
    .catch(() => {})

  // 托盘必须先建出来：启动失败时它是用户唯一的入口（重试 / 退出）。
  if (!tray || tray.isDestroyed()) {
    tray = new Tray(asset('assets', 'tray.png'))
    tray.setToolTip('Our Free Model')
    tray.on('click', () => panelAction())
  }
  updateTray()
  // 启动即重试：上一个实例可能还在退出（数据目录锁未释放），
  // 直接报错会让用户以为装坏了。给它最多 4 次机会再亮错误页。
  let result = await startService()
  adoptChild(result.child ?? null)
  if (result.error) logEvent(`boot: 第 1 次启动失败（${result.error}）`)
  let attempt = 0
  while (result.error && !quitting && attempt < START_ATTEMPTS - 1) {
    attempt++
    setErrorStatus(`服务暂不可用（${result.error}），${Math.round(START_BACKOFF_MS[attempt] / 1000)} 秒后重试 ${attempt + 1}/${START_ATTEMPTS}…`)
    await sleep(START_BACKOFF_MS[attempt])
    if (quitting) return
    if (failureWindow && !failureWindow.isDestroyed()) failureWindow.close()
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show()
    result = await startService()
    adoptChild(result.child ?? null)
  }
  if (quitting) return
  if (result.error) {
    logEvent(`boot: 重试 ${attempt} 次后仍失败，亮错误页（${result.error}）`)
    showFailure(result.error)
    return
  }
  logEvent(`boot: 服务握手成功（端口 ${new URL(result.address).port}）`)
  openMain(result.address)
}

function openMain(address) {
  serviceAddress = address
  const origin = new URL(address).origin
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 960, minHeight: 600, center: true,
    frame: false, show: false,
    title: 'Our Free Model',
    icon: asset('assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: asset('preload-titlebar.js'),
      // 只允许同源请求管理 API；外部链接一律交给系统浏览器。
      webSecurity: true,
    },
  })
  // 自定义标题栏只在本服务 origin 下可用。
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.executeJavaScript(titlebarScript(origin)).catch(() => {})
  })
  // 服务页之外的导航交给系统浏览器，本窗口不承载外部内容。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin)) return { action: 'allow' }
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return
    event.preventDefault()
    shell.openExternal(url).catch(() => {})
  })
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    mainWindow.show()
  })
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.loadURL(address).catch(error => {
    // 内嵌 WebView 打不开时（极少见的系统限制），退回系统浏览器，
    // 服务本身已经在跑，用户不会因此失去入口。
    const reason = String(error?.message ?? error)
    logEvent(`openMain: 管理页加载失败（${reason}），已改用系统浏览器`)
    console.error(`主窗口加载失败：${reason}`)
    showFailure(`${reason}\n\n已为你打开系统浏览器访问管理页面；服务仍在后台运行。`)
    shell.openExternal(address).catch(() => {})
  })
}

function showFailure(reason) {
  logEvent(`showFailure: ${reason}`)
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  // 主窗口加载失败那条路：旧窗口已经没内容了，直接销毁，别让它躲进托盘。
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow !== failureWindow) {
    const stale = mainWindow
    stale.removeAllListeners('close')
    stale.destroy()
    mainWindow = null
  }
  if (failureWindow && !failureWindow.isDestroyed()) failureWindow.close()
  failureWindow = new BrowserWindow({
    width: 620, height: 340, center: true, resizable: false, frame: false,
    title: 'Our Free Model — 启动失败',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: asset('preload-titlebar.js'),
    },
  })
  mainWindow = failureWindow
  failureWindow.setMenu(null)
  failureWindow.loadURL(pathToFileURL(asset('splash', 'error.html')).toString())
    .then(() => failureWindow.webContents.executeJavaScript(
      `document.getElementById('reason').textContent = ${JSON.stringify(reason)};`,
    ))
    .catch(() => {})
  failureWindow.on('closed', () => {
    failureWindow = null
    if (mainWindow === failureWindow) mainWindow = null
  })
  failureWindow.show()
  updateTray()
}

/** 记录服务子进程（含已退出的判活），同时刷新托盘。 */
function adoptChild(child) {
  serviceChild = child && child.exitCode === null && !child.killed ? child : null
  updateTray()
}

/** 错误页上的状态行（重试进度）。 */
function setErrorStatus(text) {
  if (!failureWindow || failureWindow.isDestroyed()) return
  failureWindow.webContents.executeJavaScript(
    `window.ofmErrorStatus && window.ofmErrorStatus(${JSON.stringify(text)}, true)`,
  ).catch(() => {})
}

/** 托盘左键 / 菜单共用的「打开面板」动作。 */
function panelAction() {
  if (mainWindow && !mainWindow.isDestroyed()) showExisting()
  else if (serviceChild && serviceAddress) openMain(serviceAddress)
  else if (!starting) void retryStart()
}

/** 托盘菜单随服务状态切换：服务没起来时给「重试启动」而不是打不开的面板。 */
function updateTray() {
  if (!tray || tray.isDestroyed()) return
  const alive = Boolean(serviceChild && !serviceChild.killed)
  tray.setContextMenu(Menu.buildFromTemplate([
    alive ? { label: '打开面板', click: () => panelAction() } : { label: '重试启动', click: () => void retryStart() },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ]))
}

/** 从托盘或错误页重试：复用 boot 的重试逻辑。 */
async function retryStart() {
  if (starting) return
  starting = true
  logEvent('retryStart: 用户请求重试')
  updateTray()
  try {
    if (failureWindow && !failureWindow.isDestroyed()) {
      setErrorStatus('正在重新启动服务…')
    } else if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show()
    }
    // 上一次可能服务活着、只是窗口加载失败：先收掉再重启，避免撞端口。
    if (serviceChild && !serviceChild.killed) {
      const stale = serviceChild
      serviceChild = null // 先摘掉引用，退出处理逻辑才不会误亮错误页
      try { stale.kill() } catch {}
      await new Promise(resolve => {
        const done = () => resolve()
        stale.once('exit', done)
        setTimeout(done, 3000)
      })
      updateTray()
    }
    let result = await startService()
    adoptChild(result.child ?? null)
    let attempt = 0
    while (result.error && !quitting && attempt < START_ATTEMPTS - 1) {
      attempt++
      setErrorStatus(`服务暂不可用（${result.error}），${Math.round(START_BACKOFF_MS[attempt] / 1000)} 秒后重试 ${attempt + 1}/${START_ATTEMPTS}…`)
      await sleep(START_BACKOFF_MS[attempt])
      if (quitting) return
      result = await startService()
      adoptChild(result.child ?? null)
    }
    if (quitting) return
    if (result.error) {
      if (failureWindow && !failureWindow.isDestroyed()) setErrorStatus('')
      showFailure(result.error)
      return
    }
    if (failureWindow && !failureWindow.isDestroyed()) failureWindow.close()
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
    logEvent('retryStart: 服务已恢复，打开面板')
    openMain(result.address)
  } finally {
    starting = false
    updateTray()
  }
}

function showExisting() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quit() {
  logEvent('quit: 收到退出请求')
  quitting = true
  if (serviceChild && !serviceChild.killed) {
    const child = serviceChild
    serviceChild = null
    try { child.kill() } catch {}
  }
  app.exit(0)
}

app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { /* 托盘常驻：不因窗口关闭而退出 */ })
app.on('activate', () => showExisting())
