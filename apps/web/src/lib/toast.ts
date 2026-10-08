// Short confirmations that a change went through ("Bild von Paula Berger
// gespeichert."), shown for a few seconds in the one live region the shell
// keeps on every member page (components/ToastRegion.vue). Errors never
// come this way: they stay next to what failed until the next attempt.
// Free of the DOM, so node:test checks the queue.

import { reactive } from 'vue'

export interface Toast {
  id: number
  text: string
}

/** How long a toast stays, unless dismissed earlier. */
export const TOAST_MS = 6000

/** At most this many at once; a new one pushes out the oldest. */
export const MAX_TOASTS = 3

export const toasts = reactive<Toast[]>([])

let lastId = 0

export function dismiss(id: number): void {
  const index = toasts.findIndex((toast) => toast.id === id)
  if (index >= 0) toasts.splice(index, 1)
}

/** Shows `text` as a toast and takes it away after TOAST_MS; `schedule` is the timer, replaceable in tests. */
export function notify(text: string, schedule: (run: () => void, ms: number) => unknown = setTimeout): number {
  const id = ++lastId
  toasts.push({ id, text })
  while (toasts.length > MAX_TOASTS) toasts.shift()
  schedule(() => dismiss(id), TOAST_MS)
  return id
}
