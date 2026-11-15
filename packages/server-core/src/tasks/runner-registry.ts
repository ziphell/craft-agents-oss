/**
 * One Conductor per workspace, for everyone who needs to reach a run.
 *
 * It is a registry rather than a field on the tasks handlers because a runner holds **live runs
 * in memory**: two instances over one workspace would each think they were the only one, and the
 * second to start a task would dispatch a second copy of every node. So whoever asks first creates
 * it and everyone after gets that same object — the ordering between `tasks:run` and, say, a stop
 * requested from the assistant's workbench stops mattering.
 *
 * Keyed by workspace id: the host that creates the runner is the same `SessionManager` either
 * way, and the workspace root is resolved by the caller (a caller that cannot find its workspace
 * has no business creating a runner).
 */

import { TaskRunner, type ConductorSessionHost, type TaskRunnerDeps } from './TaskRunner'

const runners = new Map<string, TaskRunner>()

export interface TaskRunnerRequest {
  workspaceId: string
  workspaceRoot: string
  /** The session host: creates children, sets statuses, cancels work. */
  host: ConductorSessionHost
  /** Decision-model hooks, when the layer is on; absent means the runner re-asks as before. */
  decide?: TaskRunnerDeps['decide']
  classifyNodeOutcome?: TaskRunnerDeps['classifyNodeOutcome']
  pickRepairNodes?: TaskRunnerDeps['pickRepairNodes']
}

export function getTaskRunner(request: TaskRunnerRequest): TaskRunner {
  let runner = runners.get(request.workspaceId)
  if (!runner) {
    runner = new TaskRunner({
      host: request.host,
      workspaceId: request.workspaceId,
      workspaceRoot: request.workspaceRoot,
      decide: request.decide,
      classifyNodeOutcome: request.classifyNodeOutcome,
      pickRepairNodes: request.pickRepairNodes,
    })
    runners.set(request.workspaceId, runner)
  }
  return runner
}

/** Test-only: drop every runner, so a suite starts from an empty registry. */
export function __resetTaskRunnersForTests(): void {
  runners.clear()
}
