/**
 * Rasterises preview/index.html with the local Edge in headless mode, so the
 * widget can be inspected without touching the running GUI.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(root, 'preview/index.html')
const OUT = path.join(root, 'preview/gauge.png')
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

if (!fs.existsSync(EDGE)) {
  console.error('Edge not found; open preview/index.html in a browser instead.')
  process.exit(1)
}

const profile = path.join(process.env.TEMP ?? '.', 'dsh-balance-gauge-edge')
fs.rmSync(OUT, { force: true })

execFileSync(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=1200,1250',
    `--user-data-dir=${profile}`,
    `--screenshot=${OUT}`,
    `file:///${PAGE.replace(/\\/g, '/')}`,
  ],
  { stdio: 'inherit', timeout: 120000 },
)

console.log(fs.existsSync(OUT) ? `wrote ${OUT}` : 'screenshot failed')
