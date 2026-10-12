#include "btga/btga_handshake.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static void fill_nonce(uint8_t* nonce, uint8_t first) {
    size_t index;
    for (index = 0U; index < BTGA_NET_NONCE_SIZE; ++index) {
        nonce[index] = (uint8_t)(first + index);
    }
}

static int test_hello(void) {
    static const uint8_t token[] = "opaque_master.token";
    BtgaNetHello source;
    BtgaNetHello decoded;
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    size_t size;

    memset(&source, 0, sizeof(source));
    source.platform = BTGA_NET_PLATFORM_PS_VITA;
    source.capabilities = BTGA_NET_CAP_DIRECT_UDP | BTGA_NET_CAP_SPECTATOR;
    fill_nonce(source.client_nonce, 0x10U);
    source.join_token = token;
    source.join_token_size = (uint16_t)(sizeof(token) - 1U);
    size = btga_net_encode_hello(payload, sizeof(payload), &source);
    CHECK(size == BTGA_NET_HELLO_FIXED_SIZE + sizeof(token) - 1U);
    CHECK(payload[0] == BTGA_NET_HANDSHAKE_VERSION);
    CHECK(payload[1] == BTGA_NET_PLATFORM_PS_VITA);
    CHECK(payload[2] == 0U && payload[3] == sizeof(token) - 1U);
    CHECK(payload[4] == 0U && payload[5] == 0U && payload[6] == 0U &&
          payload[7] == (BTGA_NET_CAP_DIRECT_UDP | BTGA_NET_CAP_SPECTATOR));
    CHECK(btga_net_decode_hello(&decoded, payload, size));
    CHECK(decoded.platform == source.platform);
    CHECK(decoded.capabilities == source.capabilities);
    CHECK(memcmp(decoded.client_nonce, source.client_nonce, BTGA_NET_NONCE_SIZE) == 0);
    CHECK(decoded.join_token_size == source.join_token_size);
    CHECK(memcmp(decoded.join_token, token, sizeof(token) - 1U) == 0);

    payload[0] = 0U;
    CHECK(!btga_net_decode_hello(&decoded, payload, size));
    payload[0] = BTGA_NET_HANDSHAKE_VERSION;
    CHECK(!btga_net_decode_hello(&decoded, payload, size - 1U));
    payload[2] = 0xFFU;
    payload[3] = 0xFFU;
    CHECK(!btga_net_decode_hello(&decoded, payload, BTGA_NET_HELLO_FIXED_SIZE));
    source.join_token_size = BTGA_NET_MAX_JOIN_TOKEN_SIZE + 1U;
    CHECK(btga_net_encode_hello(payload, sizeof(payload), &source) == 0U);
    source.join_token = (const uint8_t*)"missing_separator";
    source.join_token_size = 17U;
    CHECK(btga_net_encode_hello(payload, sizeof(payload), &source) == 0U);
    source.join_token = (const uint8_t*)"bad.token!";
    source.join_token_size = 10U;
    CHECK(btga_net_encode_hello(payload, sizeof(payload), &source) == 0U);
    return 0;
}

static int test_nonce_exchange(void) {
    BtgaNetChallenge source;
    BtgaNetChallenge decoded;
    uint8_t payload[BTGA_NET_CHALLENGE_SIZE];

    fill_nonce(source.client_nonce, 0x20U);
    fill_nonce(source.host_nonce, 0x80U);
    CHECK(btga_net_encode_challenge(payload, sizeof(payload), &source) ==
          BTGA_NET_CHALLENGE_SIZE);
    CHECK(btga_net_decode_challenge(&decoded, payload, sizeof(payload)));
    CHECK(memcmp(&source, &decoded, sizeof(source)) == 0);
    CHECK(btga_net_encode_authenticate(payload, sizeof(payload), &source) ==
          BTGA_NET_AUTHENTICATE_SIZE);
    CHECK(btga_net_decode_authenticate(&decoded, payload, sizeof(payload)));
    CHECK(memcmp(&source, &decoded, sizeof(source)) == 0);
    CHECK(!btga_net_decode_challenge(&decoded, payload, sizeof(payload) - 1U));
    return 0;
}

static int test_welcome(void) {
    BtgaNetWelcome source;
    BtgaNetWelcome decoded;
    uint8_t payload[BTGA_NET_WELCOME_SIZE];

    memset(&source, 0, sizeof(source));
    fill_nonce(source.client_nonce, 0x40U);
    source.assigned_peer_id = 3U;
    source.max_players = 4U;
    source.simulation_hz = 30U;
    source.initial_tick = UINT32_C(0x10203040);
    CHECK(btga_net_encode_welcome(payload, sizeof(payload), &source) ==
          BTGA_NET_WELCOME_SIZE);
    CHECK(btga_net_decode_welcome(&decoded, payload, sizeof(payload)));
    CHECK(memcmp(decoded.client_nonce, source.client_nonce, BTGA_NET_NONCE_SIZE) == 0);
    CHECK(decoded.assigned_peer_id == 3U);
    CHECK(decoded.max_players == 4U);
    CHECK(decoded.simulation_hz == 30U);
    CHECK(decoded.initial_tick == UINT32_C(0x10203040));
    payload[22] = 1U;
    CHECK(!btga_net_decode_welcome(&decoded, payload, sizeof(payload)));
    source.assigned_peer_id = 4U;
    CHECK(btga_net_encode_welcome(payload, sizeof(payload), &source) == 0U);
    return 0;
}

int main(void) {
    CHECK(test_hello() == 0);
    CHECK(test_nonce_exchange() == 0);
    CHECK(test_welcome() == 0);
    return 0;
}
