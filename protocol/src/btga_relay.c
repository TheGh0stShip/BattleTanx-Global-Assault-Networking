#include "btga/btga_relay.h"

#include <string.h>

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

static int valid(const BtgaRelayEnvelope* envelope) {
    return envelope != NULL &&
           envelope->message_type >= BTGA_RELAY_MSG_BIND &&
           envelope->message_type <= BTGA_RELAY_MSG_ERROR &&
           envelope->payload_size <= BTGA_NET_MAX_DATAGRAM_SIZE &&
           (envelope->payload_size == 0U || envelope->payload != NULL);
}

size_t btga_relay_encode(uint8_t* destination, size_t destination_size,
                         const BtgaRelayEnvelope* envelope) {
    const size_t encoded_size = envelope == NULL
        ? 0U : BTGA_RELAY_HEADER_SIZE + (size_t)envelope->payload_size;
    if (destination == NULL || !valid(envelope) || destination_size < encoded_size) {
        return 0U;
    }
    put_u32(destination, BTGA_RELAY_MAGIC);
    destination[4] = BTGA_RELAY_VERSION;
    destination[5] = envelope->message_type;
    put_u16(destination + 6, 0U);
    put_u64(destination + 8, envelope->session_id);
    put_u16(destination + 16, envelope->source_slot);
    put_u16(destination + 18, envelope->destination_slot);
    put_u16(destination + 20, envelope->payload_size);
    put_u16(destination + 22, 0U);
    if (envelope->payload_size != 0U) {
        memcpy(destination + BTGA_RELAY_HEADER_SIZE, envelope->payload,
               envelope->payload_size);
    }
    return encoded_size;
}

int btga_relay_decode(BtgaRelayEnvelope* envelope, const uint8_t* datagram,
                      size_t datagram_size) {
    uint16_t payload_size;
    if (envelope == NULL || datagram == NULL ||
        datagram_size < BTGA_RELAY_HEADER_SIZE ||
        datagram_size > BTGA_RELAY_MAX_DATAGRAM_SIZE ||
        get_u32(datagram) != BTGA_RELAY_MAGIC ||
        datagram[4] != BTGA_RELAY_VERSION ||
        get_u16(datagram + 6) != 0U || get_u16(datagram + 22) != 0U) {
        return 0;
    }
    payload_size = get_u16(datagram + 20);
    envelope->message_type = datagram[5];
    envelope->session_id = get_u64(datagram + 8);
    envelope->source_slot = get_u16(datagram + 16);
    envelope->destination_slot = get_u16(datagram + 18);
    envelope->payload_size = payload_size;
    envelope->payload = datagram + BTGA_RELAY_HEADER_SIZE;
    return datagram_size == BTGA_RELAY_HEADER_SIZE + (size_t)payload_size &&
           valid(envelope);
}
