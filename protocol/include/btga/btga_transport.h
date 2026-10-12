#ifndef BTGA_TRANSPORT_H
#define BTGA_TRANSPORT_H

#include "btga/btga_net.h"
#include "btga/btga_reliability.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum BtgaNetPacketResult {
    BTGA_NET_PACKET_INVALID = -4,
    BTGA_NET_PACKET_WRONG_SESSION = -3,
    BTGA_NET_PACKET_SELF = -2,
    BTGA_NET_PACKET_TOO_OLD = -1,
    BTGA_NET_PACKET_DUPLICATE = 0,
    BTGA_NET_PACKET_NEW = 1
} BtgaNetPacketResult;

typedef struct BtgaNetPacketView {
    BtgaNetHeader header;
    const uint8_t* payload;
    size_t payload_size;
} BtgaNetPacketView;

/*
 * Socket-free endpoint state shared by every platform port. One receive
 * window is kept for each protocol peer; no host pointers cross the wire.
 */
typedef struct BtgaNetEndpoint {
    uint64_t session_id;
    uint32_t next_sequence;
    uint16_t local_peer_id;
    BtgaNetReceiveWindow peers[BTGA_NET_MAX_PLAYERS];
} BtgaNetEndpoint;

int btga_net_endpoint_init(BtgaNetEndpoint* endpoint, uint64_t session_id,
                           uint16_t local_peer_id, uint32_t initial_sequence);

/* Encodes a complete datagram and advances the local sequence on success. */
size_t btga_net_endpoint_encode(BtgaNetEndpoint* endpoint, uint8_t* destination,
                                size_t destination_size, uint8_t message_type,
                                uint8_t flags, uint16_t destination_peer_id,
                                const uint8_t* payload, size_t payload_size);

/*
 * Validates a complete datagram, its session and sender, then applies
 * per-peer replay/duplicate filtering. The packet view is set only for a new
 * packet and refers to the caller-owned datagram buffer.
 */
BtgaNetPacketResult btga_net_endpoint_decode(BtgaNetEndpoint* endpoint,
                                             BtgaNetPacketView* view,
                                             const uint8_t* packet,
                                             size_t packet_size);

#ifdef __cplusplus
}
#endif

#endif
