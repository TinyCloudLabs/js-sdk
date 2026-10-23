#!/usr/bin/env python3
"""Validate the portable candidate and build an allowlisted, reproducible ZIP.

Requires Python 3 and jsonschema >= 4 (Draft 2020-12). Fetches canonical schemas
without modifying them. This command never submits or marks acceptance passed.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import sys
from urllib.request import urlopen
import zipfile

try:
    from jsonschema import Draft202012Validator
except ImportError:
    sys.exit("Install jsonschema>=4 in your packaging environment, then rerun.")

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "plugin/package"
ALLOWLIST = ("assets/logo.png", "mcp.json", "plugin.json")
ENDPOINT = "https://mcp.tinycloud.xyz/chatgpt/mcp"
SCHEMAS = {
    name: f"https://agent-plugins.org/schemas/1.0.0/{name}.schema.json"
    for name in ("plugin", "mcp")
}
TOOLS = {
    "tinycloud_connect", "tinycloud_apps_context", "tinycloud_apps_read",
    "tinycloud_apps_write", "tinycloud_apps_query",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fetch_json(url):
    with urlopen(url, timeout=30) as response:
        require(response.url.startswith("https://"), "HTTPS required")
        raw = response.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, "Remote JSON exceeds 1 MiB")
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def canonical_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def build_zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in ALLOWLIST:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, files[name])
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True,
                        help="Artifact directory outside plugin/package")
    args = parser.parse_args()
    output = args.output.resolve()
    require(output != SOURCE and SOURCE not in output.parents,
            "Artifacts must not be written inside plugin/package")
    paths = list(SOURCE.rglob("*"))
    require(not any(path.is_symlink() for path in paths), "Symlinks are forbidden")
    actual = sorted(path.relative_to(SOURCE).as_posix() for path in paths if path.is_file())
    require(actual == list(ALLOWLIST), f"Unexpected package files: {actual}")
    files = {name: (SOURCE / name).read_bytes() for name in ALLOWLIST}
    documents = {}
    schema_checks = {}
    for name, url in SCHEMAS.items():
        document = json.loads(files[f"{name}.json"])
        schema, digest = fetch_json(url)
        require(schema.get("$id") == url, "Unexpected canonical schema identity")
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(document)
        documents[name] = document
        files[f"{name}.json"] = canonical_json(document)
        schema_checks[name] = {"url": url, "sha256": digest, "result": "passed"}

    plugin = documents["plugin"]
    require(plugin["name"] == "tinycloud", "Unexpected plugin identity")
    require(re.fullmatch(r"\d+\.\d+\.\d+", plugin["version"]), "Use an explicit release version")
    require(documents["mcp"] == {
        "$schema": SCHEMAS["mcp"],
        "mcpServers": {"tinycloud": {"type": "streamable-http", "url": ENDPOINT}},
    }, "MCP configuration must be the fixed public URL with discovery and no headers")
    extension = plugin["extensions"]["com.openai"]
    require(set(extension) == {"interface", "review", "publication"},
            "Only listing, case definitions and release notes belong in this MCP-only plugin")
    interface = extension["interface"]
    for field, maximum in (("displayName", 30), ("shortDescription", 30),
                           ("longDescription", 4000), ("developerName", 80)):
        require(isinstance(interface[field], str) and 0 < len(interface[field]) <= maximum,
                f"Invalid listing field: {field}")
    require(interface["logo"] == interface["composerIcon"] == "./assets/logo.png",
            "Only the allowlisted logo may be referenced")
    cases = extension["review"]["test_cases"]
    for group, count in (("positive", 5), ("negative", 3)):
        require(len(cases[group]) == count, f"Exactly {count} {group} cases required")
        for case in cases[group]:
            for key in ("description", "prompt", "expected_behavior"):
                require(isinstance(case.get(key), str) and case[key].strip(),
                        f"Missing {group} case {key}")
            if group == "positive":
                require(case.get("tools_triggered"), "Positive case requires expected tools")
                mentioned = set(re.findall(r"tinycloud_[a-z_]+", case["tools_triggered"]))
                require(mentioned and mentioned <= TOOLS, "Case references a non-public tool")
    # These are defense-in-depth checks, not a substitute for reviewing the exact ZIP.
    text = files["plugin.json"].decode()
    require(not re.search(r"(?:/home/|/Users/|[A-Z]:\\\\|-----BEGIN .*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.)", text),
            "Local path or credential-like material in manifest")
    require(not re.search(r'"(?:test_credentials|reviewer_instructions|clientSecret|access_token|refresh_token|password)"\s*:', text),
            "Private credential fields are forbidden")
    logo = files["assets/logo.png"]
    require(logo.startswith(b"\x89PNG\r\n\x1a\n") and len(logo) <= 5 * 1024 * 1024,
            "Expected PNG logo no larger than 5 MiB")
    width, height = struct.unpack(">II", logo[16:24])
    require(width == height and 48 <= width <= 4096, "Logo must be square, 48–4096 pixels")

    discovery = {"status": "not run", "registration": "dcr", "scopes": ["tinycloud:mcp"]}

    archive_bytes = build_zip(files)
    require(archive_bytes == build_zip(files), "ZIP generation must be deterministic")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        require(archive.namelist() == list(ALLOWLIST), "ZIP allowlist mismatch")
        require(archive.testzip() is None, "ZIP CRC validation failed")
        for name in ALLOWLIST:
            require(archive.read(name) == files[name], f"ZIP content mismatch: {name}")
    archive_name = f"tinycloud-{plugin['version']}.zip"
    digest = hashlib.sha256(archive_bytes).hexdigest()
    report = {
        "artifact": archive_name, "sha256": digest, "version": plugin["version"],
        "schema_validation": schema_checks,
        "archive_allowlist": list(ALLOWLIST),
        "files": {name: hashlib.sha256(files[name]).hexdigest() for name in ALLOWLIST},
        "reproducible_zip": True, "oauth_discovery": discovery,
        "portal_import": "not run", "acceptance": "not run",
        "submission_readiness": "not established by packaging",
        "missing_listing_fields": [key for key in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL") if not interface.get(key)],
        "review_recording": "provided; access not verified" if extension["review"].get("demo_recording_url") else "missing",
        "release_gates": json.loads((ROOT / "plugin/review-evidence.json").read_text())["submission_gates"],
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / archive_name).write_bytes(archive_bytes)
    (output / f"{archive_name}.sha256").write_text(f"{digest}  {archive_name}\n")
    (output / "package-report.json").write_bytes(canonical_json(report))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
