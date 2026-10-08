// The browser tab's title: the page's own name first, then the app's, so
// the tabs of several Wahltermine stay apart. A page passes a getter, and
// the title follows it as the page's data arrives.

import { watchEffect } from 'vue'

const APP_NAME = 'Schulwahl'

export function usePageTitle(name: () => string): void {
  watchEffect(() => {
    const own = name()
    document.title = own === '' ? APP_NAME : `${own} – ${APP_NAME}`
  })
}
