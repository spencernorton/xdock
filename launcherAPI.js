// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Gio} from './dependencies/gi.js';
import {DBusMenuUtils} from './imports.js';

const DBusMenu = await DBusMenuUtils.haveDBusMenu();

export class LauncherEntryRemoteModel {
    constructor() {
        this._entrySourceStacks = new Map();
        this._remoteMaps = new Map();

        this._launcher_entry_dbus_signal_id =
            Gio.DBus.session.signal_subscribe(null, // sender
                'com.canonical.Unity.LauncherEntry', // iface
                'Update', // member
                null, // path
                null, // arg0
                Gio.DBusSignalFlags.NONE,
                (_connection, senderName, _objectPath, _interfaceName, _signalName, parameters) =>
                    this._onUpdate(senderName, ...parameters.deep_unpack()));

        this._dbus_name_owner_changed_signal_id = 0;

        this._acquireUnityDBus();
    }

    _ensureNameOwnerWatch() {
        if (this._dbus_name_owner_changed_signal_id)
            return;
        this._dbus_name_owner_changed_signal_id =
            Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',  // sender
                'org.freedesktop.DBus',  // interface
                'NameOwnerChanged',      // member
                '/org/freedesktop/DBus', // path
                null,                    // arg0
                Gio.DBusSignalFlags.NONE,
                (_connection, _senderName, _objectPath, _interfaceName, _signalName, parameters) =>
                    this._onDBusNameChange(...parameters.deep_unpack().slice(1)));
    }

    _clearNameOwnerWatch() {
        if (!this._dbus_name_owner_changed_signal_id)
            return;
        Gio.DBus.session.signal_unsubscribe(this._dbus_name_owner_changed_signal_id);
        this._dbus_name_owner_changed_signal_id = 0;
    }

    destroy() {
        if (this._launcher_entry_dbus_signal_id)
            Gio.DBus.session.signal_unsubscribe(this._launcher_entry_dbus_signal_id);

        this._clearNameOwnerWatch();


        // Drop the per-app quicklist DBusMenu.Client proxies and their
        // root-changed handlers. DockManager recreates this whole model on
        // every DND toggle, so undisposed clients would pile up between GCs.
        for (const remoteMap of this._remoteMaps.values()) {
            for (const remote of remoteMap.values())
                this._disposeQuicklistClient(remote);
        }
        this._remoteMaps.clear();

        this._releaseUnityDBus();
    }

    _disposeQuicklistClient(remote) {
        const menuClient = remote?._quicklistMenuClient;
        if (!menuClient)
            return;
        if (menuClient._rootChangedHandlerId) {
            menuClient.disconnect(menuClient._rootChangedHandlerId);
            menuClient._rootChangedHandlerId = 0;
        }
        remote._quicklistMenuClient = null;
    }

    _lookupStackById(appId) {
        let sourceStack = this._entrySourceStacks.get(appId);
        if (!sourceStack) {
            sourceStack = new PropertySourceStack(new LauncherEntry(),
                launcherEntryDefaults);
            this._entrySourceStacks.set(appId, sourceStack);
        }

        return sourceStack;
    }

    lookupById(appId) {
        return this._lookupStackById(appId).target;
    }

    _acquireUnityDBus() {
        if (!this._unity_bus_id) {
            this._unity_bus_id = Gio.DBus.session.own_name('com.canonical.Unity',
                Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                null, () => (this._unity_bus_id = 0));
        }
    }

    _releaseUnityDBus() {
        if (this._unity_bus_id) {
            Gio.DBus.session.unown_name(this._unity_bus_id);
            this._unity_bus_id = 0;
        }
    }

    _onDBusNameChange(before, after) {
        if (!before || !this._remoteMaps.size)
            return;

        const remoteMap = this._remoteMaps.get(before);
        if (!remoteMap)
            return;

        this._remoteMaps.delete(before);
        if (after && !this._remoteMaps.has(after)) {
            this._remoteMaps.set(after, remoteMap);
            // D-Bus client endpoints are construct-only. A replacement owner
            // must advertise a fresh quicklist before it can become visible.
            for (const [appId, remote] of remoteMap) {
                this._disposeQuicklistClient(remote);
                if (remote.quicklist === null)
                    continue;

                remote.quicklist = null;
                const sourceStack = this._entrySourceStacks.get(appId);
                if (sourceStack?.isTop(remote)) {
                    sourceStack.target.quicklist = null;
                    sourceStack.target._emitChangedEvents(['quicklist']);
                }
            }
        } else {
            for (const [appId, remote] of remoteMap) {
                const sourceStack = this._entrySourceStacks.get(appId);
                const changed = sourceStack.remove(remote);
                if (changed)
                    sourceStack.target._emitChangedEvents(changed);
                this._disposeQuicklistClient(remote);
                if (sourceStack.isEmpty && !sourceStack.target.hasListeners)
                    this._entrySourceStacks.delete(appId);
            }
        }
        if (!this._remoteMaps.size)
            this._clearNameOwnerWatch();
    }

    _onUpdate(senderName, appUri, properties) {
        if (!senderName)
            return;


        const appId = appUri.replace(/(^\w+:|^)\/\//, '');
        if (!appId)
            return;


        let remoteMap = this._remoteMaps.get(senderName);
        if (!remoteMap) {
            this._remoteMaps.set(senderName, remoteMap = new Map());
            this._ensureNameOwnerWatch();
        }

        let remote = remoteMap.get(appId);
        if (!remote)
            remoteMap.set(appId, remote = Object.assign({}, launcherEntryDefaults));

        for (const name in properties) {
            if (name === 'quicklist' && DBusMenu) {
                const quicklistPath = properties[name].unpack();
                if (quicklistPath &&
                    (!remote._quicklistMenuClient ||
                     remote._quicklistMenuClient.dbus_name !== senderName ||
                     remote._quicklistMenuClient.dbus_object !== quicklistPath)) {
                    remote.quicklist = null;
                    // Both endpoint properties are construct-only, so a name
                    // or path change needs a fresh client (issue #2).
                    this._disposeQuicklistClient(remote);
                    let menuClient;
                    // This property should not be enumerable
                    Object.defineProperty(remote, '_quicklistMenuClient', {
                        writable: true,
                        value: menuClient = new DBusMenu.Client({
                            dbus_name: senderName,
                            dbus_object: quicklistPath,
                        }),
                    });
                    const handler = () => {
                        const root = menuClient.get_root();
                        if (remote.quicklist !== root) {
                            remote.quicklist = root;
                            if (sourceStack.isTop(remote)) {
                                sourceStack.target.quicklist = root;
                                sourceStack.target._emitChangedEvents(['quicklist']);
                            }
                        }
                    };
                    menuClient._rootChangedHandlerId =
                        menuClient.connect(DBusMenu.CLIENT_SIGNAL_ROOT_CHANGED, handler);
                }
            } else {
                remote[name] = properties[name].unpack();
            }
        }

        const sourceStack = this._lookupStackById(appId);
        sourceStack.target._emitChangedEvents(sourceStack.update(remote));
    }
}

const launcherEntryDefaults = Object.freeze({
    count: 0,
    progress: 0,
    urgent: false,
    updating: false,
    quicklist: null,
    'count-visible': false,
    'progress-visible': false,
});

const LauncherEntry = class XDockLauncherEntry {
    constructor() {
        this._connections = new Map();
        this._handlers = new Map();
        this._nextId = 0;
    }

    connect(eventNames, callback) {
        if (typeof eventNames === 'string')
            eventNames = [eventNames];

        callback(this, this);
        const id = this._nextId++;
        const handler = {id, callback};
        eventNames.forEach(name => {
            let handlerList = this._handlers.get(name);
            if (!handlerList)
                this._handlers.set(name, handlerList = []);

            handlerList.push(handler);
        });
        this._connections.set(id, eventNames);
        return id;
    }

    disconnect(id) {
        const eventNames = this._connections.get(id);
        if (!eventNames)
            return;

        this._connections.delete(id);
        eventNames.forEach(name => {
            const handlerList = this._handlers.get(name);
            if (handlerList) {
                for (let i = 0, iMax = handlerList.length; i < iMax; i++) {
                    if (handlerList[i].id === id) {
                        handlerList.splice(i, 1);
                        break;
                    }
                }
            }
        });
    }

    get hasListeners() {
        return this._connections.size > 0;
    }

    _emitChangedEvents(propertyNames) {
        const handlers = new Set();
        propertyNames.forEach(name => {
            const handlerList = this._handlers.get(`${name}-changed`);
            if (handlerList) {
                for (let i = 0, iMax = handlerList.length; i < iMax; i++)
                    handlers.add(handlerList[i]);
            }
        });
        Array.from(handlers).sort((x, y) => x.id - y.id).forEach(handler => handler.callback(this, this));
    }
};

for (const [name, defaultValue] of Object.entries(launcherEntryDefaults)) {
    const jsName = name.replaceAll('-', '_');
    LauncherEntry.prototype[jsName] = defaultValue;
    if (jsName !== name) {
        Object.defineProperty(LauncherEntry.prototype, name, {
            get() {
                return this[jsName];
            },
            set(value) {
                this[jsName] = value;
            },
        });
    }
}

const PropertySourceStack = class XDockPropertySourceStack {
    constructor(target, bottom) {
        this.target = target;
        this._bottom = bottom;
        this._stack = [];
    }

    get isEmpty() {
        return this._stack.length === 0;
    }

    isTop(source) {
        return this._stack.length > 0 && this._stack[this._stack.length - 1] === source;
    }

    update(source) {
        if (!this.isTop(source)) {
            this.remove(source);
            this._stack.push(source);
        }
        return this._assignFrom(source);
    }

    remove(source) {
        const stack = this._stack;
        const top = stack[stack.length - 1];
        if (top === source) {
            stack.length--;
            return this._assignFrom(stack.length > 0 ? stack[stack.length - 1] : this._bottom);
        }
        for (let i = 0, iMax = stack.length; i < iMax; i++) {
            if (stack[i] === source) {
                stack.splice(i, 1);
                break;
            }
        }

        return null;
    }

    _assignFrom(source) {
        const changedProperties = [];
        for (const name in source) {
            if (this.target[name] !== source[name]) {
                this.target[name] = source[name];
                changedProperties.push(name);
            }
        }
        return changedProperties;
    }
};
