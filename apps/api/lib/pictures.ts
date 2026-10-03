// Candidate pictures. The browser prepares a picture before it is sent
// (apps/web/src/lib/picture.ts): upright, at most 480 px on its longer
// side, as WebP, or as JPEG where the browser cannot encode WebP. The server
// does not rely on that. It decodes what arrives with sharp (libvips),
// turns it upright by its EXIF orientation, scales it into 480 × 480 if it
// is larger, and encodes it as WebP, which is what is stored and served.
// Re-encoding keeps nothing but the pixels: no EXIF (with GPS), XMP, IPTC,
// ICC profile or comment survives it.
//
// Only JPEG, PNG and WebP are accepted, recognised by their first bytes
// before libvips sees them, so none of its other loaders (SVG, PDF, TIFF,
// HEIF and more) ever runs on an upload. The upload, the number of pixels
// it decodes to and the stored picture are bounded.

import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** The longer side of a stored picture, at most. */
export const PICTURE_MAX_DIMENSION = 480
/** The largest upload, decoded. The browser's pictures are a fraction of it. */
export const PICTURE_MAX_UPLOAD_BYTES = 256 * 1024
/**
 * The body limit of the upload route: the base64 text of the largest
 * upload and the JSON around it, in whole KiB, as nginx's
 * client_max_body_size for that route (deploy/nginx.example.conf).
 */
export const PICTURE_BODY_LIMIT = 352 * 1024
/** The largest stored picture; the database checks the same bound. */
export const PICTURE_MAX_STORED_BYTES = 128 * 1024
/** Width × height an upload may decode to, at most: a 16-megapixel photo. */
const MAX_INPUT_PIXELS = 4096 * 4096
/** WebP qualities to try, until the picture fits; a 480 px photo fits at the first. */
const QUALITIES = [82, 60, 40] as const

// Nothing of a picture stays in libvips' cache once its request is done.
sharp.cache(false)

export interface StoredPicture {
  /** WebP. */
  data: Buffer
  /** SHA-256 of data, in lowercase hex: the picture's name in its URL and its ETag. */
  sha256: string
  width: number
  height: number
}

/** Why an upload was refused, as the API answers it (422, or 413 for picture_too_large). */
export type PictureRefusal = 'picture_format' | 'picture_unreadable' | 'picture_too_large'

export type PictureResult
  = | { ok: true, picture: StoredPicture }
    | { ok: false, refusal: PictureRefusal }

const refused = (refusal: PictureRefusal): PictureResult => ({ ok: false, refusal })

/** The picture as it is stored: upright, within 480 × 480, WebP, without metadata; or why not. */
export async function normalizePicture(upload: Uint8Array): Promise<PictureResult> {
  if (upload.length > PICTURE_MAX_UPLOAD_BYTES) return refused('picture_too_large')
  if (!isAcceptedFormat(upload)) return refused('picture_format')
  try {
    const { width, height } = await sharp(upload).metadata()
    if (width * height > MAX_INPUT_PIXELS) return refused('picture_too_large')
    for (const quality of QUALITIES) {
      const { data, info } = await sharp(upload, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: PICTURE_MAX_DIMENSION, height: PICTURE_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true })
      if (data.length <= PICTURE_MAX_STORED_BYTES) {
        return { ok: true, picture: { data, sha256: sha256(data), width: info.width, height: info.height } }
      }
    }
    return refused('picture_too_large')
  } catch {
    // libvips could not decode it: truncated, corrupt, or not what its
    // first bytes claim.
    return refused('picture_unreadable')
  }
}

const JPEG = [0xff, 0xd8, 0xff]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((byte, i) => bytes[offset + i] === byte)
}

/** JPEG, PNG or WebP, by the first bytes. */
export function isAcceptedFormat(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG) || startsWith(bytes, PNG) || (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8))
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Where a picture is served. The URL names the picture by its hash, so a
 * new picture gets a new URL and a URL is never reused for other content:
 * that is what lets a browser keep it for good.
 */
export function pictureUrl(electionId: string, candidateId: string, hash: string): string {
  return `/api/elections/${electionId}/candidates/${candidateId}/picture/${hash}`
}

/** The strong ETag of a picture: its hash. */
export function pictureEtag(hash: string): string {
  return `"${hash}"`
}

/**
 * Whether an If-None-Match header names this picture, compared weakly as
 * RFC 9110 has it for GET: a list of tags, each possibly W/, or *.
 */
export function matchesEtag(ifNoneMatch: string | undefined, hash: string): boolean {
  if (ifNoneMatch === undefined) return false
  const etag = pictureEtag(hash)
  return ifNoneMatch.split(',').map((tag) => tag.trim().replace(/^W\//, '')).some((tag) => tag === '*' || tag === etag)
}
