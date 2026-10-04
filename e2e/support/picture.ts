// A photo for a candidate, drawn in memory so that no image file has to
// be committed: a portrait-sized PNG with a face-like shape on a sky.

import { PNG } from 'pngjs'

export function photo(width = 640, height = 800): Buffer {
  const png = new PNG({ width, height })
  const cx = width / 2
  const cy = height * 0.42
  const r = Math.min(width, height) * 0.22
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inFace = (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2
      const inBody = y > cy + r * 0.8 && Math.abs(x - cx) < r * 1.6 * ((y - cy) / height + 0.5)
      const sky = 1 - y / height
      let rgb = [120 + 80 * sky, 170 + 60 * sky, 230]
      if (inBody) rgb = [60, 90, 160]
      if (inFace) rgb = [236, 198, 170]
      png.data[i] = Math.round(rgb[0] ?? 0)
      png.data[i + 1] = Math.round(rgb[1] ?? 0)
      png.data[i + 2] = Math.round(rgb[2] ?? 0)
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}
