/**
 * OpenTTD admin-port packet framing (src/network/core/packet.cpp, tcp_admin.h).
 * Frame: uint16 LE total size | [16-byte MAC when encrypted] | uint8 type | payload.
 * With encryption, type+payload are encrypted with the incremental AEAD, no AD.
 */
import type { AeadStream } from './aead';

export const Admin = {
  Join: 0,
  Quit: 1,
  UpdateFrequency: 2,
  Poll: 3,
  Chat: 4,
  Rcon: 5,
  GameScript: 6,
  Ping: 7,
  ExternalChat: 8,
  JoinSecure: 9,
  AuthResponse: 10,
} as const;

export const Server = {
  Full: 100,
  Banned: 101,
  Error: 102,
  Protocol: 103,
  Welcome: 104,
  NewGame: 105,
  Shutdown: 106,
  Date: 107,
  ClientJoin: 108,
  ClientInfo: 109,
  ClientUpdate: 110,
  ClientQuit: 111,
  ClientError: 112,
  CompanyNew: 113,
  CompanyInfo: 114,
  CompanyUpdate: 115,
  CompanyRemove: 116,
  CompanyEconomy: 117,
  CompanyStats: 118,
  Chat: 119,
  Rcon: 120,
  Console: 121,
  CmdNames: 122,
  CmdLoggingOld: 123,
  GameScript: 124,
  RconEnd: 125,
  Pong: 126,
  CmdLogging: 127,
  AuthRequest: 128,
  EnableEncryption: 129,
} as const;

/** AdminUpdateType / AdminUpdateFrequency values used by the bridge. */
export const UpdateType = { ClientInfo: 1, CompanyInfo: 2, Gamescript: 9 } as const;
export const FREQ_AUTOMATIC = 1 << 6;
/** NetworkAuthenticationMethod::X25519_AuthorizedKey. */
export const AUTH_AUTHORIZED_KEY = 2;
export const MAC_SIZE = 16;
/** COMPAT_MTU: what the server accepts from an admin. */
export const MTU = 1460;

export class Writer {
  private parts: number[] = [];
  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  str(s: string): this {
    for (const b of Buffer.from(s, 'utf8')) this.parts.push(b);
    return this.u8(0);
  }
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('packet too short');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  u64(): bigint {
    const lo = BigInt(this.u32());
    return lo | (BigInt(this.u32()) << 32n);
  }
  str(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new Error('unterminated string');
    const s = Buffer.from(this.buf.subarray(this.pos, end)).toString('utf8');
    this.pos = end + 1;
    return s;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
}

/** Packet.PrepareToSend: size prefix, optional MAC, (encrypted) type+payload. */
export function encodeFrame(type: number, payload: Uint8Array, enc?: AeadStream): Uint8Array {
  const body = new Uint8Array(1 + payload.length);
  body[0] = type;
  body.set(payload, 1);
  const macLen = enc ? MAC_SIZE : 0;
  const size = 2 + macLen + body.length;
  if (size > MTU) throw new Error(`admin packet too large (${size})`);
  const out = new Uint8Array(size);
  out[0] = size & 0xff;
  out[1] = size >>> 8;
  if (enc) {
    const [mac, ct] = enc.write(body);
    out.set(mac, 2);
    out.set(ct, 2 + MAC_SIZE);
  } else {
    out.set(body, 2);
  }
  return out;
}

/**
 * Splits a byte stream into packets. `dec` is read at every packet, so the caller can
 * switch decryption on right after ServerEnableEncryption (the next packet is encrypted).
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);
  dec: AeadStream | undefined;

  push(chunk: Uint8Array): { type: number; payload: Uint8Array }[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: { type: number; payload: Uint8Array }[] = [];
    while (this.buf.length >= 2) {
      const size = this.buf[0] | (this.buf[1] << 8);
      if (size < 3) throw new Error('invalid packet size');
      if (this.buf.length < size) break;
      const frame = this.buf.subarray(2, size);
      this.buf = this.buf.slice(size);
      let body: Uint8Array;
      if (this.dec) {
        const plain = this.dec.read(frame.subarray(0, MAC_SIZE), frame.subarray(MAC_SIZE));
        if (!plain || plain.length < 1) throw new Error('admin packet failed authentication');
        body = plain;
      } else {
        body = frame;
      }
      const pkt = { type: body[0], payload: body.slice(1) };
      out.push(pkt);
      // The packet right after EnableEncryption is already encrypted: stop here and let
      // the caller install `dec` before the rest of this chunk is decoded.
      if (pkt.type === Server.EnableEncryption && !this.dec) break;
    }
    return out;
  }
}
