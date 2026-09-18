const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

// Require CI or the developer to provide a real Apollo3 source checkout.
const apolloRoot =
  process.env.APOLLO3_PATH

if (!apolloRoot) {
  throw new Error(
    'APOLLO3_PATH must point to a checked-out GMOD/Apollo3 repository',
  )
}

// Restrict the search to Apollo's real collaboration-server implementation.
const serverSource = path.join(
  apolloRoot,
  'packages',
  'apollo-collaboration-server',
  'src',
)

// Find the source file that implements Apollo's custom-auth extension point.
function findAuthenticationSource(directory) {
  for (
    const entry
    of fs.readdirSync(
      directory,
      {
        withFileTypes: true,
      },
    )
  ) {
    const filename = path.join(
      directory,
      entry.name,
    )

    // Search nested source directories recursively.
    if (entry.isDirectory()) {
      const match =
        findAuthenticationSource(
          filename,
        )

      if (match) {
        return match
      }

      continue
    }

    // Only inspect TypeScript implementation files.
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts')
    ) {
      continue
    }

    const source =
      fs.readFileSync(
        filename,
        'utf8',
      )

    // Identify the real Apollo authentication code by its extension point.
    if (
      source.includes(
        'Apollo-RegisterCustomAuth',
      )
    ) {
      return {
        filename,
        source,
      }
    }
  }

  return undefined
}

// Load the authentication implementation from the checked-out Apollo revision.
const authentication =
  findAuthenticationSource(
    serverSource,
  )

if (!authentication) {
  throw new Error(
    'Could not find Apollo-RegisterCustomAuth in apollo-collaboration-server',
  )
}

// Normalize whitespace so formatting-only Apollo changes do not break the test.
const normalized =
  authentication.source.replace(
    /\s+/g,
    ' ',
  )

// Verify Apollo still exposes the extension point used during plugin installation.
test('Apollo exposes Apollo-RegisterCustomAuth', () => {
  assert.match(
    authentication.source,
    /Apollo-RegisterCustomAuth/,
  )
})

// Verify Apollo still invokes a handler supplied by a custom auth provider.
test('Apollo invokes the registered custom authentication handler', () => {
  assert.match(
    normalized,
    /\.handler\s*\(/,
  )
})

// Verify the custom-auth result still supports redirect-style responses.
test('Apollo custom authentication supports URL redirects', () => {
  assert.match(
    normalized,
    /\burl\b/,
  )
})

// Verify authenticated custom providers still return Apollo user identity fields.
test('Apollo custom authentication consumes name and email', () => {
  assert.match(
    normalized,
    /\bname\b/,
  )

  assert.match(
    normalized,
    /\bemail\b/,
  )
})

// Verify Apollo still uses redirect_uri as part of its authentication completion.
test('Apollo authentication still consumes redirect_uri state', () => {
  assert.match(
    normalized,
    /\bredirect_uri\b/,
  )

  // The current plugin depends on Apollo preserving state across the auth callback.
  assert.match(
    normalized,
    /\bstate\b/,
  )
})

// Verify Apollo still parses authentication state before completing its redirect.
test('Apollo still parses callback state as structured data', () => {
  assert.match(
    normalized,
    /JSON\.parse\s*\(/,
  )

  // Require redirect_uri to occur near Apollo's state-handling implementation.
  assert.match(
    normalized,
    /JSON\.parse[\s\S]{0,1000}redirect_uri|redirect_uri[\s\S]{0,1000}JSON\.parse/,
  )
})

// Report exactly which upstream file was checked when CI output is inspected.
test('reports the real Apollo authentication source being tested', () => {
  assert.ok(
    authentication.filename.startsWith(
      serverSource,
    ),
  )

  console.log(
    `Apollo authentication contract: ${authentication.filename}`,
  )
})
