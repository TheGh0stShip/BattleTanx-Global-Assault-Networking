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
#define BTGA_NET_FRAME_SYNC_VERSION 1U
#define BTGA_NET_FRAME_SYNC_TYPE 1U
#define BTGA_NET_FRAME_SYNC_SIZE 12U
#define BTGA_NET_AUTHORITY_PLAYER_LIMIT 4U
#define BTGA_NET_AUTHORITY_FRAME_VERSION 1U
#define BTGA_NET_AUTHORITY_FRAME_TYPE 2U
#define BTGA_NET_AUTHORITY_FRAME_HEADER_SIZE 16U
#define BTGA_NET_AUTHORITY_FRAME_SIZE \
    (BTGA_NET_AUTHORITY_FRAME_HEADER_SIZE + \
     BTGA_NET_AUTHORITY_PLAYER_LIMIT * BTGA_NET_INPUT_FRAME_SIZE)
#define BTGA_NET_SNAPSHOT_CHUNK_VERSION 1U
#define BTGA_NET_SNAPSHOT_CHUNK_TYPE 3U
#define BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE 32U
#define BTGA_NET_SNAPSHOT_CHUNK_DATA_LIMIT \
    (BTGA_NET_MAX_PAYLOAD_SIZE - BTGA_NET_SNAPSHOT_CHUNK_HEADER_SIZE)

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

/* Portable simulation-boundary marker carried in BTGA_NET_MSG_EVENT. */
typedef struct BtgaNetFrameSync {
    uint32_t frame;
    uint32_t state_checksum;
} BtgaNetFrameSync;

/* Canonical result of one server simulation tick. The received mask says
 * which seats supplied that tick on time; predicted seats used their last
 * accepted input. Unoccupied seats must be zero in both masks and inputs. */
typedef struct BtgaNetAuthoritativeFrame {
    uint32_t tick;
    uint64_t state_digest;
    uint8_t occupied_mask;
    uint8_t received_mask;
    BtgaNetInputFrame inputs[BTGA_NET_AUTHORITY_PLAYER_LIMIT];
} BtgaNetAuthoritativeFrame;

/* A full canonical server state is split across reliable snapshot chunks.
 * data points into the decoded packet and is valid only while that packet is
 * retained by the caller. Chunks may arrive out of order. */
typedef struct BtgaNetSnapshotChunk {
    uint32_t snapshot_id;
    uint32_t tick;
    uint64_t state_digest;
    uint32_t total_size;
    uint32_t offset;
    uint16_t data_size;
    const uint8_t* data;
} BtgaNetSnapshotChunk;

size_t btga_net_encode_input_batch(uint8_t* destination,
                                   size_t destination_size,
                                   const BtgaNetInputBatch* batch);
int btga_net_decode_input_batch(BtgaNetInputBatch* batch,
                                const uint8_t* payload,
                                size_t payload_size);
size_t btga_net_encode_frame_sync(uint8_t* destination,
                                  size_t destination_size,
                                  const BtgaNetFrameSync* sync);
int btga_net_decode_frame_sync(BtgaNetFrameSync* sync,
                               const uint8_t* payload,
                               size_t payload_size);
size_t btga_net_encode_authoritative_frame(
    uint8_t* destination, size_t destination_size,
    const BtgaNetAuthoritativeFrame* frame);
int btga_net_decode_authoritative_frame(
    BtgaNetAuthoritativeFrame* frame, const uint8_t* payload,
    size_t payload_size);
size_t btga_net_encode_snapshot_chunk(
    uint8_t* destination, size_t destination_size,
    const BtgaNetSnapshotChunk* chunk);
int btga_net_decode_snapshot_chunk(
    BtgaNetSnapshotChunk* chunk, const uint8_t* payload,
    size_t payload_size);

#ifdef __cplusplus
}
#endif

#endif
