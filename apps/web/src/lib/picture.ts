// Prepares a candidate picture in the browser (the decisions are in
// picture-rules.ts): decode the file upright, scale it with pica to fit
// 480 × 480, put it on white (a transparent PNG would otherwise turn black
// in a JPEG), and encode it as WebP, or as JPEG where the browser cannot
// encode WebP, lowering the quality until it fits the upload limit.
//
// pica runs its split build: the worker is a file of the app, so the
// Content-Security-Policy, which allows scripts and workers from the app's
// own origin only, lets it start. WebAssembly is not used, because the
// policy does not allow compiling it.

import createPica from 'pica/pica_main'
import picaWorkerUrl from 'pica/pica_worker?url'
import { fitInside, isImageFile, PICTURE_MAX_UPLOAD_BYTES, PICTURE_QUALITIES, type PictureProblem } from './picture-rules.ts'

export interface PreparedPicture {
  bytes: Uint8Array
  type: 'image/webp' | 'image/jpeg'
  width: number
  height: number
  /** A data: URL of the picture, for a preview: the policy allows data: images, not blob: ones. */
  preview: string
}

/** A picture that cannot be used, and why. */
export class PictureError extends Error {
  override name = 'PictureError'
  readonly problem: PictureProblem

  constructor(problem: PictureProblem) {
    super(problem)
    this.problem = problem
  }
}

let resizer: ReturnType<typeof createPica> | undefined

function pica(): ReturnType<typeof createPica> {
  resizer ??= createPica({ features: ['js', 'ww'], workerURL: picaWorkerUrl })
  return resizer
}

interface Decoded {
  image: ImageBitmap | HTMLImageElement
  width: number
  height: number
  close: () => void
}

/** Turns any photo the browser can open into the picture the API takes; throws PictureError. */
export async function preparePicture(file: File): Promise<PreparedPicture> {
  if (!isImageFile(file)) throw new PictureError('not-an-image')
  const source = await decode(file)
  try {
    const size = fitInside(source)
    const scaled = canvas(size.width, size.height)
    await pica().resize(source.image, scaled, { filter: 'mks2013' })
    const flat = canvas(size.width, size.height)
    const context = flat.getContext('2d')
    if (!context) throw new PictureError('failed')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, size.width, size.height)
    context.drawImage(scaled, 0, 0)
    for (const quality of PICTURE_QUALITIES) {
      const blob = await encode(flat, quality)
      if (blob.size <= PICTURE_MAX_UPLOAD_BYTES) {
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          type: blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
          ...size,
          preview: await dataUrl(blob),
        }
      }
    }
    throw new PictureError('too-large')
  } finally {
    source.close()
  }
}

/**
 * The picture, upright: createImageBitmap turns it by its Exif orientation
 * as asked. A browser that does not know that option, or cannot decode the
 * file that way, gets a second try with an <img>, which applies the
 * orientation by default. A file neither can open is a format the browser
 * does not support, such as HEIC outside Safari.
 */
async function decode(file: File): Promise<Decoded> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  } catch {
    const image = new Image()
    image.decoding = 'async'
    image.src = await dataUrl(file)
    try {
      await image.decode()
    } catch {
      throw new PictureError('unsupported-format')
    }
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => image.removeAttribute('src') }
  }
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas')
  element.width = width
  element.height = height
  return element
}

// Whether this browser encodes WebP; learnt from the first picture.
let webp: boolean | undefined

async function encode(source: HTMLCanvasElement, quality: number): Promise<Blob> {
  if (webp !== false) {
    const blob = await toBlob(source, 'image/webp', quality)
    // A browser without a WebP encoder hands back a PNG instead.
    webp = blob.type === 'image/webp'
    if (webp) return blob
  }
  return toBlob(source, 'image/jpeg', quality)
}

function toBlob(source: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    source.toBlob((blob) => (blob ? resolve(blob) : reject(new PictureError('failed'))), type, quality)
  })
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new PictureError('failed')))
    reader.onerror = () => reject(new PictureError('failed'))
    reader.readAsDataURL(blob)
  })
}
