use std::path::PathBuf;
use std::sync::Arc;

use super::*;
use crate::board_store::board_db::peek_board;
use crate::board_store::board_index::summaries;
use crate::library_mcp::tests::library;
use crate::schema::CardKind;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mail");

struct Library {
  dir: PathBuf,
  host: Detached,
}

impl Library {
  fn new(name: &str) -> Self {
    let dir = library(&format!("writes-{name}"));
    Self { host: Detached::new(&dir), dir }
  }

  /// The board open in the app, as a session.
  fn opened(name: &str) -> Self {
    let mut library = Self::new(name);
    library.host.open = OpenBoard::holding(&library.dir.join("boards/brd_acme.sqlite"), "brd_acme");
    library
  }

  fn board(&self) -> Board {
    peek_board(&self.dir.join("boards"), "brd_acme").unwrap().unwrap()
  }

  fn import(&self, path: &str) -> Result<Value, String> {
    let args = ImportArgs { board_id: "brd_acme".into(), path: path.into(), position: None, cluster_ids: Some(vec!["g".into()]) };
    import_file(&self.host, args)
  }

  fn file(&self, name: &str, bytes: &[u8]) -> String {
    let path = self.dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path.to_string_lossy().into_owned()
  }
}

impl Drop for Library {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

fn fields(value: Value) -> Map<String, Value> {
  value.as_object().unwrap().clone()
}

#[test]
fn an_imported_email_becomes_a_card_in_its_clusters_and_a_second_import_is_skipped() {
  let library = Library::new("import-email");
  let imported = library.import(&format!("{FIXTURES}/sample.eml")).unwrap();
  assert_eq!((imported["cards"][0]["kind"].as_str(), imported["skipped"].as_u64()), (Some("email"), Some(0)));
  let card = library.board().cards.into_iter().last().unwrap();
  assert_eq!((card.title.as_str(), card.cluster_ids), ("Re: the “collection”", vec!["g".to_string()]));
  let eml = card.email.unwrap().eml_file.unwrap();
  assert!(library.dir.join("media").join(eml).exists());
  assert!(!library.host.events.lock().unwrap()[0].can_undo);

  let again = library.import(&format!("{FIXTURES}/sample.eml")).unwrap();
  assert_eq!((again["cards"].as_array().unwrap().len(), again["skipped"].as_u64()), (0, Some(1)));
  assert_eq!(library.board().cards.len(), 4);
}

#[test]
fn an_emlx_a_picture_and_a_document_each_import_as_their_kind() {
  let library = Library::new("import-kinds");
  let png = library.file("Beach Day.png", b"not really a png");
  let pdf = library.file("brief.pdf", b"%PDF-broken");
  for (path, kind) in [
    (format!("{FIXTURES}/sample.emlx"), CardKind::Email),
    (format!("{FIXTURES}/sample.partial.emlx"), CardKind::Email),
    (png, CardKind::Evidence),
    (pdf, CardKind::Document),
  ] {
    let id = library.import(&path).unwrap()["cards"][0]["id"].as_str().unwrap().to_string();
    let card = library.board().cards.into_iter().find(|c| c.id == id).unwrap();
    assert_eq!(card.kind, kind, "{path}");
    assert!(card.media_files().all(|m| library.dir.join("media").join(m).exists()), "{path}");
  }
  let evidence = library.board().cards.into_iter().find(|c| c.title == "Beach Day").unwrap();
  assert_eq!(evidence.position, Vec2 { x: 320.0, y: 0.0 });
}

#[test]
fn an_import_refuses_what_isnt_an_importable_regular_file() {
  let library = Library::new("import-refused");
  let notes = library.file("notes.md", b"# hi");
  let big = library.dir.join("huge.pdf");
  std::fs::File::create(&big).unwrap().set_len(IMPORT_LIMIT + 1).unwrap();
  let dir = library.dir.to_string_lossy().into_owned();
  let refusals = [
    ("relative/a.eml".to_string(), "isn't an absolute path"),
    (dir.clone(), "isn't a file"),
    (format!("{dir}/missing.eml"), "Could not read"),
    (notes, "isn't email, a picture or a document"),
    (big.to_string_lossy().into_owned(), "over the 256 MB"),
    (library.file("empty.eml", b""), "Not an email message"),
  ];
  for (path, why) in refusals {
    let refused = library.import(&path).unwrap_err();
    assert!(refused.contains(why), "{path}: {refused}");
  }
  assert_eq!(library.board().cards.len(), 3);

  let tools = LibraryTools { library: library.dir.clone(), host: Arc::new(Detached::new(&library.dir)) };
  let args = ImportArgs { board_id: "brd_acme".into(), path: "relative".into(), position: None, cluster_ids: None };
  let answer = tauri::async_runtime::block_on(tools.import_file(Parameters(args))).unwrap();
  assert_eq!(answer.is_error, Some(true));
}

#[test]
fn a_card_made_on_the_open_board_is_undone_there() {
  let library = Library::opened("create-open");
  let args = CreateCardArgs {
    board_id: "brd_acme".into(),
    card: fields(json!({ "title": "Auditor", "kind": "person", "clusterIds": ["g"] })),
    position: Some(Point { x: 5.0, y: 6.0 }),
  };
  let made = create_card(&library.host, args).unwrap();
  let id = made["card"]["id"].as_str().unwrap();
  assert!(id.starts_with("card_"));
  let open = library.host.open.board().unwrap();
  assert_eq!(open.cards.last().map(|c| (c.id.as_str(), c.position)), Some((id, Vec2 { x: 5.0, y: 6.0 })));
  assert_eq!(library.board(), open);
  assert!(library.host.events.lock().unwrap()[0].can_undo);

  library.host.open.undo().unwrap().unwrap();
  assert_eq!(library.board().cards.len(), 3);
}

#[test]
fn a_new_card_takes_only_card_fields_and_names_no_files() {
  let library = Library::new("create-refused");
  let create = |card: Value| {
    create_card(&library.host, CreateCardArgs { board_id: "brd_acme".into(), card: fields(card), position: None })
  };
  assert!(create(json!({ "title": "x", "position": { "x": 1, "y": 1 } })).unwrap_err().contains("isn't a card field"));
  assert!(create(json!({ "title": "x", "document": { "file": "aa.pdf" } })).unwrap_err().contains("can't name media files"));
  assert!(create(json!({ "notes": "no title" })).unwrap_err().contains("title"));
  assert_eq!(library.board().cards.len(), 3);
}

#[test]
fn boards_clusters_and_connections_are_made_and_then_edited() {
  let library = Library::new("create-and-edit");
  let board = create_board(&library.host, "  Second case ").unwrap();
  let board_id = board["board"]["id"].as_str().unwrap();
  let listed = serde_json::to_value(summaries(&*library.host.db.lock_db().unwrap()).unwrap()).unwrap();
  assert!(listed.as_array().unwrap().iter().any(|b| b["id"] == board_id && b["title"] == "Second case"));
  assert!(create_board(&library.host, " ").is_err());

  let cluster = |label: &str| {
    let args = CreateClusterArgs { board_id: "brd_acme".into(), label: label.into(), color: None };
    create_cluster(&library.host, args).unwrap()["cluster"].clone()
  };
  assert_eq!(cluster("People")["color"], "#3b7de2");
  assert_eq!(cluster("Places")["color"], "#e2a13b");

  let connect = |source: &str, target: &str| {
    let args = CreateConnectionArgs {
      board_id: "brd_acme".into(),
      source: source.into(),
      target: target.into(),
      label: Some(" met ".into()),
      kind: None,
      grade: Some(Grade::Asserted),
    };
    create_connection(&library.host, args)
  };
  let link = connect("p", "e").unwrap()["connection"].clone();
  assert_eq!((link["label"].as_str(), link["kind"].as_str(), link["grade"].as_str()), (Some("met"), Some("red-string"), Some("asserted")));
  assert!(connect("p", "d").unwrap_err().contains("already connected"));
  assert!(connect("p", "nobody").is_err());

  let edit = |run: Box<dyn FnOnce(&mut Session) -> Outcome + '_>| changed(library.host.edit("brd_acme", run)).unwrap();
  assert_eq!(edit(Box::new(|s| s.edit_card("p", fields(json!({ "title": "Jane Doe" }))))), json!({ "changed": true }));
  assert_eq!(edit(Box::new(|s| s.edit_card("p", fields(json!({ "title": "Jane Doe" }))))), json!({ "changed": false }));
  assert_eq!(edit(Box::new(|s| s.rename("Acme Ltd"))), json!({ "changed": true }));
  let board = library.board();
  assert_eq!((board.meta.title.as_str(), board.cards[0].title.as_str(), board.clusters.len()), ("Acme Ltd", "Jane Doe", 3));
  assert_eq!(board.connections.len(), 2);
}
