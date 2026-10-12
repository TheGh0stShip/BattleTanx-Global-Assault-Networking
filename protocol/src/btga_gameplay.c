#include "btga/btga_gameplay.h"

#include <stddef.h>

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

size_t btga_net_encode_input_batch(uint8_t* destination,
                                   size_t destination_size,
                                   const BtgaNetInputBatch* batch) {
    size_t index;
    size_t encoded_size;
    if (destination == NULL || batch == NULL ||
        batch->player_id >= BTGA_NET_MAX_PLAYERS || batch->frame_count == 0U ||
        batch->frame_count > BTGA_NET_MAX_INPUT_FRAMES) return 0U;
    encoded_size = BTGA_NET_INPUT_HEADER_SIZE +
                   (size_t)batch->frame_count * BTGA_NET_INPUT_FRAME_SIZE;
    if (destination_size < encoded_size || encoded_size > BTGA_NET_MAX_PAYLOAD_SIZE) return 0U;
    destination[0] = BTGA_NET_GAMEPLAY_VERSION;
    destination[1] = batch->player_id;
    destination[2] = batch->frame_count;
    destination[3] = 0U;
    put_u32(destination + 4, batch->first_tick);
    for (index = 0U; index < batch->frame_count; ++index) {
        uint8_t* output = destination + BTGA_NET_INPUT_HEADER_SIZE +
                          index * BTGA_NET_INPUT_FRAME_SIZE;
        put_u16(output, batch->frames[index].buttons);
        output[2] = (uint8_t)batch->frames[index].stick_x;
        output[3] = (uint8_t)batch->frames[index].stick_y;
    }
    return encoded_size;
}

int btga_net_decode_input_batch(BtgaNetInputBatch* batch,
                                const uint8_t* payload,
                                size_t payload_size) {
    size_t index;
    uint8_t frame_count;
    if (batch == NULL || payload == NULL ||
        payload_size < BTGA_NET_INPUT_HEADER_SIZE ||
        payload[0] != BTGA_NET_GAMEPLAY_VERSION ||
        payload[1] >= BTGA_NET_MAX_PLAYERS || payload[3] != 0U) return 0;
    frame_count = payload[2];
    if (frame_count == 0U || frame_count > BTGA_NET_MAX_INPUT_FRAMES ||
        payload_size != BTGA_NET_INPUT_HEADER_SIZE +
                        (size_t)frame_count * BTGA_NET_INPUT_FRAME_SIZE) return 0;
    batch->player_id = payload[1];
    batch->frame_count = frame_count;
    batch->first_tick = get_u32(payload + 4);
    for (index = 0U; index < frame_count; ++index) {
        const uint8_t* input = payload + BTGA_NET_INPUT_HEADER_SIZE +
                               index * BTGA_NET_INPUT_FRAME_SIZE;
        batch->frames[index].buttons = get_u16(input);
        batch->frames[index].stick_x = (int8_t)input[2];
        batch->frames[index].stick_y = (int8_t)input[3];
    }
    return 1;
}

size_t btga_net_encode_frame_sync(uint8_t* destination,
                                  size_t destination_size,
                                  const BtgaNetFrameSync* sync) {
    if (destination == NULL || sync == NULL ||
        destination_size < BTGA_NET_FRAME_SYNC_SIZE) return 0U;
    destination[0] = BTGA_NET_FRAME_SYNC_VERSION;
    destination[1] = BTGA_NET_FRAME_SYNC_TYPE;
    destination[2] = 0U;
    destination[3] = 0U;
    put_u32(destination + 4, sync->frame);
    put_u32(destination + 8, sync->state_checksum);
    return BTGA_NET_FRAME_SYNC_SIZE;
}

int btga_net_decode_frame_sync(BtgaNetFrameSync* sync,
                               const uint8_t* payload,
                               size_t payload_size) {
    if (sync == NULL || payload == NULL ||
        payload_size != BTGA_NET_FRAME_SYNC_SIZE ||
        payload[0] != BTGA_NET_FRAME_SYNC_VERSION ||
        payload[1] != BTGA_NET_FRAME_SYNC_TYPE ||
        payload[2] != 0U || payload[3] != 0U) return 0;
    sync->frame = get_u32(payload + 4);
    sync->state_checksum = get_u32(payload + 8);
    return 1;
}
