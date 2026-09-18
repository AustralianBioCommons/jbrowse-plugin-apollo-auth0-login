const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadSource } = require('./helpers.cjs')

// Provide the fixed Auth0 configuration used by the tests.
const options = {
  domain: 'tenant.au.auth0.com',
  clientID: 'test-client',
  clientSecret: 'test-secret',
  callbackURL:
    'https://apollo.example.org/prefix/auth/auth0',
}

// Provide a normal Auth0 UserInfo response.
const profile = {
  sub: 'auth0|test-user',
  name: 'Test User',
  email: 'user@example.org',
  email_verified: true,
}

// Build an isolated openid-client mock and handler.
function setup(overrides = {}) {
  const calls = []

  let verifierNumber = 0
  let nonceNumber = 0
  let stateNumber = 0

  const config = {
    type: 'mock-openid-config',
  }

  // Mock only the protocol boundary owned by openid-client.
  const oidc = {
    async discovery(
      issuer,
      clientID,
      clientSecret,
    ) {
      calls.push({
        type: 'discovery',
        issuer: issuer.href,
        clientID,
        clientSecret,
      })

      if (overrides.discoveryError) {
        throw new Error(
          'sensitive provider details',
        )
      }

      return config
    },

    randomPKCECodeVerifier() {
      verifierNumber += 1

      const value =
        `verifier-${verifierNumber}`

      calls.push({
        type: 'pkce-verifier',
        value,
      })

      return value
    },

    async calculatePKCECodeChallenge(
      verifier,
    ) {
      const value =
        `challenge-${verifier}`

      calls.push({
        type: 'pkce-challenge',
        verifier,
        value,
      })

      return value
    },

    randomNonce() {
      nonceNumber += 1

      const value =
        `nonce-${nonceNumber}`

      calls.push({
        type: 'nonce',
        value,
      })

      return value
    },

    randomState() {
      stateNumber += 1

      const value =
        `state-${stateNumber}`

      calls.push({
        type: 'state',
        value,
      })

      return value
    },

    buildAuthorizationUrl(
      receivedConfig,
      params,
    ) {
      calls.push({
        type: 'authorize',
        config: receivedConfig,
        params: { ...params },
      })

      // Build a representative provider URL for the handler result.
      const url = new URL(
        'https://tenant.au.auth0.com/authorize',
      )

      for (
        const [key, value]
        of Object.entries(params)
      ) {
        url.searchParams.set(
          key,
          value,
        )
      }

      return url
    },

    async authorizationCodeGrant(
      receivedConfig,
      callbackURL,
      checks,
    ) {
      calls.push({
        type: 'grant',
        config: receivedConfig,
        callbackURL: callbackURL.href,
        checks: { ...checks },
      })

      if (overrides.grantError) {
        throw new Error(
          'sensitive provider details',
        )
      }

      // Model state checking performed by openid-client.
      if (
        callbackURL.searchParams.get('state') !==
        checks.expectedState
      ) {
        throw new Error(
          'state mismatch',
        )
      }

      // Model provider denial before any token result is returned.
      if (
        callbackURL.searchParams.has('error')
      ) {
        throw new Error(
          'provider denied authorization',
        )
      }

      // Model the authorization-code requirement.
      if (
        !callbackURL.searchParams.get('code')
      ) {
        throw new Error(
          'authorization code missing',
        )
      }

      return {
        access_token: 'access-token',

        // Model already validated ID-token claims.
        claims() {
          if (
            Object.prototype.hasOwnProperty.call(
              overrides,
              'claims',
            )
          ) {
            return overrides.claims
          }

          return {
            sub: profile.sub,
          }
        },
      }
    },

    async fetchUserInfo(
      receivedConfig,
      accessToken,
      expectedSubject,
    ) {
      calls.push({
        type: 'userinfo',
        config: receivedConfig,
        accessToken,
        expectedSubject,
      })

      if (overrides.profileError) {
        throw new Error(
          'sensitive provider details',
        )
      }

      const result = {
        ...profile,
        ...overrides.profile,
      }

      // Model openid-client's expected-subject check.
      if (
        result.sub !== expectedSubject
      ) {
        throw new Error(
          'UserInfo subject mismatch',
        )
      }

      return result
    },
  }

  // Load the handler with the real protocol library replaced by the mock.
  const {
    default: Handler,
  } = loadSource(
    'src/auth0.ts',
    {
      'openid-client': oidc,
    },
  )

  const handler =
    new Handler(options)

  // Start a login and expose the generated authorization state.
  async function start(
    redirectUri =
      'https://apollo.example.org/popup',
  ) {
    const request = {
      query: {},
    }

    const result =
      await handler.login(
        request,
        redirectUri,
      )

    const authorize =
      [...calls]
        .reverse()
        .find(
          call =>
            call.type === 'authorize',
        )

    assert.ok(
      authorize,
    )

    return {
      request,
      result,
      params: authorize.params,
      state: authorize.params.state,
    }
  }

  return {
    Handler,
    handler,
    oidc,
    config,
    calls,
    start,
  }
}

// Verify the first leg creates PKCE, nonce, state, and the Auth0 redirect.
test('starts login with PKCE, nonce, and Apollo state', async () => {
  const {
    calls,
    start,
  } = setup()

  const {
    result,
    params,
    state,
  } = await start()

  const url =
    new URL(result.url)

  assert.equal(
    url.origin,
    'https://tenant.au.auth0.com',
  )

  assert.equal(
    url.pathname,
    '/authorize',
  )

  assert.equal(
    params.redirect_uri,
    options.callbackURL,
  )

  assert.equal(
    params.scope,
    'openid profile email',
  )

  assert.equal(
    params.code_challenge,
    'challenge-verifier-1',
  )

  assert.equal(
    params.code_challenge_method,
    'S256',
  )

  assert.equal(
    params.nonce,
    'nonce-1',
  )

  const parsedState =
    JSON.parse(state)

  assert.deepEqual(
    parsedState,
    {
      redirect_uri:
        'https://apollo.example.org/popup',
      auth0_state:
        'state-1',
    },
  )

  // The PKCE verifier stays server-side.
  assert.equal(
    state.includes('verifier-1'),
    false,
  )

  // Client credentials must never be placed in the browser URL.
  assert.equal(
    url.searchParams.has(
      'client_secret',
    ),
    false,
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'discovery',
    ).length,
    1,
  )
})

// The flow must not depend on an Express browser session.
test('starts login without an Express session', async () => {
  const {
    handler,
  } = setup()

  const result =
    await handler.login(
      {
        query: {},
      },
      'https://apollo.example.org/popup',
    )

  assert.ok(
    result.url,
  )
})

// Verify callback processing delegates security checks to openid-client.
test('completes the authorization-code flow', async () => {
  const {
    handler,
    calls,
    start,
  } = setup()

  const {
    state,
  } = await start()

  const user =
    await handler.login({
      query: {
        code: 'authorization-code',
        state,
      },
    })

  assert.deepEqual(
    user,
    {
      name: profile.name,
      email: profile.email,
    },
  )

  const grant =
    calls.find(
      call =>
        call.type === 'grant',
    )

  assert.ok(
    grant,
  )

  const callbackURL =
    new URL(
      grant.callbackURL,
    )

  assert.equal(
    callbackURL.pathname,
    '/prefix/auth/auth0',
  )

  assert.equal(
    callbackURL.searchParams.get(
      'code',
    ),
    'authorization-code',
  )

  assert.equal(
    callbackURL.searchParams.get(
      'state',
    ),
    state,
  )

  assert.deepEqual(
    grant.checks,
    {
      pkceCodeVerifier:
        'verifier-1',
      expectedState:
        state,
      expectedNonce:
        'nonce-1',
      idTokenExpected:
        true,
    },
  )

  const userInfo =
    calls.find(
      call =>
        call.type === 'userinfo',
    )

  assert.ok(
    userInfo,
  )

  assert.equal(
    userInfo.accessToken,
    'access-token',
  )

  assert.equal(
    userInfo.expectedSubject,
    profile.sub,
  )

  // OIDC discovery is cached across both OAuth legs.
  assert.equal(
    calls.filter(
      call =>
        call.type === 'discovery',
    ).length,
    1,
  )
})

// Authentication state must be consumed after one callback.
test('rejects replayed callbacks', async () => {
  const {
    handler,
    calls,
    start,
  } = setup()

  const {
    state,
  } = await start()

  const callback = {
    query: {
      code: 'authorization-code',
      state,
    },
  }

  await handler.login(
    callback,
  )

  await assert.rejects(
    handler.login(callback),
    /Invalid or expired Auth0 login state/,
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'grant',
    ).length,
    1,
  )
})

// Missing ID-token subject must stop before UserInfo retrieval.
test('requires an authenticated OIDC subject', async () => {
  const {
    handler,
    calls,
    start,
  } = setup({
    claims: {},
  })

  const {
    state,
  } = await start()

  await assert.rejects(
    handler.login({
      query: {
        code: 'authorization-code',
        state,
      },
    }),
    /did not return an authenticated subject/,
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'userinfo',
    ).length,
    0,
  )
})

// Require Auth0 to provide a verified, non-empty email.
for (const invalid of [
  {
    email: '',
  },
  {
    email: undefined,
  },
  {
    email_verified: false,
  },
  {
    email_verified: 'true',
  },
]) {
  test(
    `rejects invalid UserInfo ${JSON.stringify(invalid)}`,
    async () => {
      const {
        handler,
        start,
      } = setup({
        profile: invalid,
      })

      const {
        state,
      } = await start()

      await assert.rejects(
        handler.login({
          query: {
            code:
              'authorization-code',
            state,
          },
        }),
        /requires a verified email address/,
      )
    },
  )
}

// UserInfo must belong to the subject authenticated by the ID token.
test('rejects a mismatched UserInfo subject', async () => {
  const {
    handler,
    start,
  } = setup({
    profile: {
      sub: 'auth0|another-user',
    },
  })

  const {
    state,
  } = await start()

  await assert.rejects(
    handler.login({
      query: {
        code: 'authorization-code',
        state,
      },
    }),
    /Failed to retrieve Auth0 user information/,
  )
})

// Fall back to verified email when Auth0 has no useful display name.
for (const name of [
  undefined,
  '',
  '  ',
  42,
]) {
  test(
    `falls back to email for name ${JSON.stringify(name)}`,
    async () => {
      const {
        handler,
        start,
      } = setup({
        profile: {
          name,
        },
      })

      const {
        state,
      } = await start()

      assert.deepEqual(
        await handler.login({
          query: {
            code:
              'authorization-code',
            state,
          },
        }),
        {
          name: profile.email,
          email: profile.email,
        },
      )
    },
  )
}

// Reject malformed browser state before contacting the token endpoint.
for (const state of [
  '',
  'not-json',
  '[]',
  '{}',
]) {
  test(
    `rejects malformed state ${JSON.stringify(state)}`,
    async () => {
      const {
        handler,
        calls,
      } = setup()

      await assert.rejects(
        handler.login({
          query: {
            code:
              'authorization-code',
            state,
          },
        }),
      )

      assert.equal(
        calls.filter(
          call =>
            call.type === 'grant',
        ).length,
        0,
      )
    },
  )
}

// Reject browser state that points at an unknown pending attempt.
test('rejects a tampered Auth0 state identifier', async () => {
  const {
    handler,
    calls,
    start,
  } = setup()

  const {
    state,
  } = await start()

  const altered =
    JSON.parse(state)

  altered.auth0_state =
    'state-attacker'

  await assert.rejects(
    handler.login({
      query: {
        code:
          'authorization-code',
        state:
          JSON.stringify(altered),
      },
    }),
    /Invalid or expired Auth0 login state/,
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'grant',
    ).length,
    0,
  )
})

// Changing Apollo state is detected by openid-client's expectedState check.
test('rejects tampered Apollo redirect state', async () => {
  const {
    handler,
    calls,
    start,
  } = setup()

  const {
    state,
  } = await start()

  const altered =
    JSON.parse(state)

  altered.redirect_uri =
    'https://attacker.example.org'

  await assert.rejects(
    handler.login({
      query: {
        code:
          'authorization-code',
        state:
          JSON.stringify(altered),
      },
    }),
    /Auth0 authentication failed or login state is invalid/,
  )

  // State was consumed before the failed code exchange.
  await assert.rejects(
    handler.login({
      query: {
        code:
          'authorization-code',
        state,
      },
    }),
    /Invalid or expired Auth0 login state/,
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'grant',
    ).length,
    1,
  )
})

// A callback carrying a code but no state is never accepted.
test('rejects callbacks missing state', async () => {
  const {
    handler,
  } = setup()

  await assert.rejects(
    handler.login({
      query: {
        code: 'authorization-code',
      },
    }),
    /Auth0 callback is missing state/,
  )
})

// Auth0 denial responses still consume and validate pending state.
test('rejects Auth0 denial callbacks', async () => {
  const {
    handler,
    start,
  } = setup()

  const {
    state,
  } = await start()

  await assert.rejects(
    handler.login({
      query: {
        error: 'access_denied',
        state,
      },
    }),
    /Auth0 authentication failed or login state is invalid/,
  )
})

// Callback state must be represented as one non-empty query string.
for (const value of [
  ['value'],
  {
    value: 'value',
  },
  null,
  1,
]) {
  test(
    `rejects malformed state query value ${JSON.stringify(value)}`,
    async () => {
      const {
        handler,
      } = setup()

      await assert.rejects(
        handler.login({
          query: {
            state: value,
          },
        }),
        /Invalid Auth0 callback parameters/,
      )
    },
  )
}

// Provider token failures must not expose provider details.
test('sanitizes authorization-code failures', async () => {
  const {
    handler,
    start,
  } = setup({
    grantError: true,
  })

  const {
    state,
  } = await start()

  await assert.rejects(
    handler.login({
      query: {
        code: 'authorization-code',
        state,
      },
    }),
    {
      message:
        'Auth0 authentication failed or login state is invalid',
    },
  )
})

// UserInfo failures must not expose provider details.
test('sanitizes UserInfo failures', async () => {
  const {
    handler,
    start,
  } = setup({
    profileError: true,
  })

  const {
    state,
  } = await start()

  await assert.rejects(
    handler.login({
      query: {
        code: 'authorization-code',
        state,
      },
    }),
    {
      message:
        'Failed to retrieve Auth0 user information',
    },
  )
})

// Multiple pending attempts must coexist instead of replacing each other.
test('supports simultaneous pending logins', async () => {
  const {
    handler,
    calls,
    start,
  } = setup()

  const first =
    await start(
      'https://apollo.example.org/first',
    )

  const second =
    await start(
      'https://apollo.example.org/second',
    )

  assert.notEqual(
    first.state,
    second.state,
  )

  // Complete the callbacks in reverse order.
  assert.deepEqual(
    await handler.login({
      query: {
        code: 'second-code',
        state: second.state,
      },
    }),
    {
      name: profile.name,
      email: profile.email,
    },
  )

  assert.deepEqual(
    await handler.login({
      query: {
        code: 'first-code',
        state: first.state,
      },
    }),
    {
      name: profile.name,
      email: profile.email,
    },
  )

  assert.equal(
    calls.filter(
      call =>
        call.type === 'grant',
    ).length,
    2,
  )
})

// Document the process-local pending-state limitation.
test('callback state does not survive a different handler instance', async () => {
  const {
    Handler,
    start,
  } = setup()

  const {
    state,
  } = await start()

  // A second handler models another process, replica, or server restart.
  const otherHandler =
    new Handler(options)

  await assert.rejects(
    otherHandler.login({
      query: {
        code:
          'authorization-code',
        state,
      },
    }),
    /Invalid or expired Auth0 login state/,
  )
})

// A popup redirect URI is required for Apollo's completion flow.
test('requires the Apollo redirect URI when starting login', async () => {
  const {
    handler,
  } = setup()

  await assert.rejects(
    handler.login({
      query: {},
    }),
    /requires an Apollo redirect_uri/,
  )
})

// Validate the tenant hostname before credentials are used.
for (const domain of [
  '',
  'https://tenant.au.auth0.com',
  'tenant.au.auth0.com/',
  'tenant.au.auth0.com/path',
  'user:password@tenant.au.auth0.com',
  'tenant.au.auth0.com?query=1',
  'tenant.au.auth0.com#fragment',
]) {
  test(
    `rejects malformed domain ${JSON.stringify(domain)}`,
    () => {
      const {
        Handler,
      } = setup()

      assert.throws(
        () =>
          new Handler({
            ...options,
            domain,
          }),
      )
    },
  )
}
