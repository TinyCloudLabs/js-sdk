pub use tinycloud_sdk_wasm;
pub mod platform;
pub mod session;

#[cfg(feature = "nodejs")]
pub mod keys;

use iri_string::types::UriString;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, str::FromStr};
use tinycloud_sdk_rs::authorization::InvocationHeaders;
use tinycloud_sdk_rs::tinycloud_auth::{
    cacaos::siwe::Message,
    resource::{Path, ResourceId, Service, SpaceId},
    siwe_recap::Capability,
    ssi::{
        claims::{chrono, chrono::Timelike, jwt::NumericDate},
        dids::{DIDBuf, DIDURLBuf},
        ucan::Payload,
    },
    ucan_capabilities_object::{Ability, Capabilities},
};
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionProof {
    delegation_header: PersistedDelegationHeader,
    delegation_cid: String,
    space_id: String,
    jwk: serde_json::Value,
    address: String,
    chain_id: u64,
    siwe: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
struct PersistedDelegationHeader {
    #[serde(rename = "Authorization")]
    authorization: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedPersistedSessionProof {
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    recap: Vec<VerifiedRecapEntry>,
    /// A verifier-versioned witness. Restore requires this rather than the
    /// legacy `recap` field, which lets existing custom bindings remain source
    /// compatible without treating their caveat-free output as authority.
    verified_recap: Vec<VerifiedRecapEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct VerifiedRecapEntry {
    service: String,
    space: String,
    path: String,
    actions: Vec<String>,
    caveats: Vec<BTreeMap<String, serde_json::Value>>,
}

fn map_jserr<E: std::error::Error>(e: E) -> JsValue {
    e.to_string().into()
}

/// Extract the verified ReCap directly instead of the upstream convenience
/// projection, which intentionally groups actions but drops their note-bene
/// caveats. We emit one entry per action so a capability with a different
/// caveat set can never be merged into a broader sibling scope.
fn verified_recap_from_siwe(siwe_string: &str) -> Result<Vec<VerifiedRecapEntry>, JsValue> {
    let message: Message = siwe_string
        .parse::<Message>()
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    let capability = match Capability::<serde_json::Value>::extract_and_verify(&message) {
        Ok(Some(capability)) => capability,
        Ok(None) => return Ok(Vec::new()),
        Err(error) => return Err(JsValue::from_str(&error.to_string())),
    };
    let (capabilities, _) = capability.into_inner();
    let mut entries = Vec::new();
    for (resource_uri, ability_map) in capabilities.abilities().iter() {
        let (space, service, path) = match resource_uri.as_str().parse::<ResourceId>() {
            Ok(resource) => (
                resource.space().to_string(),
                resource.service().to_string(),
                resource.path().map(|path| path.as_str().to_string()).unwrap_or_default(),
            ),
            Err(error) if resource_uri.as_str().starts_with("urn:tinycloud:encryption:") => (
                "encryption".to_string(),
                "encryption".to_string(),
                resource_uri.to_string(),
            ),
            Err(error) => {
                return Err(JsValue::from_str(&format!(
                    "invalid ReCap resource URI {}: {error}",
                    resource_uri
                )));
            }
        };
        for (ability, caveats) in ability_map {
            entries.push(VerifiedRecapEntry {
                service: service.clone(),
                space: space.clone(),
                path: path.clone(),
                actions: vec![ability.to_string()],
                caveats: caveats.as_ref().to_vec(),
            });
        }
    }
    Ok(entries)
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

/// Verify and reconstruct persisted session authority as a single operation.
///
/// This deliberately uses the TinyCloud SDK's SIWE parser, EIP-191 verifier,
/// ReCap verifier, and Cacao constructor. TypeScript callers never parse a
/// persisted SIWE to decide whether its permissions or expiry are trustworthy.
#[wasm_bindgen]
#[allow(non_snake_case)]
pub fn validatePersistedSession(proof: JsValue) -> Result<JsValue, JsValue> {
    let proof: PersistedSessionProof = serde_wasm_bindgen::from_value(proof)?;
    if proof.jwk.get("alg").is_some_and(serde_json::Value::is_null) {
        return Err(JsValue::from_str(
            "session key alg must be EdDSA when present",
        ));
    }

    // The caller may supply persisted key material, but never the identity
    // that validates it. Importing derives the canonical did:key verification
    // method from the private Ed25519 JWK and applies the same private-key
    // validation as the session manager used by restore.
    let jwk = serde_json::from_value(proof.jwk.clone()).map_err(map_jserr)?;
    let mut manager =
        crate::session::SessionManager::new().map_err(|error| JsValue::from_str(&error))?;
    let key_id = "persisted".to_owned();
    manager
        .replace_session_key(jwk, key_id.clone())
        .map_err(|error| JsValue::from_str(&error))?;
    let verification_method = manager
        .get_did(Some(key_id))
        .map_err(|error| JsValue::from_str(&error))?;

    let signed: tinycloud_sdk_wasm::session::SignedSession =
        serde_json::from_value(serde_json::json!({
            "siwe": proof.siwe,
            "signature": proof.signature,
            "jwk": proof.jwk,
            "spaceId": proof.space_id,
            "verificationMethod": verification_method,
        }))
        .map_err(map_jserr)?;

    let expected_address = tinycloud_sdk_rs::util::decode_eip55(
        proof.address.strip_prefix("0x").unwrap_or(&proof.address),
    )
    .map_err(map_jserr)?;
    if signed.session.siwe.address != expected_address
        || signed.session.siwe.chain_id != proof.chain_id
    {
        return Err(JsValue::from_str(
            "persisted SIWE address or chain does not match session metadata",
        ));
    }
    if signed.session.siwe.uri.as_str() != signed.session.verification_method {
        return Err(JsValue::from_str(
            "persisted SIWE audience does not match the restored session key",
        ));
    }
    // `Date.now()` is obtained by the WASM module, rather than from caller
    // input, so an expired proof cannot be revived with a historical clock.
    let now_millis = js_sys::Date::now();
    if !now_millis.is_finite() {
        return Err(JsValue::from_str("current clock is unavailable"));
    }
    let now = time::OffsetDateTime::from_unix_timestamp_nanos((now_millis as i128) * 1_000_000)
        .map_err(map_jserr)?;
    if !signed.session.siwe.valid_at(&now) {
        return Err(JsValue::from_str(
            "persisted SIWE is expired or not yet valid",
        ));
    }
    signed
        .session
        .siwe
        .verify_eip191(&signed.signature)
        .map_err(map_jserr)?;

    // ReCap extraction verifies the capability statement/resource binding.
    // The primary space is authority; additional `spaces` are persisted UI
    // metadata (for example the lazily hosted public space) and are not
    // implicitly elevated to signed authority merely by being present here.
    let recap = verified_recap_from_siwe(&signed.session.siwe.to_string())?;
    let expected_spaces = [signed.session.space_id.to_string()];
    if !recap.is_empty()
        && expected_spaces
            .iter()
            .any(|space| !recap.iter().any(|entry| entry.space == *space))
    {
        return Err(JsValue::from_str(
            "persisted SIWE ReCap does not authorize every restored space",
        ));
    }

    // Reconstruct the exact Cacao from the verified SIWE/signature and reject
    // any persisted authorization bytes or CID that do not identify it.
    let expires_at = signed
        .session
        .siwe
        .expiration_time
        .as_ref()
        .map(ToString::to_string);
    let reconstructed =
        tinycloud_sdk_wasm::session::complete_session_setup(signed).map_err(map_jserr)?;
    let reconstructed_header_value =
        serde_json::to_value(&reconstructed.delegation_header).map_err(map_jserr)?;
    let reconstructed_header = reconstructed_header_value
        .get("Authorization")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| JsValue::from_str("failed to reconstruct persisted delegation header"))?;
    if reconstructed_header != proof.delegation_header.authorization
        || reconstructed.delegation_cid.to_string() != proof.delegation_cid
    {
        return Err(JsValue::from_str(
            "persisted delegation header or CID does not match verified SIWE authority",
        ));
    }

    serde_wasm_bindgen::to_value(&ValidatedPersistedSessionProof {
        recap: recap.clone(),
        verified_recap: recap,
        expires_at,
    })
        .map_err(Into::into)
}

/// Parse a ReCap into exact action/caveat scopes. This is deliberately a new
/// export: the upstream `parseRecapFromSiwe` remains available for old custom
/// bindings, while first-party bindings can opt into the verifier v2 witness.
#[wasm_bindgen]
#[allow(non_snake_case)]
pub fn parseVerifiedRecapFromSiwe(siwe_string: &str) -> Result<JsValue, JsValue> {
    let entries = verified_recap_from_siwe(siwe_string)?;
    serde_wasm_bindgen::to_value(&entries).map_err(Into::into)
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

#[cfg(test)]
mod tests {
    use super::*;
    use tinycloud_sdk_rs::tinycloud_auth::cacaos::siwe::Version as SIWEVersion;

    #[test]
    fn verified_recap_keeps_each_signed_action_caveat() {
        let mut capability = Capability::<serde_json::Value>::default();
        let resource: UriString = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default/kv/narrow"
            .parse()
            .unwrap();
        let action: Ability = "tinycloud.kv/get".parse().unwrap();
        let caveat = BTreeMap::from([(
            "tenant".to_string(),
            serde_json::Value::String("alpha".to_string()),
        )]);
        capability.with_actions(resource, [(action, vec![caveat.clone()])]);
        let message = capability
            .build_message(Message {
                scheme: None,
                domain: "restore.test".parse().unwrap(),
                address: Default::default(),
                statement: None,
                uri: "did:key:z6Mkrestore".parse().unwrap(),
                version: SIWEVersion::V1,
                chain_id: 1,
                nonce: "restore-caveat".into(),
                issued_at: "2026-01-01T00:00:00.000Z".parse().unwrap(),
                expiration_time: None,
                not_before: None,
                request_id: None,
                resources: vec![],
            })
            .unwrap();

        let recap = verified_recap_from_siwe(&message.to_string()).unwrap();
        assert_eq!(recap.len(), 1);
        assert_eq!(recap[0].actions, vec!["tinycloud.kv/get"]);
        assert_eq!(recap[0].caveats, vec![caveat]);
    }
}
