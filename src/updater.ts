// Update-check state, shared between the header gearwheel (which shows a dot
// when a newer release exists) and the Settings panel (which runs the check and
// shows the notes + Download button). All network happens in the Rust
// `check_for_update` command; nothing installs automatically — this is
// prompt-only, matching the local-first promise.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type UpdateInfo = {
  current: string;
  latest: string;
  is_newer: boolean;
  notes: string;
  url: string;
};

export type CheckState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "error";

const STARTUP_KEY = "captionsmith:checkOnStartup";

export const [checkState, setCheckState] = createSignal<CheckState>("idle");
export const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
export const [checkError, setCheckError] = createSignal("");

/** Opt-in startup check, persisted in localStorage. Off by default: a launch
 *  should not phone home unless the user asked it to. */
export function checkOnStartupEnabled(): boolean {
  return localStorage.getItem(STARTUP_KEY) === "true";
}

export function setCheckOnStartup(on: boolean) {
  localStorage.setItem(STARTUP_KEY, on ? "true" : "false");
}

/** The gearwheel shows a dot only when a strictly-newer release was found. */
export function updateAvailable(): boolean {
  return checkState() === "available" && (updateInfo()?.is_newer ?? false);
}

/** User-initiated check from Settings: surfaces every outcome, errors included. */
export async function checkForUpdate(): Promise<void> {
  if (checkState() === "checking") return;
  setCheckState("checking");
  setCheckError("");
  try {
    const info = await invoke<UpdateInfo>("check_for_update");
    setUpdateInfo(info);
    setCheckState(info.is_newer ? "available" : "up-to-date");
  } catch (e) {
    setCheckError(String(e));
    setCheckState("error");
  }
}

/** Silent check run once at mount when the toggle is on. Only ever flips to
 *  "available"; a failure (e.g. offline) stays quiet so launch isn't noisy. */
export async function silentStartupCheck(): Promise<void> {
  if (!checkOnStartupEnabled()) return;
  try {
    const info = await invoke<UpdateInfo>("check_for_update");
    setUpdateInfo(info);
    if (info.is_newer) setCheckState("available");
  } catch {
    /* stay quiet on startup */
  }
}

export async function openReleasePage(): Promise<void> {
  const info = updateInfo();
  if (info?.url) await invoke("open_release_page", { url: info.url });
}
