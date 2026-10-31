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

fn cluster(id: &str) -> Cluster {
  Cluster { id: id.into(), label: id.into(), color: "#f00".into(), visible: true }
}

fn adding(cards: Vec<Card>, connections: Vec<Connection>) -> BoardEdit {
  BoardEdit { cards, connections, ..Default::default() }
}

fn adding_cluster(cluster: Cluster) -> BoardEdit {
  BoardEdit { clusters: vec![cluster], ..Default::default() }
}

fn card_update(id: &str, value: Value) -> CardUpdate {
  CardUpdate { id: id.into(), patch: patch(value) }
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
  let change = f.session.update_card("a", patch(json!({ "title": "Renamed" })), Logged::Edit).unwrap().unwrap();
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
  assert_eq!(f.session.update_card("a", patch(json!({ "title": "A" })), Logged::Edit).unwrap(), None);
  assert_eq!(f.session.update_card("gone", patch(json!({ "title": "X" })), Logged::Edit).unwrap(), None);
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
  let edit = f.session.update_card("a", patch(json!({ "title": "Renamed" })), Logged::Edit).unwrap().unwrap();
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
    .apply_edit(adding(vec![card("x"), card("y")], vec![link("e3", "x", "a"), link("e4", "a", "b")]))
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
  assert!(f.session.apply_edit(adding(vec![card("a")], vec![])).is_err());
  assert!(f.session.apply_edit(adding(vec![card("x"), card("x")], vec![])).is_err());
  assert!(f.session.apply_edit(adding(vec![card("x")], vec![link("e3", "x", "gone")])).is_err());
  assert!(f.session.apply_edit(adding(vec![], vec![link("e3", "a", "a")])).is_err());
  assert!(f.session.apply_edit(adding(vec![], vec![link("e1", "c", "a")])).is_err());
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
fn an_added_cluster_appends_and_an_id_in_use_is_refused() {
  let mut f = Fixture::new("add-cluster");
  let added = cluster("g3");
  f.session.apply_edit(adding_cluster(added.clone())).unwrap().unwrap();
  assert!(f.session.apply_edit(adding_cluster(Cluster { label: "Again".into(), ..added })).is_err());
  let disk = f.on_disk();
  assert_eq!(ids(&disk.clusters), ["g1", "g2", "g3"]);
  assert_eq!(disk.clusters[2].label, "g3");
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
  assert!(f.session.update_card("a", patch(json!({ "kind": "suspect" })), Logged::Edit).is_err());
  assert!(f.session.update_card("a", patch(json!({ "id": "z" })), Logged::Edit).is_err());
  assert!(f.session.update_card("a", patch(json!({ "occurredAt": "2026-01-01T00:00:00+10:00" })), Logged::Edit).is_err());
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
  f.session.update_card("b", patch(json!({ "imageFile": "new.png" })), Logged::Edit).unwrap().unwrap();
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

fn unstamped(mut board: Board) -> Board {
  board.meta.updated_at = String::new();
  board
}

type Edit = fn(&mut Session) -> Outcome;

fn tidied() -> Vec<CardMove> {
  let row = |(i, id): (usize, &str)| CardMove { id: id.into(), position: Vec2 { x: 100.0, y: i as f64 * 50.0 } };
  ["a", "b", "c", "d"].into_iter().enumerate().map(row).collect()
}

/// A new cluster, a message and a person in it, a message already on the board
/// joining it, and a person gaining an address.
fn email_import() -> BoardEdit {
  let joined = |id: &str| parse_card(json!({ "id": id, "title": id, "clusterIds": ["g3"], "position": { "x": 0, "y": 0 } }));
  BoardEdit {
    clusters: vec![cluster("g3")],
    cards: vec![joined("m1").unwrap(), joined("p1").unwrap()],
    connections: vec![],
    card_updates: vec![
      card_update("b", json!({ "clusterIds": ["g2", "g3"] })),
      card_update("c", json!({ "notes": "jo@example.com" })),
    ],
  }
}

#[test]
fn an_import_is_one_change_written_in_one_transaction() {
  let mut f = Fixture::new("import");
  let change = f.session.apply_edit(email_import()).unwrap().unwrap();
  assert_eq!(ids(&change.clusters), ["g3"]);
  assert_eq!(ids(&change.cards), ["m1", "p1", "b", "c"]);
  let disk = f.on_disk();
  assert_eq!(disk, f.session.board);
  assert_eq!(ids(&disk.cards), ["a", "b", "c", "d", "m1", "p1"]);
  assert_eq!(disk.cards[1].cluster_ids, ["g2", "g3"]);
  assert_eq!(f.session.undo.len(), 1);
}

#[test]
fn patches_in_one_edit_stack_and_skip_unknown_and_unchanged_cards() {
  let mut f = Fixture::new("import-patches");
  let edit = BoardEdit {
    cards: vec![card("x")],
    card_updates: vec![
      card_update("a", json!({ "title": "One" })),
      card_update("a", json!({ "notes": "Two" })),
      card_update("x", json!({ "title": "Fresh" })),
      card_update("b", json!({ "title": "B" })),
      card_update("gone", json!({ "title": "Nobody" })),
    ],
    ..Default::default()
  };
  let change = f.session.apply_edit(edit).unwrap().unwrap();
  assert_eq!(ids(&change.cards), ["x", "a"]);
  let disk = f.on_disk();
  assert_eq!((disk.cards[0].title.as_str(), disk.cards[0].notes.as_str()), ("One", "Two"));
  assert_eq!(disk.cards[4].title, "Fresh");
}

#[test]
fn a_bad_import_writes_nothing() {
  let mut f = Fixture::new("bad-import");
  assert!(f.session.apply_edit(adding_cluster(cluster("g1"))).is_err());
  let bad_patch = BoardEdit { card_updates: vec![card_update("a", json!({ "position": "here" }))], ..email_import() };
  assert!(f.session.apply_edit(bad_patch).is_err());
  let renaming = BoardEdit { card_updates: vec![card_update("a", json!({ "id": "z" }))], ..Default::default() };
  assert!(f.session.apply_edit(renaming).is_err());
  assert_eq!(f.writes(), 0);
  assert_eq!(f.on_disk(), fixture());
  assert!(f.session.undo.is_empty());
}

#[test]
fn every_kind_of_edit_undoes_and_redoes_exactly() {
  let edits: [(&str, Edit); 15] = [
    ("update_card", |s| s.update_card("a", patch(json!({ "title": "Renamed", "imageFile": "new.png" })), Logged::Edit)),
    ("move_cards", |s| s.move_cards(&[CardMove { id: "b".into(), position: Vec2 { x: 9.0, y: 9.0 } }])),
    ("tidy", |s| s.move_cards(&tidied())),
    ("email_import", |s| s.apply_edit(email_import())),
    ("add_cards", |s| s.apply_edit(adding(vec![card("x")], vec![link("e3", "x", "a")]))),
    ("add_connections", |s| s.apply_edit(adding(vec![], vec![link("e3", "c", "a")]))),
    ("delete_card", |s| s.delete_cards(&["b".into()])),
    ("delete_cards", |s| s.delete_cards(&["a".into(), "c".into()])),
    ("update_connection", |s| s.update_connection("e1", patch(json!({ "label": "knows" })))),
    ("delete_connections", |s| s.delete_connections(&["e1".into()])),
    ("add_cluster", |s| s.apply_edit(adding_cluster(cluster("g3")))),
    ("update_cluster", |s| s.update_cluster("g2", patch(json!({ "visible": false })))),
    ("recolour_cluster", |s| s.update_cluster("g2", patch(json!({ "color": "#0f0" })))),
    ("delete_cluster", |s| s.delete_cluster("g1")),
    ("set_meta", |s| s.set_meta(MetaPatch { title: Some("Renamed".into()), country_code: Some("+44".into()) })),
  ];
  for (name, edit) in edits {
    let mut f = Fixture::new(&format!("undo-{name}"));
    let refs = f.refs();
    edit(&mut f.session).unwrap().unwrap();
    let edited = (unstamped(f.session.board.clone()), f.refs());

    let undone = f.session.undo().unwrap().unwrap();
    assert_eq!(unstamped(f.on_disk()), unstamped(fixture()), "{name}");
    assert_eq!(f.on_disk(), f.session.board, "{name}");
    assert_eq!(f.refs(), refs, "{name}");
    assert_ne!(undone.meta.unwrap().updated_at, STAMPED_BEFORE, "{name}");
    assert!(!undone.can_undo && undone.can_redo, "{name}");

    let redone = f.session.redo().unwrap().unwrap();
    assert_eq!((unstamped(f.on_disk()), f.refs()), edited, "{name}");
    assert!(redone.can_undo && !redone.can_redo, "{name}");
    f.session.undo().unwrap().unwrap();
    assert_eq!(unstamped(f.on_disk()), unstamped(fixture()), "{name}");
  }
}

#[test]
fn undoing_a_delete_puts_rows_back_in_their_old_places_and_says_so() {
  let mut f = Fixture::new("undo-order");
  f.session.delete_cluster("g1").unwrap().unwrap();
  f.session.delete_cards(&["b".into()]).unwrap().unwrap();
  let card_back = f.session.undo().unwrap().unwrap();
  assert_eq!(card_back.card_order.as_deref(), Some(&["a", "b", "c", "d"].map(String::from)[..]));
  assert_eq!(ids(&card_back.connections), ["e1", "e2"]);
  let cluster_back = f.session.undo().unwrap().unwrap();
  assert_eq!(cluster_back.cluster_order.as_deref(), Some(&["g1", "g2"].map(String::from)[..]));
  assert_eq!(f.on_disk().cards[0].cluster_ids, ["g1", "g2"]);
  let event = serde_json::to_value(f.session.apply_edit(adding_cluster(cluster("g3"))).unwrap().unwrap()).unwrap();
  assert!(event.get("clusterOrder").is_none());
}

#[test]
fn undo_keeps_the_last_hundred_steps() {
  let mut f = Fixture::new("undo-depth");
  for i in 1..=UNDO_DEPTH + 1 {
    f.session.move_cards(&[CardMove { id: "a".into(), position: Vec2 { x: i as f64, y: 0.0 } }]).unwrap().unwrap();
  }
  for _ in 0..UNDO_DEPTH {
    f.session.undo().unwrap().unwrap();
  }
  assert_eq!(f.session.undo().unwrap(), None);
  assert_eq!(f.on_disk().cards[0].position, Vec2 { x: 1.0, y: 0.0 });
}

#[test]
fn a_new_edit_clears_redo() {
  let mut f = Fixture::new("undo-clears-redo");
  f.session.update_card("a", patch(json!({ "title": "One" })), Logged::Edit).unwrap().unwrap();
  f.session.undo().unwrap().unwrap();
  let change = f.session.update_card("b", patch(json!({ "title": "Two" })), Logged::Edit).unwrap().unwrap();
  assert!(change.can_undo && !change.can_redo);
  assert_eq!(f.session.redo().unwrap(), None);
  assert_eq!(f.on_disk().cards[0].title, "A");
}

#[test]
fn the_viewport_and_no_op_edits_are_never_logged() {
  let mut f = Fixture::new("undo-not-logged");
  f.session.update_card("a", patch(json!({ "title": "Renamed" })), Logged::Edit).unwrap().unwrap();
  let panned = f.session.set_viewport(Viewport { x: 5.0, y: 6.0, zoom: 2.0 }).unwrap().unwrap();
  assert!(panned.can_undo);
  assert_eq!(f.session.update_card("a", patch(json!({ "title": "Renamed" })), Logged::Edit).unwrap(), None);
  assert_eq!(f.session.delete_cards(&["gone".into()]).unwrap(), None);
  f.session.undo().unwrap().unwrap();
  let disk = f.on_disk();
  assert_eq!(disk.cards[0].title, "A");
  assert_eq!(disk.viewport, Some(Viewport { x: 5.0, y: 6.0, zoom: 2.0 }));
  assert_eq!(f.session.undo().unwrap(), None);
}

#[test]
fn a_fresh_session_has_nothing_to_undo() {
  let open = OpenBoard::default();
  let f = Fixture::new("undo-session");
  let edit = |open: &OpenBoard, notes: &str| {
    open.lock().unwrap().as_mut().unwrap().update_card("a", patch(json!({ "notes": notes })), Logged::Edit).unwrap().unwrap();
  };
  let undo = |open: &OpenBoard| open.lock().unwrap().as_mut().unwrap().undo().unwrap();

  *open.lock().unwrap() = Some(Session::open(&f.path, "brd_test".into()).unwrap());
  edit(&open, "one");
  open.close("brd_test").unwrap();
  *open.lock().unwrap() = Some(Session::open(&f.path, "brd_test".into()).unwrap());
  assert_eq!(undo(&open), None);

  edit(&open, "two");
  *open.lock().unwrap() = Some(Session::open(&f.path, "brd_other".into()).unwrap());
  assert_eq!(undo(&open), None);
}

#[test]
fn an_unlogged_edit_is_not_undone_and_leaves_the_users_steps() {
  let mut f = Fixture::new("unlogged-apart");
  f.session.update_card("a", patch(json!({ "title": "Renamed" })), Logged::Edit).unwrap().unwrap();
  let ocr = f.session.update_card("b", patch(json!({ "notes": "OCR text" })), Logged::Unlogged).unwrap().unwrap();
  assert!(ocr.can_undo);
  f.session.undo().unwrap().unwrap();
  let disk = f.on_disk();
  assert_eq!((disk.cards[0].title.as_str(), disk.cards[1].notes.as_str()), ("A", "OCR text"));
  assert_eq!(f.session.undo().unwrap(), None);
  f.session.redo().unwrap().unwrap();
  assert_eq!(f.on_disk().cards[0].title, "Renamed");
}

#[test]
fn an_unlogged_edit_to_a_logged_row_clears_both_stacks() {
  let mut f = Fixture::new("unlogged-overlap");
  f.session.update_card("a", patch(json!({ "title": "One" })), Logged::Edit).unwrap().unwrap();
  f.session.update_card("b", patch(json!({ "title": "Two" })), Logged::Edit).unwrap().unwrap();
  f.session.undo().unwrap().unwrap();
  let ocr = f.session.update_card("a", patch(json!({ "notes": "OCR text" })), Logged::Unlogged).unwrap().unwrap();
  assert!(!ocr.can_undo && !ocr.can_redo);
  assert_eq!(f.session.undo().unwrap(), None);
  assert_eq!(f.session.redo().unwrap(), None);
  let a = &f.on_disk().cards[0];
  assert_eq!((a.title.as_str(), a.notes.as_str()), ("One", "OCR text"));
}
