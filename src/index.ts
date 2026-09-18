import Plugin from '@jbrowse/core/Plugin'
import type PluginManager from '@jbrowse/core/PluginManager'
import type { Request } from 'express'

import Auth0AuthHandler from './auth0'
import type { AuthUser } from './auth0'

import { version } from '../package.json'

// Describe the two result types Apollo accepts from a custom auth handler.
interface CustomAuthHandler {
  message: string
  needsPopup: boolean
  handler: (
    request: Request,
    redirectUri?: string,
  ) => Promise<{ url: string } | AuthUser>
}

// Register the Auth0 authentication provider with Apollo.
export default class ApolloAuth0Login extends Plugin {
  // Expose plugin metadata to the JBrowse plugin manager.
  name = 'ApolloAuth0Login'
  version = version

  // Install the Apollo-specific authentication extension.
  apolloInstall(pluginManager: PluginManager) {
    // Read Auth0 and Apollo configuration from the process environment.
    const domain = process.env.AUTH0_DOMAIN
    const clientID = process.env.AUTH0_CLIENT_ID
    const clientSecret = process.env.AUTH0_CLIENT_SECRET
    const callbackURL = process.env.AUTH0_CALLBACK_URL

    // Allow the Auth0 login button text to be customized.
    const loginMessage =
      process.env.AUTH0_LOGIN_MESSAGE ||
      'Sign in with Auth0'

    // Do not register Auth0 when any required configuration is missing.
    if (!domain || !clientID || !clientSecret || !callbackURL) {
      return
    }


    // Create one long-lived handler so pending OAuth state survives the callback.
    const auth = new Auth0AuthHandler({
      domain,
      clientID,
      clientSecret,
      callbackURL,
    })

    // Register the Auth0 provider through Apollo's custom-auth extension point.
    pluginManager.addToExtensionPoint(
      'Apollo-RegisterCustomAuth',
      (
        customAuths: Map<string, CustomAuthHandler>,
      ) => {
        // Add the Auth0 login option displayed by Apollo.
        customAuths.set('auth0', {
          message: loginMessage,
          needsPopup: true,

          // Delegate both OAuth legs to the same Auth0 handler instance.
          handler: (
            request: Request,
            redirectUri?: string,
          ) => auth.login(
            request,
            redirectUri,
          ),
        })

        // Return the modified authentication-provider registry to Apollo.
        return customAuths
      },
    )
  }
}
