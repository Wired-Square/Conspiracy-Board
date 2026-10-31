use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::board_store::board_db::create_board_db;
use crate::board_store::temp_dir_for;
use crate::schema::parse_board;

const STAMPED_BEFORE: &str = "2026-07-19T00:00:00.000Z";

fn fixture() -> Board {
  parse_board(json!({
    "version": 4,
    "meta": { "title": "Case", "updatedAt": STAMPED_BEFORE },
    "clusters": [
      { "id": "g1", "label": "One", "color": "#fff", "visible": true },
      { "id": "g2", "label": "Two", "color": "#000", "visible": true },
    ],
    "cards": [
      { "id": "a", "title": "A", "clusterIds": ["g1", "g2"], "position": { "x": 0, "y": 0 } },
      { "id": "b", "title": "B", "clusterIds": ["g2"], "position": { "x": 10, "y": 0 }, "imageFile": "shared.png" },
      { "id": "c", "title": "C", "clusterIds": [], "position": { "x": 20, "y": 0 }, "imageFile": "c.png" },
      { "id": "d", "title": "D", "clusterIds": [], "position": { "x": 30, "y": 0 }, "document": { "file": "shared.png" } },
    ],
    "connections": [
      { "id": "e1", "source": "a", "target": "b" },
      { "id": "e2", "source": "b", "target": "c" },
    ],
    "viewport": { "x": 0, "y": 0, "zoom": 1 },
  }))
  .unwrap()
}

struct Fixture {
  dir: PathBuf,
  path: PathBuf,
  session: Session,
}

impl Fixture {
  fn new(name: &str) -> Self {
    let dir = temp_dir_for(&format!("session-{name}"));
    let path = dir.join("brd_test.sqlite");
    create_board_db(&path, &fixture()).unwrap();
    let session = Session::open(&path, "brd_test".into()).unwrap();
    Self { dir, path, session }
  }

  /// The board as a fresh connection reads it back from disk.
  fn on_disk(&self) -> Board {
    reassemble_board(&rusqlite::Connection::open(&self.path).unwrap()).unwrap()
  }

  fn writes(&self) -> u64 {
    self.session.conn.total_changes()
  }

  fn refs(&self) -> Vec<String> {
    let conn = rusqlite::Connection::open(&self.path).unwrap();
    let mut stmt = conn.prepare("SELECT name FROM media_refs ORDER BY name").unwrap();
    stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
  }
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

fn patch(value: Value) -> Map<String, Value> {
  value.as_object().unwrap().clone()
}

fn ids<T: Row>(rows: &[T]) -> Vec<&str> {
  rows.iter().map(Row::id).collect()
}

fn card(id: &str) -> Card {
  parse_card(json!({ "id": id, "title": id, "clusterIds": [], "position": { "x": 0, "y": 0 } })).unwrap()
}

fn link(id: &str, source: &str, target: &str) -> Connection {
  from_value(json!({ "id": id, "source": source, "target": target })).unwrap()
}

#[test]
fn opening_a_session_writes_nothing() {
  let dir = temp_dir_for("session-open");
  let path = dir.join("brd_test.sqlite");
  create_board_db(&path, &fixture()).unwrap();
  let before = std::fs::read(&path).unwrap();
  let session = Session::open(&path, "brd_test".into()).unwrap();
  assert_eq!(session.conn.total_changes(), 0);
  assert_eq!(std::fs::read(&path).unwrap(), before);
  assert_eq!(session.board, fixture());
  drop(session);
  let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn opening_a_board_without_a_database_fails_without_making_one() {
  let dir = temp_dir_for("session-missing");
  let path = dir.join("brd_none.sqlite");
  assert!(Session::open(&path, "brd_none".into()).is_err());
  assert!(!path.exists());
  let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn update_card_writes_only_its_row_and_the_stamp() {
  let mut f = Fixture::new("update");
  let change = f.session.update_card("a", patch(json!({ "title": "Renamed" }))).unwrap().unwrap();
  // The card row, then the version and meta rows.
  assert_eq!(f.writes(), 3);
  assert_eq!(change.board_id, "brd_test");
  assert_eq!(ids(&change.cards), ["a"]);
  assert_eq!(change.cards[0].title, "Renamed");
  let stamp = &change.meta.as_ref().unwrap().updated_at;
  assert_ne!(stamp, STAMPED_BEFORE);
  assert!(crate::schema::UtcInstant::new(stamp.clone()).is_some());

  let disk = f.on_disk();
  assert_eq!(disk.cards[0].title, "Renamed");
  assert_eq!(disk.meta.updated_at, *stamp);
  assert_eq!(disk, f.session.board);
}

#[test]
fn an_edit_that_changes_nothing_neither_stamps_nor_emits() {
  let mut f = Fixture::new("noop");
  assert_eq!(f.session.update_card("a", patch(json!({ "title": "A" }))).unwrap(), None);
  assert_eq!(f.session.update_card("gone", patch(json!({ "title": "X" }))).unwrap(), None);
  assert_eq!(f.session.move_cards(&[CardMove { id: "a".into(), position: Vec2 { x: 0.0, y: 0.0 } }]).unwrap(), None);
  assert_eq!(f.session.update_cluster("g1", patch(json!({ "label": "One" }))).unwrap(), None);
  assert_eq!(f.session.update_cluster("gone", patch(json!({ "label": "X" }))).unwrap(), None);
  assert_eq!(f.session.set_meta(MetaPatch { title: Some("Case".into()), country_code: None }).unwrap(), None);
  assert_eq!(f.session.set_viewport(Viewport { x: 0.0, y: 0.0, zoom: 1.0 }).unwrap(), None);
  assert_eq!(f.session.delete_cards(&["gone".into()]).unwrap(), None);
  assert_eq!(f.session.delete_connections(&["gone".into()]).unwrap(), None);
  assert_eq!(f.session.delete_cluster("gone").unwrap(), None);
  assert_eq!(f.writes(), 0);
  assert_eq!(f.on_disk().meta.updated_at, STAMPED_BEFORE);
}

#[test]
fn the_viewport_persists_without_restamping() {
  let mut f = Fixture::new("viewport");
  let viewport = Viewport { x: 5.0, y: 6.0, zoom: 2.0 };
  let change = f.session.set_viewport(viewport).unwrap().unwrap();
  assert_eq!(change.meta, None);
  assert_eq!(change.viewport, Some(viewport));
  let disk = f.on_disk();
  assert_eq!(disk.viewport, Some(viewport));
  assert_eq!(disk.meta.updated_at, STAMPED_BEFORE);
}

#[test]
fn a_pan_after_an_edit_keeps_the_edit_stamp() {
  let mut f = Fixture::new("pan-after-edit");
  let edit = f.session.update_card("a", patch(json!({ "title": "Renamed" }))).unwrap().unwrap();
  f.session.set_viewport(Viewport { x: 5.0, y: 6.0, zoom: 2.0 }).unwrap();
  assert_eq!(f.on_disk().meta.updated_at, edit.meta.unwrap().updated_at);
}

#[test]
fn a_bulk_move_is_one_change_of_only_the_moved_cards() {
  let mut f = Fixture::new("move");
  let moves = [
    CardMove { id: "a".into(), position: Vec2 { x: 1.0, y: 1.0 } },
    CardMove { id: "b".into(), position: Vec2 { x: 10.0, y: 0.0 } },
    CardMove { id: "c".into(), position: Vec2 { x: 2.0, y: 2.0 } },
    CardMove { id: "gone".into(), position: Vec2 { x: 3.0, y: 3.0 } },
  ];
  let change = f.session.move_cards(&moves).unwrap().unwrap();
  assert_eq!(ids(&change.cards), ["a", "c"]);
  let disk = f.on_disk();
  assert_eq!(disk.cards[0].position, Vec2 { x: 1.0, y: 1.0 });
  assert_eq!(disk.cards[2].position, Vec2 { x: 2.0, y: 2.0 });
}

#[test]
fn added_cards_and_their_strings_append_in_one_change() {
  let mut f = Fixture::new("add");
  let change = f
    .session
    .add_cards(vec![card("x"), card("y")], vec![link("e3", "x", "a"), link("e4", "a", "b")])
    .unwrap()
    .unwrap();
  assert_eq!(ids(&change.cards), ["x", "y"]);
  // a→b is already strung.
  assert_eq!(ids(&change.connections), ["e3"]);
  let disk = f.on_disk();
  assert_eq!(ids(&disk.cards), ["a", "b", "c", "d", "x", "y"]);
  assert_eq!(ids(&disk.connections), ["e1", "e2", "e3"]);
}

#[test]
fn a_bad_add_writes_nothing() {
  let mut f = Fixture::new("bad-add");
  assert!(f.session.add_cards(vec![card("a")], vec![]).is_err());
  assert!(f.session.add_cards(vec![card("x"), card("x")], vec![]).is_err());
  assert!(f.session.add_cards(vec![card("x")], vec![link("e3", "x", "gone")]).is_err());
  assert!(f.session.add_cards(vec![], vec![link("e3", "a", "a")]).is_err());
  assert!(f.session.add_cards(vec![], vec![link("e1", "c", "a")]).is_err());
  assert_eq!(f.writes(), 0);
  assert_eq!(f.on_disk(), fixture());
}

#[test]
fn deleting_cards_takes_their_strings() {
  let mut f = Fixture::new("delete");
  let change = f.session.delete_cards(&["c".into(), "gone".into()]).unwrap().unwrap();
  assert_eq!(change.removed_cards, ["c"]);
  assert_eq!(change.removed_connections, ["e2"]);
  let disk = f.on_disk();
  assert_eq!(ids(&disk.cards), ["a", "b", "d"]);
  assert_eq!(ids(&disk.connections), ["e1"]);
}

#[test]
fn deleting_a_cluster_keeps_its_cards_without_the_membership() {
  let mut f = Fixture::new("cluster");
  let change = f.session.delete_cluster("g1").unwrap().unwrap();
  assert_eq!(change.removed_clusters, ["g1"]);
  assert_eq!(ids(&change.cards), ["a"]);
  let disk = f.on_disk();
  assert_eq!(ids(&disk.clusters), ["g2"]);
  assert_eq!(disk.cards[0].cluster_ids, ["g2"]);
  assert_eq!(disk.cards[1].cluster_ids, ["g2"]);
}

#[test]
fn add_cluster_appends_and_refuses_an_id_in_use() {
  let mut f = Fixture::new("add-cluster");
  let added = Cluster { id: "g3".into(), label: "Three".into(), color: "#f00".into(), visible: true };
  f.session.add_cluster(added.clone()).unwrap().unwrap();
  assert!(f.session.add_cluster(Cluster { label: "Again".into(), ..added }).is_err());
  let disk = f.on_disk();
  assert_eq!(ids(&disk.clusters), ["g1", "g2", "g3"]);
  assert_eq!(disk.clusters[2].label, "Three");
}

#[test]
fn update_cluster_patches_only_the_fields_it_names() {
  let mut f = Fixture::new("update-cluster");
  f.session.update_cluster("g1", patch(json!({ "label": "Renamed" }))).unwrap().unwrap();
  let change = f.session.update_cluster("g1", patch(json!({ "color": "#123456" }))).unwrap().unwrap();
  assert!(change.meta.as_ref().unwrap().updated_at != STAMPED_BEFORE);
  let g1 = &f.on_disk().clusters[0];
  assert_eq!((g1.label.as_str(), g1.color.as_str(), g1.visible), ("Renamed", "#123456", true));
  let writes = f.writes();
  assert!(f.session.update_cluster("g1", patch(json!({ "id": "g9" }))).is_err());
  assert!(f.session.update_cluster("g1", patch(json!({ "visible": "yes" }))).is_err());
  assert_eq!(f.writes(), writes);
}

#[test]
fn set_meta_changes_the_title_and_stamps() {
  let mut f = Fixture::new("meta");
  let change = f.session.set_meta(MetaPatch { title: Some("Renamed".into()), country_code: Some("+44".into()) }).unwrap().unwrap();
  let meta = change.meta.unwrap();
  assert_eq!((meta.title.as_str(), meta.country_code.as_deref()), ("Renamed", Some("+44")));
  assert_ne!(meta.updated_at, STAMPED_BEFORE);
  assert_eq!(f.on_disk().meta, meta);
}

#[test]
fn a_patch_is_validated_whole_and_keeps_the_id() {
  let mut f = Fixture::new("patch");
  assert!(f.session.update_card("a", patch(json!({ "kind": "suspect" }))).is_err());
  assert!(f.session.update_card("a", patch(json!({ "id": "z" }))).is_err());
  assert!(f.session.update_card("a", patch(json!({ "occurredAt": "2026-01-01T00:00:00+10:00" }))).is_err());
  assert!(f.session.update_connection("e1", patch(json!({ "target": "gone" }))).is_err());
  assert_eq!(f.writes(), 0);
  let change = f.session.update_connection("e1", patch(json!({ "label": "knows", "grade": "asserted" }))).unwrap().unwrap();
  assert_eq!(change.connections[0].label.as_deref(), Some("knows"));
  assert_eq!(f.on_disk().connections[0], change.connections[0]);
}

#[test]
fn media_refs_follow_the_cards() {
  let mut f = Fixture::new("refs");
  assert_eq!(f.refs(), ["c.png", "shared.png"]);
  f.session.delete_cards(&["c".into()]).unwrap().unwrap();
  // d still holds shared.png.
  f.session.update_card("b", patch(json!({ "imageFile": "new.png" }))).unwrap().unwrap();
  assert_eq!(f.refs(), ["new.png", "shared.png"]);
  f.session.delete_cards(&["d".into()]).unwrap().unwrap();
  assert_eq!(f.refs(), ["new.png"]);
}

#[test]
fn the_event_is_camel_case_with_meta_only_for_content() {
  let mut f = Fixture::new("event");
  let moved = f.session.set_viewport(Viewport { x: 1.0, y: 1.0, zoom: 1.0 }).unwrap().unwrap();
  let event = serde_json::to_value(&moved).unwrap();
  assert_eq!(event["boardId"], "brd_test");
  assert!(event.get("meta").is_none());
  assert_eq!(event["removedCards"], json!([]));
  let deleted = serde_json::to_value(f.session.delete_cards(&["a".into()]).unwrap().unwrap()).unwrap();
  assert_eq!(deleted["removedCards"], json!(["a"]));
  assert_eq!(deleted["removedConnections"], json!(["e1"]));
  assert!(deleted["meta"]["updatedAt"].is_string());
}

#[test]
fn closing_ignores_another_boards_id() {
  let open = OpenBoard::default();
  let f = Fixture::new("close");
  *open.lock().unwrap() = Some(Session::open(&f.path, "brd_test".into()).unwrap());
  open.close("brd_other").unwrap();
  assert!(open.lock().unwrap().is_some());
  open.close("brd_test").unwrap();
  assert!(open.lock().unwrap().is_none());
}
