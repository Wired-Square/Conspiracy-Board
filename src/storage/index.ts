import type { StorageAdapter } from './StorageAdapter';
import { tauriStorage } from './tauriStorage';

// One platform, one implementation. The seam stays because it is what keeps
// persistence out of the rest of src/, not because there is a choice to make.
export const storage: StorageAdapter = tauriStorage;
