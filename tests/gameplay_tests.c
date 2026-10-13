#include "btga/btga_gameplay.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

int main(void) {
    static const uint8_t expected[] = {
        0x01, 0x03, 0x02, 0x00, 0xFF, 0xFF, 0xFF, 0xFE,
        0x90, 0x01, 0xB0, 0x50, 0x20, 0x04, 0x80, 0x7F
    };
    BtgaNetInputBatch source = {0};
    BtgaNetInputBatch decoded = {0};
    uint8_t payload[BTGA_NET_MAX_PAYLOAD_SIZE];
    size_t encoded_size;
    source.first_tick = UINT32_MAX - 1U;
    source.player_id = 3U;
    source.frame_count = 2U;
    source.frames[0].buttons = UINT16_C(0x9001);
    source.frames[0].stick_x = -80;
    source.frames[0].stick_y = 80;
    source.frames[1].buttons = UINT16_C(0x2004);
    source.frames[1].stick_x = INT8_MIN;
    source.frames[1].stick_y = INT8_MAX;
    encoded_size = btga_net_encode_input_batch(payload, sizeof(payload), &source);
    CHECK(encoded_size == sizeof(expected));
    CHECK(memcmp(payload, expected, sizeof(expected)) == 0);
    CHECK(btga_net_decode_input_batch(&decoded, payload, encoded_size));
    CHECK(decoded.first_tick == source.first_tick);
    CHECK(decoded.player_id == source.player_id && decoded.frame_count == 2U);
    CHECK(decoded.frames[0].buttons == source.frames[0].buttons);
    CHECK(decoded.frames[0].stick_x == -80 && decoded.frames[0].stick_y == 80);
    CHECK(decoded.frames[1].stick_x == INT8_MIN &&
          decoded.frames[1].stick_y == INT8_MAX);
    payload[3] = 1U;
    CHECK(!btga_net_decode_input_batch(&decoded, payload, encoded_size));
    payload[3] = 0U;
    CHECK(!btga_net_decode_input_batch(&decoded, payload, encoded_size - 1U));
    source.frame_count = 0U;
    CHECK(btga_net_encode_input_batch(payload, sizeof(payload), &source) == 0U);
    source.frame_count = BTGA_NET_MAX_INPUT_FRAMES + 1U;
    CHECK(btga_net_encode_input_batch(payload, sizeof(payload), &source) == 0U);

    {
        static const uint8_t expected_sync[] = {
            0x01, 0x01, 0x00, 0x00, 0xFE, 0xDC, 0xBA, 0x98,
            0x12, 0x34, 0x56, 0x78
        };
        const BtgaNetFrameSync frame = {
            UINT32_C(0xFEDCBA98), UINT32_C(0x12345678)
        };
        BtgaNetFrameSync decoded_frame = {0};
        encoded_size = btga_net_encode_frame_sync(payload, sizeof(payload), &frame);
        CHECK(encoded_size == sizeof(expected_sync));
        CHECK(memcmp(payload, expected_sync, sizeof(expected_sync)) == 0);
        CHECK(btga_net_decode_frame_sync(&decoded_frame, payload, encoded_size));
        CHECK(decoded_frame.frame == frame.frame);
        CHECK(decoded_frame.state_checksum == frame.state_checksum);
        CHECK(!btga_net_decode_frame_sync(&decoded_frame, payload, encoded_size - 1U));
        payload[2] = 1U;
        CHECK(!btga_net_decode_frame_sync(&decoded_frame, payload, encoded_size));
        payload[2] = 0U;
        CHECK(btga_net_encode_frame_sync(payload, BTGA_NET_FRAME_SYNC_SIZE - 1U,
                                         &frame) == 0U);
    }
    {
        static const uint8_t expected_authority[] = {
            0x02, 0x02, 0x0F, 0x0F, 0x0B, 0x00, 0x00, 0x00,
            0x01, 0x02, 0x03, 0x04,
            0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
            0xA1, 0xB2, 0xC3, 0xD4,
            0x00, 0x01, 0xFE, 0x03, 0x00, 0x02, 0x04, 0xFB,
            0x80, 0x00, 0x80, 0x7F, 0x40, 0x00, 0x00, 0x00
        };
        BtgaNetAuthoritativeFrame frame = {0};
        BtgaNetAuthoritativeFrame decoded_frame = {0};
        frame.tick = UINT32_C(0x01020304);
        frame.state_digest = UINT64_C(0x1122334455667788);
        frame.random_seed = UINT32_C(0xA1B2C3D4);
        frame.occupied_mask = 0x0FU;
        frame.connected_mask = 0x0FU;
        frame.received_mask = 0x0BU;
        frame.inputs[0] = (BtgaNetInputFrame){1U, -2, 3};
        frame.inputs[1] = (BtgaNetInputFrame){2U, 4, -5};
        frame.inputs[2] = (BtgaNetInputFrame){UINT16_C(0x8000), INT8_MIN, INT8_MAX};
        frame.inputs[3] = (BtgaNetInputFrame){UINT16_C(0x4000), 0, 0};
        encoded_size = btga_net_encode_authoritative_frame(
            payload, sizeof(payload), &frame);
        CHECK(encoded_size == sizeof(expected_authority));
        CHECK(memcmp(payload, expected_authority, sizeof(expected_authority)) == 0);
        CHECK(btga_net_decode_authoritative_frame(
            &decoded_frame, payload, encoded_size));
        CHECK(decoded_frame.tick == frame.tick);
        CHECK(decoded_frame.state_digest == frame.state_digest);
        CHECK(decoded_frame.random_seed == frame.random_seed);
        CHECK(decoded_frame.occupied_mask == frame.occupied_mask);
        CHECK(decoded_frame.connected_mask == frame.connected_mask);
        CHECK(decoded_frame.received_mask == frame.received_mask);
        CHECK(memcmp(decoded_frame.inputs, frame.inputs,
                     sizeof(frame.inputs)) == 0);
        payload[4] = 0x10U;
        CHECK(!btga_net_decode_authoritative_frame(
            &decoded_frame, payload, encoded_size));
        payload[4] = frame.received_mask;
        payload[2] = 0U;
        CHECK(!btga_net_decode_authoritative_frame(
            &decoded_frame, payload, encoded_size));
    }
    {
        static const uint8_t bytes[] = {0x10, 0x20, 0x30, 0x40, 0x50};
        BtgaNetSnapshotChunk chunk = {
            UINT32_C(0x10203040), UINT32_C(0x50607080),
            UINT64_C(0x1122334455667788), 9U, 4U, 5U, bytes
        };
        BtgaNetSnapshotChunk decoded_chunk = {0};
        encoded_size = btga_net_encode_snapshot_chunk(
            payload, sizeof(payload), &chunk);
        CHECK(encoded_size == BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE + sizeof(bytes));
        CHECK(payload[0] == 1U && payload[1] == 3U);
        CHECK(payload[4] == 0x10U && payload[7] == 0x40U);
        CHECK(payload[20] == 0U && payload[23] == 9U);
        CHECK(payload[24] == 0U && payload[27] == 4U);
        CHECK(payload[28] == 0U && payload[29] == sizeof(bytes));
        CHECK(memcmp(payload + BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE,
                     bytes, sizeof(bytes)) == 0);
        CHECK(btga_net_decode_snapshot_chunk(
            &decoded_chunk, payload, encoded_size));
        CHECK(decoded_chunk.snapshot_id == chunk.snapshot_id);
        CHECK(decoded_chunk.tick == chunk.tick);
        CHECK(decoded_chunk.state_digest == chunk.state_digest);
        CHECK(decoded_chunk.total_size == 9U && decoded_chunk.offset == 4U);
        CHECK(decoded_chunk.data_size == sizeof(bytes));
        CHECK(memcmp(decoded_chunk.data, bytes, sizeof(bytes)) == 0);
        payload[30] = 1U;
        CHECK(!btga_net_decode_snapshot_chunk(
            &decoded_chunk, payload, encoded_size));
        payload[30] = 0U;
        CHECK(!btga_net_decode_snapshot_chunk(
            &decoded_chunk, payload, encoded_size - 1U));
        chunk.offset = 5U;
        CHECK(btga_net_encode_snapshot_chunk(
            payload, sizeof(payload), &chunk) == 0U);
    }
    return 0;
}
