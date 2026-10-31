import '@wired-square/mcp-bridge/dom-ops';
import { startHarnessBridge } from '@wired-square/mcp-bridge/tauri-bridge';
import { appOps } from './appOps';

const stop = startHarnessBridge(appOps);
import.meta.hot?.dispose(() => stop.then((unlisten) => unlisten()));
