import fs from 'fs';
import path from 'path';

// dashboard-ext.mjs: dashboard helpers (OpenTUI edition).
// Section 1: key specs (dashboard.json "control+b" -> canonical form +
//   matching against OpenTUI KeyEvent { name, ctrl, meta, shift }).
// Section 2: working directory selector (OpenTUI renderables, flex only).
// Section 3: danger highlight (plain-text marker).

// --- Section 1: key specs ---
// Human-friendly key specs for dashboard.json ("control+b", "shift+a",
// "alt+c", "function+f1") translated to a canonical "C-M-S-base" form.
// Matching is done against OpenTUI KeyEvent objects (see
// keyEventMatchesSpec / specMatchesKeyEvent).
//
// "function"/"fn" only makes sense with an F-key ("function+f1" means F1):
// the Fn key itself sends nothing to the terminal, so it cannot be used
// as a real modifier.

const BASE_ALIASES = {
    return: 'return',
    enter: 'return',
    esc: 'escape',
    del: 'delete',
    ins: 'insert',
    pgup: 'pageup',
    'page-up': 'pageup',
    pgdown: 'pagedown',
    'page-down': 'pagedown'
};

const KNOWN_BASE = /^(?:[a-z0-9]|space|return|escape|tab|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|clear|f(?:[1-9]|1[0-2]))$/;

export function normalizeKeySpec(spec) {
    if (typeof spec !== 'string') return '';
    const raw = spec.trim();
    if (raw === '') return '';

    // A lone uppercase letter means Shift+letter: terminals send "A"
    // with shift held.
    if (/^[A-Z]$/.test(raw)) return 'S-' + raw.toLowerCase();

    let parts = raw.split('+').map(function (p) { return p.trim().toLowerCase(); }).filter(function (p) { return p !== ''; });

    // Backward compatibility: raw shorthand ("C-b", "M-c", "S-a").
    if (parts.length === 1) {
        const m = parts[0].match(/^((?:[cms]-)+)(.+)$/);
        if (m) {
            const mods = m[1].split('-').filter(Boolean).map(function (c) {
                return c === 'c' ? 'control' : c === 'm' ? 'alt' : 'shift';
            });
            parts = mods.concat([m[2]]);
        }
    }

    let ctrl = false;
    let meta = false;
    let shift = false;
    let fnMarker = false;
    let base = null;

    for (const p of parts) {
        if (p === 'control' || p === 'ctrl') ctrl = true;
        else if (p === 'shift') shift = true;
        else if (p === 'alt' || p === 'meta') meta = true;
        else if (p === 'function' || p === 'fn') fnMarker = true;
        else if (base === null) base = p;
        else return '';
    }

    if (base === null) return '';
    base = BASE_ALIASES[base] || base;

    // "function" only makes sense with an F-key: "function+f1" is F1.
    if (fnMarker && !/^f(?:[1-9]|1[0-2])$/.test(base)) return '';

    if (!KNOWN_BASE.test(base)) {
        // Tolerate single punctuation characters.
        if (base.length !== 1) return '';
    }

    // Canonical order: C-, then M-, then S-, then base.
    return (ctrl ? 'C-' : '') + (meta ? 'M-' : '') + (shift ? 'S-' : '') + base;
}

export function formatKeyLabel(spec) {
    if (typeof spec !== 'string') return '';
    return spec.split('+').map(function (p) { return p.trim(); }).filter(function (p) { return p !== ''; }).join('+').toUpperCase();
}

function parseCanonical(normalized) {
    if (typeof normalized !== 'string' || normalized === '') return null;
    let rest = normalized;
    let ctrl = false;
    let meta = false;
    let shift = false;
    for (;;) {
        if (rest.startsWith('C-')) { ctrl = true; rest = rest.slice(2); continue; }
        if (rest.startsWith('M-')) { meta = true; rest = rest.slice(2); continue; }
        if (rest.startsWith('S-')) { shift = true; rest = rest.slice(2); continue; }
        break;
    }
    if (rest === '') return null;
    return { ctrl, meta, shift, base: rest };
}

// Match a canonical spec (as returned by normalizeKeySpec) against an
// OpenTUI KeyEvent ({ name, ctrl, meta, shift }).
export function keyEventMatchesSpec(normalized, key) {
    const parsed = parseCanonical(normalized);
    if (!parsed || !key || typeof key.name !== 'string') return false;
    const keyName = String(key.name).toLowerCase();
    const wantBase = String(parsed.base).toLowerCase();
    if (keyName !== wantBase) {
        // Shifted letters may arrive as uppercase with shift set.
        if (!(wantBase.length === 1 && keyName === wantBase && parsed.shift)) return false;
    }
    if (!!key.ctrl !== parsed.ctrl) return false;
    if (!!(key.meta || key.option) !== parsed.meta) return false;
    // Shift: require exact match, except function keys where terminals
    // may report shift implicitly.
    if (!!key.shift !== parsed.shift) return false;
    return true;
}

// Convenience: match a raw dashboard.json spec directly.
export function specMatchesKeyEvent(spec, key) {
    const normalized = normalizeKeySpec(spec);
    if (normalized === '') return false;
    return keyEventMatchesSpec(normalized, key);
}

// --- Section 2: working directory selector ---
export function resolveCwdPromptFlag(command) {
    if (typeof command !== 'object' || command === null) return false;
    return command.promptCwd === true
        || command.cwdPrompt === true
        || command.askCwd === true
        || command.cwdRequired === true;
}

export function listSubdirectories(dir) {
    try {
        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        return dirents
            .filter((d) => {
                try {
                    return d.isDirectory();
                } catch {
                    return false;
                }
            })
            .map((d) => d.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch {
        return null;
    }
}

export function withGnomeTerminalWorkdir(command, cwd) {
    if (!cwd || typeof command !== 'string') return command;
    if (!command.includes('gnome-terminal')) return command;
    if (command.includes('--working-directory')) return command;
    const escaped = String(cwd).replace(/"/g, '\\"');
    return command.replace('gnome-terminal', `gnome-terminal --working-directory="${escaped}"`);
}

export function resolveSpawnCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return undefined;
    try {
        const resolved = path.resolve(cwd);
        if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch { /* invalid cwd -> ignore */ }
    return undefined;
}

// OpenTUI folder browser. Layout uses flex only (no absolute coordinates):
// the caller owns a centered `mount` box (visible while the modal is open)
// and this function builds a dialog inside it.
//
// Resolves to the chosen directory, or null when cancelled.
export function promptForWorkingDirectory(renderer, { mount, title = '', initialDir = process.cwd(), theme = {}, requestRender = null } = {}) {
    return new Promise((resolve) => {
        if (!renderer || !mount) {
            resolve(null);
            return;
        }
        let currentDir = path.resolve(initialDir || process.cwd());
        try {
            if (!fs.statSync(currentDir).isDirectory()) currentDir = process.cwd();
        } catch {
            currentDir = process.cwd();
        }

        const render = typeof requestRender === 'function'
            ? requestRender
            : () => { try { renderer.requestRender(); } catch { /* ignore */ } };

        let settled = false;
        let dialog = null;
        let dirSelect = null;
        let pathText = null;

        const cleanup = (value) => {
            if (settled) return;
            settled = true;
            try {
                if (keyHandler) renderer.keyInput.off('keypress', keyHandler);
            } catch { /* ignore */ }
            try {
                if (dialog) dialog.destroyRecursively();
            } catch { /* ignore */ }
            render();
            resolve(value);
        };

        const refresh = async () => {
            try {
                const { BoxRenderable, TextRenderable, SelectRenderable } = await import('@opentui/core');
                if (!dialog) {
                    dialog = new BoxRenderable(renderer, {
                        width: '70%',
                        height: '70%',
                        border: true,
                        title: ` Working directory ${title ? '- ' + String(title).slice(0, 40) : ''} `,
                        borderColor: theme.border,
                        backgroundColor: theme.panel,
                        flexDirection: 'column',
                        padding: 1,
                        gap: 1
                    });
                    mount.add(dialog);
                    pathText = new TextRenderable(renderer, { content: currentDir, fg: theme.text });
                    dialog.add(pathText);
                    dirSelect = new SelectRenderable(renderer, {
                        flexGrow: 1,
                        options: [],
                        backgroundColor: theme.panel,
                        focusedBackgroundColor: theme.panelFocus,
                        textColor: theme.text,
                        focusedTextColor: theme.text,
                        selectedBackgroundColor: theme.selected,
                        selectedTextColor: theme.text,
                        showDescription: false
                    });
                    dialog.add(dirSelect);
                    const hint = new TextRenderable(renderer, {
                        content: 'Enter: confirm/enter | Backspace: parent | Escape: cancel',
                        fg: theme.border,
                        selectable: false
                    });
                    dialog.add(hint);
                    dirSelect.on('itemSelected', (index) => {
                        const item = items[index];
                        if (!item) return;
                        if (item.kind === 'select') {
                            cleanup(currentDir);
                            return;
                        }
                        if (item.kind === 'info') return;
                        if (item.kind === 'parent') {
                            currentDir = path.dirname(currentDir);
                            refresh();
                            return;
                        }
                        if (item.kind === 'dir') {
                            const next = path.join(currentDir, item.name);
                            try {
                                if (fs.statSync(next).isDirectory()) {
                                    currentDir = next;
                                    refresh();
                                }
                            } catch {
                                // stay on current dir if unreadable
                            }
                        }
                    });
                    dirSelect.focus();
                }
                pathText.content = currentDir;
                const subdirs = listSubdirectories(currentDir);
                items = [{ kind: 'select', name: '', display: 'Select this folder' }];
                if (path.dirname(currentDir) !== currentDir) {
                    items.push({ kind: 'parent', name: '..', display: 'UP .. (parent folder)' });
                }
                if (subdirs === null) {
                    items.push({ kind: 'info', name: '', display: '(unreadable)' });
                } else {
                    for (const name of subdirs) {
                        const prefix = name.startsWith('.') ? '- ' : '+ ';
                        items.push({ kind: 'dir', name, display: `${prefix}${name}` });
                    }
                }
                dirSelect.options = items.map((it) => ({ name: it.display, description: it.kind }));
                dirSelect.setSelectedIndex(0);
                render();
            } catch {
                cleanup(null);
            }
        };

        let items = [];

        const keyHandler = (key) => {
            if (settled) return;
            if (!key) return;
            if (key.name === 'escape') {
                key.preventDefault();
                key.stopPropagation();
                cleanup(null);
                return;
            }
            if (key.name === 'backspace') {
                const parent = path.dirname(currentDir);
                if (parent !== currentDir) {
                    key.preventDefault();
                    key.stopPropagation();
                    currentDir = parent;
                    refresh();
                }
                return;
            }
        };

        renderer.keyInput.on('keypress', keyHandler);
        refresh();
    });
}

// --- Section 3: danger highlight ---
// Sidebar entries flagged with `"danger": true` render with a plain-text
// "! " marker. OpenTUI Select options carry no per-option colors, so the
// marker (not a background) signals destructive entries.
export function resolveDangerFlag(command) {
    if (typeof command !== 'object' || command === null) return false;
    return command.danger === true;
}

export function formatSidebarLabel(label, isDanger) {
    if (isDanger !== true) return label;
    return `! ${label}`;
}

// --- Section 4: script descriptions ---
// Sidebar entries accept an optional `"description"` string in
// dashboard.json. The engine shows it in the full-width footer when the
// entry is highlighted. Anything but a non-empty string means no text.
export function resolveDescription(command) {
    if (typeof command !== 'object' || command === null) return '';
    if (typeof command.description !== 'string') return '';
    return command.description.trim();
}
