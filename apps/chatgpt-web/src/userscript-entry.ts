/**
 * Tampermonkey userscript entrypoint.
 * Injects a floating control HUD into ChatGPT Web and orchestrates DecisionTabDriver.
 */
import { GmBridgeTransport, FetchBridgeTransport, type BridgeTransport } from "./transport";
import { GmCheckpointStore } from "./checkpoint";
import { ChatGptWebAdapter } from "./adapter";
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
}

export function initSymphonyUserscript(options?: UserscriptInitOptions): void {
  if (document.getElementById("symphony-driver-hud")) {
    return; // Already initialized
  }

  let bridgeUrl =
    options?.bridgeBaseUrl ??
    (typeof GM_getValue === "function"
      ? GM_getValue<string>("symphony_bridge_url", "http://127.0.0.1:4040")
      : "http://127.0.0.1:4040");

  let token =
    options?.authToken ??
    (typeof GM_getValue === "function" ? GM_getValue<string>("symphony_bridge_token", "") : "");

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
  titleRow.textContent = "Symphony Decision Driver";

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

  const tokenInput = document.createElement("input");
  tokenInput.id = "symphony-token-input";
  tokenInput.type = "password";
  tokenInput.placeholder = "Bearer Token (optional)";
  tokenInput.value = token;
  Object.assign(tokenInput.style, {
    background: "#313244",
    color: "#cdd6f4",
    border: "1px solid #45475a",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "11px",
  });

  settingsContainer.appendChild(urlInput);
  settingsContainer.appendChild(tokenInput);

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

  let currentDriver: DecisionTabDriver | null = null;
  let isRunning = false;

  const updateUI = (running: boolean, message?: string, isError = false) => {
    isRunning = running;
    if (running) {
      statusIndicator.textContent = "● Running";
      statusIndicator.style.color = "#a6e3a1";
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

  const start = async () => {
    try {
      bridgeUrl = urlInput.value.trim() || "http://127.0.0.1:4040";
      token = tokenInput.value.trim();

      if (typeof GM_setValue === "function") {
        GM_setValue("symphony_bridge_url", bridgeUrl);
        GM_setValue("symphony_bridge_token", token);
      }

      const transport = createTransport(bridgeUrl, token);
      const checkpointStore = new GmCheckpointStore();
      const adapter = new ChatGptWebAdapter();

      currentDriver = new DecisionTabDriver({
        transport,
        checkpointStore,
        adapter,
        onError: (err: Error) => {
          updateUI(false, `Error: ${err.message}`, true);
        },
      });

      updateUI(true, "Connecting & polling...");
      // Fire driver start in background
      currentDriver.start().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        updateUI(false, `Driver stopped on error: ${msg}`, true);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateUI(false, `Failed to start: ${msg}`, true);
    }
  };

  const stop = () => {
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

  if (options?.autoStart) {
    void start();
  }
}

// Automatically init when loaded into browser
if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initSymphonyUserscript());
  } else {
    initSymphonyUserscript();
  }
}
