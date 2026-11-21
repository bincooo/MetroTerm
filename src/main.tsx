import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { loadConfig, readConfig } from './lib/config';
import { sanitizeLanguage, setLanguage } from './i18n';
import { initBackend } from './lib/backend';
import { loadHostOs } from './lib/hostOs';
import { disableAutocomplete } from './lib/noAutocomplete';
import { attachAppCaret } from './lib/appCaret';
import { installFileDrop } from './lib/fileDrop';
import { installPopupMotion } from './lib/popupMotion';
import './colors.css';
import './styles.css';

// No browser input history (autocomplete dropdowns) in any field.
disableAutocomplete();
// Taller, 2px text caret in all inputs (the terminal keeps its own cursor).
attachAppCaret();
// Files dragged in from the file manager: Filer uploads them, a terminal gets their paths.
installFileDrop();
// Enter / leave animations of menus, tooltips, dialogs and notices (lib/popupMotion).
installPopupMotion();

// Detect the backend (Tauri / WebSocket server / static preview), then load ~/.metroterm/*.json
// (browser storage in the static preview) before the first render.
void initBackend()
  .catch(() => 'preview')
  // The host system decides the built-in local shells of a first start (App: builtinShells).
  .then(() => Promise.all([loadConfig(), loadHostOs()]))
  .finally(() => {
    // Settings → LANGUAGE (English by default), before the first render.
    setLanguage(sanitizeLanguage(readConfig<{ language?: unknown }>('settings')?.language));
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
