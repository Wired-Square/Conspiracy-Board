import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { ObjectPickerDialog, type PickableObject } from './ObjectPickerDialog';
import { useBoardStore } from '../../store/boardStore';
import { useImageEditorStore } from '../../store/imageEditorStore';
import { storage } from '../../storage';
import { downloadImage, extForFetched, extOf, mediaSrc } from '../../storage/media';
import { clamp, clampOffset, coverScale, cropToView, viewToCrop, type Geom } from '../../lib/imageCrop';
import type { ImageCrop } from '../../types/board';

// The crop is authored in a 4:3 frame, matching how a card shows its picture. The
// minimum scale is cover-fit, so the frame is never left showing bare film. The
// ceiling is the larger of two limits (see zoomCeiling), so a small image keeps its
// headroom while a big one can still be cropped in tight to a single face.
const MAX_ZOOM = 5; // …× the cover-fit scale
const MAX_UPSCALE = 3; // …× the image's own pixels

// The most the frame may zoom in. `min` is the cover-fit scale, which for a large
// image is tiny — so `min * MAX_ZOOM` alone can sit well below the image's natural
// size, leaving a group shot un-croppable to one face. Allowing up to MAX_UPSCALE×
// the natural pixels regardless lifts that: whichever limit is higher wins, so no
// image loses reach and a big one gains it.
const zoomCeiling = (min: number) => Math.max(min * MAX_ZOOM, MAX_UPSCALE);

// What the frame is currently showing: the image's on-screen size (`scale` px per
// natural px) and where its top-left sits relative to the frame's, plus the
// smallest scale that still covers the frame (the zoom floor).
type View = { scale: number; tx: number; ty: number; min: number };

// What Save will store as the media file. An existing library file is kept and
// only re-cropped; a picked file or a fetched URL is written from the held Blob on
// Save; a remote URL the migration hasn't localised yet is downloaded then.
type Persist = { existingFile?: string; blob?: Blob; ext?: string; remoteUrl?: string };

// The loaded image and how Save will persist it — always set together, so one bit
// of state rather than two kept in step.
type Source = { url: string; natW: number; natH: number; persist: Persist };

/** A view with its offset clamped so the image keeps covering the frame. */
function clampView(scale: number, tx: number, ty: number, min: number, geom: Geom): View {
  return { scale, min, ...clampOffset(scale, tx, ty, geom) };
}

/** The view to open on: a stored crop restored, else cover-fit and centred. */
function initialView(geom: Geom, crop: ImageCrop | null): View {
  const min = coverScale(geom);
  if (crop) {
    const { scale, tx, ty } = cropToView(crop, geom);
    return clampView(scale, tx, ty, min, geom);
  }
  return clampView(min, (geom.fw - geom.natW * min) / 2, (geom.fh - geom.natH * min) / 2, min, geom);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be loaded."));
    img.src = url;
  });
}

export function ImageEditorModal({ cardId }: { cardId: string }) {
  const card = useBoardStore((s) => s.cards.find((c) => c.id === cardId));
  const cards = useBoardStore((s) => s.cards);
  const updateCard = useBoardStore((s) => s.updateCard);
  const close = useImageEditorStore((s) => s.close);

  // Pictures already on the board, one tile per file — the name is content-addressed,
  // so cards sharing an image share the one file (a group photo lands on everyone in
  // it). Each tile keeps all the cards that use it, first seen first, so the picker
  // can find it by any of them and show how many it is linked to. Picking one reuses
  // its stored file verbatim (see onSave's existingFile branch); nothing re-imports.
  const existing = useMemo(() => {
    const byFile = new Map<string, PickableObject>();
    for (const c of cards) {
      if (!c.imageFile) continue;
      const tile = byFile.get(c.imageFile);
      if (tile) tile.cards.push(c);
      else byFile.set(c.imageFile, { cards: [c], file: c.imageFile, src: mediaSrc(c.imageFile) });
    }
    return [...byFile.values()];
  }, [cards]);

  const frameRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [source, setSource] = useState<Source | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A blob URL for a picked file or a fetched image, replaced as the source
  // changes and revoked on unmount so a dialog opened many times leaks none.
  function swapObjectUrl(blob: Blob): string {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(blob);
    objectUrlRef.current = url;
    return url;
  }
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  /** The frame's on-screen box plus the image's natural pixels — measured now, as
   *  the frame is always mounted (it shows the empty-state span when there's none). */
  function frameGeom(natW: number, natH: number): Geom {
    const { width, height } = frameRef.current!.getBoundingClientRect();
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
  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    const src = card.imageFile ? mediaSrc(card.imageFile) : card.imageUrl;
    if (!src) return;
    void loadImage(src)
      .then((img) => {
        if (cancelled) return;
        show(img, card.imageFile ? { existingFile: card.imageFile } : { remoteUrl: card.imageUrl! }, card.imageCrop);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Only on open: later source changes go through the file / URL handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      // A File is already a Blob: display and persist it directly, no byte copy.
      const img = await loadImage(swapObjectUrl(file));
      show(img, { blob: file, ext: extOf(file.name, file.type) }, null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }

  async function onLoadUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setError(null);
    setBusy('Fetching…');
    try {
      const { bytes, mime } = await storage.fetchImage(url);
      const blob = new Blob([bytes], mime ? { type: mime } : undefined);
      const img = await loadImage(swapObjectUrl(blob));
      show(img, { blob, ext: extForFetched(url, mime) }, null);
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
      setError(String((e as Error).message ?? e));
    }
  }

  // Zoom about the frame's centre, keeping whatever is under it fixed, then re-clamp.
  function zoomTo(scale: number) {
    if (!source || !view) return;
    const geom = frameGeom(source.natW, source.natH);
    const next = clamp(scale, view.min, zoomCeiling(view.min));
    const ix = (geom.fw / 2 - view.tx) / view.scale;
    const iy = (geom.fh / 2 - view.ty) / view.scale;
    setView(clampView(next, geom.fw / 2 - ix * next, geom.fh / 2 - iy * next, view.min, geom));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!source || !view) return;
    // The frame is fixed for the whole drag, so measure it once here, not per move.
    const geom = frameGeom(source.natW, source.natH);
    const start = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    const move = (ev: PointerEvent) => {
      setView((v) => (v ? clampView(v.scale, start.tx + (ev.clientX - start.x), start.ty + (ev.clientY - start.y), v.min, geom) : v));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onWheel(e: React.WheelEvent) {
    if (!view) return;
    // Away from the user zooms out, toward zooms in; the exponential keeps the step
    // proportional so a trackpad glides rather than leaps. The slider is the
    // deterministic control — this is just the convenience of it under the pointer.
    zoomTo(view.scale * Math.exp(-e.deltaY / 400));
  }

  async function onSave() {
    if (!card || !source || !view) return;
    const crop = viewToCrop(view.scale, view.tx, view.ty, frameGeom(source.natW, source.natH));
    const { persist } = source;
    setBusy('Saving…');
    setError(null);
    try {
      let imageFile = persist.existingFile ?? null;
      if (!imageFile && persist.blob) imageFile = await storage.saveMedia(await persist.blob.arrayBuffer(), persist.ext ?? 'bin');
      else if (!imageFile && persist.remoteUrl) imageFile = await downloadImage(persist.remoteUrl);
      if (!imageFile) throw new Error('There is no image to save.');
      updateCard(card.id, { imageFile, imageUrl: null, imageCrop: crop });
      close();
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(null);
    }
  }

  const footer = (
    <>
      {busy && <span className="modal__status">{busy}</span>}
      <button className="link-button" onClick={close}>
        Cancel
      </button>
      <button onClick={() => void onSave()} disabled={!source || !view || busy != null}>
        Save
      </button>
    </>
  );

  return (
    <Modal title="Card image" onClose={close} footer={footer}>
      <div className="field__row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button onClick={() => fileRef.current?.click()}>File</button>
        {existing.length > 0 && <button onClick={() => setPickerOpen(true)}>Object</button>}
        <input
          className="field--grow"
          placeholder="…or paste an image URL"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onLoadUrl();
          }}
        />
        <button onClick={() => void onLoadUrl()} disabled={!urlInput.trim() || busy != null}>
          Load
        </button>
      </div>
      {pickerOpen && (
        <ObjectPickerDialog
          objects={existing}
          onPick={(file) => void onPickExisting(file)}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {error && <p className="modal__warn">{error}</p>}
      <p className="field__hint">Drag to reposition, scroll or use the slider to zoom. The frame is how the card shows it.</p>

      <div className="image-cropper">
        <div
          className="image-cropper__frame"
          ref={frameRef}
          onPointerDown={onPointerDown}
          onWheel={onWheel}
        >
          {source && view ? (
            <img
              src={source.url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: source.natW * view.scale,
                height: source.natH * view.scale,
                maxWidth: 'none',
                transform: `translate(${view.tx}px, ${view.ty}px)`,
              }}
            />
          ) : (
            <span className="image-cropper__empty">Choose a file or load a URL to frame it here.</span>
          )}
        </div>
        {source && view && (
          <input
            type="range"
            min={view.min}
            max={zoomCeiling(view.min)}
            step="any"
            value={view.scale}
            onChange={(e) => zoomTo(Number(e.target.value))}
            aria-label="Zoom"
          />
        )}
      </div>
    </Modal>
  );
}
