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

static void put_u64(uint8_t* output, uint64_t value) {
    put_u32(output, (uint32_t)(value >> 32));
    put_u32(output + 4, (uint32_t)value);
}

static uint16_t get_u16(const uint8_t* input) {
    return (uint16_t)(((uint16_t)input[0] << 8) | input[1]);
}

static uint32_t get_u32(const uint8_t* input) {
    return ((uint32_t)input[0] << 24) | ((uint32_t)input[1] << 16) |
           ((uint32_t)input[2] << 8) | input[3];
}

static uint64_t get_u64(const uint8_t* input) {
    return ((uint64_t)get_u32(input) << 32) | get_u32(input + 4);
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

size_t btga_net_encode_authoritative_frame(
    uint8_t* destination, size_t destination_size,
    const BtgaNetAuthoritativeFrame* frame) {
    size_t index;
    if (destination == NULL || frame == NULL ||
        destination_size < BTGA_NET_AUTHORITY_FRAME_SIZE ||
        frame->occupied_mask == 0U || (frame->occupied_mask & 0xF0U) != 0U ||
        (frame->connected_mask & (uint8_t)~frame->occupied_mask) != 0U ||
        (frame->received_mask & (uint8_t)~frame->connected_mask) != 0U) return 0U;
    destination[0] = BTGA_NET_AUTHORITY_FRAME_VERSION;
    destination[1] = BTGA_NET_AUTHORITY_FRAME_TYPE;
    destination[2] = frame->occupied_mask;
    destination[3] = frame->connected_mask;
    destination[4] = frame->received_mask;
    destination[5] = 0U;
    destination[6] = 0U;
    destination[7] = 0U;
    put_u32(destination + 8, frame->tick);
    put_u64(destination + 12, frame->state_digest);
    put_u32(destination + 20, frame->random_seed);
    for (index = 0U; index < BTGA_NET_AUTHORITY_PLAYER_LIMIT; ++index) {
        uint8_t* output = destination + BTGA_NET_AUTHORITY_FRAME_HEADER_SIZE +
                          index * BTGA_NET_INPUT_FRAME_SIZE;
        if ((frame->occupied_mask & (1U << index)) == 0U &&
            (frame->inputs[index].buttons != 0U ||
             frame->inputs[index].stick_x != 0 ||
             frame->inputs[index].stick_y != 0)) return 0U;
        put_u16(output, frame->inputs[index].buttons);
        output[2] = (uint8_t)frame->inputs[index].stick_x;
        output[3] = (uint8_t)frame->inputs[index].stick_y;
    }
    return BTGA_NET_AUTHORITY_FRAME_SIZE;
}

int btga_net_decode_authoritative_frame(
    BtgaNetAuthoritativeFrame* frame, const uint8_t* payload,
    size_t payload_size) {
    size_t index;
    if (frame == NULL || payload == NULL ||
        payload_size != BTGA_NET_AUTHORITY_FRAME_SIZE ||
        payload[0] != BTGA_NET_AUTHORITY_FRAME_VERSION ||
        payload[1] != BTGA_NET_AUTHORITY_FRAME_TYPE ||
        payload[2] == 0U || (payload[2] & 0xF0U) != 0U ||
        (payload[3] & (uint8_t)~payload[2]) != 0U ||
        (payload[4] & (uint8_t)~payload[3]) != 0U ||
        payload[5] != 0U || payload[6] != 0U || payload[7] != 0U) return 0;
    frame->occupied_mask = payload[2];
    frame->connected_mask = payload[3];
    frame->received_mask = payload[4];
    frame->tick = get_u32(payload + 8);
    frame->state_digest = get_u64(payload + 12);
    frame->random_seed = get_u32(payload + 20);
    for (index = 0U; index < BTGA_NET_AUTHORITY_PLAYER_LIMIT; ++index) {
        const uint8_t* input = payload + BTGA_NET_AUTHORITY_FRAME_HEADER_SIZE +
                               index * BTGA_NET_INPUT_FRAME_SIZE;
        frame->inputs[index].buttons = get_u16(input);
        frame->inputs[index].stick_x = (int8_t)input[2];
        frame->inputs[index].stick_y = (int8_t)input[3];
        if ((frame->occupied_mask & (1U << index)) == 0U &&
            (frame->inputs[index].buttons != 0U ||
             frame->inputs[index].stick_x != 0 ||
             frame->inputs[index].stick_y != 0)) return 0;
    }
    return 1;
}

size_t btga_net_encode_snapshot_chunk(
    uint8_t* destination, size_t destination_size,
    const BtgaNetSnapshotChunk* chunk) {
    size_t encoded_size;
    if (destination == NULL || chunk == NULL || chunk->data == NULL ||
        chunk->data_size == 0U ||
        chunk->data_size > BTGA_NET_SNAPSHOT_CHUNK_DATA_LIMIT ||
        chunk->total_size == 0U || chunk->offset >= chunk->total_size ||
        (uint64_t)chunk->offset + chunk->data_size > chunk->total_size) return 0U;
    encoded_size = BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE + chunk->data_size;
    if (destination_size < encoded_size) return 0U;
    destination[0] = BTGA_NET_SNAPSHOT_CHUNK_VERSION;
    destination[1] = BTGA_NET_SNAPSHOT_CHUNK_TYPE;
    destination[2] = 0U;
    destination[3] = 0U;
    put_u32(destination + 4, chunk->snapshot_id);
    put_u32(destination + 8, chunk->tick);
    put_u64(destination + 12, chunk->state_digest);
    put_u32(destination + 20, chunk->total_size);
    put_u32(destination + 24, chunk->offset);
    put_u16(destination + 28, chunk->data_size);
    destination[30] = 0U;
    destination[31] = 0U;
    {
        size_t index;
        for (index = 0U; index < chunk->data_size; ++index) {
            destination[BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE + index] =
                chunk->data[index];
        }
    }
    return encoded_size;
}

int btga_net_decode_snapshot_chunk(
    BtgaNetSnapshotChunk* chunk, const uint8_t* payload,
    size_t payload_size) {
    uint16_t data_size;
    uint32_t total_size;
    uint32_t offset;
    if (chunk == NULL || payload == NULL ||
        payload_size < BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE ||
        payload[0] != BTGA_NET_SNAPSHOT_CHUNK_VERSION ||
        payload[1] != BTGA_NET_SNAPSHOT_CHUNK_TYPE ||
        payload[2] != 0U || payload[3] != 0U ||
        payload[30] != 0U || payload[31] != 0U) return 0;
    total_size = get_u32(payload + 20);
    offset = get_u32(payload + 24);
    data_size = get_u16(payload + 28);
    if (data_size == 0U || data_size > BTGA_NET_SNAPSHOT_CHUNK_DATA_LIMIT ||
        payload_size != BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE + data_size ||
        total_size == 0U || offset >= total_size ||
        (uint64_t)offset + data_size > total_size) return 0;
    chunk->snapshot_id = get_u32(payload + 4);
    chunk->tick = get_u32(payload + 8);
    chunk->state_digest = get_u64(payload + 12);
    chunk->total_size = total_size;
    chunk->offset = offset;
    chunk->data_size = data_size;
    chunk->data = payload + BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE;
    return 1;
}
