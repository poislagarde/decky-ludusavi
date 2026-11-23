import { DropdownItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { PersistentState, setAppState, useAppState } from "../../util/state";
import { setConfig } from "../../util/backend";
import { useCallback } from "react";
import { restartPeriodicBackups } from "../../util/syncUtil";

const PERIODIC_OPTIONS = [
  { data: 0, label: "Off" },
  { data: 15, label: "Every 15 minutes" },
  { data: 30, label: "Every 30 minutes" },
  { data: 60, label: "Every hour" },
  { data: 120, label: "Every 2 hours" },
];

export default function ConfigurationPanel() {
  const appState = useAppState();

  const handleConfigChange = useCallback((key: keyof PersistentState, value: boolean | number): void => {
    setAppState(key, value);
    setConfig(key, value);
  }, []);

  return (
    <PanelSection title="Global Config">
      <PanelSectionRow>
        <ToggleField label="Auto-Sync Feature Enabled" checked={appState.auto_backup_enabled} onChange={(e) => handleConfigChange("auto_backup_enabled", e)} />
      </PanelSectionRow>
      {appState.auto_backup_enabled && (
        <>
          <PanelSectionRow>
            <ToggleField
              label="Auto-Sync New Games"
              checked={appState.auto_backup_new_games}
              onChange={(e) => handleConfigChange("auto_backup_new_games", e)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Auto-Sync Notifications"
              checked={appState.auto_backup_toast_enabled}
              onChange={(e) => handleConfigChange("auto_backup_toast_enabled", e)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <DropdownItem
              label="Backup While Playing"
              description="Also back up games with 'Sync after closing game' on, at this interval while they run. Successful backups stay silent."
              rgOptions={PERIODIC_OPTIONS}
              selectedOption={appState.periodic_backup_minutes ?? 0}
              onChange={(e) => {
                handleConfigChange("periodic_backup_minutes", e.data as number);
                restartPeriodicBackups();
              }}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Keep Cloud Caught Up"
              description="If backups couldn't reach the cloud (e.g. played offline), upload them automatically once online. Stops and alerts if the cloud has backups this device didn't make."
              checked={appState.cloud_auto_catch_up}
              onChange={(e) => handleConfigChange("cloud_auto_catch_up", e)}
            />
          </PanelSectionRow>
          {appState.periodic_backup_minutes > 0 && (
            <PanelSectionRow>
              <ToggleField
                label="Cloud Alerts While Playing"
                description="Notify when a periodic backup can't reach the cloud (e.g. offline). Local backups still happen either way."
                checked={appState.periodic_cloud_alerts}
                onChange={(e) => handleConfigChange("periodic_cloud_alerts", e)}
              />
            </PanelSectionRow>
          )}
        </>
      )}
    </PanelSection>
  );
}
