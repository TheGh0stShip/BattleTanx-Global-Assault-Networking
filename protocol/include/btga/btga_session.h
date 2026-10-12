#ifndef BTGA_SESSION_H
#define BTGA_SESSION_H

#include "btga/btga_handshake.h"
#include "btga/btga_transport.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum BtgaNetClientState {
    BTGA_NET_CLIENT_IDLE = 0,
    BTGA_NET_CLIENT_READY,
    BTGA_NET_CLIENT_HELLO_SENT,
    BTGA_NET_CLIENT_CHALLENGED,
    BTGA_NET_CLIENT_AUTH_SENT,
    BTGA_NET_CLIENT_ESTABLISHED,
    BTGA_NET_CLIENT_FAILED
} BtgaNetClientState;

typedef enum BtgaNetHostPendingState {
    BTGA_NET_HOST_PENDING_EMPTY = 0,
    BTGA_NET_HOST_PENDING_HELLO,
    BTGA_NET_HOST_PENDING_CHALLENGE_SENT,
    BTGA_NET_HOST_PENDING_AUTHENTICATED,
    BTGA_NET_HOST_PENDING_ESTABLISHED,
    BTGA_NET_HOST_PENDING_FAILED
} BtgaNetHostPendingState;

/*
 * Socket-free client admission state. The token is copied so an asynchronous
 * platform HTTPS adapter may release its response buffer immediately.
 */
typedef struct BtgaNetClientSession {
    uint64_t session_id;
    uint32_t capabilities;
    uint32_t next_sequence;
    uint16_t token_size;
    uint8_t platform;
    uint8_t state;
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t host_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t token[BTGA_NET_MAX_JOIN_TOKEN_SIZE];
} BtgaNetClientSession;

/*
 * One pending host admission. A platform host binds this object to the source
 * UDP endpoint from which HELLO arrived and validates token[] over HTTPS after
 * AUTHENTICATE succeeds. No source address or native pointer is serialized.
 */
typedef struct BtgaNetHostPending {
    uint64_t session_id;
    uint32_t capabilities;
    uint32_t next_sequence;
    uint16_t token_size;
    uint8_t platform;
    uint8_t state;
    uint8_t client_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t host_nonce[BTGA_NET_NONCE_SIZE];
    uint8_t token[BTGA_NET_MAX_JOIN_TOKEN_SIZE];
} BtgaNetHostPending;

int btga_net_client_session_init(BtgaNetClientSession* session,
                                 uint64_t session_id, uint8_t platform,
                                 uint32_t capabilities,
                                 const uint8_t* join_token,
                                 uint16_t join_token_size,
                                 const uint8_t client_nonce[BTGA_NET_NONCE_SIZE],
                                 uint32_t initial_sequence);
size_t btga_net_client_build_hello(BtgaNetClientSession* session,
                                   uint8_t* packet, size_t packet_capacity);
int btga_net_client_accept_challenge(BtgaNetClientSession* session,
                                     const uint8_t* packet,
                                     size_t packet_size);
size_t btga_net_client_build_authenticate(BtgaNetClientSession* session,
                                          uint8_t* packet,
                                          size_t packet_capacity);
int btga_net_client_accept_welcome(BtgaNetClientSession* session,
                                   BtgaNetWelcome* welcome,
                                   BtgaNetEndpoint* endpoint,
                                   const uint8_t* packet,
                                   size_t packet_size);

int btga_net_host_accept_hello(BtgaNetHostPending* pending,
                               uint64_t session_id,
                               const uint8_t host_nonce[BTGA_NET_NONCE_SIZE],
                               uint32_t initial_sequence,
                               const uint8_t* packet, size_t packet_size);
size_t btga_net_host_build_challenge(BtgaNetHostPending* pending,
                                     uint8_t* packet,
                                     size_t packet_capacity);
int btga_net_host_accept_authenticate(BtgaNetHostPending* pending,
                                      const uint8_t* packet,
                                      size_t packet_size);
size_t btga_net_host_build_welcome(BtgaNetHostPending* pending,
                                   uint16_t assigned_peer_id,
                                   uint16_t max_players,
                                   uint16_t simulation_hz,
                                   uint32_t initial_tick,
                                   uint8_t* packet,
                                   size_t packet_capacity);

#ifdef __cplusplus
}
#endif

#endif
