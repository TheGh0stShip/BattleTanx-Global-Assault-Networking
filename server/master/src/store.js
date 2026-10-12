"use strict";

const { TableClient } = require("@azure/data-tables");

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
        const entity = { ...source, id: source.rowKey };
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
        await this.table.upsertEntity(entity, "Replace");
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

module.exports = { AzureLobbyStore };
