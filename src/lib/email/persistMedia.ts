import { storage } from '../../storage';
import type { CardDraft } from '../../store/boardStore';
import type { EmailDraft } from './parseEmails';

/** Best-effort write: a file that won't save degrades the media, not the import. */
async function trySave(bytes: ArrayBuffer, ext: string): Promise<string | undefined> {
  try {
    return await storage.saveMedia(bytes, ext);
  } catch (err) {
    console.warn('Could not keep imported media:', err);
    return undefined;
  }
}

/**
 * Write a parsed message's media to the library and return a plain card draft
 * that references the files, transient bytes stripped. Run at commit, not at
 * parse — a message the user never adds costs no disk. Idempotent by content
 * hash, so committing the same message twice writes its files once.
 *
 * The .eml is skipped when `emlFile` is already set: the Apple Mail path gets it
 * from the shell, which kept the promised file itself rather than handing the
 * bytes back to be written again.
 */
export async function persistDraftMedia(draft: EmailDraft): Promise<CardDraft> {
  const { media, email: parsed, ...rest } = draft;
  const email = { ...parsed };
  const out: CardDraft = { ...rest, email };

  if (media.image) {
    const file = await trySave(media.image.bytes, media.image.ext);
    if (file) out.imageFile = file;
  }

  email.attachments = await Promise.all(
    media.attachments.map(async (a) => {
      const file = a.bytes ? await trySave(a.bytes, a.ext) : undefined;
      return { name: a.name, ...(a.mime ? { mime: a.mime } : {}), ...(file ? { file } : {}) };
    }),
  );

  if (media.eml && !email.emlFile) {
    const file = await trySave(media.eml, 'eml');
    if (file) email.emlFile = file;
  }

  return out;
}
