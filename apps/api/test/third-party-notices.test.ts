// The image carries a notice for libvips, the one library under a
// copyleft license, and for the two fonts of the printable sheets, under
// the Open Font License (third-party-notices/README.md). It has to name
// what is actually installed, so an update of sharp or of a font package
// fails here until the notice follows it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const NOTICES = path.join(ROOT, 'third-party-notices')
const notice = readFileSync(path.join(NOTICES, 'README.md'), 'utf8')

// sharp.versions names the libraries by their short names; the notice by the names their projects use.
const NAMES: Record<string, string> = {
  archive: 'libarchive', exif: 'libexif', ffi: 'libffi', heif: 'libheif', imagequant: 'libimagequant', png: 'libpng',
  rsvg: 'librsvg', tiff: 'libtiff', uhdr: 'libultrahdr', vips: 'libvips', webp: 'libwebp', xml2: 'libxml2',
}

test('the notice names the libvips package and every library in it at the installed versions', () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
  const libvipsPackage = lock.packages['node_modules/@img/sharp-libvips-linux-x64']?.version
  assert.ok(libvipsPackage)
  assert.ok(notice.includes(`\`@img/sharp-libvips-linux-x64\` ${libvipsPackage}`))
  assert.ok(notice.includes(`https://github.com/lovell/sharp-libvips/tree/v${libvipsPackage}`))

  const { sharp: _sharp, ...libraries } = sharp.versions as Record<string, string>
  const vips = libraries.vips
  assert.ok(vips)
  assert.ok(notice.includes(`lib/libvips-cpp.so.${vips}\``))
  assert.ok(notice.includes(`https://github.com/libvips/libvips/tree/v${vips}`))
  // The table's rows, without its header.
  const rows = new Map([...notice.matchAll(/^\| ([\w-]+) \| ([\w.]+) \| .+ \|$/gm)]
    .map((match): [string, string] => [match[1] ?? '', match[2] ?? ''])
    .filter(([name]) => name !== 'Library'))
  assert.deepEqual(
    Object.fromEntries([...rows].toSorted()),
    Object.fromEntries(Object.entries(libraries).map(([name, version]) => [NAMES[name] ?? name, version]).toSorted()),
  )
})

test('the license texts the notice refers to are there, and the image carries them', () => {
  for (const [, file = ''] of notice.matchAll(/\]\(([\w.-]+\.txt)\)/g)) {
    assert.ok(existsSync(path.join(NOTICES, file)), file)
  }
  assert.match(readFileSync(path.join(NOTICES, 'LGPL-3.0.txt'), 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  assert.match(readFileSync(path.join(NOTICES, 'GPL-3.0.txt'), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
  assert.match(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'), /^COPY third-party-notices third-party-notices$/m)
})

test('the notice names the font packages at their installed versions, and each font\'s license text is the OFL', () => {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
  for (const [pkg, file] of [['dm-sans', 'OFL-1.1-DM-Sans.txt'], ['jetbrains-mono', 'OFL-1.1-JetBrains-Mono.txt']] as const) {
    const version = lock.packages[`node_modules/@fontsource/${pkg}`]?.version
    assert.ok(version, pkg)
    assert.ok(notice.includes(`\`@fontsource/${pkg}\` ${version}`), `${pkg} ${version}`)
    assert.match(readFileSync(path.join(NOTICES, file), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/)
  }
})
