import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export async function checkExtensionReload(xdock, wait) {
    const shell = Main.extensionManager;
    const module = await import(`${xdock.dir.get_uri()}/extension.js`);
    const dockActors = () => Main.uiGroup.get_children().filter(actor => actor.name === 'xdockContainer');
    const until = async (predicate, message) => {
        for (let i = 0; i < 100; i++) {
            if (predicate())
                return;
            // eslint-disable-next-line no-await-in-loop -- wait for Shell to finish this transition
            await wait(50);
        }
        throw new Error(message);
    };

    // An earlier reload can call enable after the user disabled XDock. The
    // notification has no right to recreate the dock or its background work.
    shell.disableExtension(xdock.uuid);
    await until(() => xdock.state === 2, 'XDock did not disable');
    xdock.stateObj.enable();
    if (module.dockManager || dockActors().length)
        throw new Error('A stale enable recreated the disabled dock');
    const first = shell.lookup('reload-first@xdock.test');
    const second = shell.lookup('reload-second@xdock.test');
    const waitingPeer = shell.lookup('reload-gate@xdock.test');
    for (const peer of [first, second, waitingPeer]) {
        shell.enableExtension(peer.uuid);
        // eslint-disable-next-line no-await-in-loop -- these peers must precede XDock in this order
        await until(() => peer.state === 1, `Test peer ${peer.uuid} did not enable`);
    }
    shell.enableExtension(xdock.uuid);
    await until(() => xdock.state === 1, 'XDock did not re-enable');

    // Shell temporarily disables later extensions and awaits their enable
    // methods in order. Hold one peer while a second settings change restores
    // XDock, then let the first reload reach the same live dock.
    const gate = waitingPeer.stateObj;
    let resume;
    gate.onEnable = () => {
        gate.onEnable = null;
        return new Promise(resolve => {
            resume = resolve;
        });
    };
    try {
        shell.disableExtension(first.uuid);
        await until(() => !!resume, 'The first extension reload did not reach the gate');
        shell.disableExtension(second.uuid);
        let overlappingManager;
        let overlappingActor;
        if (shell._enableExtensionMutex) {
            // Shell 51 serializes settings changes behind this mutex. The
            // queued disable cannot finish until the first reload resumes.
            if (second.state !== 1 || module.dockManager)
                throw new Error('XDock was restored while the first reload was paused');
        } else {
            await until(() => second.state === 2, 'The overlapping extension reload did not finish');
            overlappingManager = module.dockManager;
            [overlappingActor] = dockActors();
            if (!overlappingManager || !overlappingActor)
                throw new Error('The overlapping reload did not restore the dock');
        }
        resume();
        await until(() => first.state === 2, 'The first extension reload did not finish');
        if (shell._enableExtensionMutex)
            await until(() => second.state === 2, 'The queued extension reload did not finish');
        const manager = module.dockManager;
        const actors = dockActors();
        const [actor] = actors;
        if (xdock.state !== 1 || !manager || actors.length !== 1 ||
            (overlappingManager && (overlappingManager !== manager || overlappingActor !== actor)))
            throw new Error('The extension reloads lost or duplicated the live dock');
        xdock.stateObj.enable();
        if (module.dockManager !== manager || dockActors()[0] !== actor || dockActors().length !== 1)
            throw new Error('A repeated enable replaced the active dock');
        // A teardown addressed to a different state object cannot destroy
        // this owner's manager, even though both use the same module export.
        xdock.stateObj.disable.call(Object.create(xdock.stateObj));
        if (module.dockManager !== manager || dockActors()[0] !== actor)
            throw new Error('An obsolete extension instance destroyed the live dock');

        // Other extensions can reach the exported manager. Even if it has
        // already been destroyed, a normal disable must clear that export.
        manager.destroy();
        shell.disableExtension(xdock.uuid);
        await until(() => xdock.state === 2, 'XDock did not finish teardown');
        if (module.dockManager || dockActors().length)
            throw new Error('Teardown retained an already destroyed manager');
    } finally {
        gate.onEnable = null;
        resume?.();
    }
}
