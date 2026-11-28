// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {DockManager} from './docking.js';
import {Extension} from './dependencies/shell/extensions/extension.js';
import {Main} from './dependencies/shell/ui.js';

// We export this so it can be accessed by other extensions
export let dockManager;

export default class XDockExtension extends Extension.Extension {
    enable() {
        // Shell can resume an older extension-order reload after another
        // reload has restored this dock or the user has disabled it.
        if (dockManager?.extension === this ||
            Main.extensionManager.lookup(this.uuid)?.enabled === false)
            return;

        const manager = new DockManager(this, {
            onFailClosed: failedManager => {
                // A runtime capability loss destroys its manager before GNOME
                // calls disable(). Do not leave the exported integration point
                // referring to that destroyed object in the meantime.
                if (dockManager === failedManager)
                    dockManager = null;
            },
        });
        if (!manager.destroyed)
            dockManager = manager;
    }

    disable() {
        const manager = dockManager;
        if (manager?.extension && manager.extension !== this)
            return;
        try {
            manager?.destroy();
        } finally {
            // Keep the exported manager available to normal destroy callbacks,
            // matching the extension's historical disable semantics.
            if (dockManager === manager)
                dockManager = null;
        }
    }
}
