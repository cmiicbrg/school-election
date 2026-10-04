// A confirmation that appears in the page is a dialog: focus moves into it
// when it opens, to its heading, so that it is read out before its
// buttons, and goes back to where it came from when it closes.

import { nextTick, watch, type Ref } from 'vue'

export function useDialogFocus(open: Ref<unknown>, heading: Ref<HTMLElement | null>): void {
  let opener: HTMLElement | null = null
  watch(open, async (now, before) => {
    if (now && !before) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      heading.value?.focus()
    } else if (!now && before) {
      await nextTick()
      if (opener?.isConnected) opener.focus()
      opener = null
    }
  })
}
