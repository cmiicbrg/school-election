import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { matchesEtag, normalizePicture, PICTURE_BODY_LIMIT, PICTURE_MAX_UPLOAD_BYTES } from '../lib/pictures.ts'
import { DB } from './helpers/db.ts'
import { ANNA, auditActions, BERND, createElection, electionApp, electionPath, forceElectionState, signIn, WANDA, type Browser } from './helpers/elections.ts'

/** A photo as a phone stores it: landscape pixels, a red band along the top edge, Exif orientation 6 (to be turned clockwise), GPS and an ICC profile. */
async function phonePhoto(width = 1600, height = 1200): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[(y * width + x) * 3 + (y < height / 5 ? 0 : 2)] = 255
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: 'Phone', Software: 'Camera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 12/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .toBuffer()
}

/** The chunk names of a WebP file. */
function webpChunks(data: Buffer): string[] {
  assert.equal(data.subarray(0, 4).toString('latin1'), 'RIFF')
  assert.equal(data.subarray(8, 12).toString('latin1'), 'WEBP')
  const chunks: string[] = []
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4)
    chunks.push(data.subarray(offset, offset + 4).toString('latin1'))
    offset += 8 + size + (size % 2)
  }
  return chunks
}

test('a picture is stored upright, within 480 × 480, as WebP, with nothing but its pixels', async () => {
  const photo = await phonePhoto()
  const input = await sharp(photo).metadata()
  assert.deepEqual([input.orientation, input.exif !== undefined, input.icc !== undefined], [6, true, true])

  const result = await normalizePicture(photo)
  assert.ok(result.ok)
  const { data, sha256, width, height } = result.picture
  assert.deepEqual([width, height], [360, 480])
  assert.deepEqual(webpChunks(data), ['VP8 '])
  const output = await sharp(data).metadata()
  assert.deepEqual([output.format, output.width, output.height, output.exif, output.icc, output.xmp, output.orientation], ['webp', 360, 480, undefined, undefined, undefined, undefined])
  assert.equal(sha256, createHash('sha256').update(data).digest('hex'))
  // The red band that ran along the top of the stored pixels is on the right now.
  const pixels = await sharp(data).raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => [...pixels.data.subarray((y * pixels.info.width + x) * 3, (y * pixels.info.width + x) * 3 + 3)]
  assert.ok((at(355, 240)[0] ?? 0) > 200 && (at(355, 240)[2] ?? 255) < 60, `right edge ${at(355, 240).join(',')}`)
  assert.ok((at(5, 240)[2] ?? 0) > 200 && (at(5, 240)[0] ?? 255) < 60, `left edge ${at(5, 240).join(',')}`)
})

test('PNG and WebP are accepted, and a small picture is not enlarged', async () => {
  const png = await sharp({ create: { width: 120, height: 90, channels: 4, background: { r: 0, g: 128, b: 0, alpha: 0.5 } } }).png().toBuffer()
  const webp = await sharp({ create: { width: 900, height: 300, channels: 3, background: '#336699' } }).webp().toBuffer()
  const results = await Promise.all([normalizePicture(png), normalizePicture(webp)])
  assert.deepEqual(results.map((r) => r.ok && [r.picture.width, r.picture.height]), [[120, 90], [480, 160]])
})

test('anything but a decodable JPEG, PNG or WebP within the limits is refused', async () => {
  const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).jpeg().toBuffer()
  // Few bytes, many pixels: 5000 × 5000 of one colour.
  const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer()
  assert.ok(huge.length < PICTURE_MAX_UPLOAD_BYTES)
  const cases: [string, Uint8Array, string][] = [
    ['random bytes', Buffer.from('not a picture at all'), 'picture_format'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/></svg>'), 'picture_format'],
    ['GIF', await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).gif().toBuffer(), 'picture_format'],
    ['a truncated JPEG', jpeg.subarray(0, jpeg.length - 40), 'picture_unreadable'],
    ['a JPEG header and nothing else', jpeg.subarray(0, 20), 'picture_unreadable'],
    ['too many pixels', huge, 'picture_too_large'],
    ['too many bytes', Buffer.concat([jpeg, Buffer.alloc(PICTURE_MAX_UPLOAD_BYTES)]), 'picture_too_large'],
  ]
  for (const [label, bytes, refusal] of cases) {
    assert.deepEqual(await normalizePicture(bytes), { ok: false, refusal }, label)
  }
})

test('If-None-Match matches the picture\'s tag, weak or strong, in a list, or *', () => {
  const hash = 'ab'.repeat(32)
  for (const header of [`"${hash}"`, `W/"${hash}"`, `"other", "${hash}"`, '*']) assert.equal(matchesEtag(header, hash), true, header)
  for (const header of [undefined, '', `"${'cd'.repeat(32)}"`, hash]) assert.equal(matchesEtag(header, hash), false, String(header))
})

interface Contest { id: string, candidates: { id: string, surname: string, picture: string | null }[] }

const upload = (browser: Browser, electionId: string, candidateId: string, data: Buffer | string) =>
  browser.request('PUT', `/api/elections/${electionId}/candidates/${candidateId}/picture`, { data: typeof data === 'string' ? data : data.toString('base64') })

test('pictures are uploaded as base64 JSON, served to members under their hash, and cached for good only there', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const bernd = await signIn(s, BERND)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const contest = (await anna.request('POST', `${base}/contests`, { title: 'Schulsprecher/in', rulesetId: 'at-school-speaker-v1' })).json<{ id: string }>()
  const added = (await anna.request('POST', `${base}/contests/${contest.id}/candidates`, { surname: 'Huber', givenName: 'Lena' })).json<Contest>()
  const candidateId = added.candidates[0]?.id ?? assert.fail('no candidate')
  await anna.request('POST', `${base}/members`, { email: WANDA.email, role: 'witness' })
  const wanda = await signIn(s, WANDA)

  const first = await upload(anna, id, candidateId, await phonePhoto())
  assert.equal(first.statusCode, 200, first.body)
  const url = first.json<Contest>().candidates[0]?.picture ?? assert.fail('no picture URL')
  const hash = url.split('/').at(-1) ?? ''
  assert.match(url, new RegExp(`^${base}/candidates/${candidateId}/picture/[0-9a-f]{64}$`))

  for (const browser of [anna, wanda]) {
    const res = await browser.request('GET', url)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'image/webp')
    assert.equal(res.headers.etag, `"${hash}"`)
    assert.equal(res.headers['cache-control'], 'private, max-age=31536000, immutable')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(createHash('sha256').update(res.rawPayload).digest('hex'), hash)
    assert.deepEqual((await sharp(res.rawPayload).metadata()).exif, undefined)
  }
  const head = await anna.request('HEAD', url)
  assert.deepEqual([head.statusCode, head.headers['cache-control'], head.headers.etag], [200, 'private, max-age=31536000, immutable', `"${hash}"`])
  for (const tag of [`"${hash}"`, `W/"${hash}"`]) {
    const revalidated = await anna.request('GET', url, undefined, { 'if-none-match': tag })
    assert.deepEqual([revalidated.statusCode, revalidated.body, revalidated.headers.etag, revalidated.headers['cache-control']], [304, '', `"${hash}"`, 'private, max-age=31536000, immutable'])
  }

  // Refusals are never cached: not for an outsider, a hash that is not the
  // picture's, or anyone without a session, revalidating or not.
  const refusals = [
    await bernd.request('GET', url),
    await bernd.request('GET', url, undefined, { 'if-none-match': `"${hash}"` }),
    await anna.request('GET', `${base}/candidates/${candidateId}/picture/${'0'.repeat(64)}`),
    await anna.request('GET', `${base}/candidates/${candidateId}/picture/${hash.toUpperCase()}`),
    await s.app.inject({ method: 'GET', url }),
  ]
  assert.deepEqual(refusals.map((res) => [res.statusCode, res.headers['cache-control']]), [[404, 'no-store'], [404, 'no-store'], [404, 'no-store'], [400, 'no-store'], [401, 'no-store']])

  // A new picture gets a new URL, and the old one is gone; the same picture again changes nothing.
  const second = await upload(anna, id, candidateId, await sharp({ create: { width: 300, height: 400, channels: 3, background: '#0a0' } }).png().toBuffer())
  const newUrl = second.json<Contest>().candidates[0]?.picture
  assert.ok(newUrl && newUrl !== url)
  assert.equal((await anna.request('GET', url)).statusCode, 404)
  assert.equal((await anna.request('GET', newUrl)).statusCode, 200)
  const events = await auditActions(anna, id)
  const again = await upload(anna, id, candidateId, await sharp({ create: { width: 300, height: 400, channels: 3, background: '#0a0' } }).png().toBuffer())
  assert.equal(again.json<Contest>().candidates[0]?.picture, newUrl)
  assert.deepEqual(await auditActions(anna, id), events)

  const removed = await anna.request('DELETE', `${base}/candidates/${candidateId}/picture`)
  assert.equal(removed.json<Contest>().candidates[0]?.picture, null)
  assert.equal((await anna.request('GET', newUrl)).statusCode, 404)
  assert.deepEqual((await auditActions(anna, id)).filter((a) => a.startsWith('candidate.picture')), ['candidate.picture-set', 'candidate.picture-set', 'candidate.picture-removed'])
})

test('an upload is bounded, must be a picture, needs the configure permission and stops when voting starts', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const base = `/api/elections/${id}`
  const contest = (await anna.request('POST', `${base}/contests`, { title: 'Abstimmung', rulesetId: 'single-choice-v1' })).json<{ id: string }>()
  const candidateId = (await anna.request('POST', `${base}/contests/${contest.id}/candidates`, { surname: 'Ja', givenName: '' })).json<Contest>().candidates[0]?.id ?? ''
  await anna.request('POST', `${base}/members`, { email: WANDA.email, role: 'witness' })
  const wanda = await signIn(s, WANDA)
  const photo = await phonePhoto(200, 150)
  const before = await auditActions(anna, id)

  const refusals: [string, Promise<{ statusCode: number, json: () => { error: string } }>, number, string][] = [
    ['a body over the route\'s limit', upload(anna, id, candidateId, 'A'.repeat(PICTURE_BODY_LIMIT)), 413, 'FST_ERR_CTP_BODY_TOO_LARGE'],
    ['more than the largest upload', upload(anna, id, candidateId, 'A'.repeat(Math.ceil(PICTURE_MAX_UPLOAD_BYTES / 3) * 4 + 4)), 400, 'FST_ERR_VALIDATION'],
    ['not base64', upload(anna, id, candidateId, 'not base64!'), 400, 'FST_ERR_VALIDATION'],
    ['not a picture', upload(anna, id, candidateId, Buffer.from('%PDF-1.7 ...')), 422, 'picture_format'],
    ['a broken picture', upload(anna, id, candidateId, photo.subarray(0, 200)), 422, 'picture_unreadable'],
    ['a witness', upload(wanda, id, candidateId, photo), 403, 'forbidden'],
    ['an unknown candidate', upload(anna, id, '0d3b5a0e-6a43-4c1b-9f5e-3d2c1b0a9f8e', photo), 404, 'not_found'],
  ]
  for (const [label, response, status, error] of refusals) {
    const res = await response
    assert.deepEqual([res.statusCode, res.json().error], [status, error], label)
  }
  // Every other route keeps the API's 64 KiB limit.
  const big = await anna.request('PATCH', base, { description: 'x'.repeat(70 * 1024) })
  assert.equal(big.statusCode, 413)
  assert.deepEqual(await auditActions(anna, id), before)

  assert.equal((await upload(anna, id, candidateId, photo)).statusCode, 200)
  await forceElectionState(s.ownerUrl, id, 'active')
  assert.equal((await upload(anna, id, candidateId, photo)).json<{ error: string }>().error, 'voting_started')
  assert.equal((await anna.request('DELETE', `${base}/candidates/${candidateId}/picture`)).json<{ error: string }>().error, 'voting_started')
})

test('every API answer but a picture\'s 200 or 304 is no-store', DB, async (t) => {
  const s = await electionApp(t)
  const anna = await signIn(s, ANNA)
  const id = await createElection(anna)
  const routes = s.routes.filter((route) => route.url.startsWith('/api/'))
  assert.deepEqual(routes.filter((route) => route.config?.contentAddressed).map((route) => `${String(route.method)} ${route.url}`), [
    'GET /api/voter/picture/:sha256',
    'HEAD /api/voter/picture/:sha256',
    'GET /api/elections/:id/candidates/:candidateId/picture/:sha256',
    'HEAD /api/elections/:id/candidates/:candidateId/picture/:sha256',
  ])
  for (const route of routes) {
    const method = route.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    const res = await anna.request(method, electionPath(route.url, id), ['GET', 'HEAD', 'DELETE'].includes(method) ? undefined : {})
    assert.equal(res.headers['cache-control'], 'no-store', `${method} ${route.url}: ${res.statusCode}`)
  }
})

test('nginx lets a picture upload through, and every other body only as far as the app does', () => {
  const conf = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/nginx.example.conf'), 'utf8')
  const block = /location ~ \^\/api\/elections\/\[\^\/\]\+\/candidates\/\[\^\/\]\+\/picture\$ \{\s*client_max_body_size (\d+)k;\s*client_body_buffer_size (\d+)k;/.exec(conf)
  assert.ok(block, 'the picture location')
  assert.deepEqual([Number(block[1]) * 1024, Number(block[2]) * 1024], [PICTURE_BODY_LIMIT, PICTURE_BODY_LIMIT])
  assert.ok(PICTURE_BODY_LIMIT >= Math.ceil(PICTURE_MAX_UPLOAD_BYTES / 3) * 4 + '{"data":""}'.length)
  assert.match(conf, /^ {4}client_max_body_size 64k;$/m)
})
