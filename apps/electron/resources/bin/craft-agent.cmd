@echo off
set "CRAFT_BUN_BIN=%CRAFT_BUN%"
if "%CRAFT_BUN_BIN%"=="" set "CRAFT_BUN_BIN=bun"
set "CRAFT_COMMANDS_BIN=%CRAFT_COMMANDS_ENTRY%"
if "%CRAFT_COMMANDS_BIN%"=="" set "CRAFT_COMMANDS_BIN=%CRAFT_CLI_ENTRY%"
if "%CRAFT_CLI_JSON_ONLY%"=="" set "CRAFT_CLI_JSON_ONLY=1"
if not exist "%CRAFT_COMMANDS_BIN%" (
  echo craft-agent: this build has no craft-agent CLI ^(labels, sources, skills, automations, permissions, theme^). 1>&2
  echo   Looked for: %CRAFT_COMMANDS_BIN% 1>&2
  echo   Write those files directly instead - see the docs in ~/.craft-agent/docs/. 1>&2
  exit /b 2
)
"%CRAFT_BUN_BIN%" run "%CRAFT_COMMANDS_BIN%" %*
