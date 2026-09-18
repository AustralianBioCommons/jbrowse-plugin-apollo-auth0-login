const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')
const { version } = require('../package.json')

// Provide the required Auth0 configuration.
const environment = {
  AUTH0_DOMAIN: 'tenant.au.auth0.com',
  AUTH0_CLIENT_ID: 'test-client',
  AUTH0_CLIENT_SECRET: 'test-secret',
  AUTH0_CALLBACK_URL: 'https://apollo.example.org/auth/auth0',
}

// Load the plugin with an isolated Auth0 handler and environment.
function setup(env = environment) {
  const instances = []

  // Capture configuration and login calls without contacting Auth0.
  class MockAuth0Handler {
    constructor(options) {
      this.options = options
      this.calls = []
      instances.push(this)
    }

    // Give each login invocation an independently controllable promise.
    login(request, redirectUri) {
      let resolve
      let reject

      const promise = new Promise(
        (resolvePromise, rejectPromise) => {
          resolve = resolvePromise
          reject = rejectPromise
        },
      )

      this.calls.push({
        request,
        redirectUri,
        resolve,
        reject,
      })

      return promise
    }
  }

  class MockPlugin {}

  // Replace external dependencies while loading the TypeScript source.
  const { default: Plugin } = loadSource(
    'src/index.ts',
    {
      '@jbrowse/core/Plugin': MockPlugin,
      './auth0': MockAuth0Handler,
      '../package.json': { version },
    },
    {
      process: {
        env: { ...env },
      },
    },
  )

  const plugin = new Plugin()
  const registrations = []

  // Capture Apollo extension registration without starting the server.
  plugin.apolloInstall({
    addToExtensionPoint(name, callback) {
      registrations.push({
        name,
        callback,
      })
    },
  })

  return {
    plugin,
    instances,
    registrations,
    register: registrations[0]?.callback,
  }
}

// Check metadata, registration, defaults, and existing providers.
test('registers the Auth0 login provider', () => {
  const {
    plugin,
    register,
    instances,
    registrations,
  } = setup()

  assert.equal(
    plugin.name,
    'ApolloAuth0Login',
  )

  assert.equal(
    plugin.version,
    version,
  )

  assert.equal(
    registrations.length,
    1,
  )

  assert.equal(
    registrations[0].name,
    'Apollo-RegisterCustomAuth',
  )

  // One handler must survive both OAuth legs.
  assert.equal(
    instances.length,
    1,
  )

  const existing = {
    message: 'Existing login',
  }

  const auths = new Map([
    ['existing', existing],
  ])

  assert.equal(
    register(auths),
    auths,
  )

  assert.equal(
    auths.get('existing'),
    existing,
  )

  const auth0 = auths.get('auth0')

  assert.equal(
    auth0.message,
    'Sign in with Auth0',
  )

  assert.equal(
    auth0.needsPopup,
    true,
  )

  assert.equal(
    typeof auth0.handler,
    'function',
  )
})

// Check the optional environment variable overrides the button text.
test('uses AUTH0_LOGIN_MESSAGE when configured', () => {
  const {
    register,
  } = setup({
    ...environment,
    AUTH0_LOGIN_MESSAGE:
      'Continue with institutional login',
  })

  const auth0 = register(
    new Map(),
  ).get('auth0')

  assert.equal(
    auth0.message,
    'Continue with institutional login',
  )
})

// Missing optional button text must continue using the default.
test('uses the default message when AUTH0_LOGIN_MESSAGE is empty', () => {
  const {
    register,
  } = setup({
    ...environment,
    AUTH0_LOGIN_MESSAGE: '',
  })

  const auth0 = register(
    new Map(),
  ).get('auth0')

  assert.equal(
    auth0.message,
    'Sign in with Auth0',
  )
})

// Do not register the extension when required configuration is absent.
for (const key of Object.keys(environment)) {
  for (const value of [undefined, '']) {
    test(
      `skips registration when ${key} is ${JSON.stringify(value)}`,
      () => {
        const {
          instances,
          registrations,
        } = setup({
          ...environment,
          [key]: value,
        })

        assert.equal(
          registrations.length,
          0,
        )

        assert.equal(
          instances.length,
          0,
        )
      },
    )
  }
}

// Pass the explicitly configured callback URL directly to the Auth0 handler.
test('passes AUTH0_CALLBACK_URL to the Auth0 handler', () => {
  const callbackURL =
    'https://public.example.org/apollo/auth/auth0'

  const {
    instances,
  } = setup({
    ...environment,
    AUTH0_CALLBACK_URL: callbackURL,
  })

  assert.equal(
    instances.length,
    1,
  )

  assert.deepEqual(
    instances[0].options,
    {
      domain: environment.AUTH0_DOMAIN,
      clientID: environment.AUTH0_CLIENT_ID,
      clientSecret: environment.AUTH0_CLIENT_SECRET,
      callbackURL,
    },
  )
})

// Verify Apollo requests are delegated to the persistent handler.
test('delegates login requests to the Auth0 handler', async () => {
  const {
    register,
    instances,
  } = setup()

  const auth0 = register(
    new Map(),
  ).get('auth0')

  const request = {
    query: {},
  }

  const redirectUri =
    'https://apollo.example.org/popup'

  const result = auth0.handler(
    request,
    redirectUri,
  )

  assert.equal(
    instances.length,
    1,
  )

  assert.equal(
    instances[0].calls.length,
    1,
  )

  const call =
    instances[0].calls[0]

  assert.equal(
    call.request,
    request,
  )

  assert.equal(
    call.redirectUri,
    redirectUri,
  )

  const redirect = {
    url: 'https://tenant.au.auth0.com/authorize',
  }

  call.resolve(
    redirect,
  )

  assert.equal(
    await result,
    redirect,
  )
})

// Concurrent logins must remain independent inside one persistent handler.
test('keeps concurrent login outcomes independent', async () => {
  const {
    register,
    instances,
  } = setup()

  const auth0 = register(
    new Map(),
  ).get('auth0')

  const firstRequest = {
    query: {
      code: 'first',
      state: 'first-state',
    },
  }

  const secondRequest = {
    query: {
      code: 'second',
      state: 'second-state',
    },
  }

  const first = auth0.handler(
    firstRequest,
  )

  const second = auth0.handler(
    secondRequest,
  )

  // Both requests use the same long-lived Auth0 handler.
  assert.equal(
    instances.length,
    1,
  )

  assert.equal(
    instances[0].calls.length,
    2,
  )

  const [
    firstCall,
    secondCall,
  ] = instances[0].calls

  assert.equal(
    firstCall.request,
    firstRequest,
  )

  assert.equal(
    secondCall.request,
    secondRequest,
  )

  const user = {
    name: 'Second User',
    email: 'second@example.org',
  }

  secondCall.resolve(
    user,
  )

  assert.equal(
    await second,
    user,
  )

  const error =
    new Error('First login failed')

  const rejection =
    assert.rejects(
      first,
      received =>
        received === error,
    )

  firstCall.reject(
    error,
  )

  await rejection
})
