import { DriverDiagnostics } from "./diagnostics";
import { getOrCreateTabId } from "./checkpoint";
/**
 * Tampermonkey userscript entrypoint.
 * Injects a floating control HUD into ChatGPT Web and orchestrates DecisionTabDriver.
 */
import { GmBridgeTransport, FetchBridgeTransport, BridgeHttpError, type BridgeTransport } from "./transport";
import { GmCheckpointStore, type CheckpointStore } from "./checkpoint";
import { ChatGptWebAdapter, DEFAULT_RESPONSE_TIMEOUT_MS } from "./adapter";
import { DecisionTabDriver } from "./driver";

function createTransport(bridgeBaseUrl: string, authToken?: string): BridgeTransport {
  const token = authToken && authToken.trim().length > 0 ? authToken.trim() : undefined;
  if (typeof GM_xmlhttpRequest !== "undefined") {
    return new GmBridgeTransport({ baseUrl: bridgeBaseUrl, authToken: token });
  }
  return new FetchBridgeTransport({ baseUrl: bridgeBaseUrl, authToken: token });
}

export interface UserscriptInitOptions {
  bridgeBaseUrl?: string | undefined;
  authToken?: string | undefined;
  autoStart?: boolean | undefined;
  adapter?: ChatGptWebAdapter | undefined;
  checkpointStore?: CheckpointStore | undefined;
  transport?: BridgeTransport | undefined;
  pollIntervalMs?: number | undefined;
}

export interface UserscriptController {
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
  getDriver: () => DecisionTabDriver | null;
}

export function initSymphonyUserscript(options?: UserscriptInitOptions): UserscriptController {
  if (document.getElementById("symphony-driver-hud")) {
    return {
      start: async () => {},
      stop: () => {},
      isRunning: () => false,
      getDriver: () => null,
    };
  }

  let bridgeUrl =
    options?.bridgeBaseUrl ??
    (typeof GM_getValue === "function"
      ? GM_getValue<string>("symphony_bridge_url", "http://127.0.0.1:4040")
      : "http://127.0.0.1:4040");

  let token =
    options?.authToken ??
    (typeof GM_getValue === "function" ? GM_getValue<string>("symphony_bridge_token", "") : "");

  const savedResponseMinutes = typeof GM_getValue === "function"
    ? GM_getValue<number>("symphony_response_timeout_minutes", 15) : 15;

  // Create HUD container
  const hud = document.createElement("div");
  hud.id = "symphony-driver-hud";
  Object.assign(hud.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "999999",
    background: "#1e1e2e",
    color: "#cdd6f4",
    padding: "12px 16px",
    borderRadius: "10px",
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    fontSize: "13px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    border: "1px solid #45475a",
    minWidth: "260px",
    maxWidth: "340px",
    userSelect: "none",
  });

  const titleRow = document.createElement("div");
  titleRow.style.fontWeight = "bold";
  titleRow.style.marginBottom = "8px";
  titleRow.style.display = "flex";
  titleRow.style.justifyContent = "space-between";
  titleRow.style.alignItems = "center";
  titleRow.textContent = `Symphony Decision Driver ${typeof __SYMPHONY_DRIVER_VERSION__ === "undefined" ? "dev" : __SYMPHONY_DRIVER_VERSION__}`;

  const statusIndicator = document.createElement("span");
  statusIndicator.id = "symphony-status-pill";
  statusIndicator.textContent = "● Idle";
  statusIndicator.style.color = "#a6adc8";
  statusIndicator.style.fontSize = "11px";
  titleRow.appendChild(statusIndicator);

  const statusText = document.createElement("div");
  statusText.id = "symphony-driver-status";
  statusText.style.marginBottom = "10px";
  statusText.style.color = "#bac2de";
  statusText.style.wordBreak = "break-word";
  statusText.textContent = "Ready to connect to bridge";

  // Settings section (collapsible or persistent inputs)
  const settingsContainer = document.createElement("div");
  settingsContainer.id = "symphony-settings-panel";
  settingsContainer.style.marginBottom = "10px";
  settingsContainer.style.display = "flex";
  settingsContainer.style.flexDirection = "column";
  settingsContainer.style.gap = "6px";

  const urlInput = document.createElement("input");
  urlInput.id = "symphony-url-input";
  urlInput.type = "text";
  urlInput.placeholder = "Bridge URL (e.g. http://127.0.0.1:4040)";
  urlInput.value = bridgeUrl;
  Object.assign(urlInput.style, {
    background: "#313244",
    color: "#cdd6f4",
    border: "1px solid #45475a",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "11px",
  });

  // Register Tampermonkey menu commands for isolated credential entry
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Symphony: Set Bridge Bearer Token", () => {
      const entered = prompt("Enter Symphony Bridge Bearer Token (persisted in Tampermonkey storage):", "");
      if (entered !== null) {
        token = entered.trim();
        if (typeof GM_setValue === "function") {
          GM_setValue("symphony_bridge_token", token);
        }
        updateTokenStatus();
      }
    });
    GM_registerMenuCommand("Symphony: Clear Bridge Bearer Token", () => {
      token = "";
      if (typeof GM_setValue === "function") {
        GM_setValue("symphony_bridge_token", "");
      }
      updateTokenStatus();
    });
  }

  // Token status and configuration (credential is kept in storage and never stored in DOM properties)
  const tokenRow = document.createElement("div");
  tokenRow.style.display = "flex";
  tokenRow.style.justifyContent = "space-between";
  tokenRow.style.alignItems = "center";
  tokenRow.style.padding = "2px 0";

  const tokenLabel = document.createElement("span");
  tokenLabel.id = "symphony-token-status";
  tokenLabel.style.fontSize = "11px";

  const tokenBtn = document.createElement("button");
  tokenBtn.id = "symphony-configure-token-btn";
  Object.assign(tokenBtn.style, {
    background: "#45475a",
    color: "#cdd6f4",
    border: "none",
    borderRadius: "4px",
    padding: "3px 8px",
    fontSize: "10px",
    cursor: "pointer",
  });

  const updateTokenStatus = () => {
    tokenLabel.textContent = token ? "Token: Configured" : "Token: Not set";
    tokenLabel.style.color = token ? "#a6e3a1" : "#a6adc8";
    tokenBtn.textContent = token ? "Change Token" : "Set Token";
  };
  updateTokenStatus();

  tokenBtn.addEventListener("click", () => {
    const entered = prompt("Enter Symphony Bridge Bearer Token (persisted in Tampermonkey storage, never in page DOM):", "");
    if (entered !== null) {
      token = entered.trim();
      if (typeof GM_setValue === "function") {
        GM_setValue("symphony_bridge_token", token);
      }
      updateTokenStatus();
    }
  });

  tokenRow.appendChild(tokenLabel);
  tokenRow.appendChild(tokenBtn);

  settingsContainer.appendChild(urlInput);
  settingsContainer.appendChild(tokenRow);

  const timeoutLabel = document.createElement("label");
  timeoutLabel.textContent = "Response timeout (minutes, 1–60)";
  const timeoutInput = document.createElement("input");
  timeoutInput.id = "symphony-response-timeout-input";
  timeoutInput.type = "number";
  timeoutInput.min = "1";
  timeoutInput.max = "60";
  timeoutInput.step = "1";
  timeoutInput.value = String(Number.isInteger(savedResponseMinutes) && savedResponseMinutes >= 1 && savedResponseMinutes <= 60
    ? savedResponseMinutes : DEFAULT_RESPONSE_TIMEOUT_MS / 60_000);
  timeoutLabel.appendChild(timeoutInput);
  settingsContainer.appendChild(timeoutLabel);

  const btnRow = document.createElement("div");
  btnRow.style.display = "flex";
  btnRow.style.gap = "8px";

  const toggleBtn = document.createElement("button");
  toggleBtn.id = "symphony-toggle-btn";
  toggleBtn.textContent = "Start Driver";
  Object.assign(toggleBtn.style, {
    background: "#89b4fa",
    color: "#11111b",
    border: "none",
    borderRadius: "6px",
    padding: "6px 12px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "12px",
    flex: "1",
  });

  btnRow.appendChild(toggleBtn);
  hud.appendChild(titleRow);
  hud.appendChild(statusText);
  hud.appendChild(settingsContainer);
  hud.appendChild(btnRow);
  document.body.appendChild(hud);

  const diagnosticPanel = document.createElement("details");
  const diagnosticTitle = document.createElement("summary");
  diagnosticTitle.textContent = "Driver diagnostics (last 50 events)";
  const diagnosticText = document.createElement("pre");
  diagnosticText.id = "symphony-driver-diagnostics";
  Object.assign(diagnosticText.style, { maxHeight: "200px", overflow: "auto", fontSize: "10px", whiteSpace: "pre-wrap" });
  diagnosticPanel.appendChild(diagnosticTitle);
  diagnosticPanel.appendChild(diagnosticText);
  hud.appendChild(diagnosticPanel);
  const diagnostics = new DriverDiagnostics(`symphony_driver_diagnostics_${getOrCreateTabId(typeof window !== "undefined" ? window : null)}`,
    text => { diagnosticText.textContent = text; });

  let currentDriver: DecisionTabDriver | null = null;
  let isRunning = false;

  const updateUI = (running: boolean, message?: string, isError = false, phase: "Running" | "Waiting" | "Blocked" = "Running") => {
    isRunning = running;
    if (running) {
      statusIndicator.textContent = `● ${phase}`;
      statusIndicator.style.color = phase === "Blocked" ? "#f38ba8" : phase === "Waiting" ? "#f9e2af" : "#a6e3a1";
      toggleBtn.textContent = "Stop Driver";
      toggleBtn.style.background = "#f38ba8";
      if (message) {
        statusText.textContent = message;
        statusText.style.color = "#bac2de";
      }
    } else {
      statusIndicator.textContent = isError ? "● Error" : "● Idle";
      statusIndicator.style.color = isError ? "#f38ba8" : "#a6adc8";
      toggleBtn.textContent = "Start Driver";
      toggleBtn.style.background = "#89b4fa";
      if (message) {
        statusText.textContent = message;
        statusText.style.color = isError ? "#f38ba8" : "#bac2de";
      }
    }
  };

  let enabledInMemory = false;
  const enabledKey = () => `symphony_driver_enabled:${bridgeUrl.replace(/\/+$/, "")}`;
  let authProbeTimer: ReturnType<typeof setTimeout> | null = null;
  let enableGeneration = 0;
  const isDriverEnabledInTab = (): boolean => {
    try {
      const stored = typeof GM_getValue === "function" ? GM_getValue<boolean | null>(enabledKey(), null) : window.localStorage.getItem(enabledKey());
      if (stored === true || stored === "true") return true;
      if (stored === false || stored === "false") return false;
      if (window.sessionStorage.getItem("symphony_driver_enabled") === "true") {
        setDriverEnabledInTab(true); // One-time migration; persisted Stop always wins.
        return true;
      }
      return enabledInMemory;
    } catch { return enabledInMemory; }
  };
  const setDriverEnabledInTab = (enabled: boolean): void => {
    enabledInMemory = enabled;
    try {
      if (typeof GM_setValue === "function") GM_setValue(enabledKey(), enabled);
      else window.localStorage.setItem(enabledKey(), String(enabled));
    } catch { /* Persistence unavailable: current page remains controllable. */ }
  };

  const start = async () => {
    try {
      const generation = ++enableGeneration;
      if (authProbeTimer) clearTimeout(authProbeTimer);
      const responseMinutes = Number(timeoutInput.value);
      if (!Number.isInteger(responseMinutes) || responseMinutes < 1 || responseMinutes > 60) {
        throw new Error("Response timeout must be an integer from 1 to 60 minutes");
      }
      if (typeof GM_setValue === "function") {
        GM_setValue("symphony_response_timeout_minutes", responseMinutes);
      }
      if (currentDriver) {
        currentDriver.stop();
        currentDriver = null;
      }

      bridgeUrl = urlInput.value.trim() || "http://127.0.0.1:4040";
      setDriverEnabledInTab(true);

      if (typeof GM_setValue === "function") {
        GM_setValue("symphony_bridge_url", bridgeUrl);
      }

      const transport = options?.transport ?? createTransport(bridgeUrl, token);
      const checkpointStore = options?.checkpointStore ?? new GmCheckpointStore();
      const adapter = options?.adapter ?? new ChatGptWebAdapter({ responseTimeoutMs: responseMinutes * 60_000,
        onResponseWaitState: ({ taskId, kind, revision, ...wait }) => diagnostics.record({ stage: "response_wait", taskId, kind, revision, wait }),
      });

      currentDriver = new DecisionTabDriver({
        transport,
        checkpointStore,
        adapter,
        shouldRun: isDriverEnabledInTab,
        ...(typeof options?.pollIntervalMs === "number" ? { pollIntervalMs: options.pollIntervalMs } : {}),
        onDiagnostic: entry => {
          diagnostics.record(entry);
          if (generation === enableGeneration && isDriverEnabledInTab()) updateUI(true, `Executing ${entry.taskId}: ${entry.stage}`);
        },
        onContinuity: work => {
          // Ignore an idle read that finished after Stop or a replacement driver.
          if (generation !== enableGeneration || !isDriverEnabledInTab()) return;
          const tasks = work.flatMap(item => item.tasks).filter(task =>
            task.status === "pending" || task.status === "claimed" || task.status === "running");
          const blocked = tasks.find(task => task.execution?.blocked);
          const owned = tasks.find(task => task.owner !== null);
          if (blocked?.execution?.blocked) {
            updateUI(true, `Blocked ${blocked.id}: ${blocked.execution.blocked.reason}. ${blocked.execution.blocked.unblock}`, false, "Blocked");
          } else if (owned) {
            updateUI(true, `Waiting ${owned.id}: no local checkpoint. Await the current owner or host reconciliation; do not resend the task.`, false, "Waiting");
          } else {
            updateUI(true, "Polling for Decision tasks");
          }
        },
        onError: (err: Error) => {
          // Auth failures are fatal: polling would loop on 401/403 until credentials
          // are fixed by the operator, so stop and surface the error.
          const isAuthError =
            err instanceof BridgeHttpError && (err.status === 401 || err.status === 403);
          if (isAuthError) {
            // Keep durable intent; only read-only probes run until bridge authorization returns.
            const probe = async () => {
              if (generation !== enableGeneration || !isDriverEnabledInTab()) return;
              try {
                await transport.request("GET", "/v1/continuity");
                if (generation === enableGeneration && isDriverEnabledInTab()) void start();
              } catch {
                if (generation === enableGeneration) authProbeTimer = setTimeout(() => { void probe(); }, 60_000);
              }
            };
            authProbeTimer = setTimeout(() => { void probe(); }, 30_000);
            if (currentDriver) {
              currentDriver.stop();
              currentDriver = null;
            }
            updateUI(false, `Error: ${err.message}`, true);
            return;
          }
          // Recoverable operational error (transient network failure, supersede race,
          // lease expiry): keep polling. Checkpoint recovery and the bridge's lease /
          // supersede semantics own reconciliation; stopping here would require a
          // manual Start for every transient conflict.
          updateUI(true, err.message.startsWith("Blocked:") ? err.message : `Recovered from error: ${err.message}`, false, err.message.startsWith("Blocked:") ? "Blocked" : "Running");
        },
      });

      updateUI(true, "Connecting & polling...");
      // Fire driver start in background
      currentDriver.start().catch((err: unknown) => {
        if (currentDriver) {
          currentDriver.stop();
          currentDriver = null;
        }
        const msg = err instanceof Error ? err.message : String(err);
        updateUI(false, `Driver stopped on error: ${msg}`, true);
      });
    } catch (err: unknown) {
      if (currentDriver) {
        currentDriver.stop();
        currentDriver = null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      updateUI(false, `Failed to start: ${msg}`, true);
    }
  };

  const stop = () => {
    ++enableGeneration;
    if (authProbeTimer) clearTimeout(authProbeTimer);
    authProbeTimer = null;
    setDriverEnabledInTab(false);
    if (currentDriver) {
      currentDriver.stop();
      currentDriver = null;
    }
    updateUI(false, "Driver stopped");
  };

  toggleBtn.addEventListener("click", () => {
    if (isRunning) {
      stop();
    } else {
      void start();
    }
  });

  const shouldAutoStart = options?.autoStart ?? isDriverEnabledInTab();
  if (shouldAutoStart) {
    void start();
  }

  return {
    start,
    stop,
    isRunning: () => isRunning,
    getDriver: () => currentDriver,
  };
}

// Automatically init when loaded into browser
if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initSymphonyUserscript());
  } else {
    initSymphonyUserscript();
  }
}
