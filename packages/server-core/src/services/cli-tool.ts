/**
 * Running one of the bundled command-line tools from the server.
 *
 * The implementation moved to `@craft-agent/shared/utils/cli-tool` so the agent's own image path
 * (`call_llm`) could normalise a picture without the server having to pass a callback through three
 * layers. This file stays as the server's entry point, so every existing import is unchanged.
 */

export { bunBinary, cliToolsDir, runCliTool } from '@craft-agent/shared/utils/cli-tool'
export type { CliRun } from '@craft-agent/shared/utils/cli-tool'
