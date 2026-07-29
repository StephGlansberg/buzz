/// No-subscription drop: event arrives but no save_subscription row exists.
#[tokio::test]
#[ignore]
async fn test_real_relay_no_subscription_drops_event() {
    let keys = Keys::generate();
    let relay_url = relay_ws_url_from_env();
    let state = make_test_app_state(keys.clone(), &relay_url);

    let channel_id = create_relay_channel(&keys).await;
    let msg_ev = EventBuilder::new(Kind::Custom(9), "should be dropped")
        .tags(vec![Tag::parse(["h", &channel_id]).unwrap()])
        .sign_with_keys(&keys)
        .unwrap();
    submit_event_to_relay(&msg_ev).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Empty file-backed archive DB — no subscription row.
    // plan_archive drops the whole group because no subscription matches.
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("archive.db");
    store::open_archive_db(&db_path).expect("init empty archive db");
    // conn from init drops here; DB file exists but has no subscription rows

    let cands = vec![candidate(&msg_ev, ScopeType::ChannelH, &channel_id)];
    let result = run_batch_real_relay(cands, &state, &db_path).await;

    assert_eq!(result.persisted, 0, "no-sub: should be dropped");
    assert_eq!(result.dropped, 1, "no-sub: drop count should be 1");

    // Belt-and-suspenders: confirm the on-disk archive is genuinely empty.
    let read_conn = store::open_archive_db(&db_path).expect("reopen archive db");
    let event_count: i64 = read_conn
        .query_row("SELECT COUNT(*) FROM archived_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        event_count, 0,
        "nothing should be archived on no-subscription"
    );

    println!("✓ real relay: no-subscription correctly dropped event");
}

/// Owner_p ephemeral path: a locally-built valid 24200 frame is archived
/// without a relay query (ephemeral events are never stored on the relay).
#[tokio::test]
#[ignore]
async fn test_real_relay_owner_p_ephemeral_path_persists_valid_frame() {
    let owner_keys = Keys::generate();
    let agent_keys = Keys::generate();
    let relay_url = relay_ws_url_from_env();
    let state = make_test_app_state(owner_keys.clone(), &relay_url);
    let identity_pk = owner_keys.public_key().to_hex();

    // Build a valid kind:24200 observer frame addressed to the owner.
    let ev = make_observer_frame(&owner_keys, &agent_keys, OBSERVER_FRAME_TELEMETRY);

    // File-backed archive DB with an owner_p subscription for kind 24200.
    let tmp = tempfile::tempdir().expect("tempdir");
    let db_path = tmp.path().join("archive.db");
    file_db_with_subscription(
        &db_path,
        &identity_pk,
        &relay_url,
        "owner_p",
        &identity_pk,
        "[24200]",
    );

    // owner_p candidates bypass the relay entirely — query_buckets gets an
    // empty bucket list and the ephemeral path handles the frame locally.
    let cands = vec![candidate(&ev, ScopeType::OwnerP, &identity_pk)];
    let result = run_batch_real_relay(cands, &state, &db_path).await;

    assert_eq!(
        result.persisted, 1,
        "owner_p: valid frame should be persisted"
    );
    assert_eq!(result.dropped, 0, "owner_p: nothing should be dropped");

    // Reopen the same file to assert exact row counts.
    let read_conn = store::open_archive_db(&db_path).expect("reopen archive db");

    let event_count: i64 = read_conn
        .query_row("SELECT COUNT(*) FROM archived_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(event_count, 1);

    let scope_count: i64 = read_conn
        .query_row(
            "SELECT COUNT(*) FROM archived_event_scopes WHERE scope_type = 'owner_p'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(scope_count, 1);

    // Confirm the stored raw_json round-trips to the original frame.
    let raw_json: String = read_conn
        .query_row("SELECT raw_json FROM archived_events", [], |r| r.get(0))
        .unwrap();
    let stored_ev = Event::from_json(&raw_json).unwrap();
    assert_eq!(stored_ev.id.to_hex(), ev.id.to_hex());

    println!(
        "✓ real relay: owner_p ephemeral frame {} archived",
        ev.id.to_hex()
    );
    println!("  archived_events:       {event_count} row(s)");
    println!("  archived_event_scopes: {scope_count} row(s)");
}
