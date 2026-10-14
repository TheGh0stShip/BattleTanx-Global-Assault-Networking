#ifndef BTGA_NET_H
#define BTGA_NET_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif
#define BTGA_NET_MAGIC UINT32_C(0x42544741) /* "BTGA" */
#define BTGA_NET_PROTOCOL_VERSION UINT16_C(1)
#define BTGA_NET_HEADER_SIZE 32U
#define BTGA_NET_MAX_DATAGRAM_SIZE 1200U
#define BTGA_NET_MAX_PAYLOAD_SIZE (BTGA_NET_MAX_DATAGRAM_SIZE - BTGA_NET_HEADER_SIZE)
#define BTGA_NET_MAX_PLAYERS 16U
#define BTGA_NET_UNASSIGNED_PEER_ID UINT16_MAX
#define BTGA_NET_SESSION_ID_TEXT_SIZE 16U

typedef enum BtgaNetPlatform {
    BTGA_NET_PLATFORM_UNKNOWN = 0,
    BTGA_NET_PLATFORM_PC = 1,
    BTGA_NET_PLATFORM_PS_VITA = 2,
    BTGA_NET_PLATFORM_XBOX_ORIGINAL = 3,
    BTGA_NET_PLATFORM_XBOX_360 = 4,
    BTGA_NET_PLATFORM_PS3 = 5,
    BTGA_NET_PLATFORM_PS4 = 6,
    BTGA_NET_PLATFORM_PS5 = 7,
    BTGA_NET_PLATFORM_NINTENDO_3DS = 8
} BtgaNetPlatform;

enum {
    BTGA_NET_CAP_DIRECT_UDP = 1U << 0,
    BTGA_NET_CAP_RELAY_UDP = 1U << 1,
    BTGA_NET_CAP_IPV6 = 1U << 2,
    BTGA_NET_CAP_VOICE = 1U << 3,
    BTGA_NET_CAP_SPECTATOR = 1U << 4,
    /* Lobby gameplay is owned by a headless authority, not a peer host. */
    BTGA_NET_CAP_DEDICATED_AUTHORITY = 1U << 5
};

typedef enum BtgaNetMessageType {
    BTGA_NET_MSG_HELLO = 1,
    BTGA_NET_MSG_CHALLENGE = 2,
    BTGA_NET_MSG_AUTHENTICATE = 3,
    BTGA_NET_MSG_WELCOME = 4,
    BTGA_NET_MSG_INPUT = 5,
    BTGA_NET_MSG_SNAPSHOT = 6,
    BTGA_NET_MSG_EVENT = 7,
    BTGA_NET_MSG_PING = 8,
    BTGA_NET_MSG_PONG = 9,
    BTGA_NET_MSG_DISCONNECT = 10
} BtgaNetMessageType;

enum {
    BTGA_NET_FLAG_RELIABLE = 1U << 0,
    BTGA_NET_FLAG_FRAGMENT = 1U << 1,
    BTGA_NET_FLAG_RELAYED = 1U << 2
};

/* This is an in-memory model, never a serialized native struct. */
typedef struct BtgaNetHeader {
    uint16_t protocol_version;
    uint8_t message_type;
    uint8_t flags;
    uint64_t session_id;
    uint32_t sequence;
    uint32_t acknowledgment;
    uint32_t acknowledgment_bits;
    uint16_t payload_size;
    uint16_t peer_id;
} BtgaNetHeader;

size_t btga_net_encode_header(uint8_t* destination, size_t destination_size,
                              const BtgaNetHeader* header);
int btga_net_decode_header(BtgaNetHeader* header, const uint8_t* packet,
                           size_t packet_size);
int btga_net_parse_session_id(uint64_t* session_id, const char* text,
                              size_t text_size);
int btga_net_format_session_id(char* destination, size_t destination_size,
                               uint64_t session_id);

#ifdef __cplusplus
}
#endif

#endif
