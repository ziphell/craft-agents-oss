import { getNetworkProxySettings } from './storage.ts';

/**
 * Proxy env vars for the operating system's proxy, as resolved by the host.
 *
 * Resolving the OS proxy needs Chromium (`session.resolveProxy`), which only the
 * Electron main process has, so it resolves and pushes the answer here. Empty
 * when nothing was resolved — including on runtimes that never resolve anything,
 * such as the server, where `system` mode simply means the subprocess decides.
 */
let systemProxyEnv: Record<string, string> = {};

export function setSystemProxyEnv(env: Record<string, string>): void {
  systemProxyEnv = env;
}

/**
 * Convert stored proxy settings into environment variables for subprocesses.
 * Returns an empty object unless a proxy is in play: under `direct` there is
 * nothing to route through, and under `system` the address comes from the host
 * (see {@link setSystemProxyEnv}).
 */
export function getProxyEnvVars(): Record<string, string> {
  const settings = getNetworkProxySettings();
  if (settings?.mode === 'system') return { ...systemProxyEnv };
  if (settings?.mode !== 'custom') return {};

  const env: Record<string, string> = {};
  if (settings.httpProxy) {
    env.HTTP_PROXY = settings.httpProxy;
    env.http_proxy = settings.httpProxy;
  }
  if (settings.httpsProxy) {
    env.HTTPS_PROXY = settings.httpsProxy;
    env.https_proxy = settings.httpsProxy;
  }
  if (settings.noProxy) {
    env.NO_PROXY = settings.noProxy;
    env.no_proxy = settings.noProxy;
  }
  return env;
}
