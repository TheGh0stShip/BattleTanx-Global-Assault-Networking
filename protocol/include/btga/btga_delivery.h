#ifndef BTGA_DELIVERY_H
#define BTGA_DELIVERY_H

#include "btga/btga_net.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BTGA_NET_SEND_WINDOW_CAPACITY 32U

typedef struct BtgaNetSendSlot {
    uint64_t sent_at_ms;
    uint32_t sequence;
    uint32_t user_tag;
    uint16_t attempts;
    uint8_t active;
} BtgaNetSendSlot;

typedef struct BtgaNetSendQueue {
    BtgaNetSendSlot slots[BTGA_NET_SEND_WINDOW_CAPACITY];
    uint16_t active_count;
} BtgaNetSendQueue;

typedef struct BtgaNetDelivery {
    uint32_t sequence;
    uint32_t user_tag;
    uint16_t attempts;
} BtgaNetDelivery;

typedef enum BtgaNetRetryResult {
    BTGA_NET_RETRY_EXPIRED = -1,
    BTGA_NET_RETRY_NONE = 0,
    BTGA_NET_RETRY_READY = 1
} BtgaNetRetryResult;

void btga_net_send_queue_init(BtgaNetSendQueue* queue);
int btga_net_send_queue_track(BtgaNetSendQueue* queue, uint32_t sequence,
                              uint64_t sent_at_ms, uint32_t user_tag);
size_t btga_net_send_queue_acknowledge(BtgaNetSendQueue* queue,
                                       uint32_t acknowledgment,
                                       uint32_t acknowledgment_bits,
                                       BtgaNetDelivery* deliveries,
                                       size_t delivery_capacity);
BtgaNetRetryResult btga_net_send_queue_poll(BtgaNetSendQueue* queue,
                                            uint64_t now_ms,
                                            uint64_t retry_interval_ms,
                                            uint16_t max_attempts,
                                            BtgaNetDelivery* delivery);

#ifdef __cplusplus
}
#endif

#endif
