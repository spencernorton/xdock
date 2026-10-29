import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Run the shipped async method, controlling only GIO completion/cancellation.
// In particular a successful operation may already be queued when cancelled.
const source = readFileSync(new URL('../locations.js', import.meta.url), 'utf8');
const begin = source.indexOf('    async _updateTrash() {');
const method = source.slice(begin, source.indexOf('\n    launchAction(', begin));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const error = code => ({matches: (_domain, other) => code === other});
const info = count => ({get_attribute_uint32: () => count});
function fixture() {
    const errors = [];
    class Cancellable {
        cancel() { this.cancelled = true; }
        is_cancelled() { return this.cancelled ?? false; }
    }
    const update = vm.runInNewContext(`({${method}})._updateTrash`, {
        GLib: {PRIORITY_LOW: 0},
        Gio: {IOErrorEnum: {CANCELLED: 1, NOT_SUPPORTED: 2}, FileQueryInfoFlags: {NONE: 0}},
        Utils: {CancellableChild: Cancellable},
        logError: e => errors.push(e),
    });
    const query = deferred();
    let enumerations = 0, closes = 0, fallbackCancellable;
    const enumerator = {
        next_files_async: async (_n, _priority, cancel) => {
            assert.equal(cancel.is_cancelled(), false);
            return [{}];
        },
        close_async: async () => closes++,
    };
    const location = {
        query_info_async: () => query.promise,
        enumerate_children_async: async (_attribute, _flags, _priority, cancel) => {
            fallbackCancellable = cancel;
            assert.equal(cancel.is_cancelled(), false);
            enumerations++;
            return enumerator;
        },
    };
    const writes = [];
    const app = {location, cancellable: new Cancellable(), set empty(value) { writes.push(value); }};
    return {
        app, query, location, enumerator, writes, errors,
        update: () => update.call(app),
        destroy: () => { app._updateTrashCancellable?.cancel(); app.cancellable.cancel(); app.location = null; },
        state: () => ({enumerations, closes, cancelled: fallbackCancellable?.is_cancelled()}),
    };
}

test('the active trash count updates its icon and releases the request', async () => {
    const f = fixture();
    const task = f.update();
    f.query.resolve(info(2));
    await task;
    assert.deepEqual(f.writes, [false]);
    assert.equal(f.app._updateTrashCancellable, undefined);
    assert.deepEqual(f.errors, []);
});

test('cancellation after destroy cannot fall through to enumeration', async () => {
    const f = fixture();
    const task = f.update();
    f.destroy();
    f.query.reject(error(1));
    await task;
    assert.deepEqual(f.errors, []);
    assert.equal(f.state().enumerations, 0);
    assert.deepEqual(f.writes, []);
});

test('a success already dispatched at destruction cannot update an old icon', async () => {
    const f = fixture();
    const task = f.update();
    f.destroy();
    f.query.resolve(info(0));
    await task;
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.errors, []);
});

test('an unsupported count falls back with a live request and closes its enumerator', async () => {
    const f = fixture();
    const task = f.update();
    f.query.reject(error(2));
    await task;
    assert.deepEqual(f.writes, [false]);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.state(), {enumerations: 1, closes: 1, cancelled: true});
});

test('cancelling a fallback still closes the acquired enumerator', async () => {
    const f = fixture();
    const next = deferred();
    f.enumerator.next_files_async = () => next.promise;
    const task = f.update();
    f.query.reject(error(2));
    await new Promise(resolve => setImmediate(resolve));
    f.destroy();
    next.reject(error(1));
    await task;
    assert.equal(f.state().closes, 1);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.writes, []);
});

test('a dispatched timer after teardown cannot start another request', async () => {
    const f = fixture();
    f.destroy();
    await f.update();
    assert.equal(f.app._updateTrashCancellable, undefined);
    assert.deepEqual(f.errors, []);
});
