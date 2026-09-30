/**
 * Tweaks tool handlers — list_tweaks / get_tweak / create_tweak / update_tweak /
 * delete_tweak.
 *
 * All storage logic (slug generation, file writes) happens behind
 * the injected ctx.tweaks callbacks, where the tweak primitives live — this package must
 * stay free of @craft-agent/shared (same rule as create_task).
 *
 * Exporting is deliberately **not** one of these. It writes an extension into a folder a
 * person chooses, which is a decision of theirs and not something an agent can reason about;
 * the app's own tweak page has that action (see `apps/electron/resources/docs/tweaks.md`).
 */

import type {
  SessionToolContext,
  CreateTweakToolInput,
  UpdateTweakToolPatch,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const TWEAKS_UNAVAILABLE = 'Tweaks tools are not available in this context.';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// ============================================================
// list_tweaks
// ============================================================

export async function handleListTweaks(ctx: SessionToolContext, _args: unknown): Promise<ToolResult> {
  if (!ctx.tweaks) return errorResponse(TWEAKS_UNAVAILABLE);

  try {
    const tweaks = await ctx.tweaks.listTweaks();
    return successResponse(JSON.stringify({ total: tweaks.length, tweaks }, null, 2));
  } catch (error) {
    return errorResponse(`Failed to list tweaks: ${toError(error)}`);
  }
}

// ============================================================
// get_tweak
// ============================================================

export interface GetTweakArgs {
  slug: string;
}

export async function handleGetTweak(ctx: SessionToolContext, args: GetTweakArgs): Promise<ToolResult> {
  if (!ctx.tweaks) return errorResponse(TWEAKS_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const tweak = await ctx.tweaks.getTweak(args.slug);
    if (!tweak) {
      return errorResponse(`Tweak not found: ${args.slug}. Use list_tweaks to see what exists.`);
    }
    return successResponse(JSON.stringify(tweak, null, 2));
  } catch (error) {
    return errorResponse(`Failed to get tweak: ${toError(error)}`);
  }
}

// ============================================================
// create_tweak
// ============================================================

export type CreateTweakArgs = CreateTweakToolInput;

export async function handleCreateTweak(ctx: SessionToolContext, args: CreateTweakArgs): Promise<ToolResult> {
  if (!ctx.tweaks) return errorResponse(TWEAKS_UNAVAILABLE);
  if (!args.name?.trim()) return errorResponse('name is required.');
  if (!Array.isArray(args.matches) || args.matches.length === 0) {
    return errorResponse(
      'matches is required — at least one Chrome match pattern for the pages this tweak is for, e.g. "*://*.example.com/admin/*".',
    );
  }

  try {
    const tweak = await ctx.tweaks.createTweak(args);
    return successResponse(JSON.stringify(tweak, null, 2));
  } catch (error) {
    return errorResponse(`Failed to create tweak: ${toError(error)}`);
  }
}

// ============================================================
// update_tweak
// ============================================================

export interface UpdateTweakArgs extends UpdateTweakToolPatch {
  slug: string;
}

export async function handleUpdateTweak(ctx: SessionToolContext, args: UpdateTweakArgs): Promise<ToolResult> {
  if (!ctx.tweaks) return errorResponse(TWEAKS_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  const hasChanges = Object.keys(patch).some((key) => (patch as Record<string, unknown>)[key] !== undefined);
  if (!hasChanges) {
    return errorResponse('Nothing to update — provide at least one of name, description, matches, enabled.');
  }

  try {
    const tweak = await ctx.tweaks.updateTweak(slug, patch);
    return successResponse(JSON.stringify(tweak, null, 2));
  } catch (error) {
    return errorResponse(`Failed to update tweak: ${toError(error)}`);
  }
}

// ============================================================
// delete_tweak
// ============================================================

export interface DeleteTweakArgs {
  slug: string;
}

export async function handleDeleteTweak(ctx: SessionToolContext, args: DeleteTweakArgs): Promise<ToolResult> {
  if (!ctx.tweaks) return errorResponse(TWEAKS_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const result = await ctx.tweaks.deleteTweak(args.slug);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to delete tweak: ${toError(error)}`);
  }
}
