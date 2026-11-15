/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @craft-agent/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';
import { isDecisionFeatureActive } from '../../../decisions/resolve.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

export function getSessionToolProxyDefs(hasProject?: boolean, hasDevices?: boolean): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
    // Same gate as the Claude path (session-scoped-tools.ts): advertise `decide`
    // only while the decision layer is on.
    includeDecide: isDecisionFeatureActive('decideTool'),
    // A conversation without a project is not offered media/library/cut tools.
    hasProject,
    // A hub that has never paired a machine is not offered the device door.
    hasDevices,
  });
}
