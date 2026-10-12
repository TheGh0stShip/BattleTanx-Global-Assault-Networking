#ifndef BTGA_RELAY_H
#define BTGA_RELAY_H

#include "btga/btga_net.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BTGA_RELAY_MAGIC UINT32_C(0x4254524c) /* "BTRL" */
#define BTGA_RELAY_VERSION 1U
#define BTGA_RELAY_HEADER_SIZE 24U
#define BTGA_RELAY_MAX_DATAGRAM_SIZE \
    (BTGA_RELAY_HEADER_SIZE + BTGA_NET_MAX_DATAGRAM_SIZE)
#define BTGA_RELAY_BROADCAST_SLOT UINT16_MAX

typedef enum BtgaRelayMessageType {
    BTGA_RELAY_MSG_BIND = 1,
    BTGA_RELAY_MSG_BOUND = 2,
    BTGA_RELAY_MSG_DATA = 3,
    BTGA_RELAY_MSG_ERROR = 4
} BtgaRelayMessageType;

/* In-memory description; no native struct is serialized. */
typedef struct BtgaRelayEnvelope {
    uint8_t message_type;
    uint64_t session_id;
    uint16_t source_slot;
    uint16_t destination_slot;
    const uint8_t* payload;
    uint16_t payload_size;
} BtgaRelayEnvelope;

size_t btga_relay_encode(uint8_t* destination, size_t destination_size,
                         const BtgaRelayEnvelope* envelope);
int btga_relay_decode(BtgaRelayEnvelope* envelope, const uint8_t* datagram,
                      size_t datagram_size);

#ifdef __cplusplus
}
#endif

#endif
