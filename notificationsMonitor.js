// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Gio, GLib} from './dependencies/gi.js';
import {Main} from './dependencies/shell/ui.js';

import {
    Docking,
    Utils,
} from './imports.js';

const {signals: Signals} = imports;

const Labels = Object.freeze({
    SOURCES: Symbol('sources'),
    NOTIFICATIONS: Symbol('notifications'),
});
export class NotificationsMonitor {
    constructor() {
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        this._appNotifications = Object.create(null);
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        const getIsEnabled = () => !this.dndMode &&
            Docking.DockManager.settings.showIconsNotificationsCounter;

        this._dndMode = !this._settings.get_boolean('show-banners');
        this._isEnabled = getIsEnabled();
        const checkIsEnabled = () => {
            const isEnabled = getIsEnabled();
            if (isEnabled !== this._isEnabled) {
                this._isEnabled = isEnabled;
                this._updateState();
                this.emit('state-changed');
                return true;
            }
            return false;
        };

        this._signalsHandler.add(this._settings, 'changed::show-banners', () => {
            this._dndMode = !this._settings.get_boolean('show-banners');
            if (!checkIsEnabled())
                this.emit('state-changed');
        });
        this._signalsHandler.add(Docking.DockManager.settings,
            'changed::show-icons-notifications-counter', checkIsEnabled);

        this._updateState();
    }

    destroy() {
        if (this._checkNotificationsId) {
            GLib.source_remove(this._checkNotificationsId);
            this._checkNotificationsId = 0;
        }
        this.emit('destroy');
        this._signalsHandler?.destroy();
        this._signalsHandler = null;
        this._appNotifications = null;
        this._settings = null;
    }

    get enabled() {
        return this._isEnabled;
    }

    get dndMode() {
        return this._dndMode;
    }

    getAppNotificationsCount(appId) {
        return this._appNotifications[appId] ?? 0;
    }

    _updateState() {
        if (this.enabled) {
            this._signalsHandler.addWithLabel(Labels.SOURCES, Main.messageTray,
                'source-added', () => this._queueCheckNotifications());
            this._signalsHandler.addWithLabel(Labels.SOURCES, Main.messageTray,
                'source-removed', () => this._queueCheckNotifications());
        } else {
            this._signalsHandler.removeWithLabel(Labels.SOURCES);
        }

        this._checkNotifications();
    }

    _queueCheckNotifications() {
        // Coalesce bursts: routing every source/notification signal straight to
        // _checkNotifications() rebuilds all connections + recounts on each event
        // (O(N) per event, O(N^2) over a burst). One idle-batched rebuild per
        // frame keeps it O(N).
        if (this._checkNotificationsId)
            return;
        this._checkNotificationsId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._checkNotificationsId = 0;
            this._checkNotifications();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkNotifications() {
        this._appNotifications = Object.create(null);
        this._signalsHandler.removeWithLabel(Labels.NOTIFICATIONS);

        if (this.enabled) {
            Main.messageTray.getSources().forEach(source => {
                this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS, source,
                    'notification-added', () => this._queueCheckNotifications());
                // GlobalSignalsHandler removes every connection to an object
                // synchronously from its destroy handler, before GObject dispose.
                this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS, source,
                    'destroy', () => this._queueCheckNotifications());

                source.notifications.forEach(notification => {
                    const app = notification.source?.app ?? notification.source?._app;
                    const appId = app?.id ?? app?._appId;

                    if (appId) {
                        if (notification.resident) {
                            if (notification.acknowledged)
                                return;

                            this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS,
                                notification, 'notify::acknowledged',
                                () => this._queueCheckNotifications());
                        }

                        this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS,
                            notification, 'destroy', () => this._queueCheckNotifications());

                        this._appNotifications[appId] =
                            (this._appNotifications[appId] ?? 0) + 1;
                    }
                });
            });
        }

        this.emit('changed');
    }
}

Signals.addSignalMethods(NotificationsMonitor.prototype);
