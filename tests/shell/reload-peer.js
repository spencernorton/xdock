import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class ReloadPeer extends Extension {
    enable() {
        return this.onEnable?.();
    }

    disable() {}
}
