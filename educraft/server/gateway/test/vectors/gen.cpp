// Generates Monocypher reference vectors for test/aead.test.ts from the SAME
// monocypher.cpp the server links (src/3rdparty/monocypher). Regenerate:
//   g++ -std=c++17 -O1 -I../../../../../src/3rdparty/monocypher gen.cpp \
//       ../../../../../src/3rdparty/monocypher/monocypher.cpp -o /tmp/gen && /tmp/gen > monocypher.json
#include "monocypher.h"
#include <cstdio>
#include <cstring>
#include <cstdint>

static void hex(const char *name, const uint8_t *b, size_t n, bool comma = true)
{
	printf("  \"%s\": \"", name);
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
	printf("\"%s\n", comma ? "," : "");
}

int main()
{
	uint8_t key[32], nonce[24], client_sk[32], server_sk[32];
	for (int i = 0; i < 32; i++) { key[i] = (uint8_t)(i * 7 + 1); client_sk[i] = (uint8_t)(0x40 + i); server_sk[i] = (uint8_t)(0x90 + i * 3); }
	for (int i = 0; i < 24; i++) nonce[i] = (uint8_t)(0xa0 + i);

	/* Incremental AEAD, two messages on one context (ratchet), no AD — packet encryption. */
	uint8_t m1[5] = {'h', 'e', 'l', 'l', 'o'};
	uint8_t m2[70];
	for (int i = 0; i < 70; i++) m2[i] = (uint8_t)i;
	uint8_t c1[5], c2[70], mac1[16], mac2[16];
	crypto_aead_ctx ctx;
	crypto_aead_init_x(&ctx, key, nonce);
	crypto_aead_write(&ctx, c1, mac1, nullptr, 0, m1, sizeof(m1));
	crypto_aead_write(&ctx, c2, mac2, nullptr, 0, m2, sizeof(m2));

	/* One-shot lock with AD — the key-exchange response. */
	uint8_t ad[32], msg[8] = {1, 2, 3, 4, 5, 6, 7, 8}, lc[8], lmac[16];
	for (int i = 0; i < 32; i++) ad[i] = (uint8_t)(255 - i);
	crypto_aead_lock(lc, lmac, key, nonce, ad, sizeof(ad), msg, sizeof(msg));

	/* X25519 + BLAKE2b-512 derivation as in X25519DerivedKeys::Exchange (client side). */
	uint8_t client_pk[32], server_pk[32], shared[32], derived[64];
	crypto_x25519_public_key(client_pk, client_sk);
	crypto_x25519_public_key(server_pk, server_sk);
	crypto_x25519(shared, client_sk, server_pk);
	crypto_blake2b_ctx b;
	crypto_blake2b_init(&b, 64);
	crypto_blake2b_update(&b, shared, 32);
	crypto_blake2b_update(&b, server_pk, 32);
	crypto_blake2b_update(&b, client_pk, 32);
	crypto_blake2b_final(&b, derived);

	printf("{\n");
	hex("key", key, 32); hex("nonce", nonce, 24);
	hex("m1", m1, 5); hex("c1", c1, 5); hex("mac1", mac1, 16);
	hex("m2", m2, 70); hex("c2", c2, 70); hex("mac2", mac2, 16);
	hex("ad", ad, 32); hex("lockMsg", msg, 8); hex("lockCipher", lc, 8); hex("lockMac", lmac, 16);
	hex("clientSecret", client_sk, 32); hex("clientPublic", client_pk, 32);
	hex("serverSecret", server_sk, 32); hex("serverPublic", server_pk, 32);
	hex("derived", derived, 64, false);
	printf("}\n");
	return 0;
}
