// The decisions behind preparing a candidate picture in the browser, kept
// free of the DOM so that node:test can check them: how large the picture
// becomes, which qualities are tried, which dropped or pasted file is
// taken, and what the teacher is told when something goes wrong.
//
// The teacher drops, pastes or picks any photo the browser can open, at
// any size. picture.ts turns it upright, scales it to fit 480 × 480 without
// cropping it (lists and the ballot show it in a fixed frame with
// object-fit: cover, so nothing is cut off for good) and encodes it as
// WebP, or JPEG where the browser cannot encode WebP. Encoding the pixels
// anew leaves every piece of metadata behind: no Exif, GPS position or
// camera details reach the server, which re-encodes the picture once more
// in any case.

/** The longer side, at most; the server stores pictures at this size. */
export const PICTURE_MAX_DIMENSION = 480
/** The server's limit for an upload (apps/api/lib/pictures.ts); a 480 px photo is a fraction of it. */
export const PICTURE_MAX_UPLOAD_BYTES = 256 * 1024
/** Encoder qualities, tried in order until the picture fits the limit. */
export const PICTURE_QUALITIES = [0.82, 0.7, 0.55, 0.4] as const

export interface Size {
  width: number
  height: number
}

/** The size that fits within max × max with the same aspect ratio; never larger than the original. */
export function fitInside(size: Size, max = PICTURE_MAX_DIMENSION): Size {
  const { width, height } = size
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`not a picture size: ${width} × ${height}`)
  }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export interface FileLike {
  readonly name: string
  readonly type: string
}

// Some systems leave the type of a file empty, HEIC photos on Windows for
// one, so the name decides then.
const IMAGE_NAME = /\.(?:jpe?g|jfif|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i

/** Whether a file claims to be a picture, by its type or, without one, by its name. */
export function isImageFile(file: FileLike): boolean {
  return file.type === '' ? IMAGE_NAME.test(file.name) : file.type.startsWith('image/')
}

interface TransferItemLike<F> {
  readonly kind: string
  getAsFile: () => F | null
}

/** What a drop (DataTransfer) or a paste (clipboardData) carries, as far as files go. */
export interface TransferLike<F> {
  readonly items?: ArrayLike<TransferItemLike<F>>
  readonly files?: ArrayLike<F>
}

/**
 * The files of a drop or a paste. The items come first: a paste of a
 * screenshot or of a picture copied in another program arrives as an item,
 * not always in files.
 */
export function filesOf<F>(transfer: TransferLike<F> | null | undefined): F[] {
  if (!transfer) return []
  const fromItems = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file) => file !== null)
  return fromItems.length > 0 ? fromItems : Array.from(transfer.files ?? [])
}

export type Picked<F>
  = | { kind: 'none' }
    | { kind: 'file', file: F, others: number }

/** The first picture among the files, else the first file (which is then refused as no picture); and how many were left. */
export function pickFile<F extends FileLike>(files: readonly F[]): Picked<F> {
  const file = files.find(isImageFile) ?? files[0]
  return file === undefined ? { kind: 'none' } : { kind: 'file', file, others: files.length - 1 }
}

export type PictureProblem = 'no-file' | 'not-an-image' | 'unsupported-format' | 'too-large' | 'failed'

/** What the teacher reads when a picture cannot be used. */
export const PICTURE_MESSAGES: Readonly<Record<PictureProblem, string>> = {
  'no-file': 'Hier kam keine Datei an. Bitte ein Foto als Datei hierher ziehen, einfügen oder „Bild auswählen“ verwenden.',
  'not-an-image': 'Das ist keine Bilddatei. Bitte ein Foto verwenden.',
  'unsupported-format': 'Dieses Bildformat kann der Browser nicht öffnen. Bitte ein JPEG- oder PNG-Foto verwenden.',
  'too-large': 'Das Bild lässt sich nicht klein genug speichern. Bitte ein anderes Foto verwenden.',
  'failed': 'Das Bild konnte nicht vorbereitet werden. Bitte noch einmal versuchen.',
}

/** What an upload's refusal (the API's error code) means for the teacher. */
export function uploadMessage(code: string): string {
  switch (code) {
    case 'picture_format':
    case 'picture_unreadable':
      return PICTURE_MESSAGES['unsupported-format']
    case 'picture_too_large':
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return PICTURE_MESSAGES['too-large']
    case 'voting_started':
    case 'election_final':
      return 'Die Wahl hat schon begonnen; Bilder lassen sich nicht mehr ändern.'
    default:
      return 'Das Bild konnte nicht gespeichert werden. Bitte noch einmal versuchen.'
  }
}

/** The bytes as base64, as the upload route takes them, in slices small enough for String.fromCharCode. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}
