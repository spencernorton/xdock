import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the production client with a controlled GIO completion queue. A
// completed async operation can dispatch success after cancellation; the
// transport stub lets that race happen deterministically, including reentry
// from cancel(). No copy of the client's lifecycle logic lives in this test.
function fixture() {
    const ready = [];
    const idles = new Map();
    let reads = 0;
    let cancellations = 0;
    let disconnects = 0;
    let onCancel = null;
    const context = {
        imports: {signals: {addSignalMethods: prototype => {
            prototype.emit = () => {};
        }}},
        global: {workspaceManager: {}, display: {}},
        GLib: {
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            idle_add: (_priority, callback) => {
                const id = idles.size + 1;
                idles.set(id, callback);
                return id;
            },
            source_remove: id => idles.delete(id),
        },
        Gio: {
            DBus: {session: {}}, IOErrorEnum: {CANCELLED: 1},
            Cancellable: class {
                cancel() { cancellations++; onCancel?.(); }
            },
            DBusProxy: {makeProxyWrapper: () => class {
                constructor(_bus, _name, _path, callback) { ready.push(() => callback(this, null)); }
                get_cached_property_names() { return []; }
            }},
        },
        Utils: {
            GlobalSignalsHandler: class {
                add() {}
                destroy() { disconnects++; }
            },
            getWindowsByObjectPath: () => { reads++; return new Map(); },
        },
        logError: error => { throw error; },
    };
    const source = readFileSync(new URL('../fileManager1API.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export class FileManager1Client', 'class FileManager1Client');
    vm.runInNewContext(`${source}\nglobalThis.Client = FileManager1Client;`, context);
    return {
        client: new context.Client(), ready, idles,
        onCancel: callback => (onCancel = callback),
        state: () => ({reads, cancellations, disconnects}),
    };
}

test('an active proxy completion still updates the window map', () => {
    const f = fixture();
    f.ready.shift()();
    assert.equal(f.state().reads, 1);
    f.client.destroy();
});

test('success dispatched after destroy cannot touch the cleared proxy', () => {
    const f = fixture();
    f.client.destroy();
    assert.doesNotThrow(() => f.ready.shift()());
    assert.equal(f.state().reads, 0);
    f.client.destroy();
    assert.deepEqual(f.state(), {reads: 0, cancellations: 1, disconnects: 1});
});

test('a reentrant completion during cancellation observes teardown first', () => {
    const f = fixture();
    f.onCancel(f.ready.shift());
    assert.doesNotThrow(() => f.client.destroy());
    assert.equal(f.state().reads, 0);
});

test('an already dispatched window idle cannot restart a destroyed client', () => {
    const f = fixture();
    f.client._onWindowsChanged();
    const dispatched = [...f.idles.values()][0];
    f.client.destroy();
    dispatched();
    f.client._onWindowsChanged();
    assert.equal(f.idles.size, 0);
    assert.equal(f.state().reads, 0);
});
