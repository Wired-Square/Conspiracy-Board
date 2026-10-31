import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Modal } from '../ui/Modal';
import { ObjectPickerDialog, type PickableObject } from './ObjectPickerDialog';
import { closeDialog } from '../../store/dialogStore';
import { boardStore } from '../../store/boardStore';
import { storage } from '../../storage';
import { mediaSrc } from '../../storage/media';
import {
  clampView,
  initialView,
  viewToCrop,
  zoomAbout,
  zoomCeiling,
  type CropView,
  type Geom,
} from '../../lib/imageCrop';
import type { ImageCrop } from '../../types/board';
import { fromStore } from '../fromStore';

// What Save will store as the media file. An existing library file is kept and
// only re-cropped; a picked file or a fetched URL is written from the held Blob on
// Save; a remote URL the migration hasn't localised yet is downloaded then.
type Persist = { existingFile?: string; blob?: Blob; name?: string; remoteUrl?: string };

// The loaded image and how Save will persist it — always set together, so one bit
// of state rather than two kept in step.
type Source = { url: string; natW: number; natH: number; persist: Persist };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be loaded."));
    img.src = url;
  });
}

const messageOf = (e: unknown) => String((e as Error).message ?? e);

export function ImageEditorModal(props: { cardId: string }) {
  const cards = fromStore(boardStore, (s) => s.cards);
  const card = createMemo(() => cards().find((c) => c.id === props.cardId));
  const close = () => closeDialog('imageEditorCardId');

  // Pictures already on the board, one tile per file — the name is content-addressed,
  // so cards sharing an image share the one file (a group photo lands on everyone in
  // it). Each tile keeps all the cards that use it, first seen first, so the picker
  // can find it by any of them and show how many it is linked to. Picking one reuses
  // its stored file verbatim (see onSave's existingFile branch); nothing re-imports.
  const existing = createMemo(() => {
    const byFile = new Map<string, PickableObject>();
    for (const c of cards()) {
      if (!c.imageFile) continue;
      const tile = byFile.get(c.imageFile);
      if (tile) tile.cards.push(c);
      else byFile.set(c.imageFile, { cards: [c], file: c.imageFile, src: mediaSrc(c.imageFile) });
    }
    return [...byFile.values()];
  });

  let frame!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  let objectUrl: string | null = null;

  const [source, setSource] = createSignal<Source | null>(null);
  const [view, setView] = createSignal<CropView | null>(null);
  const [urlInput, setUrlInput] = createSignal('');
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  // A blob URL for a picked file or a fetched image, replaced as the source
  // changes and revoked on close so a dialog opened many times leaks none.
  function swapObjectUrl(blob: Blob): string {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    return objectUrl;
  }
  onCleanup(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  /** The frame's on-screen box plus the image's natural pixels — measured now, as
   *  the frame is always mounted (it shows the empty-state span when there's none). */
  function frameGeom(natW: number, natH: number): Geom {
    const { width, height } = frame.getBoundingClientRect();
    return { fw: width, fh: height, natW, natH };
  }

  // Show a loaded image and frame it (from a stored crop, or cover-fit) in one go.
  function show(img: HTMLImageElement, persist: Persist, crop: ImageCrop | null) {
    const geom = frameGeom(img.naturalWidth, img.naturalHeight);
    setSource({ url: img.src, natW: img.naturalWidth, natH: img.naturalHeight, persist });
    setView(initialView(geom, crop));
  }

  // Open onto the card's current picture, if it has one. A remote URL the migration
  // hasn't localised (offline, say) still displays and is downloaded on Save.
  onMount(() => {
    const c = card();
    const src = c && (c.imageFile ? mediaSrc(c.imageFile) : c.imageUrl);
    if (!c || !src) return;
    let cancelled = false;
    onCleanup(() => (cancelled = true));
    void loadImage(src)
      .then((img) => {
        if (!cancelled) show(img, c.imageFile ? { existingFile: c.imageFile } : { remoteUrl: c.imageUrl! }, c.imageCrop);
      })
      .catch(() => {});
  });

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      // A File is already a Blob: display and persist it directly, no byte copy.
      const img = await loadImage(swapObjectUrl(file));
      show(img, { blob: file, name: file.name }, null);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function onLoadUrl() {
    const url = urlInput().trim();
    if (!url) return;
    setError(null);
    setBusy('Fetching…');
    try {
      // Stored on fetch: if the dialog is cancelled the file is an orphan the media
      // sweep reclaims, as with a declined bundle import.
      const file = await storage.downloadImage(url);
      const img = await loadImage(mediaSrc(file));
      show(img, { existingFile: file }, null);
    } catch {
      setError("Couldn't fetch that image. Check the URL and that you're online.");
    } finally {
      setBusy(null);
    }
  }

  // Reuse a picture already on the board: load it into the frame and mark it as an
  // existing file, so Save re-crops it without writing a second copy. The picker
  // closes itself once it hands the file back.
  async function onPickExisting(file: string) {
    setError(null);
    try {
      const img = await loadImage(mediaSrc(file));
      show(img, { existingFile: file }, null);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  function zoomTo(scale: number) {
    const s = source();
    const v = view();
    if (!s || !v) return;
    setView(zoomAbout(v, scale, frameGeom(s.natW, s.natH)));
  }

  function onPointerDown(e: PointerEvent) {
    const s = source();
    const v = view();
    if (!s || !v) return;
    // The frame is fixed for the whole drag, so measure it once here, not per move.
    const geom = frameGeom(s.natW, s.natH);
    const start = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty };
    const move = (ev: PointerEvent) => {
      setView((cur) =>
        cur ? clampView(cur.scale, start.tx + (ev.clientX - start.x), start.ty + (ev.clientY - start.y), cur.min, geom) : cur,
      );
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onWheel(e: WheelEvent) {
    const v = view();
    if (!v) return;
    // Away from the user zooms out, toward zooms in; the exponential keeps the step
    // proportional so a trackpad glides rather than leaps. The slider is the
    // deterministic control — this is just the convenience of it under the pointer.
    zoomTo(v.scale * Math.exp(-e.deltaY / 400));
  }

  async function onSave() {
    const c = card();
    const s = source();
    const v = view();
    if (!c || !s || !v) return;
    const crop = viewToCrop(v.scale, v.tx, v.ty, frameGeom(s.natW, s.natH));
    const { persist } = s;
    setBusy('Saving…');
    setError(null);
    try {
      let imageFile = persist.existingFile ?? null;
      if (!imageFile && persist.blob) {
        const { blob, name } = persist;
        imageFile = await storage.saveMedia(await blob.arrayBuffer(), { name, mime: blob.type });
      } else if (!imageFile && persist.remoteUrl) {
        imageFile = await storage.downloadImage(persist.remoteUrl);
      }
      if (!imageFile) throw new Error('There is no image to save.');
      boardStore.getState().updateCard(c.id, { imageFile, imageUrl: null, imageCrop: crop });
      close();
    } catch (e) {
      setError(messageOf(e));
      setBusy(null);
    }
  }

  const footer = (
    <>
      <Show when={busy()}>
        <span class="modal__status">{busy()}</span>
      </Show>
      <button class="link-button" onClick={close}>
        Cancel
      </button>
      <button onClick={() => void onSave()} disabled={!source() || !view() || busy() != null}>
        Save
      </button>
    </>
  );

  return (
    <Modal title="Card image" onClose={close} footer={footer}>
      <div class="field__row">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void onFile(e.currentTarget.files?.[0])}
        />
        <button onClick={() => fileInput.click()}>File</button>
        <Show when={existing().length > 0}>
          <button onClick={() => setPickerOpen(true)}>Object</button>
        </Show>
        <input
          class="field--grow"
          placeholder="…or paste an image URL"
          value={urlInput()}
          onInput={(e) => setUrlInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onLoadUrl();
          }}
        />
        <button onClick={() => void onLoadUrl()} disabled={!urlInput().trim() || busy() != null}>
          Load
        </button>
      </div>
      <Show when={pickerOpen()}>
        <ObjectPickerDialog
          objects={existing()}
          onPick={(file) => void onPickExisting(file)}
          onClose={() => setPickerOpen(false)}
        />
      </Show>
      <Show when={error()}>
        <p class="modal__warn">{error()}</p>
      </Show>
      <p class="field__hint">Drag to reposition, scroll or use the slider to zoom. The frame is how the card shows it.</p>

      <div class="image-cropper">
        <div class="image-cropper__frame" ref={frame} onPointerDown={onPointerDown} onWheel={onWheel}>
          <Show
            when={source() && view()}
            fallback={<span class="image-cropper__empty">Choose a file or load a URL to frame it here.</span>}
          >
            <img
              src={source()!.url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '0',
                top: '0',
                width: `${source()!.natW * view()!.scale}px`,
                height: `${source()!.natH * view()!.scale}px`,
                'max-width': 'none',
                transform: `translate(${view()!.tx}px, ${view()!.ty}px)`,
              }}
            />
          </Show>
        </div>
        <Show when={source() && view()}>
          <input
            type="range"
            min={view()!.min}
            max={zoomCeiling(view()!.min)}
            step="any"
            value={view()!.scale}
            onInput={(e) => zoomTo(Number(e.currentTarget.value))}
            aria-label="Zoom"
          />
        </Show>
      </div>
    </Modal>
  );
}
