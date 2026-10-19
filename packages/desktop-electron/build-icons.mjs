/** 从 assets/icon.svg 生成桌面端所需的全部 PNG 尺寸。 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = path.join(here, 'assets', 'icon.svg')
if (!fs.existsSync(source)) throw new Error(`缺少图标源文件：${source}`)

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
for (const size of sizes) {
  await sharp(source, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(here, 'assets', `icon-${size}.png`))
}
// electron-builder 的 icon 源需要至少 256x256。
fs.copyFileSync(path.join(here, 'assets', 'icon-256.png'), path.join(here, 'assets', 'icon.png'))
// 托盘用小图。
fs.copyFileSync(path.join(here, 'assets', 'icon-32.png'), path.join(here, 'assets', 'tray.png'))
console.log(`图标已生成：${sizes.join(', ')} px`)
