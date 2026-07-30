use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use serde_json::Value;

const VECTOR: &[u8] = include_bytes!("../../share-envelope/test/vectors/end-to-end.json");

#[test]
fn share_envelope_bearer_vector_verifies_with_strict_ed25519() {
    let vector: Value = serde_json::from_slice(VECTOR).expect("share vector JSON");
    let seed = hex::decode(vector["ed25519SeedHex"].as_str().expect("seed")).expect("seed hex");
    let message = hex::decode(vector["signingJcsHex"].as_str().expect("signing bytes")).expect("message hex");
    let signature = Signature::from_slice(&hex::decode(vector["signatureHex"].as_str().expect("signature")).expect("signature hex")).expect("signature bytes");
    let signing_key = SigningKey::from_bytes(seed.as_slice().try_into().expect("32-byte seed"));
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    verifying_key.verify_strict(&message, &signature).expect("strict share signature");
}
