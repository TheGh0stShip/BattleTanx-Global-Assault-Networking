#include "btga/btga_delivery.h"

#include <stdint.h>
#include <stdio.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #condition); \
        return 1; \
    } \
} while (0)

static int test_acknowledgments(void) {
    BtgaNetSendQueue queue;
    BtgaNetDelivery delivered[2];
    btga_net_send_queue_init(&queue);
    CHECK(btga_net_send_queue_track(&queue, 100U, 1000U, 10U));
    CHECK(btga_net_send_queue_track(&queue, 101U, 1001U, 11U));
    CHECK(btga_net_send_queue_track(&queue, 103U, 1002U, 13U));
    CHECK(!btga_net_send_queue_track(&queue, 101U, 1003U, 99U));
    CHECK(queue.active_count == 3U);
    CHECK(btga_net_send_queue_acknowledge(&queue, 103U, UINT32_C(0x00000005),
                                          delivered, 2U) == 2U);
    CHECK(delivered[0].sequence == 100U && delivered[0].user_tag == 10U);
    CHECK(delivered[1].sequence == 103U && delivered[1].user_tag == 13U);
    CHECK(queue.active_count == 1U);
    CHECK(btga_net_send_queue_acknowledge(&queue, 101U, 0U,
                                          delivered, 2U) == 1U);
    CHECK(delivered[0].user_tag == 11U && queue.active_count == 0U);
    return 0;
}

static int test_retry_and_expiry(void) {
    BtgaNetSendQueue queue;
    BtgaNetDelivery delivery;
    btga_net_send_queue_init(&queue);
    CHECK(btga_net_send_queue_track(&queue, UINT32_MAX, 1000U, 77U));
    CHECK(btga_net_send_queue_poll(&queue, 1099U, 100U, 3U, &delivery) ==
          BTGA_NET_RETRY_NONE);
    CHECK(btga_net_send_queue_poll(&queue, 1100U, 100U, 3U, &delivery) ==
          BTGA_NET_RETRY_READY);
    CHECK(delivery.sequence == UINT32_MAX && delivery.user_tag == 77U &&
          delivery.attempts == 2U);
    CHECK(btga_net_send_queue_poll(&queue, 1200U, 100U, 3U, &delivery) ==
          BTGA_NET_RETRY_READY);
    CHECK(delivery.attempts == 3U);
    CHECK(btga_net_send_queue_poll(&queue, 1300U, 100U, 3U, &delivery) ==
          BTGA_NET_RETRY_EXPIRED);
    CHECK(delivery.attempts == 3U && queue.active_count == 0U);
    CHECK(btga_net_send_queue_track(&queue, 0U, 5000U, 1U));
    CHECK(btga_net_send_queue_poll(&queue, 4000U, 100U, 3U, &delivery) ==
          BTGA_NET_RETRY_NONE);
    return 0;
}

static int test_capacity(void) {
    BtgaNetSendQueue queue;
    uint32_t index;
    btga_net_send_queue_init(&queue);
    for (index = 0U; index < BTGA_NET_SEND_WINDOW_CAPACITY; ++index) {
        CHECK(btga_net_send_queue_track(&queue, index, 0U, index + 100U));
    }
    CHECK(!btga_net_send_queue_track(&queue, 100U, 0U, 0U));
    CHECK(queue.active_count == BTGA_NET_SEND_WINDOW_CAPACITY);
    return 0;
}

int main(void) {
    CHECK(test_acknowledgments() == 0);
    CHECK(test_retry_and_expiry() == 0);
    CHECK(test_capacity() == 0);
    return 0;
}
