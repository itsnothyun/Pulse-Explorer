import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { QuickViewWindow } from './components/QuickViewWindow';
import { isQuickViewWindow } from './services/desktopBridge';
import './styles/index.css';

// The desktop shell opens a second, transparent "quickview" window for files
// launched from File Explorer; it renders only the floating viewer.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isQuickViewWindow() ? <QuickViewWindow /> : <App />}</React.StrictMode>
);
