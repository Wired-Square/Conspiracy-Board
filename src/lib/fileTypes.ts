import {
  AUDIO_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  EMAIL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from '../bindings/fileTypes';
import type { FileFilter } from '../storage/StorageAdapter';

// The file types as the UI needs them: the pickers' filters and the Objects view's
// icons. The rules themselves are the shell's (src-tauri/src/file_types.rs), and
// these lists are generated from it.

export const EMAIL_FILE_FILTER: FileFilter = { name: 'Email', extensions: [...EMAIL_EXTENSIONS] };
export const IMAGE_FILE_FILTER: FileFilter = { name: 'Images', extensions: [...IMAGE_EXTENSIONS] };
export const DOCUMENT_FILE_FILTER: FileFilter = { name: 'Documents', extensions: [...DOCUMENT_EXTENSIONS] };

const hasExtension = (extensions: readonly string[]) => (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase());
};

export const isImageFile = hasExtension(IMAGE_EXTENSIONS);
export const isDocumentFile = hasExtension(DOCUMENT_EXTENSIONS);
export const isVideoFile = hasExtension(VIDEO_EXTENSIONS);
export const isAudioFile = hasExtension(AUDIO_EXTENSIONS);
