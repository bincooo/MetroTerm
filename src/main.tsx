import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import { loadConfig, readConfig } from './lib/platform/config';
import { sanitizeLanguage, setLanguage } from './i18n';
import { initBackend } from './lib/platform/backend';
import { loadHostOs } from './lib/platform/hostOs';
import { disableAutocomplete } from './lib/ui/noAutocomplete';
import { attachAppCaret } from './lib/ui/appCaret';
import { installFileDrop } from './lib/ui/fileDrop';
import { installPopupMotion } from './lib/ui/popupMotion';
import { installLabelClicks } from './lib/ui/labelClicks';
import { installDialogKeys } from './lib/ui/dialogKeys';
import './styles/index.css';

// No browser input history (autocomplete dropdowns) in any field.
disableAutocomplete();
// Taller, 2px text caret in all inputs (the terminal keeps its own cursor).
attachAppCaret();
// Files dragged in from the file manager: Filer uploads them, a terminal gets their paths.
installFileDrop();
// Enter / leave animations of menus, tooltips, dialogs and notices (lib/ui/popupMotion).
installPopupMotion();
// Clicking a field's title does not focus the field (lib/ui/labelClicks).
installLabelClicks();
// In a dialog: Tab stays inside it, ← / → move between the footer buttons (lib/ui/dialogKeys).
installDialogKeys();

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
