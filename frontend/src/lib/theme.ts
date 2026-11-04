// Runs in <head> before first paint so a light-theme user never sees a dark flash.
// ThemeToggle writes the same localStorage key.
export const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="light")document.documentElement.dataset.theme="light"}catch(e){}`;
