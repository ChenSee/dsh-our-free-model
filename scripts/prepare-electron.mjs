import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const tauri = path.join(repositoryRoot, 'packages/desktop')
const electronDir = path.join(repositoryRoot, 'packages/desktop-electron')
const assets = path.join(electronDir, 'assets')
const splash = path.join(electronDir, 'splash')

fs.mkdirSync(assets, { recursive: true })
fs.mkdirSync(splash, { recursive: true })
// 界面资源与 Tauri 版共用一份源，避免两处维护出现行为分叉。
fs.copyFileSync(path.join(tauri, 'ui/titlebar.css'), path.join(assets, 'titlebar.css'))
fs.copyFileSync(path.join(tauri, 'ui/titlebar.js'), path.join(assets, 'titlebar.js'))
for (const name of ['splash.html', 'error.html']) {
  fs.copyFileSync(path.join(tauri, 'splash', name), path.join(splash, name))
}
const ico = path.join(tauri, 'src-tauri/icons/icon.ico')
if (fs.existsSync(ico)) fs.copyFileSync(ico, path.join(assets, 'icon.ico'))
else console.warn('未找到 icon.ico，安装包将使用默认图标')
/** 图标由 packages/desktop-electron/build-icons.mjs 生成（sharp 装在该包内）。 */
for (const name of ['icon.png', 'tray.png']) {
  if (!fs.existsSync(path.join(assets, name))) {
    throw new Error(`缺少 ${name}，请先在 packages/desktop-electron 运行 node build-icons.mjs`)
  }
}
console.log('Electron 桌面壳资源已同步')
