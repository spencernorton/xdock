import {GLib, St} from './dependencies/gi.js';
import {DeferredTask} from './lifecycle.js';
import {Utils} from './imports.js';

const MAILBOX_APPS = new Set([
    'dev.norvi.PenguinMail.desktop',
    'io.github.c9dev.PenguinMail.desktop',
    'io.github.c9dev.penguin-mail.desktop',
]);

export function isMailboxApp(id) {
    return MAILBOX_APPS.has(id);
}

// Own one subscription to each watched app's LauncherEntry. Dock, launcher,
// and overview views all consume the same coalesced value for that app.
export class AppBadgeCounts {
    constructor(settings, notifications) {
        this._settings = settings;
        this._notifications = notifications;
        this._remoteModel = null;
        this._apps = new Map();
        this._dirty = new Set();
        this._task = new DeferredTask(
            callback => GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, callback),
            id => GLib.source_remove(id));
        this._signals = new Utils.GlobalSignalsHandler();
        const refresh = () => this._refreshAll();
        this._signals.add(
            [notifications, 'changed', refresh],
            [notifications, 'state-changed', refresh],
            [St.Settings.get(), 'notify::high-contrast', refresh],
            [settings, 'changed::show-icons-emblems', refresh],
            [settings, 'changed::notification-badge-style', refresh],
            [settings, 'changed::application-counter-overrides-notifications', refresh]);
    }

    setRemoteModel(model) {
        if (model === this._remoteModel)
            return;

        this._remoteModel = model;
        for (const [id, app] of this._apps)
            this._connectRemote(id, app);
        this._refreshAll();
    }

    subscribe(id, callback) {
        const style = this._readStyle();
        let app = this._apps.get(id);
        if (!app) {
            app = {listeners: new Set(), remote: null, remoteId: null, count: 0, style};
            this._apps.set(id, app);
            this._connectRemote(id, app);
            app.count = this._readCount(id, app);
        }
        app.listeners.add(callback);
        // Take the current snapshot when mapping, even if a burst is pending.
        callback(this._readCount(id, app), false, style);
        return () => {
            app.listeners.delete(callback);
            if (!app.listeners.size && this._apps.get(id) === app) {
                this._disconnectRemote(app);
                this._apps.delete(id);
                this._dirty.delete(id);
            }
        };
    }

    _connectRemote(id, app) {
        this._disconnectRemote(app);
        app.remote = this._remoteModel?.lookupById(id);
        app.remoteId = app.remote?.connect(['count-changed', 'count-visible-changed'],
            () => this._queue(id));
    }

    _disconnectRemote(app) {
        app.remote?.disconnect(app.remoteId);
        app.remote = null;
    }

    _readCount(id, {remote}) {
        if (!this._settings.showIconsEmblems || this._notifications.dndMode)
            return 0;

        const advertised = remote?.count;
        const remoteCount = remote?.count_visible && Number.isSafeInteger(advertised) && advertised > 0
            ? advertised : 0;
        // Mailbox publishes All Inboxes, including zero. Its notification
        // cards are delivery notices and can outlive the app or unread mail.
        if (isMailboxApp(id) || (remoteCount > 0 && this._settings.applicationCounterOverridesNotifications))
            return remoteCount;

        return remoteCount + this._notifications.getAppNotificationsCount(id);
    }

    _readStyle() {
        return St.Settings.get().high_contrast
            ? 'high-contrast'
            : this._settings.get_string('notification-badge-style');
    }

    _refreshAll() {
        for (const id of this._apps.keys())
            this._queue(id);
    }

    _queue(id) {
        this._dirty.add(id);
        this._task.schedule(() => {
            const dirty = this._dirty;
            this._dirty = new Set();
            const style = this._readStyle();
            const motionAllowed = !this._notifications.dndMode && this._settings.showIconsEmblems;
            for (const appId of dirty) {
                const app = this._apps.get(appId);
                if (!app)
                    continue;

                const count = this._readCount(appId, app);
                const countChanged = count !== app.count;
                if (!countChanged && style === app.style)
                    continue;

                app.count = count;
                app.style = style;
                for (const listener of app.listeners)
                    listener(count, countChanged && motionAllowed, style);
            }
        });
    }

    destroy() {
        this._task.deactivate();
        this._signals.destroy();
        for (const app of this._apps.values())
            this._disconnectRemote(app);
        this._apps.clear();
        this._dirty.clear();
    }
}
