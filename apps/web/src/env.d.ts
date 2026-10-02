/// <reference types="vite/client" />

// vue-tsc understands .vue imports on its own; this declaration is for the
// plain TypeScript service ESLint uses, which does not.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent
  export default component
}
