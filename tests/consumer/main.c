#include <btga/btga_net.h>
#include <btga/btga_reliability.h>

#include <stdint.h>

int main(void) {
    BtgaNetReceiveWindow window;
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

    btga_net_receive_window_init(&window);
    return btga_net_encode_header(packet, sizeof(packet), &header) ==
                   BTGA_NET_HEADER_SIZE &&
               btga_net_receive_window_record(&window, 1U) == BTGA_NET_RECEIVE_NEW
           ? 0
           : 1;
}
