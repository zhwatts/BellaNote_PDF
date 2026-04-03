import { createRoot } from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import './index.css'
import App from './App.tsx'
import { RootErrorBoundary } from './RootErrorBoundary.tsx'

const el = document.getElementById('root')
if (!el) {
  throw new Error('Missing #root element')
}

createRoot(el).render(
  <RootErrorBoundary>
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          /* Cool light grays (slight blue undertone, not “blue UI”) */
          colorBgBase: '#f2f5fa',
          colorBgContainer: '#f7f8fb',
          colorBgElevated: '#fafbfc',
          colorBgLayout: '#f2f5fa',
          colorBorder: '#d1d7e0',
          colorBorderSecondary: '#dfe3ea',
          colorText: '#1e293b',
          colorTextSecondary: '#64748b',
          colorTextTertiary: '#94a3b8',
          colorTextLightSolid: '#f8fafc',
          /* Muted cool-gray primary — avoids harsh white-on-black */
          colorPrimary: '#5f6b7a',
          colorPrimaryHover: '#4d5765',
          colorPrimaryActive: '#3f4854',
          colorPrimaryBg: '#e2e6ee',
          colorPrimaryBgHover: '#d5dae4',
          colorSuccess: '#64748b',
          colorInfo: '#6b7c8f',
          colorLink: '#5f6b7a',
          colorLinkHover: '#4d5765',
          borderRadiusLG: 8,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        },
        components: {
          Layout: {
            bodyBg: '#f2f5fa',
            headerBg: '#f2f5fa',
            siderBg: '#e4e7ef',
          },
          Button: {
            defaultShadow: 'none',
            primaryShadow: 'none',
          },
          Card: {
            colorBgContainer: '#fafbfc',
          },
          Modal: {
            contentBg: '#fafbfc',
            headerBg: '#fafbfc',
            footerBg: '#fafbfc',
          },
          Switch: {
            colorPrimary: '#8b95a5',
          },
          Tag: {
            defaultBg: '#e2e6ee',
            defaultColor: '#5f6b7a',
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </RootErrorBoundary>,
)
