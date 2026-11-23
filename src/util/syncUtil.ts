import appState, { setAppState } from "./state";
import { resolveGameName } from "./steamUtil";
import { toaster } from "@decky/api";
import { backup, cloudCatchUp, getGameConfig, log, setConfig } from "./backend";

// Periodic backups of running games, keyed by Steam app id.
const periodicTimers = new Map<number, ReturnType<typeof setInterval>>();

const stopPeriodicBackup = (appId: number) => {
    const timer = periodicTimers.get(appId);
    if (timer !== undefined) {
        clearInterval(timer);
        periodicTimers.delete(appId);
    }
}

const startPeriodicBackup = async (appId: number, gameName: string) => {
    stopPeriodicBackup(appId);

    const minutes = appState.currentState.periodic_backup_minutes;
    if (!minutes || minutes <= 0) return;
    if (!appState.currentState.ludusavi_enabled || !appState.currentState.auto_backup_enabled) return;

    const game = await getGameConfig(gameName);
    if (!game?.autoSync) return;

    log(`Periodic backup every ${minutes} min started for ${game.alias} (app ${appId})`);
    periodicTimers.set(appId, setInterval(async () => {
        if (appState.currentState.syncing) {
            log(`Periodic backup of ${game.alias} skipped: another backup is running`, "warn");
            return;
        }
        await backupGame(game.alias, { quiet: true });
    }, minutes * 60_000));
}

// Re-arm timers for running games after the interval setting changes.
const runningGames = new Map<number, string>();
export const restartPeriodicBackups = () => {
    runningGames.forEach((gameName, appId) => startPeriodicBackup(appId, gameName));
}

export const onGameStart = async (appId: number) => {
    const gameName = await resolveGameName(appId);

    if (gameName) {
        appState.pushRecentGame(gameName);
        runningGames.set(appId, gameName);
        periodicConflictWarned.clear(); // new session: allow one conflict warning again
        await startPeriodicBackup(appId, gameName);
    } else {
        console.error("Ludusavi: game not supported", gameName);
    }
}

export const onGameExit = async (appId: number) => {
    runningGames.delete(appId);
    stopPeriodicBackup(appId);

    if (appState.currentState.ludusavi_enabled && appState.currentState.auto_backup_enabled) {
        const gameName = await resolveGameName(appId);
        if (!gameName) {
            console.error("Ludusavi: could not resolve app", appId);
            return;
        }

        const game = await getGameConfig(gameName);

        if (game.autoSync) {
            // A periodic backup may still be running; wait (up to 5 min) so the exit backup isn't dropped.
            for (let waited = 0; appState.currentState.syncing && waited < 300; waited++) {
                await new Promise((r) => setTimeout(r, 1000));
            }
            await backupGame(game.alias);
        }
    }
}


export async function backupGame(gameName: string, { quiet = false }: { quiet?: boolean } = {}) {
    if (appState.currentState.syncing) {
        throw 'Sync in Progress';
    }

    const start = new Date();

    try {
        setAppState("syncing", true);
        await handleComplete(start, await backup(gameName), quiet, gameName);
    } catch (e) {
        toaster.toast({ title: "⛔ Ludusavi: Error", body: "An error occurred while backing up. Check logs." });
        console.error(e);
    } finally {
        setAppState("syncing", false);
    }
}

// Games already warned about a real cloud conflict by a periodic backup during this play session.
const periodicConflictWarned = new Set<string>();

// ---- Cloud catch-up ----
// Ludusavi calls it a "cloud conflict" whenever local backups and the cloud differ, including the
// common case where only this device moved ahead (backups made while offline). The backend previews
// an upload and only performs it when nothing in the cloud would be lost; otherwise it's a real conflict.

const setCloudPending = (gameName: string, pending: boolean) => {
    const current = appState.currentState.cloud_pending ?? [];
    if (current.includes(gameName) === pending) return;
    const next = pending ? [...current, gameName] : current.filter((g) => g !== gameName);
    setAppState("cloud_pending", next);
    setConfig("cloud_pending", next);
}

const reportCloudUnreachable = (gameName: string, quiet: boolean) => {
    // Usually just offline. The local backup still completed, so stay silent during play unless opted in.
    if (!quiet || appState.currentState.periodic_cloud_alerts) {
        toaster.toast({ title: "⚠️ Ludusavi: Cloud Sync Issue", body: "Unable to reach the cloud. Will retry automatically." });
    } else {
        log(`${gameName}: cloud unreachable (offline?); local backup kept, will retry; toast muted`, "warn");
    }
}

const reportRealConflict = (gameName: string, quiet: boolean, foreign: string[] = []) => {
    log(`${gameName}: real cloud conflict, nothing uploaded. Cloud-only backups: ${foreign.join(", ")}`, "warn");
    // A real conflict doesn't go away by itself; during play, warn once per session instead of every interval.
    if (!quiet || !periodicConflictWarned.has(gameName)) {
        toaster.toast({
            title: "⚠️ Ludusavi: Cloud Conflict",
            body: "The cloud has backups this device didn't make. Nothing was overwritten. Resolve in Ludusavi.",
        });
        if (quiet) periodicConflictWarned.add(gameName);
    }
}

// Returns true when the cloud now matches this device's backups.
async function catchUpCloud(gameName: string, quiet: boolean): Promise<boolean> {
    const r = await cloudCatchUp(gameName);
    switch (r.status) {
        case "uploaded":
            setCloudPending(gameName, false);
            log(`${gameName}: cloud caught up, uploaded ${r.files} file(s), removed ${r.pruned} file(s) of backups already pruned locally`);
            return true;
        case "in_sync":
            setCloudPending(gameName, false);
            log(`${gameName}: cloud already in sync`);
            return true;
        case "conflict":
            setCloudPending(gameName, false); // don't retry; needs a decision
            reportRealConflict(gameName, quiet, r.foreign);
            return false;
        default:
            setCloudPending(gameName, true);
            log(`${gameName}: cloud catch-up ${r.status}: ${r.detail ?? ""}`, "warn");
            reportCloudUnreachable(gameName, quiet);
            return false;
    }
}

// Retry games whose cloud copy is behind, e.g. after coming back online. Silent unless something needs attention.
export async function retryPendingCloud() {
    const s = appState.currentState;
    if (!s.ludusavi_enabled || !s.cloud_auto_catch_up) return;
    for (const gameName of [...(s.cloud_pending ?? [])]) {
        if (appState.currentState.syncing) return;
        setAppState("syncing", true);
        try {
            await catchUpCloud(gameName, true);
        } catch (e) {
            log(`${gameName}: cloud retry failed: ${e}`, "error");
        } finally {
            setAppState("syncing", false);
        }
    }
}

// quiet = periodic backup: no success toast, and cloud problems are muted (see above).
// Errors that mean the local backup itself failed always toast.
async function handleComplete(start: Date, result: LudusaviBackupResponse, quiet = false, gameName = "") {
    let cloudNote = "";

    if (result.errors) {
        let failed = false;

        if (result.errors.cloudConflict) {
            if (appState.currentState.cloud_auto_catch_up) {
                if (await catchUpCloud(gameName, quiet)) {
                    cloudNote = " Cloud caught up.";
                } else {
                    failed = true;
                }
            } else {
                setCloudPending(gameName, true);
                reportRealConflict(gameName, quiet);
                failed = true;
            }
        }
        if (result.errors.cloudSyncFailed) {
            setCloudPending(gameName, true);
            reportCloudUnreachable(gameName, quiet);
            failed = true;
        }
        if (result.errors.unknownGames) {
            toaster.toast({ title: "⛔ Ludusavi: Unknown Game", body: result.errors.unknownGames[0] })
            failed = true;
        }
        if (result.errors.pluginError) {
            toaster.toast({ title: "⛔ Ludusavi: Plugin Error", body: result.errors.pluginError })
            failed = true;
        }

        if (failed) {
            console.error(result.errors)
            return;
        }
    } else {
        setCloudPending(gameName, false);
    }

    Object.keys(result.games ?? {}).forEach((gameName) => {
        const game = result.games[gameName];
        let message = "";
        let bytesChanged = 0;

        if (game.change === "Same") {
            message = "No changes detected";
        } else {
            const changes = {
                Same: 0,
                Different: 0,
                New: 0,
                Removed: 0,
            };

            Object.keys(game.files).forEach((fileName) => {
                const file = game.files[fileName];
                if (!file.ignored) {
                    changes[file.change]++;
                }

                if (!file.ignored && file.change !== "Same") bytesChanged += file.bytes;
            });

            message += `Synced ${changes.New + changes.Different} file(s) [${(bytesChanged / 1_000_000).toFixed(2)} MB]`;
        }

        if (quiet) {
            log(`Periodic backup of ${gameName}: ${message}.${cloudNote}`);
        } else if (appState.currentState.auto_backup_toast_enabled) {
            toaster.toast({
                title: `Ludusavi Backup Complete - ${gameName}`,
                body: `${message}.${cloudNote} ⌛ ${((new Date().getTime() - start.getTime()) / 1000).toFixed(2)} s.`,
            });
        }
    });
}
