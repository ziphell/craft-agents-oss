/**
 * Network proxy manager — configures both Node.js (undici) and Electron session proxies.
 *
 * - Electron side: calls session.setProxy() on default + browser-pane sessions,
 *   connecting directly, following the operating system's proxy settings, or
 *   using the configured ones.
 * - Node side: replaces the global undici dispatcher with a ProtocolProxyDispatcher
 *   that routes HTTP/HTTPS through different ProxyAgent instances and respects NO_PROXY.
 *   Node has no OS proxy discovery of its own, so under `system` the OS answer is
 *   read with session.resolveProxy() and handed over — see resolveSystemProxy() —
 *   and re-read on a timer, because Node gets no notification when it moves.
 */

import { app, session } from 'electron';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { parseNoProxyRules, parseResolvedProxy, shouldBypassProxy, splitCommaSeparated, type NoProxyRule } from './network-proxy-utils';
import { getLlmConnections, getNetworkProxySettings, setNetworkProxySettings } from '@craft-agent/shared/config/storage';
import { setSystemProxyEnv } from '@craft-agent/shared/config/proxy-env';
import type { NetworkProxySettings } from '@craft-agent/shared/config/types';
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager';
import log from './logger';

/** The proxy a request should take, already narrowed to one address. */
interface EffectiveProxy {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

// Track the current dispatcher so we can close it when reconfiguring
let currentProxyDispatcher: Dispatcher | null = null;

// The last OS answer handed to Node, and the timer that re-reads it.
let lastSystemProxy: SystemProxy | undefined;
let systemProxyPoll: ReturnType<typeof setInterval> | null = null;
let resolvingSystemProxy = false;

/**
 * Custom undici Dispatcher that routes requests through proxy agents based on protocol,
 * bypasses proxied destinations listed in NO_PROXY rules, and falls back to a direct Agent.
 */
class ProtocolProxyDispatcher extends Dispatcher {
  private httpProxy: ProxyAgent | null;
  private httpsProxy: ProxyAgent | null;
  private direct: Agent;
  private rules: NoProxyRule[];

  constructor(opts: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }) {
    super();
    this.httpProxy = opts.httpProxy ? new ProxyAgent(opts.httpProxy) : null;
    this.httpsProxy = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : null;
    this.direct = new Agent();
    this.rules = parseNoProxyRules(opts.noProxy);
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();

    // If URL matches bypass rules, go direct
    if (url && shouldBypassProxy(url, this.rules)) {
      return this.direct.dispatch(opts, handler);
    }

    // Route based on protocol
    const isHttps = url?.startsWith('https:');
    const proxy = isHttps ? (this.httpsProxy ?? this.httpProxy) : this.httpProxy;

    if (proxy) {
      return proxy.dispatch(opts, handler);
    }

    return this.direct.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
      this.direct.close(),
    ]);
  }

  async destroy(): Promise<void> {
    await Promise.all([
      this.httpProxy?.destroy(),
      this.httpsProxy?.destroy(),
      this.direct.destroy(),
    ]);
  }
}

/**
 * Configure the Node.js global undici dispatcher for proxy routing.
 */
function configureNodeProxy(proxy: EffectiveProxy | undefined): void {
  // Close previous dispatcher (proxy or direct — both are tracked)
  if (currentProxyDispatcher) {
    currentProxyDispatcher.close().catch(() => {});
    currentProxyDispatcher = null;
  }

  if (!proxy || (!proxy.httpProxy && !proxy.httpsProxy)) {
    // Restore a direct dispatcher and track it so next reconfigure can close it
    const direct = new Agent();
    setGlobalDispatcher(direct);
    currentProxyDispatcher = direct;
    return;
  }

  const dispatcher = new ProtocolProxyDispatcher({
    httpProxy: proxy.httpProxy,
    httpsProxy: proxy.httpsProxy,
    noProxy: proxy.noProxy,
  });

  setGlobalDispatcher(dispatcher);
  currentProxyDispatcher = dispatcher;
}

/**
 * Configure Electron session proxies (default session + browser-pane partition).
 * Requires app to be ready.
 */
async function configureElectronProxy(settings: NetworkProxySettings | undefined): Promise<void> {
  if (!app.isReady()) return;

  // `direct` and `system` are Chromium's own modes: one never proxies, the other
  // asks the operating system.
  const proxyConfig: Electron.ProxyConfig = settings?.mode === 'custom'
    ? buildElectronProxyConfig(settings)
    : { mode: settings?.mode === 'system' ? 'system' : 'direct' };

  const sessions = [
    session.defaultSession,
    session.fromPartition(BROWSER_PANE_SESSION_PARTITION),
  ];

  await Promise.all(sessions.map(ses => ses.setProxy(proxyConfig)));
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  const rules: string[] = [];

  if (settings.httpsProxy) {
    rules.push(`https=${settings.httpsProxy}`);
  }
  if (settings.httpProxy) {
    rules.push(`http=${settings.httpProxy}`);
  }

  // Custom mode with nothing to route through is a direct connection, not a
  // silently ignored setting.
  if (rules.length === 0) {
    return { mode: 'direct' };
  }

  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    proxyBypassRules: settings.noProxy
      ? splitCommaSeparated(settings.noProxy).join(',')
      : undefined,
  };
}

/**
 * Hosts that must never go through a proxy — a proxy is the one thing they cannot be.
 * Spelled the way a URL spells them, because that is what they get matched against.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Where we ask the operating system what it would do.
 *
 * The configured LLM endpoints come first: those are the requests that have to
 * work. One address for the rest — if the OS has a proxy for external traffic at
 * all, any outside host answers the same way.
 */
const SYSTEM_PROXY_PROBE_FALLBACK = 'https://api.anthropic.com/';

function systemProxyProbeUrls(): string[] {
  const configured = getLlmConnections()
    .map((connection) => connection.baseUrl)
    .filter((url): url is string => !!url && url.startsWith('https://'));

  return [...new Set([...configured, SYSTEM_PROXY_PROBE_FALLBACK])];
}

interface SystemProxy {
  /** The proxy to hand to Node, when the OS says there is one. */
  url?: string;
  /** Comma-separated hosts to keep out of it. */
  noProxy: string;
}

/**
 * Ask the OS the same question Chromium asks for its own sessions, and turn the
 * answer into something Node can act on.
 *
 * A probe that resolves DIRECT is recorded as a bypass rather than ignored: when
 * one endpoint is proxied and another is not, that difference is the OS's own
 * per-host routing, and Node only has one proxy to give it.
 *
 * Must run while the session is already in `system` mode, otherwise it answers
 * for whatever the session was last told instead of for the operating system.
 */
async function resolveSystemProxy(): Promise<SystemProxy> {
  const noProxy = [...LOOPBACK_HOSTS];
  let url: string | undefined;
  let unsupported: string | undefined;

  for (const probe of systemProxyProbeUrls()) {
    let answer: string;
    try {
      answer = await session.defaultSession.resolveProxy(probe);
    } catch (err) {
      log.debug(`[proxy] resolveProxy failed for ${probe}: ${String(err)}`);
      continue;
    }

    const rule = parseResolvedProxy(answer);
    if (rule?.kind === 'proxy') {
      url ??= rule.url;
    } else if (rule?.kind === 'direct') {
      noProxy.push(new URL(probe).hostname);
    } else if (rule?.kind === 'unsupported') {
      unsupported = rule.scheme;
    }
  }

  if (unsupported && !url) {
    log.info(`[proxy] system proxy is ${unsupported} — Chromium uses it, Node side goes direct`);
  }

  return { url, noProxy: noProxy.join(',') };
}

/** The env a subprocess needs to take the same route Node does. */
function buildSystemProxyEnv(system: SystemProxy): Record<string, string> {
  if (!system.url) return {};

  return {
    HTTP_PROXY: system.url,
    http_proxy: system.url,
    HTTPS_PROXY: system.url,
    https_proxy: system.url,
    NO_PROXY: system.noProxy,
    no_proxy: system.noProxy,
  };
}

/** Hand an OS answer to the Node side — both the in-process dispatcher and subprocesses. */
function applySystemProxyToNode(system: SystemProxy | undefined): void {
  configureNodeProxy(
    system?.url ? { httpProxy: system.url, httpsProxy: system.url, noProxy: system.noProxy } : undefined,
  );
  setSystemProxyEnv(system ? buildSystemProxyEnv(system) : {});
}

/**
 * How often the OS answer is re-read while `system` mode is on.
 *
 * Chromium keeps its own sessions current by itself; Node has to be told, and the
 * answer moves when a VPN connects, a laptop joins another network, or an admin
 * pushes new settings. A minute is far below the time it takes anyone to notice,
 * and a few resolveProxy() calls cost nothing.
 */
const SYSTEM_PROXY_POLL_MS = 60_000;

function sameSystemProxy(a: SystemProxy | undefined, b: SystemProxy | undefined): boolean {
  return a?.url === b?.url && a?.noProxy === b?.noProxy;
}

function stopSystemProxyPolling(): void {
  if (systemProxyPoll) {
    clearInterval(systemProxyPoll);
    systemProxyPoll = null;
  }
}

function startSystemProxyPolling(): void {
  if (!app.isReady() || systemProxyPoll) return;
  systemProxyPoll = setInterval(() => void refreshSystemProxy(), SYSTEM_PROXY_POLL_MS);
}

/**
 * Re-read the OS answer and only touch Node when it actually changed: replacing
 * the dispatcher drops pooled connections, which is not something to do for an
 * answer that stayed the same.
 */
async function refreshSystemProxy(): Promise<void> {
  if (resolvingSystemProxy) return;
  if (getNetworkProxySettings()?.mode !== 'system') {
    stopSystemProxyPolling();
    return;
  }

  resolvingSystemProxy = true;
  try {
    const system = await resolveSystemProxy();
    if (sameSystemProxy(system, lastSystemProxy)) return;

    log.info('[proxy] system proxy changed:', { proxy: !!system.url, bypass: system.noProxy });
    lastSystemProxy = system;
    applySystemProxyToNode(system);
  } catch (err) {
    log.debug(`[proxy] system proxy refresh failed: ${String(err)}`);
  } finally {
    resolvingSystemProxy = false;
  }
}

/**
 * Read persisted proxy settings and apply to both Node and Electron.
 * Safe to call before app.whenReady() — Electron session setup is skipped until ready.
 */
export async function applyConfiguredProxySettings(): Promise<void> {
  const settings = getNetworkProxySettings();
  const mode = settings?.mode ?? 'direct';

  // Sessions first: `system` resolution reads the session's own configuration,
  // so the session has to be in system mode before we ask it anything.
  await configureElectronProxy(settings);

  if (mode === 'system') {
    const system = app.isReady() ? await resolveSystemProxy() : undefined;
    log.info('[proxy] Applying proxy settings:', { mode, nodeProxy: !!system?.url });

    // The poll keeps this answer current; the baseline is what "changed" means.
    lastSystemProxy = system;
    startSystemProxyPolling();
    applySystemProxyToNode(system);
    return;
  }

  const nodeProxy: EffectiveProxy | undefined = mode === 'custom'
    ? { httpProxy: settings?.httpProxy, httpsProxy: settings?.httpsProxy, noProxy: settings?.noProxy }
    : undefined;

  log.info('[proxy] Applying proxy settings:', { mode, nodeProxy: !!nodeProxy });

  stopSystemProxyPolling();
  lastSystemProxy = undefined;
  configureNodeProxy(nodeProxy);
  setSystemProxyEnv({});
}

/**
 * Persist new proxy settings and apply immediately.
 */
export async function updateConfiguredProxySettings(settings: NetworkProxySettings): Promise<void> {
  setNetworkProxySettings(settings);
  await applyConfiguredProxySettings();
}
