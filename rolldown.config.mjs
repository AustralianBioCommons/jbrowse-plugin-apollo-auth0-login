import { builtinModules } from 'node:module'
import path from 'node:path'

import jbrowseGlobals from '@jbrowse/core/ReExports/list'
import { esmExternalRequirePlugin } from 'rolldown/plugins'
import { defineConfig } from 'rolldown'

// Include both bare and node-prefixed Node.js built-in module names.
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

// Build the plugin for use in the browser.
export default defineConfig({
  input: 'src/index.ts',
  platform: 'browser',
  // Keep JBrowse-provided packages external and bundle other dependencies.
  external: (id) => {
    const isExternal = !id.startsWith('.') && !path.isAbsolute(id)
    if (isExternal && !jbrowseGlobals.includes(id)) {
      return false
    }
    return isExternal
  },
  // Handle require calls for external Node.js built-in modules.
  plugins: [
    esmExternalRequirePlugin({
      external: [...nodeBuiltins],
    }),
  ],
  // Emit development and minified production bundles with source maps.
  output: [
    {
      file: 'dist/jbrowse-plugin-apollo-auth0-login.development.mjs',
      format: 'esm',
      exports: 'named',
      sourcemap: true,
    },
    {
      file: 'dist/jbrowse-plugin-apollo-auth0-login.production.min.mjs',
      format: 'esm',
      exports: 'named',
      sourcemap: true,
      minify: true,
    },
  ],
  watch: { clearScreen: false },
})
