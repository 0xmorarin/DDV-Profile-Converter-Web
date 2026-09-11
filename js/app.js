import { PROFILE_FILE_NAME } from "./config.js";
import { buildBackupFileName, createEncryptedProfile, createPrettyProfile, loadProfile } from "./profile.js";

const appShell = document.getElementById("appShell");
const idlePanel = document.getElementById("idlePanel");
const processingPanel = document.getElementById("processingPanel");
const successPanel = document.getElementById("successPanel");
const errorPanel = document.getElementById("errorPanel");
const fileInput = document.getElementById("fileInput");
const processingFileText = document.getElementById("processingFileText");
const successTitle = document.getElementById("successTitle");
const successSubtitle = document.getElementById("successSubtitle");
const downloadsList = document.getElementById("downloadsList");
const downloadStatus = document.getElementById("downloadStatus");
const errorMessageText = document.getElementById("errorMessageText");
const playerNameValue = document.getElementById("playerNameValue");
const playerIdValue = document.getElementById("playerIdValue");
const saveVersionValue = document.getElementById("saveVersionValue");
const playTimeValue = document.getElementById("playTimeValue");
const createdValue = document.getElementById("createdValue");
const lastModifiedValue = document.getElementById("lastModifiedValue");
const lastSavedOnValue = document.getElementById("lastSavedOnValue");

let busy = false;
let currentDownloads = [];
let dragDepth = 0;

function showOnly(panel) {
  idlePanel.hidden = panel !== idlePanel;
  processingPanel.hidden = panel !== processingPanel;
  successPanel.hidden = panel !== successPanel;
  errorPanel.hidden = panel !== errorPanel;
}

function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function valueOrDash(value) {
  return typeof value === "string" && value.trim() ? value : "—";
}

function formatPlayerId(value) {
  return typeof value === "string" && value.trim() ? `mdc:${value}` : "—";
}

function formatPlayTime(minutes) {
  if (typeof minutes !== "string" || !/^\d+$/.test(minutes)) return "—";
  const total = BigInt(minutes);
  return `${total / 60n}h ${total % 60n}m`;
}

function formatTimestamp(value) {
  if (typeof value !== "string") return "—";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/);
  if (!match) return value.trim() || "—";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC`;
}

function formatDevice(value) {
  if (typeof value !== "string" || !value.trim()) return "—";
  const prefix = "DeviceType_";
  const name = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (/^(Switch|NintendoSwitch|Nintendo)$/i.test(name)) return "Nintendo Switch";
  if (/^Windows$/i.test(name)) return "Windows";
  return name.replaceAll("_", " ");
}

function showMetadata(metadata) {
  playerNameValue.textContent = valueOrDash(metadata.playerName);
  playerIdValue.textContent = formatPlayerId(metadata.lastCustomIdOwner);
  saveVersionValue.textContent = metadata.version ?? "—";
  playTimeValue.textContent = formatPlayTime(metadata.timePlayedInMinutes);
  createdValue.textContent = formatTimestamp(metadata.created);
  lastModifiedValue.textContent = formatTimestamp(metadata.modified);
  lastSavedOnValue.textContent = formatDevice(metadata.lastSaveDeviceType);
}

function downloadBytes(entry) {
  const blob = new Blob([entry.bytes], { type: entry.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = entry.name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function renderDownloads(entries) {
  currentDownloads = entries;
  downloadsList.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "download-row";

    const info = document.createElement("div");
    info.className = "download-info";

    const kind = document.createElement("div");
    kind.className = "download-kind";
    kind.textContent = entry.label;

    const name = document.createElement("div");
    name.className = "download-name";
    name.textContent = entry.name;

    const button = document.createElement("button");
    button.className = "download-button";
    button.type = "button";
    button.textContent = "Download Again";
    button.addEventListener("click", () => downloadBytes(entry));

    info.append(kind, name);
    row.append(info, button);
    downloadsList.append(row);
  }
  downloadStatus.textContent = entries.length === 2
    ? "2 files ready. Downloads started automatically; use Download Again if your browser blocks one."
    : "1 file ready. Download started automatically.";
}

function startAutomaticDownloads() {
  for (const entry of currentDownloads) downloadBytes(entry);
}

function showProcessing(fileName) {
  processingFileText.textContent = `Converting ${fileName || PROFILE_FILE_NAME}`;
  showOnly(processingPanel);
}

function showSuccess(mode, metadata, entries) {
  const decrypted = mode === "decrypted";
  successTitle.textContent = decrypted ? "DECRYPTED" : "ENCRYPTED";
  successSubtitle.textContent = decrypted ? "Profile decrypted successfully." : "Profile encrypted successfully.";
  showMetadata(metadata);
  renderDownloads(entries);
  showOnly(successPanel);
  requestAnimationFrame(() => startAutomaticDownloads());
}

function showError(message) {
  errorMessageText.textContent = typeof message === "string" && message.trim()
    ? message
    : "The selected file could not be converted.";
  currentDownloads = [];
  showOnly(errorPanel);
}

async function processFile(file) {
  if (busy || !file) return;
  busy = true;
  showProcessing(file.name);
  await nextPaint();

  try {
    const raw = new Uint8Array(await file.arrayBuffer());
    const loaded = await loadProfile(raw);

    if (loaded.inputType === "encrypted") {
      const plaintext = createPrettyProfile(loaded.jsonText, loaded.metadata);
      const backupName = buildBackupFileName(loaded.metadata);
      const entries = [
        {
          label: "Decrypted profile",
          name: PROFILE_FILE_NAME,
          bytes: plaintext,
          mime: "application/json;charset=utf-8"
        },
        {
          label: "Original backup",
          name: backupName,
          bytes: raw,
          mime: "application/octet-stream"
        }
      ];
      showSuccess("decrypted", loaded.metadata, entries);
    } else {
      const encrypted = await createEncryptedProfile(loaded.jsonText, loaded.metadata);
      const entries = [
        {
          label: "Encrypted profile",
          name: PROFILE_FILE_NAME,
          bytes: encrypted,
          mime: "application/octet-stream"
        }
      ];
      showSuccess("encrypted", loaded.metadata, entries);
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    fileInput.value = "";
    busy = false;
  }
}

for (const button of document.querySelectorAll("[data-choose-file]")) {
  button.addEventListener("click", () => {
    if (!busy) fileInput.click();
  });
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void processFile(file);
});

window.addEventListener("dragenter", event => {
  event.preventDefault();
  dragDepth++;
  if (!busy) appShell.classList.add("is-dragging");
});

window.addEventListener("dragover", event => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
});

window.addEventListener("dragleave", event => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) appShell.classList.remove("is-dragging");
});

window.addEventListener("drop", event => {
  event.preventDefault();
  dragDepth = 0;
  appShell.classList.remove("is-dragging");
  if (busy) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length !== 1) {
    showError("Drop exactly one file.");
    return;
  }
  void processFile(files[0]);
});
