// Slack reads its client id at module load, so configure it before anything
// imports the Slack module. `.isolated.ts`: the root test script runs this file
// in its own process, because a shared module cache from another test file
// would already hold an unconfigured Slack module.
process.env.SLACK_OAUTH_CLIENT_ID = 'slack-test-client';
process.env.SLACK_OAUTH_CLIENT_SECRET = 'slack-test-secret';

import { describe, expect, it } from 'bun:test';
import { OAUTH_RELAY_CALLBACK_URL, isOAuthRelayState, decodeOAuthRelayState } from '../../auth/oauth-relay.ts';
import type { LoadedSource, FolderSourceConfig } from '../types.ts';

const { SourceCredentialManager } = await import('../credential-manager.ts');
const { SLACK_LEGACY_RELAY_CALLBACK_URL, slackLegacyRelayPortForReturnTo, slackLegacyRelayRedirectUri } = await import('../../auth/slack-oauth.ts');

function createSlackSource(): LoadedSource {
  return {
    config: {
      id: 'slack-id',
      slug: 'slack',
      name: 'Slack',
      type: 'api',
      provider: 'slack',
      enabled: true,
      api: {
        baseUrl: 'https://slack.com/api/',
        authType: 'oauth',
      },
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/test/sources/slack',
    workspaceRootPath: '/tmp/test',
    workspaceId: 'test-workspace',
  };
}

// Regression for craft-agents-oss#1068: since the generic OAuth relay was
// introduced, desktop Slack flows sent redirect_uri=https://thecraftagents.com/auth/callback,
// which the Slack app does not have registered, so Slack rejected the request
// before consent.
describe('slackLegacyRelayPortForReturnTo', () => {
  it('accepts the desktop callback server target', () => {
    expect(slackLegacyRelayPortForReturnTo('http://localhost:6477/callback')).toBe(6477);
    expect(slackLegacyRelayPortForReturnTo('http://127.0.0.1:8914/callback')).toBe(8914);
  });

  it('rejects targets the legacy relay cannot serve', () => {
    expect(slackLegacyRelayPortForReturnTo('https://ghalmos.craftdocs-cf-t1.com/api/oauth/callback')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo('http://localhost:6477/oauth/callback')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo('http://localhost/callback')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo('http://localhost:80/callback')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo('https://localhost:6477/callback')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo('not a url')).toBeUndefined();
    expect(slackLegacyRelayPortForReturnTo(undefined)).toBeUndefined();
  });

  it('builds the registered relay redirect for a port', () => {
    expect(slackLegacyRelayRedirectUri(6477)).toBe(`${SLACK_LEGACY_RELAY_CALLBACK_URL}?port=6477`);
  });
});

describe('SourceCredentialManager.prepareOAuth for Slack', () => {
  const credManager = new SourceCredentialManager();

  it('desktop flows use the registered Slack relay and no relay envelope', async () => {
    const result = await credManager.prepareOAuth(createSlackSource(), {
      callbackUrl: 'http://localhost:6477/callback',
    });

    expect(result.provider).toBe('slack');
    expect(result.redirectUri).toBe(`${SLACK_LEGACY_RELAY_CALLBACK_URL}?port=6477`);

    const authUrl = new URL(result.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`${SLACK_LEGACY_RELAY_CALLBACK_URL}?port=6477`);
    expect(authUrl.searchParams.get('client_id')).toBe('slack-test-client');
    // The worker forwards Slack's state untouched, so it must be the inner state itself.
    expect(authUrl.searchParams.get('state')).toBe(result.state);
    expect(isOAuthRelayState(result.state)).toBe(false);
  });

  it('desktop flows started with a callback port behave the same way', async () => {
    const result = await credManager.prepareOAuth(createSlackSource(), { callbackPort: 6480 });
    expect(result.redirectUri).toBe(`${SLACK_LEGACY_RELAY_CALLBACK_URL}?port=6480`);
  });

  it('WebUI flows keep the generic relay envelope', async () => {
    const returnTo = 'https://ghalmos.craftdocs-cf-t1.com/api/oauth/callback';
    const result = await credManager.prepareOAuth(createSlackSource(), { callbackUrl: returnTo });

    expect(result.redirectUri).toBe(OAUTH_RELAY_CALLBACK_URL);
    const authUrl = new URL(result.authUrl);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(OAUTH_RELAY_CALLBACK_URL);
    const outerState = authUrl.searchParams.get('state')!;
    expect(isOAuthRelayState(outerState)).toBe(true);
    expect(decodeOAuthRelayState(outerState)).toEqual({ returnTo, innerState: result.state });
  });
});
