// use serde::{Deserialize, Serialize};
use serde_wasm_bindgen::to_value;

use js_sys::JsString;
use wasm_bindgen::prelude::*;

use super::manager;
use super::types::*;

#[wasm_bindgen]
// #[derive(Serialize, Deserialize)]
pub struct TCWSessionManager {
    manager: manager::SessionManager,
}

#[wasm_bindgen]
/// Builds an TCWSession.
impl TCWSessionManager {
    #[wasm_bindgen(constructor)]
    /// Initialize a new TinyCloudWebSessionManager.
    pub fn new() -> Result<TCWSessionManager, String> {
        let manager = match manager::SessionManager::new() {
            Ok(manager) => manager,
            Err(e) => return Err(e),
        };

        Ok(TCWSessionManager { manager })
    }

    #[allow(non_snake_case)]
    /// Reset the SIWE message builder to its initial state.
    pub fn resetCapability(&mut self) {
        self.manager.reset_capability();
    }

    /// Build a SIWE message for signing.
    pub fn build(
        self,
        config: SiweConfig,
        key_id: Option<String>,
        custom_uri: Option<String>,
    ) -> Result<String, JsValue> {
        self.manager.build(config, key_id, custom_uri)
    }

    #[allow(non_snake_case)]
    /// Add actions for a specific target to a capability.
    pub fn addTargetedActions(&mut self, target: String, actions: Vec<JsString>) -> bool {
        self.manager.add_targeted_actions(target, actions)
    }

    #[allow(non_snake_case)]
    /// Create a new session key with the given key ID (Defaults to 'default').
    pub fn createSessionKey(&mut self, key_id: Option<String>) -> Result<String, String> {
        self.manager.create_session_key(key_id)
    }

    /// Replace an existing session key with a persisted private Ed25519 JWK.
    ///
    /// The manager validates the private JWK before replacing the existing
    /// entry. This is intentionally exposed on both the Node and browser WASM
    /// builds so restore flows share one key lifecycle.
    #[allow(non_snake_case)]
    pub fn replaceSessionKey(&mut self, js_jwk: JsValue, key_id: String) -> Result<String, String> {
        let key = serde_wasm_bindgen::from_value(js_jwk).map_err(|e| e.to_string())?;
        self.manager.replace_session_key(key, key_id)
    }

    #[allow(non_snake_case)]
    /// List the available session keys.
    pub fn listSessionKeys(&self) -> Result<JsValue, JsValue> {
        let keys = self.manager.list_session_keys();
        to_value(&keys).map_err(JsValue::from)
    }

    #[allow(non_snake_case)]
    /// Rename the key_id to retrieve session data.
    pub fn renameSessionKeyId(
        &mut self,
        old_key_id: String,
        new_key_id: String,
    ) -> Result<(), String> {
        self.manager.rename_session_key_id(old_key_id, new_key_id)
    }

    #[allow(non_snake_case)]
    /// Get the DID associated with a the session key key_id.
    pub fn getDID(&self, key_id: Option<String>) -> Result<String, String> {
        self.manager.get_did(key_id)
    }

    /// Get the full JWK associated with a the session key key_id.
    pub fn jwk(&self, key_id: Option<String>) -> Option<String> {
        self.manager.jwk(key_id)
    }

    // #[allow(non_snake_case)]
    // pub fn updateSession(
    //     &mut self,
    //     session: Session,
    //     key_id: Option<String>,
    // ) -> Result<(), String> {
    //     self.manager.update_session(session, key_id)
    // }
}

// Internal methods for key management (not exposed to wasm_bindgen directly)
impl TCWSessionManager {
    /// Import a session key (internal method for use by keys module)
    #[cfg(feature = "nodejs")]
    pub fn import_session_key_internal(
        &mut self,
        key: tinycloud_sdk_rs::tinycloud_auth::ssi::jwk::JWK,
        key_id: Option<String>,
        override_existing: bool,
    ) -> Result<String, String> {
        self.manager
            .import_session_key(key, key_id, override_existing)
    }

    /// Get the JWK for a key ID (internal method for use by keys module)
    #[cfg(feature = "nodejs")]
    pub fn get_jwk(
        &self,
        key_id: Option<String>,
    ) -> Result<tinycloud_sdk_rs::tinycloud_auth::ssi::jwk::JWK, String> {
        let jwk_str = self.manager.jwk(key_id).ok_or("Key not found")?;
        serde_json::from_str(&jwk_str).map_err(|e| format!("Failed to parse JWK: {}", e))
    }
}
