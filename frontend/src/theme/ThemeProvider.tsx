/** @format */

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ConfigProvider, theme as antdTheme } from "antd";

const STORAGE_KEY = "bella-note-theme";

type ThemeContextValue = {
  isDark: boolean;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredDark(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark";
  } catch {
    return false;
  }
}

const lightAntdTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorBgBase: "#f2f5fa",
    colorBgContainer: "#f7f8fb",
    colorBgElevated: "#fafbfc",
    colorBgLayout: "#f2f5fa",
    colorBorder: "#d1d7e0",
    colorBorderSecondary: "#dfe3ea",
    colorText: "#1e293b",
    colorTextSecondary: "#64748b",
    colorTextTertiary: "#94a3b8",
    colorTextLightSolid: "#f8fafc",
    colorPrimary: "#5f6b7a",
    colorPrimaryHover: "#4d5765",
    colorPrimaryActive: "#3f4854",
    colorPrimaryBg: "#e2e6ee",
    colorPrimaryBgHover: "#d5dae4",
    colorSuccess: "#64748b",
    colorInfo: "#6b7c8f",
    colorLink: "#5f6b7a",
    colorLinkHover: "#4d5765",
    borderRadiusLG: 8,
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },
  components: {
    Layout: {
      bodyBg: "#f2f5fa",
      headerBg: "#f2f5fa",
      siderBg: "#e4e7ef",
    },
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Card: {
      colorBgContainer: "#fafbfc",
    },
    Modal: {
      contentBg: "#fafbfc",
      headerBg: "#fafbfc",
      footerBg: "#fafbfc",
    },
    Switch: {
      colorPrimary: "#8b95a5",
    },
    Tag: {
      defaultBg: "#e2e6ee",
      defaultColor: "#5f6b7a",
    },
  },
} as const;

const darkAntdTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorBgBase: "#121820",
    colorBgContainer: "#1a222d",
    colorBgElevated: "#1e2733",
    colorBgLayout: "#141a21",
    colorBorder: "#2d3a4a",
    colorBorderSecondary: "#3d4d62",
    colorText: "#e8ecf1",
    colorTextSecondary: "#94a3b8",
    colorTextTertiary: "#64748b",
    colorTextLightSolid: "#f8fafc",
    colorPrimary: "#94a3b8",
    colorPrimaryHover: "#a8b4c4",
    colorPrimaryActive: "#7d8a9c",
    colorPrimaryBg: "#2d3748",
    colorPrimaryBgHover: "#374151",
    colorSuccess: "#94a3b8",
    colorInfo: "#8b9cb0",
    colorLink: "#94a3b8",
    colorLinkHover: "#a8b4c4",
    borderRadiusLG: 8,
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  },
  components: {
    Layout: {
      bodyBg: "#141a21",
      headerBg: "#141a21",
      siderBg: "#1a222d",
    },
    Button: {
      defaultShadow: "none",
      primaryShadow: "none",
    },
    Card: {
      colorBgContainer: "#1e2733",
    },
    Modal: {
      contentBg: "#1e2733",
      headerBg: "#1e2733",
      footerBg: "#1e2733",
    },
    Switch: {
      colorPrimary: "#64748b",
    },
    Tag: {
      defaultBg: "#2d3748",
      defaultColor: "#94a3b8",
    },
  },
} as const;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(readStoredDark);

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }, [isDark]);

  const toggleTheme = useCallback(() => {
    setIsDark((d) => {
      const next = !d;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      isDark,
      toggleTheme,
    }),
    [isDark, toggleTheme],
  );

  const antdTheme = useMemo(
    () => (isDark ? darkAntdTheme : lightAntdTheme),
    [isDark],
  );

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider theme={antdTheme}>{children}</ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useThemeMode(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useThemeMode must be used within ThemeProvider");
  }
  return ctx;
}
