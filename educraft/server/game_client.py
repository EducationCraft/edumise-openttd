"""Scripted OpenTTD game client for gs_harness.py: joins over the real game protocol and
sends raw client packets (moves, commands), so the server-side wallet hooks in
network_server.cpp are tested where they run (CONTRACT.md §5 tests 1, 2 and 5).

It does not simulate the game: it acknowledges frames to stay connected and ignores
the map and the command stream. Encryption is monocypher's (X25519 key exchange,
BLAKE2b key derivation, XChaCha20-Poly1305 with a per-packet rekey), in pure Python
because the harness is stdlib only. Packet and command numbers are read from the
C++ headers, so the client follows the source it is tested against.
"""

import hashlib
import os
import re
import socket
import struct
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
M32 = 0xFFFFFFFF


def cpp_enum(header, name):
    """Values of a plain `enum class <name>` (sequential, optional `= number`)."""
    text = (ROOT / header).read_text(encoding="utf-8")
    body = re.search(r"enum class " + name + r"\b[^{]*\{(.*?)\n\};", text, re.S).group(1)
    body = re.sub(r"//[^\n]*|/\*.*?\*/", "", body, flags=re.S)
    values, n = {}, 0
    for item in filter(None, (x.strip() for x in body.split(","))):
        key, _, val = (s.strip() for s in item.partition("="))
        if val:
            n = values[val] if val in values else int(val, 0)
        values[key] = n
        n += 1
    return values


PKT = cpp_enum("src/network/core/tcp_game.h", "PacketGameType")
CMD = cpp_enum("src/command_type.h", "Commands")
ERR = {v: k for k, v in cpp_enum("src/network/network_type.h", "NetworkErrorCode").items()}
SPECTATOR, NEW_COMPANY = 255, 254


# ---------------------------------------------------------------- crypto

def _rotl(v, c):
    return ((v << c) & M32) | (v >> (32 - c))


def _rounds(state):
    x = list(state)
    for _ in range(10):
        for a, b, c, d in ((0, 4, 8, 12), (1, 5, 9, 13), (2, 6, 10, 14), (3, 7, 11, 15),
                           (0, 5, 10, 15), (1, 6, 11, 12), (2, 7, 8, 13), (3, 4, 9, 14)):
            x[a] = (x[a] + x[b]) & M32; x[d] = _rotl(x[d] ^ x[a], 16)
            x[c] = (x[c] + x[d]) & M32; x[b] = _rotl(x[b] ^ x[c], 12)
            x[a] = (x[a] + x[b]) & M32; x[d] = _rotl(x[d] ^ x[a], 8)
            x[c] = (x[c] + x[d]) & M32; x[b] = _rotl(x[b] ^ x[c], 7)
    return x


_SIGMA = struct.unpack("<4I", b"expand 32-byte k")


def _block(key, nonce8, counter):
    """ChaCha20, djb variant: 64-bit counter, 8-byte nonce."""
    st = [*_SIGMA, *struct.unpack("<8I", key), counter & M32, counter >> 32, *struct.unpack("<2I", nonce8)]
    return struct.pack("<16I", *((a + b) & M32 for a, b in zip(_rounds(st), st)))


def _xor(key, nonce8, counter, data):
    out = bytearray()
    for i in range(0, len(data), 64):
        chunk = data[i:i + 64]
        ks = int.from_bytes(_block(key, nonce8, counter + i // 64)[:len(chunk)], "little")
        out += (int.from_bytes(chunk, "little") ^ ks).to_bytes(len(chunk), "little")
    return bytes(out)


def _poly1305(key, msg):
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    p, acc = (1 << 130) - 5, 0
    for i in range(0, len(msg), 16):
        acc = (acc + int.from_bytes(msg[i:i + 16] + b"\x01", "little")) * r % p
    return ((acc + int.from_bytes(key[16:], "little")) & ((1 << 128) - 1)).to_bytes(16, "little")


def _pad16(b):
    return b + bytes(-len(b) % 16)


class Aead:
    """monocypher crypto_aead_init_x + crypto_aead_write/read: the key ratchets per message."""

    def __init__(self, key, nonce24):
        st = [*_SIGMA, *struct.unpack("<8I", key), *struct.unpack("<4I", nonce24[:16])]
        x = _rounds(st)
        self.key, self.nonce = struct.pack("<8I", *x[0:4], *x[12:16]), nonce24[16:]

    def _next(self, ad, cipher):
        auth = _block(self.key, self.nonce, 0)
        mac = _poly1305(auth[:32], _pad16(ad) + _pad16(cipher) + struct.pack("<QQ", len(ad), len(cipher)))
        return auth[32:], mac

    def write(self, plain, ad=b""):
        cipher = _xor(self.key, self.nonce, 1, plain)
        self.key, mac = self._next(ad, cipher)
        return mac, cipher

    def read(self, cipher):
        plain = _xor(self.key, self.nonce, 1, cipher)
        self.key = _block(self.key, self.nonce, 0)[32:]  # MAC not checked: a test client
        return plain


def x25519(k, u):
    """RFC 7748."""
    p, k = 2 ** 255 - 19, bytearray(k)
    k[0] &= 248; k[31] &= 127; k[31] |= 64
    k, x1 = int.from_bytes(k, "little"), int.from_bytes(u, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        bit = (k >> t) & 1
        if swap ^ bit:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b, c, d = x2 + z2, x2 - z2, x3 + z3, x3 - z3
        aa, bb, da, cb = a * a, b * b, d * a, c * b
        e = aa - bb
        x3, z3 = (da + cb) ** 2 % p, x1 * (da - cb) ** 2 % p
        x2, z2 = aa * bb % p, e * (aa + 121665 * e) % p
    if swap:
        x2, z2 = x3, z3
    return (x2 * pow(z2, p - 2, p) % p).to_bytes(32, "little")


# ---------------------------------------------------------------- client

def u8(v): return struct.pack("<B", v)
def u16(v): return struct.pack("<H", v)
def u32(v): return struct.pack("<I", v)
def i64(v): return struct.pack("<q", v)
def cstr(s): return s.encode() + b"\0"


class JoinRefused(Exception):
    pass


class GameClient:
    """One connected client. A reader thread acknowledges frames and records what it sees."""

    def __init__(self, port, revision, newgrf_version, name, playas=SPECTATOR):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.tx = self.rx = None
        self.lock = threading.Lock()
        self.chat, self.closed = [], False
        self.buf = b""

        self.send("ClientJoin", cstr(revision) + u32(newgrf_version))
        t, r = self.recv()
        self.refuse_on_error(t, r)
        assert t == PKT["ServerAuthenticationRequest"] and r[0] == 0, "expected X25519 key exchange only"
        server_pub, kx_nonce = r[1:33], r[33:57]

        secret = os.urandom(32)
        pub = x25519(secret, (9).to_bytes(32, "little"))
        keys = hashlib.blake2b(x25519(secret, server_pub) + server_pub + pub, digest_size=64).digest()
        mac, msg = Aead(keys[:32], kx_nonce).write(os.urandom(8), ad=pub)
        self.send("ClientAuthenticationResponse", pub + mac + msg)
        t, r = self.recv()
        self.refuse_on_error(t, r)
        assert t == PKT["ServerEnableEncryption"], t
        self.tx, self.rx = Aead(keys[:32], r[:24]), Aead(keys[32:], r[:24])

        self.send("ClientIdentify", cstr(name) + u8(playas))
        while True:
            t, r = self.recv()
            self.refuse_on_error(t, r)
            if t == PKT["ServerCheckNewGRFs"]:
                self.send("ClientNewGRFsChecked", b"")
            elif t == PKT["ServerWelcome"]:
                self.client_id = struct.unpack_from("<I", r)[0]
                self.send("ClientGetMap", b"")
            elif t == PKT["ServerMapDone"]:
                break
        self.send("ClientMapOk", b"")
        self.last_ack, self.acked = -1, threading.Event()
        threading.Thread(target=self.reader, daemon=True).start()
        # The server takes moves only once our first ACK made the client active.
        if not self.acked.wait(15):
            raise ConnectionError("no frame from the server after the map")
        time.sleep(0.5)  # ponytail: the ACK is handled on the next server tick (~30 ms); nothing observable marks it

    def refuse_on_error(self, t, r):
        if t == PKT["ServerError"]:
            raise JoinRefused(ERR.get(r[0], r[0]))
        if t in (PKT["ServerFull"], PKT["ServerBanned"]):
            raise JoinRefused("ServerFull" if t == PKT["ServerFull"] else "ServerBanned")

    def send(self, ptype, payload):
        body = u8(PKT[ptype]) + payload
        with self.lock:
            if self.tx is not None:
                mac, body = self.tx.write(body)
                body = mac + body
            self.sock.sendall(u16(len(body) + 2) + body)

    def recv(self):
        while len(self.buf) < 2 or len(self.buf) < struct.unpack_from("<H", self.buf)[0]:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("server closed the game connection")
            self.buf += chunk
        size = struct.unpack_from("<H", self.buf)[0]
        body, self.buf = self.buf[2:size], self.buf[size:]
        if self.rx is not None:
            body = self.rx.read(body[16:])
        return body[0], body[1:]

    def reader(self):
        try:
            while True:
                t, r = self.recv()
                if t == PKT["ServerFrame"]:
                    frame = struct.unpack_from("<I", r)[0]
                    token = r[8] if len(r) > 8 else None
                    if token is not None or frame >= self.last_ack + 74:
                        self.last_ack = frame
                        self.send("ClientAck", u32(frame) + u8(token or 0))
                        self.acked.set()
                elif t == PKT["ServerChat"]:
                    self.chat.append(r[6:r.index(b"\0", 6)].decode("utf-8", "replace"))
                elif t == PKT["ServerError"]:
                    self.chat.append(f"error {ERR.get(r[0], r[0])}")
        except OSError:
            pass
        finally:
            self.closed = True

    def move(self, company):
        self.send("ClientMove", u8(company))

    def command(self, company, cmd, *args):
        """Client command packet: company, command, error message, argument buffer, callback 0."""
        data = b"".join(args)
        self.send("ClientCommand", u8(company) + u16(CMD[cmd]) + u16(0) + u16(len(data)) + data + u8(0))

    def close(self):
        try:
            self.send("ClientQuit", b"")
        except OSError:
            pass
        self.sock.close()


def newgrf_version(openttd):
    """The NewGRF version the server binary checks on join, from its generated rev.cpp."""
    rev = (Path(openttd).resolve().parent / "generated/rev.cpp").read_text(encoding="utf-8")
    expr = re.search(r"_openttd_newgrf_version = ([0-9<|+ ()]+);", rev).group(1)
    assert re.fullmatch(r"[0-9<|+ ()]+", expr)
    return eval(expr)  # digits and operators only, checked above
