#ifndef BTGA_RELAY_CLIENT_H
#define BTGA_RELAY_CLIENT_H

#include "btga/btga_handshake.h"
#include "btga/btga_relay.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum BtgaRelayClientState {
    BTGA_RELAY_CLIENT_OFFLINE = 0,
    BTGA_RELAY_CLIENT_BINDING = 1,
    BTGA_RELAY_CLIENT_BOUND = 2
} BtgaRelayClientState;

typedef enum BtgaRelayRole {
    BTGA_RELAY_ROLE_HOST = 1,
    BTGA_RELAY_ROLE_CLIENT = 2
} BtgaRelayRole;

typedef struct BtgaRelayClient {
    uint8_t state;
    uint8_t role;
    uint64_t session_id;
    uint16_t relay_slot;
    uint16_t token_size;
    uint8_t token[BTGA_NET_MAX_JOIN_TOKEN_SIZE];
} BtgaRelayClient;

/* init is deliberately offline and emits no packet. */
void btga_relay_client_init(BtgaRelayClient* client);
int btga_relay_client_begin(BtgaRelayClient* client, BtgaRelayRole role,
                            uint64_t session_id, const uint8_t* token,
                            size_t token_size);
size_t btga_relay_client_make_bind(const BtgaRelayClient* client,
                                   uint8_t* destination,
                                   size_t destination_size);
int btga_relay_client_accept_bound(BtgaRelayClient* client,
                                   const uint8_t* datagram,
                                   size_t datagram_size);
size_t btga_relay_client_wrap(const BtgaRelayClient* client,
                              uint16_t destination_slot,
                              const uint8_t* inner_datagram,
                              size_t inner_size, uint8_t* destination,
                              size_t destination_size);
int btga_relay_client_unwrap(const BtgaRelayClient* client,
                             const uint8_t* relay_datagram,
                             size_t relay_size,
                             const uint8_t** inner_datagram,
                             size_t* inner_size, uint16_t* source_slot);
void btga_relay_client_disconnect(BtgaRelayClient* client);

#ifdef __cplusplus
}
#endif

#endif
