"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PublicReadCache } = require("../src/public_cache");

test("concurrent public reads share one in-flight load and cache its value", async () => {
    let now = 1000;
    let loads = 0;
    const cache = new PublicReadCache({ ttlMs: 2000, clock: () => now });
    const load = async () => {
        loads += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return { generation: loads };
    };
    const values = await Promise.all(Array.from({ length: 100 }, () => cache.get("status", load)));
    assert.equal(loads, 1);
    assert.ok(values.every((value) => value === values[0]));
    assert.equal((await cache.get("status", load)).generation, 1);
    now += 2001;
    assert.equal((await cache.get("status", load)).generation, 2);
});

test("failed loads are never cached", async () => {
    const cache = new PublicReadCache();
    await assert.rejects(cache.get("status", async () => { throw new Error("storage down"); }));
    assert.equal(await cache.get("status", async () => "recovered"), "recovered");
});

test("cache cardinality is bounded", async () => {
    const cache = new PublicReadCache({ maxEntries: 4 });
    for (let i = 0; i < 20; ++i) await cache.get(`build-${i}`, async () => i);
    assert.equal(cache.entries.size, 4);
});
