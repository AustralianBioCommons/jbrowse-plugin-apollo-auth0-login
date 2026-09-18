# jbrowse-plugin-apollo-auth0-login

[![CI main](https://github.com/AustralianBioCommons/jbrowse-plugin-apollo-auth0-login/actions/workflows/apollo-integration.yml/badge.svg?branch=main)](https://github.com/AustralianBioCommons/jbrowse-plugin-apollo-auth0-login/actions/workflows/apollo-integration.yml?query=branch%3Amain)
[![CI dev](https://github.com/AustralianBioCommons/jbrowse-plugin-apollo-auth0-login/actions/workflows/apollo-integration.yml/badge.svg?branch=dev)](https://github.com/AustralianBioCommons/jbrowse-plugin-apollo-auth0-login/actions/workflows/apollo-integration.yml?query=branch%3Adev)

Adds [Auth0](https://auth0.com) login to an [Apollo](https://apollo.jbrowse.org/) collaboration server using OpenID Connect (OIDC).

The plugin follows the same custom-authentication architecture as the [Apollo ORCID plugin](https://github.com/GMOD/jbrowse-plugin-apollo-orcid-login):

* registers an `auth0` provider with `Apollo-RegisterCustomAuth`
* returns `{ url }` to start authentication
* returns `{ name, email }` after successful authentication

Authentication is implemented with [`openid-client`](https://github.com/panva/openid-client/tree/main) using the OAuth 2.0 Authorization Code flow with PKCE, state, and an OIDC nonce.

The plugin does not install Express routes or session middleware. Apollo provides the `/auth/auth0` route and calls the plugin handler for both the initial login and the Auth0 callback.

The plugin is built as an ES module with [Rolldown](https://github.com/rolldown/rolldown) and loaded by Apollo through `PLUGIN_URLS`.

Authentication flow:

`Apollo → OIDC discovery → PKCE/state/nonce → Auth0 → callback → code exchange and validation → UserInfo → Apollo user`

## 1. Configure Auth0

Create a **Regular Web Application** in Auth0.

Add the Apollo Auth0 callback URL to **Allowed Callback URLs**:

```text
https://apollo.example.org/auth/auth0
```

If Apollo is hosted below a path prefix, preserve that prefix in the callback URL.

For example:

```text
https://example.org/apollo/auth/auth0
```

For local dev, use: `http://localhost:3999/auth/auth0`

The callback URL must match the Apollo `URL` configuration plus `/auth/auth0`.

The plugin requests these OIDC scopes:

```text
openid profile email
```

A user must have a non-empty email with:

```text
email_verified: true
```

The plugin returns the Auth0 display name and verified email to Apollo. If no display name is available, the verified email is used as the name.

## 2. Build and serve the plugin

Install dependencies and build the plugin:

```bash
yarn
yarn build
```

The production bundle is generated under `dist`.

Copy the production `.mjs` bundle to a location that Apollo can access over HTTP or HTTPS.

The bundle may be served from the same web server as JBrowse/Apollo; it does not need to be hosted on an external service.

### Local testing

- TypeScript checks: `yarn typecheck`.
- Unit tests: `yarn test`.
- Source-mapped unit coverage: `yarn test:coverage` (Node.js 24+).
- Bundle smoke tests: `yarn build && yarn test:bundle` (Node.js 24+).
- Apollo contract checks: set `APOLLO3_PATH` to an existing Apollo3 checkout, then run `yarn test:apollo`.

Coverage reports are written to `coverage/summary.txt` and `coverage/lcov.info`.
The report includes production TypeScript sources only and verifies that every
current source module is represented. Coverage is informational; no percentage
threshold is enforced yet. Tests mock the OIDC boundary, so coverage does not
prove that a live Auth0 login succeeds.

CI runs typechecking, coverage, builds, and smoke tests on pushes and pull requests.
Download the `unit-test-coverage` artifact from a workflow run for the text and LCOV
reports; artifacts are retained for 14 days. The badges show workflow status, not
coverage percentages.

The smoke tests evaluate both bundles without Node globals, supply JBrowse's Plugin
base as a stub, then verify Apollo registration using a simulated server environment.
They do not launch a browser or contact Auth0.

The Apollo contract job also runs weekly on Monday at 02:17 UTC against upstream
`main`. Direct pushes to `dev` skip the contract job; pull requests, manual runs,
and scheduled runs include it. GitHub runs schedules from the default branch.

## 3. Configure Apollo

Set the required environment variables on the Apollo collaboration server:

```env
AUTH0_CALLBACK_URL=http://localhost:3999/auth/auth0
AUTH0_DOMAIN=your-tenant.au.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret

PLUGIN_URLS=https://apollo.example.org/plugins/jbrowse-plugin-apollo-auth0-login.production.min.mjs
```

`AUTH0_DOMAIN` must be a hostname only:

```text
your-tenant.au.auth0.com
```

Do not include:

```text
https://
```

or a trailing `/`.

A custom Auth0 domain may also be used.

Keep `AUTH0_CLIENT_SECRET` on the Apollo collaboration server and never expose it to the browser.

The Auth0 login provider is registered only when all of these values are present:

* `URL`
* `AUTH0_DOMAIN`
* `AUTH0_CLIENT_ID`
* `AUTH0_CLIENT_SECRET`

Optionally configure message with: 

* `AUTH0_LOGIN_MESSAGE="Sign in with MyName"` - Default is: "Sign in with Auth0"

Restart Apollo after changing the configuration.

The login page should then include:

```text
Sign in with Auth0
```

## 4. Login flow

1. Apollo calls `handler(request, redirectUri)` when the user selects Auth0 login.

2. The plugin discovers the Auth0 OIDC configuration.

3. The plugin generates a PKCE verifier/challenge, random state identifier, and OIDC nonce.

4. The plugin temporarily stores the verifier, nonce, expected state, and expiry on the Apollo server.

5. The plugin returns the Auth0 authorization URL to Apollo as `{ url }`.

6. Apollo opens Auth0 in its authentication popup.

7. Auth0 redirects the browser back to `/auth/auth0` with its authorization response.

8. Apollo invokes the same plugin handler for the callback.

9. `openid-client` validates the callback and exchanges the authorization code using the saved PKCE verifier, state, and nonce.

10. The plugin retrieves Auth0 UserInfo and requires a verified email.

11. The plugin returns:

```ts
{
  name,
  email,
}
```

to Apollo.

Apollo then completes its own login flow.

## 5. State and security

The plugin uses:

* Authorization Code flow
* PKCE with `S256`
* random OAuth state
* OIDC nonce
* short-lived authentication state
* single-use callback state
* Auth0 OIDC discovery
* verified Auth0 email addresses

Apollo requires its popup `redirect_uri` to be preserved inside the OAuth state value.

The plugin therefore sends state containing:

```json
{
  "redirect_uri": "...",
  "auth0_state": "random-value"
}
```

The random `auth0_state` identifies the corresponding server-side authentication attempt.

The PKCE verifier and nonce are never taken from browser-provided state.

Pending authentication attempts expire after ten minutes.

## 6. Compatibility and testing

This plugin targets the Apollo 3 custom-authentication interface implemented by the [`GMOD/Apollo3`](https://github.com/GMOD/Apollo3) collaboration server.

The interface used by this plugin is based on:

* the `Apollo-RegisterCustomAuth` extension point
* custom handlers called as `handler(request, redirectUri)`
* `{ url }` returned to start an external authentication flow
* `{ name, email }` returned after successful authentication
* OAuth `state` containing Apollo's `redirect_uri` so Apollo can complete its popup login flow

The current compatibility baseline is the Apollo3 `main` branch checked by CI. At the time of this README update, the current published `@apollo-annotation/jbrowse-plugin-apollo` release is `1.1.2`.

The unit tests explicitly model Apollo's final use of the authentication state and verify that:

```text
JSON.parse(state).redirect_uri
```

still contains the same popup return URL originally supplied by Apollo.

A GitHub Actions integration test also checks out the real `GMOD/Apollo3` repository and inspects the collaboration-server authentication implementation. It verifies that the Apollo interface assumptions used by this plugin are still present, including:

* `Apollo-RegisterCustomAuth`
* custom authentication handlers
* redirect-style `{ url }` results
* authenticated `name` and `email`
* callback `state`
* Apollo's `redirect_uri` handling

This upstream contract test is intended to detect Apollo authentication-interface changes when Apollo is updated.

It is not a full browser end-to-end authentication test: CI does not start MongoDB, a complete Apollo deployment, or a live/mock Auth0 tenant. The plugin's OIDC protocol behaviour is tested separately with `openid-client` mocked at its external protocol boundary.

Because the GitHub Action checks Apollo3 `main`, an upstream interface change may cause CI to fail before that change appears in a stable Apollo release. This is intentional and provides early warning that the plugin may need updating.

## 7. Limitations

Compatibility currently depends on Apollo 3's `Apollo-RegisterCustomAuth` interface. This is verified against the Apollo3 `main` branch in CI rather than treated as a permanently stable public API.

Pending authentication state is stored in memory inside the Apollo server process.

This means:

* restarting Apollo invalidates logins already in progress
* multiple Apollo server replicas cannot independently access the same pending login
* a callback reaching a different replica will fail unless requests use sticky routing

For a multi-replica deployment, replace the in-memory pending-auth map with a shared TTL store such as Redis or another suitable shared datastore.

No Express browser session is required by the plugin.

Auth0 logout is not implemented. Logging the user out of Apollo does not automatically create an Auth0 RP-Initiated Logout request; that requires separate integration.
