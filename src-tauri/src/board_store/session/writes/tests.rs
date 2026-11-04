use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::json;

use super::*;
use crate::board_store::board_db::create_board_db;
use crate::board_store::board_index::summaries;
use crate::board_store::board_db::reassemble_board;
use crate::board_store::temp_dir_for;
use crate::library_index::open_at;
use crate::schema::{parse_board, Board};

fn fixture(title: &str) -> Board {
  parse_board(json!({
    "version": 4,
    "meta": { "title": title, "updatedAt": "2026-07-19T00:00:00.000Z" },
    "clusters": [{ "id": "g1", "label": "One", "color": "#fff", "visible": true }],
    "cards": [
      { "id": "a", "title": "A", "clusterIds": ["g1"], "position": { "x": 0, "y": 40 } },
      { "id": "b", "title": "B", "clusterIds": [], "position": { "x": 300, "y": 10 } },
      { "id": "m", "title": "M", "kind": "email", "clusterIds": [], "position": { "x": 9000, "y": -900 } },
      { "id": "d", "title": "D", "kind": "document", "clusterIds": [], "position": { "x": 0, "y": 0 }, "document": { "file": "d.pdf" } },
    ],
    "connections": [{ "id": "e1", "source": "a", "target": "b" }],
  }))
  .unwrap()
}

struct Library {
  dir: PathBuf,
  db: LibraryDb,
  events: Mutex<Vec<DocChanged>>,
}

impl Library {
  fn new(name: &str) -> Self {
    let dir = temp_dir_for(&format!("writes-{name}"));
    for (id, title) in [("brd_one", "One"), ("brd_two", "Two")] {
      create_board_db(&dir.join(format!("boards/{id}.sqlite")), &fixture(title)).unwrap();
    }
    Self { db: open_at(&dir).unwrap(), dir, events: Mutex::default() }
  }

  fn path(&self, id: &str) -> PathBuf {
    self.dir.join(format!("boards/{id}.sqlite"))
  }

  fn on_disk(&self, id: &str) -> Board {
    reassemble_board(&rusqlite::Connection::open(self.path(id)).unwrap()).unwrap()
  }

  fn edit(&self, open: &OpenBoard, board_id: &str, edit: impl FnOnce(&mut Session) -> Outcome) -> Outcome {
    edit_board(open, &self.db, &self.dir.join("boards"), board_id, edit, |c| self.events.lock().unwrap().push(c.clone()))
  }
}

impl Drop for Library {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

fn patch(value: Value) -> Map<String, Value> {
  value.as_object().unwrap().clone()
}

fn new_card(id: &str, kind: &str, occurred_at: Option<&str>) -> Card {
  parse_card(json!({ "id": id, "title": id, "kind": kind, "occurredAt": occurred_at, "clusterIds": [], "position": { "x": 0, "y": 0 } }))
    .unwrap()
}

#[test]
fn a_write_to_the_open_board_goes_on_its_undo_log() {
  let library = Library::new("open");
  let open = OpenBoard::holding(&library.path("brd_one"), "brd_one");
  let change = library.edit(&open, "brd_one", |s| s.edit_card("a", patch(json!({ "title": "Renamed" })))).unwrap().unwrap();
  assert!(change.can_undo);
  assert_eq!(open.board().unwrap().cards[0].title, "Renamed");
  assert_eq!(library.on_disk("brd_one").cards[0].title, "Renamed");
  assert_eq!(library.events.lock().unwrap().len(), 1);

  open.undo().unwrap().unwrap();
  assert_eq!(library.on_disk("brd_one").cards[0].title, "A");
}

#[test]
fn a_write_to_a_board_not_open_has_no_undo_and_leaves_the_open_one_be() {
  let library = Library::new("not-open");
  let open = OpenBoard::holding(&library.path("brd_one"), "brd_one");
  let change = library.edit(&open, "brd_two", |s| s.rename("Two, renamed")).unwrap().unwrap();
  assert_eq!((change.board_id.as_str(), change.can_undo), ("brd_two", false));
  assert_eq!(library.on_disk("brd_two").meta.title, "Two, renamed");
  assert_eq!(open.board().unwrap(), library.on_disk("brd_one"));
  assert!(open.undo().unwrap().is_none());
  let listed = serde_json::to_value(summaries(&*library.db.lock_db().unwrap()).unwrap()).unwrap();
  assert_eq!(listed[0]["title"], "Two, renamed");

  let nothing_open = OpenBoard::default();
  library.edit(&nothing_open, "brd_one", |s| s.rename("One, renamed")).unwrap().unwrap();
  assert_eq!(library.on_disk("brd_one").meta.title, "One, renamed");
  assert!(nothing_open.board().is_none());
  assert_eq!(library.edit(&nothing_open, "brd_gone", |s| s.rename("x")).unwrap_err(), "No board \"brd_gone\".");
}

#[test]
fn a_card_edit_takes_only_its_fields_and_keeps_its_files() {
  let library = Library::new("card-edit");
  let open = OpenBoard::default();
  let edit = |id: &str, value: Value| library.edit(&open, "brd_one", |s| s.edit_card(id, patch(value)));
  for refused in [json!({ "position": { "x": 1, "y": 1 } }), json!({ "imageFile": "x.png" }), json!({ "id": "z" })] {
    assert!(edit("a", refused.clone()).unwrap_err().contains("isn't a card field"), "{refused}");
  }
  assert_eq!(edit("d", json!({ "document": { "file": "other.pdf" } })).unwrap_err(), "An edit can't change the files a card holds.");
  assert_eq!(edit("d", json!({ "document": {} })).unwrap_err(), "An edit can't change the files a card holds.");
  assert_eq!(edit("a", json!({ "clusterIds": ["g9"] })).unwrap_err(), "No cluster \"g9\".");
  assert_eq!(edit("z", json!({ "title": "Z" })).unwrap_err(), "No card \"z\".");
  assert_eq!(library.on_disk("brd_one"), fixture("One"));

  edit("d", json!({ "notes": "Seized", "kind": "evidence", "occurredAt": "2026-01-02T00:00:00.000Z", "clusterIds": ["g1"] }))
    .unwrap()
    .unwrap();
  let card = library.on_disk("brd_one").cards.into_iter().find(|c| c.id == "d").unwrap();
  assert_eq!((card.notes.as_str(), card.cluster_ids, card.document.unwrap().file), ("Seized", vec!["g1".to_string()], Some("d.pdf".into())));
}

#[test]
fn adding_checks_clusters_and_pairs_and_removes_nothing() {
  let library = Library::new("add");
  let open = OpenBoard::default();
  let link = |id: &str, source: &str, target: &str| Connection {
    id: id.into(),
    source: source.into(),
    target: target.into(),
    label: None,
    kind: Default::default(),
    grade: None,
  };
  let repeat = library.edit(&open, "brd_one", |s| s.add(vec![], vec![], vec![link("e2", "a", "b")]));
  assert_eq!(repeat.unwrap_err(), "\"a\" is already connected to \"b\".");
  let mut stray = new_card("x", "person", None);
  stray.cluster_ids = vec!["g9".into()];
  assert_eq!(library.edit(&open, "brd_one", |s| s.add(vec![], vec![stray], vec![])).unwrap_err(), "No cluster \"g9\".");

  let cluster = Cluster { id: "g2".into(), label: "Two".into(), color: "#000".into(), visible: true };
  let mut member = new_card("x", "person", None);
  member.cluster_ids = vec!["g2".into()];
  let change = library.edit(&open, "brd_one", |s| s.add(vec![cluster], vec![member], vec![link("e2", "b", "x")])).unwrap().unwrap();
  assert!(change.removed_cards.is_empty() && change.removed_connections.is_empty() && change.removed_clusters.is_empty());
  let board = library.on_disk("brd_one");
  assert_eq!((board.cards.len(), board.connections.len(), board.clusters.len()), (5, 2, 2));
}

#[test]
fn new_cards_land_clear_of_the_drawn_cards_drawn_first_and_oldest_first() {
  let library = Library::new("place");
  let session = Session::open(&library.path("brd_one"), "brd_one".into()).unwrap();
  let mut cards = vec![
    new_card("mail", "email", Some("2026-01-01T00:00:00.000Z")),
    new_card("later", "event", Some("2026-03-01T00:00:00.000Z")),
    new_card("undated", "evidence", None),
    new_card("earlier", "event", Some("2026-02-01T00:00:00.000Z")),
  ];
  session.place(&mut cards, None);
  let placed: Vec<_> = cards.iter().map(|c| (c.id.as_str(), c.position.x, c.position.y)).collect();
  assert_eq!(placed, [("earlier", 620.0, 10.0), ("later", 880.0, 10.0), ("undated", 620.0, 230.0), ("mail", 880.0, 230.0)]);

  session.place(&mut cards[..1], Some(Vec2 { x: 5.0, y: 6.0 }));
  assert_eq!(cards[0].position, Vec2 { x: 5.0, y: 6.0 });
}

#[test]
fn moves_connections_clusters_and_titles_refuse_what_isnt_there() {
  let library = Library::new("other-edits");
  let open = OpenBoard::default();
  let moved = library.edit(&open, "brd_one", |s| s.move_existing(vec![("z".into(), Vec2 { x: 1.0, y: 1.0 })]));
  assert_eq!(moved.unwrap_err(), "No card \"z\".");
  assert_eq!(library.edit(&open, "brd_one", |s| s.edit_connection("e9", patch(json!({ "label": "x" })))).unwrap_err(), "No connection \"e9\".");
  assert!(library.edit(&open, "brd_one", |s| s.edit_connection("e1", patch(json!({ "id": "e2" })))).is_err());
  assert!(library.edit(&open, "brd_one", |s| s.edit_cluster("g1", patch(json!({ "id": "g2" })))).is_err());
  assert_eq!(library.edit(&open, "brd_one", |s| s.rename("  ")).unwrap_err(), "A board needs a title.");
  assert_eq!(library.on_disk("brd_one"), fixture("One"));

  library.edit(&open, "brd_one", |s| s.move_existing(vec![("a".into(), Vec2 { x: 1.0, y: 2.0 })])).unwrap().unwrap();
  library.edit(&open, "brd_one", |s| s.edit_connection("e1", patch(json!({ "label": "pays", "grade": "asserted" })))).unwrap().unwrap();
  library.edit(&open, "brd_one", |s| s.edit_cluster("g1", patch(json!({ "label": "Money", "visible": false })))).unwrap().unwrap();
  let board = library.on_disk("brd_one");
  assert_eq!(board.cards[0].position, Vec2 { x: 1.0, y: 2.0 });
  assert_eq!(board.connections[0].label.as_deref(), Some("pays"));
  assert_eq!((board.clusters[0].label.as_str(), board.clusters[0].visible), ("Money", false));
}
