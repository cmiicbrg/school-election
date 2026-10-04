// The side effects of the voter's bootstrap, in the browser: at import,
// which main.ts puts first so that this runs before the router exists,
// and on every fragment navigation after that, when another card is
// scanned into the same tab and the browser changes the fragment without
// loading the page again. The page hears the same event, after this, and
// starts over with the key taken here.

import { takeKey } from './bootstrap.ts'

takeKey(window.location, window.history)
window.addEventListener('hashchange', () => takeKey(window.location, window.history))
