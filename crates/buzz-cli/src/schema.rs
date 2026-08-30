use clap::{Arg, ArgAction, Command, CommandFactory};
use serde::Serialize;

use crate::Cli;

/// Version of the machine-readable CLI contract emitted by `buzz schema`.
///
/// This version is independent from the package version. Increment it only
/// when the JSON contract changes incompatibly.
pub const SCHEMA_VERSION: &str = "1";

#[derive(Debug, Serialize)]
pub struct CliSchema {
    pub schema_version: &'static str,
    pub package: PackageIdentity,
    pub command: CommandSchema,
}

#[derive(Debug, Serialize)]
pub struct PackageIdentity {
    pub name: &'static str,
    pub version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sha: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<&'static str>,
}

#[derive(Debug, Serialize)]
pub struct CommandSchema {
    pub name: String,
    pub arguments: Vec<ArgumentSchema>,
    pub subcommands: Vec<CommandSchema>,
}

#[derive(Debug, Serialize)]
pub struct ArgumentSchema {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<char>,
    pub required: bool,
    pub repeatable: bool,
    pub value_type: &'static str,
    pub default: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    pub secret_hidden: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub possible_values: Vec<String>,
}

pub fn cli_schema() -> CliSchema {
    let mut command = Cli::command();
    command.build();

    CliSchema {
        schema_version: SCHEMA_VERSION,
        package: PackageIdentity {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            source_sha: nonempty(option_env!("BUZZ_SOURCE_SHA")),
            build_id: nonempty(option_env!("BUZZ_BUILD_ID")),
        },
        command: command_schema(&command),
    }
}

fn nonempty(value: Option<&'static str>) -> Option<&'static str> {
    value.filter(|value| !value.trim().is_empty())
}

fn command_schema(command: &Command) -> CommandSchema {
    CommandSchema {
        name: command.get_name().to_owned(),
        arguments: command.get_arguments().map(argument_schema).collect(),
        subcommands: command.get_subcommands().map(command_schema).collect(),
    }
}

fn argument_schema(argument: &Arg) -> ArgumentSchema {
    let action = argument.get_action();
    let possible_values: Vec<String> = argument
        .get_possible_values()
        .into_iter()
        .filter(|value| !value.is_hide_set())
        .map(|value| value.get_name().to_owned())
        .collect();
    let takes_multiple_values = argument
        .get_num_args()
        .is_some_and(|range| range.max_values() > 1);

    ArgumentSchema {
        name: argument.get_id().as_str().to_owned(),
        long: argument.get_long().map(str::to_owned),
        short: argument.get_short(),
        required: argument.is_required_set(),
        repeatable: matches!(action, ArgAction::Append | ArgAction::Count) || takes_multiple_values,
        value_type: value_type(action, &possible_values),
        default: argument
            .get_default_values()
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect(),
        env: argument
            .get_env()
            .map(|name| name.to_string_lossy().into_owned()),
        secret_hidden: argument.is_hide_env_values_set(),
        possible_values,
    }
}

fn value_type(action: &ArgAction, possible_values: &[String]) -> &'static str {
    if !possible_values.is_empty() {
        return if matches!(action, ArgAction::Append) {
            "enum[]"
        } else {
            "enum"
        };
    }

    match action {
        ArgAction::SetTrue | ArgAction::SetFalse | ArgAction::Help | ArgAction::Version => {
            "boolean"
        }
        ArgAction::Count => "integer",
        ArgAction::Append => "string[]",
        ArgAction::Set => "string",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argument_at<'a>(schema: &'a CommandSchema, path: &[&str], name: &str) -> &'a ArgumentSchema {
        let command = path.iter().fold(schema, |command, segment| {
            command
                .subcommands
                .iter()
                .find(|candidate| candidate.name == *segment)
                .unwrap_or_else(|| panic!("missing command {segment:?}"))
        });
        command
            .arguments
            .iter()
            .find(|argument| argument.name == name)
            .unwrap_or_else(|| panic!("missing argument {name:?} at {path:?}"))
    }

    #[test]
    fn schema_has_stable_versioned_identity_and_command_shape() {
        let schema = cli_schema();
        assert_eq!(schema.schema_version, "1");
        assert_eq!(schema.package.name, "buzz-cli");
        assert_eq!(schema.package.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(schema.command.name, "buzz");
        assert!(schema
            .command
            .subcommands
            .iter()
            .any(|cmd| cmd.name == "schema"));

        let mentions = argument_at(&schema.command, &["messages", "send"], "mentions");
        assert!(mentions.repeatable);
        assert_eq!(mentions.value_type, "string[]");
    }

    #[test]
    fn schema_exposes_secret_contract_without_secret_values() {
        let schema = cli_schema();
        let private_key = argument_at(&schema.command, &[], "private_key");
        assert_eq!(private_key.env.as_deref(), Some("BUZZ_PRIVATE_KEY"));
        assert!(private_key.secret_hidden);
        assert!(private_key.default.is_empty());

        let auth_tag = argument_at(&schema.command, &[], "auth_tag");
        assert_eq!(auth_tag.env.as_deref(), Some("BUZZ_AUTH_TAG"));
        assert!(auth_tag.secret_hidden);
        assert!(auth_tag.default.is_empty());

        let json = serde_json::to_string(&schema).expect("schema serializes");
        assert!(!json.contains("super-secret-value"));
    }

    #[test]
    fn schema_json_is_deterministic() {
        let first = serde_json::to_string(&cli_schema()).expect("schema serializes");
        let second = serde_json::to_string(&cli_schema()).expect("schema serializes");
        assert_eq!(first, second);
    }
}
