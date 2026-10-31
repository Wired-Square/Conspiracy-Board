use super::*;

const V1: &str = include_str!("../../tests/fixtures/boards/v1.json");
const V2_EMAIL: &str = include_str!("../../tests/fixtures/boards/v2-email.json");
const V3_ENTITIES: &str = include_str!("../../tests/fixtures/boards/v3-entities.json");
const V4_CURRENT: &str = include_str!("../../tests/fixtures/boards/v4-current.json");
const SEED: &str = include_str!("../../../data/board.json");

fn v1() -> Value {
  serde_json::from_str(V1).unwrap()
}

/// The v1 board with its one card patched and its version set.
fn v1_with(version: u8, card: Value) -> Value {
  let mut board = v1();
  board["version"] = json!(version);
  for (k, v) in card.as_object().unwrap() {
    board["cards"][0][k] = v.clone();
  }
  board
}

fn parse(board: Value) -> Board {
  parse_board(board).unwrap()
}

/// Numbers compared by value, so `1` and `1.0` are the same number, as they are in JS.
fn same_json(a: &Value, b: &Value) -> bool {
  match (a, b) {
    (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
    (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y)),
    (Value::Object(x), Value::Object(y)) => {
      x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
    }
    _ => a == b,
  }
}

mod v1_to_v4 {
  use super::*;

  #[test]
  fn restamps_the_version() {
    assert_eq!(parse(v1()).version, 4);
  }

  #[test]
  fn widens_the_legacy_cluster_id_into_a_one_element_cluster_ids() {
    let card = &parse(v1()).cards[0];
    assert_eq!(card.cluster_ids, vec!["cl_1"]);
    assert!(serde_json::to_value(card).unwrap().get("clusterId").is_none());
  }

  #[test]
  fn widens_a_null_cluster_id_to_no_memberships() {
    assert!(parse(v1_with(1, json!({ "clusterId": null }))).cards[0].cluster_ids.is_empty());
  }

  #[test]
  fn fills_the_new_card_fields_with_defaults_leaving_old_cards_undated() {
    let card = &parse(v1()).cards[0];
    assert_eq!(card.kind, CardKind::Evidence);
    assert_eq!(card.occurred_at, None);
    assert_eq!(card.occurred_at_precision, DatePrecision::Minute);
    assert_eq!(card.email, None);
  }

  #[test]
  fn leaves_a_pre_v3_card_as_evidence_ungraded_and_unentitied() {
    let card = &parse(v1()).cards[0];
    assert_eq!(card.kind, CardKind::Evidence);
    assert_eq!((card.grade, &card.person, &card.organisation), (None, &None, &None));
  }

  #[test]
  fn leaves_a_pre_v3_connection_ungraded() {
    assert_eq!(parse(v1()).connections[0].grade, None);
  }

  #[test]
  fn preserves_the_existing_content() {
    let board = parse(v1());
    assert_eq!(board.meta.title, "Test");
    assert_eq!(board.cards[0].title, "A card");
    assert_eq!((board.clusters.len(), board.connections.len()), (1, 1));
  }
}

mod v2 {
  use super::*;

  #[test]
  fn round_trips_without_losing_the_new_fields_widening_bare_attachments() {
    let board = parse_board_json(V2_EMAIL).unwrap();
    let card = &board.cards[0];
    assert_eq!(card.kind, CardKind::Email);
    assert_eq!(card.occurred_at, UtcInstant::new("2024-11-14T17:32:00.000Z".into()));
    assert_eq!(
      serde_json::to_value(card.email.as_ref().unwrap()).unwrap(),
      json!({
        "from": { "name": "Jane", "address": "jane@x.com" },
        "to": [{ "address": "bob@x.com" }],
        "cc": [],
        "messageId": "<abc@x.com>",
        "inReplyTo": null,
        "attachments": [{ "name": "report.pdf" }],
      })
    );
  }

  #[test]
  fn accepts_a_dated_card_at_day_precision() {
    let board = parse(v1_with(2, json!({ "occurredAt": "2024-11-14T00:00:00.000Z", "occurredAtPrecision": "day" })));
    assert_eq!(board.cards[0].occurred_at_precision, DatePrecision::Day);
  }
}

mod v3 {
  use super::*;

  #[test]
  fn round_trips_each_kind() {
    for kind in ["person", "organisation", "document", "email", "message", "call", "event", "evidence"] {
      let card = &parse(v1_with(3, json!({ "kind": kind }))).cards[0];
      assert_eq!(serde_json::to_value(card.kind).unwrap(), kind);
    }
  }

  #[test]
  fn round_trips_a_person_and_their_addresses() {
    let board = parse_board_json(V3_ENTITIES).unwrap();
    assert_eq!(
      serde_json::to_value(&board.cards[0].person).unwrap(),
      json!({ "addresses": ["jane@acme.com", "jane@personal.example"] })
    );
  }

  #[test]
  fn round_trips_an_organisation_with_addresses_of_its_own_and_domains() {
    let board = parse(v1_with(
      3,
      json!({ "kind": "organisation", "organisation": { "addresses": ["legal@acme.com"], "domains": ["acme.com"] } }),
    ));
    assert_eq!(
      serde_json::to_value(&board.cards[0].organisation).unwrap(),
      json!({ "addresses": ["legal@acme.com"], "domains": ["acme.com"] })
    );
  }

  #[test]
  fn defaults_an_entity_payloads_lists_rather_than_rejecting_a_bare_one() {
    let board = parse_board_json(V3_ENTITIES).unwrap();
    assert_eq!(
      serde_json::to_value(&board.cards[1].organisation).unwrap(),
      json!({ "addresses": [], "domains": [] })
    );
  }

  #[test]
  fn round_trips_a_graded_card() {
    assert_eq!(parse_board_json(V3_ENTITIES).unwrap().cards[3].grade, Some(Grade::Adjudicated));
  }

  #[test]
  fn round_trips_a_graded_connection() {
    assert_eq!(parse_board_json(V3_ENTITIES).unwrap().connections[0].grade, Some(Grade::Inference));
  }

  #[test]
  fn keeps_a_payload_for_a_kind_the_card_no_longer_is() {
    let board = parse(v1_with(
      3,
      json!({
        "kind": "person",
        "person": { "addresses": [] },
        "email": { "from": null, "to": [], "cc": [], "messageId": "<a@b>", "inReplyTo": null, "attachments": [] },
      }),
    ));
    assert_eq!(board.cards[0].email.as_ref().unwrap().message_id.as_deref(), Some("<a@b>"));
  }
}

mod v4 {
  use super::*;

  #[test]
  fn round_trips_ordered_multi_cluster_membership() {
    let mut board = v1_with(4, json!({ "clusterIds": ["cl_2", "cl_1"] }));
    board["cards"][0].as_object_mut().unwrap().remove("clusterId");
    let board = parse(board);
    assert_eq!(board.cards[0].cluster_ids, vec!["cl_2", "cl_1"]);
    assert_eq!(board.version, 4);
  }

  #[test]
  fn lets_cluster_ids_win_when_a_card_carries_both_shapes() {
    assert!(parse(v1_with(4, json!({ "clusterId": "cl_1", "clusterIds": [] }))).cards[0].cluster_ids.is_empty());
  }
}

mod rejection {
  use super::*;

  fn rejects(board: Value) {
    assert!(parse_board(board).is_err());
  }

  #[test]
  fn rejects_a_malformed_board() {
    rejects(json!({ "version": 2, "meta": {}, "cards": [] }));
    assert!(parse_board_json("not json").is_err());
  }

  #[test]
  fn rejects_an_unknown_version() {
    rejects(v1_with(5, json!({})));
    rejects(v1_with(0, json!({})));
  }

  #[test]
  fn rejects_an_unknown_kind_which_is_what_makes_the_v3_bump_worth_it() {
    rejects(v1_with(1, json!({ "kind": "suspect" })));
  }

  #[test]
  fn rejects_an_unknown_grade() {
    rejects(v1_with(1, json!({ "grade": "probably" })));
  }

  #[test]
  fn rejects_a_non_utc_occurred_at_holding_the_storage_invariant() {
    rejects(v1_with(1, json!({ "occurredAt": "2024-11-14T00:00:00+05:00" })));
  }

  #[test]
  fn rejects_a_non_iso_occurred_at() {
    rejects(v1_with(1, json!({ "occurredAt": "November 2024" })));
  }

  #[test]
  fn loads_a_card_whose_image_meta_and_document_carry_explicit_nulls_stripping_them() {
    let board = parse_board_json(V3_ENTITIES).unwrap();
    let card = serde_json::to_value(&board.cards[2]).unwrap();
    assert_eq!(card["imageMeta"], json!({ "width": 1288.0, "height": 672.0 }));
    assert_eq!(card["document"], json!({ "file": "a.pdf", "title": "A" }));
  }
}

mod utc_instants {
  use super::*;

  #[test]
  fn accepts_what_to_iso_string_writes_and_its_shorter_forms() {
    for s in ["2024-11-14T17:32:11.000Z", "2024-11-14T17:32Z", "2024-11-14T17:32:11Z", "2024-02-29T00:00:00.1Z", "2000-02-29T23:59:59.999999Z"] {
      assert!(is_utc_instant(s), "{s}");
    }
  }

  #[test]
  fn refuses_offsets_bad_dates_and_bad_times() {
    for s in [
      "2024-11-14T00:00:00+05:00",
      "2024-11-14T00:00:00",
      "2024-11-14",
      "2023-02-29T00:00Z",
      "1900-02-29T00:00Z",
      "2024-04-31T00:00Z",
      "2024-13-01T00:00Z",
      "2024-11-14T24:00Z",
      "2024-11-14T12:60Z",
      "2024-11-14T12:00.5Z",
      "2024-11-14T12:00:00.Z",
      "24-11-14T12:00Z",
    ] {
      assert!(!is_utc_instant(s), "{s}");
    }
  }
}

mod fixtures {
  use super::*;

  /// A board written by the current build reads back as exactly what is on disk:
  /// nothing dropped, nothing added, nothing reshaped.
  #[test]
  fn a_current_board_loads_unchanged() {
    let on_disk: Value = serde_json::from_str(V4_CURRENT).unwrap();
    let loaded = serde_json::to_value(parse_board(on_disk.clone()).unwrap()).unwrap();
    assert!(same_json(&loaded, &on_disk), "{loaded:#}");
  }

  #[test]
  fn every_older_version_loads_and_then_reloads_unchanged() {
    for text in [V1, V2_EMAIL, V3_ENTITIES, SEED] {
      let once = serde_json::to_value(parse_board_json(text).unwrap()).unwrap();
      let twice = serde_json::to_value(parse_board(once.clone()).unwrap()).unwrap();
      assert_eq!(once, twice);
    }
  }

  #[test]
  fn the_seed_board_migrates_its_cluster_memberships() {
    let seed = parse_board_json(SEED).unwrap();
    assert_eq!(seed.version, 4);
    assert!(seed.cards.iter().any(|c| !c.cluster_ids.is_empty()));
  }
}
