import { lazy } from 'react';

// Menu search: loaded on first use, prefetched when the pointer reaches its button (bundle-conditional, bundle-preload).
export const loadCommandPalette = () => import('../../components/dialogs/CommandPalette');
export const CommandPalette = lazy(loadCommandPalette);
