import fs from 'fs';
import path from 'path';
import { spawn, exec } from 'child_process';
import { Tail } from 'tail';
import kill from 'kill-port';
import {
    createCliRenderer,
    BoxRenderable,
    TextRenderable,
    SelectRenderable,
    SelectRenderableEvents,
    InputRenderable,
    InputRenderableEvents,
    ScrollBoxRenderable
} from '@opentui/core';
import {
    resolveCwdPromptFlag,
    resolveDangerFlag,
    resolveDescription,
    formatSidebarLabel,
    withGnomeTerminalWorkdir,
    resolveSpawnCwd,
    promptForWorkingDirectory,
    normalizeKeySpec,
    specMatchesKeyEvent,
    formatKeyLabel
} from './dashboard-ext.mjs';

/**
 * dashboard.json format:
 * {
 *   "logs": [ "<path>", ... ],
 *   "scriptsDir": "<relative path to scripts>",
 *   "keyBindings": { "<key>": "<script file>", ... },
 *   "commands": [
 *     "<script file>",
 *     { "label": "<display label>", "script": "<script file>", "key": "<optional key>", "promptCwd": false, "description": "<optional footer text>" },
 *     ...
 *   ],
 *   "commandSets": [
 *     { "name": "<set name>", "commands": [
 *       { "label": "<display label>", "script": "<script file>", "key": "<optional key>", "promptCwd": true, "description": "<optional footer text>" },
 *       ...
 *     ] }
 *   ],
 *   "settings": { ... },
 *   "events": {
 *     "onDashboardStart": [
 *       { "action": "killProcess" | "closeTCPPorts" | "closeUDPPorts", "parameters": [ ... ] },
 *       ...
 *     ],
 *     "beforeStartProcess": [
 *       {
 *         "script": "<script file name, including extension>",
 *         "actions": [
 *           { "action": "killProcess" | "closeTCPPorts" | "closeUDPPorts", "parameters": [ ... ] },
 *           ...
 *         ]
 *       },
 *       ...
 *     ]
 *   }
 * }
 *
 * Notes:
 * - Script matching uses the full file name (with extension).
 * - Actions available in both places: killProcess, closeTCPPorts, closeUDPPorts.
 * - For backward compatibility, legacy top-level keys `onDashboardStart` and
 *   `beforeStartProcess` (object map) are accepted and normalized into `events`.
 * - Per-command working directory prompt: set `promptCwd: true` (aliases
 *   accepted: `cwdPrompt`, `askCwd`, `cwdRequired`) on a command entry.
 *   When the entry is activated (list selection or key shortcut), a folder
 *   selector modal opens first; the chosen directory is used as `cwd` for
 *   the spawned process. Cancelling aborts the launch.
 * - Destructive entries render with a "! " marker: set `danger: true`
 *   on a command entry.
 * - Descriptive entries show a footer line when highlighted: set
 *   `description: "<short text>"` on a command entry. Entries without
 *   a description leave the footer empty.
 * - The persisted-log directory reads `settings.logDir` (relative to
 *   the working directory, `"log"` when absent): only used when
 *   `persistLogs` is true.
 * - Hidden entries never reach the sidebar: set `disabled: true`
 *   on a command entry.
 * - Key shortcuts use whole words joined with "+": "control+b", "shift+a",
 *   "alt+c", "function+f1", "control+shift+s", "escape", "f5".
 *   Words accepted: control/ctrl, shift, alt/meta, function/fn (F-keys only).
 *   Raw shorthand ("C-b", "S-a", "M-c") still works. Invalid specs bind
 *   nothing (the entry stays selectable from the list).
 */

const defaultSettings = {
    enableCommandHistory: true,
    persistLogs: true,
    notifyOnExit: true,
    showCustomCommand: true,
    showLogWindow: true,
    renderThrottleMs: 100,
    maxLogLines: 1000,
    logBatchSize: 50,
    maxQueuedLogLines: 2000,
    sidebarMinWidth: 32,
    logDir: 'log'
};

function parsePositiveInteger(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return undefined;
        return Math.floor(value);
    }
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeSettings(overrides) {
    const normalized = { ...defaultSettings };
    if (!overrides || typeof overrides !== 'object') {
        return normalized;
    }

    const booleanKeys = ['enableCommandHistory', 'persistLogs', 'notifyOnExit', 'showCustomCommand', 'showLogWindow'];
    for (const key of booleanKeys) {
        if (typeof overrides[key] === 'boolean') {
            normalized[key] = overrides[key];
        }
    }

    const positiveIntegerKeys = ['renderThrottleMs', 'maxLogLines', 'logBatchSize', 'maxQueuedLogLines', 'sidebarMinWidth'];
    for (const key of positiveIntegerKeys) {
        const parsed = parsePositiveInteger(overrides[key]);
        if (parsed !== undefined) {
            if (key === 'sidebarMinWidth') {
                normalized[key] = Math.max(parsed, 32);
                continue;
            }
            normalized[key] = parsed;
        }
    }

    if (typeof overrides.logDir === 'string' && overrides.logDir.trim() !== '') {
        normalized.logDir = overrides.logDir.trim();
    }

    return normalized;
}

let currentSettings = { ...defaultSettings };
const logQueues = new Map();
let renderer = null;

let logStream = null;

// interface LastCommand { kind: 'script' | 'custom'; value: string; cwd?: string }
let lastCommand = null;

// Throttle rendering to avoid performance issues with high-frequency log updates
let renderScheduled = false;
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const delay = currentSettings.renderThrottleMs ?? defaultSettings.renderThrottleMs;
    setTimeout(() => {
        renderScheduled = false;
        if (renderer) {
            try { renderer.requestRender(); } catch { /* ignore */ }
        }
    }, delay);
}

function requestRenderNow() {
    if (renderer) {
        try { renderer.requestRender(); } catch { /* ignore */ }
    }
}

function ensureLogQueue(textNode) {
    let entry = logQueues.get(textNode);
    if (!entry) {
        entry = { pending: [], processing: false, backlogDropped: false, lines: [] };
        logQueues.set(textNode, entry);
    }
    return entry;
}

function flushLogQueue(textNode) {
    const entry = logQueues.get(textNode);
    if (!entry) return;
    const batchSize = currentSettings.logBatchSize ?? defaultSettings.logBatchSize;
    const batch = entry.pending.splice(0, batchSize);
    if (entry.backlogDropped) {
        entry.lines.push('... [log backlog trimmed to keep dashboard responsive] ...');
        entry.backlogDropped = false;
    }
    for (const line of batch) {
        entry.lines.push(line);
    }
    const maxLines = currentSettings.maxLogLines ?? defaultSettings.maxLogLines;
    if (entry.lines.length > maxLines) {
        entry.lines = entry.lines.slice(entry.lines.length - maxLines);
        entry.lines[0] = '... [log cleared to prevent memory overflow] ...';
    }
    try {
        textNode.content = entry.lines.join('\n');
    } catch { /* ignore */ }
    scheduleRender();
    if (entry.pending.length > 0) {
        setImmediate(() => flushLogQueue(textNode));
    } else {
        entry.processing = false;
    }
}

function enqueueLogLine(textNode, line) {
    const entry = ensureLogQueue(textNode);
    entry.pending.push(line);
    const maxQueued = currentSettings.maxQueuedLogLines ?? defaultSettings.maxQueuedLogLines;
    if (entry.pending.length > maxQueued) {
        entry.pending = entry.pending.slice(entry.pending.length - maxQueued);
        entry.backlogDropped = true;
    }
    if (!entry.processing) {
        entry.processing = true;
        setImmediate(() => flushLogQueue(textNode));
    }
}

function initLogFile() {
    if (config.settings?.persistLogs !== true || logStream) return;
    const configured = currentSettings.logDir ?? defaultSettings.logDir;
    const logDir = path.resolve(process.cwd(), configured);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:]/g, '-');
    const filePath = path.join(logDir, `dash-${timestamp}.log`);
    logStream = fs.createWriteStream(filePath, { flags: 'a' });
}

function stopLogFile() {
    if (!logStream) return;
    logStream.end();
    logStream = null;
}

function loadConfig() {
    try {
        const cfgPath = path.join(process.cwd(), 'dashboard.json');
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const cfg = JSON.parse(raw);
        // Normalize legacy keys into events
        const legacyODS = cfg.onDashboardStart || [];
        const legacyBSP = cfg.beforeStartProcess || {};
        const inEvents = cfg.events || {};
        // Convert legacy object map { "scriptName": [actions] } -> array of { script, actions }
        const normalizeMapToArray = (m) => {
            if (!m || Array.isArray(m)) return Array.isArray(m) ? m : [];
            if (typeof m !== 'object') return [];
            return Object.entries(m).map(([script, actions]) => ({
                script,
                actions: Array.isArray(actions) ? actions : []
            }));
        };
        // Determine final events
        const events = {
            onDashboardStart: Array.isArray(inEvents.onDashboardStart) ? inEvents.onDashboardStart
                                : Array.isArray(legacyODS) ? legacyODS : [],
            beforeStartProcess: Array.isArray(inEvents.beforeStartProcess)
                                ? inEvents.beforeStartProcess
                                : normalizeMapToArray(legacyBSP)
        };
        const computedSettings = normalizeSettings(cfg.settings);
        currentSettings = computedSettings;
        return {
            ...cfg,
            events,
            settings: computedSettings
        };
    } catch {
        const fallbackSettings = normalizeSettings();
        currentSettings = fallbackSettings;
        return { settings: fallbackSettings, events: { onDashboardStart: [], beforeStartProcess: [] } };
    }
}


function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLogDate(s) {
    const iso = s.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    return new Date(iso).getTime();
}

function resolveLatest(p) {
    if (!p.includes('{{latest}}')) return p;

    const [before, after] = p.split('{{latest}}');
    const dir = path.dirname(before);
    const prefix = path.basename(before);
    const directory = path.resolve(dir || '.');

    try {
        const regex = new RegExp(`^${escapeRegex(prefix)}(\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}-\\d{2}-\\d{2})?)${escapeRegex(after)}$`);
        const entries = fs.readdirSync(directory)
            .map(name => {
                const match = name.match(regex);
                if (!match) return null;
                return { dateStr: match[1], timestamp: parseLogDate(match[1]) };
            })
            .filter((v) => v !== null)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (entries.length === 0) return path.join(dir, `${prefix}latest${after}`);

        return path.join(dir, `${prefix}${entries[0].dateStr}${after}`);
    } catch {
        return path.join(dir, `${prefix}latest${after}`);
    }
}

function resolveBindingLabel(binding) {
    if (typeof binding === 'object' && binding && typeof binding.label === 'string' && binding.label.trim() !== '') {
        return binding.label;
    }
    if (typeof binding === 'object' && binding && typeof binding.script === 'string' && binding.script.trim() !== '') {
        return binding.script;
    }
    if (typeof binding === 'string' && binding.trim() !== '') {
        return binding;
    }
    return '';
}

function resolveBindingScript(binding) {
    if (typeof binding === 'object' && binding && typeof binding.script === 'string') {
        const trimmed = binding.script.trim();
        return trimmed === '' ? '' : trimmed;
    }
    if (typeof binding === 'string') {
        const trimmed = binding.trim();
        return trimmed === '' ? '' : trimmed;
    }
    return '';
}

function normalizeSidebarEntries() {
    const entries = [];

    for (const [bindingKey, binding] of Object.entries(config.keyBindings ?? {})) {
        if (typeof binding === 'object' && binding && binding.disabled === true) {
            continue;
        }
        const displayLabel = resolveBindingLabel(binding);
        const script = resolveBindingScript(binding);
        const rawKey = String(bindingKey || '').trim();
        const keyName = normalizeKeySpec(rawKey);
        const keyText = formatKeyLabel(rawKey);
        const content = displayLabel !== '' ? displayLabel : rawKey;
        const danger = resolveDangerFlag(binding);
        entries.push({
            text: formatSidebarLabel(keyText !== '' ? `${keyText} - ${content}` : content, danger),
            label: displayLabel !== '' ? displayLabel : rawKey,
            script,
            keyName,
            rawKey,
            selectable: script !== '',
            promptCwd: resolveCwdPromptFlag(binding),
            danger,
            description: resolveDescription(binding)
        });
    }

    for (const command of (Array.isArray(config.commands) ? config.commands : [])) {
        if (typeof command === 'object' && command && command.disabled === true) {
            continue;
        }
        const displayLabel = resolveBindingLabel(command);
        const script = resolveBindingScript(command);
        const rawKey = (typeof command === 'object' && command && typeof command.key === 'string')
            ? command.key.trim()
            : '';
        const keyName = normalizeKeySpec(rawKey);
        const keyText = formatKeyLabel(rawKey);
        const fallbackLabel = script !== '' ? script : '(no command)';
        const danger = resolveDangerFlag(command);
        entries.push({
            text: formatSidebarLabel(keyText !== '' ? `${keyText} - ${displayLabel || fallbackLabel}` : `${displayLabel || fallbackLabel}`, danger),
            label: displayLabel || fallbackLabel,
            script,
            keyName,
            rawKey,
            selectable: script !== '',
            promptCwd: resolveCwdPromptFlag(command),
            danger,
            description: resolveDescription(command)
        });
    }

    return entries;
}

const config = loadConfig();

let currentCommandSetIndex = 0;

function getCurrentCommandSet() {
    const sets = Array.isArray(config.commandSets) ? config.commandSets : [];
    if (sets.length === 0) return { name: 'empty', commands: [] };
    return sets[currentCommandSetIndex] ?? sets[0];
}

function normalizeSidebarEntriesFromSet(commandSet) {
    const entries = [];

    for (const command of (Array.isArray(commandSet.commands) ? commandSet.commands : [])) {
        if (typeof command === 'object' && command && command.disabled === true) {
            continue;
        }
        const displayLabel = resolveBindingLabel(command);
        const script = resolveBindingScript(command);

        const rawKey = (typeof command === 'object' && command && typeof command.key === 'string')
            ? command.key.trim()
            : '';

        const keyName = normalizeKeySpec(rawKey);
        const keyText = formatKeyLabel(rawKey);
        const fallbackLabel = script !== '' ? script : '(no command)';

        const danger = resolveDangerFlag(command);
        entries.push({
            text: formatSidebarLabel(keyText !== '' ? `${keyText} - ${displayLabel || fallbackLabel}` : `${displayLabel || fallbackLabel}`, danger),
            label: displayLabel || fallbackLabel,
            script,
            keyName,
            rawKey,
            selectable: script !== '',
            promptCwd: resolveCwdPromptFlag(command),
            danger,
            description: resolveDescription(command)
        });
    }

    return entries;
}

let sidebarEntries = (Array.isArray(config.commandSets) && config.commandSets.length > 0)
    ? normalizeSidebarEntriesFromSet(getCurrentCommandSet())
    : normalizeSidebarEntries();

function buildSelectOptions(entries) {
    return entries.map((entry, index) => ({
        name: entry.text,
        description: entry.selectable ? entry.label : '',
        value: index
    }));
}

const dashboardTheme = {
    background: '#1a2f4d',
    panel: '#22436b',
    panelAlt: '#1f3a5d',
    text: '#e3edf9',
    border: '#7ea2cd',
    focus: '#c9ddf3',
    selected: '#4f7fb2',
    hover: '#3f6c9d'
};

function setOutputLabel(outputPanel, label) {
    try {
        outputPanel.title = ` ${label} `;
    } catch { /* ignore */ }
    requestRenderNow();
}

// interface LogWatcher { configPath: string; currentPath: string; text: TextRenderable; scroll: ScrollBoxRenderable; tail: Tail }
function startTail(file, textNode) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    const entry = ensureLogQueue(textNode);
    entry.pending = [];
    entry.processing = false;
    entry.backlogDropped = false;
    const tail = new Tail(file, {
        follow: true,
        useWatchFile: true,
        fsWatchOptions: { interval: 500 }
    });
    tail.on('line', (line) => {
        enqueueLogLine(textNode, line);
    });
    tail.on('error', (err) => {
        enqueueLogLine(textNode, `Tail error: ${err.message}`);
    });
    return tail;
}

async function main() {
    renderer = await createCliRenderer({
        exitOnCtrlC: false,
        backgroundColor: dashboardTheme.background
    });

    // --- Root layout (flex only, no absolute coordinates) ---
    const app = new BoxRenderable(renderer, {
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: dashboardTheme.background
    });
    renderer.root.add(app);

    const mainRow = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 0,
        flexDirection: 'row',
        backgroundColor: dashboardTheme.background
    });
    app.add(mainRow);

    const sidebarWidth = currentSettings.sidebarMinWidth ?? defaultSettings.sidebarMinWidth;
    const sidebarPanel = new BoxRenderable(renderer, {
        width: sidebarWidth,
        flexShrink: 0,
        flexDirection: 'column',
        border: true,
        title: 'Scripts',
        borderColor: dashboardTheme.border,
        backgroundColor: dashboardTheme.panel
    });
    mainRow.add(sidebarPanel);

    const sidebarSelect = new SelectRenderable(renderer, {
        flexGrow: 1,
        minHeight: 0,
        options: buildSelectOptions(sidebarEntries),
        backgroundColor: dashboardTheme.panel,
        textColor: dashboardTheme.text,
        selectedBackgroundColor: dashboardTheme.selected,
        selectedTextColor: dashboardTheme.text,
        showDescription: false
    });
    sidebarPanel.add(sidebarSelect);

    const rightCol = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: 'column',
        backgroundColor: dashboardTheme.panelAlt
    });
    mainRow.add(rightCol);

    const logsRow = new BoxRenderable(renderer, {
        flexGrow: 3,
        flexBasis: 0,
        minHeight: 0,
        flexDirection: 'row',
        gap: 1,
        backgroundColor: dashboardTheme.panelAlt
    });
    rightCol.add(logsRow);

    const bottomCol = new BoxRenderable(renderer, {
        flexGrow: 2,
        flexBasis: 0,
        minHeight: 0,
        flexDirection: 'column',
        gap: 1,
        backgroundColor: dashboardTheme.panelAlt
    });
    rightCol.add(bottomCol);

    const controlsRow = new BoxRenderable(renderer, {
        height: 3,
        flexShrink: 0,
        flexDirection: 'row',
        gap: 1,
        backgroundColor: dashboardTheme.panel
    });
    bottomCol.add(controlsRow);

    const stopBtn = new BoxRenderable(renderer, {
        width: 12,
        flexShrink: 0,
        border: true,
        backgroundColor: dashboardTheme.panel,
        borderColor: dashboardTheme.border,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        focusable: true
    });
    stopBtn.add(new TextRenderable(renderer, { content: 'Stop', fg: dashboardTheme.text, selectable: false }));
    controlsRow.add(stopBtn);

    const customWrap = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: 'column',
        border: true,
        title: ' Custom Command ',
        borderColor: dashboardTheme.border,
        backgroundColor: dashboardTheme.panel
    });
    controlsRow.add(customWrap);
    const inputBox = new InputRenderable(renderer, {
        flexGrow: 1,
        placeholder: '',
        backgroundColor: dashboardTheme.panel,
        textColor: dashboardTheme.text
    });
    customWrap.add(inputBox);

    const filterWrap = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 0,
        flexDirection: 'column',
        border: true,
        title: ' Output Filter ',
        borderColor: dashboardTheme.border,
        backgroundColor: dashboardTheme.panel
    });
    controlsRow.add(filterWrap);
    const filterBox = new InputRenderable(renderer, {
        flexGrow: 1,
        placeholder: '',
        backgroundColor: dashboardTheme.panel,
        textColor: dashboardTheme.text
    });
    filterWrap.add(filterBox);

    const outputPanel = new BoxRenderable(renderer, {
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 0,
        flexDirection: 'column',
        border: true,
        title: 'Process output',
        borderColor: dashboardTheme.border,
        backgroundColor: dashboardTheme.panel
    });
    bottomCol.add(outputPanel);
    const outputScroll = new ScrollBoxRenderable(renderer, {
        flexGrow: 1,
        minHeight: 0,
        stickyScroll: true,
        stickyStart: 'bottom',
        backgroundColor: dashboardTheme.panel
    });
    outputPanel.add(outputScroll);
    const outputText = new TextRenderable(renderer, { content: '', fg: dashboardTheme.text });
    outputScroll.add(outputText);

    const descPanel = new BoxRenderable(renderer, {
        height: 3,
        flexShrink: 0,
        flexDirection: 'column',
        border: true,
        title: ' Description ',
        borderColor: dashboardTheme.border,
        backgroundColor: dashboardTheme.panel
    });
    app.add(descPanel);
    const descText = new TextRenderable(renderer, { content: '', fg: dashboardTheme.text, selectable: false });
    descPanel.add(descText);

    // Modal layer: centered flex container, hidden unless a modal is open.
    // Shown by hiding mainRow/descPanel (visible flags only, flex intact).
    const modalLayer = new BoxRenderable(renderer, {
        flexGrow: 1,
        minHeight: 0,
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: dashboardTheme.background,
        visible: false
    });
    app.add(modalLayer);

    const outputHistory = [];
    const outputHistoryLimit = currentSettings.maxQueuedLogLines ?? defaultSettings.maxQueuedLogLines;
    let outputFilterValue = '';
    const OUTPUT_TRIM_MESSAGE = '... [log cleared to prevent memory overflow] ...';

    function storeOutputLine(line, writeToFile = true) {
        outputHistory.push(line);
        while (outputHistory.length > outputHistoryLimit) {
            outputHistory.shift();
        }
        if (writeToFile && logStream) {
            logStream.write(`[${new Date().toISOString()}] ${line}\n`);
        }
    }

    function refreshOutputDisplay() {
        const filter = outputFilterValue;
        const filtered = filter
            ? outputHistory.filter(line => line.includes(filter))
            : outputHistory.slice();

        const maxLines = currentSettings.maxLogLines ?? defaultSettings.maxLogLines;
        let linesToShow;
        if (!filter && filtered.length > maxLines) {
            linesToShow = filtered.slice(filtered.length - maxLines);
            if (linesToShow.length > 0) {
                linesToShow[0] = OUTPUT_TRIM_MESSAGE;
            }
        } else if (filtered.length > maxLines) {
            linesToShow = filtered.slice(filtered.length - maxLines);
        } else {
            linesToShow = filtered;
        }

        try {
            outputText.content = linesToShow.join('\n');
            outputScroll.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
        } catch { /* ignore */ }
        scheduleRender();
    }

    function appendOutputLines(message) {
        const normalized = String(message ?? '').replace(/\r/g, '');
        if (normalized === '') {
            storeOutputLine('');
        } else {
            const parts = normalized.split('\n');
            const hasTrailingNewline = normalized.endsWith('\n');
            for (let i = 0; i < parts.length; i++) {
                if (i === parts.length - 1 && parts[i] === '' && !hasTrailingNewline) {
                    continue;
                }
                storeOutputLine(parts[i]);
            }
        }
        refreshOutputDisplay();
    }

    function setOutputFilter(value) {
        const next = value ?? '';
        if (next === outputFilterValue) {
            refreshOutputDisplay();
            return;
        }
        outputFilterValue = next;
        refreshOutputDisplay();
    }

    initLogFile();

    function updateDescriptionFooter(index) {
        const entry = sidebarEntries[index ?? sidebarSelect.getSelectedIndex()];
        const text = entry && entry.selectable ? (entry.description ?? '') : '';
        try {
            descText.content = text;
        } catch { /* ignore */ }
        scheduleRender();
    }

    sidebarSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (index) => {
        updateDescriptionFooter(index);
    });
    updateDescriptionFooter(sidebarSelect.getSelectedIndex() ?? 0);

    function applyControlsLayout() {
        if (currentSettings.showCustomCommand === false) {
            customWrap.visible = false;
        } else {
            customWrap.visible = true;
        }
        scheduleRender();
    }

    function applyRightLayout() {
        if (currentSettings.showLogWindow === false) {
            logsRow.visible = false;
        } else {
            logsRow.visible = logsRow.getChildrenCount() > 0;
        }
        scheduleRender();
    }

    // NOTE: no absolute-coordinate sidebar math: the sidebar keeps a fixed
    // flex width, the right column grows. Yoga handles terminal resizes.

    const logTexts = [];
    const logScrolls = [];
    const logWatchers = [];
    (config.logs ?? []).forEach((cfgPath) => {
        const resolved = resolveLatest(cfgPath);
        const logPanel = new BoxRenderable(renderer, {
            flexGrow: 1,
            flexBasis: 0,
            minWidth: 0,
            flexDirection: 'column',
            border: true,
            title: path.basename(resolved),
            borderColor: dashboardTheme.border,
            backgroundColor: dashboardTheme.panel
        });
        logsRow.add(logPanel);
        const scroll = new ScrollBoxRenderable(renderer, {
            flexGrow: 1,
            minHeight: 0,
            stickyScroll: true,
            stickyStart: 'bottom',
            backgroundColor: dashboardTheme.panel
        });
        logPanel.add(scroll);
        const textNode = new TextRenderable(renderer, { content: '', fg: dashboardTheme.text });
        scroll.add(textNode);
        logTexts.push(textNode);
        logScrolls.push(scroll);
        try {
            const tail = startTail(resolved, textNode);
            logWatchers.push({ configPath: cfgPath, currentPath: resolved, panel: logPanel, text: textNode, scroll, tail });
        } catch (err) {
            enqueueLogLine(textNode, `Cannot watch ${resolved}: ${err.message}`);
        }
    });

    function refreshCommandSetLabel() {
        const currentSet = getCurrentCommandSet();
        const sets = Array.isArray(config.commandSets) ? config.commandSets : [];
        try {
            sidebarPanel.title = sets.length > 0 ? ` Scripts (${currentSet.name}) ` : 'Scripts';
        } catch { /* ignore */ }
    }
    refreshCommandSetLabel();

    function switchCommandSet(direction = 1) {
        const sets = Array.isArray(config.commandSets) ? config.commandSets : [];
        if (sets.length <= 1) return;

        currentCommandSetIndex += direction;

        if (currentCommandSetIndex < 0) {
            currentCommandSetIndex = sets.length - 1;
        } else if (currentCommandSetIndex >= sets.length) {
            currentCommandSetIndex = 0;
        }

        sidebarEntries = normalizeSidebarEntriesFromSet(getCurrentCommandSet());
        try {
            sidebarSelect.options = buildSelectOptions(sidebarEntries);
            sidebarSelect.setSelectedIndex(0);
        } catch { /* ignore */ }

        refreshCommandSetLabel();
        updateDescriptionFooter(0);
        requestRenderNow();
    }

    setInterval(() => {
        logWatchers.forEach(w => {
            if (!w.configPath.includes('{{latest}}')) return;
            const newPath = resolveLatest(w.configPath);
            if (newPath === w.currentPath) return;
            try {
                w.tail.unwatch();
            } catch { /* ignore */ }
            try {
                w.panel.title = path.basename(newPath);
            } catch { /* ignore */ }
            w.tail = startTail(newPath, w.text);
            w.currentPath = newPath;
            scheduleRender();
        });
    }, 60000);

    sidebarSelect.focus();

    const focusables = [
        sidebarSelect,
        ...logScrolls,
        stopBtn,
        ...(currentSettings.showCustomCommand === false ? [] : [inputBox]),
        filterBox,
        outputScroll
    ];
    let focusIndex = 0;

    function focusAt(index) {
        if (focusables.length === 0) return;
        focusIndex = ((index % focusables.length) + focusables.length) % focusables.length;
        try {
            focusables[focusIndex].focus();
        } catch { /* ignore */ }
        requestRenderNow();
    }

    // ---------------------------------------------------------------------------
    // Working directory selector (folder browser modal, see ./dashboard-ext.mjs)
    // Activated per command via `promptCwd: true` in dashboard.json
    // (aliases: `cwdPrompt`, `askCwd`, `cwdRequired`).
    // ---------------------------------------------------------------------------

    let cwdSelectorOpen = false;

    async function launchSidebarEntry(entry) {
        if (!entry || !entry.selectable || entry.script === '') return;
        if (entry.promptCwd === true && !cwdSelectorOpen) {
            cwdSelectorOpen = true;
            mainRow.visible = false;
            descPanel.visible = false;
            modalLayer.visible = true;
            requestRenderNow();
            try {
                const chosen = await promptForWorkingDirectory(renderer, {
                    mount: modalLayer,
                    title: entry.label || entry.script,
                    initialDir: process.cwd(),
                    theme: dashboardTheme,
                    requestRender: scheduleRender
                });
                if (!chosen) {
                    appendOutputLines('[dash] Working directory selection cancelled.');
                    scheduleRender();
                    return;
                }
                await runScriptFile(entry.script, { cwd: chosen });
            } finally {
                modalLayer.visible = false;
                mainRow.visible = true;
                descPanel.visible = true;
                cwdSelectorOpen = false;
                focusAt(focusIndex);
            }
            return;
        }
        await runScriptFile(entry.script);
    }

    const registeredKeys = new Set();
    for (const entry of sidebarEntries) {
        if (!entry.selectable || entry.keyName === '' || registeredKeys.has(entry.keyName)) {
            continue;
        }
        registeredKeys.add(entry.keyName);
    }

    function shutdown(code = 0) {
        try {
            for (const w of logWatchers) {
                try { w.tail.unwatch(); } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
        stopLogFile();
        if (current) {
            try { current.kill(); } catch { /* ignore */ }
        }
        try {
            renderer.destroy();
        } catch { /* ignore */ }
        const closed = renderer?.closed;
        if (closed && typeof closed.then === 'function') {
            closed.then(
                () => process.exit(code),
                () => process.exit(code)
            );
        } else {
            process.exit(code);
        }
    }

    function stopCurrentProcess() {
        if (current) {
            current.kill();
            current = null;
            appendOutputLines('Current process killed.');
            scheduleRender();
        }
    }

    renderer.keyInput.on('keypress', (key) => {
        if (!key) return;
        if (cwdSelectorOpen) return; // modal handles its own keys (Escape = cancel)

        // Command-set switching: ctrl+left / ctrl+right
        if (key.ctrl && !key.meta && (key.name === 'left' || key.name === 'right')) {
            key.preventDefault();
            switchCommandSet(key.name === 'right' ? 1 : -1);
            return;
        }

        // Tab cycles focus (shift+tab goes backward)
        if (key.name === 'tab' && !key.ctrl && !key.meta) {
            key.preventDefault();
            focusAt(focusIndex + (key.shift ? -1 : 1));
            return;
        }

        // History navigation inside the custom-command input
        const focused = renderer.currentFocusedRenderable;
        if (focused === inputBox && (key.name === 'up' || key.name === 'down') && !key.ctrl && !key.meta) {
            if (currentSettings.enableCommandHistory !== true) return;
            if (commandHistory.length === 0) return;
            key.preventDefault();
            if (key.name === 'up') {
                if (historyIndex > 0) historyIndex--;
                try { inputBox.value = commandHistory[historyIndex] ?? ''; } catch { /* ignore */ }
                scheduleRender();
            } else {
                if (historyIndex < commandHistory.length - 1) {
                    historyIndex++;
                    try { inputBox.value = commandHistory[historyIndex] ?? ''; } catch { /* ignore */ }
                } else {
                    historyIndex = commandHistory.length;
                    try { inputBox.value = ''; } catch { /* ignore */ }
                }
                scheduleRender();
            }
            return;
        }

        // Enter on the Stop button
        if (focused === stopBtn && key.name === 'return' && !key.ctrl && !key.meta) {
            key.preventDefault();
            stopCurrentProcess();
            return;
        }

        // quit: q (when not editing) or ctrl+c
        if ((key.name === 'q' && !key.ctrl && !key.meta && focused !== inputBox && focused !== filterBox) ||
            (key.ctrl && !key.meta && key.name === 'c')) {
            key.preventDefault();
            shutdown(0);
            return;
        }

        // rerun last command: ctrl+r
        if (key.ctrl && !key.meta && !key.shift && key.name === 'r') {
            key.preventDefault();
            if (!lastCommand) {
                requestRenderNow();
                return;
            }
            if (lastCommand.kind === 'script') {
                runScript(lastCommand.value, { cwd: lastCommand.cwd }).catch(err => {
                    appendOutputLines(`Error: ${err.message}`);
                    scheduleRender();
                });
            } else {
                runCustomCommand(lastCommand.value, { cwd: lastCommand.cwd });
            }
            return;
        }

        // stop: ctrl+s
        if (key.ctrl && !key.meta && !key.shift && key.name === 's') {
            key.preventDefault();
            stopCurrentProcess();
            return;
        }

        // per-entry shortcuts
        for (const entry of sidebarEntries) {
            if (!entry.selectable || entry.keyName === '') continue;
            if (specMatchesKeyEvent(entry.rawKey || '', key)) {
                key.preventDefault();
                launchSidebarEntry(entry).catch((err) => {
                    appendOutputLines(`Error: ${err?.message || err}`);
                    scheduleRender();
                });
                return;
            }
        }
    });

    sidebarSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index) => {
        const entry = sidebarEntries[index];
        if (entry?.selectable && entry.script !== '') {
            launchSidebarEntry(entry).catch((err) => {
                appendOutputLines(`Error: ${err?.message || err}`);
                scheduleRender();
            });
        }
    });

    stopBtn.onMouseDown = () => {
        stopCurrentProcess();
    };

    inputBox.on(InputRenderableEvents.ENTER, (value) => {
        const trimmed = (value || '').trim();
        if (!trimmed) return;
        commandHistory.push(trimmed);
        historyIndex = commandHistory.length;
        runCustomCommand(trimmed);
        try { inputBox.value = ''; } catch { /* ignore */ }
        requestRenderNow();
    });

    filterBox.on(InputRenderableEvents.ENTER, (value) => {
        setOutputFilter(value ?? '');
        requestRenderNow();
    });

    filterBox.on(InputRenderableEvents.CHANGE, (value) => {
        // Keep the committed filter in sync; Escape restores it via key handler below.
    });

    renderer.keyInput.on('keypress', (key) => {
        if (cwdSelectorOpen) return;
        if (!key || key.name !== 'escape') return;
        const focused = renderer.currentFocusedRenderable;
        if (focused === filterBox) {
            key.preventDefault();
            try { filterBox.value = outputFilterValue; } catch { /* ignore */ }
            focusAt(focusIndex + 1);
        } else if (focused === inputBox) {
            key.preventDefault();
            try { inputBox.value = ''; } catch { /* ignore */ }
            focusAt(focusIndex + 1);
        }
    });

    // NOTE: moved here exactly like your original file layout
    let current = null;
    const commandHistory = [];
    let historyIndex = -1;

    function runCustomCommand(command, options = {}) {
        const trimmed = (command || '').trim();
        if (!trimmed) return;

        if (current) {
            current.kill();
            appendOutputLines('Previous process killed.');
        }

        const spawnCwd = resolveSpawnCwd(options.cwd);
        if (spawnCwd) {
            appendOutputLines(`[dash] cwd: ${spawnCwd}`);
        }

        const args = trimmed.split(' ');
        const cmd = args.shift();

        current = spawn(cmd, args, { shell: true, ...(spawnCwd ? { cwd: spawnCwd } : {}) });
        setOutputLabel(outputPanel, trimmed);
        lastCommand = { kind: 'custom', value: trimmed, cwd: spawnCwd };

        current.stdout.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.stderr.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.on('close', code => {
            appendOutputLines(`Process exited with code ${code}`);
            current = null;

            if (config.settings?.notifyOnExit) {
                try { process.stdout.write('\x07'); } catch { /* ignore */ }
            }

            scheduleRender();
        });
    }

    async function closePorts(method, ports) {
        for (const p of ports) {
            const port = parseInt(p, 10);
            if (isNaN(port)) continue;
            try {
                await kill(port, method);
                appendOutputLines(`Closed ${method.toUpperCase()} port ${port}`);
            } catch (err) {
                appendOutputLines(`Error closing ${method.toUpperCase()} port ${port}: ${err.message}`);
            }
            scheduleRender();
        }
    }

    function execShell(cmd) {
        return new Promise((resolve) => {
            exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
                resolve({
                    code: err ? (err.code || 1) : 0,
                    stdout: stdout || '',
                    stderr: stderr || (err ? err.message : '')
                });
            });
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function isAlive(pid) {
        try { process.kill(pid, 0); return true; }
        catch (e) { return e && e.code === 'EPERM' ? true : false; }
    }

    async function waitForExit(pid, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!isAlive(pid)) return true;
            await sleep(100);
        }
        return !isAlive(pid);
    }

    // Linux: read /proc/*/cmdline (robust, no ps/pgrep)
    // Windows: tasklist CSV
    function readCmdline(pid) {
        try {
            const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
            // cmdline is \0-separated
            return raw.toString('utf8').split('\0').filter(Boolean).join(' ');
        } catch {
            return '';
        }
    }

    async function getPidsByName(name) {
        const needle = String(name).toLowerCase();
        const selfPid = process.pid;
        const results = new Set();

        if (process.platform === 'win32') {
            const { stdout } = await execShell(`tasklist /FO CSV /NH`);
            stdout.split(/\r?\n/).forEach(line => {
                if (!line.trim()) return;
                const parts = line.split('","').map(s => s.replace(/(^"|"$)/g, ''));
                const procName = (parts[0] || '').toLowerCase();
                const pid = parseInt(parts[1], 10);
                if (!isNaN(pid) && pid !== selfPid && procName.includes(needle)) {
                    results.add(pid);
                }
            });
            return Array.from(results);
        }

        // Linux /proc scan
        let pids;
        try {
            pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
        } catch {
            pids = [];
        }

        for (const d of pids) {
            const pid = parseInt(d, 10);
            if (pid === selfPid) continue;
            const cmd = readCmdline(pid).toLowerCase();
            // If cmdline is empty, some daemons: could fall back to exe
            if (!cmd) continue;
            if (cmd.includes(needle)) results.add(pid);
        }
        return Array.from(results);
    }

    async function killPid(pid) {
        // SIGTERM
        try { process.kill(pid, 'SIGTERM'); } catch (e) {
            if (e && e.code === 'ESRCH') return { ok: true, method: 'already-dead' };
            if (e && e.code === 'EPERM') return { ok: false, method: 'SIGTERM', error: 'EPERM' };
            // other error -> force kill anyway
        }
        const graceful = await waitForExit(pid, 1500);
        if (graceful) return { ok: true, method: 'SIGTERM' };

        // FORCE
        if (process.platform === 'win32') {
            const { code, stderr } = await execShell(`taskkill /PID ${pid} /T /F`);
            return { ok: code === 0, method: 'taskkill', error: code !== 0 ? stderr : undefined };
        } else {
            try { process.kill(pid, 'SIGKILL'); }
            catch (e) {
                if (e && e.code === 'ESRCH') return { ok: true, method: 'SIGKILL' };
                if (e && e.code === 'EPERM') return { ok: false, method: 'SIGKILL', error: 'EPERM' };
                return { ok: false, method: 'SIGKILL', error: e.message || 'unknown' };
            }
            const hard = await waitForExit(pid, 1000);
            return { ok: hard, method: 'SIGKILL', error: hard ? undefined : 'still alive' };
        }
    }

    async function killProcesses(params) {
        const selfPid = process.pid;

        for (const target of params) {
            // Direct PID
            if (/^\d+$/.test(String(target))) {
                const pid = parseInt(String(target), 10);
                if (pid === selfPid) { continue; }
                const res = await killPid(pid);
                if (res.ok) appendOutputLines(`Killed PID ${pid} via ${res.method}`);
                else appendOutputLines(`Failed to kill PID ${pid} via ${res.method}: ${res.error || 'unknown'}`);
                scheduleRender();
                continue;
            }

            // Name / substring pattern (cmdline)
            const name = String(target).trim();
            const pids = await getPidsByName(name);

            for (const pid of pids) {
                if (pid === selfPid) { continue; }
                const res = await killPid(pid);
                if (res.ok) appendOutputLines(`Killed "${name}" (PID ${pid}) via ${res.method}`);
                else appendOutputLines(`Failed to kill "${name}" (PID ${pid}) via ${res.method}: ${res.error || 'unknown'}`);
            }
            scheduleRender();
        }
    }


    // Execute a list of actions with shared handlers
    async function executeActions(actions, label = 'actions') {
        // Normalize and no-op
        if (!actions || actions.length === 0) return;

        for (const act of actions) {
            const params = Array.isArray(act.parameters)
                ? act.parameters
                : (act.parameters != null ? [act.parameters] : []);

            if (act.action === 'closeTCPPorts') {
                appendOutputLines(`Closing TCP ports ${params}`);
                await closePorts('tcp', params);
            } else if (act.action === 'closeUDPPorts') {
                appendOutputLines(`Closing UDP ports ${params}`);
                await closePorts('udp', params);
            } else if (act.action === 'killProcess') {
                appendOutputLines(`Killing processes: ${params}`);
                await killProcesses(params);
            } else {
                appendOutputLines(`[${label}] unknown action "${act.action}"`);
            }
        }
        scheduleRender();
    }


    async function executeBeforeActions(name) {
        const entries = (config.events?.beforeStartProcess || []).filter(e => e && e.script === name);
        const actions = entries.flatMap(e => Array.isArray(e.actions) ? e.actions : []);
        await executeActions(actions, 'pre-launch actions');
    }
    // Execute actions once when the dashboard starts
    async function executeStartupActions() {
        const actions = config.events?.onDashboardStart;
        await executeActions(actions, 'startup actions');
    }
    async function runScript(name, options = {}) {
        if (current) {
            current.kill();
            current = null;
        }

        appendOutputLines(`--------------------------------------------------`);

        await executeBeforeActions(name);
        const spawnCwd = resolveSpawnCwd(options.cwd);
        if (spawnCwd) {
            appendOutputLines(`[dash] cwd: ${spawnCwd}`);
        }
        current = spawn('npm', ['run', name], { shell: true, ...(spawnCwd ? { cwd: spawnCwd } : {}) });
        lastCommand = { kind: 'script', value: name, cwd: spawnCwd };

        setOutputLabel(outputPanel, name);

        current.stdout.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.stderr.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.on('close', code => {
            appendOutputLines(`Process exited with code ${code}`);
            current = null;
            scheduleRender();
        });
    }

    async function runScriptFile(scriptFile, options = {}) {
        if (current) {
            current.kill();
            current = null;
        }

        const scriptPath = path.join(config.scriptsDir ?? './scripts', scriptFile);

        appendOutputLines(`--------------------------------------------------`);
        appendOutputLines(`[dash] Running: ${scriptPath}`);

        const spawnCwd = resolveSpawnCwd(options.cwd);
        if (spawnCwd) {
            appendOutputLines(`[dash] cwd: ${spawnCwd}`);
        }

        await executeBeforeActions(path.basename(scriptFile, path.extname(scriptFile)));

        const spawnOptions = { shell: true, ...(spawnCwd ? { cwd: spawnCwd } : {}) };
        // If the script file doesn't exist in scriptsDir, treat it as a shell command
        if (!fs.existsSync(scriptPath)) {
            const effectiveCommand = withGnomeTerminalWorkdir(scriptFile, spawnCwd);
            current = spawn(effectiveCommand, spawnOptions);
            lastCommand = { kind: 'custom', value: effectiveCommand, cwd: spawnCwd };
            setOutputLabel(outputPanel, scriptFile);
        } else {
            current = spawn(scriptPath, spawnOptions);
            lastCommand = { kind: 'custom', value: scriptPath, cwd: spawnCwd };
            setOutputLabel(outputPanel, path.basename(scriptPath));
        }

        current.stdout.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.stderr.on('data', data => {
            appendOutputLines(data.toString());
            scheduleRender();
        });

        current.on('close', code => {
            appendOutputLines(`Process exited with code ${code}`);
            current = null;
            scheduleRender();
        });
    }

    applyControlsLayout();
    applyRightLayout();

    // Kick off one-shot startup actions
    (async () => {
        try {
            await executeStartupActions();
        } catch (err) {
            appendOutputLines(`[startup] error: ${err?.message || err}`);
            scheduleRender();
        }
    })();

    requestRenderNow();
}

main().catch((err) => {
    try {
        if (renderer) renderer.destroy();
    } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.error(`[dashboard] fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
});

export { initLogFile, stopLogFile };
