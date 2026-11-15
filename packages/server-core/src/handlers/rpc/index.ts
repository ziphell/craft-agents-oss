import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

import { registerAuthHandlers } from './auth'
import { registerBotHandlers } from './bot'
import { registerAutomationsHandlers } from './automations'
import { registerBrowserProfileHandlers } from './browser-profiles'
import { registerDecisionsHandlers } from './decisions'
import { registerFilesHandlers } from './files'
import { registerMediaHandlers } from './media'
import { registerAsrHandlers } from './asr'
import { registerImgHandlers } from './img'
import { registerLabelsHandlers } from './labels'
import { registerLlmConnectionsHandlers } from './llm-connections'
import { registerOAuthHandlers } from './oauth'
import { registerResourcesHandlers } from './resources'
import { registerOnboardingHandlers } from './onboarding'
import { registerSessionsHandlers } from './sessions'
export { registerSessionsHandlers, cleanupSessionFileWatchForClient } from './sessions'
import { registerCanvasHandlers } from './canvas'
import { registerProjectFilesHandlers } from './project-files'
export { registerProjectFilesHandlers, cleanupProjectFilesWatchForClient } from './project-files'
import { registerServerHandlers } from './server'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
export type { ServerHandlerContext } from '../../bootstrap/headless-start'
export { getHealthCheck } from './server'
import { registerSettingsHandlers } from './settings'
import { registerProjectsHandlers } from './projects'
import { registerDrawioHandlers } from './drawio'
import { registerOfficeHandlers } from './office'
import { registerTweaksHandlers } from './tweaks'
import { registerCreationsHandlers } from './creations'
import { registerSkillsHandlers } from './skills'
import { registerSourcesHandlers } from './sources'
import { registerStatusesHandlers } from './statuses'
import { registerSystemCoreHandlers } from './system'
import { registerTasksHandlers } from './tasks'
import { registerTransferHandlers } from './transfer'
import { registerWorkspaceCoreHandlers } from './workspace'
import { registerMessagingHandlers } from './messaging'

export function registerCoreRpcHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  serverCtx?: ServerHandlerContext,
): void {
  registerAuthHandlers(server, deps)
  registerBotHandlers(server, deps)
  registerAutomationsHandlers(server, deps)
  registerBrowserProfileHandlers(server, deps)
  registerDecisionsHandlers(server, deps)
  registerFilesHandlers(server, deps)
  registerMediaHandlers(server, deps)
  registerAsrHandlers(server, deps)
  registerImgHandlers(server, deps)
  registerLabelsHandlers(server, deps)
  registerLlmConnectionsHandlers(server, deps)
  registerOAuthHandlers(server, deps)
  registerOnboardingHandlers(server, deps)
  registerResourcesHandlers(server, deps)
  registerSessionsHandlers(server, deps)
  registerProjectFilesHandlers(server, deps)
  registerCanvasHandlers(server, deps)
  if (serverCtx) registerServerHandlers(server, deps, serverCtx)
  registerSettingsHandlers(server, deps)
  registerProjectsHandlers(server, deps)
  registerDrawioHandlers(server, deps)
  registerOfficeHandlers(server, deps)
  registerTweaksHandlers(server, deps)
  registerCreationsHandlers(server, deps)
  registerSkillsHandlers(server, deps)
  registerSourcesHandlers(server, deps)
  registerStatusesHandlers(server, deps)
  registerSystemCoreHandlers(server, deps)
  registerTasksHandlers(server, deps)
  registerTransferHandlers(server)
  registerWorkspaceCoreHandlers(server, deps)
  registerMessagingHandlers(server, deps)
}
