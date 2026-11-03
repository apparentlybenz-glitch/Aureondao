// The two themes. The choice is stored per browser; dark is the default. The class on <html>
// is "dark" or "light" (`.dark` and `:root` in globals.css hold the tokens). The browser chrome
// colors below mirror --background in each theme (theme.test.mjs keeps them equal).
export type Theme = "dark" | "light";

export const THEME_KEY = "aureonx-theme";
export const THEME_COLORS: Record<Theme, string> = { dark: "#151a18", light: "#ffffff" };
// iOS home-screen status bar: "black" (white text) for dark, "default" (dark text) for light.
export const STATUS_BAR: Record<Theme, string> = { dark: "black", light: "default" };

// The two failure shells (/offline and global-error) style themselves inline, with no stylesheet
// to carry the tokens, so they are always dark and take their colors from here.
export const SHELL_COLORS = { background: "#050505", text: "#f5f5f5", muted: "#a3a3a3", button: "#1ba04a" } as const;

// Runs in <head> before first paint, so the page never shows the wrong theme. It reads the
// stored choice (any failure means dark), sets the class on <html> and the browser chrome
// meta tags. toggleTheme below does the same on a tap.
export const THEME_SCRIPT = `(function(){var t="dark";try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="light")t="light"}catch(e){}var d=document.documentElement;d.classList.remove("dark","light");d.classList.add(t);var c=${JSON.stringify(THEME_COLORS)},s=${JSON.stringify(STATUS_BAR)};var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}m.content=c[t];var a=document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(a)a.content=s[t]})();`;

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme];
  const status = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (status) status.content = STATUS_BAR[theme];
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the theme still applies for this page view.
  }
}
