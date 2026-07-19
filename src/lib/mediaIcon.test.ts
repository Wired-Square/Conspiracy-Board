import { describe, expect, it } from 'vitest';
import { mediaIconFor, mediaIconForKind } from './mediaIcon';

describe('mediaIconFor', () => {
  it('reads the .eml itself as the email, never an attachment', () => {
    expect(mediaIconFor('abc.eml', 'eml')).toEqual({ type: 'email', attachment: false });
  });

  it('picks the base icon from the file type', () => {
    expect(mediaIconFor('clip.mp4').type).toBe('movie');
    expect(mediaIconFor('song.mp3').type).toBe('sound');
    expect(mediaIconFor('photo.jpg').type).toBe('image');
    expect(mediaIconFor('warrant.pdf').type).toBe('document');
  });

  it('falls back to a document for an unknown type', () => {
    expect(mediaIconFor('mystery.bin').type).toBe('document');
  });

  it('clips a file that came in on an email, keeping its own type', () => {
    expect(mediaIconFor('invoice.pdf', 'attachment')).toEqual({
      type: 'document',
      attachment: true,
    });
    expect(mediaIconFor('demo.mov', 'attachment')).toEqual({ type: 'movie', attachment: true });
  });

  it('does not clip a standalone image or document card', () => {
    expect(mediaIconFor('photo.png', 'image').attachment).toBe(false);
    expect(mediaIconFor('report.docx', 'document').attachment).toBe(false);
  });
});

describe('mediaIconForKind', () => {
  it('gives the record kinds their glyph and nothing else one', () => {
    expect(mediaIconForKind('email')).toBe('email');
    expect(mediaIconForKind('document')).toBe('document');
    expect(mediaIconForKind('person')).toBeNull();
    expect(mediaIconForKind('organisation')).toBeNull();
    expect(mediaIconForKind('event')).toBeNull();
    expect(mediaIconForKind('evidence')).toBeNull();
  });
});
