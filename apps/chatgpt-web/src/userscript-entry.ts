/**
 * Tampermonkey userscript entrypoint.
 * Injects a floating control HUD into ChatGPT Web and orchestrates DecisionTabDriver.
 */
import { GmBridgeTransport, FetchBridgeTransport, type BridgeTransport } from "./transport";
import { GmCheckpointStore } from "./checkpoint";
import { ChatGptWebAdapter } from "./adapter";
import { DecisionTabDriver } from "./driver";

function createTransport(bridgeBaseUrl: string): BridgeTransport {
  if (typeof GM_xmlhttpRequest !== "undefined") {
    return new GmBridgeTransport({ baseUrl: bridgeBaseUrl });
  }
  return new FetchBridgeTransport({ baseUrl: bridgeBaseUrl });
}

export function initSymphonyUserscript(options?: {
  bridgeBaseUrl?: string;
  autoStart?: boolean;
}): void {
  const defaultBridgeUrl = options?.bridgeBaseUrl ?? "http://127.0.0.1:4040";

  if (document.getElementById("symphony-driver-hud")) {
    return; // Already initialized
  }

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
    minWidth: "220px",
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
  statusText.textContent = "Ready to connect to bridge";

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
  });

  btnRow.appendChild(toggleBtn);
  hud.appendChild(titleRow);
  hud.appendChild(statusText);
  hud.appendChild(btnRow);
  document.body.appendChild(hud);

  let currentDriver: DecisionTabDriver | null = null;
  let isRunning = false;

  const updateUI = (running: boolean, message?: string) => {
    isRunning = running;
    if (running) {
      statusIndicator.textContent = "● Running";
      statusIndicator.style.color = "#a6e3a1";
      toggleBtn.textContent = "Stop Driver";
      toggleBtn.style.background = "#f38ba8";
      if (message) statusText.textContent = message;
    } else {
      statusIndicator.textContent = "● Idle";
      statusIndicator.style.color = "#a6adc8";
      toggleBtn.textContent = "Start Driver";
      toggleBtn.style.background = "#89b4fa";
      if (message) statusText.textContent = message;
    }
  };

  const start = async () => {
    try {
      const transport = createTransport(defaultBridgeUrl);
      const checkpointStore = new GmCheckpointStore();
      const adapter = new ChatGptWebAdapter();
      currentDriver = new DecisionTabDriver({
        transport,
        checkpointStore,
        adapter,
      });

      updateUI(true, "Connecting to bridge...");
      // Fire driver start in background
      currentDriver.start().catch((err: unknown) => {
        updateUI(false, `Error: ${err instanceof Error ? err.message : String(err)}`);
      });
      updateUI(true, "Polling for tasks...");
    } catch (err: unknown) {
      updateUI(false, `Failed to start: ${err instanceof Error ? err.message : String(err)}`);
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
