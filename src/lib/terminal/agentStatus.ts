import { useEffect, useSyncExternalStore } from 'react';
import { backend, type BackendEvent } from '../platform/backend';
import { terminalSession } from './cwd';
import { t } from '../../i18n';
import { DEFAULT_SOUND, playAgentSound, type SoundId } from '../ui/sound';

/**
 * Agent CLI status of the terminal tabs (Claude Code, Codex, opencode …). The backend recognises
 * the agent and its state from the terminal output (src-rust/src/agents) and pushes `agent.state`
 * events; this module only keeps the latest one per tab for the Session panel, and tells the
 * backend which terminal the user is looking at (a turn that finished there is not `done`).
 * A finished turn (working → done, or → idle when it finished in the viewed terminal) plays the
 * chosen sound (lib/ui/sound; Settings → AGENT DONE SOUND) while View → Agent Done Sound is on
 * (`setAgentSound`) — only when the user sent the agent something first (`noteAgentInput`: Enter
 * while the agent ran), so a working phase nobody asked for (start-up, redraws) stays silent.
 */
export type AgentState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown';
export type AgentStatus = { sessionId: string; agent: string; name: string; state: AgentState };

const STATE_LABELS: Record<AgentState, string> = {
  working: 'Working',
  blocked: 'Needs input',
  done: 'Done',
  idle: 'Idle',
  unknown: 'Unknown',
};
export const agentStateLabel = (state: AgentState) => t(STATE_LABELS[state]);

let statuses: ReadonlyMap<string, AgentStatus> = new Map();
const listeners = new Set<() => void>();
let listening = false;

/** Session ids are `tabId#generation` (TerminalView). */
const tabOf = (sessionId: string) => {
  const at = sessionId.lastIndexOf('#');
  return at < 0 ? sessionId : sessionId.slice(0, at);
};

const STATES = new Set<string>(Object.keys(STATE_LABELS));

let agentSound: SoundId | null = DEFAULT_SOUND;
/** View → Agent Done Sound / Settings → AGENT DONE SOUND (TerminalPrefs.agentSound, agentSoundName); null = off. */
export const setAgentSound = (sound: SoundId | null) => {
  agentSound = sound;
};

/** Sessions whose agent got an Enter from the user since its last finished turn. */
const prompted = new Set<string>();
/** Input typed / pasted / sent into a terminal session (TerminalView). */
export const noteAgentInput = (sessionId: string, data: string) => {
  if (data.includes('\r') && statuses.get(tabOf(sessionId))?.sessionId === sessionId) prompted.add(sessionId);
};

function onEvent(event: BackendEvent) {
  if (event.type !== 'agent.state') return;
  const tabId = tabOf(event.sessionId);
  const current = statuses.get(tabId);
  const next = new Map(statuses);
  if (event.agent && event.state && STATES.has(event.state)) {
    const state = event.state as AgentState;
    next.set(tabId, { sessionId: event.sessionId, agent: event.agent, name: event.name ?? event.agent, state });
    const finished = current?.sessionId === event.sessionId && current.state === 'working' && (state === 'done' || state === 'idle');
    if (finished && prompted.delete(event.sessionId) && agentSound) playAgentSound(agentSound);
  } else if (current && current.sessionId === event.sessionId) {
    prompted.delete(event.sessionId);
    next.delete(tabId);
  } else return; // the end of an older session of the tab
  statuses = next;
  listeners.forEach(listener => listener());
  // A restarted terminal has a new session id: tell the backend again which one is viewed.
  if (event.agent && tabId === viewedTab) reportFocus();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!listening) {
    listening = true;
    backend.on(onEvent);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Agent status per terminal tab id. */
export const useAgentStatuses = () => useSyncExternalStore(subscribe, () => statuses);

let viewedTab: string | null = null;
let sentFocus: string | null | undefined;

function reportFocus() {
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  const sessionId = viewedTab && visible ? terminalSession(viewedTab) || null : null;
  if (sessionId === sentFocus || !backend.live) return;
  sentFocus = sessionId;
  void backend.call('agent.focus', { sessionId }).catch(() => undefined);
}

/** Reports the terminal the user is looking at: the active tab, while the window has the focus. */
export function useAgentFocus(activeTabId: string | null) {
  useEffect(() => {
    viewedTab = activeTabId;
    reportFocus();
  }, [activeTabId]);
  useEffect(() => {
    window.addEventListener('focus', reportFocus);
    window.addEventListener('blur', reportFocus);
    document.addEventListener('visibilitychange', reportFocus);
    return () => {
      window.removeEventListener('focus', reportFocus);
      window.removeEventListener('blur', reportFocus);
      document.removeEventListener('visibilitychange', reportFocus);
    };
  }, []);
}
