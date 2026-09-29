# -*- coding: utf-8 -*-
"""
Armored private key coverage for the Python SecurityAnalyzer (task-9)
=====================================================================

Regression: the credential pattern for private keys only allowed
``(?:RSA |DSA |EC |OPENSSH )?`` before ``PRIVATE KEY``, so the modern PKCS#8
``ENCRYPTED PRIVATE KEY`` armor and the PGP ``PGP PRIVATE KEY BLOCK`` armor were
silently missed — a committed encrypted key produced no
``Private Key Embedded in Source`` finding at all.

The evidence payload carries only severity/category/description/line number, so
no key material is echoed; these tests pin both the detection breadth and the
absence of public-key/certificate false positives.

Kept in its own module (not appended to ``test_security_evolution.py``) because
that file is pinned as a whole-file sample by the frozen scoring dataset
(``engine/evaluation/scoring_cases.json``): touching it drifts the dataset pin
for an unrelated reason. Only SYNTHETIC bodies are used here.
"""
from engine.analyzers.security_analyzer import SecurityAnalyzer

PRIVATE_KEY_ARMOR_FORMS = [
    ("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
    ("-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"),
    ("-----BEGIN EC PRIVATE KEY-----", "-----END EC PRIVATE KEY-----"),
    ("-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"),
    ("-----BEGIN DSA PRIVATE KEY-----", "-----END DSA PRIVATE KEY-----"),
    ("-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----END ENCRYPTED PRIVATE KEY-----"),
    ("-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"),
    ("-----begin encrypted private key-----", "-----end encrypted private key-----"),
]

SYNTHETIC_KEY_BODY = "MIIEowIBAAKCAQEASYNTHETICKEYBODY0001"


def _private_key_findings(result) -> list[dict]:
    return [
        f for f in result.details["findings"]
        if f["description"] == "Private Key Embedded in Source"
    ]


def test_security_detects_every_private_key_armor_form():
    for header, footer in PRIVATE_KEY_ARMOR_FORMS:
        source = f'KEY = """{header}\n{SYNTHETIC_KEY_BODY}\n{footer}"""\n'
        result = SecurityAnalyzer().run({"source": source}, {"source": ""})
        matches = _private_key_findings(result)
        assert len(matches) == 1, (header, result.details["findings"])
        # Identical treatment to the legacy PEM form: CRITICAL + same rule id.
        assert matches[0]["severity"] == "CRITICAL", header
        assert matches[0]["category"] == "Hardcoded Credential", header
        assert matches[0]["line"] == 1, header
        # Evidence never echoes key material (description + line only).
        evidence = "\n".join(result.evidence)
        assert SYNTHETIC_KEY_BODY not in evidence
        assert "-----BEGIN" not in evidence
        assert "-----END" not in evidence


def test_security_does_not_flag_public_key_or_certificate_armor():
    source = (
        'PUB = """-----BEGIN PUBLIC KEY-----\n'
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAESYNTHETICPUB0001\n"
        '-----END PUBLIC KEY-----"""\n'
        'CERT = """-----BEGIN CERTIFICATE-----\n'
        "MIICERTIFICATESYNTHETIC0001\n"
        '-----END CERTIFICATE-----"""\n'
    )
    result = SecurityAnalyzer().run({"source": source}, {"source": ""})
    assert _private_key_findings(result) == []
    assert result.details["critical_count"] == 0


def test_scan_file_reports_encrypted_key_armor():
    result = SecurityAnalyzer().scan_file(
        f'KEY = """-----BEGIN ENCRYPTED PRIVATE KEY-----\n{SYNTHETIC_KEY_BODY}\n'
        '-----END ENCRYPTED PRIVATE KEY-----"""\n'
    )
    assert result["critical_count"] == 1
    assert result["score"] > 0
    assert any("Private Key Embedded in Source" in str(f["description"]) for f in result["findings"])
