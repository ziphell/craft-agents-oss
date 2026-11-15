@echo off
rem ical-tool — see apps\electron\resources\cli-tools\ical-tool.ts. Bun, so no Python and no uv on any host.
if "%CRAFT_BUN%"=="" set "CRAFT_BUN=bun"
if "%CRAFT_CLI_TOOLS%"=="" set "CRAFT_CLI_TOOLS=%~dp0..\cli-tools\dist"
if not exist "%CRAFT_CLI_TOOLS%\ical-tool.mjs" (
  echo ical-tool: not built ^(run: bun run build:cli-tools^) 1>&2
  exit /b 2
)
"%CRAFT_BUN%" run "%CRAFT_CLI_TOOLS%\ical-tool.mjs" %*
