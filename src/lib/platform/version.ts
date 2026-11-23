/** App version (package.json; tauri.conf.json and Cargo.toml carry the same number). */
import { version } from '../../../package.json';

export const APP_VERSION: string = version;
