#include "btga/btga_delivery.h"

#include "btga/btga_reliability.h"

#include <stddef.h>

void btga_net_send_queue_init(BtgaNetSendQueue* queue) {
    size_t index;
    if (queue == NULL) return;
    queue->active_count = 0U;
    for (index = 0U; index < BTGA_NET_SEND_WINDOW_CAPACITY; ++index) {
        queue->slots[index].sent_at_ms = 0U;
        queue->slots[index].sequence = 0U;
        queue->slots[index].user_tag = 0U;
        queue->slots[index].attempts = 0U;
        queue->slots[index].active = 0U;
    }
}

int btga_net_send_queue_track(BtgaNetSendQueue* queue, uint32_t sequence,
                              uint64_t sent_at_ms, uint32_t user_tag) {
    size_t index;
    BtgaNetSendSlot* free_slot = NULL;
    if (queue == NULL || queue->active_count >= BTGA_NET_SEND_WINDOW_CAPACITY) return 0;
    for (index = 0U; index < BTGA_NET_SEND_WINDOW_CAPACITY; ++index) {
        BtgaNetSendSlot* slot = &queue->slots[index];
        if (slot->active != 0U && slot->sequence == sequence) return 0;
        if (slot->active == 0U && free_slot == NULL) free_slot = slot;
    }
    if (free_slot == NULL) return 0;
    free_slot->sent_at_ms = sent_at_ms;
    free_slot->sequence = sequence;
    free_slot->user_tag = user_tag;
    free_slot->attempts = 1U;
    free_slot->active = 1U;
    queue->active_count += 1U;
    return 1;
}

size_t btga_net_send_queue_acknowledge(BtgaNetSendQueue* queue,
                                       uint32_t acknowledgment,
                                       uint32_t acknowledgment_bits,
                                       BtgaNetDelivery* deliveries,
                                       size_t delivery_capacity) {
    size_t index;
    size_t delivered = 0U;
    if (queue == NULL || deliveries == NULL || delivery_capacity == 0U) return 0U;
    for (index = 0U; index < BTGA_NET_SEND_WINDOW_CAPACITY &&
                     delivered < delivery_capacity; ++index) {
        BtgaNetSendSlot* slot = &queue->slots[index];
        if (slot->active != 0U &&
            btga_net_sequence_is_acknowledged(slot->sequence, acknowledgment,
                                              acknowledgment_bits)) {
            deliveries[delivered].sequence = slot->sequence;
            deliveries[delivered].user_tag = slot->user_tag;
            deliveries[delivered].attempts = slot->attempts;
            delivered += 1U;
            slot->active = 0U;
            queue->active_count -= 1U;
        }
    }
    return delivered;
}

BtgaNetRetryResult btga_net_send_queue_poll(BtgaNetSendQueue* queue,
                                            uint64_t now_ms,
                                            uint64_t retry_interval_ms,
                                            uint16_t max_attempts,
                                            BtgaNetDelivery* delivery) {
    size_t index;
    if (queue == NULL || delivery == NULL || retry_interval_ms == 0U ||
        max_attempts == 0U) return BTGA_NET_RETRY_NONE;
    for (index = 0U; index < BTGA_NET_SEND_WINDOW_CAPACITY; ++index) {
        BtgaNetSendSlot* slot = &queue->slots[index];
        if (slot->active == 0U || now_ms < slot->sent_at_ms ||
            now_ms - slot->sent_at_ms < retry_interval_ms) continue;
        delivery->sequence = slot->sequence;
        delivery->user_tag = slot->user_tag;
        delivery->attempts = slot->attempts;
        if (slot->attempts >= max_attempts) {
            slot->active = 0U;
            queue->active_count -= 1U;
            return BTGA_NET_RETRY_EXPIRED;
        }
        slot->sent_at_ms = now_ms;
        slot->attempts += 1U;
        delivery->attempts = slot->attempts;
        return BTGA_NET_RETRY_READY;
    }
    return BTGA_NET_RETRY_NONE;
}
