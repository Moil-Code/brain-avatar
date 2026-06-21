/**
 * Platform detection for the one shared React app that ships to both the macOS
 * desktop shell and the iOS app. The iPhone build always runs in "remote mode"
 * (it talks to the Mac Mini's brain-daemon over Tailscale), so `isMobile` drives
 * the handful of places that must differ:
 *   - TTS: web SpeechSynthesis instead of the macOS `say` sidecar.
 *   - Tools: offer only the daemon-served tools (no local file/AppleScript/etc.).
 *   - Chrome: hide the desktop-only peek/minimize + tray affordances.
 *   - Layout: full-screen with safe-area insets instead of a floating window.
 *
 * WKWebView on iOS reports "iPhone"/"iPad" in the user-agent, which is the most
 * reliable synchronous signal available before first paint.
 */
export const isMobile: boolean = (() => {
  try {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent);
  } catch {
    return false;
  }
})();
