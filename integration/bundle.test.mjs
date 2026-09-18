import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

// Use the real built bundles while supplying only JBrowse's external Plugin base.
for (const suffix of ['development', 'production.min']) {
  test(`${suffix} bundle loads and registers Apollo authentication`, async () => {
    const filename = `dist/jbrowse-plugin-apollo-auth0-login.${suffix}.mjs`
    const code = await readFile(
      new URL(`../${filename}`, import.meta.url),
      'utf8',
    )
    // Start without Node globals to catch server-only imports during browser loading.
    const context = createContext({
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
    })
    const core = new SyntheticModule(
      ['default'],
      function () {
        this.setExport('default', class Plugin {})
      },
      { context },
    )
    const bundle = new SourceTextModule(code, {
      context,
      identifier: filename,
      importModuleDynamically: () => {
        throw new Error('Unexpected dynamic import')
      },
    })
    await bundle.link((specifier) => {
      assert.equal(
        specifier,
        '@jbrowse/core/Plugin',
        'Unexpected external bundle dependency',
      )
      return core
    })
    await bundle.evaluate()
    const Plugin = bundle.namespace.default
    assert.equal(typeof Plugin, 'function')
    const plugin = new Plugin()
    assert.equal(plugin.name, 'ApolloAuth0Login')

    // Apollo supplies process.env when installing the authentication provider on the server.
    context.process = {
      env: {
        AUTH0_DOMAIN: 'tenant.auth0.com',
        AUTH0_CLIENT_ID: 'test-client',
        AUTH0_CLIENT_SECRET: 'test-secret',
        AUTH0_CALLBACK_URL: 'https://apollo.example.org/auth/auth0',
      },
    }
    const registrations = []
    plugin.apolloInstall({
      addToExtensionPoint: (name, callback) =>
        registrations.push({ name, callback }),
    })
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'Apollo-RegisterCustomAuth')
    const existing = { message: 'Existing login' }
    const auths = new Map([['existing', existing]])
    assert.equal(registrations[0].callback(auths), auths)
    assert.equal(auths.get('existing'), existing)
    assert.equal(auths.get('auth0').message, 'Sign in with Auth0')
    assert.equal(auths.get('auth0').needsPopup, true)
    assert.equal(typeof auths.get('auth0').handler, 'function')

    // A bundle without credentials must load normally and leave authentication disabled.
    context.process.env = {}
    new Plugin().apolloInstall({
      addToExtensionPoint: () =>
        assert.fail('Unconfigured Auth0 must not register'),
    })
  })
}
