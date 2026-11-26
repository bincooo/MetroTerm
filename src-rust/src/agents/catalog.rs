//! The bundled detection manifests and screen signatures (`manifests/`, `identify.toml`), or the
//! user's overrides in `~/.metroterm/agents/`, loaded once.

use super::*;

pub(super) struct Catalog {
    /// Same order as `AGENTS`; None = the manifest failed to load (agent never detected).
    pub(super) manifests: Vec<Option<Manifest>>,
    pub(super) signatures: Vec<Signature>,
}

pub(super) struct Signature {
    pub(super) agent: usize,
    pub(super) region: Region,
    pub(super) gate: Gate,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SignatureFile {
    #[serde(default)]
    pub(super) signatures: Vec<SignatureEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SignatureEntry {
    pub(super) agent: String,
    #[serde(default = "bottom_region")]
    pub(super) region: String,
    #[serde(default)]
    pub(super) all: Vec<GateFile>,
    #[serde(default)]
    pub(super) any: Vec<GateFile>,
    #[serde(default, rename = "not")]
    pub(super) not_gate: Vec<GateFile>,
    #[serde(default)]
    pub(super) contains: Vec<String>,
    #[serde(default)]
    pub(super) regex: Vec<String>,
    #[serde(default)]
    pub(super) line_regex: Vec<String>,
}

pub(super) fn bottom_region() -> String {
    "bottom_non_empty_lines(10)".into()
}

pub(super) fn parse_signatures(text: &str) -> Result<Vec<Signature>, String> {
    let file: SignatureFile = toml::from_str(text).map_err(|error| error.to_string())?;
    file.signatures
        .into_iter()
        .map(|entry| {
            let agent = AGENTS
                .iter()
                .position(|agent| agent.id == entry.agent)
                .ok_or_else(|| format!("unknown agent {:?}", entry.agent))?;
            let region = Region::parse(&entry.region)
                .ok_or_else(|| format!("unknown region {:?}", entry.region))?;
            let gate = Gate::compile(&GateFile::new(
                entry.all,
                entry.any,
                entry.not_gate,
                entry.contains,
                entry.regex,
                entry.line_regex,
            ))?;
            Ok(Signature {
                agent,
                region,
                gate,
            })
        })
        .collect()
}

/// A user file in `~/.metroterm/agents/`, if there is one.
pub(super) fn user_file(name: &str) -> Option<(std::path::PathBuf, String)> {
    let path = crate::common::config::config_dir()
        .ok()?
        .join("agents")
        .join(name);
    let text = std::fs::read_to_string(&path).ok()?;
    Some((path, text))
}

pub(super) fn load_manifest(agent: &AgentInfo) -> Option<Manifest> {
    if let Some((path, text)) = user_file(agent.file) {
        match Manifest::parse(&text) {
            Ok(manifest)
                if manifest.id == agent.id
                    || manifest.aliases.iter().any(|alias| alias == agent.id) =>
            {
                log::info!("Agent status: {} rules from {}", agent.name, path.display());
                return Some(manifest);
            }
            Ok(manifest) => log::warn!(
                "Agent status: {} is for {:?}, not {:?} — using the built-in rules",
                path.display(),
                manifest.id,
                agent.id
            ),
            Err(error) => log::warn!(
                "Agent status: {}: {error} — using the built-in rules",
                path.display()
            ),
        }
    }
    match Manifest::parse(agent.manifest) {
        Ok(manifest) => Some(manifest),
        Err(error) => {
            log::error!("Agent status: built-in rules of {}: {error}", agent.name);
            None
        }
    }
}

pub(super) fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let signatures = user_file("identify.toml")
            .and_then(|(path, text)| match parse_signatures(&text) {
                Ok(signatures) => {
                    log::info!("Agent status: screen signatures from {}", path.display());
                    Some(signatures)
                }
                Err(error) => {
                    log::warn!(
                        "Agent status: {}: {error} — using the built-in signatures",
                        path.display()
                    );
                    None
                }
            })
            .unwrap_or_else(|| {
                parse_signatures(IDENTIFY).unwrap_or_else(|error| {
                    log::error!("Agent status: built-in screen signatures: {error}");
                    Vec::new()
                })
            });
        Catalog {
            manifests: AGENTS.iter().map(load_manifest).collect(),
            signatures,
        }
    })
}
