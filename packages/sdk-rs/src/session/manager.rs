use std::{collections::HashMap, str::FromStr};

use ed25519_dalek::SigningKey;
use iri_string::types::UriString;
use js_sys::JsString;
use serde_json::Value;
use tinycloud_sdk_rs::tinycloud_auth::{
    cacaos::siwe::{generate_nonce, Message, Version as SiweVersion},
    siwe_recap::{Ability, Capability},
    ssi::{
        dids::DIDKey,
        jwk::{Params, JWK},
    },
};
use wasm_bindgen::prelude::*;

use super::types::*;
use crate::platform::log_error;

use tinycloud_sdk_wasm::session::Session;

#[derive(Debug, Default)]
pub struct SessionInfo {
    key: Option<JWK>,
    session: Option<Session>,
}

#[derive(Debug)]
pub struct SessionManager {
    sessions: HashMap<String, SessionInfo>,
    capability: Capability<Value>,
}

static DEFAULT_KEY_ID: &str = "default";

/// Session keys are Ed25519 private JWKs. Validate both the JWK shape and
/// that its public component is actually derived from its private component
/// before storing it. The DID is derived from `x`, while invocation signing
/// uses `d`; accepting a mismatched pair would make the restored identity and
/// signer diverge.
fn validate_private_ed25519_jwk(key: &JWK) -> Result<(), String> {
    let params = match &key.params {
        Params::OKP(params) if params.curve == "Ed25519" => params,
        Params::OKP(_) => return Err("session key must use the Ed25519 curve".to_string()),
        _ => return Err("session key must be an Ed25519 OKP JWK".to_string()),
    };

    let private_key = params
        .private_key
        .as_ref()
        .ok_or_else(|| "session key must include an Ed25519 private component".to_string())?;
    let private_key: [u8; 32] = private_key
        .0
        .as_slice()
        .try_into()
        .map_err(|_| "session key has an invalid Ed25519 private component".to_string())?;
    if params.public_key.0.len() != 32 {
        return Err("session key has an invalid Ed25519 public component".to_string());
    }

    let derived_public_key = SigningKey::from_bytes(&private_key).verifying_key();
    if derived_public_key.as_bytes() != params.public_key.0.as_slice() {
        return Err("session key Ed25519 public and private components do not match".to_string());
    }

    Ok(())
}

/// Builds an TCWSession.
impl SessionManager {
    /// Initialize a new SessionManager.
    pub fn new() -> Result<SessionManager, String> {
        let key_id = DEFAULT_KEY_ID.to_string();
        let mut sessions: HashMap<String, SessionInfo> = HashMap::new();
        let mut default_key: JWK = JWK::generate_ed25519()
            .map_err(|error| format!("failed to generate session key: {}", error))?;

        // add key_id to jwk
        default_key.key_id = Some(key_id.clone());

        sessions.insert(
            key_id,
            SessionInfo {
                key: Some(default_key),
                session: None,
            },
        );
        Ok(Self {
            sessions,
            capability: Capability::default(),
        })
    }

    // reset the builder
    pub fn reset_capability(&mut self) {
        self.capability = Capability::default();
    }

    /// Build a SIWE message for signing.
    pub fn build(
        self,
        config: SiweConfig,
        key_id: Option<String>,
        custom_uri: Option<String>,
    ) -> Result<String, JsValue> {
        let did_uri_string = match custom_uri {
            Some(uri) => uri,
            None => self.get_did(key_id)?,
        };

        let uri = iri_string::types::UriString::from_str(&did_uri_string)
            .map_err(|e| format!("Failed to convert URI string to RiString: {}", e))?;

        let domain = config
            .domain()
            .parse()
            .map_err(|e| format!("failed to parse the domain as an authority: {}", e))?;
        let addr = config.address();
        let address =
            tinycloud_sdk_rs::util::decode_eip55(addr.strip_prefix("0x").unwrap_or(&addr))
                .map_err(|e| format!("failed to parse '{}' as an Eth Address: {}", addr, e))?;
        let nonce = config.nonce().unwrap_or_else(generate_nonce);
        let parse_date_err = |e| format!("unable to parse timestamp from string: {}", e);
        let issued_at = config.issuedAt().parse().map_err(parse_date_err)?;
        let expiration_time = config
            .expirationTime()
            .map(|s| s.parse().map_err(parse_date_err))
            .transpose()?;
        let not_before = config
            .notBefore()
            .map(|s| s.parse().map_err(parse_date_err))
            .transpose()?;
        let resources = config
            .resources()
            .unwrap_or_default()
            .iter()
            .map(|js_string| js_string.as_string())
            .map(|s: Option<String>| match s {
                Some(string) => string
                    .parse()
                    .map_err(|e| format!("unable to parse resource as uri: {}", e).into()),
                None => Err("error converting UTF-16 to UTF-8".into()),
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        let message = Message {
            scheme: None,
            domain,
            address,
            statement: config.statement(),
            uri,
            version: SiweVersion::V1,
            chain_id: config.chainId() as u64,
            nonce,
            issued_at,
            expiration_time,
            not_before,
            request_id: config.requestId(),
            resources,
        };

        let siwe = self
            .capability
            .build_message(message)
            .map_err(|build_error| format!("unable to build siwe message: {}", build_error))?;
        Ok(siwe.to_string())
    }

    /// Add actions for a specific target to a capability.
    pub fn add_targeted_actions(&mut self, target: String, actions: Vec<JsString>) -> bool {
        let actions: Vec<String> = if let Some(actions) = actions
            .iter()
            .map(|js_string| js_string.as_string())
            .collect()
        {
            actions
        } else {
            string_conversion_error();
            return false;
        };

        // Create a properly formatted resource URI

        for action in actions {
            if let Err(e) = self.capability.with_action_convert(
                target.parse::<UriString>().unwrap(),
                action.parse::<Ability>().unwrap(),
                Vec::<std::collections::BTreeMap<String, Value>>::new(),
            ) {
                log_error(&format!("Failed to add targeted action: {}", e));
                return false;
            }
        }
        true
    }

    pub fn create_session_key(&mut self, key_id: Option<String>) -> Result<String, String> {
        let key_id = key_id.unwrap_or(DEFAULT_KEY_ID.to_string());
        if self.sessions.contains_key(&key_id) {
            return Err(format!("key already exists: {}", key_id));
        }
        let mut new_key: JWK = JWK::generate_ed25519()
            .map_err(|error| format!("failed to generate session key: {}", error))?;

        // add key_id to jwk
        new_key.key_id = Some(key_id.clone());

        self.sessions.insert(
            key_id.clone(),
            SessionInfo {
                key: Some(new_key),
                session: None,
            },
        );
        Ok(key_id)
    }

    pub fn import_session_key(
        &mut self,
        mut key: JWK,
        key_id: Option<String>,
        override_key_id: bool,
    ) -> Result<String, String> {
        validate_private_ed25519_jwk(&key)?;
        let key_id = key_id.unwrap_or(DEFAULT_KEY_ID.to_string());
        if self.sessions.contains_key(&key_id) && !override_key_id {
            return Err(format!("key already exists: {}", key_id));
        }

        // add "kid" to jwk
        key.key_id = Some(key_id.clone());

        self.sessions.insert(
            key_id.clone(),
            SessionInfo {
                key: Some(key),
                session: None,
            },
        );
        Ok(key_id)
    }

    /// Replace one active session key after validating the supplied private
    /// Ed25519 JWK. This is the restore path: validation happens before the
    /// existing key entry is overwritten, so a malformed persisted key cannot
    /// leave a manager with a half-installed session key.
    pub fn replace_session_key(&mut self, key: JWK, key_id: String) -> Result<String, String> {
        self.import_session_key(key, Some(key_id), true)
    }

    pub fn list_session_keys(&self) -> Vec<String> {
        let keys = self.sessions.keys().cloned().collect();
        keys
    }

    pub fn rename_session_key_id(
        &mut self,
        old_key_id: String,
        new_key_id: String,
    ) -> Result<(), String> {
        if !self.sessions.contains_key(&old_key_id) {
            return Err(format!("Key {} does not exist.", old_key_id));
        }
        if self.sessions.contains_key(&new_key_id) {
            return Err(format!("Key {} already exists.", new_key_id));
        }
        if let Some(session_info) = self.sessions.remove(&old_key_id) {
            self.sessions.insert(new_key_id, session_info);
        }
        Ok(())
    }

    pub fn get_did(&self, key_id: Option<String>) -> Result<String, String> {
        let did = DIDKey::generate(&self.get_private_key(key_id)?)
            .map_err(|e| format!("unable to generate the DID of the session key: {e}"))?;
        // Create a proper DID URL with fragment: did:key:z6Mk...#z6Mk...
        let did_str = did.to_string();
        let fragment = did_str
            .rsplit_once(':')
            .ok_or_else(|| "Failed to extract DID fragment".to_string())?
            .1;
        Ok(format!("{}#{}", did_str, fragment))
    }

    fn get_private_key(&self, key_id: Option<String>) -> Result<JWK, String> {
        let key_id = key_id.unwrap_or(DEFAULT_KEY_ID.to_string());
        let session_info = self
            .sessions
            .get(&key_id)
            .ok_or(format!("key not found: {}", key_id))?;
        if let Some(key) = &session_info.key {
            Ok(key.clone())
        } else {
            Err(format!("private key not found for key_id: {}", key_id))
        }
    }

    pub fn jwk(&self, key_id: Option<String>) -> Option<String> {
        match serde_json::to_string(&self.get_private_key(key_id).unwrap()) {
            Ok(s) => Some(s),
            Err(e) => {
                log_error(&e.to_string());
                None
            }
        }
    }

    pub fn update_session(
        &mut self,
        session: Session,
        key_id: Option<String>,
    ) -> Result<(), String> {
        let final_key_id = key_id
            .or(session.jwk.key_id.clone())
            .ok_or("No key_id provided")?;

        let session_info = self.sessions.entry(final_key_id).or_default();

        session_info.session = Some(session);

        Ok(())
    }
}

fn string_conversion_error() {
    log_error("error converting UTF-16 into UTF-8");
}

#[cfg(test)]
pub mod test {
    use super::*;
    use std::collections::HashSet;
    use tinycloud_sdk_rs::tinycloud_auth::ssi::jwk::JWK;

    fn test_session() -> Session {
        let config = serde_json::json!({
            "abilities": {
                "kv": {
                    "path": [
                        "tinycloud.kv/put",
                        "tinycloud.kv/get",
                        "tinycloud.kv/list",
                        "tinycloud.kv/del",
                        "tinycloud.kv/metadata"
                    ]
                }
            },
            "address": "0x7BD63AA37326a64d458559F44432103e3d6eEDE9",
            "chainId": 1u8,
            "domain": "example.com",
            "issuedAt": "2022-01-01T00:00:00.000Z",
            "spaceId": "tinycloud:pkh:eip155:1:0x7BD63AA37326a64d458559F44432103e3d6eEDE9:default",
            "expirationTime": "3000-01-01T00:00:00.000Z",
        });
        let prepared =
            tinycloud_sdk_wasm::session::prepare_session(serde_json::from_value(config).unwrap())
                .unwrap();
        let mut signed = serde_json::to_value(prepared).unwrap();
        signed.as_object_mut().unwrap().insert(
            "signature".into(),
            "361647d08fb3ac41b26d9300d80e1964e1b3e7960e5276b3c9f5045ae55171442287279c83fd8922f9238312e89336b1672be8778d078d7dc5107b8c913299721c".into(),
        );
        tinycloud_sdk_wasm::session::complete_session_setup(serde_json::from_value(signed).unwrap())
            .unwrap()
    }

    #[tokio::test]
    async fn test_new_session_key_manager() {
        let manager = SessionManager::new();
        assert!(manager.is_ok());
        let manager = manager.unwrap();
        let keys = manager.list_session_keys();
        assert_eq!(keys.len(), 1);
    }

    #[tokio::test]
    async fn test_create_session_key() {
        let mut manager = SessionManager::new().unwrap();
        let result = manager.create_session_key(Some("custom_key".to_string()));
        assert!(result.is_ok());
        assert!(manager.sessions.contains_key("custom_key"));
    }

    #[tokio::test]
    async fn test_create_duplicate_session_key() {
        let mut manager = SessionManager::new().unwrap();
        let _ = manager.create_session_key(Some("custom_key".to_string()));
        let result = manager.create_session_key(Some("custom_key".to_string()));
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_import_session_key() {
        let mut manager = SessionManager::new().unwrap();
        let key = JWK::generate_ed25519().unwrap();
        let result = manager.import_session_key(key, Some("imported_key".to_string()), false);
        assert!(result.is_ok());
        assert!(manager.sessions.contains_key("imported_key"));
    }

    #[tokio::test]
    async fn test_import_session_key_rejects_public_or_mismatched_ed25519_jwk() {
        let mut manager = SessionManager::new().unwrap();
        let original_default = manager.jwk(Some("default".to_string())).unwrap();

        let mut public_only = JWK::generate_ed25519().unwrap();
        if let Params::OKP(params) = &mut public_only.params {
            params.private_key = None;
        }
        assert!(manager
            .replace_session_key(public_only, "default".to_string())
            .is_err());
        assert_eq!(
            manager.jwk(Some("default".to_string())).unwrap(),
            original_default
        );

        let mut mismatched = JWK::generate_ed25519().unwrap();
        let unrelated = JWK::generate_ed25519().unwrap();
        if let (Params::OKP(params), Params::OKP(unrelated_params)) =
            (&mut mismatched.params, unrelated.params)
        {
            params.public_key = unrelated_params.public_key.clone();
        }
        assert!(manager
            .replace_session_key(mismatched, "default".to_string())
            .is_err());
        assert_eq!(
            manager.jwk(Some("default".to_string())).unwrap(),
            original_default
        );
    }

    #[tokio::test]
    async fn test_list_session_keys() {
        let mut manager = SessionManager::new().unwrap();
        let _ = manager.create_session_key(Some("custom_key".to_string()));
        let keys = manager.list_session_keys();
        let mut key_set = HashSet::new();
        key_set.insert("default".to_string());
        key_set.insert("custom_key".to_string());
        assert_eq!(keys.into_iter().collect::<HashSet<_>>(), key_set);
    }

    #[tokio::test]
    async fn test_rename_session_key_id() {
        let mut manager = SessionManager::new().unwrap();
        let result =
            manager.rename_session_key_id("default".to_string(), "renamed_key".to_string());
        assert!(result.is_ok());
        assert!(!manager.sessions.contains_key("default"));
        assert!(manager.sessions.contains_key("renamed_key"));
    }

    #[tokio::test]
    async fn test_rename_nonexistent_session_key_id() {
        let mut manager = SessionManager::new().unwrap();
        let result =
            manager.rename_session_key_id("nonexistent_key".to_string(), "new_key".to_string());
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_did() {
        let manager = SessionManager::new().unwrap();
        let result = manager.get_did(None);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_private_key() {
        let manager = SessionManager::new().unwrap();
        let result = manager.get_private_key(None);
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_jwk() {
        let manager = SessionManager::new().unwrap();
        let result = manager.jwk(None);
        assert!(result.is_some());
        let jwk = result.unwrap();
        assert!(jwk.contains("crv\":\"Ed25519\""));
    }

    #[tokio::test]
    async fn test_invocation_mints_nonce_by_default() {
        let invocation = test_session()
            .invoke_any_uri(
                [(
                    "tinycloud://example/kv/path".parse::<UriString>().unwrap(),
                    ["tinycloud.kv/get".parse::<Ability>().unwrap()],
                )],
                None,
            )
            .expect("failed to create invocation");
        let nonce = invocation
            .payload()
            .nonce
            .as_deref()
            .expect("invocation nonce");
        assert!(nonce.starts_with("urn:uuid:"));
    }

    #[tokio::test]
    async fn test_import_existing_session_key_without_override() {
        let mut manager = SessionManager::new().unwrap();
        let key = JWK::generate_ed25519().unwrap();
        let result =
            manager.import_session_key(key.clone(), Some("imported_key".to_string()), false);
        assert!(result.is_ok());
        let result = manager.import_session_key(key, Some("imported_key".to_string()), false);
        assert!(result.is_err()); // expect error because override is false
    }

    // #[tokio::test]
    // async fn test_update_session() {
    //     let mut manager = SessionManager::new().unwrap();

    //     let session = Default::default();
    //     let result = manager.update_session(session, Some("default".to_string()));
    //     assert!(result.is_ok());

    //     // Check if session info is stored properly
    //     if let Some(session_info) = manager.sessions.get("default") {
    //         assert!(session_info.session.is_some());
    //         assert_eq!(session_info.session.as_ref().unwrap().id, "session1");
    //         assert_eq!(session_info.session.as_ref().unwrap().timestamp, 123456);
    //     } else {
    //         panic!("Session not found");
    //     }
    // }
}
