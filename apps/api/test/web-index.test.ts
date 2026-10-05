import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BASE_PATH_META, loadWebIndex, withBasePath } from '../lib/web-index.ts'

/** index.html as Vite writes it with a relative base: the tag, and assets relative to the page. */
const BUILT = `<!doctype html><html><head>${BASE_PATH_META}<script type="module" crossorigin src="./assets/index-a.js"></script><link rel="stylesheet" crossorigin href="./assets/index-b.css"></head><body><div id="app"></div></body></html>`

test('the page is told its base path, and its asset references are made absolute under it', () => {
  const root = withBasePath(BUILT, '')
  assert.match(root, /<meta name="base-path" content="\/">/)
  assert.ok(root.includes('src="/assets/index-a.js"') && root.includes('href="/assets/index-b.css"'))
  const under = withBasePath(BUILT, '/wahl')
  assert.match(under, /<meta name="base-path" content="\/wahl\/">/)
  assert.ok(under.includes('src="/wahl/assets/index-a.js"') && under.includes('href="/wahl/assets/index-b.css"'))
  assert.ok(!under.includes('./assets/'))
})

test('a page without the tag or relative references is left as it is', () => {
  const absolute = '<title>x</title><script src="/assets/a.js"></script>'
  assert.equal(withBasePath(absolute, '/wahl'), absolute)
})

test('the page is read from the build directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'school-election-web-'))
  writeFileSync(path.join(dir, 'index.html'), BUILT)
  assert.match(await loadWebIndex(dir, '/wahl'), /content="\/wahl\/"/)
})
