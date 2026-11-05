//! The edits the library MCP may make, each through the session's own commands. None
//! removes a row, and none changes the media files a card holds.

use std::collections::HashSet;
use std::path::Path;

use serde_json::{Map, Value};

use super::{changed, patched, publish, BoardEdit, CardMove, DocChanged, MetaPatch, OpenBoard, Outcome, Row, Session};
use crate::board_store::board_db::board_db_in;
use crate::library_index::LibraryDb;
use crate::schema::{parse_card, Card, Cluster, Connection, Vec2};

pub(crate) const CARD_FIELDS: &[&str] = &[
  "title",
  "notes",
  "kind",
  "occurredAt",
  "occurredAtPrecision",
  "grade",
  "clusterIds",
  "email",
  "message",
  "call",
  "person",
  "organisation",
  "document",
  "event",
];
const CONNECTION_FIELDS: &[&str] = &["source", "target", "label", "kind", "grade"];
const CLUSTER_FIELDS: &[&str] = &["label", "color", "visible"];

/// `CLUSTER_PALETTE` in `src/store/boardStore.ts`.
const CLUSTER_PALETTE: [&str; 12] = [
  "#e23b3b", "#3b7de2", "#e2a13b", "#3bd17a", "#b06be0", "#e06ba8", "#3bd1c4", "#e2673b", "#6b6be0", "#9bd13b", "#d13bb0",
  "#d9cf3b",
];

/// `gridPositions` in `src/lib/layout.ts`.
const CARD_W: f64 = 210.0;
const GUTTER: f64 = 110.0;
const STEP_X: f64 = 260.0;
const STEP_Y: f64 = 220.0;
const MAX_COLS: f64 = 6.0;

/// Runs `edit` through the open session when it holds `board_id`, so it lands on that
/// session's undo log; otherwise through a session opened for this edit alone, with no
/// undo. The lock is held throughout, so the app can't open the board mid-edit.
pub(crate) fn edit_board(
  open: &OpenBoard,
  library: &LibraryDb,
  boards: &Path,
  board_id: &str,
  edit: impl FnOnce(&mut Session) -> Outcome,
  emit: impl FnOnce(&DocChanged),
) -> Outcome {
  let mut guard = open.lock()?;
  let change = match guard.as_mut().filter(|s| s.board_id == board_id) {
    Some(session) => edit(session)?,
    None => {
      let path = board_db_in(boards, board_id)?.ok_or_else(|| format!("No board {board_id:?}."))?;
      let change = edit(&mut Session::open(&path, board_id.to_string())?)?;
      change.map(|change| DocChanged { can_undo: false, can_redo: false, ..change })
    }
  };
  if let Some(change) = &change {
    publish(library, change, emit)?;
  }
  Ok(change)
}

pub(crate) fn only(patch: &Map<String, Value>, fields: &[&str], what: &str) -> Result<(), String> {
  match patch.keys().find(|key| !fields.contains(&key.as_str())) {
    Some(key) => Err(format!("{key:?} isn't a {what} field that can be set here. These are: {}.", fields.join(", "))),
    None => Ok(()),
  }
}

fn found<T: Row>(rows: &[T], id: &str, what: &str) -> Result<(), String> {
  match rows.iter().any(|r| r.id() == id) {
    true => Ok(()),
    false => Err(format!("No {what} {id:?}.")),
  }
}

impl Session {
  pub(crate) fn cards(&self) -> &[Card] {
    &self.board.cards
  }

  pub(crate) fn next_cluster_colour(&self) -> String {
    CLUSTER_PALETTE[self.board.clusters.len() % CLUSTER_PALETTE.len()].to_string()
  }

  fn check_clusters(&self, ids: &[String], added: &[Cluster]) -> Result<(), String> {
    match ids.iter().find(|id| !self.board.clusters.iter().chain(added).any(|c| c.id == **id)) {
      Some(id) => Err(format!("No cluster {id:?}.")),
      None => Ok(()),
    }
  }

  /// Lays new cards out as an import does (`addCards`): the ones the board draws
  /// first, then oldest first, in a grid from `origin` or clear of the drawn cards.
  pub(crate) fn place(&self, cards: &mut [Card], origin: Option<Vec2>) {
    cards.sort_by(|a, b| {
      let order = |c: &Card| (c.kind.is_record(), c.occurred_at.is_none(), c.occurred_at.clone());
      order(a).cmp(&order(b))
    });
    let origin = origin.unwrap_or_else(|| {
      let drawn = self.board.cards.iter().filter(|c| !c.kind.is_record()).map(|c| c.position);
      drawn
        .reduce(|a, b| Vec2 { x: a.x.max(b.x), y: a.y.min(b.y) })
        .map_or(Vec2 { x: 80.0, y: 80.0 }, |edge| Vec2 { x: edge.x + CARD_W + GUTTER, y: edge.y })
    });
    let cols = (cards.len() as f64).sqrt().ceil().clamp(1.0, MAX_COLS) as usize;
    for (i, card) in cards.iter_mut().enumerate() {
      card.position = Vec2 { x: origin.x + (i % cols) as f64 * STEP_X, y: origin.y + (i / cols) as f64 * STEP_Y };
    }
  }

  /// Clusters, cards and the strings among them, as one edit. A card's clusters must
  /// be on the board or among those added, and a string must not repeat a pair.
  pub(crate) fn add(&mut self, clusters: Vec<Cluster>, cards: Vec<Card>, connections: Vec<Connection>) -> Outcome {
    for card in &cards {
      self.check_clusters(&card.cluster_ids, &clusters)?;
    }
    let mut pairs: HashSet<(&str, &str)> =
      self.board.connections.iter().map(|c| (c.source.as_str(), c.target.as_str())).collect();
    if let Some(link) = connections.iter().find(|l| !pairs.insert((&l.source, &l.target))) {
      return Err(format!("{:?} is already connected to {:?}.", link.source, link.target));
    }
    self.apply_edit(BoardEdit { clusters, cards, connections, card_updates: Vec::new() })
  }

  pub(crate) fn edit_card(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    only(&patch, CARD_FIELDS, "card")?;
    let card = self.card(id).ok_or_else(|| format!("No card {id:?}."))?;
    let next = patched(card, patch, parse_card)?;
    if !next.media_files().eq(card.media_files()) {
      return Err("An edit can't change the files a card holds.".into());
    }
    self.check_clusters(&next.cluster_ids, &[])?;
    self.commit(DocChanged { cards: changed(card, next), ..Default::default() })
  }

  pub(crate) fn move_existing(&mut self, moves: Vec<(String, Vec2)>) -> Outcome {
    if let Some((id, _)) = moves.iter().find(|(id, _)| !self.has_card(id)) {
      return Err(format!("No card {id:?}."));
    }
    let moves: Vec<CardMove> = moves.into_iter().map(|(id, position)| CardMove { id, position }).collect();
    self.move_cards(&moves)
  }

  pub(crate) fn edit_connection(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    only(&patch, CONNECTION_FIELDS, "connection")?;
    found(&self.board.connections, id, "connection")?;
    self.update_connection(id, patch)
  }

  pub(crate) fn edit_cluster(&mut self, id: &str, patch: Map<String, Value>) -> Outcome {
    only(&patch, CLUSTER_FIELDS, "cluster")?;
    found(&self.board.clusters, id, "cluster")?;
    self.update_cluster(id, patch)
  }

  pub(crate) fn rename(&mut self, title: &str) -> Outcome {
    let title = title.trim();
    if title.is_empty() {
      return Err("A board needs a title.".into());
    }
    self.set_meta(MetaPatch { title: Some(title.to_string()), ..Default::default() })
  }
}

#[cfg(test)]
impl OpenBoard {
  pub(crate) fn holding(path: &Path, board_id: &str) -> Self {
    Self(std::sync::Mutex::new(Some(Session::open(path, board_id.to_string()).unwrap())))
  }

  pub(crate) fn undo(&self) -> Outcome {
    self.lock()?.as_mut().ok_or("Nothing is open.")?.undo()
  }

  pub(crate) fn board(&self) -> Option<crate::schema::Board> {
    self.lock().unwrap().as_ref().map(|s| s.board.clone())
  }
}

#[cfg(test)]
mod tests;
