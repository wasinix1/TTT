"""Web Push from the standard library: the crypto, and one send.

A push message to a browser has to be signed (VAPID, RFC 8292: an ES256
JWT, so ECDSA on P-256) and encrypted (RFC 8291: ECDH on P-256, HKDF-SHA256,
AES-128-GCM). Python's standard library has none of the three, and this
server installs nothing — every dependency is one more thing that can fail
on the night — so they are here, written out.

None of it has to be fast. A message is a few hundred bytes and goes out a
handful of times a minute; a scalar multiplication in pure Python is a few
milliseconds. It does have to be right, which is what the RFC 8291 test
vector in sim.py is for.

Nothing here is constant-time. The secret that matters is the VAPID key,
and the only thing anyone can time is how long this server takes to send
somebody a table call.
"""

import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ------------------------------------------------------------------ P-256

P = 2**256 - 2**224 + 2**192 + 2**96 - 1
A = P - 3
B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
     0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)


def _on_curve(pt):
    x, y = pt
    return 0 <= x < P and 0 <= y < P and (y * y - (x * x * x + A * x + B)) % P == 0


# Jacobian coordinates (X, Y, Z) for x = X/Z², y = Y/Z³; Z == 0 is infinity.
def _double(p1):
    X, Y, Z = p1
    if not Y or not Z:
        return (0, 1, 0)
    YY = Y * Y % P
    S = 4 * X * YY % P
    ZZ = Z * Z % P
    M = 3 * (X - ZZ) * (X + ZZ) % P           # a = -3
    X3 = (M * M - 2 * S) % P
    Y3 = (M * (S - X3) - 8 * YY * YY) % P
    Z3 = 2 * Y * Z % P
    return (X3, Y3, Z3)


def _add(p1, p2):
    X1, Y1, Z1 = p1
    X2, Y2, Z2 = p2
    if not Z1:
        return p2
    if not Z2:
        return p1
    Z1Z1, Z2Z2 = Z1 * Z1 % P, Z2 * Z2 % P
    U1, U2 = X1 * Z2Z2 % P, X2 * Z1Z1 % P
    S1, S2 = Y1 * Z2 * Z2Z2 % P, Y2 * Z1 * Z1Z1 % P
    if U1 == U2:
        return _double(p1) if S1 == S2 else (0, 1, 0)
    H = (U2 - U1) % P
    R = (S2 - S1) % P
    HH = H * H % P
    HHH = H * HH % P
    V = U1 * HH % P
    X3 = (R * R - HHH - 2 * V) % P
    Y3 = (R * (V - X3) - S1 * HHH) % P
    Z3 = H * Z1 * Z2 % P
    return (X3, Y3, Z3)


def _mul(k, pt):
    """k·pt, affine in and out."""
    acc, q = (0, 1, 0), (pt[0], pt[1], 1)
    for bit in bin(k % N)[2:]:
        acc = _double(acc)
        if bit == "1":
            acc = _add(acc, q)
    X, Y, Z = acc
    if not Z:
        raise ValueError("point at infinity")
    zi = pow(Z, -1, P)
    return (X * zi * zi % P, Y * zi * zi * zi % P)


def public_bytes(pt):
    return b"\x04" + pt[0].to_bytes(32, "big") + pt[1].to_bytes(32, "big")


def point(raw):
    """A public key as browsers hand it over: 65 bytes, uncompressed."""
    if len(raw) != 65 or raw[0] != 4:
        raise ValueError("not an uncompressed P-256 key")
    pt = (int.from_bytes(raw[1:33], "big"), int.from_bytes(raw[33:], "big"))
    if not _on_curve(pt):
        raise ValueError("that key is not on the curve")
    return pt


def new_key():
    """(private int, public bytes)"""
    d = secrets.randbelow(N - 1) + 1
    return d, public_bytes(_mul(d, G))


def public_of(d):
    return public_bytes(_mul(d, G))


def ecdh(d, raw_public):
    return _mul(d, point(raw_public))[0].to_bytes(32, "big")


def sign(d, msg):
    """ECDSA P-256 / SHA-256, as r||s — the shape a JWT wants."""
    z = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    while True:
        k = secrets.randbelow(N - 1) + 1
        r = _mul(k, G)[0] % N
        if not r:
            continue
        s = pow(k, -1, N) * (z + r * d) % N
        if s:
            return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify(raw_public, msg, sig):
    """For tests: the other half of sign()."""
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if not (0 < r < N and 0 < s < N):
        return False
    z = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    w = pow(s, -1, N)
    q = point(raw_public)
    a = _mul(z * w % N, G)
    b = _mul(r * w % N, q)
    x, y, zz = _add((a[0], a[1], 1), (b[0], b[1], 1))
    if not zz:
        return False
    zi = pow(zz, -1, P)
    return x * zi * zi % P % N == r


# ------------------------------------------------------------------ HKDF

def _hmac(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf(salt, ikm, info, length):
    prk = _hmac(salt, ikm)
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = _hmac(prk, t + info + bytes([i]))
        out += t
        i += 1
    return out[:length]


# ---------------------------------------------------------------- AES-128

def _sbox():
    sbox = [0] * 256
    p = q = 1
    while True:
        p ^= ((p << 1) ^ (0x1B if p & 0x80 else 0)) & 0xFF
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ (q << 1 | q >> 7) ^ (q << 2 | q >> 6) ^ (q << 3 | q >> 5) ^ (q << 4 | q >> 4)
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


SBOX = _sbox()


def _xt(b):
    return ((b << 1) ^ 0x1B) & 0xFF if b & 0x80 else b << 1


def _expand(key):
    w = [list(key[i:i + 4]) for i in range(0, 16, 4)]
    rcon = 1
    for i in range(4, 44):
        t = list(w[i - 1])
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [SBOX[x] for x in t]
            t[0] ^= rcon
            rcon = _xt(rcon)
        w.append([a ^ b for a, b in zip(w[i - 4], t)])
    return [sum(w[r * 4:r * 4 + 4], []) for r in range(11)]


def _encrypt_block(rk, block):
    s = [b ^ k for b, k in zip(block, rk[0])]
    for rnd in range(1, 11):
        s = [SBOX[b] for b in s]
        # shift rows; the state is column-major, 4 bytes a column
        s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]
        if rnd != 10:
            out = []
            for c in range(4):
                a = s[4 * c:4 * c + 4]
                t = a[0] ^ a[1] ^ a[2] ^ a[3]
                out += [a[i] ^ t ^ _xt(a[i] ^ a[(i + 1) % 4]) for i in range(4)]
            s = out
        s = [b ^ k for b, k in zip(s, rk[rnd])]
    return bytes(s)


def _gmul(x, y):
    R = 0xE1 << 120
    z, v = 0, y
    for i in range(127, -1, -1):
        if (x >> i) & 1:
            z ^= v
        v = (v >> 1) ^ R if v & 1 else v >> 1
    return z


def _ghash(h, data):
    y = 0
    for i in range(0, len(data), 16):
        blk = data[i:i + 16].ljust(16, b"\0")
        y = _gmul(y ^ int.from_bytes(blk, "big"), h)
    return y


def _ctr(rk, j0, data):
    out = bytearray()
    ctr = int.from_bytes(j0[12:], "big")
    for i in range(0, len(data), 16):
        ctr = (ctr + 1) & 0xFFFFFFFF
        ks = _encrypt_block(rk, j0[:12] + ctr.to_bytes(4, "big"))
        out += bytes(a ^ b for a, b in zip(data[i:i + 16], ks))
    return bytes(out)


def aes_gcm(key, iv, plain):
    """AES-128-GCM with no associated data: ciphertext || 16-byte tag."""
    rk = _expand(key)
    h = int.from_bytes(_encrypt_block(rk, bytes(16)), "big")
    j0 = iv + b"\0\0\0\1"
    ct = _ctr(rk, j0, plain)
    lens = struct.pack(">QQ", 0, len(ct) * 8)
    s = _ghash(h, ct + bytes(-len(ct) % 16) + lens)
    tag = (int.from_bytes(_encrypt_block(rk, j0), "big") ^ s).to_bytes(16, "big")
    return ct + tag


def aes_gcm_open(key, iv, sealed):
    """For tests: the other half of aes_gcm()."""
    ct, tag = sealed[:-16], sealed[-16:]
    rk = _expand(key)
    h = int.from_bytes(_encrypt_block(rk, bytes(16)), "big")
    j0 = iv + b"\0\0\0\1"
    lens = struct.pack(">QQ", 0, len(ct) * 8)
    s = _ghash(h, ct + bytes(-len(ct) % 16) + lens)
    want = (int.from_bytes(_encrypt_block(rk, j0), "big") ^ s).to_bytes(16, "big")
    if not hmac.compare_digest(want, tag):
        raise ValueError("bad tag")
    return _ctr(rk, j0, ct)


# ---------------------------------------------------------------- RFC 8291

def encrypt(plain, ua_public, auth_secret, salt=None, as_key=None):
    """The body of a push message: one aes128gcm record, readable only by
    the browser that subscribed."""
    as_d, as_public = as_key or new_key()
    salt = salt or secrets.token_bytes(16)
    shared = ecdh(as_d, ua_public)
    ikm = hkdf(auth_secret, shared, b"WebPush: info\0" + ua_public + as_public, 32)
    cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\0", 12)
    head = salt + struct.pack(">I", 4096) + bytes([len(as_public)]) + as_public
    return head + aes_gcm(cek, nonce, plain + b"\x02")


def decrypt(body, ua_d, auth_secret):
    """For tests: what the browser does with encrypt()'s output."""
    salt, idlen = body[:16], body[20]
    as_public = body[21:21 + idlen]
    ua_public = public_of(ua_d)
    shared = ecdh(ua_d, as_public)
    ikm = hkdf(auth_secret, shared, b"WebPush: info\0" + ua_public + as_public, 32)
    cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\0", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\0", 12)
    plain = aes_gcm_open(cek, nonce, body[21 + idlen:])
    return plain.rstrip(b"\0")[:-1]


# ---------------------------------------------------------------- RFC 8292

def vapid_header(d, endpoint, subject, ttl=12 * 3600):
    u = urlparse(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}",
                              "exp": int(time.time()) + ttl, "sub": subject},
                             separators=(",", ":")).encode())
    msg = f"{head}.{claims}".encode()
    jwt = f"{head}.{claims}.{b64u(sign(d, msg))}"
    return f"vapid t={jwt}, k={b64u(public_of(d))}"


def send(sub, payload, vapid_d, subject, ttl=600, topic=None, urgency="high", timeout=10):
    """Post one message to one subscription. Returns the push service's
    status: 201 is sent, 404 and 410 mean the subscription is gone for good."""
    keys = sub.get("keys") or sub          # as the browser gives it, or as push.db keeps it
    body = encrypt(json.dumps(payload).encode(), unb64u(keys["p256dh"]), unb64u(keys["auth"]))
    headers = {"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
               "TTL": str(int(ttl)), "Urgency": urgency,
               "Authorization": vapid_header(vapid_d, sub["endpoint"], subject)}
    if topic:
        headers["Topic"] = topic
    req = urllib.request.Request(sub["endpoint"], data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
