import { jobsStore } from '../store/jobsStore';
import { storage } from '../storage';
import { listenTauri } from './listen';

// The shell emits `jobs:progress` as its workers index files; the count it had
// before this listener attached is asked for once, and loses to any event since.
export function startJobProgress(): () => void {
  let heard = false;
  const unlisten = listenTauri<{ pending: number }>('jobs:progress', (e) => {
    heard = true;
    jobsStore.setState({ pending: e.payload.pending });
  });
  void storage
    .jobsPending()
    .then((pending) => heard || jobsStore.setState({ pending }))
    .catch(() => {});
  return unlisten;
}
