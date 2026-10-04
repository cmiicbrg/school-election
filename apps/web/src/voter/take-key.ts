// The one side effect of the voter's bootstrap, in the browser, at import:
// main.ts imports this module first, so it runs before the router exists.

import { takeKey } from './bootstrap.ts'

takeKey(window.location, window.history)
