import { setLibraryMcpStatus } from '../store/libraryMcpStore';
import { libraryMcp } from './libraryMcp';

// Like startJobProgress: the status at attach time is asked for once, and loses
// to any `library-mcp:changed` since (the resume at launch emits one).
export function startLibraryMcpStatus(): () => void {
  let heard = false;
  const unlisten = libraryMcp.listen((status) => {
    heard = true;
    setLibraryMcpStatus(status);
  });
  void libraryMcp
    .status()
    .then((status) => heard || setLibraryMcpStatus(status))
    .catch(() => {});
  return unlisten;
}
