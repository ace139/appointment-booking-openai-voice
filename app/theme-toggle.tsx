"use client";

import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<string>("light");

  useEffect(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem("theme")) || "light";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    if (typeof window !== "undefined") localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
  }

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      className="focus-ring inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
    >
      <span className="w-4 h-4 inline-block" aria-hidden>
        {theme === "light" ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M6.76 4.84l-1.8-1.79L3.17 4.84l1.79 1.79 1.8-1.79zm10.48 14.32l1.79 1.79 1.79-1.79-1.79-1.79-1.79 1.79zM1 13h3v-2H1v2zm19 0h3v-2h-3v2zM4.22 19.78l1.79-1.79-1.79-1.79-1.79 1.79 1.79 1.79zM12 4a1 1 0 100-2 1 1 0 000 2zm0 18a1 1 0 100-2 1 1 0 000 2zm7.78-14.22l-1.79 1.79 1.79 1.79 1.79-1.79-1.79-1.79zM12 6a6 6 0 100 12A6 6 0 0012 6z"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M21.64 13a1 1 0 00-1.05-.14A8 8 0 1111.1 3.41a1 1 0 00-.14-1.05A1 1 0 009.9 2 10 10 0 1022 14.1a1 1 0 00-.36-1.1z"/></svg>
        )}
      </span>
      <span className="text-sm">{theme === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}

