/**
 * Mermaid Validate Handler
 *
 * Validates Mermaid diagram syntax using beautiful-mermaid renderer, plus the
 * app's own parser for mind maps (the one family beautiful-mermaid cannot read).
 * No DOM required - works identically in Claude and Codex.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { renderMermaidSVG } from 'beautiful-mermaid';
import { isMindmapSource, parseMindmap } from '@craft-agent/core/mermaid/mindmap';
import { normalizeMermaidSource } from '../validation.ts';

export interface MermaidValidateArgs {
  code: string;
  render?: boolean;
}

/**
 * Handle the mermaid_validate tool call.
 *
 * Uses renderMermaidSVG from beautiful-mermaid to validate the same diagram
 * families the renderer accepts, including xychart-beta. YAML frontmatter is
 * stripped before validation because it is metadata rather than diagram syntax.
 * If rendering succeeds, the diagram is valid. If rendering throws, returns the
 * error message.
 *
 * `mindmap` is the one family beautiful-mermaid cannot read, so it is checked with
 * the parser the app's own mindmap block draws from — the same code, so a source
 * that validates is one that draws.
 */
export async function handleMermaidValidate(
  _ctx: SessionToolContext,
  args: MermaidValidateArgs
): Promise<ToolResult> {
  const { code } = args;

  try {
    const normalized = normalizeMermaidSource(code);
    // renderMermaidSVG throws if syntax/layout is invalid. Use the renderer path
    // rather than parseMermaid(), which only understands flowchart/state syntax.
    if (isMindmapSource(normalized)) parseMindmap(normalized);
    else renderMermaidSVG(normalized);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          valid: true,
          message: 'Diagram syntax is valid',
        }, null, 2),
      }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown parse error';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          valid: false,
          error: errorMessage,
          suggestion: 'Check the syntax against ~/.craft-agent/docs/mermaid.md',
        }, null, 2),
      }],
      isError: true,
    };
  }
}
