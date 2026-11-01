//! The development harness: an MCP server on loopback that reads app state and
//! drives the window's DOM over Tauri events. Never in a release build.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_router, ErrorData};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use wslib_mcp::dom::{self, DomBridge, BRIDGE_TIMEOUT};
use wslib_mcp::result::{ok_json, tool_error};
use wslib_mcp::rmcp;
use wslib_mcp::router::mark_read_only;
use wslib_mcp::server::{ServerIdentity, ToolServer};
use wslib_mcp::tauri_bridge::TauriBridge;

use crate::jobs::Jobs;
use crate::library_mcp::{random_token, serve_loopback};

const PORT: u16 = 8792;

pub fn start(app: &AppHandle) {
  if let Err(e) = try_start(app) {
    log::warn!("[mcp] not started: {e}");
  }
}

fn try_start(app: &AppHandle) -> Result<(), String> {
  let token = match std::env::var("CONSPIRACY_MCP_TOKEN") {
    Ok(token) if !token.is_empty() => token,
    _ => random_token()?,
  };
  let tools = Tools { page: TauriBridge::new(app), jobs: app.state::<Arc<Jobs>>().inner().clone() };
  let router = Arc::new(Tools::router());
  let identity = Tools::identity();
  serve_loopback(PORT, token.clone(), move || ToolServer::new(tools.clone(), router.clone(), identity.clone()))?;

  let url = format!("http://127.0.0.1:{PORT}/mcp");
  // Not the app's data directory, which macOS guards from a terminal.
  let handoff = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/mcp.json");
  wslib_file_atomic::Options::new()
    .create_parents(true)
    .write(&handoff, json!({ "url": url, "token": token }).to_string().as_bytes())
    .map_err(|e| format!("{}: {e}", handoff.display()))?;
  log::info!("[mcp] dev server on {url}; token in {}", handoff.display());
  Ok(())
}

#[derive(Clone)]
struct Tools {
  page: TauriBridge<Wry>,
  jobs: Arc<Jobs>,
}

impl Tools {
  fn router() -> ToolRouter<Self> {
    let mut app = Self::app_router();
    mark_read_only(&mut app);
    app + dom::read_router() + dom::drive_router()
  }

  fn identity() -> ServerIdentity {
    ServerIdentity::new("conspiracy", env!("CARGO_PKG_VERSION"))
      .with_title("Conspiracy (dev)")
      .with_instructions(
        "Development harness for the Conspiracy board app. App tools only read state; every \
         change goes through the UI, which the DOM tools drive by CSS selector in the main window.",
      )
  }
}

impl DomBridge for Tools {
  async fn call(&self, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
    self.page.call(op, args, timeout).await
  }
}

#[tool_router(router = app_router)]
impl Tools {
  #[tool(description = "The open board: its id and title, and how many cards, connections and clusters it holds.")]
  async fn board_summary(&self) -> Result<CallToolResult, ErrorData> {
    match self.page.request("board_summary", json!({}), BRIDGE_TIMEOUT).await {
      Ok(summary) => ok_json(summary),
      Err(e) => Ok(tool_error(e)),
    }
  }

  #[tool(description = "How many media files the extraction workers have queued or are reading; 0 when idle.")]
  async fn jobs_pending(&self) -> Result<CallToolResult, ErrorData> {
    ok_json(json!({ "pending": self.jobs.pending() }))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_app_tools_and_the_dom_reads_are_the_read_only_ones() {
    let tools: Vec<_> = Tools::router()
      .list_all()
      .into_iter()
      .map(|t| (t.name.to_string(), t.annotations.and_then(|a| a.read_only_hint) == Some(true)))
      .collect();
    let expected = [
      ("board_summary", true),
      ("click", false),
      ("console", true),
      ("jobs_pending", true),
      ("press", false),
      ("query", true),
      ("type", false),
      ("wait_for", true),
    ]
    .map(|(name, read_only)| (name.to_string(), read_only));
    assert_eq!(tools, expected);
  }
}
