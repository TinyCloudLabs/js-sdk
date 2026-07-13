pub use tinycloud_sdk_wasm;
pub mod platform;
pub mod session;

#[cfg(feature = "nodejs")]
pub mod keys;

use iri_string::types::UriString;
use serde::Deserialize;
use std::{collections::BTreeMap, str::FromStr};
use tinycloud_sdk_rs::authorization::InvocationHeaders;
use tinycloud_sdk_rs::tinycloud_auth::{
    resource::{Path, Service, SpaceId},
    ssi::{
        claims::{chrono, chrono::Timelike, jwt::NumericDate},
        dids::{DIDBuf, DIDURLBuf},
        ucan::Payload,
    },
    ucan_capabilities_object::{Ability, Capabilities},
};
use wasm_bindgen::prelude::*;

fn map_jserr<E: std::error::Error>(e: E) -> JsValue {
    e.to_string().into()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InvokeAnyEntry {
    resource: Option<String>,
    /// Legacy space-scoped resource. Omitted when `resource` is provided.
    #[serde(default)]
    space_id: Option<String>,
    service: String,
    path: String,
    action: String,
    #[serde(default)]
    caveats: Vec<BTreeMap<String, serde_json::Value>>,
}

#[wasm_bindgen]
#[allow(non_snake_case)]
/// Initialise console-error-panic-hook to improve debug output for panics.
///
/// Run once on initialisation.
pub fn initPanicHook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
#[allow(non_snake_case)]
pub fn invokeAny(session: JsValue, entries: JsValue, facts: JsValue) -> Result<JsValue, JsValue> {
    let session: tinycloud_sdk_wasm::session::Session = serde_wasm_bindgen::from_value(session)?;
    let entries: Vec<InvokeAnyEntry> = serde_wasm_bindgen::from_value(entries)?;
    let facts_opt: Option<Vec<serde_json::Value>> = if facts.is_undefined() || facts.is_null() {
        None
    } else {
        Some(serde_wasm_bindgen::from_value(facts)?)
    };

    let mut capabilities = Capabilities::new();
    for entry in entries {
        let action: Ability = entry.action.parse().map_err(map_jserr)?;
        let resource: UriString = match entry.resource {
            Some(resource) => resource.parse().map_err(map_jserr)?,
            None => {
                let space_id = entry.space_id.ok_or_else(|| {
                    JsValue::from_str(
                        "invokeAny entry requires spaceId when resource is not provided",
                    )
                })?;
                let space_id: SpaceId = space_id.parse().map_err(map_jserr)?;
                let service: Service = entry.service.parse().map_err(map_jserr)?;
                let path: Path = entry.path.parse().map_err(map_jserr)?;
                space_id
                    .to_resource(service, Some(path), None, None)
                    .as_uri()
            }
        };
        let caveats = if entry.caveats.is_empty() {
            vec![BTreeMap::new()]
        } else {
            entry.caveats
        };
        capabilities.with_action(resource, action, caveats);
    }

    let now = chrono::Utc::now();
    let expiration = ((now.timestamp() + 60) as f64) + (now.nanosecond() as f64 / 1_000_000_000.0);
    let verification_method = session.verification_method.clone();
    let mut nonce_bytes = [0_u8; 16];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    nonce_bytes[6] = (nonce_bytes[6] & 0x0f) | 0x40;
    nonce_bytes[8] = (nonce_bytes[8] & 0x3f) | 0x80;
    let nonce = format!(
        "urn:uuid:{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        nonce_bytes[0], nonce_bytes[1], nonce_bytes[2], nonce_bytes[3],
        nonce_bytes[4], nonce_bytes[5], nonce_bytes[6], nonce_bytes[7],
        nonce_bytes[8], nonce_bytes[9], nonce_bytes[10], nonce_bytes[11],
        nonce_bytes[12], nonce_bytes[13], nonce_bytes[14], nonce_bytes[15],
    );
    let authz = Payload {
        issuer: DIDURLBuf::from_str(&verification_method).map_err(map_jserr)?,
        audience: DIDBuf::from_str(
            verification_method
                .split('#')
                .next()
                .unwrap_or(&verification_method),
        )
        .map_err(map_jserr)?,
        not_before: None,
        expiration: NumericDate::try_from_seconds(expiration).map_err(map_jserr)?,
        nonce: Some(nonce),
        facts: facts_opt,
        proof: vec![session.delegation_cid],
        attenuation: capabilities,
    }
    .sign(
        session.jwk.get_algorithm().unwrap_or_default(),
        &session.jwk,
    )
    .map_err(map_jserr)?;
    Ok(serde_wasm_bindgen::to_value(&InvocationHeaders::new(
        authz,
    ))?)
}
