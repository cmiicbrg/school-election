// A confirmation that appears in the page is a dialog: focus moves into it
// when it opens, to its heading, so that it is read out before its
// buttons, and goes back when it closes: to the element that had it when
// the dialog opened, or, when a request had taken it away by then (a
// button disabled while busy), to the one the caller names.

import { nextTick, watch, type Ref } from 'vue'

export function useDialogFocus(open: Ref<unknown>, heading: Ref<HTMLElement | null>, returnTo?: Ref<HTMLElement | null>): void {
  let opener: HTMLElement | null = null
  watch(open, async (now, before) => {
    if (now && !before) {
      const active = document.activeElement
      opener = active instanceof HTMLElement && active !== document.body ? active : null
      await nextTick()
      heading.value?.focus()
    } else if (!now && before) {
      await nextTick()
      const target = opener?.isConnected ? opener : returnTo?.value
      target?.focus()
      opener = null
    }
  })
}
