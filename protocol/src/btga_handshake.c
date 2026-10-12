#include "btga/btga_handshake.h"

#include <string.h>

static void put_u16(uint8_t* output, uint16_t value) {
    output[0] = (uint8_t)(value >> 8);
    output[1] = (uint8_t)value;
}

static void put_u32(uint8_t* output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24);
    output[1] = (uint8_t)(value >> 16);
    output[2] = (uint8_t)(value >> 8);
    output[3] = (uint8_t)value;
}

static uint16_t get_u16(const uint8_t* input) {
    return (uint16_t)(((uint16_t)input[0] << 8) | input[1]);
}

static uint32_t get_u32(const uint8_t* input) {
    return ((uint32_t)input[0] << 24) | ((uint32_t)input[1] << 16) |
           ((uint32_t)input[2] << 8) | input[3];
}

static int valid_platform(uint8_t platform) {
    return platform >= BTGA_NET_PLATFORM_PC &&
           platform <= BTGA_NET_PLATFORM_NINTENDO_3DS;
}

size_t btga_net_encode_hello(uint8_t* destination, size_t destination_size,
                             const BtgaNetHello* hello) {
    size_t encoded_size;

    if (destination == NULL || hello == NULL || !valid_platform(hello->platform) ||
        hello->join_token == NULL || hello->join_token_size == 0U ||
        hello->join_token_size > BTGA_NET_MAX_JOIN_TOKEN_SIZE) {
        return 0U;
    }
    encoded_size = BTGA_NET_HELLO_FIXED_SIZE + (size_t)hello->join_token_size;
    if (destination_size < encoded_size || encoded_size > BTGA_NET_MAX_PAYLOAD_SIZE) {
        return 0U;
    }
    destination[0] = BTGA_NET_HANDSHAKE_VERSION;
    destination[1] = hello->platform;
    put_u16(destination + 2, hello->join_token_size);
    put_u32(destination + 4, hello->capabilities);
    memcpy(destination + 8, hello->client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(destination + BTGA_NET_HELLO_FIXED_SIZE, hello->join_token,
           hello->join_token_size);
    return encoded_size;
}

int btga_net_decode_hello(BtgaNetHello* hello, const uint8_t* payload,
                          size_t payload_size) {
    uint16_t token_size;

    if (hello == NULL || payload == NULL || payload_size < BTGA_NET_HELLO_FIXED_SIZE ||
        payload[0] != BTGA_NET_HANDSHAKE_VERSION || !valid_platform(payload[1])) {
        return 0;
    }
    token_size = get_u16(payload + 2);
    if (token_size == 0U || token_size > BTGA_NET_MAX_JOIN_TOKEN_SIZE ||
        payload_size != BTGA_NET_HELLO_FIXED_SIZE + (size_t)token_size) {
        return 0;
    }
    hello->platform = payload[1];
    hello->join_token_size = token_size;
    hello->capabilities = get_u32(payload + 4);
    memcpy(hello->client_nonce, payload + 8, BTGA_NET_NONCE_SIZE);
    hello->join_token = payload + BTGA_NET_HELLO_FIXED_SIZE;
    return 1;
}

static size_t encode_nonce_pair(uint8_t* destination, size_t destination_size,
                                const BtgaNetChallenge* challenge) {
    if (destination == NULL || challenge == NULL ||
        destination_size < BTGA_NET_CHALLENGE_SIZE) {
        return 0U;
    }
    memcpy(destination, challenge->client_nonce, BTGA_NET_NONCE_SIZE);
    memcpy(destination + BTGA_NET_NONCE_SIZE, challenge->host_nonce,
           BTGA_NET_NONCE_SIZE);
    return BTGA_NET_CHALLENGE_SIZE;
}

static int decode_nonce_pair(BtgaNetChallenge* challenge,
                             const uint8_t* payload, size_t payload_size) {
    if (challenge == NULL || payload == NULL ||
        payload_size != BTGA_NET_CHALLENGE_SIZE) {
        return 0;
    }
    memcpy(challenge->client_nonce, payload, BTGA_NET_NONCE_SIZE);
    memcpy(challenge->host_nonce, payload + BTGA_NET_NONCE_SIZE,
           BTGA_NET_NONCE_SIZE);
    return 1;
}

size_t btga_net_encode_challenge(uint8_t* destination, size_t destination_size,
                                 const BtgaNetChallenge* challenge) {
    return encode_nonce_pair(destination, destination_size, challenge);
}

int btga_net_decode_challenge(BtgaNetChallenge* challenge,
                              const uint8_t* payload, size_t payload_size) {
    return decode_nonce_pair(challenge, payload, payload_size);
}

size_t btga_net_encode_authenticate(uint8_t* destination,
                                    size_t destination_size,
                                    const BtgaNetChallenge* challenge) {
    return encode_nonce_pair(destination, destination_size, challenge);
}

int btga_net_decode_authenticate(BtgaNetChallenge* challenge,
                                 const uint8_t* payload, size_t payload_size) {
    return decode_nonce_pair(challenge, payload, payload_size);
}

size_t btga_net_encode_welcome(uint8_t* destination, size_t destination_size,
                               const BtgaNetWelcome* welcome) {
    if (destination == NULL || welcome == NULL ||
        destination_size < BTGA_NET_WELCOME_SIZE ||
        welcome->max_players == 0U || welcome->max_players > BTGA_NET_MAX_PLAYERS ||
        welcome->assigned_peer_id >= welcome->max_players ||
        welcome->simulation_hz == 0U) {
        return 0U;
    }
    memcpy(destination, welcome->client_nonce, BTGA_NET_NONCE_SIZE);
    put_u16(destination + 16, welcome->assigned_peer_id);
    put_u16(destination + 18, welcome->max_players);
    put_u16(destination + 20, welcome->simulation_hz);
    put_u16(destination + 22, 0U);
    put_u32(destination + 24, welcome->initial_tick);
    return BTGA_NET_WELCOME_SIZE;
}

int btga_net_decode_welcome(BtgaNetWelcome* welcome, const uint8_t* payload,
                            size_t payload_size) {
    if (welcome == NULL || payload == NULL ||
        payload_size != BTGA_NET_WELCOME_SIZE || get_u16(payload + 22) != 0U) {
        return 0;
    }
    memcpy(welcome->client_nonce, payload, BTGA_NET_NONCE_SIZE);
    welcome->assigned_peer_id = get_u16(payload + 16);
    welcome->max_players = get_u16(payload + 18);
    welcome->simulation_hz = get_u16(payload + 20);
    welcome->initial_tick = get_u32(payload + 24);
    return welcome->max_players != 0U &&
           welcome->max_players <= BTGA_NET_MAX_PLAYERS &&
           welcome->assigned_peer_id < welcome->max_players &&
           welcome->simulation_hz != 0U;
}
