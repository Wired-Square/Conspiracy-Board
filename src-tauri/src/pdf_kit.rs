//! A PDF read through PDFKit: the fallback for a file lopdf can't parse, and the
//! renderer that turns a scanned page into an image for Vision to read.

use std::ptr::null_mut;

use objc2::rc::{autoreleasepool, Retained};
use objc2::AllocAnyThread;
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
  CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGContext, CGImageAlphaInfo,
};
use objc2_foundation::NSData;
use objc2_pdf_kit::{PDFDisplayBox, PDFDocument, PDFPage};

/// 300 dpi, so footnote-sized print still reads.
const RENDER_SCALE: f64 = 300.0 / 72.0;
/// The longest side of a rendered page, so an oversized page can't ask for a huge bitmap.
const MAX_RENDER_SIDE: f64 = 4096.0;

pub struct PdfKitDocument(Retained<PDFDocument>);

impl PdfKitDocument {
  /// `None` when PDFKit can't open it, it's locked, or it has no pages.
  pub fn open(bytes: &[u8]) -> Option<Self> {
    autoreleasepool(|_| {
      let data = NSData::with_bytes(bytes);
      let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }?;
      let readable = unsafe { !doc.isLocked() && doc.pageCount() > 0 };
      readable.then_some(Self(doc))
    })
  }

  pub fn page_count(&self) -> usize {
    unsafe { self.0.pageCount() }
  }

  pub fn page_text(&self, index: usize) -> String {
    autoreleasepool(|_| {
      self.page(index).and_then(|p| unsafe { p.string() }).map(|s| s.to_string()).unwrap_or_default()
    })
  }

  pub fn read_page(&self, index: usize) -> String {
    autoreleasepool(|_| {
      self
        .page(index)
        .and_then(|p| render(&p))
        .and_then(|bitmap| CGBitmapContextCreateImage(Some(&bitmap)))
        .map(|image| crate::ocr::recognise_image(&image))
        .unwrap_or_default()
    })
  }

  /// Out-of-range `pageAtIndex:` raises an Objective-C exception, which can't unwind
  /// through Rust.
  fn page(&self, index: usize) -> Option<Retained<PDFPage>> {
    (index < self.page_count()).then(|| unsafe { self.0.pageAtIndex(index) }).flatten()
  }
}

/// The page's crop box on a white 8-bit grey bitmap, turned upright.
fn render(page: &PDFPage) -> Option<CFRetained<CGContext>> {
  let bounds = unsafe { page.boundsForBox(PDFDisplayBox::CropBox) };
  let (mut width, mut height) = (bounds.size.width, bounds.size.height);
  if unsafe { page.rotation() } % 180 != 0 {
    (width, height) = (height, width);
  }
  let scale = RENDER_SCALE.min(MAX_RENDER_SIDE / width.max(height));
  let (pixels_wide, pixels_high) = ((width * scale).ceil() as usize, (height * scale).ceil() as usize);
  if pixels_wide == 0 || pixels_high == 0 {
    return None;
  }
  let grey = CGColorSpace::new_device_gray()?;
  let bitmap = unsafe {
    CGBitmapContextCreate(
      null_mut(),
      pixels_wide,
      pixels_high,
      8,
      0,
      Some(&grey),
      CGImageAlphaInfo::None.0,
    )
  }?;
  CGContext::set_gray_fill_color(Some(&bitmap), 1.0, 1.0);
  CGContext::fill_rect(
    Some(&bitmap),
    CGRect::new(CGPoint::ZERO, CGSize::new(pixels_wide as f64, pixels_high as f64)),
  );
  CGContext::scale_ctm(Some(&bitmap), scale, scale);
  unsafe { page.drawWithBox_toContext(PDFDisplayBox::CropBox, &bitmap) };
  Some(bitmap)
}

#[cfg(test)]
impl PdfKitDocument {
  /// The page as `render` draws it: width, height and one grey byte per pixel, top row first.
  pub fn render_grey(&self, index: usize) -> Option<(usize, usize, Vec<u8>)> {
    use objc2_core_graphics::{
      CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGBitmapContextGetHeight,
      CGBitmapContextGetWidth,
    };
    let bitmap = self.page(index).and_then(|p| render(&p))?;
    let (width, height) = (CGBitmapContextGetWidth(Some(&bitmap)), CGBitmapContextGetHeight(Some(&bitmap)));
    let row = CGBitmapContextGetBytesPerRow(Some(&bitmap));
    let data = CGBitmapContextGetData(Some(&bitmap)).cast::<u8>();
    let bytes = unsafe { std::slice::from_raw_parts(data, row * height) };
    Some((width, height, bytes.chunks(row).flat_map(|r| &r[..width]).copied().collect()))
  }
}

