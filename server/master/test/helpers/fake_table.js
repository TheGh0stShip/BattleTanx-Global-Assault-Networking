"use strict";

// In-process stand-in for @azure/data-tables TableClient with the semantics
// the stores rely on: ETags, If-Match ("*" by default, as the SDK does),
// 404/409/412 status codes, Edm-annotated values, and the simple
// "PartitionKey eq '...' and updated lt N" filter used by the idle purge.
// `failing` makes every call throw a transient 503; `latencyMs` delays calls.

function statusError(statusCode) {
    return Object.assign(new Error(`table status ${statusCode}`), { statusCode });
}

function plain(value) {
    return value !== null && typeof value === "object" && "value" in value && "type" in value
        ? (value.type === "Double" || value.type === "Int32" ? Number(value.value) : value.value)
        : value;
}

class FakeTableClient {
    constructor() {
        this.rows = new Map();
        this.version = 0;
        this.failing = false;
        this.latencyMs = 0;
        this.calls = 0;
    }

    async step() {
        this.calls += 1;
        if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
        else await new Promise(setImmediate);
        if (this.failing) throw statusError(503);
    }

    key(partitionKey, rowKey) {
        return `${partitionKey}\u0000${rowKey}`;
    }

    store(entity) {
        const row = {};
        for (const [name, value] of Object.entries(entity)) row[name] = plain(value);
        row.etag = `W/"datetime'${++this.version}'"`;
        this.rows.set(this.key(entity.partitionKey, entity.rowKey), row);
    }

    async createTable() {
        await this.step();
    }

    async getEntity(partitionKey, rowKey) {
        await this.step();
        const row = this.rows.get(this.key(partitionKey, rowKey));
        if (row === undefined) throw statusError(404);
        return { ...row };
    }

    async createEntity(entity) {
        await this.step();
        if (this.rows.has(this.key(entity.partitionKey, entity.rowKey))) throw statusError(409);
        this.store(entity);
    }

    async upsertEntity(entity) {
        await this.step();
        this.store(entity);
    }

    async updateEntity(entity, mode, options = {}) {
        await this.step();
        const { etag = "*" } = options;
        const row = this.rows.get(this.key(entity.partitionKey, entity.rowKey));
        if (row === undefined) throw statusError(404);
        if (etag !== "*" && etag !== row.etag) throw statusError(412);
        this.store(entity);
    }

    async deleteEntity(partitionKey, rowKey, options = {}) {
        await this.step();
        const { etag = "*" } = options;
        const key = this.key(partitionKey, rowKey);
        const row = this.rows.get(key);
        if (row === undefined) throw statusError(404);
        if (etag !== "*" && etag !== row.etag) throw statusError(412);
        this.rows.delete(key);
    }

    async *listEntities(options = {}) {
        await this.step();
        const filter = (options.queryOptions && options.queryOptions.filter) || "";
        const partition = filter.match(/PartitionKey eq '([^']*)'/u);
        const updated = filter.match(/updated lt ([0-9.]+)/u);
        for (const row of [...this.rows.values()]) {
            if (partition && row.partitionKey !== partition[1]) continue;
            if (updated && !(row.updated < Number(updated[1]))) continue;
            yield { ...row };
        }
    }
}

module.exports = { FakeTableClient, statusError };
