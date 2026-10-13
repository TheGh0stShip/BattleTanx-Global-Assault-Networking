"use strict";

const { TableClient, odata } = require("@azure/data-tables");
const { validEtag } = require("./core");

class AzureLobbyStore {
    constructor(table) {
        this.table = table;
    }

    static async connect(connectionString, tableName) {
        const table = TableClient.fromConnectionString(connectionString, tableName);
        try {
            await table.createTable();
        } catch (error) {
            if (error.statusCode !== 409) {
                throw error;
            }
        }
        return new AzureLobbyStore(table);
    }

    static fromEntity(source) {
        const entity = { ...source, id: source.rowKey, _etag: source.etag };
        delete entity.partitionKey;
        delete entity.rowKey;
        delete entity.timestamp;
        delete entity.etag;
        entity.capabilities = Number(entity.capabilities);
        return entity;
    }

    async put(lobby) {
        const entity = {
            ...lobby,
            capabilities: String(lobby.capabilities),
            partitionKey: "lobbies",
            rowKey: lobby.id
        };
        delete entity.id;
        delete entity._etag;
        await this.table.upsertEntity(entity, "Replace");
    }

    async compareAndSwap(lobby, etag) {
        if (!validEtag(etag)) return false;
        const entity = {
            ...lobby,
            capabilities: String(lobby.capabilities),
            partitionKey: "lobbies",
            rowKey: lobby.id
        };
        delete entity.id;
        delete entity._etag;
        try {
            await this.table.updateEntity(entity, "Replace", { etag });
            return true;
        } catch (error) {
            if (error.statusCode === 409 || error.statusCode === 412) return false;
            throw error;
        }
    }

    async get(lobbyId) {
        try {
            return AzureLobbyStore.fromEntity(await this.table.getEntity("lobbies", lobbyId));
        } catch (error) {
            if (error.statusCode === 404) {
                return null;
            }
            throw error;
        }
    }

    async delete(lobbyId) {
        try {
            await this.table.deleteEntity("lobbies", lobbyId);
        } catch (error) {
            if (error.statusCode !== 404) {
                throw error;
            }
        }
    }

    async list() {
        const result = [];
        for await (const entity of this.table.listEntities({
            queryOptions: { filter: "PartitionKey eq 'lobbies'" }
        })) {
            result.push(AzureLobbyStore.fromEntity(entity));
        }
        return result;
    }
}

// Both columns are written as explicit Edm.Double. Millisecond timestamps
// exceed Int32, and an unannotated JSON integer would otherwise be typed by
// the service, which would make the idle-purge filter compare mixed types.
function bucketColumns(state) {
    return {
        tokens: { value: String(state.tokens), type: "Double" },
        updated: { value: String(state.updated), type: "Double" }
    };
}

// Rate-limit buckets: PartitionKey = scope, RowKey = 4-hex-digit shard. Row
// count is bounded by scopes x shards (see ratelimit.js).
class AzureRateLimitStore {
    constructor(table) {
        this.table = table;
    }

    static async connect(connectionString, tableName) {
        const table = TableClient.fromConnectionString(connectionString, tableName);
        try {
            await table.createTable();
        } catch (error) {
            if (error.statusCode !== 409) throw error;
        }
        return new AzureRateLimitStore(table);
    }

    async get(partition, row) {
        try {
            const entity = await this.table.getEntity(partition, row);
            return { tokens: Number(entity.tokens), updated: Number(entity.updated), etag: entity.etag };
        } catch (error) {
            if (error.statusCode === 404) return null;
            throw error;
        }
    }

    async create(partition, row, state) {
        try {
            await this.table.createEntity({
                partitionKey: partition, rowKey: row, ...bucketColumns(state)
            });
            return true;
        } catch (error) {
            if (error.statusCode === 409) return false;
            throw error;
        }
    }

    async replace(partition, row, state, etag) {
        if (!validEtag(etag)) return false;
        try {
            await this.table.updateEntity({
                partitionKey: partition, rowKey: row, ...bucketColumns(state)
            }, "Replace", { etag });
            return true;
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 409 ||
                error.statusCode === 412) return false;
            throw error;
        }
    }

    // Deletes up to `limit` rows idle since before `olderThanMs`. Deletion is
    // conditional on the ETag read, so a row refreshed meanwhile survives.
    async purgeIdle(partition, olderThanMs, limit) {
        let removed = 0;
        const rows = this.table.listEntities({
            queryOptions: {
                filter: `${odata`PartitionKey eq ${partition}`} and updated lt ${Number(olderThanMs).toFixed(1)}`,
                select: ["PartitionKey", "RowKey"]
            }
        });
        for await (const entity of rows) {
            if (removed >= limit) break;
            try {
                await this.table.deleteEntity(partition, entity.rowKey, { etag: entity.etag });
                removed += 1;
            } catch (error) {
                if (error.statusCode !== 404 && error.statusCode !== 412) throw error;
            }
        }
        return removed;
    }
}

module.exports = { AzureLobbyStore, AzureRateLimitStore };
