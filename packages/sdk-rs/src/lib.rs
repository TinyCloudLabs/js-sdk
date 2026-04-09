pub use tinycloud_sdk_wasm;
pub mod platform;
pub mod session;

#[cfg(feature = "nodejs")]
pub mod keys;

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
    space_id: String,
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
pub fn invokeAny(
    session: JsValue,
    entries: JsValue,
    facts: JsValue,
) -> Result<JsValue, JsValue> {
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
            let space_id: SpaceId = entry.space_id.parse().map_err(map_jserr)?;
            let service: Service = entry.service.parse().map_err(map_jserr)?;
            let action: Ability = entry.action.parse().map_err(map_jserr)?;
            let path: Path = entry.path.parse().map_err(map_jserr)?;
            let resource = space_id.to_resource(service, Some(path), None, None);
            Ok::<_, JsValue>((resource, std::iter::once(action)))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let authz = session.invoke_any(actions, facts_opt).map_err(map_jserr)?;
    Ok(serde_wasm_bindgen::to_value(&InvocationHeaders::new(authz))?)
}
