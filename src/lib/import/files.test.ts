import { describe, expect, it } from 'vitest';
import { documentMime, isDocumentFile, isImageFile, isMediaFile } from './files';

describe('isImageFile', () => {
  it('matches common photo extensions, case-insensitively', () => {
    for (const n of ['a.jpg', 'a.JPEG', 'b.png', 'c.heic', 'd.tif', 'e.tiff', 'f.webp', 'g.avif', 'h.svg']) {
      expect(isImageFile(n)).toBe(true);
    }
  });
  it("doesn't match documents or email", () => {
    for (const n of ['a.pdf', 'b.docx', 'c.eml', 'd.txt']) expect(isImageFile(n)).toBe(false);
  });
});

describe('isDocumentFile', () => {
  it('matches PDF and Office, modern and legacy', () => {
    for (const n of ['a.pdf', 'b.doc', 'b.docx', 'c.xls', 'c.xlsx', 'd.ppt', 'd.pptx', 'E.PDF']) {
      expect(isDocumentFile(n)).toBe(true);
    }
  });
  it("doesn't claim .txt (that stays with email) or images", () => {
    for (const n of ['note.txt', 'photo.png', 'msg.eml']) expect(isDocumentFile(n)).toBe(false);
  });
});

describe('isMediaFile', () => {
  it('is the union of images and documents, and excludes email', () => {
    expect(isMediaFile('a.png')).toBe(true);
    expect(isMediaFile('a.pdf')).toBe(true);
    expect(isMediaFile('a.eml')).toBe(false);
  });
});

describe('documentMime', () => {
  it('maps known document extensions', () => {
    expect(documentMime('a.pdf')).toBe('application/pdf');
    expect(documentMime('a.DOCX')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
  it('is undefined for the unknown or extensionless', () => {
    expect(documentMime('a.png')).toBeUndefined();
    expect(documentMime('noext')).toBeUndefined();
  });
});
