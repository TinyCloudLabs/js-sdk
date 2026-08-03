use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

const VECTOR: &[u8] = include_bytes!("../../share-envelope/test/vectors/end-to-end.json");

#[test]
fn share_envelope_bearer_vector_verifies_with_strict_ed25519() {
    let vector: Value = serde_json::from_slice(VECTOR).expect("share vector JSON");
    let envelope = vector["envelope"].as_object().expect("envelope object");
    assert_eq!(envelope["version"], 1);
    assert_eq!(envelope["target"]["origin"], "https://share.tinycloud.xyz");
    assert_eq!(envelope["target"]["resource"]["kind"], "exact");
    let path = envelope["target"]["resource"]["path"].as_str().expect("resource path");
    assert!(!path.split('/').any(|part| part.is_empty() || part == "." || part == ".."));
    assert_eq!(envelope["authorizationTarget"]["kind"], "policy");
    assert!(envelope["expiry"].as_str().expect("expiry").ends_with('Z'));

    // Rebuild the JCS object from the fixture rather than accepting the
    // detached signingJcsHex as an opaque message. The fixture is ASCII-keyed,
    // so lexicographic object ordering is identical to RFC 8785 ordering.
    let mut unsigned = envelope.clone();
    unsigned.remove("signature");
    let canonical = canonical_json(&Value::Object(unsigned));
    let signing = format!("xyz.tinycloud.share/envelope/v1\0{}", canonical);
    let expected_signing = hex::decode(vector["signingJcsHex"].as_str().expect("signing bytes")).expect("signing hex");
    assert_eq!(signing.as_bytes(), expected_signing.as_slice());

    let seed = hex::decode(vector["ed25519SeedHex"].as_str().expect("seed")).expect("seed hex");
    let message = signing.as_bytes();
    let signature = Signature::from_slice(&hex::decode(vector["signatureHex"].as_str().expect("signature")).expect("signature hex")).expect("signature bytes");
    let signing_key = SigningKey::from_bytes(seed.as_slice().try_into().expect("32-byte seed"));
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    verifying_key.verify_strict(message, &signature).expect("strict share signature");

    let policy = base64url(vector["envelope"]["authorizationTarget"]["policyBytes"].as_str().expect("policy bytes"));
    assert_eq!(raw_cid(&policy), envelope["authorizationTarget"]["policyCid"].as_str().expect("policy CID"));
    let sealed = hex::decode(vector["sealedBlobHex"].as_str().expect("sealed blob")).expect("sealed blob hex");
    assert_eq!(sealed.first(), Some(&1), "sealed blob version");
    assert!(sealed.len() >= 1 + 12 + 16, "sealed blob must include nonce and tag");
    assert_eq!(raw_cid(&sealed), vector["cid"].as_str().expect("envelope CID"));
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string"),
        Value::Array(values) => format!("[{}]", values.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            format!("{{{}}}", entries.into_iter().map(|(key, value)| format!("{}:{}", serde_json::to_string(key).expect("JSON key"), canonical_json(value))).collect::<Vec<_>>().join(","))
        }
    }
}

fn raw_cid(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut multihash = vec![0x01, 0x55, 0x12, 0x20];
    multihash.extend_from_slice(&digest);
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut output = String::from("b");
    let mut buffer = 0u16;
    let mut bits = 0u8;
    for byte in multihash {
        buffer = (buffer << 8) | byte as u16;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            output.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 { output.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char); }
    output
}

fn base64url(value: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in value.bytes() {
        let digit = ALPHABET.iter().position(|candidate| *candidate == byte).expect("base64url alphabet") as u32;
        buffer = (buffer << 6) | digit;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    output
}
