#include <btga/btga_net.h>
#include <btga/btga_handshake.h>
#include <btga/btga_reliability.h>
#include <btga/btga_transport.h>

#include <stdint.h>

int main(void) {
    BtgaNetReceiveWindow window;
    BtgaNetEndpoint endpoint;
    BtgaNetWelcome welcome = {{0}, 0U, 4U, 30U, 0U};
    BtgaNetHeader header = {
        BTGA_NET_PROTOCOL_VERSION,
        BTGA_NET_MSG_PING,
        0U,
        UINT64_C(1),
        UINT32_C(1),
        0U,
        0U,
        0U,
        0U
    };
    uint8_t packet[BTGA_NET_HEADER_SIZE];
    uint8_t welcome_payload[BTGA_NET_WELCOME_SIZE];

    btga_net_receive_window_init(&window);
    return btga_net_encode_header(packet, sizeof(packet), &header) ==
                   BTGA_NET_HEADER_SIZE &&
               btga_net_endpoint_init(&endpoint, UINT64_C(1), 0U, 0U) &&
               btga_net_encode_welcome(welcome_payload, sizeof(welcome_payload),
                                       &welcome) == BTGA_NET_WELCOME_SIZE &&
               btga_net_receive_window_record(&window, 1U) == BTGA_NET_RECEIVE_NEW
           ? 0
           : 1;
}
