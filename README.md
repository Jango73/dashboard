# Dashboard

[![Build](https://github.com/Jango73/dashboard/actions/workflows/build.yml/badge.svg)](https://github.com/Jango73/dashboard/actions/workflows/build.yml)

Terminal dashboard engine (Node.js + `blessed`). The engine lives here, each host project keeps its own `dashboard.json` beside its scripts.

## Mounting

Add the submodule at `dashboard/` in the host project (or `backend/dashboard/` when the dashboard configuration lives in `backend/`):

```sh
git submodule add -b main git@github.com:Jango73/dashboard.git dashboard
```

The host project must provide the runtime dependencies (`blessed`, `tail`, `kill-port`, see `package.json`) through its own `npm install`, and a `dashboard.json` in its working directory. Launch from the project root so the engine finds the project configuration:

```sh
./dashboard/dashboard.sh
```

Keep a thin `./dashboard.sh` shim at the project root when existing shortcuts or documentation reference it.

## `dashboard.json` format

```json
{
    "scriptsDir": "scripts",
    "commandSets": [
        { "name": "<set name>", "commands": [
            { "label": "<display label>", "script": "<script file>", "key": "<optional key>", "promptCwd": false, "danger": false, "disabled": false, "description": "<optional footer text>" }
        ] }
    ],
    "settings": { "enableCommandHistory": true, "persistLogs": false, "logDir": "log", "notifyOnExit": true, "showCustomCommand": true, "showLogWindow": false, "renderThrottleMs": 100, "maxLogLines": 1000, "sidebarMinWidth": 32 },
    "events": {
        "onDashboardStart": [],
        "beforeStartProcess": [
            { "script": "<script file name, including extension>", "actions": [
                { "action": "killProcess" | "closeTCPPorts" | "closeUDPPorts", "parameters": [ "..." ] }
            ] }
        ]
    }
}
```

Legacy top-level `commands` (plain list) and `keyBindings` entries stay accepted. Per-command flags: `promptCwd` (aliases `cwdPrompt`, `askCwd`, `cwdRequired`) opens a folder selector before launch, `danger` renders the entry on a red background, `disabled` hides the entry from the sidebar, `description` shows a short text in the full-width footer while the entry is highlighted (empty when absent), `key` binds a shortcut written as whole words joined with `+` (`control+b`, `shift+a`, `alt+c`, `function+f1`, `escape`, `f5`). Separators use a label-only entry such as `{ "label": "--------" }`. `settings.logDir` sets the persisted-log directory relative to the working directory (`log` when absent), used only when `persistLogs` is true.
