import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { AuthProvider } from './lib/auth';
import { PrefsProvider } from './lib/prefs';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AuthProvider><PrefsProvider><App /></PrefsProvider></AuthProvider></React.StrictMode>
);
