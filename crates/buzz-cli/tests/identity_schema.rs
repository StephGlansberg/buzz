use std::process::Command;

fn buzz() -> Command {
    Command::new(env!("CARGO_BIN_EXE_buzz"))
}

#[test]
fn version_reports_the_package_identity() {
    let output = buzz().arg("--version").output().expect("buzz starts");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("version is UTF-8"),
        format!("buzz {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn schema_is_json_and_never_expands_secret_environment_values() {
    let output = buzz()
        .arg("schema")
        .env("BUZZ_PRIVATE_KEY", "super-secret-private-key")
        .env("BUZZ_AUTH_TAG", "super-secret-auth-tag")
        .output()
        .expect("buzz starts");

    assert!(output.status.success());
    assert!(output.stderr.is_empty());

    let raw = String::from_utf8(output.stdout).expect("schema is UTF-8");
    assert!(!raw.contains("super-secret-private-key"));
    assert!(!raw.contains("super-secret-auth-tag"));

    let schema: serde_json::Value = serde_json::from_str(&raw).expect("schema is JSON");
    assert_eq!(schema["schema_version"], "1");
    assert_eq!(schema["package"]["name"], "buzz-cli");
    assert_eq!(schema["package"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(schema["command"]["name"], "buzz");

    let arguments = schema["command"]["arguments"]
        .as_array()
        .expect("root arguments array");
    for (name, env_name) in [
        ("private_key", "BUZZ_PRIVATE_KEY"),
        ("auth_tag", "BUZZ_AUTH_TAG"),
    ] {
        let argument = arguments
            .iter()
            .find(|argument| argument["name"] == name)
            .unwrap_or_else(|| panic!("missing {name} schema"));
        assert_eq!(argument["env"], env_name);
        assert_eq!(argument["secret_hidden"], true);
        assert_eq!(argument["default"], serde_json::json!([]));
    }
}
