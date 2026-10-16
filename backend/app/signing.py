"""Ed25519 (EdDSA) result tokens. The token attests what THIS server decided, nothing more."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .config import TOKEN_TTL_S

log = logging.getLogger("aegis")
ALGORITHM = "EdDSA"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Signer:
    def __init__(self, private_key: Ed25519PrivateKey):
        self._private = private_key
        self._public = private_key.public_key()
        x = _b64url(self._public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
        thumbprint = json.dumps({"crv": "Ed25519", "kty": "OKP", "x": x}, separators=(",", ":"), sort_keys=True)
        self.kid = _b64url(hashlib.sha256(thumbprint.encode()).digest())  # RFC 7638
        self.jwk = {"kty": "OKP", "crv": "Ed25519", "x": x, "use": "sig", "alg": ALGORITHM, "kid": self.kid}

    @classmethod
    def from_b64(cls, seed_b64: str) -> "Signer":
        if not seed_b64:
            log.warning("!!! SIGNING_KEY_B64 IS NOT SET: generated an EPHEMERAL signing key. "
                        "Tokens will stop verifying when this process restarts. Set SIGNING_KEY_B64 in production. !!!")
            return cls(Ed25519PrivateKey.generate())
        try:
            seed = base64.b64decode(seed_b64 + "=" * (-len(seed_b64) % 4), altchars=b"-_", validate=True)
        except ValueError as error:
            raise RuntimeError("SIGNING_KEY_B64 is not valid base64") from error
        if len(seed) != 32:
            raise RuntimeError("SIGNING_KEY_B64 must decode to a raw 32-byte Ed25519 seed")
        return cls(Ed25519PrivateKey.from_private_bytes(seed))

    def sign(self, session_id: str, decision: str, risk: int, policy_version: str, now_s: int | None = None) -> str:
        iat = int(time.time()) if now_s is None else now_s
        claims = {"sub": session_id, "decision": decision, "risk": risk, "policy_version": policy_version,
                  "iat": iat, "exp": iat + TOKEN_TTL_S}
        return jwt.encode(claims, self._private, algorithm=ALGORITHM, headers={"kid": self.kid})

    def verify(self, token: str) -> dict | None:
        try:
            return jwt.decode(token, self._public, algorithms=[ALGORITHM], options={"require": ["sub", "iat", "exp"]})
        except jwt.PyJWTError:
            return None
