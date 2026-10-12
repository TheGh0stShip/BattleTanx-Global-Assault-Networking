#ifndef BTGA_HANDSHAKE_H
#define BTGA_HANDSHAKE_H

#include "btga/btga_net.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BTGA_NET_HANDSHAKE_VERSION 1U
#define BTGA_NET_NONCE_SIZE 16U
#define BTGA_NET_MAX_JOIN_TOKEN_SIZE 1024U
#define BTGA_NET_HELLO_FIXED_SIZE 24U
#define BTGA_NET_CHALLENGE_SIZE (BTGA_NET_NONCE_SIZE * 2U)
#define BTGA_NET_AUTHENTICATE_SIZE (BTGA_NET_NONCE_SIZE * 2U)
#define BTGA_NET_WELCOME_SIZE 28U

typedef struct BtgaNetHello {
    uint8_t platform;
    uint32_t capabilities;
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    const uint8_t* join_token;
    uint16_t join_token_size;
} BtgaNetHello;

typedef struct BtgaNetChallenge {
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t host_nonce[BTGA_NET_NONCE_SIZE];
} BtgaNetChallenge;

typedef struct BtgaNetWelcome {
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    uint16_t assigned_peer_id;
    uint16_t max_players;
    uint16_t simulation_hz;
    uint32_t initial_tick;
} BtgaNetWelcome;

size_t btga_net_encode_hello(uint8_t* destination, size_t destination_size,
                             const BtgaNetHello* hello);
int btga_net_decode_hello(BtgaNetHello* hello, const uint8_t* payload,
                          size_t payload_size);
size_t btga_net_encode_challenge(uint8_t* destination, size_t destination_size,
                                 const BtgaNetChallenge* challenge);
int btga_net_decode_challenge(BtgaNetChallenge* challenge,
                              const uint8_t* payload, size_t payload_size);
size_t btga_net_encode_authenticate(uint8_t* destination,
                                    size_t destination_size,
                                    const BtgaNetChallenge* challenge);
int btga_net_decode_authenticate(BtgaNetChallenge* challenge,
                                 const uint8_t* payload, size_t payload_size);
size_t btga_net_encode_welcome(uint8_t* destination, size_t destination_size,
                               const BtgaNetWelcome* welcome);
int btga_net_decode_welcome(BtgaNetWelcome* welcome, const uint8_t* payload,
                            size_t payload_size);

#ifdef __cplusplus
}
#endif

#endif
