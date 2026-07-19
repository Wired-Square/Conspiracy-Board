//! Text recognition for imported images, via the macOS Vision framework.
//!
//! A screenshot of a text-message thread is the practical way to get a
//! conversation onto the board — there is no clean iMessage/SMS export — but a
//! screenshot is an opaque picture. Vision reads the words back out of it,
//! on-device and offline, so the card can carry the conversation as text:
//! searchable, quotable, editable. Best-effort throughout — anything unreadable
//! just yields an empty string, and the image is still imported as the picture it
//! is. Runs off the main thread (a Tauri command does), which Vision is happy with.

use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary};
use objc2_vision::{
  VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
  VNRequestTextRecognitionLevel,
};

/// Recognise text in the given image bytes: the top candidate line for each block
/// Vision finds, joined in reading order. Empty when there is nothing to read or
/// Vision cannot decode the bytes.
pub fn recognise_text(bytes: &[u8]) -> String {
  let data = NSData::with_bytes(bytes);
  // No decode hints; Vision sniffs the format itself.
  let options = NSDictionary::new();
  let handler =
    VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &options);

  let request = VNRecognizeTextRequest::new();
  // Accurate over Fast: a chat screenshot is dense small text, and this runs once
  // at import, not per frame. Language correction fixes the obvious slips.
  request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
  request.setUsesLanguageCorrection(true);

  let request_ref: &VNRequest = &request;
  let requests = NSArray::from_slice(&[request_ref]);
  if handler.performRequests_error(&requests).is_err() {
    return String::new();
  }

  let Some(results) = request.results() else {
    return String::new();
  };

  let mut lines: Vec<String> = Vec::new();
  for obs in results.iter() {
    // A text request's observations are always VNRecognizedTextObservation.
    let Ok(text_obs) = obs.downcast::<VNRecognizedTextObservation>() else {
      continue;
    };
    if let Some(text) = text_obs.topCandidates(1).firstObject() {
      lines.push(text.string().to_string());
    }
  }
  lines.join("\n")
}
