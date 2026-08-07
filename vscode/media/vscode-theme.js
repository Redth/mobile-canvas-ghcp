(function () {
  const root = document.documentElement;
  const body = document.body;
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");

  function has(name) {
    return body.classList.contains(name);
  }

  function parseChannel(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(255, number)) : null;
  }

  function isDarkColor(value) {
    const color = value.trim();
    let channels;
    const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color);
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(color);
    const rgb = /^rgba?\(\s*([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s/)]+)/i.exec(color);
    if (shortHex) {
      channels = shortHex.slice(1).map((channel) => Number.parseInt(channel + channel, 16));
    } else if (hex) {
      channels = hex.slice(1).map((channel) => Number.parseInt(channel, 16));
    } else if (rgb) {
      channels = rgb.slice(1).map(parseChannel);
    }
    if (!channels || channels.some((channel) => channel === null)) return null;
    const [red, green, blue] = channels;
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 128;
  }

  function detectTheme() {
    if (has("vscode-high-contrast-light")) return { theme: "light", contrast: "high" };
    if (has("vscode-high-contrast")) return { theme: "dark", contrast: "high" };
    if (has("vscode-light")) return { theme: "light", contrast: "normal" };
    if (has("vscode-dark")) return { theme: "dark", contrast: "normal" };

    const styles = getComputedStyle(body);
    const background = styles.getPropertyValue("--vscode-sideBar-background")
      || styles.getPropertyValue("--vscode-editor-background");
    const inferred = isDarkColor(background);
    return {
      theme: inferred === null ? (media?.matches ? "dark" : "light") : (inferred ? "dark" : "light"),
      contrast: "normal",
    };
  }

  function applyTheme() {
    const { theme, contrast } = detectTheme();
    root.dataset.host = "vscode";
    root.dataset.hostTheme = theme;
    root.dataset.hostContrast = contrast;
  }

  applyTheme();
  new MutationObserver(applyTheme).observe(body, {
    attributes: true,
    attributeFilter: ["class", "data-vscode-theme-id"],
  });
  media?.addEventListener?.("change", applyTheme);
})();
