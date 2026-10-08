import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dismiss, MAX_TOASTS, notify, TOAST_MS, toasts } from '../src/lib/toast.ts'

test('a toast stays until its timer runs or it is dismissed, and the newest few are kept', () => {
  toasts.splice(0)
  const timers: { run: () => void, ms: number }[] = []
  const schedule = (run: () => void, ms: number) => timers.push({ run, ms })

  const first = notify('Name gespeichert.', schedule)
  assert.deepEqual(toasts.map((toast) => toast.text), ['Name gespeichert.'])
  assert.equal(timers[0]?.ms, TOAST_MS)
  timers[0]?.run()
  assert.equal(toasts.length, 0, 'gone when its time is up')
  dismiss(first)
  assert.equal(toasts.length, 0, 'dismissing a gone toast changes nothing')

  const ids = Array.from({ length: MAX_TOASTS + 1 }, (_, n) => notify(`Toast ${n}`, schedule))
  assert.equal(toasts.length, MAX_TOASTS)
  assert.equal(toasts[0]?.text, 'Toast 1', 'the oldest made room')
  dismiss(ids[2] ?? 0)
  assert.deepEqual(toasts.map((toast) => toast.text), ['Toast 1', 'Toast 3'])
  assert.ok(new Set(ids).size === ids.length, 'every toast has its own id')
})
