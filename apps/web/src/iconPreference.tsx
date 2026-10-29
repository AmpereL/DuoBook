import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type AppIconId = 1 | 2 | 3 | 4;

export const APP_ICONS: Array<{ id: AppIconId; name: string; description: string; src: string }> = [
  { id: 1, name: "书页与逻辑树", description: "书页向上生长出逻辑分支", src: "/icons/app-icon-1.png" },
  { id: 2, name: "分层阅读路径", description: "沿着路径逐层深入原文", src: "/icons/app-icon-2.png" },
  { id: 3, name: "进入书中", description: "从书页进入深读空间", src: "/icons/app-icon-3.png" },
  { id: 4, name: "书签与分支", description: "把阅读路径收进书签", src: "/icons/app-icon-4.png" },
];

const STORAGE_KEY = "logic-reading-app-icon";
const DEFAULT_ICON: AppIconId = 2;

function validIcon(value: unknown): value is AppIconId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function browserIcon(): AppIconId {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return validIcon(stored) ? stored : DEFAULT_ICON;
  } catch {
    return DEFAULT_ICON;
  }
}

type AppIconContextValue = {
  iconId: AppIconId;
  icon: (typeof APP_ICONS)[number];
  selectIcon: (id: AppIconId) => Promise<void>;
  error: string | null;
};

const AppIconContext = createContext<AppIconContextValue | null>(null);

export function AppIconProvider({ children }: { children: ReactNode }) {
  const [iconId, setIconId] = useState<AppIconId>(browserIcon);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.duobookDesktop?.getAppIcon) return;
    window.duobookDesktop.getAppIcon().then((saved) => {
      if (validIcon(saved)) setIconId(saved);
    }).catch(() => setError("无法读取桌面图标设置"));
  }, []);

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = APP_ICONS[iconId - 1].src;
  }, [iconId]);

  const selectIcon = async (id: AppIconId) => {
    setError(null);
    try {
      await window.duobookDesktop?.setAppIcon(id);
      window.localStorage.setItem(STORAGE_KEY, String(id));
      setIconId(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换图标失败");
    }
  };

  return (
    <AppIconContext.Provider value={{ iconId, icon: APP_ICONS[iconId - 1], selectIcon, error }}>
      {children}
    </AppIconContext.Provider>
  );
}

export function useAppIcon() {
  const value = useContext(AppIconContext);
  if (!value) throw new Error("AppIconProvider is missing");
  return value;
}
