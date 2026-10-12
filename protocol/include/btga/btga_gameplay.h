#ifndef BTGA_GAMEPLAY_H
#define BTGA_GAMEPLAY_H

#include "btga/btga_net.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BTGA_NET_GAMEPLAY_VERSION 1U
#define BTGA_NET_MAX_INPUT_FRAMES 32U
#define BTGA_NET_INPUT_HEADER_SIZE 8U
#define BTGA_NET_INPUT_FRAME_SIZE 4U

typedef struct BtgaNetInputFrame {
    uint16_t buttons;
    int8_t stick_x;
    int8_t stick_y;
} BtgaNetInputFrame;

typedef struct BtgaNetInputBatch {
    uint32_t first_tick;
    uint8_t player_id;
    uint8_t frame_count;
    BtgaNetInputFrame frames[BTGA_NET_MAX_INPUT_FRAMES];
} BtgaNetInputBatch;

size_t btga_net_encode_input_batch(uint8_t* destination,
                                   size_t destination_size,
                                   const BtgaNetInputBatch* batch);
int btga_net_decode_input_batch(BtgaNetInputBatch* batch,
                                const uint8_t* payload,
                                size_t payload_size);

#ifdef __cplusplus
}
#endif

#endif
