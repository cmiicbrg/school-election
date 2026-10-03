// Reads the QR code of a printed card, which the page draws as a PNG data
// URL, so the journey can compare what a scanner would get with what the
// API stores.

import jsqr from 'jsqr'
import { PNG } from 'pngjs'

type Decode = typeof jsqr.default

// jsqr is a CommonJS module whose export is the function itself. Node
// hands that to an ES module as the default import; TypeScript (NodeNext)
// types the import as the module's namespace, so the function is taken
// from either shape.
const decode: Decode = ((jsqr as unknown as { default?: Decode }).default ?? jsqr) as Decode

export function decodeQr(dataUrl: string): string {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  const png = PNG.sync.read(Buffer.from(base64, 'base64'))
  const pixels = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
  const code = decode(pixels, png.width, png.height)
  if (!code) throw new Error('no QR code in the image')
  return code.data
}
