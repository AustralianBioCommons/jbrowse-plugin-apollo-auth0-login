import type { Request } from 'express'
import * as oidc from 'openid-client'

// Describe the authenticated identity Apollo expects from a custom provider.
export interface AuthUser {
  name: string
  email: string
}

// Describe the Auth0 settings required to initialize the OIDC client.
interface AuthOptions {
  domain: string
  clientID: string
  clientSecret: string
  callbackURL: string
}

// Store the security values needed to validate one authorization attempt.
interface PendingAuth {
  state: string
  codeVerifier: string
  nonce: string
  expiresAt: number
}

// Preserve Apollo's required redirect state plus an unpredictable state handle.
interface ApolloState {
  redirect_uri: string
  auth0_state: string
}

// Expire abandoned authentication attempts after ten minutes.
const AUTH_TTL_MS = 10 * 60 * 1000

// Prevent unlimited memory growth from unfinished authentication requests.
const MAX_PENDING_AUTH = 1000

// Validate the configured Auth0 domain and convert it to an issuer URL.
function issuerFor(domain: string): URL {
  // Reject an empty Auth0 domain before constructing the URL.
  if (!domain) {
    throw new Error('AUTH0_DOMAIN is required')
  }

  // Add the fixed HTTPS scheme required for Auth0 OIDC endpoints.
  const issuer = new URL(
    `https://${domain}/`,
  )

  // Reject schemes, paths, credentials, queries, or altered hostnames.
  if (
    issuer.host !== domain ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== '/' ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error(
      'AUTH0_DOMAIN must be a hostname without a scheme, path, or credentials',
    )
  }

  // Return the validated issuer URL used for OIDC discovery.
  return issuer
}

// Read one callback query parameter and require a non-empty string value.
function queryString(
  request: Request,
  key: string,
): string | undefined {
  // Read the raw Express query value.
  const value = request.query[key]

  // Treat an absent parameter as undefined rather than an error.
  if (value === undefined) {
    return undefined
  }

  // Reject arrays, objects, empty strings, and other unexpected query values.
  if (
    typeof value !== 'string' ||
    !value
  ) {
    throw new Error(
      'Invalid Auth0 callback parameters',
    )
  }

  // Return the validated callback value.
  return value
}

// Decode the state value that must remain compatible with Apollo's auth flow.
function parseApolloState(
  value: string,
): ApolloState {
  let parsed: unknown

  // Parse the browser-returned state without trusting its contents yet.
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      'Invalid Auth0 login state',
    )
  }

  // Require an object containing both Apollo and plugin state fields.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('redirect_uri' in parsed) ||
    !('auth0_state' in parsed)
  ) {
    throw new Error(
      'Invalid Auth0 login state',
    )
  }

  // Extract the fields only after confirming the expected object shape.
  const {
    redirect_uri,
    auth0_state,
  } = parsed as Record<string, unknown>

  // Require both state properties to be non-empty strings.
  if (
    typeof redirect_uri !== 'string' ||
    !redirect_uri ||
    typeof auth0_state !== 'string' ||
    !auth0_state
  ) {
    throw new Error(
      'Invalid Auth0 login state',
    )
  }

  // Parse the Apollo redirect URI before validating its allowed protocol.
  const redirect = new URL(
    redirect_uri,
  )

  // Restrict the final Apollo redirect to ordinary web protocols.
  if (
    redirect.protocol !== 'http:' &&
    redirect.protocol !== 'https:'
  ) {
    throw new Error(
      'Invalid Auth0 redirect URI',
    )
  }

  // Return the validated state fields.
  return {
    redirect_uri,
    auth0_state,
  }
}

// Reconstruct the complete callback URL expected by openid-client.
function callbackUrlFromRequest(
  request: Request,
  callbackURL: string,
): URL {
  // Start with the configured callback URL without trusting forwarded host data.
  const url = new URL(
    callbackURL,
  )

  // Copy only validated query parameters from the incoming callback request.
  for (
    const [key, value]
    of Object.entries(request.query)
  ) {
    // Copy ordinary single-value query parameters.
    if (typeof value === 'string') {
      url.searchParams.append(
        key,
        value,
      )
      continue
    }

    // Copy repeated query parameters only when every item is a string.
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== 'string') {
          throw new Error(
            'Invalid Auth0 callback parameters',
          )
        }

        url.searchParams.append(
          key,
          item,
        )
      }

      continue
    }

    // Reject unexpected non-string query parameter representations.
    if (value !== undefined) {
      throw new Error(
        'Invalid Auth0 callback parameters',
      )
    }
  }

  // Return the reconstructed authorization callback URL.
  return url
}

// Handle both legs of the Auth0 authorization-code flow.
export default class Auth0AuthHandler {
  // Store immutable configuration used across authentication requests.
  private readonly issuer: URL
  private readonly clientID: string
  private readonly clientSecret: string
  private readonly callbackURL: string

  // Cache OIDC discovery so Auth0 metadata is not fetched for every login.
  private configPromise?: ReturnType<
    typeof oidc.discovery
  >

  // Keep short-lived PKCE, nonce, and state data between redirect and callback.
  private readonly pendingAuth = new Map<
    string,
    PendingAuth
  >()

  // Limitation: this state exists only inside one Apollo server process.
  // Multi-replica deployments need sticky routing or a shared TTL store.
  // Restarting the process also invalidates any authentication already in flight.

  // Initialize and validate static Auth0 configuration.
  constructor({
    domain,
    clientID,
    clientSecret,
    callbackURL,
  }: AuthOptions) {
    // Validate the tenant hostname before any credentials are sent.
    this.issuer = issuerFor(
      domain,
    )

    // Retain client credentials for OIDC discovery and token exchange.
    this.clientID = clientID
    this.clientSecret = clientSecret

    // Retain the exact callback URI registered with Auth0.
    this.callbackURL = callbackURL
  }

  // Discover and cache Auth0's OpenID Connect endpoints and metadata.
  private getConfig() {
    // Reuse the same discovery promise after the first successful call.
    this.configPromise ??= oidc.discovery(
      this.issuer,
      this.clientID,
      this.clientSecret,
    )

    // Return the cached or newly created discovery promise.
    return this.configPromise
  }

  // Remove abandoned authentication attempts from the in-memory state store.
  private cleanupExpired() {
    // Capture one timestamp so every entry is evaluated consistently.
    const now = Date.now()

    // Walk all pending state entries and remove expired attempts.
    for (
      const [key, pending]
      of this.pendingAuth
    ) {
      if (pending.expiresAt <= now) {
        this.pendingAuth.delete(
          key,
        )
      }
    }
  }

  // Start the authorization-code flow and return the Auth0 redirect URL.
  private async startLogin(
    redirectUri: string | undefined,
  ): Promise<{ url: string }> {
    // Apollo needs this URI later to finish its popup login flow.
    if (!redirectUri) {
      throw new Error(
        'Auth0 login requires an Apollo redirect_uri',
      )
    }

    // Remove stale state before allocating another authentication attempt.
    this.cleanupExpired()

    // Bound the amount of state an attacker can make the process retain.
    if (
      this.pendingAuth.size >=
      MAX_PENDING_AUTH
    ) {
      throw new Error(
        'Too many pending Auth0 login attempts',
      )
    }

    // Load the Auth0 issuer metadata used to construct the authorization URL.
    const config = await this.getConfig()

    // Generate a high-entropy PKCE verifier retained only by this server.
    const codeVerifier =
      oidc.randomPKCECodeVerifier()

    // Derive the SHA-256 PKCE challenge that is safe to send to Auth0.
    const codeChallenge =
      await oidc.calculatePKCECodeChallenge(
        codeVerifier,
      )

    // Generate the OIDC nonce later checked against the returned ID token.
    const nonce = oidc.randomNonce()

    // Generate an opaque identifier used to correlate browser and server state.
    const stateId = oidc.randomState()

    // Preserve Apollo's required JSON state format while adding random entropy.
    const state = JSON.stringify({
      redirect_uri: redirectUri,
      auth0_state: stateId,
    } satisfies ApolloState)

    // Retain security material that must never be trusted from the browser.
    this.pendingAuth.set(
      stateId,
      {
        state,
        codeVerifier,
        nonce,
        expiresAt:
          Date.now() +
          AUTH_TTL_MS,
      },
    )

    // Build the OIDC authorization request using code flow, PKCE, and nonce.
    const authorizationURL =
      oidc.buildAuthorizationUrl(
        config,
        {
          redirect_uri: this.callbackURL,
          scope: 'openid profile email',
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        },
      )

    // Return the Auth0 URL so Apollo can redirect the popup browser.
    return {
      url: authorizationURL.href,
    }
  }

  // Validate the Auth0 callback and exchange its authorization code for tokens.
  private async finishLogin(
    request: Request,
    state: string,
  ): Promise<AuthUser> {
    // Remove unrelated expired attempts before looking up callback state.
    this.cleanupExpired()

    // Validate Apollo's state structure and extract the opaque server lookup key.
    const apolloState =
      parseApolloState(
        state,
      )

    // Look up the security context created before redirecting to Auth0.
    const pending =
      this.pendingAuth.get(
        apolloState.auth0_state,
      )

    // Reject unknown, expired, restarted, or cross-instance authentication state.
    if (
      !pending ||
      pending.expiresAt <= Date.now()
    ) {
      this.pendingAuth.delete(
        apolloState.auth0_state,
      )

      throw new Error(
        'Invalid or expired Auth0 login state',
      )
    }

    // Consume state before token exchange so one callback cannot be replayed.
    this.pendingAuth.delete(
      apolloState.auth0_state,
    )

    // Load the same discovered Auth0 metadata used for the initial request.
    const config = await this.getConfig()

    let tokens

    // Validate state, nonce, PKCE, ID token, and exchange Auth0's code.
    try {
      tokens =
        await oidc.authorizationCodeGrant(
          config,
          callbackUrlFromRequest(
            request,
            this.callbackURL,
          ),
          {
            pkceCodeVerifier:
              pending.codeVerifier,
            expectedState:
              pending.state,
            expectedNonce:
              pending.nonce,
            idTokenExpected: true,
          },
        )
    } catch {
      // Keep provider responses and tokens out of errors shown to the client.
      throw new Error(
        'Auth0 authentication failed or login state is invalid',
      )
    }

    // Read the already validated claims from the returned ID token.
    const idTokenClaims =
      tokens.claims()

    // Require an OIDC subject before trusting the authentication result.
    if (!idTokenClaims?.sub) {
      throw new Error(
        'Auth0 did not return an authenticated subject',
      )
    }

    let profile

    // Retrieve UserInfo and require it to belong to the authenticated subject.
    try {
      profile =
        await oidc.fetchUserInfo(
          config,
          tokens.access_token,
          idTokenClaims.sub,
        )
    } catch {
      throw new Error(
        'Failed to retrieve Auth0 user information',
      )
    }

    // Require a non-empty email address that Auth0 explicitly marks verified.
    if (
      typeof profile.email !== 'string' ||
      !profile.email.trim() ||
      profile.email_verified !== true
    ) {
      throw new Error(
        'Auth0 login requires a verified email address',
      )
    }

    // Prefer the Auth0 display name but fall back to the verified email.
    const name =
      typeof profile.name === 'string' &&
      profile.name.trim()
        ? profile.name
        : profile.email

    // Return only the identity fields Apollo needs for its own user handling.
    return {
      name,
      email: profile.email,
    }
  }

  // Route either the initial login request or the Auth0 callback.
  async login(
    request: Request,
    redirectUri?: string,
  ): Promise<{ url: string } | AuthUser> {
    // Read state first because every valid Auth0 callback should include it.
    const state = queryString(
      request,
      'state',
    )

    // Detect callback requests without manually constructing or parsing OAuth code.
    const isCallback =
      state !== undefined ||
      request.query.code !== undefined ||
      request.query.error !== undefined

    // No OAuth callback values means this is the first authentication leg.
    if (!isCallback) {
      return this.startLogin(
        redirectUri,
      )
    }

    // Require state on both successful and failed Auth0 callback responses.
    if (!state) {
      throw new Error(
        'Auth0 callback is missing state',
      )
    }

    // Let openid-client validate and process the complete callback response.
    return this.finishLogin(
      request,
      state,
    )
  }
}
