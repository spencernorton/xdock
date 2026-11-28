// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,

    // Use __ () and N__() for the extension gettext domain, and reuse
    // the shell domain with the default _() and N_()
    gettext as __,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCALE_UPDATE_TIMEOUT = 500;
const DEFAULT_ICONS_SIZES = [128, 96, 64, 48, 32, 24, 16];

const TransparencyMode = Object.freeze({
    DEFAULT: 0,
    FIXED: 1,
    DYNAMIC: 3,
});

const RunningIndicatorStyle = Object.freeze({
    DEFAULT: 0,
    DOTS: 1,
    SQUARES: 2,
    DASHES: 3,
    SEGMENTED: 4,
    SOLID: 5,
    CILIORA: 6,
    METRO: 7,
});

const MonitorsConfig = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class MonitorsConfig extends GObject.Object {
    static get XML_INTERFACE() {
        return '<node>\
            <interface name="org.gnome.Mutter.DisplayConfig">\
                <method name="GetCurrentState">\
                <arg name="serial" direction="out" type="u" />\
                <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />\
                <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />\
                <arg name="properties" direction="out" type="a{sv}" />\
                </method>\
                <signal name="MonitorsChanged" />\
            </interface>\
        </node>';
    }

    static get ProxyWrapper() {
        return Gio.DBusProxy.makeProxyWrapper(MonitorsConfig.XML_INTERFACE);
    }

    constructor() {
        super();

        this._monitorsConfigProxy = new MonitorsConfig.ProxyWrapper(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig'
        );

        // Connecting to a D-Bus signal
        this._monitorsConfigProxy.connectSignal('MonitorsChanged',
            () => this._updateResources());

        this._primaryMonitor = null;
        this._monitors = [];
        this._logicalMonitors = [];
        this._resourcesRequestGeneration = 0;

        this._updateResources();
    }

    _updateResources() {
        const requestGeneration = ++this._resourcesRequestGeneration;
        this._monitorsConfigProxy.GetCurrentStateRemote((resources, err) => {
            // MonitorsChanged can arrive faster than D-Bus replies. Ignore an
            // older snapshot rather than replacing newer monitor state with it.
            if (requestGeneration !== this._resourcesRequestGeneration)
                return;

            if (err) {
                logError(err);
                return;
            }

            // Reset before repopulating, otherwise entries pile up on every
            // hot-plug (MonitorsChanged fires repeatedly for a single change).
            this._monitors = [];
            this._primaryMonitor = null;

            const [serial_, monitors, logicalMonitors] = resources;
            let index = 0;
            for (const monitor of monitors) {
                const [monitorSpecs, modes_, props] = monitor;
                const [connector, vendor, product, serial] = monitorSpecs;
                this._monitors.push({
                    index: index++,
                    active: false,
                    connector, vendor, product, serial,
                    displayName: props['display-name'].unpack(),
                });
            }

            for (const logicalMonitor of logicalMonitors) {
                const [x_, y_, scale_, transform_, isPrimary, monitorsSpecs] =
                    logicalMonitor;

                // We only care about the first one really
                for (const monitorSpecs of monitorsSpecs) {
                    const [connector, vendor, product, serial] = monitorSpecs;
                    const monitor = this._monitors.find(m =>
                        m.connector === connector && m.vendor === vendor &&
                        m.product === product && m.serial === serial);

                    if (monitor) {
                        monitor.active = true;
                        monitor.isPrimary = isPrimary;
                        if (monitor.isPrimary)
                            this._primaryMonitor = monitor;
                        break;
                    }
                }
            }

            const activeMonitors = this._monitors.filter(m => m.active);
            if (activeMonitors.length > 1 && logicalMonitors.length === 1 &&
                this._primaryMonitor) {
                // We're in cloning mode, so let's just activate the primary monitor
                this._monitors.forEach(m => (m.active = false));
                this._primaryMonitor.active = true;
            }

            // Mutter can briefly report no primary monitor while displays are
            // being reconfigured or disconnected. Keep the transient snapshot
            // usable and wait for the next MonitorsChanged event to reindex it.
            if (this._primaryMonitor)
                this._updateMonitorsIndexes();
            this.emit('updated');
        });
    }

    _updateMonitorsIndexes() {
        // This function ensures that we follow the old Gdk indexing strategy
        // for monitors, it can be removed when we don't care about breaking
        // old user configurations or external apps configuring this extension
        // such as ubuntu's gnome-control-center.
        const {index: primaryMonitorIndex} = this._primaryMonitor;
        for (const monitor of this._monitors) {
            let {index} = monitor;
            // The The dock uses the Gdk index for monitors, where the primary monitor
            // always has index 0, so let's follow what xdock does in docking.js
            // (as part of _createDocks), but using inverted math
            index -= primaryMonitorIndex;

            if (index < 0)
                index += this._monitors.length;

            monitor.index = index;
        }
    }

    get primaryMonitor() {
        return this._primaryMonitor;
    }

    get monitors() {
        return this._monitors;
    }
});

/**
 * @param settings
 */
function setShortcut(settings) {
    const shortcutText = settings.get_string('shortcut-text');
    const [success, key, mods] = Gtk.accelerator_parse(shortcutText);

    if (success && Gtk.accelerator_valid(key, mods)) {
        const shortcut = Gtk.accelerator_name(key, mods);
        settings.set_strv('shortcut', [shortcut]);
    } else {
        settings.set_strv('shortcut', []);
    }
}

export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings('org.gnome.shell.extensions.xdock');
        this._appSwitcherSettings = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        this._rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;
        this._monitorsConfig = new MonitorsConfig();

        // Timeouts to delay the update of the settings
        this._dockSizeTimeoutId = 0;
        this._iconSizeTimeoutId = 0;
        this._pendingScaleSettingUpdates = new Map();

        window.set_default_size(-1, 850);
        window.connect('close-request', () => this._onWindowClosed());

        window.add(this._buildPositionAndSizePage());
        window.add(this._buildLaunchersPage());
        window.add(this._buildBehaviorPage());
        window.add(this._buildAppearancePage());
        window.add(this._buildAboutPage());
    }

    _onWindowClosed() {
        if (this._dockSizeTimeoutId)
            GLib.source_remove(this._dockSizeTimeoutId);

        if (this._iconSizeTimeoutId)
            GLib.source_remove(this._iconSizeTimeoutId);

        for (const {timeoutId, commit} of
            [...this._pendingScaleSettingUpdates.values()]) {
            GLib.source_remove(timeoutId);
            commit();
        }
    }

    // Adds a row to either a Adw.PreferencesGroup or an Adw.ExpanderRow,
    // whichever the caller passes in.
    _addRow(container, row) {
        if (container.add_row)
            container.add_row(row);
        else
            container.add(row);
        return row;
    }

    _switchRow(container, {title, subtitle, key, flags = Gio.SettingsBindFlags.DEFAULT}) {
        const params = {title};
        if (subtitle)
            params.subtitle = subtitle;
        const row = new Adw.SwitchRow(params);
        this._settings.bind(key, row, 'active', flags);
        return this._addRow(container, row);
    }

    // `values` maps combo index -> enum value, for non-contiguous enums
    // (e.g. transparency-mode). Omit it when index === enum value.
    _comboRow(container, {title, subtitle, key, labels, values}) {
        const params = {title, model: Gtk.StringList.new(labels)};
        if (subtitle)
            params.subtitle = subtitle;
        const row = new Adw.ComboRow(params);

        const valueToIndex = v => values ? values.indexOf(v) : v;
        const indexToValue = i => values ? values[i] : i;

        row.selected = valueToIndex(this._settings.get_enum(key));
        row.connect('notify::selected', () => {
            this._settings.set_enum(key, indexToValue(row.selected));
        });
        this._settings.connect(`changed::${key}`, () => {
            row.selected = valueToIndex(this._settings.get_enum(key));
        });

        return this._addRow(container, row);
    }

    _spinRow(container, {title, subtitle, key, lower = 0, upper, step, page, digits = 0}) {
        const params = {
            title,
            adjustment: new Gtk.Adjustment({
                lower, upper, step_increment: step, page_increment: page,
            }),
            digits,
        };
        if (subtitle)
            params.subtitle = subtitle;
        const row = new Adw.SpinRow(params);
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return this._addRow(container, row);
    }

    // Returns the bare Gtk.Scale (as an ActionRow suffix) so the caller can
    // wire up its own debounce/formatting, which differs per-scale. Setting
    // `digits` on it also sets `round_digits`, so it moves in the steps it
    // shows. Setting `round_digits` after that overrides it: at 0, a 0-1
    // scale can only land on its ends.
    _scaleRow(container, title, {lower, upper, step, page}) {
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower, upper, step_increment: step, page_increment: page,
            }),
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            value_pos: Gtk.PositionType.RIGHT,
        });
        const row = new Adw.ActionRow({title});
        row.add_suffix(scale);
        this._addRow(container, row);
        return scale;
    }

    _setDoubleAfterScaleSettles(key, getValue) {
        const pendingUpdate = this._pendingScaleSettingUpdates.get(key);
        if (pendingUpdate)
            GLib.source_remove(pendingUpdate.timeoutId);

        const commit = () => {
            this._pendingScaleSettingUpdates.delete(key);
            this._settings.set_double(key, getValue());
        };
        const timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                commit();
                return GLib.SOURCE_REMOVE;
            });
        this._pendingScaleSettingUpdates.set(key, {timeoutId, commit});
    }

    _colorRow(container, {title, subtitle, key}) {
        const params = {title};
        if (subtitle)
            params.subtitle = subtitle;
        const row = new Adw.ActionRow(params);

        const dialog = new Gtk.ColorDialog();
        const button = new Gtk.ColorDialogButton({dialog, valign: Gtk.Align.CENTER});
        const rgba = new Gdk.RGBA();
        rgba.parse(this._settings.get_string(key));
        button.set_rgba(rgba);
        button.connect('notify::rgba', () => {
            this._settings.set_string(key, button.get_rgba().to_string());
        });
        row.add_suffix(button);

        this._addRow(container, row);
        return {row, button};
    }

    _resetButton(keys) {
        const button = new Gtk.Button({
            label: __('Reset to defaults'),
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => {
            keys.forEach(key => this._settings.set_value(key, this._settings.get_default_value(key)));
        });
        return button;
    }

    _buildPositionAndSizePage() {
        const page = new Adw.PreferencesPage({
            title: __('Position and size'),
            icon_name: 'video-display-symbolic',
        });

        const displayGroup = new Adw.PreferencesGroup({title: __('Display')});
        page.add(displayGroup);

        const monitorRow = new Adw.ComboRow({title: __('Show the dock on')});
        this._addRow(displayGroup, monitorRow);

        let monitors = [];
        let updatingMonitorRow = false;
        const updateMonitorRow = () => {
            const preferredMonitor = this._settings.get_int('preferred-monitor');
            const preferredMonitorByConnector =
                this._settings.get_string('preferred-monitor-by-connector');
            const labels = [];
            let primaryIndex = -1;
            let activeIndex = -1;

            monitors = [];
            for (const monitor of this._monitorsConfig.monitors) {
                if (!monitor.active && monitor.index !== preferredMonitor)
                    continue;

                if (monitor.isPrimary) {
                    labels.push(
                        /* Translators: This will be followed by Display Name - Connector. */
                        `${__('Primary monitor: ') + monitor.displayName} - ${monitor.connector}`);
                    primaryIndex = monitors.length;
                } else {
                    labels.push(
                        /* Translators: Followed by monitor index, Display Name - Connector. */
                        `${__('Secondary monitor ') + (monitor.index + 1)} - ${
                            monitor.displayName} - ${monitor.connector}`);
                }

                monitors.push(monitor);

                if (monitor.index === preferredMonitor ||
                    (preferredMonitor === -2 && preferredMonitorByConnector === monitor.connector))
                    activeIndex = monitors.length - 1;
            }

            if (activeIndex < 0 && primaryIndex >= 0)
                activeIndex = primaryIndex;

            updatingMonitorRow = true;
            monitorRow.model = Gtk.StringList.new(labels);
            if (activeIndex >= 0)
                monitorRow.selected = activeIndex;
            updatingMonitorRow = false;
        };
        updateMonitorRow();
        this._monitorsConfig.connect('updated', () => updateMonitorRow());
        this._settings.connect('changed::preferred-monitor', () => updateMonitorRow());
        this._settings.connect('changed::preferred-monitor-by-connector', () => updateMonitorRow());

        monitorRow.connect('notify::selected', () => {
            if (updatingMonitorRow || !monitors.length)
                return;

            const preferredMonitor = monitors[monitorRow.selected]?.connector;
            if (!preferredMonitor)
                return;

            this._settings.set_string('preferred-monitor-by-connector', preferredMonitor);
            this._settings.set_int('preferred-monitor', -2);
        });

        this._settings.bind('multi-monitor', monitorRow, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);

        this._switchRow(displayGroup, {
            title: __('Show on all monitors'),
            key: 'multi-monitor',
        });

        const positionLabels = [__('Top'), __('Right'), __('Bottom'), __('Left')];
        if (this._rtl) {
            // Left is Right in rtl as a setting: only the displayed strings swap,
            // the underlying enum values stay 0..3 in TOP/RIGHT/BOTTOM/LEFT order.
            positionLabels[1] = __('Left');
            positionLabels[3] = __('Right');
        }
        this._comboRow(displayGroup, {
            title: __('Position on screen'),
            key: 'dock-position',
            labels: positionLabels,
        });

        const autohideGroup = new Adw.PreferencesGroup({title: __('Autohide')});
        page.add(autohideGroup);

        this._switchRow(autohideGroup, {
            title: __('Intelligent autohide'),
            subtitle: __('Hide the dock when it obstructs a window of the current application. ' +
                'More refined settings are available.'),
            key: 'dock-fixed',
            flags: Gio.SettingsBindFlags.INVERT_BOOLEAN,
        });

        const autohideAdvancedExpander = new Adw.ExpanderRow({
            title: __('Intelligent autohide customization'),
        });
        this._settings.bind('dock-fixed', autohideAdvancedExpander, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._addRow(autohideGroup, autohideAdvancedExpander);

        this._switchRow(autohideAdvancedExpander, {
            title: __('Autohide'),
            subtitle: __('Show the dock by mouse hover on the screen edge.'),
            key: 'autohide',
        });
        const fullscreenRow = this._switchRow(autohideAdvancedExpander, {
            title: __('Enable in fullscreen mode'),
            key: 'autohide-in-fullscreen',
        });
        const requirePressureRow = this._switchRow(autohideAdvancedExpander, {
            title: __('Push to show: require pressure to show the dock'),
            key: 'require-pressure-to-show',
        });
        const urgentNotifyRow = this._switchRow(autohideAdvancedExpander, {
            title: __('Show dock for urgent notifications'),
            key: 'show-dock-urgent-notify',
        });
        this._settings.bind('autohide', fullscreenRow, 'sensitive', Gio.SettingsBindFlags.GET);
        this._settings.bind('autohide', requirePressureRow, 'sensitive', Gio.SettingsBindFlags.GET);
        this._settings.bind('autohide', urgentNotifyRow, 'sensitive', Gio.SettingsBindFlags.GET);

        this._switchRow(autohideAdvancedExpander, {
            title: __('Dodge windows'),
            subtitle: __('Show the dock when it doesn\'t obstruct application windows.'),
            key: 'intellihide',
        });
        const intellihideModeRow = this._comboRow(autohideAdvancedExpander, {
            title: __('Windows to consider'),
            key: 'intellihide-mode',
            labels: [
                __('All windows'),
                __('Only focused application\'s windows'),
                __('Only maximized windows'),
                __('Always on top'),
            ],
        });
        this._settings.bind('intellihide', intellihideModeRow, 'sensitive', Gio.SettingsBindFlags.GET);

        this._spinRow(autohideAdvancedExpander, {
            title: __('Animation duration (s)'),
            key: 'animation-time',
            upper: 1, step: 0.05, page: 0.25, digits: 3,
        });
        this._spinRow(autohideAdvancedExpander, {
            title: __('Hide timeout (s)'),
            key: 'hide-delay',
            upper: 1, step: 0.05, page: 0.25, digits: 3,
        });
        const showTimeoutRow = this._spinRow(autohideAdvancedExpander, {
            title: __('Show timeout (s)'),
            key: 'show-delay',
            upper: 1, step: 0.05, page: 0.25, digits: 3,
        });
        const pressureThresholdRow = this._spinRow(autohideAdvancedExpander, {
            title: __('Pressure threshold'),
            key: 'pressure-threshold',
            upper: 100, step: 5, page: 25,
        });
        this._settings.bind('require-pressure-to-show', showTimeoutRow, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this._settings.bind('require-pressure-to-show', pressureThresholdRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        autohideAdvancedExpander.add_action(this._resetButton([
            'intellihide', 'autohide', 'intellihide-mode', 'autohide-in-fullscreen',
            'show-dock-urgent-notify', 'require-pressure-to-show', 'animation-time',
            'show-delay', 'hide-delay', 'pressure-threshold',
        ]));

        const sizeGroup = new Adw.PreferencesGroup({title: __('Size')});
        page.add(sizeGroup);

        const dockSizeScale = this._scaleRow(sizeGroup, __('Dock size limit'), {
            lower: 0.33, upper: 1, step: 0.01, page: 0.10,
        });
        dockSizeScale.digits = 2;
        dockSizeScale.add_mark(0.9, Gtk.PositionType.TOP, null);
        dockSizeScale.set_value(this._settings.get_double('height-fraction'));
        dockSizeScale.set_format_value_func((_scale, value) => `${Math.round(value * 100)} %`);
        dockSizeScale.connect('value-changed', () => {
            if (this._dockSizeTimeoutId)
                GLib.source_remove(this._dockSizeTimeoutId);
            this._dockSizeTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                    this._settings.set_double('height-fraction', dockSizeScale.get_value());
                    this._dockSizeTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        });
        this._settings.bind('extend-height', dockSizeScale, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);

        this._switchRow(sizeGroup, {
            title: __('Panel mode: extend to the screen edge'),
            key: 'extend-height',
        });
        const centerIconsRow = this._switchRow(sizeGroup, {
            title: __('Place icons to the center'),
            key: 'always-center-icons',
        });
        this._settings.bind('extend-height', centerIconsRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        const iconSizeScale = this._scaleRow(sizeGroup, __('Icon size limit'), {
            lower: 8, upper: DEFAULT_ICONS_SIZES[0], step: 1, page: 10,
        });
        iconSizeScale.digits = 0;
        // 24 sits too close to 16 and 32 for a label of its own.
        DEFAULT_ICONS_SIZES.forEach(val =>
            iconSizeScale.add_mark(val, Gtk.PositionType.TOP, val === 24 ? null : val.toString()));
        iconSizeScale.set_value(this._settings.get_int('dash-max-icon-size'));
        iconSizeScale.set_format_value_func((_scale, value) => `${value} px`);
        iconSizeScale.connect('value-changed', () => {
            if (this._iconSizeTimeoutId)
                GLib.source_remove(this._iconSizeTimeoutId);
            this._iconSizeTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                    this._settings.set_int('dash-max-icon-size', iconSizeScale.get_value());
                    this._iconSizeTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        });

        // Correct for rtl languages
        if (this._rtl) {
            // Flip value position: this is not done automatically
            dockSizeScale.set_value_pos(Gtk.PositionType.LEFT);
            iconSizeScale.set_value_pos(Gtk.PositionType.LEFT);
            // I suppose due to a bug, having a more than one mark and one above
            // a value of 100 makes the rendering of the marks wrong in rtl.
            // This doesn't happen setting the scale as not flippable
            // and then manually inverting it
            iconSizeScale.set_flippable(false);
            iconSizeScale.set_inverted(true);
        }

        this._switchRow(sizeGroup, {
            title: __('Fixed icon size: scroll to reveal other icons'),
            key: 'icon-size-fixed',
        });

        this._switchRow(sizeGroup, {
            title: __('Magnify icons under the pointer'),
            subtitle: __('Grow the icon under the pointer and its neighbours. Needs a non-scrolling dock.'),
            key: 'magnify-icons',
        });
        const magnifyRows = [
            this._spinRow(sizeGroup, {
                title: __('Magnified size'),
                key: 'magnify-max-scale', lower: 1.1, upper: 2.5, step: 0.05, page: 0.25, digits: 2,
            }),
            this._spinRow(sizeGroup, {
                title: __('Magnification reach (icons)'),
                key: 'magnify-range-factor', lower: 1, upper: 5, step: 0.5, page: 1, digits: 1,
            }),
            this._spinRow(sizeGroup, {
                title: __('Magnification response (ms)'),
                key: 'magnify-duration', lower: 0, upper: 500, step: 5, page: 50,
            }),
        ];
        magnifyRows.forEach(row =>
            this._settings.bind('magnify-icons', row, 'sensitive', Gio.SettingsBindFlags.DEFAULT));

        const previewSizeScale = this._scaleRow(sizeGroup, __('Preview size scale'), {
            lower: 0, upper: 1, step: 0.01, page: 0.1,
        });
        previewSizeScale.digits = 2;
        previewSizeScale.set_value(this._settings.get_double('preview-size-scale'));
        previewSizeScale.set_format_value_func(
            (_scale, value) => value === 0 ? __('auto') : `${value}`);
        previewSizeScale.connect('value-changed', () => {
            this._settings.set_double('preview-size-scale', previewSizeScale.get_value());
        });

        return page;
    }

    _buildLaunchersPage() {
        const page = new Adw.PreferencesPage({
            title: __('Launchers'),
            icon_name: 'view-grid-symbolic',
        });

        const group = new Adw.PreferencesGroup();
        page.add(group);

        this._switchRow(group, {
            title: __('Show pinned applications'),
            key: 'show-favorites',
        });

        this._switchRow(group, {
            title: __('Show running applications'),
            key: 'show-running',
        });

        const isolateWorkspacesRow = new Adw.SwitchRow({title: __('Isolate workspaces')});
        this._settings.bind('isolate-workspaces', isolateWorkspacesRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        // Connect BEFORE the SYNC_CREATE bind below, which syncs 'sensitive'
        // synchronously inside bind() — otherwise the subtitle is missed on open
        // when current-workspace-only is already on.
        isolateWorkspacesRow.connect('notify::sensitive', row => {
            row.subtitle = row.sensitive
                ? ''
                : __('Managed by GNOME Multitasking\'s Application Switching setting.');
        });
        this._appSwitcherSettings.bind('current-workspace-only', isolateWorkspacesRow, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN | Gio.SettingsBindFlags.SYNC_CREATE);
        this._addRow(group, isolateWorkspacesRow);

        this._switchRow(group, {
            title: __('Show urgent windows despite current workspace'),
            key: 'workspace-agnostic-urgent-windows',
        });
        this._switchRow(group, {
            title: __('Isolate monitors'),
            key: 'isolate-monitors',
        });
        this._switchRow(group, {
            title: __('Show open windows\' previews'),
            key: 'show-windows-preview',
        });

        this._switchRow(group, {
            title: __('Show trash can'),
            key: 'show-trash',
        });

        this._switchRow(group, {
            title: __('Show volumes and devices'),
            key: 'show-mounts',
        });
        this._switchRow(group, {
            title: __('Only if mounted'),
            key: 'show-mounts-only-mounted',
        });
        this._switchRow(group, {
            title: __('Include network volumes'),
            key: 'show-mounts-network',
        });

        const isolateLocationsRow = this._switchRow(group, {
            title: __('Isolate volumes, devices and trash windows from file manager'),
            key: 'isolate-locations',
        });
        const updateIsolateLocationsSensitivity = () => {
            isolateLocationsRow.sensitive = this._settings.get_boolean('show-trash') ||
                this._settings.get_boolean('show-mounts');
        };
        updateIsolateLocationsSensitivity();
        this._settings.connect('changed::show-trash', updateIsolateLocationsSensitivity);
        this._settings.connect('changed::show-mounts', updateIsolateLocationsSensitivity);

        this._switchRow(group, {
            title: __('Wiggle urgent applications'),
            key: 'dance-urgent-applications',
        });
        this._switchRow(group, {
            title: __('Hide application tooltip'),
            key: 'hide-tooltip',
        });

        this._switchRow(group, {
            title: __('Show icons emblems'),
            subtitle: __('When enabled application icons will show notification counters and ' +
                'progress-bars (if Unity API is used).'),
            key: 'show-icons-emblems',
        });
        const notificationsCounterRow = this._switchRow(group, {
            title: __('Show the number of unread notifications'),
            key: 'show-icons-notifications-counter',
        });
        this._settings.bind('show-icons-emblems', notificationsCounterRow, 'sensitive',
            Gio.SettingsBindFlags.GET);
        const overrideCounterRow = this._switchRow(group, {
            title: __('Application-provided counter overrides the notifications counter'),
            key: 'application-counter-overrides-notifications',
        });
        notificationsCounterRow.bind_property('active', overrideCounterRow, 'sensitive',
            GObject.BindingFlags.SYNC_CREATE);
        this._settings.connect('changed::show-icons-emblems', () => {
            overrideCounterRow.sensitive = this._settings.get_boolean('show-icons-emblems') &&
                notificationsCounterRow.active;
        });

        this._switchRow(group, {
            title: __('Show <i>Applications</i> icon'),
            subtitle: __('If disabled, these settings are accessible from gnome-tweak-tool or ' +
                'the extension website.'),
            key: 'show-show-apps-button',
        });
        const showAppsFirstRow = this._switchRow(group, {
            title: __('Move Applications button to the start (left/top) of the dock'),
            key: 'show-apps-at-top',
        });
        const showAppsEdgeRow = this._switchRow(group, {
            title: __('Put <i>Show Applications</i> in a dock edge when using Panel mode'),
            key: 'show-apps-always-in-the-edge',
        });
        const showAppsActionRow = this._comboRow(group, {
            title: __('When the Applications button is clicked'),
            key: 'show-apps-action',
            labels: [__('Show the applications grid'), __('Open a search launcher')],
        });
        this._settings.bind('show-show-apps-button', showAppsFirstRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-show-apps-button', showAppsEdgeRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('show-show-apps-button', showAppsActionRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        this._switchRow(group, {
            title: __('Keep the focused application always visible in the dash'),
            key: 'scroll-to-focused-application',
        });

        return page;
    }

    _buildBehaviorPage() {
        const page = new Adw.PreferencesPage({
            title: __('Behavior'),
            icon_name: 'input-mouse-symbolic',
        });

        const keyboardGroup = new Adw.PreferencesGroup({title: __('Keyboard')});
        page.add(keyboardGroup);

        this._switchRow(keyboardGroup, {
            title: __('Use keyboard shortcuts to activate apps'),
            subtitle: __('Enable Super+(0-9) as shortcuts to activate apps. It can also be used ' +
                'together with Shift and Ctrl.'),
            key: 'hot-keys',
        });

        const overlayExpander = new Adw.ExpanderRow({title: __('Show dock and application numbers')});
        this._settings.bind('hot-keys', overlayExpander, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        this._addRow(keyboardGroup, overlayExpander);

        this._switchRow(overlayExpander, {
            title: __('Number overlay'),
            subtitle: __('Temporarily show the application numbers over the icons, corresponding ' +
                'to the shortcut.'),
            key: 'hotkeys-overlay',
        });
        this._switchRow(overlayExpander, {
            title: __('Show the dock if it is hidden'),
            subtitle: __('If using autohide, the dock will appear for a short time when ' +
                'triggering the shortcut.'),
            key: 'hotkeys-show-dock',
        });

        const shortcutRow = new Adw.EntryRow({title: __('Shortcut for the options above')});
        this._settings.connect('changed::shortcut-text', () => setShortcut(this._settings));
        this._settings.bind('shortcut-text', shortcutRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        this._addRow(overlayExpander, shortcutRow);
        this._addRow(overlayExpander, new Adw.ActionRow({
            title: GLib.markup_escape_text(
                __('Syntax: <Shift>, <Ctrl>, <Alt>, <Super>'), -1),
        }));

        this._spinRow(overlayExpander, {
            title: __('Hide timeout (s)'),
            key: 'shortcut-timeout',
            upper: 10, step: 0.25, page: 1, digits: 3,
        });

        overlayExpander.add_action(this._resetButton([
            'shortcut-text', 'hotkeys-overlay', 'hotkeys-show-dock', 'shortcut-timeout',
        ]));

        const mouseGroup = new Adw.PreferencesGroup({title: __('Mouse')});
        page.add(mouseGroup);

        this._comboRow(mouseGroup, {
            title: __('Click action'),
            subtitle: __('Behaviour when clicking on the icon of a running application.'),
            key: 'click-action',
            labels: [
                __('Raise window'), __('Minimize'), __('Launch new instance'),
                __('Cycle through windows'), __('Minimize or overview'), __('Show window previews'),
                __('Minimize or show previews'), __('Focus or show previews'),
                __('Focus or app spread'), __('Focus, minimize or show previews'),
                __('Focus, minimize or app spread'),
            ],
        });

        const fullClickActionLabels = [
            __('Raise window'), __('Minimize window'), __('Launch new instance'),
            __('Cycle through windows'), __('Minimize or overview'), __('Show window previews'),
            __('Minimize or show previews'), __('Focus or show previews'),
            __('Focus or app spread'), __('Focus, minimize or show previews'),
            __('Focus, minimize or app spread'), __('Quit'),
        ];
        const middleClickExpander = new Adw.ExpanderRow({
            title: __('Customize middle-click behavior'),
        });
        this._addRow(mouseGroup, middleClickExpander);
        this._comboRow(middleClickExpander, {
            title: __('Shift+Click action'),
            subtitle: __('When set to minimize, double clicking minimizes all the windows of ' +
                'the application.'),
            key: 'shift-click-action',
            labels: fullClickActionLabels,
        });
        this._comboRow(middleClickExpander, {
            title: __('Middle-Click action'),
            subtitle: __('Behavior for Middle-Click.'),
            key: 'middle-click-action',
            labels: fullClickActionLabels,
        });
        this._comboRow(middleClickExpander, {
            title: __('Shift+Middle-Click action'),
            subtitle: __('Behavior for Shift+Middle-Click.'),
            key: 'shift-middle-click-action',
            labels: fullClickActionLabels,
        });
        middleClickExpander.add_action(this._resetButton([
            'shift-click-action', 'middle-click-action', 'shift-middle-click-action',
        ]));

        const scrollGroup = new Adw.PreferencesGroup({title: __('Scrolling')});
        page.add(scrollGroup);

        this._comboRow(scrollGroup, {
            title: __('Scroll action'),
            subtitle: __('Behaviour when scrolling on the icon of an application.'),
            key: 'scroll-action',
            labels: [__('Do nothing'), __('Cycle through windows'), __('Switch workspace')],
        });

        const scrollNote = new Adw.ActionRow({
            title: __('Won\'t work over icons because \'Fixed icon size\' is enabled.'),
        });
        scrollNote.visible = this._settings.get_boolean('icon-size-fixed');
        this._settings.connect('changed::icon-size-fixed', () => {
            scrollNote.visible = this._settings.get_boolean('icon-size-fixed');
        });
        this._addRow(scrollGroup, scrollNote);

        return page;
    }

    _buildAppearancePage() {
        const page = new Adw.PreferencesPage({
            title: __('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const badgeGroup = new Adw.PreferencesGroup({title: __('Notification badges')});
        page.add(badgeGroup);
        this._comboRow(badgeGroup, {
            title: __('Badge style'),
            subtitle: __('Applies to the dock and application launcher.'),
            key: 'notification-badge-style',
            labels: [__('Frosted Tint'), __('Accent Fill')],
        });

        const dashGroup = new Adw.PreferencesGroup({title: __('Dash')});
        page.add(dashGroup);

        this._switchRow(dashGroup, {
            title: __('Shrink the dash'),
            subtitle: __('Save space reducing padding and border radius.'),
            key: 'custom-theme-shrink',
        });
        this._switchRow(dashGroup, {
            title: __('Force straight corner'),
            key: 'force-straight-corner',
        });
        this._switchRow(dashGroup, {
            title: __('Blur behind the dock'),
            subtitle: __('Needs GNOME Rounded Blur, and shows only where the dock background ' +
                'is not fully opaque.'),
            key: 'dock-blur',
        });
        this._switchRow(dashGroup, {
            title: __('Show overview on startup'),
            key: 'disable-overview-on-startup',
            flags: Gio.SettingsBindFlags.INVERT_BOOLEAN,
        });

        const themeGroup = new Adw.PreferencesGroup({title: __('Theme')});
        page.add(themeGroup);

        this._switchRow(themeGroup, {
            title: __('Use built-in theme'),
            subtitle: __('Few customizations meant to integrate the dock with the default ' +
                'GNOME theme. Alternatively, specific options can be enabled below.'),
            key: 'apply-custom-theme',
        });

        // Everything below is only meaningful once the built-in theme is turned off.
        const themeCustomizeGroup = new Adw.PreferencesGroup();
        page.add(themeCustomizeGroup);
        this._settings.bind('apply-custom-theme', themeCustomizeGroup, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN | Gio.SettingsBindFlags.GET);

        this._comboRow(themeCustomizeGroup, {
            title: __('Customize windows counter indicators'),
            key: 'running-indicator-style',
            labels: [
                __('Default'), __('Dots'), __('Squares'), __('Dashes'), __('Segmented'),
                __('Solid'), __('Ciliora'), __('Metro'), __('Binary'), __('Dot'),
            ],
        });

        const runningAdvancedExpander = new Adw.ExpanderRow({
            title: __('Customize running indicators'),
        });
        this._addRow(themeCustomizeGroup, runningAdvancedExpander);
        const updateRunningAdvancedSensitivity = () => {
            runningAdvancedExpander.sensitive =
                this._settings.get_enum('running-indicator-style') !== RunningIndicatorStyle.DEFAULT;
        };
        updateRunningAdvancedSensitivity();
        this._settings.connect('changed::running-indicator-style', updateRunningAdvancedSensitivity);

        this._switchRow(runningAdvancedExpander, {
            title: __('Enable Unity7 like glossy backlit items'),
            key: 'unity-backlit-items',
        });
        const glossyRow = this._switchRow(runningAdvancedExpander, {
            title: __('Apply glossy effect.'),
            key: 'apply-glossy-effect',
        });
        this._settings.bind('unity-backlit-items', glossyRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        this._switchRow(runningAdvancedExpander, {
            title: __('Use dominant color'),
            key: 'running-indicator-dominant-color',
        });

        this._switchRow(runningAdvancedExpander, {
            title: __('Customize indicator style'),
            key: 'custom-theme-customize-running-dots',
        });
        const {row: dotColorRow} = this._colorRow(runningAdvancedExpander, {
            title: __('Color'),
            key: 'custom-theme-running-dots-color',
        });
        const {row: dotBorderColorRow} = this._colorRow(runningAdvancedExpander, {
            title: __('Border color'),
            key: 'custom-theme-running-dots-border-color',
        });
        const dotBorderWidthRow = this._spinRow(runningAdvancedExpander, {
            title: __('Border width'),
            key: 'custom-theme-running-dots-border-width',
            upper: 10, step: 1, page: 5,
        });
        this._settings.bind('custom-theme-customize-running-dots', dotColorRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-theme-customize-running-dots', dotBorderColorRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-theme-customize-running-dots', dotBorderWidthRow, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);

        const {row: backgroundColorRow, button: backgroundColorButton} = this._colorRow(
            themeCustomizeGroup, {
                title: __('Customize the dash color'),
                subtitle: __('Set the background color for the dash.'),
                key: 'background-color',
            });
        const backgroundColorSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
        this._settings.bind('custom-background-color', backgroundColorSwitch, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        this._settings.bind('custom-background-color', backgroundColorButton, 'sensitive',
            Gio.SettingsBindFlags.DEFAULT);
        backgroundColorRow.add_suffix(backgroundColorSwitch);

        this._comboRow(themeCustomizeGroup, {
            title: __('Customize opacity'),
            key: 'transparency-mode',
            labels: [__('Default'), __('Fixed'), __('Dynamic')],
            values: [0, 1, 3],
        });

        const opacityScale = this._scaleRow(themeCustomizeGroup, __('Opacity'), {
            lower: 0, upper: 1, step: 0.01, page: 0.10,
        });
        opacityScale.digits = 2;
        opacityScale.set_value(this._settings.get_double('background-opacity'));
        opacityScale.set_format_value_func((_scale, value) => `${Math.round(value * 100)}%`);
        opacityScale.connect('value-changed', () =>
            this._setDoubleAfterScaleSettles(
                'background-opacity', () => opacityScale.get_value()));
        const updateOpacitySensitivity = () => {
            opacityScale.sensitive =
                this._settings.get_enum('transparency-mode') === TransparencyMode.FIXED;
        };
        updateOpacitySensitivity();
        this._settings.connect('changed::transparency-mode', updateOpacitySensitivity);

        const opacityAdvancedExpander = new Adw.ExpanderRow({title: __('Customize opacity')});
        this._addRow(themeCustomizeGroup, opacityAdvancedExpander);
        const updateOpacityAdvancedSensitivity = () => {
            opacityAdvancedExpander.sensitive =
                this._settings.get_enum('transparency-mode') === TransparencyMode.DYNAMIC;
        };
        updateOpacityAdvancedSensitivity();
        this._settings.connect('changed::transparency-mode', updateOpacityAdvancedSensitivity);

        this._switchRow(opacityAdvancedExpander, {
            title: __('Customize minimum and maximum opacity values'),
            key: 'customize-alphas',
        });

        const minAlphaScale = this._scaleRow(opacityAdvancedExpander, __('Minimum opacity'), {
            lower: 0, upper: 1, step: 0.01, page: 0.10,
        });
        minAlphaScale.digits = 2;
        minAlphaScale.set_value(this._settings.get_double('min-alpha'));
        minAlphaScale.set_format_value_func((_scale, value) => `${Math.round(value * 100)} %`);
        minAlphaScale.connect('value-changed', () =>
            this._setDoubleAfterScaleSettles(
                'min-alpha', () => minAlphaScale.get_value()));
        this._settings.bind('customize-alphas', minAlphaScale, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        const maxAlphaScale = this._scaleRow(opacityAdvancedExpander, __('Maximum opacity'), {
            lower: 0, upper: 1, step: 0.01, page: 0.10,
        });
        maxAlphaScale.digits = 2;
        maxAlphaScale.set_value(this._settings.get_double('max-alpha'));
        maxAlphaScale.set_format_value_func((_scale, value) => `${Math.round(value * 100)} %`);
        maxAlphaScale.connect('value-changed', () =>
            this._setDoubleAfterScaleSettles(
                'max-alpha', () => maxAlphaScale.get_value()));
        this._settings.bind('customize-alphas', maxAlphaScale, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        return page;
    }

    _buildAboutPage() {
        const page = new Adw.PreferencesPage({
            title: __('About'),
            icon_name: 'help-about-symbolic',
        });

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            margin_top: 24,
            margin_bottom: 24,
            halign: Gtk.Align.CENTER,
        });

        box.append(Gtk.Image.new_from_file(`${this.path}/media/logo.svg`));

        box.append(new Gtk.Label({label: '<b>XDock</b>', use_markup: true}));

        const versionBox = new Gtk.Box({halign: Gtk.Align.CENTER, spacing: 5});
        versionBox.append(new Gtk.Label({halign: Gtk.Align.END, label: __('version: ')}));
        versionBox.append(new Gtk.Label({
            halign: Gtk.Align.START,
            label: `${this.metadata['version-name'] ?? this.metadata.version}`,
        }));
        box.append(versionBox);

        box.append(new Gtk.Label({
            label: __('Application dock and launcher for GNOME Shell'),
            justify: Gtk.Justification.CENTER,
            wrap: true,
        }));

        const authorBox = new Gtk.Box({halign: Gtk.Align.CENTER, spacing: 5});
        authorBox.append(new Gtk.Label({label: __('Maintained by')}));
        authorBox.append(new Gtk.Label({
            label: 'NorviTech · original implementation by Michele G.',
        }));
        box.append(authorBox);

        box.append(new Gtk.LinkButton({
            label: __('Webpage'),
            halign: Gtk.Align.CENTER,
            uri: 'https://github.com/spencercnorton/xdock',
        }));

        box.append(new Gtk.Label({
            label: __('<span size="small">This program comes with ABSOLUTELY NO WARRANTY.\n' +
                'See the <a href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html">GNU ' +
                'General Public License, version 2 or later</a> for details.</span>'),
            use_markup: true,
            justify: Gtk.Justification.CENTER,
            wrap: true,
        }));

        group.add(box);

        return page;
    }
}
