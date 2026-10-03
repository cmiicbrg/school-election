import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filesOf,
  fitInside,
  isImageFile,
  pickFile,
  PICTURE_MAX_DIMENSION,
  PICTURE_MESSAGES,
  PICTURE_QUALITIES,
  toBase64,
  uploadMessage,
} from '../src/lib/picture-rules.ts'

test('a picture is scaled to fit 480 × 480, keeping its aspect ratio, and never enlarged', () => {
  assert.equal(PICTURE_MAX_DIMENSION, 480)
  const cases: [number, number, number, number][] = [
    [4032, 3024, 480, 360], // phone photo, landscape
    [3024, 4032, 360, 480], // phone photo, portrait (after turning it upright)
    [6000, 4000, 480, 320],
    [480, 480, 480, 480],
    [800, 100, 480, 60],
    [10000, 7, 480, 1], // no side shrinks to nothing
    [320, 200, 320, 200], // small pictures stay as they are
    [1, 1, 1, 1],
  ]
  for (const [width, height, w, h] of cases) {
    assert.deepEqual(fitInside({ width, height }), { width: w, height: h }, `${width} × ${height}`)
  }
  for (const [width, height] of [[0, 10], [10, -1], [Number.NaN, 10], [Infinity, 10]]) {
    assert.throws(() => fitInside({ width: width ?? 0, height: height ?? 0 }), RangeError)
  }
})

test('qualities start high and only go down', () => {
  assert.equal(PICTURE_QUALITIES[0], 0.82)
  assert.ok(PICTURE_QUALITIES.every((quality, i) => quality > 0 && quality <= 1 && (i === 0 || quality < (PICTURE_QUALITIES[i - 1] ?? 1))))
})

const file = (name: string, type: string) => ({ name, type })

test('a file is a picture by its type, or by its name when the system gave it no type', () => {
  for (const f of [file('a.jpg', 'image/jpeg'), file('IMG_0001.HEIC', ''), file('scan', 'image/png'), file('foto.jfif', ''), file('x.heif', 'image/heif')]) {
    assert.equal(isImageFile(f), true, f.name)
  }
  for (const f of [file('lebenslauf.pdf', 'application/pdf'), file('notes.txt', ''), file('a.jpg', 'text/plain'), file('heic', '')]) {
    assert.equal(isImageFile(f), false, f.name)
  }
})

test('the first picture of a drop or paste is taken; without a picture the first file, to be refused', () => {
  const pdf = file('a.pdf', 'application/pdf')
  const jpg = file('b.jpg', 'image/jpeg')
  const png = file('c.png', 'image/png')
  assert.deepEqual(pickFile([pdf, jpg, png]), { kind: 'file', file: jpg, others: 2 })
  assert.deepEqual(pickFile([png]), { kind: 'file', file: png, others: 0 })
  assert.deepEqual(pickFile([pdf]), { kind: 'file', file: pdf, others: 0 })
  assert.deepEqual(pickFile([]), { kind: 'none' })
})

test('files come from the items of a drop or paste, else from its file list', () => {
  const jpg = file('b.jpg', 'image/jpeg')
  const item = (kind: string, value: typeof jpg | null) => ({ kind, getAsFile: () => value })
  // A picture copied in a browser: the file, and its HTML as a string item.
  assert.deepEqual(filesOf({ items: [item('string', null), item('file', jpg)] }), [jpg])
  // Items that turn out to hold nothing fall back to the list.
  assert.deepEqual(filesOf({ items: [item('file', null)], files: [jpg] }), [jpg])
  assert.deepEqual(filesOf({ files: [jpg] }), [jpg])
  // A link dragged from another page carries no file.
  assert.deepEqual(filesOf({ items: [item('string', null)], files: [] }), [])
  assert.deepEqual(filesOf(null), [])
})

test('messages are German and say what to do, including for a format the browser cannot open', () => {
  assert.equal(PICTURE_MESSAGES['unsupported-format'], 'Dieses Bildformat kann der Browser nicht öffnen. Bitte ein JPEG- oder PNG-Foto verwenden.')
  for (const message of Object.values(PICTURE_MESSAGES)) assert.match(message, /Bitte/)
  assert.equal(uploadMessage('picture_unreadable'), 'Dieses Bild konnte nicht gelesen werden. Bitte ein JPEG- oder PNG-Foto verwenden.')
  assert.equal(uploadMessage('FST_ERR_CTP_BODY_TOO_LARGE'), PICTURE_MESSAGES['too-large'])
  assert.match(uploadMessage('voting_started'), /begonnen/)
  assert.match(uploadMessage('internal_error'), /nicht gespeichert/)
})

test('base64 is what the server decodes, also for pictures larger than one slice', () => {
  for (const length of [0, 1, 2, 3, 0x8000, 0x8000 * 3 + 5]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 7 + 3) % 256)
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'), String(length))
  }
})
