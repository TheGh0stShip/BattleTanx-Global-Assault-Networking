#ifndef BTGA_RELIABILITY_H
#define BTGA_RELIABILITY_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum BtgaNetReceiveResult {
    BTGA_NET_RECEIVE_TOO_OLD = -1,
    BTGA_NET_RECEIVE_DUPLICATE = 0,
    BTGA_NET_RECEIVE_NEW = 1
} BtgaNetReceiveResult;

typedef struct BtgaNetReceiveWindow {
    uint32_t most_recent;
    uint32_t acknowledgment_bits;
    uint8_t initialized;
} BtgaNetReceiveWindow;

void btga_net_receive_window_init(BtgaNetReceiveWindow* window);
int btga_net_sequence_more_recent(uint32_t left, uint32_t right);
BtgaNetReceiveResult btga_net_receive_window_record(BtgaNetReceiveWindow* window,
                                                    uint32_t sequence);
int btga_net_sequence_is_acknowledged(uint32_t sequence, uint32_t acknowledgment,
                                      uint32_t acknowledgment_bits);

#ifdef __cplusplus
}
#endif

#endif
