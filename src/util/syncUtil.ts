import appState, { setAppState } from "./state";
import { resolveGameName } from "./steamUtil";
import { toaster } from "@decky/api";
import { backup, getGameConfig, log } from "./backend";

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
        handleComplete(start, await backup(gameName), quiet, gameName);
    } catch (e) {
        toaster.toast({ title: "⛔ Ludusavi: Error", body: "An error occurred while backing up. Check logs." });
        console.error(e);
    } finally {
        setAppState("syncing", false);
    }
}

// Games already warned about a cloud conflict by a periodic backup during this play session.
const periodicConflictWarned = new Set<string>();

// quiet = periodic backup: no success toast, and cloud problems are muted (see below).
// Errors that mean the local backup itself failed always toast.
function handleComplete(start: Date, result: LudusaviBackupResponse, quiet = false, gameName = "") {
    if (result.errors) {
        if (result.errors.cloudConflict) {
            // A conflict doesn't go away by itself; during play, warn once per session instead of every interval.
            if (!quiet || !periodicConflictWarned.has(gameName)) {
                toaster.toast({ title: "⚠️ Ludusavi: Cloud Conflict", body: "Files out of sync with cloud." });
                if (quiet) periodicConflictWarned.add(gameName);
            } else {
                log(`Periodic backup of ${gameName}: cloud conflict (already notified this session)`, "warn");
            }
        }
        if (result.errors.cloudSyncFailed) {
            // Usually just offline. The local backup still completed, so stay silent during play unless opted in.
            if (!quiet || appState.currentState.periodic_cloud_alerts) {
                toaster.toast({ title: "⚠️ Ludusavi: Cloud Sync Issue", body: "Unable to synchronize with cloud." })
            } else {
                log(`Periodic backup of ${gameName}: cloud sync failed (offline?); local backup kept, toast muted`, "warn");
            }
        }
        if (result.errors.unknownGames) {
            toaster.toast({ title: "⛔ Ludusavi: Unknown Game", body: result.errors.unknownGames[0] })
        }
        if (result.errors.pluginError) {
            toaster.toast({ title: "⛔ Ludusavi: Plugin Error", body: result.errors.pluginError })
        }

        console.error(result.errors)
        return;
    }

    Object.keys(result.games).forEach((gameName) => {
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
            log(`Periodic backup of ${gameName}: ${message}`);
        } else if (appState.currentState.auto_backup_toast_enabled) {
            toaster.toast({
                title: `Ludusavi Backup Complete - ${gameName}`,
                body: `${message}. ⌛ ${((new Date().getTime() - start.getTime()) / 1000).toFixed(2)} s.`,
            });
        }
    });
}
