import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('release build rewrites the package, bundle row, and client id', async (t) => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-release-'))
  t.after(() => fsp.rm(out, { recursive: true, force: true }))
  execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'build-release.mjs'), '--name', 'dsh-swarm-bundle', '--out', out],
    { cwd: root, stdio: 'pipe' },
  )
  const pkg = JSON.parse(await fsp.readFile(path.join(out, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-swarm-bundle')
  assert.equal(pkg.version, '0.1.0')
  const patch = await fsp.readFile(path.join(out, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name:\s*'dsh-swarm-bundle'/)
  const client = await fsp.readFile(path.join(out, 'client.js'), 'utf8')
  assert.match(client, /id:\s*'dsh-swarm-bundle'/)
  assert.equal(await fsp.readFile(path.join(out, 'RELEASE.md'), 'utf8').then((text) => text.includes('dsh-swarm-bundle@0.1.0')), true)
  assert.equal(await fsp.readFile(path.join(out, 'src', 'index.js'), 'utf8').then((text) => text.length > 100), true)
})
