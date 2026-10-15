// The bridge to the native side (src-tauri). Inside the app this uses Tauri.
// Opened in a normal browser by the test server, it uses an HTTP bridge
// instead, so the whole UI can be tested against the real interpreter.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import * as dialog from '@tauri-apps/plugin-dialog';

export const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

let bridgeEvents = null;
const bridgeListeners = new Map();

function bridgeSource() {
  if (!bridgeEvents) {
    bridgeEvents = new EventSource('/__events');
    bridgeEvents.onmessage = (m) => {
      const { event, payload } = JSON.parse(m.data);
      for (const fn of bridgeListeners.get(event) || []) fn({ payload });
    };
  }
}

async function bridgeCall(cmd, args) {
  const r = await fetch('/__bridge/' + cmd, { method: 'POST', body: JSON.stringify(args || {}) });
  const body = await r.json();
  if (!r.ok) throw body.error;
  return body.result;
}

/**
 * Calls a native command. Arguments are written like the Rust side names them
 * (timeout_ms); Tauri wants them in camelCase (timeoutMs), so they're changed here.
 */
export function invoke(cmd, args) {
  if (!inTauri) return bridgeCall(cmd, args);
  const named = args && Object.fromEntries(Object.entries(args).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
  return tauriInvoke(cmd, named);
}

export async function listen(event, fn) {
  if (inTauri) return tauriListen(event, fn);
  bridgeSource();
  if (!bridgeListeners.has(event)) bridgeListeners.set(event, new Set());
  bridgeListeners.get(event).add(fn);
  return () => bridgeListeners.get(event).delete(fn);
}

const JLB_FILTER = [{ name: 'JLB programs', extensions: ['jlb'] }, { name: 'All files', extensions: ['*'] }];

/** Native "open" dialog. Gives back a path, or null if cancelled. */
export async function pickOpen({ folder = false, defaultPath } = {}) {
  if (!inTauri) return bridgeCall('dialog_open', { folder });
  const r = await dialog.open({ directory: folder, multiple: false, defaultPath, filters: folder ? undefined : JLB_FILTER });
  return typeof r === 'string' ? r : null;
}

/** Native "save as" dialog. Gives back a path, or null if cancelled. */
export async function pickSave({ defaultPath } = {}) {
  if (!inTauri) return bridgeCall('dialog_save', { defaultPath });
  return (await dialog.save({ defaultPath, filters: JLB_FILTER })) || null;
}
