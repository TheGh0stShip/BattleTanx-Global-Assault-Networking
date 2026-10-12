#include "btga/btga_transport.h"

#include <string.h>

int btga_net_endpoint_init(BtgaNetEndpoint* endpoint, uint64_t session_id,
                           uint16_t local_peer_id, uint32_t initial_sequence) {
    size_t index;

    if (endpoint == NULL || session_id == 0U || local_peer_id >= BTGA_NET_MAX_PLAYERS) {
        return 0;
    }
    endpoint->session_id = session_id;
    endpoint->next_sequence = initial_sequence;
    endpoint->local_peer_id = local_peer_id;
    for (index = 0U; index < BTGA_NET_MAX_PLAYERS; ++index) {
        btga_net_receive_window_init(&endpoint->peers[index]);
    }
    return 1;
}

size_t btga_net_endpoint_encode(BtgaNetEndpoint* endpoint, uint8_t* destination,
                                size_t destination_size, uint8_t message_type,
                                uint8_t flags, uint16_t destination_peer_id,
                                const uint8_t* payload, size_t payload_size) {
    BtgaNetHeader header;
    const BtgaNetReceiveWindow* receive_window;
    size_t packet_size;

    if (endpoint == NULL || destination == NULL ||
        destination_peer_id >= BTGA_NET_MAX_PLAYERS ||
        destination_peer_id == endpoint->local_peer_id ||
        payload_size > BTGA_NET_MAX_PAYLOAD_SIZE ||
        (payload_size != 0U && payload == NULL)) {
        return 0U;
    }
    packet_size = BTGA_NET_HEADER_SIZE + payload_size;
    if (destination_size < packet_size) {
        return 0U;
    }

    header.protocol_version = BTGA_NET_PROTOCOL_VERSION;
    header.message_type = message_type;
    header.flags = flags;
    header.session_id = endpoint->session_id;
    header.sequence = endpoint->next_sequence;
    receive_window = &endpoint->peers[destination_peer_id];
    header.acknowledgment = receive_window->initialized != 0U
        ? receive_window->most_recent : 0U;
    header.acknowledgment_bits = receive_window->initialized != 0U
        ? receive_window->acknowledgment_bits : 0U;
    header.payload_size = (uint16_t)payload_size;
    header.peer_id = endpoint->local_peer_id;
    if (btga_net_encode_header(destination, destination_size, &header) == 0U) {
        return 0U;
    }
    if (payload_size != 0U) {
        memcpy(destination + BTGA_NET_HEADER_SIZE, payload, payload_size);
    }
    endpoint->next_sequence += 1U;
    return packet_size;
}

BtgaNetPacketResult btga_net_endpoint_decode(BtgaNetEndpoint* endpoint,
                                             BtgaNetPacketView* view,
                                             const uint8_t* packet,
                                             size_t packet_size) {
    BtgaNetHeader header;
    BtgaNetReceiveResult receive_result;

    if (endpoint == NULL || view == NULL || packet == NULL ||
        !btga_net_decode_header(&header, packet, packet_size)) {
        return BTGA_NET_PACKET_INVALID;
    }
    if (header.session_id != endpoint->session_id) {
        return BTGA_NET_PACKET_WRONG_SESSION;
    }
    if (header.peer_id == endpoint->local_peer_id) {
        return BTGA_NET_PACKET_SELF;
    }
    receive_result = btga_net_receive_window_record(&endpoint->peers[header.peer_id],
                                                    header.sequence);
    if (receive_result == BTGA_NET_RECEIVE_DUPLICATE) {
        return BTGA_NET_PACKET_DUPLICATE;
    }
    if (receive_result == BTGA_NET_RECEIVE_TOO_OLD) {
        return BTGA_NET_PACKET_TOO_OLD;
    }
    view->header = header;
    view->payload = packet + BTGA_NET_HEADER_SIZE;
    view->payload_size = header.payload_size;
    return BTGA_NET_PACKET_NEW;
}
