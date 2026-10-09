// The cards' QR codes as images, drawn in the browser; the page's policy
// allows data: images. Each carries the card's address with its key in the
// fragment (lib/sheet.ts).

import QRCode from 'qrcode'
import type { Card } from './sheet.ts'

/** Every card's QR image, by its key. */
export async function drawCodes(cards: readonly Card[]): Promise<Map<string, string>> {
  const drawn = await Promise.all(cards.map(async (card): Promise<[string, string]> =>
    [card.key, await QRCode.toDataURL(card.url, { errorCorrectionLevel: 'M', margin: 0, width: 320 })]))
  return new Map(drawn)
}

/** Whether every card has its image: only then are the sheets shown and printable. */
export function allDrawn(cards: readonly Card[], images: ReadonlyMap<string, string>): boolean {
  return cards.every((card) => (images.get(card.key) ?? '') !== '')
}
