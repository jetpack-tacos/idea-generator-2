import { api } from './api.js';

export const ROLES = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief', 'deep', 'exists'];

export const loadSettings = () => api('GET', '/api/runtime-settings');
export const saveSettings = (settings) => api('PUT', '/api/runtime-settings', settings);

export function providersInUse(settings) {
  return [...new Set(Object.values(settings.models).filter(Boolean).map((ref) =>
    /^[a-z]+:/.test(ref) ? ref.split(':', 1)[0] : 'openrouter'))]
    .filter((p) => p !== 'crew');
}
