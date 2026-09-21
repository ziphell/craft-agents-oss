/**
 * Websites tool handlers — list_websites / get_website / create_website /
 * update_website / write_website_data / delete_website.
 *
 * All storage logic (slug generation, digests, SQLite writes, watcher
 * notifications, unpublish-on-delete) happens behind the injected ctx.websites
 * callbacks where the website primitives live — this package must stay
 * dependency-free of @craft-agent/shared (same rule as create_task).
 */

import type {
  SessionToolContext,
  CreateWebsiteToolInput,
  UpdateWebsiteToolPatch,
  WebsiteDataToolPatch,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const WEBSITES_UNAVAILABLE =
  'Websites tools are not available in this context.';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// ============================================================
// list_websites
// ============================================================

export interface ListWebsitesArgs {
  projectId?: string;
}

export async function handleListWebsites(
  ctx: SessionToolContext,
  args: ListWebsitesArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);

  try {
    let websites = await ctx.websites.listWebsites();
    if (args.projectId !== undefined) {
      websites = websites.filter(website => website.projectId === args.projectId);
    }
    return successResponse(JSON.stringify({ total: websites.length, websites }, null, 2));
  } catch (error) {
    return errorResponse(`Failed to list websites: ${toError(error)}`);
  }
}

// ============================================================
// get_website
// ============================================================

export interface GetWebsiteArgs {
  slug: string;
  includeContent?: boolean;
}

export async function handleGetWebsite(
  ctx: SessionToolContext,
  args: GetWebsiteArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const website = await ctx.websites.getWebsite(args.slug, { includeContent: args.includeContent === true });
    if (!website) {
      return errorResponse(`Website not found: ${args.slug}. Use list_websites to see available websites.`);
    }
    return successResponse(JSON.stringify(website, null, 2));
  } catch (error) {
    return errorResponse(`Failed to get website: ${toError(error)}`);
  }
}

// ============================================================
// create_website
// ============================================================

export type CreateWebsiteArgs = CreateWebsiteToolInput;

export async function handleCreateWebsite(
  ctx: SessionToolContext,
  args: CreateWebsiteArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);
  if (!args.name?.trim()) return errorResponse('name is required.');

  try {
    const website = await ctx.websites.createWebsite(args);
    return successResponse(JSON.stringify(website, null, 2));
  } catch (error) {
    return errorResponse(`Failed to create website: ${toError(error)}`);
  }
}

// ============================================================
// update_website
// ============================================================

export interface UpdateWebsiteArgs extends UpdateWebsiteToolPatch {
  slug: string;
}

export async function handleUpdateWebsite(
  ctx: SessionToolContext,
  args: UpdateWebsiteArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  const hasChanges = Object.keys(patch).some(key => (patch as Record<string, unknown>)[key] !== undefined);
  if (!hasChanges) {
    return errorResponse('Nothing to update — provide at least one of name, description, kind, projectId, content, refresh.');
  }

  try {
    const website = await ctx.websites.updateWebsite(slug, patch);
    return successResponse(JSON.stringify(website, null, 2));
  } catch (error) {
    return errorResponse(`Failed to update website: ${toError(error)}`);
  }
}

// ============================================================
// write_website_data
// ============================================================

export interface WriteWebsiteDataArgs extends WebsiteDataToolPatch {
  slug: string;
}

export async function handleWriteWebsiteData(
  ctx: SessionToolContext,
  args: WriteWebsiteDataArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  try {
    const result = await ctx.websites.writeWebsiteData(slug, patch);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to write website data: ${toError(error)}`);
  }
}

// ============================================================
// delete_website
// ============================================================

export interface DeleteWebsiteArgs {
  slug: string;
}

export async function handleDeleteWebsite(
  ctx: SessionToolContext,
  args: DeleteWebsiteArgs
): Promise<ToolResult> {
  if (!ctx.websites) return errorResponse(WEBSITES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const result = await ctx.websites.deleteWebsite(args.slug);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to delete website: ${toError(error)}`);
  }
}
