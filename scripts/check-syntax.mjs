/** Syntax-check every source file without any third-party tooling. */
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const targets = [
  path.join(root, 'client.js'),
  path.join(root, 'bench', 'run.mjs'),
  path.join(root, 'scripts', 'build-release.mjs'),
  path.join(root, 'scripts', 'demo.mjs'),
]
for (const entry of await fsp.readdir(path.join(root, 'src'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) targets.push(path.join(root, 'src', entry.name))
}
for (const entry of await fsp.readdir(path.join(root, 'test'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) targets.push(path.join(root, 'test', entry.name))
}
let failed = 0
for (const file of targets.sort()) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    console.log(`ok   ${path.relative(root, file)}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${path.relative(root, file)}`)
    console.error(String(error.stderr ?? error.message))
  }
}
console.log(`\n${targets.length - failed}/${targets.length} files passed`)
process.exitCode = failed > 0 ? 1 : 0
