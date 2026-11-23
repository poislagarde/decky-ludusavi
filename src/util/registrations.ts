import { onGameExit, onGameStart, retryPendingCloud } from "./syncUtil";
import PluginLogsPage from "../pages/PluginLogsPage";
import { AppLifetimeNotification } from "@decky/ui/dist/globals/steam-client/GameSessions";
import { Unregisterable } from "@decky/ui";

const registrations: Unregisterable[] = [];

function registerAppLifecycleNotifications() {
    registrations.push(SteamClient.GameSessions.RegisterForAppLifetimeNotifications(async (e: AppLifetimeNotification) => {
        if (e.bRunning) {
            onGameStart(e.unAppID);
        } else {
            onGameExit(e.unAppID);
        }
    }));
}

// Upload backups that couldn't reach the cloud earlier (e.g. made offline), once we're back online.
function registerCloudRetry() {
    const first = setTimeout(retryPendingCloud, 60_000);
    const every = setInterval(retryPendingCloud, 10 * 60_000);
    registrations.push({ unregister: () => { clearTimeout(first); clearInterval(every); } });
}

function registerPages() {
    registrations.push(PluginLogsPage.register());
}


export const registerDependencies = () => {
    registerAppLifecycleNotifications();
    registerPages();
    registerCloudRetry();

    return () => registrations.forEach((registration) => {
        registration.unregister();
    });
}


