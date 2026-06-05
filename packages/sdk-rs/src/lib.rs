pub use tinycloud_sdk_wasm;
pub mod platform;
pub mod session;

#[cfg(feature = "nodejs")]
pub mod keys;

use iri_string::types::UriString;
use serde::Deserialize;
use tinycloud_sdk_rs::authorization::InvocationHeaders;
use tinycloud_sdk_rs::tinycloud_auth::{
    resource::{Path, Service, SpaceId},
    siwe_recap::Ability,
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

    let actions = entries
        .into_iter()
        .map(|entry| {
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
            Ok::<_, JsValue>((resource, std::iter::once(action)))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let authz = session
        .invoke_any_uri(actions, facts_opt)
        .map_err(map_jserr)?;
    Ok(serde_wasm_bindgen::to_value(&InvocationHeaders::new(
        authz,
    ))?)
}
