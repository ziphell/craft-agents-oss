/**
 * Designs tool handlers — list_designs / get_design / create_design / update_design /
 * write_design_data / delete_design.
 *
 * All storage logic (slug generation, digests, SQLite writes, watcher
 * notifications, unpublish-on-delete) happens behind the injected ctx.designs
 * callbacks where the design primitives live — this package must stay
 * dependency-free of @craft-agent/shared (same rule as create_task).
 */

import type {
  SessionToolContext,
  CreateDesignToolInput,
  UpdateDesignToolPatch,
  DesignDataToolPatch,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const PAGES_UNAVAILABLE =
  'Designs tools are not available in this context.';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// ============================================================
// list_designs
// ============================================================

export interface ListDesignsArgs {
  projectId?: string;
}

export async function handleListDesigns(
  ctx: SessionToolContext,
  args: ListDesignsArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);

  try {
    let designs = await ctx.designs.listDesigns();
    if (args.projectId !== undefined) {
      designs = designs.filter(design => design.projectId === args.projectId);
    }
    return successResponse(JSON.stringify({ total: designs.length, designs }, null, 2));
  } catch (error) {
    return errorResponse(`Failed to list designs: ${toError(error)}`);
  }
}

// ============================================================
// get_design
// ============================================================

export interface GetDesignArgs {
  slug: string;
  includeContent?: boolean;
}

export async function handleGetDesign(
  ctx: SessionToolContext,
  args: GetDesignArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const design = await ctx.designs.getDesign(args.slug, { includeContent: args.includeContent === true });
    if (!design) {
      return errorResponse(`Design not found: ${args.slug}. Use list_designs to see available designs.`);
    }
    return successResponse(JSON.stringify(design, null, 2));
  } catch (error) {
    return errorResponse(`Failed to get design: ${toError(error)}`);
  }
}

// ============================================================
// create_design
// ============================================================

export type CreateDesignArgs = CreateDesignToolInput;

export async function handleCreateDesign(
  ctx: SessionToolContext,
  args: CreateDesignArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.name?.trim()) return errorResponse('name is required.');

  try {
    const design = await ctx.designs.createDesign(args);
    return successResponse(JSON.stringify(design, null, 2));
  } catch (error) {
    return errorResponse(`Failed to create design: ${toError(error)}`);
  }
}

// ============================================================
// update_design
// ============================================================

export interface UpdateDesignArgs extends UpdateDesignToolPatch {
  slug: string;
}

export async function handleUpdateDesign(
  ctx: SessionToolContext,
  args: UpdateDesignArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  const hasChanges = Object.keys(patch).some(key => (patch as Record<string, unknown>)[key] !== undefined);
  if (!hasChanges) {
    return errorResponse('Nothing to update — provide at least one of name, description, projectId, content, refresh, deck, motion.');
  }

  try {
    const design = await ctx.designs.updateDesign(slug, patch);
    return successResponse(JSON.stringify(design, null, 2));
  } catch (error) {
    return errorResponse(`Failed to update design: ${toError(error)}`);
  }
}

// ============================================================
// write_design_data
// ============================================================

export interface WriteDesignDataArgs extends DesignDataToolPatch {
  slug: string;
}

export async function handleWriteDesignData(
  ctx: SessionToolContext,
  args: WriteDesignDataArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  try {
    const result = await ctx.designs.writeDesignData(slug, patch);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to write design data: ${toError(error)}`);
  }
}

// ============================================================
// delete_design
// ============================================================

export interface DeleteDesignArgs {
  slug: string;
}

export async function handleDeleteDesign(
  ctx: SessionToolContext,
  args: DeleteDesignArgs
): Promise<ToolResult> {
  if (!ctx.designs) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const result = await ctx.designs.deleteDesign(args.slug);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to delete design: ${toError(error)}`);
  }
}
