#include "btga/btga_net.h"

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

static int hex_value(char character) {
    if (character >= '0' && character <= '9') {
        return character - '0';
    }
    if (character >= 'a' && character <= 'f') {
        return character - 'a' + 10;
    }
    if (character >= 'A' && character <= 'F') {
        return character - 'A' + 10;
    }
    return -1;
}

static int valid_header(const BtgaNetHeader* header) {
    const int unassigned_handshake =
        header->peer_id == BTGA_NET_UNASSIGNED_PEER_ID &&
        (header->message_type == BTGA_NET_MSG_HELLO ||
         header->message_type == BTGA_NET_MSG_AUTHENTICATE);
    return header->protocol_version == BTGA_NET_PROTOCOL_VERSION &&
           header->message_type >= BTGA_NET_MSG_HELLO &&
           header->message_type <= BTGA_NET_MSG_DISCONNECT &&
           (header->flags & ~(BTGA_NET_FLAG_RELIABLE | BTGA_NET_FLAG_FRAGMENT |
                              BTGA_NET_FLAG_RELAYED)) == 0U &&
           header->payload_size <= BTGA_NET_MAX_PAYLOAD_SIZE &&
           (header->peer_id < BTGA_NET_MAX_PLAYERS || unassigned_handshake);
}

size_t btga_net_encode_header(uint8_t* destination, size_t destination_size,
                              const BtgaNetHeader* header) {
    if (destination == NULL || header == NULL || destination_size < BTGA_NET_HEADER_SIZE ||
        !valid_header(header)) {
        return 0U;
    }
    put_u32(destination, BTGA_NET_MAGIC);
    put_u16(destination + 4, header->protocol_version);
    destination[6] = header->message_type;
    destination[7] = header->flags;
    put_u64(destination + 8, header->session_id);
    put_u32(destination + 16, header->sequence);
    put_u32(destination + 20, header->acknowledgment);
    put_u32(destination + 24, header->acknowledgment_bits);
    put_u16(destination + 28, header->payload_size);
    put_u16(destination + 30, header->peer_id);
    return BTGA_NET_HEADER_SIZE;
}

int btga_net_decode_header(BtgaNetHeader* header, const uint8_t* packet,
                           size_t packet_size) {
    if (header == NULL || packet == NULL || packet_size < BTGA_NET_HEADER_SIZE ||
        get_u32(packet) != BTGA_NET_MAGIC) {
        return 0;
    }
    header->protocol_version = get_u16(packet + 4);
    header->message_type = packet[6];
    header->flags = packet[7];
    header->session_id = get_u64(packet + 8);
    header->sequence = get_u32(packet + 16);
    header->acknowledgment = get_u32(packet + 20);
    header->acknowledgment_bits = get_u32(packet + 24);
    header->payload_size = get_u16(packet + 28);
    header->peer_id = get_u16(packet + 30);
    return valid_header(header) &&
           packet_size == BTGA_NET_HEADER_SIZE + (size_t)header->payload_size;
}

int btga_net_parse_session_id(uint64_t* session_id, const char* text,
                              size_t text_size) {
    uint64_t value = 0U;
    size_t index;

    if (session_id == NULL || text == NULL ||
        text_size != BTGA_NET_SESSION_ID_TEXT_SIZE) {
        return 0;
    }
    for (index = 0U; index < BTGA_NET_SESSION_ID_TEXT_SIZE; ++index) {
        const int digit = hex_value(text[index]);
        if (digit < 0) {
            return 0;
        }
        value = (value << 4) | (uint64_t)(unsigned int)digit;
    }
    *session_id = value;
    return 1;
}

int btga_net_format_session_id(char* destination, size_t destination_size,
                               uint64_t session_id) {
    static const char digits[] = "0123456789abcdef";
    size_t index;

    if (destination == NULL ||
        destination_size < BTGA_NET_SESSION_ID_TEXT_SIZE + 1U) {
        return 0;
    }
    for (index = 0U; index < BTGA_NET_SESSION_ID_TEXT_SIZE; ++index) {
        const unsigned int shift = (unsigned int)
            ((BTGA_NET_SESSION_ID_TEXT_SIZE - index - 1U) * 4U);
        destination[index] = digits[(session_id >> shift) & UINT64_C(0xF)];
    }
    destination[BTGA_NET_SESSION_ID_TEXT_SIZE] = '\0';
    return 1;
}
